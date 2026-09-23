'use strict';

/**
 * Head-to-head comparison of the two curve detectors.
 *
 *   window  - sliding fixed-length windows, each tested in isolation
 *             (lib/curvature.js, analysePolyline)
 *   profile - continuous kappa(s), curves detected as runs and tested whole
 *             (lib/curvatureprofile.js, analysePolylineByProfile)
 *
 * Run: node tools/compare-detectors.js [--trials 12]
 *
 * The decision rule is deliberately strict. The profile detector ships only if
 * it improves detection on spiralled curves WITHOUT losing accuracy on ordinary
 * curves and WITHOUT raising the false-positive rate on straight roads. A curve
 * warning system that invents curves is worse than one that misses them.
 */

import { analysePolyline } from '../lib/curvature.js';
import { analysePolylineByProfile } from '../lib/curvatureprofile.js';

const args = Object.fromEntries(process.argv.slice(2)
  .map((value, index, all) => (value.startsWith('--') ? [value.slice(2), all[index + 1]] : null))
  .filter(Boolean));
const TRIALS = Number(args.trials) || 12;

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Straight tangent into a circular arc, joined without a kink. */
function tangentArc(radius, arcLength, tangentLength, step = 1, noise = 0, seed = 1) {
  const random = mulberry32(seed);
  const points = [];
  for (let s = -tangentLength; s < 0; s += step) points.push({ x: s, y: 0 });
  for (let s = 0; s <= arcLength; s += step) {
    const phi = s / radius;
    points.push({ x: radius * Math.sin(phi), y: radius - radius * Math.cos(phi) });
  }
  let heading = arcLength / radius;
  let { x, y } = points[points.length - 1];
  for (let i = 0; i < tangentLength / step; i += 1) {
    x += Math.cos(heading - Math.PI / 2) * step * 0 + Math.cos(heading) * step;
    y += Math.sin(heading) * step;
    points.push({ x, y });
  }
  return noise
    ? points.map(p => ({ x: p.x + (random() - 0.5) * 2 * noise, y: p.y + (random() - 0.5) * 2 * noise }))
    : points;
}

/** Clothoid - circular arc - clothoid, integrated numerically. */
function spiralArcSpiral(radius, spiralLength, tangentLength, arcLength, step = 1, noise = 0, seed = 1) {
  const random = mulberry32(seed);
  const points = [];
  for (let s = -tangentLength; s < 0; s += step) points.push({ x: s, y: 0 });

  let x = 0;
  let y = 0;
  let heading = 0;
  const n = Math.max(1, Math.round(spiralLength / step));
  for (let i = 1; i <= n; i += 1) {
    const mid = (i - 0.5) * spiralLength / n;
    const theta = (mid * mid) / (2 * radius * spiralLength);
    x += Math.cos(theta) * (spiralLength / n);
    y += Math.sin(theta) * (spiralLength / n);
    points.push({ x, y });
  }
  heading = spiralLength / (2 * radius);

  const m = Math.max(1, Math.round(arcLength / step));
  for (let i = 1; i <= m; i += 1) {
    const dTheta = (arcLength / m) / radius;
    x += Math.cos(heading + dTheta / 2) * (arcLength / m);
    y += Math.sin(heading + dTheta / 2) * (arcLength / m);
    heading += dTheta;
    points.push({ x, y });
  }

  for (let i = 1; i <= n; i += 1) {
    const s = spiralLength - (i - 0.5) * spiralLength / n;
    const kappa = s / (radius * spiralLength);
    const ds = spiralLength / n;
    x += Math.cos(heading + kappa * ds / 2) * ds;
    y += Math.sin(heading + kappa * ds / 2) * ds;
    heading += kappa * ds;
    points.push({ x, y });
  }
  for (let i = 1; i <= tangentLength / step; i += 1) {
    x += Math.cos(heading) * step;
    y += Math.sin(heading) * step;
    points.push({ x, y });
  }

  return noise
    ? points.map(p => ({ x: p.x + (random() - 0.5) * 2 * noise, y: p.y + (random() - 0.5) * 2 * noise }))
    : points;
}

function straight(lengthMetres, spacing, noise, seed) {
  const random = mulberry32(seed);
  const points = [];
  for (let x = 0; x <= lengthMetres; x += spacing) {
    points.push({ x, y: (random() - 0.5) * 2 * noise });
  }
  return points;
}

const DETECTORS = {
  window: analysePolyline,
  profile: analysePolylineByProfile
};

