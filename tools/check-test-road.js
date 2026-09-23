'use strict';

/**
 * Match the curves the pipeline found against the curves the test road was
 * designed with, and report what it got right and what it missed.
 *
 * Usage:
 *   node tools/check-test-road.js [--layer data/test-road-layer.json]
 *                                 [--truth data/test-road-truth.json]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distanceMetres } from '../lib/geo.js';
import { advisorySpeedKmh } from '../lib/safespeed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const layerPath = path.resolve(here, '..', args.layer || 'data/test-road-layer.json');
const truthPath = path.resolve(here, '..', args.truth || 'data/test-road-truth.json');
const tolerance = Number(args.tolerance) || 120;

const layer = JSON.parse(await fs.readFile(layerPath, 'utf8'));
const truth = JSON.parse(await fs.readFile(truthPath, 'utf8'));

const detected = layer.curves.map(curve => ({ ...curve, matched: null }));

// Greedy nearest-apex matching, closest pair first, so a detection cannot be
// stolen by a curve it fits worse.
const pairs = [];
truth.curves.forEach((designed, t) => {
  detected.forEach((found, d) => {
    const gap = distanceMetres(designed.apex[0], designed.apex[1], found.apex[0], found.apex[1]);
    if (gap <= tolerance) pairs.push({ t, d, gap });
  });
});
pairs.sort((a, b) => a.gap - b.gap);

const takenTruth = new Set();
const takenFound = new Set();
for (const pair of pairs) {
  if (takenTruth.has(pair.t) || takenFound.has(pair.d)) continue;
  takenTruth.add(pair.t);
  takenFound.add(pair.d);
  truth.curves[pair.t].found = detected[pair.d];
  truth.curves[pair.t].apexGap = pair.gap;
  detected[pair.d].matched = pair.t;
}

/* -------------------------------------------------------------- reporting */

console.log(`Test road: ${truth.totalLengthMetres} m, ${truth.curves.length} designed curves, ` +
  `${truth.noiseMetres} m node noise, ${truth.nodeSpacing[0]}-${truth.nodeSpacing[1]} m spacing`);
console.log(`Layer: ${detected.length} curves detected\n`);

console.log('  designed                          detected');
console.log('  #   R       turn    arc     |  R        turn    apex off   R error   length   core');
console.log('  ' + '-'.repeat(88));

let hits = 0;
const errors = [];
truth.curves.forEach((designed, index) => {
  const found = designed.found;
  const row = '  ' + String(index + 1).padStart(2) + ' ' +
    (designed.radius + ' m').padStart(7) + '  ' + designed.turn.padEnd(6) +
    (designed.arcLengthMetres + ' m').padStart(7) + '  |  ';
  if (!found) {
    console.log(row + 'MISSED');
    return;
  }
  hits += 1;
  const error = (found.radius - designed.radius) / designed.radius;
  errors.push(Math.abs(error));
  console.log(row +
    (found.radius.toFixed(0) + ' m').padStart(7) + '  ' + found.direction.padEnd(7) +
    (designed.apexGap.toFixed(0) + ' m').padStart(7) + '   ' +
    ((error > 0 ? '+' : '') + (error * 100).toFixed(0) + '%').padStart(7) + '  ' +
    (found.lengthMetres.toFixed(0) + ' m').padStart(7) + '  ' +
    ((found.coreLengthMetres ?? 0).toFixed(0) + ' m').padStart(7) +
    (found.direction !== designed.turn ? '   << TURN WRONG' : ''));
});

const spurious = detected.filter(curve => curve.matched === null);
if (spurious.length) {
  console.log(`\n  ${spurious.length} detection(s) with no designed curve nearby (false positives):`);
  spurious.forEach(curve => console.log(`    R=${curve.radius.toFixed(0)} m, ` +
    `${curve.direction}, deflection ${curve.deflectionDegrees.toFixed(0)}deg, ` +
    `apex ${curve.apex[0].toFixed(5)},${curve.apex[1].toFixed(5)}`));
} else {
  console.log('\n  No false positives.');
}

console.log(`\nDetection rate ${hits}/${truth.curves.length}` +
  (errors.length ? `, median |radius error| ${(median(errors) * 100).toFixed(0)}%` : ''));

/* ------------------------------------------- what the driver would be told */

console.log('\nAdvisory speed the driver would see (IRC f=0.15):');
console.log('  #   designed R   true advisory   detected R   shown advisory   difference');
truth.curves.forEach((designed, index) => {
  const found = designed.found;
  const trueAdvisory = advisorySpeedKmh(designed.radius, { superelevation: 0.07 });
  const line = '  ' + String(index + 1).padStart(2) + ' ' + (designed.radius + ' m').padStart(10) +
    (trueAdvisory.toFixed(0) + ' km/h').padStart(15);
  if (!found) { console.log(line + '       (no warning given)'); return; }
  const shown = advisorySpeedKmh(found.radius, { superelevation: found.superelevation });
  console.log(line + (found.radius.toFixed(0) + ' m').padStart(13) +
    (shown.toFixed(0) + ' km/h').padStart(17) +
    ((shown - trueAdvisory > 0 ? '+' : '') + (shown - trueAdvisory).toFixed(0) + ' km/h').padStart(13));
});

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) result[key] = true;
    else { result[key] = next; i += 1; }
  }
  return result;
}
