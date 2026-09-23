'use strict';

/**
 * The offline curvature layer: precomputed road geometry plus derived curve
 * records, with a uniform grid spatial index.
 *
 * This is the architectural change from Part 4. Instead of asking Overpass for
 * geometry while driving -- which is rate limited, adds seconds of latency to a
 * time-critical decision, and simply does not work in a tunnel or a dead zone --
 * the geometry for the study region is extracted, stitched, smoothed and
 * analysed once, at build time. At run time the job reduces to map matching
 * against a local index, which is deterministic and reproducible: two replays
 * of the same GPS trace produce byte-identical warnings, which is what makes
 * the results defensible in a paper.
 */

import { distanceMetres } from './geo.js';

export const LAYER_VERSION = 2;
export const DEFAULT_CELL_DEGREES = 0.005; // ~550 m of latitude

export function cellKey(latitude, longitude, cellDegrees = DEFAULT_CELL_DEGREES) {
  return `${Math.floor(latitude / cellDegrees)}:${Math.floor(longitude / cellDegrees)}`;
}

/** Every cell key touched by a circle of `radiusMetres` about a point. */
export function cellKeysAround(latitude, longitude, radiusMetres, cellDegrees = DEFAULT_CELL_DEGREES) {
  const latitudeSpan = radiusMetres / 111320;
  const longitudeSpan = radiusMetres / (111320 * Math.max(0.05, Math.cos(latitude * Math.PI / 180)));
  const keys = [];
  const minRow = Math.floor((latitude - latitudeSpan) / cellDegrees);
  const maxRow = Math.floor((latitude + latitudeSpan) / cellDegrees);
  const minColumn = Math.floor((longitude - longitudeSpan) / cellDegrees);
  const maxColumn = Math.floor((longitude + longitudeSpan) / cellDegrees);
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) keys.push(`${row}:${column}`);
  }
  return keys;
}

/**
 * Build the grid index for a set of roads. Every cell a road passes through
 * gets a reference, so a road is found even when the vehicle is near its middle
 * rather than an endpoint.
 */
export function buildRoadIndex(roads, cellDegrees = DEFAULT_CELL_DEGREES) {
  const index = {};
  roads.forEach((road, roadIndex) => {
    const touched = new Set();
    for (let i = 0; i < road.points.length; i += 1) {
      const [latitude, longitude] = road.points[i];
      touched.add(cellKey(latitude, longitude, cellDegrees));
      // Also stamp the cells between widely spaced nodes.
      const next = road.points[i + 1];
      if (!next) continue;
      const steps = Math.ceil(distanceMetres(latitude, longitude, next[0], next[1]) / 100);
      for (let step = 1; step < steps; step += 1) {
        const t = step / steps;
        touched.add(cellKey(
          latitude + t * (next[0] - latitude),
          longitude + t * (next[1] - longitude),
          cellDegrees
        ));
      }
    }
    for (const key of touched) {
      if (!index[key]) index[key] = [];
      index[key].push(roadIndex);
    }
  });
  return index;
}

export function createLayer({ roads, curves, settings, bbox, cellDegrees = DEFAULT_CELL_DEGREES }) {
  return {
    version: LAYER_VERSION,
    generatedAt: new Date().toISOString(),
    bbox,
    cellDegrees,
    settings,
    roads,
    curves,
    roadIndex: buildRoadIndex(roads, cellDegrees)
  };
}

/** Roads near a point, returned in the Overpass element shape the graph expects. */
export function waysNear(layer, latitude, longitude, radiusMetres) {
  if (!layer) return [];
  const seen = new Set();
  const elements = [];
  for (const key of cellKeysAround(latitude, longitude, radiusMetres, layer.cellDegrees)) {
    for (const roadIndex of layer.roadIndex[key] || []) {
      if (seen.has(roadIndex)) continue;
      seen.add(roadIndex);
      const road = layer.roads[roadIndex];
      elements.push({
        type: 'way',
        id: road.id,
        nodes: road.nodes,
        // `normaliseWays` stores 'unknown' for an untagged way at build time,
        // but rejects that same literal at runtime, so echoing it back made
        // those roads invisible to the corridor builder. Omit it instead.
        tags: {
          highway: road.highway === 'unknown' ? undefined : road.highway,
          name: road.name || undefined,
          oneway: road.oneway ? 'yes' : undefined
        },
        geometry: road.points.map(([lat, lon]) => ({ lat, lon }))
      });
    }
  }
  return elements;
}

export function layerCovers(layer, latitude, longitude, marginDegrees = 0.002) {
  if (!layer || !layer.bbox) return false;
  const [minLat, minLon, maxLat, maxLon] = layer.bbox;
  return latitude >= minLat - marginDegrees && latitude <= maxLat + marginDegrees &&
    longitude >= minLon - marginDegrees && longitude <= maxLon + marginDegrees;
}
