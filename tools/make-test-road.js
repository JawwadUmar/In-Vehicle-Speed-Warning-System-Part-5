'use strict';

/**
 * Generate a realistic two-lane rural highway with KNOWN geometry, then degrade
 * it to look like OpenStreetMap tracing.
 *
 * This exists because a curve detector can only be trusted if it is checked
 * against an alignment whose answers are known. Real OSM has no ground truth;
 * the surveyed table in data/ is 182 m long and its radius column does not
 * match its own coordinates. So: design a corridor to IRC, lay clothoid
 * transitions on it, then throw away the precision the way OSM does -- coarse
 * irregular node spacing and a metre or so of positional noise -- and see what
 * the pipeline gets back.
 *
 * Usage:
 *   node tools/make-test-road.js [--design-speed 80] [--noise 1.2]
 *                                [--spacing-min 15] [--spacing-max 45] [--seed 7]
 *
 * Writes an Overpass-shaped network plus a ground-truth file of every curve.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalFrame, distanceMetres } from '../lib/geo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

const designSpeed = Number(args['design-speed']) || 80;
const noiseMetres = args.noise === undefined ? 1.2 : Number(args.noise);
const spacingMin = Number(args['spacing-min']) || 15;
const spacingMax = Number(args['spacing-max']) || 45;
const seed = Number(args.seed) || 7;
const origin = { latitude: 22.6100, longitude: 75.8400 };

const random = mulberry32(seed);
let spare = null;

/**
 * The design. Radii chosen to span the range that matters on a rolling-terrain
 * two-lane highway: IRC ruling and absolute minima for 80 km/h are about 230
 * and 155 m, so the set brackets those and includes one substandard curve and
 * two gentle ones near the limit of what OSM geometry can resolve.
 */
const DESIGNS = {};
DESIGNS.rural = [
  { tangent: 700 },
  { radius: 500, arc: 220, turn: 'left', note: 'gentle, near the detection ceiling' },
  { tangent: 450 },
  { radius: 230, arc: 200, turn: 'right', note: 'IRC ruling minimum for 80 km/h' },
  { tangent: 520 },
  { radius: 155, arc: 170, turn: 'left', note: 'IRC absolute minimum for 80 km/h' },
  { tangent: 300 },
  { radius: 340, arc: 190, turn: 'right', note: 'gentle' },
  { tangent: 480 },
  { radius: 90, arc: 130, turn: 'left', note: 'substandard for 80 km/h' },
  { tangent: 260 },
  { radius: 260, arc: 180, turn: 'right', note: 'reverse curve, short tangent before it' },
  { tangent: 700 }
];

/**
 * A ghat-section road: short, sharp curves with short tangents between them.
 * This is the opposite stress case to the rural design -- it checks that a
 * detector tuned long enough to resolve gentle curves does not blur these.
 */
DESIGNS.hill = [
  { tangent: 250 },
  { radius: 45, arc: 60, turn: 'left', note: 'hairpin' },
  { tangent: 120 },
  { radius: 80, arc: 70, turn: 'right', note: 'sharp' },
  { tangent: 90 },
  { radius: 60, arc: 55, turn: 'left', note: 'sharp, short tangent either side' },
  { tangent: 150 },
  { radius: 110, arc: 80, turn: 'right', note: 'moderate' },
  { tangent: 100 },
  { radius: 50, arc: 65, turn: 'left', note: 'hairpin' },
  { tangent: 130 },
  { radius: 70, arc: 60, turn: 'right', note: 'reverse curve' },
  { tangent: 250 }
];

/** A dead straight road, for counting phantom curves. */
DESIGNS.straight = [{ tangent: 5000 }];

const DESIGN = DESIGNS[stringArg(args, 'design', 'rural')] || DESIGNS.rural;

/* ------------------------------------------------------ build the alignment */

const STEP = 1;
const local = [{ x: 0, y: 0 }];
const truth = [];
let heading = 0;
let x = 0;
let y = 0;
let chainage = 0;

const advance = (distance, curvature) => {
  const steps = Math.max(1, Math.round(distance / STEP));
  const ds = distance / steps;
  for (let i = 0; i < steps; i += 1) {
    const kappa = typeof curvature === 'function' ? curvature((i + 0.5) * ds) : curvature;
    x += Math.cos(heading + kappa * ds / 2) * ds;
    y += Math.sin(heading + kappa * ds / 2) * ds;
    heading += kappa * ds;
    chainage += ds;
    local.push({ x, y });
  }
};

for (const element of DESIGN) {
  if (element.tangent) { advance(element.tangent, 0); continue; }

  const { radius, arc, turn } = element;
  const sign = turn === 'left' ? 1 : -1;
  // IRC transition length, capped so a sharp curve does not get a spiral longer
  // than the curve itself.
  const spiral = Math.min(2.7 * designSpeed * designSpeed / radius, arc * 0.6, 90);

  const startChainage = chainage;
  advance(spiral, s => sign * (s / (radius * spiral)));       // entry clothoid
  const circularStart = chainage;
  advance(arc, sign / radius);                                 // circular arc
  const circularEnd = chainage;
  advance(spiral, s => sign * ((spiral - s) / (radius * spiral))); // exit clothoid
  const endChainage = chainage;

  truth.push({
    radius,
    turn,
    spiralLengthMetres: round(spiral, 1),
    arcLengthMetres: arc,
    startChainage: round(startChainage, 1),
    circularStartChainage: round(circularStart, 1),
    circularEndChainage: round(circularEnd, 1),
    endChainage: round(endChainage, 1),
    apexChainage: round((circularStart + circularEnd) / 2, 1),
    note: element.note
  });
}