/** Tightest curve found, which is the one that would govern the warning. */
function tightest(result) {
  if (!result.curves.length) return null;
  return result.curves.reduce((a, b) => (a.radius < b.radius ? a : b));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function run(name, build, trueRadius, noise) {
  const row = { name, trueRadius };
  for (const [label, detector] of Object.entries(DETECTORS)) {
    const radii = [];
    let found = 0;
    for (let seed = 1; seed <= (noise ? TRIALS : 1); seed += 1) {
      const best = tightest(detector(build(seed)));
      if (best) { found += 1; radii.push(best.radius); }
    }
    const trials = noise ? TRIALS : 1;
    row[label] = {
      detectionRate: found / trials,
      medianRadius: median(radii),
      medianError: radii.length ? (median(radii) - trueRadius) / trueRadius : null
    };
  }
  return row;
}

function printTable(title, rows) {
  console.log(`\n=== ${title} ===`);
  console.log('  case                          true R    window: found  R      err     profile: found  R      err');
  for (const row of rows) {
    const cell = r => (r.detectionRate === 0
      ? '    —      —        —  '
      : `${(100 * r.detectionRate).toFixed(0).padStart(4)}%  ` +
        `${r.medianRadius.toFixed(0).padStart(5)} m  ` +
        `${((r.medianError >= 0 ? '+' : '') + (100 * r.medianError).toFixed(0) + '%').padStart(6)}`);
    console.log('  ' + row.name.padEnd(28) + (row.trueRadius + ' m').padStart(7) + '   ' +
      cell(row.window) + '   ' + cell(row.profile));
  }
}

/* ------------------------------------------------ 1. ordinary curves, clean */

const plainClean = [];
for (const radius of [40, 90, 155, 230, 360]) {
  plainClean.push(run(`tangent-arc, clean`, () => tangentArc(radius, Math.max(120, radius), 250, 1),
    radius, 0));
}
printTable('Ordinary tangent-arc curves, clean geometry (must not regress)', plainClean);

/* ------------------------------------------------ 2. ordinary curves, noisy */

const plainNoisy = [];
for (const radius of [40, 90, 155, 230, 360]) {
  plainNoisy.push(run(`tangent-arc, 1 m noise`,
    seed => tangentArc(radius, Math.max(120, radius), 250, 1, 1.0, seed), radius, 1.0));
}
printTable('Ordinary tangent-arc curves, 1 m noise', plainNoisy);

/* ---------------------------------------------------- 3. spiralled curves */

const spiralled = [];
for (const [radius, designSpeed, arcLength] of
  [[155, 65, 120], [155, 65, 60], [230, 80, 120], [230, 80, 60], [230, 80, 20],
   [360, 100, 120], [360, 100, 60], [360, 100, 20]]) {
  const spiralLength = 2.7 * designSpeed * designSpeed / radius;
  spiralled.push(run(`spiral-arc-spiral, arc ${arcLength} m`,
    () => spiralArcSpiral(radius, spiralLength, 250, arcLength, 1), radius, 0));
}
printTable('Spiral-arc-spiral, clean geometry', spiralled);

const spiralledNoisy = [];
for (const [radius, designSpeed, arcLength] of
  [[155, 65, 60], [230, 80, 60], [230, 80, 20], [360, 100, 60], [360, 100, 120]]) {
  const spiralLength = 2.7 * designSpeed * designSpeed / radius;
  spiralledNoisy.push(run(`spiral-arc-spiral, arc ${arcLength} m`,
    seed => spiralArcSpiral(radius, spiralLength, 250, arcLength, 1, 1.0, seed), radius, 1.0));
}
printTable('Spiral-arc-spiral, 1 m noise (the case the window detector misses)', spiralledNoisy);

/* ------------------------------------------- 4. false positives on straights */

console.log('\n=== False positives on straight road (the hard constraint) ===');
console.log('  node spacing   noise    window          profile');
for (const spacing of [5, 10, 25, 50]) {
  for (const noise of [0.5, 0.8]) {
    const counts = {};
    for (const [label, detector] of Object.entries(DETECTORS)) {
      let phantoms = 0;
      let km = 0;
      for (let seed = 1; seed <= 10; seed += 1) {
        phantoms += detector(straight(2000, spacing, noise * 1.732, seed)).curves.length;
        km += 2;
      }
      counts[label] = phantoms / km;
    }
    console.log('  ' + (spacing + ' m').padStart(12) + '  ' + (noise + ' m').padStart(6) + '   ' +
      (counts.window.toFixed(2) + ' /km').padStart(12) + '    ' +
      (counts.profile.toFixed(2) + ' /km').padStart(12) +
      (counts.profile > counts.window ? '   <-- WORSE' : ''));
  }
}

/* --------------------------------------------------------------- verdict */

console.log('\n=== Verdict ===');
const spiralGain = spiralledNoisy.filter(row =>
  row.profile.detectionRate > row.window.detectionRate).length;
const spiralLoss = spiralledNoisy.filter(row =>
  row.profile.detectionRate < row.window.detectionRate).length;
const plainLoss = [...plainClean, ...plainNoisy].filter(row =>
  row.profile.detectionRate < row.window.detectionRate - 0.01).length;
console.log(`  spiralled cases improved   ${spiralGain} of ${spiralledNoisy.length}`);
console.log(`  spiralled cases worsened   ${spiralLoss}`);
console.log(`  ordinary cases regressed   ${plainLoss} of ${plainClean.length + plainNoisy.length}`);
console.log('\n  Ship the profile detector only if it improves spiralled detection,');
console.log('  regresses no ordinary case, and does not raise the phantom-curve rate.');
