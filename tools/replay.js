'use strict';

/**
 * Offline replay harness.
 *
 * Part 4 could only be tested by driving, which meant the warning logic was
 * never exercised repeatably and a regression could not be detected. This runs
 * a GPS trace (GPX, CSV, or a synthetic drive along the layer) through exactly
 * the same modules the browser uses, and writes the same CSV schema the
 * in-vehicle logger produces -- so field logs and simulated logs are directly
 * comparable.
 *
 * Usage:
 *   node tools/replay.js --synthetic --speed 55
 *   node tools/replay.js --track trip.gpx --out logs/trip.csv
 *
 * Options:
 *   --track <file>        .gpx, or .csv with latitude,longitude[,timestamp]
 *   --synthetic           drive along the curve layer's longest chain
 *   --speed <kmh>         constant speed for a synthetic drive (default 50)
 *   --hz <rate>           synthetic fix rate (default 1)
 *   --noise <metres>      Gaussian GPS noise added to each synthetic fix
 *   --layer <file>        curve layer (default data/curve-layer.json)
 *   --friction irc|aashto   side friction model (default irc)
 *   --superelevation <e> --reaction <s>
 *   --out <file>          CSV output (default logs/replay.csv)
 *   --quiet               suppress the per-alert timeline
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bearingDegrees, createLocalFrame } from '../lib/geo.js';
import { normaliseWays, matchPosition, buildCorridor } from '../lib/roadgraph.js';
import { layerCovers, waysNear } from '../lib/curvelayer.js';
import { buildCorridorPayload, CorridorTracker, MotionEstimator } from '../lib/pipeline.js';
import {
  advisorySpeedPart4, classifyAlert, requiredLookAheadMetres, selectGoverningCurve
} from '../lib/safespeed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

const layerPath = path.resolve(here, '..', stringArg(args, 'layer', 'data/curve-layer.json'));
const layer = JSON.parse(await fs.readFile(layerPath, 'utf8'));
console.log(`Layer: ${layer.roads.length} roads, ${layer.curves.length} curves`);

// Superelevation comes from the curve records the layer was built with; only
// an explicit --superelevation overrides them, for bound comparisons.
const superelevationOverride = args.superelevation === undefined
  ? null : Number(args.superelevation);
const options = {
  frictionModel: args.friction || 'irc',
  superelevation: 0,
  reactionSeconds: Number(args.reaction) || 1.2
};
if (superelevationOverride !== null) {
  console.log(`Overriding superelevation with ${(100 * superelevationOverride).toFixed(1)}% on every curve`);
}

const track = args.track
  ? await loadTrack(path.resolve(process.cwd(), stringArg(args, 'track')))
  : syntheticTrack(layer, Number(args.speed) || 50, Number(args.hz) || 1, Number(args.noise) || 0);

if (track.length < 2) throw new Error('Track has fewer than two fixes.');
console.log(`Track: ${track.length} fixes over ${((track[track.length - 1].timestamp - track[0].timestamp) / 1000).toFixed(0)} s`);

/* ------------------------------------------------------------- the drive */

const tracker = new CorridorTracker();
const motion = new MotionEstimator();
const rows = [];
const timeline = [];
let alertLevel = 'none';
let alertSince = 0;
let corridorBuilds = 0;

