'use strict';

/**
 * Build the offline curvature layer for a study region.
 *
 * This is the build-time half of the architecture change: everything expensive
 * or unreliable -- the Overpass call, the stitching, the smoothing, the circle
 * fitting -- happens once, here, instead of in the vehicle at 80 km/h.
 *
 * Curves are derived from *chains* rather than individual ways. OSM splits a
 * road at every junction and tag change, so a curve frequently straddles two or
 * three way records; analysing ways in isolation would cut those curves in half
 * and inflate their fitted radii.
 *
 * Usage:
 *   node tools/build-curve-layer.js --bbox 22.515,75.915,22.532,75.932
 *   node tools/build-curve-layer.js --input data/sample-overpass.json
 *
 * Options:
 *   --bbox s,w,n,e      fetch this bounding box from Overpass
 *   --input <file>      read a saved Overpass JSON response instead (offline)
 *   --save-raw <file>   write the fetched Overpass response for reuse
 *   --out <file>        output path (default data/curve-layer.json)
 *   --min-radius, --max-radius, --fit-window, --min-deflection
 *   --min-noise <m>     floor on assumed positional noise (default 1 m, suited
 *                       to OSM). Lower it only for survey-grade geometry.
 *   --detector auto|profile|window   curve detector. Default 'auto': the
 *                       kappa(s) profile detector on chains of 150 m or more,
 *                       the sliding-window detector on shorter stubs where the
 *                       profile method has no room to work. See
 *                       tools/compare-detectors.js for the head-to-head.
 *
 * Superelevation (design-implied per IRC, see lib/superelevation.js):
 *   --road-class NH|SH|MDR|ODR|VR      default SH
 *   --terrain plain|rolling|mountainous|steep   default rolling
 *   --design-basis minimum|ruling      default minimum (conservative)
 *   --design-speed <kmh>               explicit override of the table
 *   --superelevation zero|design       default design; zero reports the
 *                                      conservative lower bound instead
 *   --measured-superelevation <csv>    survey values, columns
 *                                      latitude,longitude,superelevation
 *                                      (e as a fraction, or as a percent if
 *                                      any value exceeds 1). Matched to curves
 *                                      by proximity, so it survives rebuilds.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchWaysInBbox } from '../lib/overpass.js';
import { normaliseWays } from '../lib/roadgraph.js';
import { createLocalFrame, bearingDegrees, cumulativeDistances } from '../lib/geo.js';
import { DEFAULTS } from '../lib/curvature.js';
import { analyseAlignment, PROFILE_DEFAULTS } from '../lib/curvatureprofile.js';
import { createLayer } from '../lib/curvelayer.js';
import {
  designSpeedKmh, ircSuperelevation, resolveSuperelevation, measuredSuperelevationNear,
  designSpeedSensitivity, capGovernsBelowRadius, MAX_SUPERELEVATION
} from '../lib/superelevation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const outputPath = path.resolve(here, '..', stringArg(args, 'out', 'data/curve-layer.json'));

const curvatureSettings = {
  ...DEFAULTS,
  ...PROFILE_DEFAULTS,
  detector: stringArg(args, 'detector', 'auto'),
  minRadiusMetres: numberOr(args['min-radius'], DEFAULTS.minRadiusMetres),
  maxRadiusMetres: numberOr(args['max-radius'], DEFAULTS.maxRadiusMetres),
  fitWindowMetres: numberOr(args['fit-window'], DEFAULTS.fitWindowMetres),
  minDeflectionDegrees: numberOr(args['min-deflection'], DEFAULTS.minDeflectionDegrees),
  minAssumedNoiseMetres: numberOr(args['min-noise'], DEFAULTS.minAssumedNoiseMetres)
};

/* ------------------------------------------------- superelevation policy */

const roadClass = stringArg(args, 'road-class', 'SH');
const terrain = stringArg(args, 'terrain', 'rolling');
const designBasis = stringArg(args, 'design-basis', 'minimum');
const maxSuperelevation = MAX_SUPERELEVATION[terrain] ?? 0.07;
const designSpeed = numberOr(args['design-speed'], designSpeedKmh(roadClass, terrain, designBasis));
const superelevationMode = stringArg(args, 'superelevation', 'design');