const frame = createLocalFrame(origin);
const geographic = local.map(point => frame.toGeographic(point));

// Attach apex coordinates to the ground truth, so detections can be matched
// by position rather than by an index that depends on the detector.
for (const curve of truth) {
  const index = Math.round(curve.apexChainage / STEP);
  const apex = geographic[Math.min(index, geographic.length - 1)];
  curve.apex = [round(apex.latitude, 7), round(apex.longitude, 7)];
}

/* ------------------------------------------------- degrade it to look like OSM */

const sampled = [];
let cursor = 0;
while (cursor < geographic.length - 1) {
  sampled.push(geographic[Math.round(cursor)]);
  cursor += spacingMin + random() * (spacingMax - spacingMin);
}
sampled.push(geographic[geographic.length - 1]);

const metresPerDegreeLat = 111320;
const metresPerDegreeLon = 111320 * Math.cos(origin.latitude * Math.PI / 180);
const noisy = sampled.map(point => ({
  latitude: point.latitude + gaussian() * noiseMetres / metresPerDegreeLat,
  longitude: point.longitude + gaussian() * noiseMetres / metresPerDegreeLon
}));

/* ----------------------------------- split into ways, as OSM splits a road */

const elements = [];
const nodeIds = noisy.map((_, index) => 500000 + index);
const WAYS = 7;
const perWay = Math.ceil((noisy.length - 1) / WAYS);
for (let piece = 0; piece < WAYS; piece += 1) {
  const start = piece * perWay;
  const end = Math.min(noisy.length - 1, start + perWay);
  if (start >= end) break;
  elements.push({
    type: 'way',
    id: 800000 + piece,
    nodes: nodeIds.slice(start, end + 1),
    tags: { highway: 'secondary', name: 'Test Highway', ref: 'SH-999' },
    geometry: noisy.slice(start, end + 1)
      .map(point => ({ lat: round(point.latitude, 7), lon: round(point.longitude, 7) }))
  });
}

/* ------------------------------------------------------------------ output */

const networkPath = path.resolve(here, '..', stringArg(args, 'out', 'data/test-road-overpass.json'));
const truthPath = path.resolve(here, '..', stringArg(args, 'truth', 'data/test-road-truth.json'));

await fs.writeFile(networkPath, JSON.stringify({ version: 0.6, generator: 'make-test-road', elements }, null, 1));
await fs.writeFile(truthPath, JSON.stringify({
  designSpeed,
  noiseMetres,
  nodeSpacing: [spacingMin, spacingMax],
  seed,
  origin,
  totalLengthMetres: round(chainage, 0),
  curves: truth
}, null, 2));

let spans = [];
for (let i = 1; i < noisy.length; i += 1) {
  spans.push(distanceMetres(noisy[i - 1].latitude, noisy[i - 1].longitude,
    noisy[i].latitude, noisy[i].longitude));
}
spans.sort((a, b) => a - b);

console.log(`Test highway: ${(chainage / 1000).toFixed(2)} km, design speed ${designSpeed} km/h`);
console.log(`${truth.length} curves designed, radii ${Math.min(...truth.map(c => c.radius))}-${Math.max(...truth.map(c => c.radius))} m`);
console.log(`Degraded to OSM-like geometry: ${noisy.length} nodes, spacing ` +
  `${spans[0].toFixed(0)}-${spans[spans.length - 1].toFixed(0)} m (median ${spans[spans.length >> 1].toFixed(0)} m), ` +
  `${noiseMetres} m positional noise`);
console.log(`Split into ${elements.length} ways, as OSM would\n`);
console.log('  #   R      turn   spiral   arc    chainage (TS-ST)     note');
truth.forEach((curve, index) => {
  console.log('  ' + String(index + 1).padStart(2) + '  ' + (curve.radius + ' m').padStart(6) + '  ' +
    curve.turn.padEnd(6) + ' ' + (curve.spiralLengthMetres + ' m').padStart(7) + ' ' +
    (curve.arcLengthMetres + ' m').padStart(6) + '   ' +
    (curve.startChainage.toFixed(0) + '-' + curve.endChainage.toFixed(0)).padStart(12) + '     ' + curve.note);
});
console.log(`\nwritten to ${path.relative(process.cwd(), networkPath)} and ${path.relative(process.cwd(), truthPath)}`);

/* ----------------------------------------------------------------- helpers */

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function gaussian() {
  if (spare !== null) { const value = spare; spare = null; return value; }
  let u = 0;
  let v = 0;
  let s = 0;
  do { u = random() * 2 - 1; v = random() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
  const factor = Math.sqrt(-2 * Math.log(s) / s);
  spare = v * factor;
  return u * factor;
}

function mulberry32(value) {
  let a = value;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function stringArg(parsed, key, fallback) {
  const value = parsed[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0) {
    console.error(`Option --${key} needs a value.`);
    process.exit(2);
  }
  return value;
}
