'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  headingProfile, curvatureFromHeading, analysePolylineByProfile,
  analyseAlignment, PROFILE_DEFAULTS
} from '../lib/curvatureprofile.js';
import { analysePolyline, resample } from '../lib/curvature.js';

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tangentArc(radius, arcLength, tangentLength, noise = 0, seed = 1) {
  const random = mulberry32(seed);
  const points = [];
  for (let s = -tangentLength; s < 0; s += 1) points.push({ x: s, y: 0 });
  for (let s = 0; s <= arcLength; s += 1) {
    const phi = s / radius;
    points.push({ x: radius * Math.sin(phi), y: radius - radius * Math.cos(phi) });
  }
  let heading = arcLength / radius;
  let { x, y } = points[points.length - 1];
  for (let i = 0; i < tangentLength; i += 1) {
    x += Math.cos(heading); y += Math.sin(heading); points.push({ x, y });
  }
  return noise
    ? points.map(p => ({ x: p.x + (random() - 0.5) * 2 * noise, y: p.y + (random() - 0.5) * 2 * noise }))
    : points;
}

function spiralArcSpiral(radius, spiralLength, tangentLength, arcLength, noise = 0, seed = 1) {
  const random = mulberry32(seed);
  const points = [];
  for (let s = -tangentLength; s < 0; s += 1) points.push({ x: s, y: 0 });
  let x = 0;
  let y = 0;
  const n = Math.round(spiralLength);
  for (let i = 1; i <= n; i += 1) {
    const mid = i - 0.5;
    const theta = (mid * mid) / (2 * radius * spiralLength);
    x += Math.cos(theta); y += Math.sin(theta); points.push({ x, y });
  }
  let heading = spiralLength / (2 * radius);
  for (let i = 1; i <= Math.round(arcLength); i += 1) {
    const dTheta = 1 / radius;
    x += Math.cos(heading + dTheta / 2); y += Math.sin(heading + dTheta / 2);
    heading += dTheta; points.push({ x, y });
  }
  for (let i = 1; i <= n; i += 1) {
    const s = spiralLength - (i - 0.5);
    const kappa = s / (radius * spiralLength);
    x += Math.cos(heading + kappa / 2); y += Math.sin(heading + kappa / 2);
    heading += kappa; points.push({ x, y });
  }
  for (let i = 1; i <= tangentLength; i += 1) {
    x += Math.cos(heading); y += Math.sin(heading); points.push({ x, y });
  }
  return noise
    ? points.map(p => ({ x: p.x + (random() - 0.5) * 2 * noise, y: p.y + (random() - 0.5) * 2 * noise }))
    : points;
}

const tightest = result => (result.curves.length
  ? result.curves.reduce((a, b) => (a.radius < b.radius ? a : b)) : null);

test('curvature is recovered as 1/R on a clean arc', () => {
  // The arc is made long enough that the +/-20 m curvature window sits wholly
  // inside it. A shorter arc dilutes the estimate with adjacent tangent and
  // over-reads the radius — the same effect the short-core warning reports at
  // build time, and the reason `auto` mode exists.
  for (const radius of [50, 150, 400]) {
    const arcLength = Math.max(250, radius * 2);
    const points = resample(tangentArc(radius, arcLength, 200), 5);
    const headings = headingProfile(points, 5, 20);
    const curvature = curvatureFromHeading(headings, 5, 40);
    const insideArc = curvature.slice(
      Math.round((200 + arcLength * 0.35) / 5), Math.round((200 + arcLength * 0.65) / 5));
    const mean = insideArc.reduce((a, b) => a + b, 0) / insideArc.length;
    assert.ok(Math.abs(1 / mean - radius) / radius < 0.05,
      `R=${radius}: curvature implies ${(1 / mean).toFixed(1)} m`);
  }
});

test('a curve shorter than the curvature window reads flatter than it is', () => {
  // Documented limitation, in the unsafe direction, which is why the build
  // reports curves whose near-circular core is under 45 m.
  const points = resample(tangentArc(50, 50, 200), 5);
  const curvature = curvatureFromHeading(headingProfile(points, 5, 20), 5, 40);
  const peak = Math.max(...curvature.map(Math.abs));
  assert.ok(1 / peak > 50, 'a short arc should read flatter, not sharper');
  assert.ok(1 / peak < 65, `read ${(1 / peak).toFixed(0)} m for a true 50 m — worse than expected`);
});

test('curvature is signed, and zero on a straight', () => {
  const left = resample(tangentArc(100, 150, 200), 5);
  const right = left.map(p => ({ x: p.x, y: -p.y }));
  const kappaLeft = curvatureFromHeading(headingProfile(left, 5, 20), 5, 40);
  const kappaRight = curvatureFromHeading(headingProfile(right, 5, 20), 5, 40);
  const mid = Math.round(kappaLeft.length * 0.75);
  assert.ok(kappaLeft[mid] * kappaRight[mid] < 0);

  const straight = [];
  for (let x = 0; x <= 500; x += 5) straight.push({ x, y: 0 });
  const kappaStraight = curvatureFromHeading(headingProfile(straight, 5, 20), 5, 40);
  assert.ok(Math.max(...kappaStraight.map(Math.abs)) < 1e-9);
});