const superelevationPolicy = {
  mode: superelevationMode,
  designSpeed,
  maxSuperelevation,
  roadClass,
  terrain,
  basis: designBasis
};

let measuredSuperelevation = null;
if (args['measured-superelevation']) {
  measuredSuperelevation = await readMeasuredSuperelevation(
    path.resolve(here, '..', stringArg(args, 'measured-superelevation')));
  console.log(`${measuredSuperelevation.length} measured superelevation values loaded`);
}

console.log(`Superelevation: ${superelevationMode === 'zero' ? 'assumed 0% (conservative bound)' :
  `design-implied, ${roadClass} / ${terrain} / ${designBasis} design speed ${designSpeed} km/h, e_max ${(100 * maxSuperelevation).toFixed(0)}%`}`);
console.log(`  the e_max cap governs for every curve below R = ${capGovernsBelowRadius(designSpeed, maxSuperelevation).toFixed(0)} m\n`);

let elements;
if (args.input) {
  const raw = JSON.parse(await fs.readFile(path.resolve(here, '..', stringArg(args, 'input')), 'utf8'));
  elements = Array.isArray(raw) ? raw : raw.elements;
  console.log(`Read ${elements.length} elements from ${args.input}`);
} else if (args.bbox) {
  const bbox = String(args.bbox).split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(value => !Number.isFinite(value))) {
    throw new Error('--bbox must be south,west,north,east');
  }
  console.log(`Querying Overpass for ${bbox.join(', ')} …`);
  elements = await fetchWaysInBbox(bbox, {
    timeoutMs: 180000,
    onRetry: (error, delay) => console.warn(`  retrying after ${delay} ms: ${error.message}`)
  });
  console.log(`Received ${elements.length} elements`);
  if (args['save-raw']) {
    await fs.writeFile(path.resolve(here, '..', stringArg(args, 'save-raw')), JSON.stringify({ elements }));
    console.log(`Raw response saved to ${args['save-raw']}`);
  }
} else {
  throw new Error('Provide either --bbox s,w,n,e or --input <overpass.json>');
}

const ways = normaliseWays(elements);
if (ways.length === 0) throw new Error('No driveable ways in the input.');
console.log(`${ways.length} driveable ways`);

/* --------------------------------------------------- chain construction */

const chains = buildChains(ways);
console.log(`${chains.length} stitched chains (median ${median(chains.map(c => c.points.length))} points)`);
const unstitchable = chains.filter(chain => chain.nodes.length === 0).length;
if (unstitchable > 0) {
  console.warn(`  ${unstitchable} chain(s) had no node ids and could not be joined to neighbours.`);
  console.warn('  Re-export with "out body geom;" so ways can be stitched across splits.');
}

/* ---------------------------------------------------- curvature analysis */

