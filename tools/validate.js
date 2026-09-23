'use strict';

/**
 * Validation harness: how well does each estimator recover the surveyed radius,
 * and what does the difference cost in advisory speed?
 *
 * Two modes.
 *
 *   --mode estimator (default)
 *     Runs both the Part 4 estimator (7-node window + Kasa fit, no smoothing,
 *     RMSE gate only) and the revised one (arc-length resampling + Savitzky-
 *     Golay + Taubin + deflection gate) over the surveyed alignment itself, and
 *     compares each against the surveyed radius at the same chainage. This
 *     isolates estimator error from map error.
 *
 *   --mode layer
 *     Compares the built curve layer against the surveyed points, i.e. what
 *     OSM digitising quality actually costs. This is the comparison to report
 *     in the paper; it needs a layer built from real OSM data for the surveyed
 *     stretch.
 *
 * Usage:
 *   node tools/validate.js
 *   node tools/validate.js --mode layer --layer data/curve-layer.json
 *   node tools/validate.js --out logs/validation.csv
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalFrame, cumulativeDistances, distanceMetres, splitOnGaps } from '../lib/geo.js';
import {
  resample, smooth, fitCircleTaubin, fitCircleKasa, curvatureProfile,
  estimateGeometryNoise, DEFAULTS
} from '../lib/curvature.js';
import { advisorySpeedKmh, advisorySpeedPart4 } from '../lib/safespeed.js';
import { ircSuperelevation, capGovernsBelowRadius, designSpeedSensitivity } from '../lib/superelevation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const mode = args.mode || 'estimator';

const surveyed = JSON.parse(await fs.readFile(path.resolve(here, '..', 'data/surveyed-points.json'), 'utf8'));

// The table is not one continuous alignment. Analyse the longest contiguous
// stretch; joining across the multi-hundred-metre gaps would fabricate geometry
// and every statistic computed over it would be meaningless.
const segments = splitOnGaps(surveyed, Number(args['max-gap']) || 40).filter(s => s.length >= 10);
const chosen = segments.sort((a, b) => b.length - a.length)[0];
if (!chosen) throw new Error('No contiguous segment of 10+ points in the surveyed table.');
console.log(`${segments.length} contiguous segment(s) of 10+ points; analysing the longest (${chosen.length} points)\n`);
const alignment = dedupe(chosen);
const frame = createLocalFrame({ latitude: alignment[0].latitude, longitude: alignment[0].longitude });
const local = alignment.map(point => frame.toLocal({ latitude: point.latitude, longitude: point.longitude }));
const chainage = cumulativeDistances(local);

console.log(`Surveyed alignment: ${alignment.length} points, ${chainage[chainage.length - 1].toFixed(0)} m`);
const spacings = [];
for (let i = 1; i < chainage.length; i += 1) spacings.push(chainage[i] - chainage[i - 1]);
console.log(`Point spacing: median ${percentile(spacings, 0.5).toFixed(2)} m`);
console.log(`Surveyed radii: ${Math.min(...alignment.map(p => p.radius)).toFixed(1)} – ${Math.max(...alignment.map(p => p.radius)).toFixed(1)} m`);

/* ------------------------------- what is measurable from this geometry at all */

const diagnosticResampled = resample(local, DEFAULTS.resampleSpacingMetres);
const diagnosticSmoothed = smooth(diagnosticResampled, DEFAULTS.smoothingWindowMetres, DEFAULTS.resampleSpacingMetres);
const alignmentNoise = estimateGeometryNoise(
  diagnosticResampled, diagnosticSmoothed,
  Math.floor((DEFAULTS.smoothingWindowMetres / DEFAULTS.resampleSpacingMetres) / 2)
);
console.log(`\nCoordinate noise about the smoothed centreline: ${alignmentNoise.toFixed(2)} m`);
console.log('Largest radius whose bend still stands clear of that noise, by window length:');
for (const window of [6, 40, 100, 200]) {
  const ceiling = (window * window) / (8 * DEFAULTS.minSagittaToNoise * Math.max(alignmentNoise, 0.1));
  const label = window === 6 ? '  (Part 4\'s effective window on this data)' : '';
  console.log(`  ${String(window).padStart(3)} m window -> R <= ${ceiling.toFixed(0)} m${label}`);
}
const beyond = alignment.filter(point => point.radius >
  (100 * 100) / (8 * DEFAULTS.minSagittaToNoise * Math.max(alignmentNoise, 0.1))).length;
