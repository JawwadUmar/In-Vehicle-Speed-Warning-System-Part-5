'use strict';

/**
 * The noise estimate and the analysis windows derived from it.
 *
 * These lock in the fix for the defect that the synthetic-highway test exposed:
 * with the curvature window fixed at 40 m, every curve gentler than about 70 m
 * radius was being read out of digitising noise, and a designed 340 m curve
 * came back as 148 m.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateNodeNoise } from '../lib/curvature.js';
import {
  scaleForNoise, analysePolylineByProfile, PROFILE_DEFAULTS
} from '../lib/curvatureprofile.js';

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianSource(seed) {
  const random = mulberry32(seed);
  let spare = null;
  return function next() {
    if (spare !== null) { const value = spare; spare = null; return value; }
    let u = 0; let v = 0; let s = 0;
    do { u = random() * 2 - 1; v = random() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
    const factor = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * factor;
    return u * factor;
  };
}

function straightWithNoise(spacing, sigma, count, seed = 3) {
  const noise = gaussianSource(seed);
  const points = [];
  for (let i = 0; i < count; i += 1) {
    points.push({ x: i * spacing + noise() * sigma, y: noise() * sigma });
  }
  return points;
}

/** Spiral-arc-spiral at the given node spacing, with Gaussian node noise. */
function curveWithNoise(radius, arcLength, spacing, sigma, seed = 5) {
  const noise = gaussianSource(seed);
  const spiral = Math.min(2.7 * 80 * 80 / radius, arcLength * 0.6, 90);
  const dense = [];
  let x = 0; let y = 0; let heading = 0;
  const advance = (length, curvature) => {
    for (let i = 0; i < Math.round(length); i += 1) {
      const kappa = typeof curvature === 'function' ? curvature(i + 0.5) : curvature;
      x += Math.cos(heading + kappa / 2);
      y += Math.sin(heading + kappa / 2);
      heading += kappa;
      dense.push({ x, y });
    }
  };
  advance(600, 0);
  advance(spiral, s => s / (radius * spiral));
  advance(arcLength, 1 / radius);
  advance(spiral, s => (spiral - s) / (radius * spiral));
  advance(600, 0);

  const sampled = [];
  for (let i = 0; i < dense.length; i += spacing) {
    sampled.push({ x: dense[i].x + noise() * sigma, y: dense[i].y + noise() * sigma });
  }
  return sampled;
}

test('node noise is recovered whatever the node spacing', () => {
  for (const spacing of [10, 32, 60]) {
    const estimate = estimateNodeNoise(straightWithNoise(spacing, 1.2, 2000));
    assert.ok(Math.abs(estimate - 1.2) < 0.2,
      `spacing ${spacing} m: estimated ${estimate.toFixed(2)} m for a true 1.2 m`);
  }
});

test('the estimate scales with the noise actually present', () => {
  const low = estimateNodeNoise(straightWithNoise(30, 0.5, 2000, 11));
  const high = estimateNodeNoise(straightWithNoise(30, 2.0, 2000, 11));
  assert.ok(Math.abs(low - 0.5) < 0.1, `expected ~0.5, got ${low.toFixed(2)}`);
  assert.ok(Math.abs(high - 2.0) < 0.3, `expected ~2.0, got ${high.toFixed(2)}`);
});

test('a curve does not inflate the estimate beyond the conservative direction', () => {
  // The estimate is a median over the whole corridor, so a curve occupying part
  // of it pushes the value up a little. Up is the safe direction -- a longer
  // window and a stricter significance gate -- but it must not run away.
  const estimate = estimateNodeNoise(curveWithNoise(155, 170, 30, 1.2));
  assert.ok(estimate > 1.0 && estimate < 2.0,
    `expected roughly 1.2-1.6 m on a corridor with one curve, got ${estimate.toFixed(2)}`);
});

test('the curvature window grows with the noise, within bounds', () => {
  const settings = { ...PROFILE_DEFAULTS };
  const quiet = scaleForNoise(0.5, settings).curvatureWindowMetres;
  const ordinary = scaleForNoise(1.5, settings).curvatureWindowMetres;
  const bad = scaleForNoise(8, settings).curvatureWindowMetres;
  assert.ok(quiet <= ordinary && ordinary < bad, `${quiet} / ${ordinary} / ${bad}`);
  assert.equal(bad, settings.maxCurvatureWindowMetres);
  assert.ok(quiet >= settings.minCurvatureWindowMetres);
});