const curves = [];
const detectorUse = {};
// The analysis windows are derived per chain from that chain's measured node
// noise, so the layer records what was actually used rather than the nulls that
// stand for "derive it". Without this a layer is not reproducible from its own
// settings block.
const scalesUsed = [];
let analysed = 0;
for (const chain of chains) {
  if (chain.points.length < 4) continue;
  const frame = createLocalFrame(chain.points[0]);
  const localPoints = chain.points.map(point => frame.toLocal(point));
  const analysis = analyseAlignment(localPoints, curvatureSettings);
  detectorUse[analysis.detector || curvatureSettings.detector] =
    (detectorUse[analysis.detector || curvatureSettings.detector] || 0) + 1;
  if (analysis.scale) {
    scalesUsed.push({
      lengthMetres: Math.round(analysis.lengthMetres),
      geometryNoiseMetres: Math.round(analysis.geometryNoiseMetres * 100) / 100,
      ...analysis.scale
    });
  }
  if (analysis.curves.length === 0) continue;
  analysed += 1;

  const cumulative = cumulativeDistances(analysis.resampled);
  for (const curve of analysis.curves) {
    const entryLocal = pointAt(analysis.resampled, cumulative, curve.startDistance);
    const exitLocal = pointAt(analysis.resampled, cumulative, curve.endDistance);
    const apexLocal = pointAt(analysis.resampled, cumulative, (curve.startDistance + curve.endDistance) / 2);
    const beforeLocal = pointAt(analysis.resampled, cumulative, Math.max(0, curve.startDistance - 25));
    const afterLocal = pointAt(analysis.resampled, cumulative,
      Math.min(cumulative[cumulative.length - 1], curve.endDistance + 25));

    const entry = frame.toGeographic(entryLocal);
    const exit = frame.toGeographic(exitLocal);
    const apex = frame.toGeographic(apexLocal);

    const measured = measuredSuperelevation
      ? measuredSuperelevationNear(measuredSuperelevation, apex.latitude, apex.longitude)
      : null;
    const resolved = resolveSuperelevation(curve.radius, superelevationPolicy, measured);
    const irc = ircSuperelevation(curve.radius, { designSpeed, maxSuperelevation });

    curves.push({
      id: `c${curves.length}`,
      radius: round(curve.radius, 2),
      medianRadius: round(curve.medianRadius, 2),
      superelevation: round(resolved.value, 4),
      superelevationSource: resolved.source,
      designSpeedKmh: designSpeed,
      capGoverns: irc.capped,
      substandard: irc.substandard,
      restrictedSpeedKmh: round(irc.restrictedSpeedKmh, 1),
      direction: curve.direction,
      lengthMetres: round(curve.lengthMetres, 1),
      deflectionDegrees: round(curve.deflectionDegrees, 1),
      maxRmse: round(curve.maxRmse, 2),
      // Estimated transition (spiral) length per end, and the length of the
      // near-circular core. Reported, not relied on: on OSM geometry the
      // spiral's footprint is usually below the digitising noise.
      transitionLengthMetres: Number.isFinite(curve.transitionLengthMetres)
        ? round(curve.transitionLengthMetres, 1) : null,
      coreLengthMetres: Number.isFinite(curve.coreLengthMetres)
        ? round(curve.coreLengthMetres, 1) : null,
      entry: [round(entry.latitude, 7), round(entry.longitude, 7)],
      apex: [round(apex.latitude, 7), round(apex.longitude, 7)],
      exit: [round(exit.latitude, 7), round(exit.longitude, 7)],
      bearingIn: round(bearingDegrees(frame.toGeographic(beforeLocal), entry), 1),
      bearingOut: round(bearingDegrees(exit, frame.toGeographic(afterLocal)), 1),
      wayIds: chain.wayIds,
      source: 'curve-layer'
    });
  }
}

console.log(`${curves.length} curves from ${analysed} chains`);
const useSummary = Object.entries(detectorUse).map(([k, v]) => `${v} ${k}`).join(', ');
if (useSummary) console.log(`  detector used: ${useSummary}`);
if (scalesUsed.length) {
  const noise = scalesUsed.map(scale => scale.geometryNoiseMetres).sort((a, b) => a - b);
  const windows = scalesUsed.map(scale => scale.curvatureWindowMetres).sort((a, b) => a - b);
  const ceiling = Math.round((windows[0] * windows[0]) / (8 * 3 * noise[noise.length - 1]));
  console.log(`  node noise ${noise[0].toFixed(2)}-${noise[noise.length - 1].toFixed(2)} m ` +
    `-> curvature window ${windows[0]}-${windows[windows.length - 1]} m`);
  console.log(`  gentlest radius this geometry can resolve: about ${ceiling} m ` +
    `(curves flatter than that are reported with wide uncertainty)`);
}

/* ------------------------------------------------------------ assembly */

const roads = ways.map(way => ({
  id: way.id,
  nodes: way.nodes,
  highway: way.highway,
  name: way.name,
  oneway: way.oneway,
  points: way.points.map(point => [round(point.latitude, 7), round(point.longitude, 7)])
}));