console.log(`${beyond} of ${alignment.length} surveyed radii (${(100 * beyond / alignment.length).toFixed(0)}%) are above the 100 m-window ceiling,`);
console.log('so no short-window method can confirm them from these coordinates.\n');

const comparisons = [];

if (mode === 'estimator') {
  /* ---- Part 4: fixed 7-node window, Kasa fit, no resampling, no smoothing ---- */
  const part4 = [];
  for (let start = 0; start + 7 <= local.length; start += 2) {
    const window = local.slice(start, start + 7);
    const fit = fitCircleKasa(window);
    if (!fit || fit.radius < 15 || fit.radius > 500 || fit.rmse > 3) continue;
    part4.push({
      distance: (chainage[start] + chainage[start + 6]) / 2,
      radius: fit.radius,
      spanMetres: chainage[start + 6] - chainage[start]
    });
  }

  /* ---------------- Revised: resample + smooth + Taubin + deflection ---------- */
  const resampled = resample(local, DEFAULTS.resampleSpacingMetres);
  const smoothed = smooth(resampled, DEFAULTS.smoothingWindowMetres, DEFAULTS.resampleSpacingMetres);
  const profile = curvatureProfile(smoothed, { ...DEFAULTS, fitStepMetres: 5 })
    .filter(window => window.significant)
    .map(window => ({ distance: window.distanceAlong, radius: window.radius }));

  const spans = part4.map(entry => entry.spanMetres);
  if (spans.length) {
    console.log(`Part 4 fit window spanned ${Math.min(...spans).toFixed(0)}–${Math.max(...spans).toFixed(0)} m of road`);
    console.log(`  (a fixed node count over irregular spacing; the revised window is a constant ${DEFAULTS.fitWindowMetres} m)\n`);
  }
  console.log(`Part 4 accepted ${part4.length} windows; revised accepted ${profile.length}\n`);

  for (let i = 0; i < alignment.length; i += 1) {
    const surveyedRadius = alignment[i].radius;
    const part4Radius = interpolate(part4, chainage[i], 30);
    const revisedRadius = interpolate(profile, chainage[i], 30);
    comparisons.push({
      chainage: chainage[i],
      latitude: alignment[i].latitude,
      longitude: alignment[i].longitude,
      surveyedRadius,
      part4Radius,
      revisedRadius
    });
  }
} else if (mode === 'layer') {
  const layerPath = path.resolve(here, '..', stringArg(args, 'layer', 'data/curve-layer.json'));
  const layer = JSON.parse(await fs.readFile(layerPath, 'utf8'));
  console.log(`Layer: ${layer.curves.length} curves, generated ${layer.generatedAt}\n`);
  const tolerance = Number(args.tolerance) || 40;

  for (let i = 0; i < alignment.length; i += 1) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const curve of layer.curves) {
      for (const anchor of [curve.entry, curve.apex, curve.exit]) {
        const distance = distanceMetres(alignment[i].latitude, alignment[i].longitude, anchor[0], anchor[1]);
        if (distance < nearestDistance) { nearestDistance = distance; nearest = curve; }
      }
    }
    comparisons.push({
      chainage: chainage[i],
      latitude: alignment[i].latitude,
      longitude: alignment[i].longitude,
      surveyedRadius: alignment[i].radius,
      part4Radius: null,
      revisedRadius: nearest && nearestDistance <= tolerance ? nearest.radius : null,
      matchDistance: nearestDistance
    });
  }
} else {
  throw new Error(`Unknown mode "${mode}". Use estimator or layer.`);
}

/* ------------------------------------------------------------- reporting */

report('Part 4 estimator (7-node window, Kasa)', comparisons, 'part4Radius', advisorySpeedPart4);
report('Revised estimator (arc-length window, Taubin)', comparisons, 'revisedRadius',
  radius => advisorySpeedKmh(radius, { superelevation: 0 }));

/**
 * Aggregate error hides the thing that matters. A 100 m error on a 250 m curve
 * changes the advisory speed by a few km/h; the same error on a 30 m curve is
 * the difference between an advisory and a crash. Reporting by radius band
 * shows where each estimator actually stands.
 */
stratify('Error by surveyed-radius band', comparisons);