for (const fix of track) {
  const state = motion.update(fix, fix.timestamp);
  const position = { latitude: fix.latitude, longitude: fix.longitude };
  const lookAhead = requiredLookAheadMetres(state.speedKmh);

  if (tracker.needsRefresh(position, lookAhead, fix.timestamp)) {
    // In the browser this is an HTTP round trip; here it is a direct call to
    // the same function the server runs, so results are identical.
    if (layerCovers(layer, position.latitude, position.longitude)) {
      const elements = waysNear(layer, position.latitude, position.longitude, lookAhead + 400);
      const payload = buildCorridorPayload(elements, position, state.headingDegrees, lookAhead, {
        superelevationPolicy: layer.superelevationPolicy,
        measuredSuperelevation: layer.measuredSuperelevation,
        layerCurves: layer.curves
      });
      if (payload) {
        tracker.setCorridor({ ...payload, source: 'curve-layer' }, fix.timestamp);
        corridorBuilds += 1;
      }
    }
  }

  const located = tracker.locate(position, fix.timestamp);
  let candidates = located && located.valid ? located.curvesAhead : [];
  if (superelevationOverride !== null) {
    candidates = candidates.map(curve => ({
      ...curve, superelevation: superelevationOverride, superelevationSource: 'override'
    }));
  }
  const governing = selectGoverningCurve(candidates, state.speedKmh, options);

  const requiredDecel = governing ? governing.requiredDeceleration : 0;
  const alert = classifyAlert(requiredDecel, alertLevel);
  const held = alert.level === 'none' && alertLevel !== 'none' && fix.timestamp - alertSince < 2000;
  const effective = held ? alertLevel : alert.level;
  if (effective !== alertLevel) {
    alertLevel = effective;
    alertSince = fix.timestamp;
    if (effective !== 'none' && governing) {
      timeline.push({
        atSeconds: (fix.timestamp - track[0].timestamp) / 1000,
        level: effective,
        speedKmh: state.speedKmh,
        radius: governing.radius,
        advisory: governing.advisorySpeedKmh,
        distance: governing.distanceAhead,
        decel: requiredDecel
      });
    }
  }

  rows.push([
    new Date(fix.timestamp).toISOString(),
    fix.latitude.toFixed(7),
    fix.longitude.toFixed(7),
    Number.isFinite(fix.accuracy) ? fix.accuracy.toFixed(1) : '',
    state.speedKmh.toFixed(2),
    Number.isFinite(state.headingDegrees) ? state.headingDegrees.toFixed(1) : '',
    located && located.valid ? `curve-layer(off ${located.offset.toFixed(1)}m)` : 'unmatched',
    governing ? governing.radius.toFixed(2) : '',
    governing && Number.isFinite(governing.medianRadius) ? governing.medianRadius.toFixed(2) : '',
    governing ? governing.distanceAhead.toFixed(1) : '',
    governing ? (governing.inCurve ? '1' : '0') : '',
    governing && Number.isFinite(governing.distanceToExit) ? governing.distanceToExit.toFixed(1) : '',
    governing && Number.isFinite(governing.superelevation) ? governing.superelevation.toFixed(4) : '',
    governing ? (governing.superelevationSource || 'assumed-zero') : '',
    governing ? governing.advisorySpeedKmh.toFixed(2) : '',
    governing ? advisorySpeedPart4(governing.radius).toFixed(2) : '',
    Number.isFinite(requiredDecel) ? requiredDecel.toFixed(3) : 'inf',
    effective
  ]);
}

/* ---------------------------------------------------------------- output */

const HEADER = [
  'timestamp_iso', 'latitude', 'longitude', 'gps_accuracy_m', 'speed_kmh',
  'heading_deg', 'source', 'curve_radius_m', 'curve_median_radius_m',
  'distance_to_curve_m', 'in_curve', 'distance_to_exit_m',
  'superelevation', 'superelevation_source',
  'advisory_speed_kmh', 'advisory_speed_part4_kmh',
  'required_decel_mps2', 'alert_level'
];

const outputPath = path.resolve(process.cwd(), stringArg(args, 'out', 'logs/replay.csv'));
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, [HEADER.join(','), ...rows.map(row => row.join(','))].join('\n'));

const matched = rows.filter(row => row[6] !== 'unmatched').length;
console.log(`\nmatched ${matched}/${rows.length} fixes (${(100 * matched / rows.length).toFixed(0)}%), ${corridorBuilds} corridor builds`);
console.log(`alerts: ${timeline.length}`);
if (!args.quiet && timeline.length) {
  console.log('\n  t(s)   level      v(km/h)  R(m)   advisory  dist(m)  a_req');
  for (const entry of timeline) {
    console.log(
      `  ${entry.atSeconds.toFixed(0).padStart(5)}  ${entry.level.padEnd(9)}  ` +
      `${entry.speedKmh.toFixed(0).padStart(6)}  ${entry.radius.toFixed(0).padStart(5)}  ` +
      `${entry.advisory.toFixed(0).padStart(7)}   ${entry.distance.toFixed(0).padStart(6)}  ` +
      `${Number.isFinite(entry.decel) ? entry.decel.toFixed(2) : 'inf'}`
    );
  }
}
console.log(`\nCSV written to ${path.relative(process.cwd(), outputPath)}`);