// Accumulate rather than spreading into Math.min/Math.max: a modest city bbox
// is a few hundred thousand coordinates, and the spread blew the call stack
// AFTER the Overpass fetch and the whole curvature analysis had completed.
let minLat = Infinity;
let minLon = Infinity;
let maxLat = -Infinity;
let maxLon = -Infinity;
for (const road of roads) {
  for (const [latitude, longitude] of road.points) {
    if (latitude < minLat) minLat = latitude;
    if (latitude > maxLat) maxLat = latitude;
    if (longitude < minLon) minLon = longitude;
    if (longitude > maxLon) maxLon = longitude;
  }
}
const bbox = [minLat, minLon, maxLat, maxLon];

const layer = createLayer({
  roads, curves, bbox,
  settings: { ...curvatureSettings, derivedScales: scalesUsed }
});
layer.superelevationPolicy = superelevationPolicy;
if (measuredSuperelevation) layer.measuredSuperelevation = measuredSuperelevation;
await fs.writeFile(outputPath, JSON.stringify(layer));

const bytes = (await fs.stat(outputPath)).size;
console.log(`\nLayer written to ${path.relative(process.cwd(), outputPath)} (${(bytes / 1024).toFixed(0)} kB)`);
if (curves.length) {
  const radii = curves.map(curve => curve.radius).sort((a, b) => a - b);
  console.log(`radius  min ${radii[0].toFixed(1)}  median ${radii[Math.floor(radii.length / 2)].toFixed(1)}  max ${radii[radii.length - 1].toFixed(1)} m`);
  const sharp = curves.filter(curve => curve.radius < 50).length;
  console.log(`${sharp} curves below 50 m radius`);

  /* ------------------------------------- superelevation sensitivity report */

  const sensitivity = designSpeedSensitivity(curves.map(curve => curve.radius), { maxSuperelevation });
  const measuredCount = curves.filter(curve => curve.superelevationSource === 'measured').length;
  const substandardCount = curves.filter(curve => curve.substandard).length;

  const shortCore = curves.filter(curve =>
    Number.isFinite(curve.coreLengthMetres) && curve.coreLengthMetres < 45).length;
  if (shortCore > 0) {
    console.log(`\n${shortCore} curve(s) have a near-circular core under 45 m — their radius may be`);
    console.log('over-estimated by roughly 5% because the fit spans part of the transition.');
  }

  console.log('\nSuperelevation');
  console.log(`  measured          ${measuredCount} curve(s)`);
  console.log(`  design-implied    ${curves.length - measuredCount} curve(s)`);
  console.log(`  at the e_max cap  ${curves.filter(c => c.capGoverns).length} of ${curves.length}`);
  console.log(`  substandard for ${designSpeed} km/h (IRC restricts the speed)  ${substandardCount}`);
  console.log('\nDesign-speed sensitivity (65 / 80 / 100 km/h):');
  console.log(`  unaffected by the assumption  ${sensitivity.insensitive} of ${sensitivity.total} curves`);
  if (sensitivity.sensitive > 0) {
    console.log(`  affected                      ${sensitivity.sensitive} (radii ` +
      `${Math.min(...sensitivity.sensitiveRadii).toFixed(0)}-${Math.max(...sensitivity.sensitiveRadii).toFixed(0)} m), ` +
      `max spread ${(100 * sensitivity.maxSuperelevationSpread).toFixed(1)} percentage points of e`);
  } else {
    console.log('  affected                      none — the cap governs every detected curve,');
    console.log('                                so the design-speed assumption does not enter the result');
  }
}

/* ------------------------------------------------------------ helpers */

/**
 * Join ways into chains through nodes where exactly two way-ends meet.
 * A junction (three or more ends) terminates a chain, because beyond it the
 * road ahead depends on which way the driver turns -- that decision belongs to
 * the runtime corridor builder, not to the offline layer.
 */
