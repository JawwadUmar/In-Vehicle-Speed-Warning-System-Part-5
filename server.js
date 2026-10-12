'use strict';

/**
 * Application server.
 *
 * Changes from Part 4:
 *  - The offline curvature layer is the primary geometry source; Overpass is a
 *    fallback that is rate limited, timed out and backed off.
 *  - `/api/road-ahead` returns a *corridor* (resampled centreline + curve
 *    records in arc-length terms), not a raw node list, so the client can keep
 *    distance-to-curve live between requests.
 *  - Per-client rate limiting, so the endpoint cannot be used as an open
 *    Overpass proxy.
 *  - Optional HTTPS. The browser Geolocation API requires a secure context, so
 *    over plain HTTP the app only works on localhost -- which made field
 *    testing on a handset impossible in Part 4.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchWaysNear, LruCache } from './lib/overpass.js';
import { layerCovers, waysNear as layerWaysNear } from './lib/curvelayer.js';
import { buildCorridorPayload } from './lib/pipeline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(here, 'public');
const LIB_ROOT = path.join(here, 'lib');
const DATA_ROOT = path.join(here, 'data');

const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000);
const MAX_LOOK_AHEAD_METRES = 1500;
const OVERPASS_ENABLED = process.env.OVERPASS !== 'off';

const corridorCache = new LruCache(256, CACHE_TTL_MS);
const rateLimiter = new Map();

let curveLayer = null;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

async function loadData() {
  try {
    const raw = await fsp.readFile(path.join(DATA_ROOT, 'curve-layer.json'), 'utf8');
    curveLayer = JSON.parse(raw);
    console.log(`Curve layer loaded: ${curveLayer.roads.length} roads, ${curveLayer.curves.length} curves, bbox ${curveLayer.bbox.join(', ')}`);
    const policy = curveLayer.superelevationPolicy;
    if (policy) {
      console.log(`Superelevation: ${policy.mode === 'zero' ? 'assumed 0%' :
        `design-implied (${policy.roadClass}/${policy.terrain}, Vd ${policy.designSpeed} km/h)`}` +
        `${curveLayer.measuredSuperelevation ? `, ${curveLayer.measuredSuperelevation.length} measured` : ''}`);
    }
  } catch {
    console.log('No data/curve-layer.json found. Run: npm run build:layer -- --bbox <s,w,n,e>');
  }
}

/**
 * Fixed window: `limit` requests per `windowMs`, keyed by remote address.
 *
 * Eviction only removes entries whose window has already expired. Clearing the
 * whole map when it grew, as this originally did, wiped the counters of clients
 * that were currently over the limit -- so rotating source addresses to inflate
 * the map defeated the limiter completely and reopened the endpoint as an open
 * Overpass proxy.
 */