/* --------------------------------------------------------------- loaders */

async function loadTrack(file) {
  const text = await fs.readFile(file, 'utf8');
  if (file.toLowerCase().endsWith('.gpx')) return parseGpx(text);
  return parseCsv(text);
}

function parseGpx(text) {
  // Match each <trkpt ...> tag on its own, then take its body only when the tag
  // was not self-closing. The previous single regex let the non-self-closing
  // alternative match a self-closing tag too (`[^>]*>` happily consumes the
  // "/>"), then scanned on to the next </trkpt> and swallowed every point in
  // between -- a GPX mixing both forms silently lost track points.
  const fixes = [];
  const tagPattern = /<trkpt\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const attributes = match[1];
    const selfClosing = match[2] === '/';
    const latitude = Number(/\blat\s*=\s*"([-\d.eE+]+)"/.exec(attributes)?.[1]);
    const longitude = Number(/\blon\s*=\s*"([-\d.eE+]+)"/.exec(attributes)?.[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    let timestamp = null;
    if (!selfClosing) {
      const close = text.indexOf('</trkpt>', tagPattern.lastIndex);
      const body = close === -1 ? '' : text.slice(tagPattern.lastIndex, close);
      const timeMatch = /<time>([^<]+)<\/time>/.exec(body);
      if (timeMatch) {
        const parsed = Date.parse(timeMatch[1]);
        if (Number.isFinite(parsed)) timestamp = parsed;
      }
      if (close !== -1) tagPattern.lastIndex = close + 8;
    }
    fixes.push({ latitude, longitude, timestamp, speed: null, heading: null, accuracy: 5 });
  }
  return fillMissingTimestamps(fixes);
}

/**
 * Give every fix a timestamp on ONE timeline.
 *
 * Falling back to `Date.now() + index * 1000` per missing point mixed two
 * epochs months apart in the same track: the reported duration came out as
 * 21 782 205 s and every derived speed was 0, because the estimator rejected
 * the impossible gaps -- so no alert could ever fire and the replay looked
 * silently fine. If any real time exists it anchors the track; the rest are
 * interpolated or stepped at 1 Hz from it.
 */
function fillMissingTimestamps(fixes, defaultIntervalMs = 1000) {
  if (fixes.length === 0) return fixes;
  const known = fixes.map((fix, index) => (Number.isFinite(fix.timestamp) ? index : -1))
    .filter(index => index >= 0);

  if (known.length === 0) {
    const base = Date.parse('2026-01-01T00:00:00Z');
    return fixes.map((fix, index) => ({ ...fix, timestamp: base + index * defaultIntervalMs }));
  }
  if (known.length !== fixes.length) {
    console.warn(`  ${fixes.length - known.length} of ${fixes.length} track points had no <time>; interpolating.`);
  }

  for (let i = 0; i < fixes.length; i += 1) {
    if (Number.isFinite(fixes[i].timestamp)) continue;
    const before = known.filter(index => index < i).pop();
    const after = known.find(index => index > i);
    if (before !== undefined && after !== undefined) {
      const span = fixes[after].timestamp - fixes[before].timestamp;
      fixes[i].timestamp = fixes[before].timestamp + span * ((i - before) / (after - before));
    } else if (before !== undefined) {
      fixes[i].timestamp = fixes[before].timestamp + (i - before) * defaultIntervalMs;
    } else {
      fixes[i].timestamp = fixes[after].timestamp - (after - i) * defaultIntervalMs;
    }
  }
  return fixes;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(cell => cell.trim().toLowerCase());
  const latitudeIndex = header.findIndex(cell => /^lat/.test(cell));
  const longitudeIndex = header.findIndex(cell => /^(lon|lng)/.test(cell));
  const timeIndex = header.findIndex(cell => /time|timestamp/.test(cell));
  const speedIndex = header.findIndex(cell => /speed/.test(cell));
  if (latitudeIndex < 0 || longitudeIndex < 0) throw new Error('CSV needs latitude and longitude columns.');

  const rows = lines.slice(1).map(line => {
    const cells = line.split(',');
    const rawTime = timeIndex >= 0 ? cells[timeIndex] : null;
    const parsed = rawTime ? Date.parse(rawTime) : NaN;
    return {
      latitude: Number(cells[latitudeIndex]),
      longitude: Number(cells[longitudeIndex]),
      timestamp: Number.isFinite(parsed) ? parsed : null,
      speed: speedIndex >= 0 && cells[speedIndex] ? Number(cells[speedIndex]) / 3.6 : null,
      heading: null,
      accuracy: 5
    };
  }).filter(fix => Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude));
  return fillMissingTimestamps(rows);
}

