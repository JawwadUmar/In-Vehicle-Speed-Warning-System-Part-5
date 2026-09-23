'use strict';

/**
 * The runtime must report the curve radii that the offline layer was built
 * with, not radii re-derived from whatever slice of road happens to be in the
 * current corridor.
 *
 * The defect these tests lock out: the corridor is a sliding window a few
 * hundred metres long, and the curvature profile is degraded over half an
 * analysis window at each of its ends, so re-analysing it made the reported
 * radius depend on where the vehicle was when the corridor was last rebuilt.
 * On the synthetic test highway at 100 km/h a 525 m curve read 525 m for four
 * seconds and then 329 m on the next rebuild, turning a correctly silent
 * approach into a BRAKE with no advisory before it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCorridorPayload } from '../lib/pipeline.js';

const ORIGIN = { latitude: 22.61, longitude: 75.84 };
const METRES_PER_DEGREE_LAT = 111320;
const METRES_PER_DEGREE_LON = 111320 * Math.cos(ORIGIN.latitude * Math.PI / 180);

const toGeographic = (x, y) => ({
  latitude: ORIGIN.latitude + y / METRES_PER_DEGREE_LAT,
  longitude: ORIGIN.longitude + x / METRES_PER_DEGREE_LON
});

/** Tangent, 250 m arc of the given radius, tangent. One way, 20 m nodes. */
function buildRoad(radius, arcLength = 250, tangent = 700) {
  const dense = [];
  let x = 0;
  let y = 0;
  let heading = 0;
  const advance = (length, curvature) => {
    for (let i = 0; i < length; i += 1) {
      x += Math.cos(heading + curvature / 2);
      y += Math.sin(heading + curvature / 2);
      heading += curvature;
      dense.push({ x, y, s: dense.length });
    }
  };
  advance(tangent, 0);
  const arcStart = dense.length;
  advance(arcLength, 1 / radius);
  const arcEnd = dense.length;
  advance(tangent, 0);

  const nodes = [];
  for (let i = 0; i < dense.length; i += 20) nodes.push(dense[i]);
  nodes.push(dense[dense.length - 1]);

  const geometry = nodes.map(point => {
    const geographic = toGeographic(point.x, point.y);
    return { lat: geographic.latitude, lon: geographic.longitude };
  });
  const apexOf = index => {
    const point = dense[index];
    const geographic = toGeographic(point.x, point.y);
    return [geographic.latitude, geographic.longitude];
  };

  return {
    elements: [{
      type: 'way', id: 1, nodes: nodes.map((_, i) => 100 + i),
      tags: { highway: 'secondary' }, geometry
    }],
    dense,
    layerCurve: {
      id: 'c0',
      radius,
      direction: 'left',
      superelevation: 0.07,
      superelevationSource: 'design-implied',
      wayIds: [1],
      entry: apexOf(arcStart),
      apex: apexOf(Math.round((arcStart + arcEnd) / 2)),
      exit: apexOf(arcEnd - 1)
    },
    at: index => {
      const point = dense[index];
      return toGeographic(point.x, point.y);
    }
  };
}

test('the layer radius is what the corridor reports, not a re-derived one', () => {
  const road = buildRoad(500);
  const payload = buildCorridorPayload(road.elements, road.at(300), 90, 900, {
    layerCurves: [road.layerCurve]
  });
  assert.ok(payload, 'no corridor built');
  assert.equal(payload.curveSource, 'layer');
  assert.equal(payload.curves.length, 1);
  assert.equal(payload.curves[0].radius, 500);
});

test('the reported radius does not change as the corridor slides', () => {
  const road = buildRoad(500);
  const radii = [];
  for (const start of [100, 300, 500, 650, 750, 850]) {
    const payload = buildCorridorPayload(road.elements, road.at(start), 90, 800, {
      layerCurves: [road.layerCurve]
    });
    if (payload && payload.curves.length) radii.push(payload.curves[0].radius);
  }
  assert.ok(radii.length >= 4, `curve reported from only ${radii.length} positions`);
  assert.ok(radii.every(radius => radius === 500),
    `radius varied across corridor rebuilds: ${radii.join(', ')}`);
});

test('a curve the vehicle is already inside is still reported', () => {
  // Its entry lies behind the corridor's start, so a membership test based on
  // the entry -- or on the apex, once that is passed too -- would drop it, and
  // the in-curve warning would go silent exactly where it is needed.
  const road = buildRoad(120, 260);
  for (const offset of [40, 130, 220]) {
    const payload = buildCorridorPayload(road.elements, road.at(700 + offset), null, 600, {
      layerCurves: [road.layerCurve]
    });
    assert.ok(payload, `no corridor built ${offset} m into the curve`);
    assert.equal(payload.curves.length, 1, `curve lost ${offset} m in`);
    assert.equal(payload.curves[0].radius, 120);
    assert.ok(payload.curves[0].startDistance <= payload.curves[0].endDistance);
  }
});

test('a curve on another road is not projected onto this corridor', () => {
  const road = buildRoad(500);
  const foreign = { ...road.layerCurve, id: 'other', radius: 80, wayIds: [999] };
  const payload = buildCorridorPayload(road.elements, road.at(300), 90, 900, {
    layerCurves: [foreign]
  });
  assert.ok(payload);
  assert.equal(payload.curves.length, 0);
});

test('without layer records the corridor is analysed, as in live Overpass mode', () => {
  const road = buildRoad(200);
  const payload = buildCorridorPayload(road.elements, road.at(300), 90, 900, {});
  assert.ok(payload);
  assert.equal(payload.curveSource, 'corridor');
  assert.ok(payload.curves.length >= 1);
});
