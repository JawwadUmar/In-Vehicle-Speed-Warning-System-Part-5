'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resample, smooth, fitCircleTaubin, fitCircleKasa, signedDeflectionDegrees,
  curvatureProfile, extractCurves, analysePolyline, DEFAULTS
} from '../lib/curvature.js';
import { projectOntoPolyline, cumulativeDistances, createLocalFrame, distanceMetres } from '../lib/geo.js';

/** Points along a circular arc of known radius. */
function arc(radius, arcLengthMetres, count, noise = 0, seed = 1) {
  const random = mulberry32(seed);
  const totalAngle = arcLengthMetres / radius;
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const angle = -totalAngle / 2 + (i / (count - 1)) * totalAngle;
    points.push({
      x: radius * Math.sin(angle) + (random() - 0.5) * 2 * noise,
      y: radius * Math.cos(angle) + (random() - 0.5) * 2 * noise
    });
  }
  return points;
}

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('Taubin recovers a clean arc radius to within 0.1%', () => {
  for (const radius of [12, 25, 60, 150, 400]) {
    const fit = fitCircleTaubin(arc(radius, 40, 9));
    assert.ok(fit, `no fit for R=${radius}`);
    assert.ok(Math.abs(fit.radius - radius) / radius < 0.001,
      `R=${radius} recovered as ${fit.radius.toFixed(3)}`);
    assert.ok(fit.rmse < 1e-6);
  }
});

test('Taubin is less biased than Kasa on short noisy arcs', () => {
  // The Part 4 estimator's failure mode: on a short arc with noise, the naive
  // algebraic fit pulls the radius towards zero.
  for (const radius of [25, 50, 100]) {
    let kasaTotal = 0;
    let taubinTotal = 0;
    let samples = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const points = arc(radius, 30, 7, 0.5, seed);
      const kasa = fitCircleKasa(points);
      const taubin = fitCircleTaubin(points);
      if (!kasa || !taubin) continue;
      kasaTotal += kasa.radius - radius;
      taubinTotal += taubin.radius - radius;
      samples += 1;
    }
    const kasaBias = Math.abs(kasaTotal / samples);
    const taubinBias = Math.abs(taubinTotal / samples);
    assert.ok(taubinBias <= kasaBias + 1e-9,
      `R=${radius}: Taubin bias ${taubinBias.toFixed(2)} exceeded Kasa bias ${kasaBias.toFixed(2)}`);
  }
});

test('resample produces uniform spacing regardless of input spacing', () => {
  // Deliberately irregular input, as OSM geometry is.
  const points = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 60, y: 0 },
    { x: 61, y: 0 }, { x: 140, y: 0 }
  ];
  const output = resample(points, 5);
  const gaps = [];
  for (let i = 1; i < output.length; i += 1) {
    gaps.push(Math.hypot(output[i].x - output[i - 1].x, output[i].y - output[i - 1].y));
  }
  const maximum = Math.max(...gaps);
  const minimum = Math.min(...gaps);
  assert.ok(maximum - minimum < 1e-6, `spacing varied between ${minimum} and ${maximum}`);
  assert.ok(Math.abs(maximum - 5) < 0.3, `spacing ${maximum} not close to 5 m`);
});

test('smoothing preserves curvature rather than flattening it', () => {
  // A moving average would inflate the radius here; the quadratic SG filter
  // should leave it essentially unchanged.
  const points = resample(arc(50, 120, 200), 5);
  const before = fitCircleTaubin(points).radius;
  const after = fitCircleTaubin(smooth(points, 40, 5)).radius;
  assert.ok(Math.abs(after - before) / before < 0.02,
    `radius moved from ${before.toFixed(2)} to ${after.toFixed(2)}`);
});

test('a straight road with noise yields no significant curve', () => {
  const random = mulberry32(7);
  const straight = [];
  for (let i = 0; i <= 100; i += 1) {
    straight.push({ x: i * 5, y: (random() - 0.5) * 3 });
  }
  const { curves } = analysePolyline(straight);
  assert.equal(curves.length, 0, `found ${curves.length} spurious curves on a straight road`);
});

/**
 * A tangent running along +x into a left-hand arc of the given radius, joined
 * tangentially so there is no artificial kink at the transition.
 */
function tangentThenArc(radius, arcLengthMetres, straightMetres, spacing = 5) {
  const points = [];
  for (let s = -straightMetres; s < 0; s += spacing) points.push({ x: s, y: 0 });
  for (let s = 0; s <= arcLengthMetres; s += spacing) {
    const phi = s / radius;
    points.push({ x: radius * Math.sin(phi), y: radius - radius * Math.cos(phi) });
  }
  return points;
}

test('a real curve is detected with the right radius and direction', () => {
  const combined = tangentThenArc(80, 120, 200);

  const { curves } = analysePolyline(combined);
  assert.equal(curves.length, 1, `expected one curve, got ${curves.length}`);
  assert.ok(Math.abs(curves[0].radius - 80) / 80 < 0.15,
    `radius ${curves[0].radius.toFixed(1)} not within 15% of 80 m`);
  assert.ok(curves[0].lengthMetres > 50);
});