function stratify(title, rows) {
  console.log(`\n=== ${title} ===`);
  console.log('  band (m)        n    Part 4 MedAPE   Revised MedAPE   Part 4 dV   Revised dV');
  const bands = [[0, 40], [40, 80], [80, 150], [150, Infinity]];
  for (const [low, high] of bands) {
    const inBand = rows.filter(row => row.surveyedRadius >= low && row.surveyedRadius < high);
    if (inBand.length === 0) continue;
    const part4 = inBand.filter(row => Number.isFinite(row.part4Radius));
    const revised = inBand.filter(row => Number.isFinite(row.revisedRadius));
    const label = high === Infinity ? `>= ${low}` : `${low}-${high}`;
    console.log(
      `  ${label.padEnd(12)} ${String(inBand.length).padStart(4)}   ` +
      `${pct(part4, 'part4Radius').padStart(12)}   ${pct(revised, 'revisedRadius').padStart(14)}   ` +
      `${speed(part4, 'part4Radius', advisorySpeedPart4).padStart(9)}   ` +
      `${speed(revised, 'revisedRadius', radius => advisorySpeedKmh(radius, { superelevation: 0 })).padStart(10)}`
    );
  }
  console.log('\n  MedAPE = median absolute percentage error in radius.');
  console.log('  dV = median advisory-speed error in km/h; positive means advising too fast.');
}

function pct(rows, key) {
  if (rows.length === 0) return '-';
  return `${(100 * percentile(rows.map(row => Math.abs(row[key] - row.surveyedRadius) / row.surveyedRadius), 0.5)).toFixed(0)}%`;
}

function speed(rows, key, advisoryFunction) {
  if (rows.length === 0) return '-';
  const errors = rows.map(row =>
    advisoryFunction(row[key]) - advisorySpeedKmh(row.surveyedRadius, { superelevation: 0 }));
  const median = percentile(errors, 0.5);
  return `${median >= 0 ? '+' : ''}${median.toFixed(1)}`;
}

function report(title, rows, key, advisoryFunction) {
  const paired = rows.filter(row => Number.isFinite(row[key]) && Number.isFinite(row.surveyedRadius));
  console.log(`\n=== ${title} ===`);
  if (paired.length === 0) {
    console.log('  no overlapping estimates');
    return;
  }
  const errors = paired.map(row => row[key] - row.surveyedRadius);
  const absolute = errors.map(Math.abs);
  const relative = paired.map((row, index) => absolute[index] / row.surveyedRadius);

  console.log(`  points compared        ${paired.length} of ${rows.length} (${(100 * paired.length / rows.length).toFixed(0)}% coverage)`);
  console.log(`  bias (mean error)      ${mean(errors).toFixed(2)} m`);
  console.log(`  MAE                    ${mean(absolute).toFixed(2)} m`);
  console.log(`  median absolute error  ${percentile(absolute, 0.5).toFixed(2)} m`);
  console.log(`  90th pct abs error     ${percentile(absolute, 0.9).toFixed(2)} m`);
  console.log(`  MAPE                   ${(100 * mean(relative)).toFixed(1)}%`);

  // The number that matters operationally: the advisory speed the error produces.
  const speedErrors = paired.map(row => advisoryFunction(row[key]) - advisorySpeedKmh(row.surveyedRadius, { superelevation: 0 }));
  console.log(`  advisory speed bias    ${mean(speedErrors).toFixed(2)} km/h  (positive = advises too fast)`);
  console.log(`  advisory speed MAE     ${mean(speedErrors.map(Math.abs)).toFixed(2)} km/h`);
  const unsafe = speedErrors.filter(value => value > 5).length;
  console.log(`  advises >5 km/h high   ${unsafe} points (${(100 * unsafe / paired.length).toFixed(1)}%)`);
}

/* ------------------------------------------------ superelevation envelope */

reportSuperelevationEnvelope(comparisons);