test('the derived window clears the sagitta of the radius it is meant to resolve', () => {
  const settings = { ...PROFILE_DEFAULTS };
  for (const sigma of [1, 1.5, 2.5]) {
    const { curvatureWindowMetres: w } = scaleForNoise(sigma, settings);
    const sagitta = w * w / (8 * settings.resolutionCeilingRadiusMetres);
    assert.ok(sagitta >= settings.minSagittaToNoise * sigma - 1e-6,
      `sigma ${sigma}: window ${w} m gives sagitta ${sagitta.toFixed(2)} m, ` +
      `needs ${(settings.minSagittaToNoise * sigma).toFixed(2)} m`);
  }
});

test('an explicit window overrides the derivation', () => {
  const scale = scaleForNoise(2.5, { ...PROFILE_DEFAULTS, curvatureWindowMetres: 45 });
  assert.equal(scale.curvatureWindowMetres, 45);
});

test('a gentle curve survives realistic OSM noise', () => {
  // The regression that started all of this: 340 m radius, 30 m node spacing,
  // 1.2 m noise. The fixed 40 m window reported 148 m (-56%) and often missed
  // the curve outright.
  //
  // The bound here is loose on purpose. Over 60 noise realisations the reported
  // radius runs 256-391 m for a designed 340 m: the median is unbiased but the
  // scatter is real, because a 340 m curve's mid-ordinate over the analysis
  // window is only a few multiples of the noise. That imprecision is tolerable
  // precisely where it occurs -- the IRC advisory speed for 340 m is 97 km/h,
  // and for the 256 m low end it is 85 km/h, both above or near the top of the
  // range a car reaches on these roads. What must not happen is a miss.
  for (const seed of [5, 17, 29, 3, 41]) {
    const result = analysePolylineByProfile(curveWithNoise(340, 190, 30, 1.2, seed));
    const best = result.curves.sort((a, b) => b.lengthMetres - a.lengthMetres)[0];
    assert.ok(best, `seed ${seed}: no curve found`);
    const error = (best.radius - 340) / 340;
    assert.ok(Math.abs(error) < 0.35,
      `seed ${seed}: reported ${best.radius.toFixed(0)} m for a designed 340 m (${(100 * error).toFixed(0)}%)`);
  }
});

test('the curves that matter are the ones reported precisely', () => {
  // Sharp curves are where the advisory speed actually bites, and they are also
  // where the geometry carries the most signal. Measured over 60 noise
  // realisations at 30 m node spacing and 1.2 m noise, the 5th-95th percentile
  // band is 85-93 m at R=90 and 148-163 m at R=155.
  for (const [radius, arc, tolerance] of [[90, 130, 0.12], [155, 170, 0.12], [230, 200, 0.15]]) {
    for (const seed of [5, 17, 29, 3, 41]) {
      const result = analysePolylineByProfile(curveWithNoise(radius, arc, 30, 1.2, seed));
      const best = result.curves.sort((a, b) => b.lengthMetres - a.lengthMetres)[0];
      assert.ok(best, `R=${radius}, seed ${seed}: no curve found`);
      const error = (best.radius - radius) / radius;
      assert.ok(Math.abs(error) < tolerance,
        `R=${radius}, seed ${seed}: reported ${best.radius.toFixed(0)} m (${(100 * error).toFixed(0)}%)`);
    }
  }
});

test('a sharp curve is not flattened by the longer window', () => {
  for (const seed of [5, 17, 29, 3, 41]) {
    const result = analysePolylineByProfile(curveWithNoise(90, 130, 15, 1.2, seed));
    const best = result.curves.sort((a, b) => b.lengthMetres - a.lengthMetres)[0];
    assert.ok(best, `seed ${seed}: no curve found`);
    const error = (best.radius - 90) / 90;
    assert.ok(Math.abs(error) < 0.2,
      `seed ${seed}: reported ${best.radius.toFixed(0)} m for a designed 90 m (${(100 * error).toFixed(0)}%)`);
  }
});

test('noisy straight road still yields no curves at any node spacing', () => {
  for (const spacing of [10, 30, 60]) {
    for (const sigma of [0.8, 1.5, 2.5]) {
      for (const seed of [2, 4]) {
        const points = straightWithNoise(spacing, sigma, Math.round(3000 / spacing), seed);
        const result = analysePolylineByProfile(points);
        assert.equal(result.curves.length, 0,
          `spacing ${spacing} m, noise ${sigma} m, seed ${seed}: ` +
          `${result.curves.length} phantom curve(s)`);
      }
    }
  }
});
