'use strict';

/**
 * Map matching and look-ahead corridor construction from OSM way geometry.
 *
 * Two Part 4 defects are addressed here.
 *
 *  1. Matching was done to way *vertices* with a score that added metres to
 *     degrees. Here candidates are scored on true perpendicular distance to
 *     the segment, with an explicit metres-per-degree heading weight and a
 *     hard rejection of ways running the wrong way.
 *
 *  2. The look-ahead stopped at the end of a single OSM way. OSM splits ways
 *     at junctions and at every tag change, so in practice the corridor often
 *     ended a hundred metres out and any curve past the split was invisible.
 *     `buildCorridor` follows connectivity through shared node ids until the
 *     requested distance is covered.
 */

import { bearingDegrees, bearingDifference, createLocalFrame, distanceMetres, projectOntoPolyline } from './geo.js';

const DRIVEABLE = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$/;

/** Normalise Overpass elements into way records. */
export function normaliseWays(elements) {
  const ways = [];
  for (const element of elements || []) {
    if (element.type !== 'way') continue;
    const geometry = element.geometry;
    if (!Array.isArray(geometry) || geometry.length < 2) continue;
    const highway = element.tags?.highway;
    if (highway && !DRIVEABLE.test(highway)) continue;
    ways.push({
      id: element.id,
      nodes: element.nodes || null,
      highway: highway || 'unknown',
      oneway: element.tags?.oneway === 'yes' || element.tags?.junction === 'roundabout',
      name: element.tags?.name || null,
      points: geometry.map(point => ({ latitude: point.lat, longitude: point.lon }))
    });
  }
  return ways;
}

/** Index ways by their endpoint node ids so the corridor can walk across splits. */
function buildEndpointIndex(ways) {
  const index = new Map();
  ways.forEach((way, wayIndex) => {
    if (!way.nodes || way.nodes.length < 2) return;
    for (const nodeId of [way.nodes[0], way.nodes[way.nodes.length - 1]]) {
      if (!index.has(nodeId)) index.set(nodeId, []);
      index.get(nodeId).push(wayIndex);
    }
  });
  return index;
}

/**
 * Find the way, segment and direction of travel that best explain the fix.
 * @returns {{wayIndex: number, segmentIndex: number, t: number, offset: number,
 *            direction: 1|-1, cost: number}|null}
 */
export function matchPosition(ways, position, headingDegrees, options = {}) {
  const {
    maxOffsetMetres = 60,
    headingWeightMetres = 60,
    maxHeadingDifference = 75
  } = options;
  const frame = createLocalFrame(position);
  const target = frame.toLocal(position);
  const hasHeading = Number.isFinite(headingDegrees);
  let best = null;

  ways.forEach((way, wayIndex) => {
    const localPoints = way.points.map(point => frame.toLocal(point));
    const projection = projectOntoPolyline(localPoints, target);
    if (!projection || projection.offset > maxOffsetMetres) return;

    const a = way.points[projection.segmentIndex];
    const b = way.points[projection.segmentIndex + 1] || a;
    const forwardBearing = bearingDegrees(a, b);

    for (const direction of way.oneway ? [1] : [1, -1]) {
      const travelBearing = direction === 1 ? forwardBearing : (forwardBearing + 180) % 360;
      let headingPenalty = 0;
      if (hasHeading) {
        const difference = bearingDifference(headingDegrees, travelBearing);
        if (difference > maxHeadingDifference) continue;
        headingPenalty = headingWeightMetres * (difference / 90);
      }
      const cost = projection.offset + headingPenalty;
      if (!best || cost < best.cost) {
        best = {
          wayIndex,
          segmentIndex: projection.segmentIndex,
          t: projection.t,
          offset: projection.offset,
          direction,
          cost,
          travelBearing
        };
      }
    }
  });

  return best;
}

/**
 * Build a geographic polyline running `lookAheadMetres` in front of the vehicle,
 * stitching across way boundaries.
 *
 * @returns {{points, wayIds, lengthMetres, truncated, atNetworkEnd}|null}
 *   `truncated` - the corridor is shorter than requested.
 *   `atNetworkEnd` - it is shorter because the road ran out (no connecting way),
 *     not because the budget was reached. The caller uses this to avoid asking
 *     for more geometry that cannot exist.
 */