/**
 * Drive the longest stitched chain in the layer at a constant speed.
 *
 * The chain is built with the same stitcher the runtime uses, so the synthetic
 * drive follows road across way splits rather than stopping at the first one.
 */
function syntheticTrack(loadedLayer, speedKmh, hz, noiseMetres) {
  const road = [...loadedLayer.roads].sort((a, b) => b.points.length - a.points.length)[0];
  if (!road) throw new Error('Layer contains no roads.');

  const ways = normaliseWays(waysNear(
    loadedLayer, road.points[0][0], road.points[0][1], 5000
  ));
  const origin = { latitude: road.points[0][0], longitude: road.points[0][1] };
  const heading = bearingDegrees(origin, { latitude: road.points[1][0], longitude: road.points[1][1] });
  const match = matchPosition(ways, origin, heading);
  const corridor = match ? buildCorridor(ways, match, 20000, { behindMetres: 0 }) : null;

  const geographic = corridor && corridor.points.length > road.points.length
    ? corridor.points
    : road.points.map(([latitude, longitude]) => ({ latitude, longitude }));
  const frame = createLocalFrame(geographic[0]);
  const local = geographic.map(point => frame.toLocal(point));

  const stepMetres = (speedKmh / 3.6) / hz;
  const fixes = [];
  const start = Date.parse('2026-01-01T09:00:00Z');
  let travelled = 0;
  let segment = 1;
  let accumulated = 0;
  const lengths = [];
  for (let i = 1; i < local.length; i += 1) {
    lengths.push(Math.hypot(local[i].x - local[i - 1].x, local[i].y - local[i - 1].y));
  }
  const total = lengths.reduce((sum, value) => sum + value, 0);

  while (travelled < total) {
    while (segment < local.length && accumulated + lengths[segment - 1] < travelled) {
      accumulated += lengths[segment - 1];
      segment += 1;
    }
    if (segment >= local.length) break;
    const t = lengths[segment - 1] > 0 ? (travelled - accumulated) / lengths[segment - 1] : 0;
    const x = local[segment - 1].x + t * (local[segment].x - local[segment - 1].x) + gaussian() * noiseMetres;
    const y = local[segment - 1].y + t * (local[segment].y - local[segment - 1].y) + gaussian() * noiseMetres;
    const point = frame.toGeographic({ x, y });
    const previous = fixes[fixes.length - 1];
    fixes.push({
      latitude: point.latitude,
      longitude: point.longitude,
      timestamp: start + Math.round((travelled / (speedKmh / 3.6)) * 1000),
      speed: speedKmh / 3.6,
      heading: previous ? bearingDegrees(previous, point) : null,
      accuracy: Math.max(3, noiseMetres * 2)
    });
    travelled += stepMetres;
  }
  return fixes;
}

var spare = null; // eslint-disable-line no-var -- hoisted: used by top-level code above
function gaussian() {
  if (spare !== null) { const value = spare; spare = null; return value; }
  let u = 0;
  let v = 0;
  let s = 0;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
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
