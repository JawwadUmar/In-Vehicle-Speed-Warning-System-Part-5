'use strict';

/**
 * Turn the surveyed alignment into an Overpass-shaped road network, so the
 * whole pipeline can be built and replayed without network access.
 *
 * The alignment is deliberately cut into several ways that share endpoint node
 * ids, mirroring how OSM splits roads at junctions and tag changes. That is
 * what exercises the chain stitching in build-curve-layer.js and the corridor
 * stitching in lib/roadgraph.js -- the case Part 4 could not handle at all.
 *
 * Usage: node tools/make-sample-network.js [--ways 6] [--out data/sample-overpass.json]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distanceMetres, splitOnGaps } from '../lib/geo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const wayCount = Number(args.ways) || 6;
const outputPath = path.resolve(here, '..', stringArg(args, 'out', 'data/sample-overpass.json'));

const points = JSON.parse(await fs.readFile(path.resolve(here, '..', 'data/surveyed-points.json'), 'utf8'));

// The surveyed table is NOT one continuous drive: it contains jumps of several
// hundred metres between separate stretches. Joining them would fabricate road.
const segments = splitOnGaps(points, Number(args['max-gap']) || 40)
  .filter(segment => segment.length >= 4);

console.log(`${segments.length} contiguous segments of 4+ points:`);
const elements = [];
let nextNodeId = 100000;
let wayId = 900000;
let totalLength = 0;

segments.forEach((segment, segmentIndex) => {
  const length = segmentLength(segment);
  totalLength += length;
  console.log(`  segment ${segmentIndex}: ${segment.length} points, ${length.toFixed(0)} m`);

  const nodeIds = segment.map(() => nextNodeId++);
  // Split the longer segments into several ways sharing endpoint nodes, so the
  // chain stitcher has something to rejoin -- this is how OSM stores roads.
  const pieces = segment.length >= 40 ? wayCount : 1;
  const perWay = Math.ceil((segment.length - 1) / pieces);
  for (let piece = 0; piece < pieces; piece += 1) {
    const start = piece * perWay;
    const end = Math.min(segment.length - 1, start + perWay);
    if (start >= end) break;
    elements.push({
      type: 'way',
      id: wayId++,
      nodes: nodeIds.slice(start, end + 1),
      tags: {
        highway: segmentIndex === 0 ? 'secondary' : 'tertiary',
        name: `Sample Survey Road ${segmentIndex}`,
        surface: 'asphalt'
      },
      geometry: segment.slice(start, end + 1).map(point => ({ lat: point.latitude, lon: point.longitude }))
    });
  }
});

await fs.writeFile(outputPath, JSON.stringify({ version: 0.6, generator: 'make-sample-network', elements }, null, 1));
console.log(`\n${totalLength.toFixed(0)} m of real alignment across ${segments.length} segments`);
console.log(`${elements.length} ways written to ${path.relative(process.cwd(), outputPath)}`);

function segmentLength(segment) {
  let total = 0;
  for (let i = 1; i < segment.length; i += 1) {
    total += distanceMetres(
      segment[i - 1].latitude, segment[i - 1].longitude,
      segment[i].latitude, segment[i].longitude
    );
  }
  return total;
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