test('the profile detector matches the window detector on clean ordinary curves', () => {
  for (const radius of [40, 90, 155, 230, 360]) {
    const points = tangentArc(radius, Math.max(120, radius), 250);
    const profile = tightest(analysePolylineByProfile(points, PROFILE_DEFAULTS));
    assert.ok(profile, `R=${radius} not found`);
    assert.ok(Math.abs(profile.radius - radius) / radius < 0.03,
      `R=${radius} recovered as ${profile.radius.toFixed(0)}`);
  }
});

test('the robust peak keeps noise from collapsing the core', () => {
  // Using the true maximum curvature let one noise spike define the core and
  // returned radii 57-70% too small on gentle curves. The 85th percentile plus
  // a minimum core length fixed it; this locks that in.
  for (const [radius, tolerance] of [[155, 0.2], [230, 0.25]]) {
    const errors = [];
    for (let seed = 1; seed <= 10; seed += 1) {
      const best = tightest(analysePolylineByProfile(
        tangentArc(radius, Math.max(120, radius), 250, 1.0, seed), PROFILE_DEFAULTS));
      if (best) errors.push((best.radius - radius) / radius);
    }
    errors.sort((a, b) => a - b);
    const median = errors[errors.length >> 1];
    assert.ok(Math.abs(median) < tolerance,
      `R=${radius}: median error ${(100 * median).toFixed(0)}%, worse than ${100 * tolerance}%`);
  }
});

test('spiralled curves the window detector misses are found by the profile detector', () => {
  // R = 230 m, IRC spiral length, 60 m circular arc, 1 m noise. The window
  // detector found this in 7 of 12 trials; the profile detector should do
  // materially better, because it tests the whole 210 m run rather than
  // isolated 100 m windows.
  const spiralLength = 2.7 * 80 * 80 / 230;
  let windowFound = 0;
  let profileFound = 0;
  for (let seed = 1; seed <= 12; seed += 1) {
    const points = spiralArcSpiral(230, spiralLength, 250, 60, 1.0, seed);
    if (tightest(analysePolyline(points))) windowFound += 1;
    if (tightest(analysePolylineByProfile(points, PROFILE_DEFAULTS))) profileFound += 1;
  }
  assert.ok(profileFound > windowFound,
    `profile found ${profileFound}/12, window found ${windowFound}/12`);
  assert.ok(profileFound >= 10, `profile found only ${profileFound}/12`);
});

test('a curve with almost no circular portion is less over-estimated', () => {
  // Two spirals meeting with a 20 m arc. The window detector reports +13%;
  // the core-based radius should roughly halve that. Over-estimation is the
  // unsafe direction, so this bound matters.
  const spiralLength = 2.7 * 80 * 80 / 230;
  const points = spiralArcSpiral(230, spiralLength, 250, 20);
  const windowResult = tightest(analysePolyline(points));
  const profileResult = tightest(analysePolylineByProfile(points, PROFILE_DEFAULTS));
  assert.ok(windowResult && profileResult);
  const windowError = (windowResult.radius - 230) / 230;
  const profileError = (profileResult.radius - 230) / 230;
  assert.ok(profileError < windowError,
    `profile +${(100 * profileError).toFixed(0)}% not better than window +${(100 * windowError).toFixed(0)}%`);
  assert.ok(profileError < 0.10, `profile still +${(100 * profileError).toFixed(0)}%`);
});

test('the profile detector reports an estimated transition length', () => {
  const spiralLength = 2.7 * 80 * 80 / 230;
  const best = tightest(analysePolylineByProfile(
    spiralArcSpiral(230, spiralLength, 250, 120), PROFILE_DEFAULTS));
  assert.ok(best);
  assert.ok(Number.isFinite(best.transitionLengthMetres));
  assert.ok(best.transitionLengthMetres > 0,
    'a spiralled curve should report a non-zero transition estimate');
  assert.ok(Number.isFinite(best.coreLengthMetres) && best.coreLengthMetres > 0);
});

test('no phantom curves on noisy straight roads, at any node spacing', () => {
  // The hard constraint: the more sensitive detector must not invent curves.
  for (const spacing of [5, 10, 25, 50]) {
    let phantoms = 0;
    for (let seed = 1; seed <= 6; seed += 1) {
      const random = mulberry32(seed);
      const straight = [];
      for (let x = 0; x <= 2000; x += spacing) straight.push({ x, y: (random() - 0.5) * 2.8 });
      phantoms += analysePolylineByProfile(straight, PROFILE_DEFAULTS).curves.length;
    }
    assert.equal(phantoms, 0, `${phantoms} phantom curves at ${spacing} m node spacing`);
  }
});

test('auto mode falls back to the window detector on short chains', () => {
  // The profile detector differentiates over a window, so a short stub has no
  // usable interior. Auto mode must not lose those curves.
  const shortChain = tangentArc(30, 45, 20);
  const auto = analyseAlignment(shortChain, PROFILE_DEFAULTS);
  assert.equal(auto.detector, 'window');
  assert.ok(auto.curves.length > 0, 'a short chain lost its curve in auto mode');

  const longChain = tangentArc(155, 200, 250);
  assert.equal(analyseAlignment(longChain, PROFILE_DEFAULTS).detector, 'profile');
});

test('auto mode can be overridden explicitly', () => {
  const points = tangentArc(155, 200, 250);
  assert.equal(analyseAlignment(points, { ...PROFILE_DEFAULTS, detector: 'window' }).detector, undefined);
  assert.ok(analyseAlignment(points, { ...PROFILE_DEFAULTS, detector: 'window' }).curves.length > 0);
  assert.ok(analyseAlignment(points, { ...PROFILE_DEFAULTS, detector: 'profile' }).curves.length > 0);
});