function reportSuperelevationEnvelope(rows) {
  const designSpeed = Number(args['design-speed']) || 65;
  const maxSuperelevation = Number(args['max-superelevation']) || 0.07;

  console.log('\n=== Advisory-speed envelope from the superelevation assumption ===');
  console.log('Side friction: IRC f = 0.15 (the model used throughout).');
  console.log(`Design speed assumed ${designSpeed} km/h, e_max ${(100 * maxSuperelevation).toFixed(0)}%.`);
  console.log(`The cap governs for every curve below R = ${capGovernsBelowRadius(designSpeed, maxSuperelevation).toFixed(0)} m,`);
  console.log('so below that radius the design-speed assumption cannot change the answer.\n');
  console.log('        R    e design   V(e=0)   V(design)   V(e=7%)   envelope width');

  const bands = [[0, 100], [100, 200], [200, 300], [300, 500], [500, Infinity]];
  for (const [low, high] of bands) {
    const inBand = rows.filter(row => row.surveyedRadius >= low && row.surveyedRadius < high);
    if (inBand.length === 0) continue;
    const radius = percentile(inBand.map(row => row.surveyedRadius), 0.5);
    const e = ircSuperelevation(radius, { designSpeed, maxSuperelevation }).superelevation;
    const v0 = advisorySpeedKmh(radius, { superelevation: 0 });
    const vd = advisorySpeedKmh(radius, { superelevation: e });
    const v7 = advisorySpeedKmh(radius, { superelevation: 0.07 });
    const label = high === Infinity ? `>=${low}` : `${low}-${high}`;
    console.log('  ' + label.padEnd(9) + `(n=${String(inBand.length).padStart(3)})  ` +
      ((100 * e).toFixed(1) + '%').padStart(7) + '  ' +
      (v0.toFixed(0) + ' km/h').padStart(8) + '  ' + (vd.toFixed(0) + ' km/h').padStart(10) + '  ' +
      (v7.toFixed(0) + ' km/h').padStart(9) + '  ' + ((v7 - v0).toFixed(0) + ' km/h').padStart(14));
  }

  const sensitivity = designSpeedSensitivity(rows.map(row => row.surveyedRadius), { maxSuperelevation });
  console.log(`\n  ${sensitivity.insensitive} of ${sensitivity.total} surveyed radii are below the cap threshold,`);
  console.log('  i.e. unaffected by which design speed is assumed.');
  console.log('\n  The envelope width is what a superelevation survey would close.');
  console.log('  Measure e on a sample of curves and pass it with --measured-superelevation at build time.');

  // Friction-model sensitivity, reported rather than adopted: the headline
  // numbers are IRC throughout, and this shows what the alternative would cost.
  console.log('\n  Sensitivity to the friction model (IRC f = 0.15 vs AASHTO f(V)):');
  console.log('        R    V_adv IRC   V_adv AASHTO   difference');
  for (const [low, high] of [[0, 100], [100, 200], [200, 300], [300, 500], [500, Infinity]]) {
    const inBand = rows.filter(row => row.surveyedRadius >= low && row.surveyedRadius < high);
    if (inBand.length === 0) continue;
    const radius = percentile(inBand.map(row => row.surveyedRadius), 0.5);
    const e = ircSuperelevation(radius, { designSpeed, maxSuperelevation }).superelevation;
    const irc = advisorySpeedKmh(radius, { superelevation: e, frictionModel: 'irc' });
    const aashto = advisorySpeedKmh(radius, { superelevation: e, frictionModel: 'aashto' });
    const label = high === Infinity ? `>=${low}` : `${low}-${high}`;
    console.log('    ' + label.padEnd(9) + (irc.toFixed(1) + ' km/h').padStart(11) + '  ' +
      (aashto.toFixed(1) + ' km/h').padStart(13) + '  ' +
      ((aashto - irc >= 0 ? '+' : '') + (aashto - irc).toFixed(1) + ' km/h').padStart(12));
  }
}

/* ------------------------------------------ synthetic-arc estimator check */