function buildChains(inputWays) {
  const endpointIndex = new Map();
  inputWays.forEach((way, index) => {
    if (!way.nodes || way.nodes.length < 2) return;
    for (const nodeId of [way.nodes[0], way.nodes[way.nodes.length - 1]]) {
      if (!endpointIndex.has(nodeId)) endpointIndex.set(nodeId, []);
      endpointIndex.get(nodeId).push(index);
    }
  });

  const used = new Set();
  const output = [];

  inputWays.forEach((way, index) => {
    if (used.has(index)) return;
    used.add(index);
    // A way with no node ids cannot be stitched, but it must still be analysed
    // on its own. Skipping it entirely meant an Overpass response saved with
    // `out geom;` instead of `out body geom;` produced a layer with zero
    // curves that still loaded and served happily, warning about nothing.
    if (!way.nodes || way.nodes.length < 2) {
      output.push({ points: [...way.points], nodes: [], wayIds: [way.id] });
      return;
    }

    let points = [...way.points];
    let nodes = [...way.nodes];
    const wayIds = [way.id];

    // Extend forwards, then backwards.
    for (const forwards of [true, false]) {
      for (;;) {
        const terminalNode = forwards ? nodes[nodes.length - 1] : nodes[0];
        const attached = (endpointIndex.get(terminalNode) || []).filter(other => !used.has(other));
        const degree = (endpointIndex.get(terminalNode) || []).length;
        if (degree !== 2 || attached.length !== 1) break;
        const nextIndex = attached[0];
        const next = inputWays[nextIndex];
        if (!next.nodes) break;
        used.add(nextIndex);
        wayIds.push(next.id);

        const startsHere = next.nodes[0] === terminalNode;
        const orderedPoints = startsHere ? next.points.slice(1) : next.points.slice(0, -1).reverse();
        const orderedNodes = startsHere ? next.nodes.slice(1) : next.nodes.slice(0, -1).reverse();

        if (forwards) {
          points = points.concat(orderedPoints);
          nodes = nodes.concat(orderedNodes);
        } else {
          points = orderedPoints.reverse().concat(points);
          nodes = orderedNodes.reverse().concat(nodes);
        }
      }
    }
    output.push({ points, nodes, wayIds });
  });

  return output;
}

function pointAt(points, cumulative, distance) {
  if (distance <= 0) return points[0];
  const total = cumulative[cumulative.length - 1];
  if (distance >= total) return points[points.length - 1];
  let i = 1;
  while (i < cumulative.length && cumulative[i] < distance) i += 1;
  const span = cumulative[i] - cumulative[i - 1];
  const t = span > 1e-9 ? (distance - cumulative[i - 1]) / span : 0;
  return {
    x: points[i - 1].x + t * (points[i].x - points[i - 1].x),
    y: points[i - 1].y + t * (points[i].y - points[i - 1].y)
  };
}

/** Read a survey CSV of latitude,longitude,superelevation. */
async function readMeasuredSuperelevation(file) {
  const text = await fs.readFile(file, 'utf8');
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(cell => cell.trim().toLowerCase());
  const latIndex = header.findIndex(cell => /^lat/.test(cell));
  const lonIndex = header.findIndex(cell => /^(lon|lng)/.test(cell));
  const eIndex = header.findIndex(cell => /super|elev|^e$|bank/.test(cell));
  if (latIndex < 0 || lonIndex < 0 || eIndex < 0) {
    throw new Error('Measured superelevation CSV needs latitude, longitude and superelevation columns.');
  }
  const rows = lines.slice(1).map(line => {
    const cells = line.split(',');
    return [Number(cells[latIndex]), Number(cells[lonIndex]), Number(cells[eIndex])];
  }).filter(row => row.every(Number.isFinite));

  // Accept either fractions or percentages; if anything exceeds 1 it must be %.
  const asPercent = rows.some(row => Math.abs(row[2]) > 1);
  if (asPercent) {
    console.log('  values look like percentages; dividing by 100');
    return rows.map(([lat, lon, value]) => [lat, lon, value / 100]);
  }
  return rows;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value, digits) {
  if (typeof value !== 'number') return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