export function buildCorridor(ways, match, lookAheadMetres, options = {}) {
  const { behindMetres = 40, maxWays = 40 } = options;
  if (!match) return null;
  const endpointIndex = buildEndpointIndex(ways);

  const startWay = ways[match.wayIndex];
  const entryPoint = interpolateGeographic(
    startWay.points[match.segmentIndex],
    startWay.points[match.segmentIndex + 1] || startWay.points[match.segmentIndex],
    match.t
  );

  // A short tail behind the vehicle keeps the projection stable when GPS jitters
  // backwards across the match point.
  const points = [];
  const tail = collectAlongWay(startWay, match, -match.direction, behindMetres, entryPoint);
  for (let i = tail.length - 1; i >= 0; i -= 1) points.push(tail[i]);
  points.push(entryPoint);

  const wayIds = [startWay.id];
  let travelled = 0;
  let currentWay = startWay;
  let currentDirection = match.direction;
  let head = collectAlongWay(startWay, match, currentDirection, lookAheadMetres, entryPoint);
  appendPoints(points, head);
  travelled += polylineLength(head, entryPoint);

  const visited = new Set([startWay.id]);
  let atNetworkEnd = false;

  while (travelled < lookAheadMetres && wayIds.length < maxWays) {
    const exitNodeId = terminalNodeId(currentWay, currentDirection);
    if (exitNodeId == null) { atNetworkEnd = true; break; }
    const candidates = (endpointIndex.get(exitNodeId) || [])
      .map(index => ways[index])
      .filter(way => way && !visited.has(way.id));
    if (candidates.length === 0) { atNetworkEnd = true; break; }

    const incomingBearing = terminalBearing(points);
    let chosen = null;
    for (const candidate of candidates) {
      const startsAtNode = candidate.nodes[0] === exitNodeId;
      const endsAtNode = candidate.nodes[candidate.nodes.length - 1] === exitNodeId;
      const directions = [];
      if (startsAtNode) directions.push(1);
      if (endsAtNode && !candidate.oneway) directions.push(-1);
      for (const direction of directions) {
        const first = direction === 1 ? candidate.points[0] : candidate.points[candidate.points.length - 1];
        const second = direction === 1 ? candidate.points[1] : candidate.points[candidate.points.length - 2];
        if (!first || !second) continue;
        const outgoingBearing = bearingDegrees(first, second);
        const turn = bearingDifference(incomingBearing, outgoingBearing);
        // Prefer going straight on, and prefer staying on the same road name/class.
        const penalty = turn +
          (candidate.name && candidate.name === currentWay.name ? -20 : 0) +
          (candidate.highway === currentWay.highway ? -10 : 0);
        if (turn > 100) continue;
        if (!chosen || penalty < chosen.penalty) chosen = { candidate, direction, penalty };
      }
    }
    if (!chosen) { atNetworkEnd = true; break; }

    visited.add(chosen.candidate.id);
    wayIds.push(chosen.candidate.id);
    const remaining = lookAheadMetres - travelled;
    const ordered = chosen.direction === 1
      ? chosen.candidate.points.slice(1)
      : chosen.candidate.points.slice(0, -1).reverse();
    const segment = truncateToLength(ordered, points[points.length - 1], remaining);
    appendPoints(points, segment);
    travelled += polylineLength(segment, points[points.length - 1 - segment.length] || points[0]);
    currentWay = chosen.candidate;
    currentDirection = chosen.direction;
  }

  if (points.length < 2) return null;
  return {
    points,
    wayIds,
    truncated: travelled < lookAheadMetres,
    atNetworkEnd,
    lengthMetres: polylineLengthTotal(points)
  };
}

function collectAlongWay(way, match, direction, limitMetres, entryPoint) {
  const result = [];
  let previous = entryPoint;
  let travelled = 0;
  let index = direction === 1 ? match.segmentIndex + 1 : match.segmentIndex;
  while (index >= 0 && index < way.points.length && travelled < limitMetres) {
    const point = way.points[index];
    travelled += distanceMetres(previous.latitude, previous.longitude, point.latitude, point.longitude);
    result.push(point);
    previous = point;
    index += direction;
  }
  return result;
}

function truncateToLength(points, startPoint, limitMetres) {
  const result = [];
  let previous = startPoint;
  let travelled = 0;
  for (const point of points) {
    travelled += distanceMetres(previous.latitude, previous.longitude, point.latitude, point.longitude);
    result.push(point);
    previous = point;
    if (travelled >= limitMetres) break;
  }
  return result;
}

function appendPoints(target, source) {
  for (const point of source) {
    const last = target[target.length - 1];
    if (last && Math.abs(last.latitude - point.latitude) < 1e-9 && Math.abs(last.longitude - point.longitude) < 1e-9) continue;
    target.push(point);
  }
}

function terminalNodeId(way, direction) {
  if (!way.nodes || way.nodes.length === 0) return null;
  return direction === 1 ? way.nodes[way.nodes.length - 1] : way.nodes[0];
}

function terminalBearing(points) {
  if (points.length < 2) return 0;
  return bearingDegrees(points[points.length - 2], points[points.length - 1]);
}

function interpolateGeographic(a, b, t) {
  return {
    latitude: a.latitude + t * (b.latitude - a.latitude),
    longitude: a.longitude + t * (b.longitude - a.longitude)
  };
}

function polylineLength(points, startPoint) {
  if (points.length === 0) return 0;
  let total = 0;
  let previous = startPoint || points[0];
  for (const point of points) {
    total += distanceMetres(previous.latitude, previous.longitude, point.latitude, point.longitude);
    previous = point;
  }
  return total;
}

function polylineLengthTotal(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += distanceMetres(points[i - 1].latitude, points[i - 1].longitude, points[i].latitude, points[i].longitude);
  }
  return total;
}