test('deflection sign distinguishes left from right turns', () => {
  const left = arc(60, 90, 30);
  const right = left.map(point => ({ x: -point.x, y: point.y }));
  assert.ok(signedDeflectionDegrees(left) * signedDeflectionDegrees(right) < 0);
});

test('curvature profile flags only the curved windows', () => {
  // Called directly, so the noise level must be supplied explicitly; via
  // analysePolyline it is measured from the geometry.
  const points = resample(tangentThenArc(70, 150, 300), 5);
  const profile = curvatureProfile(smooth(points, DEFAULTS.smoothingWindowMetres, 5),
    { ...DEFAULTS, geometryNoiseMetres: 0.1, minAssumedNoiseMetres: 0.1 });
  const significant = profile.filter(window => window.significant);
  assert.ok(significant.length > 0, 'no significant windows on a curved road');
  assert.ok(significant.length < profile.length, 'every window flagged, including the straight');
  const curves = extractCurves(profile, DEFAULTS);
  assert.ok(curves.length >= 1);
});

test('the noise gate scales the detectable radius with the window length', () => {
  // With 1 m of assumed noise a 40 m window can only confirm R <= ~67 m; the
  // 100 m window carries the rest. Both scales run in analysePolyline, so a
  // 70 m curve on clean geometry must still be found even though the short
  // window alone cannot confirm it.
  const { curves } = analysePolyline(tangentThenArc(70, 200, 300));
  assert.ok(curves.length >= 1, 'a 70 m curve was missed entirely');
  assert.ok(Math.abs(curves[0].radius - 70) / 70 < 0.25,
    `radius ${curves[0].radius.toFixed(1)} not within 25% of 70 m`);
});

test('sparsely noded geometry is not mistaken for noise-free geometry', () => {
  // Resampling interpolates between nodes, so measuring the residual on the
  // RESAMPLED line reports widely spaced noisy nodes as pristine. At 25 m
  // spacing that under-read the noise tenfold and let ~9 phantom curves per km
  // through. The noise must be measured against the original nodes.
  let phantoms = 0;
  for (let seed = 1; seed <= 8; seed += 1) {
    const random = mulberry32(seed);
    const straight = [];
    for (let x = 0; x <= 2000; x += 25) straight.push({ x, y: (random() - 0.5) * 2.8 });
    phantoms += analysePolyline(straight).curves.length;
  }
  assert.equal(phantoms, 0, `${phantoms} phantom curves over 16 km of sparsely noded straight road`);
});

test('projection onto a polyline beats nearest-vertex distance', () => {
  // Two vertices 100 m apart; a point 5 m off the middle of the segment.
  const polyline = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const projection = projectOntoPolyline(polyline, { x: 50, y: 5 });
  assert.ok(Math.abs(projection.offset - 5) < 1e-9, `offset ${projection.offset}`);
  assert.ok(Math.abs(projection.distanceAlong - 50) < 1e-9, `along ${projection.distanceAlong}`);

  const nearestVertex = Math.min(
    Math.hypot(50 - 0, 5 - 0),
    Math.hypot(50 - 100, 5 - 0)
  );
  assert.ok(projection.offset < nearestVertex,
    'segment projection should be closer than the nearest vertex');
});

test('cumulative distance and projection agree along an arc', () => {
  const points = resample(arc(100, 200, 400), 5);
  const cumulative = cumulativeDistances(points);
  const midpoint = points[Math.floor(points.length / 2)];
  const projection = projectOntoPolyline(points, midpoint, cumulative);
  assert.ok(projection.offset < 1e-6);
  assert.ok(Math.abs(projection.distanceAlong - cumulative[Math.floor(points.length / 2)]) < 1e-6);
});

test('local frame round-trips to within a millimetre', () => {
  const frame = createLocalFrame({ latitude: 22.5227, longitude: 75.9237 });
  const original = { latitude: 22.5251, longitude: 75.9269 };
  const back = frame.toGeographic(frame.toLocal(original));
  const error = distanceMetres(original.latitude, original.longitude, back.latitude, back.longitude);
  assert.ok(error < 0.001, `round-trip error ${error} m`);
});

test('noisy straight roads do not generate phantom curves across many seeds', () => {
  // The false-alarm rate is what makes or breaks driver trust, so this sweeps
  // seeds rather than relying on one lucky sample.
  let falsePositives = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const random = mulberry32(seed);
    const straight = [];
    for (let i = 0; i <= 120; i += 1) straight.push({ x: i * 5, y: (random() - 0.5) * 3 });
    falsePositives += analysePolyline(straight).curves.length;
  }
  assert.equal(falsePositives, 0, `${falsePositives} phantom curves over 40 noisy straights (24 km)`);
});

test('genuine curves are still found once noise is added', () => {
  for (const radius of [30, 60, 120]) {
    let detected = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const random = mulberry32(seed);
      const points = tangentThenArc(radius, Math.max(90, radius * 1.5), 200)
        .map(point => ({ x: point.x + (random() - 0.5) * 1.6, y: point.y + (random() - 0.5) * 1.6 }));
      const { curves } = analysePolyline(points);
      if (curves.some(curve => Math.abs(curve.radius - radius) / radius < 0.4)) detected += 1;
    }
    assert.ok(detected >= 18, `R=${radius}: detected in only ${detected}/20 noisy trials`);
  }
});