function rateLimited(remoteAddress, limit = 30, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimiter.get(remoteAddress);
  if (!entry || now - entry.windowStart > windowMs) {
    if (rateLimiter.size > 5000) {
      for (const [key, value] of rateLimiter) {
        if (now - value.windowStart > windowMs) rateLimiter.delete(key);
      }
      // Still full of live windows: refuse rather than forget who is over.
      if (rateLimiter.size > 5000) return true;
    }
    rateLimiter.set(remoteAddress, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

async function serveRoadAhead(url, request, response) {
  const remoteAddress = request.socket.remoteAddress || 'unknown';
  if (rateLimited(remoteAddress)) {
    sendJson(response, 429, { error: 'Rate limit exceeded (too many requests to server).', source: 'none' });
    return;
  }

  const latitude = Number(url.searchParams.get('lat'));
  const longitude = Number(url.searchParams.get('lon'));
  const headingRaw = url.searchParams.get('heading');
  const heading = headingRaw === null || headingRaw === '' ? NaN : Number(headingRaw);
  const lookAhead = Math.min(
    MAX_LOOK_AHEAD_METRES,
    Math.max(200, Number(url.searchParams.get('lookahead')) || 600)
  );

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    sendJson(response, 400, { error: 'lat and lon are required and must be valid coordinates.', source: 'none' });
    return;
  }

  const position = { latitude, longitude };

  // 1. Offline layer -- the supported runtime path.
  if (curveLayer && layerCovers(curveLayer, latitude, longitude)) {
    const elements = layerWaysNear(curveLayer, latitude, longitude, lookAhead + 400);
    const payload = buildCorridorPayload(elements, position, heading, lookAhead, {
      superelevationPolicy: curveLayer.superelevationPolicy,
      measuredSuperelevation: curveLayer.measuredSuperelevation,
      layerCurves: curveLayer.curves
    });
    if (payload) {
      sendJson(response, 200, { ...payload, source: 'curve-layer', cached: false });
      return;
    }
    if (!OVERPASS_ENABLED) {
      sendJson(response, 503, {
        error: 'Within offline layer bounding box, but no driveable road matched vehicle position or heading.',
        source: 'none'
      });
      return;
    }
  }

  if (!OVERPASS_ENABLED) {
    sendJson(response, 503, {
      error: 'Position is outside offline curve layer area and live Overpass fallback is disabled (OVERPASS=off).',
      source: 'none'
    });
    return;
  }

  // 2. Live Overpass fallback, cached on a coarse grid so a moving vehicle
  //    reuses one response for a useful stretch of road rather than missing
  //    the cache on every request as Part 4 did.
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)},${Math.round((heading || 0) / 45)},${Math.round(lookAhead / 200)}`;
  const cached = corridorCache.get(key);
  if (cached) {
    sendJson(response, 200, { ...cached, cached: true });
    return;
  }

  try {
    const elements = await fetchWaysNear(latitude, longitude, lookAhead + 400, { attempts: 2, timeoutMs: 12000 });
    // No layer here, so no design-speed context: fall back to the conservative
    // bound rather than inventing a policy for an unknown road.
    const payload = buildCorridorPayload(elements, position, heading, lookAhead, {
      superelevationPolicy: { mode: 'zero' }
    });
    if (!payload) throw new Error('No driveable road matched near this location in OSM.');
    const value = { ...payload, source: 'overpass' };
    corridorCache.set(key, value);
    sendJson(response, 200, { ...value, cached: false });
  } catch (error) {
    console.error('Road lookup failed:', error.message);
    sendJson(response, 503, {
      error: 'Road geometry temporarily unavailable',
      details: error.message,
      source: 'none'
    });
  }
}

function serveHealth(response) {
  sendJson(response, 200, {
    ok: true,
    curveLayer: curveLayer
      ? {
          roads: curveLayer.roads.length,
          curves: curveLayer.curves.length,
          bbox: curveLayer.bbox,
          generatedAt: curveLayer.generatedAt,
          superelevationPolicy: curveLayer.superelevationPolicy || null,
          measuredSuperelevationCount: curveLayer.measuredSuperelevation
            ? curveLayer.measuredSuperelevation.length : 0
        }
      : null,
    overpassFallback: OVERPASS_ENABLED,
    cacheEntries: corridorCache.size
  });
}

function serveStatic(urlPath, response) {
  let decoded;
  try {
    // A malformed percent-escape ("/%") makes decodeURIComponent throw. Inside
    // the async handler that became an unhandled rejection and killed the
    // process, taking every subsequent request with it.
    decoded = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath);
  } catch {
    sendText(response, 400, 'Bad request');
    return;
  }
  const relative = decoded.replace(/^\/+/, '');
  // `lib/` and `data/` are served read-only so the browser can import the same
  // geometry modules the server and the offline tools use.
  let root = PUBLIC_ROOT;
  let target = relative;
  if (relative.startsWith('lib/')) { root = LIB_ROOT; target = relative.slice(4); }
  else if (relative.startsWith('data/')) { root = DATA_ROOT; target = relative.slice(5); }

  const filePath = path.resolve(root, target);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    sendText(response, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) { sendText(response, 404, 'Not found'); return; }
    const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': `${contentType}; charset=utf-8` };
    // The service worker must never be cached by the browser's HTTP cache, or
    // an updated worker will not be picked up.
    if (filePath.endsWith('service-worker.js')) headers['Cache-Control'] = 'no-cache';
    response.writeHead(200, headers);
    response.end(contents);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

function sendText(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(value);
}

async function handler(request, response) {
  // Nothing below may be allowed to reject: an unhandled rejection in a request
  // handler terminates the Node process, which for this app means the driver's
  // warnings stop for the rest of the journey.
  try {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
      sendText(response, 400, 'Bad request');
      return;
    }
    if (url.pathname === '/api/road-ahead') return await serveRoadAhead(url, request, response);
    if (url.pathname === '/api/health') return serveHealth(response);
    return serveStatic(url.pathname, response);
  } catch (error) {
    console.error('Request failed:', error && error.stack ? error.stack : error);
    if (!response.headersSent) sendText(response, 500, 'Internal error');
    else response.end();
  }
}

process.on('unhandledRejection', error => {
  console.error('Unhandled rejection (server continues):', error);
});

await loadData();

const certPath = process.env.TLS_CERT;
const keyPath = process.env.TLS_KEY;
if (certPath && keyPath) {
  https.createServer(
    { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
    handler
  ).listen(PORT, () => console.log(`Curve speed warning (HTTPS): https://localhost:${PORT}`));
} else {
  http.createServer(handler).listen(PORT, () => {
    console.log(`Curve speed warning: http://localhost:${PORT}`);
    console.log('Note: browsers only grant geolocation on localhost or HTTPS.');
    console.log('For on-road testing set TLS_CERT and TLS_KEY (see README).');
  });
}