if (mode === 'estimator') {
  // Medians, not means: at large radii both estimators are heavy-tailed and a
  // handful of near-collinear samples drags the mean anywhere.
  console.log('\n=== Estimator behaviour on synthetic arcs (0.5 m noise, 600 trials) ===');
  console.log('Median recovered radius; a good estimator sits on the true value.\n');
  console.log('  true R    arc    n     Kasa median   Taubin median   Kasa MedAE  Taubin MedAE');
  for (const [trueRadius, arcLength, count] of [
    [15, 30, 7], [25, 30, 7], [50, 30, 7],
    [50, 40, 9], [100, 40, 9], [100, 100, 21], [200, 100, 21], [200, 200, 41]
  ]) {
    const kasa = [];
    const taubin = [];
    for (let trial = 0; trial < 600; trial += 1) {
      const points = syntheticArc(trueRadius, arcLength, count, 0.5);
      const kasaFit = fitCircleKasa(points);
      const taubinFit = fitCircleTaubin(points);
      if (kasaFit) kasa.push(kasaFit.radius);
      if (taubinFit) taubin.push(taubinFit.radius);
    }
    console.log(
      `  ${String(trueRadius).padStart(6)}  ${String(arcLength).padStart(5)}  ${String(count).padStart(3)}  ` +
      `${percentile(kasa, 0.5).toFixed(1).padStart(12)}  ${percentile(taubin, 0.5).toFixed(1).padStart(14)}  ` +
      `${percentile(kasa.map(r => Math.abs(r - trueRadius)), 0.5).toFixed(1).padStart(11)}  ` +
      `${percentile(taubin.map(r => Math.abs(r - trueRadius)), 0.5).toFixed(1).padStart(12)}`
    );
  }
  console.log('\nNote how both estimators fail at R=100 over a 40 m arc and recover over 100 m:');
  console.log('sagitta grows with the square of the arc length while noise does not, which is');
  console.log('why the pipeline fits at two window scales rather than one.');
}

/* ------------------------------------------------------------------ CSV */

if (args.out) {
  const outputPath = path.resolve(process.cwd(), stringArg(args, 'out'));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const header = ['chainage_m', 'latitude', 'longitude', 'surveyed_radius_m',
    'part4_radius_m', 'revised_radius_m', 'surveyed_advisory_kmh', 'revised_advisory_kmh'];
  const lines = comparisons.map(row => [
    row.chainage.toFixed(1), row.latitude, row.longitude,
    row.surveyedRadius.toFixed(2),
    Number.isFinite(row.part4Radius) ? row.part4Radius.toFixed(2) : '',
    Number.isFinite(row.revisedRadius) ? row.revisedRadius.toFixed(2) : '',
    advisorySpeedKmh(row.surveyedRadius, { superelevation: 0 }).toFixed(2),
    Number.isFinite(row.revisedRadius) ? advisorySpeedKmh(row.revisedRadius, { superelevation: 0 }).toFixed(2) : ''
  ].join(','));
  await fs.writeFile(outputPath, [header.join(','), ...lines].join('\n'));
  console.log(`\nPer-point comparison written to ${path.relative(process.cwd(), outputPath)}`);
}

/* -------------------------------------------------------------- helpers */

function dedupe(points) {
  const output = [];
  for (const point of points) {
    const previous = output[output.length - 1];
    if (previous && distanceMetres(previous.latitude, previous.longitude, point.latitude, point.longitude) < 0.5) continue;
    output.push(point);
  }
  return output;
}

function interpolate(series, distance, tolerance) {
  let best = null;
  let bestGap = Infinity;
  for (const entry of series) {
    const gap = Math.abs(entry.distance - distance);
    if (gap < bestGap) { bestGap = gap; best = entry; }
  }
  return best && bestGap <= tolerance ? best.radius : null;
}

function syntheticArc(radius, arcLengthMetres, pointCount, noiseMetres) {
  const totalAngle = arcLengthMetres / radius;
  const points = [];
  for (let i = 0; i < pointCount; i += 1) {
    const angle = -totalAngle / 2 + (i / (pointCount - 1)) * totalAngle;
    points.push({
      x: radius * Math.sin(angle) + gaussian() * noiseMetres,
      y: radius * Math.cos(angle) + gaussian() * noiseMetres
    });
  }
  return points;
}

function mean(values) {
  if (values.length === 0) return NaN;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values, fraction) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

var spare = null; // eslint-disable-line no-var -- hoisted: used by top-level code above
function gaussian() {
  if (spare !== null) { const value = spare; spare = null; return value; }
  let u = 0;
  let v = 0;
  let s = 0;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
  const factor = Math.sqrt(-2 * Math.log(s) / s);
  spare = v * factor;
  return u * factor;
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

/**
 * Read an option that must be a path or other string. A trailing `--out` with
 * no value parses as boolean `true`, which used to be handed straight to
 * path.resolve and die with an ERR_INVALID_ARG_TYPE stack trace instead of a
 * usage message.
 */
function stringArg(args, key, fallback) {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0) {
    console.error(`Option --${key} needs a value.`);
    process.exit(2);
  }
  return value;
}
