'use strict';

/**
 * Overpass client with the operational safeguards Part 4 was missing:
 * an identifying User-Agent (required by the OSM API usage policy), a hard
 * request timeout, exponential backoff with respect for Retry-After, endpoint
 * rotation, and a bounded LRU cache instead of an unbounded Map.
 *
 * Overpass fair-use allows a couple of requests per minute. Part 4 polled it
 * every 15 s with a cache key rounded to ~11 m, so nearly every request was a
 * miss and sustained driving would earn a 429 within minutes. This client is
 * intended for *build-time* extraction (see tools/build-curve-layer.js) and as
 * a last-resort runtime source; the offline layer is the supported runtime path.
 */

export const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

export const USER_AGENT =
  'CurveSpeedWarning/5.0 (research prototype; https://github.com/example/curve-speed-warning)';

const DRIVEABLE_FILTER =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

export function buildQuery({ latitude, longitude, radiusMetres, bbox, timeoutSeconds = 60 }) {
  const selector = `["highway"~"^(${DRIVEABLE_FILTER})$"]`;
  const area = bbox
    ? `(${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]})`
    : `(around:${Math.round(radiusMetres)},${latitude},${longitude})`;
  // `out body geom` returns node ids as well as coordinates; the ids are what
  // make it possible to stitch across way splits.
  return `[out:json][timeout:${timeoutSeconds}];way${area}${selector};out body geom;`;
}

export class LruCache {
  constructor(maxEntries = 128, ttlMs = 300000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { createdAt: Date.now(), value });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  get size() {
    return this.map.size;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run an Overpass query with retries. Throws after the final attempt.
 */
export async function runQuery(query, options = {}) {
  const {
    endpoints = DEFAULT_ENDPOINTS,
    timeoutMs = 25000,
    attempts = 3,
    onRetry = null
  } = options;

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const endpoint = endpoints[attempt % endpoints.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
          Accept: 'application/json'
        },
        body: `data=${encodeURIComponent(query)}`
      });
      if (response.status === 429 || response.status === 504 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30000, 2000 * 2 ** attempt);
        lastError = new Error(`Overpass ${response.status} from ${endpoint}`);
        if (onRetry) onRetry(lastError, delay, attempt);
        clearTimeout(timer);
        if (attempt < attempts - 1) await sleep(delay);
        continue;
      }
      if (!response.ok) throw new Error(`Overpass ${response.status} from ${endpoint}`);
      const data = await response.json();
      clearTimeout(timer);
      return data.elements || [];
    } catch (error) {
      lastError = error;
      if (onRetry) onRetry(error, 0, attempt);
      if (attempt < attempts - 1) await sleep(Math.min(15000, 1000 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Overpass request failed');
}

export async function fetchWaysNear(latitude, longitude, radiusMetres, options = {}) {
  return runQuery(buildQuery({ latitude, longitude, radiusMetres }), options);
}

export async function fetchWaysInBbox(bbox, options = {}) {
  return runQuery(buildQuery({ bbox, timeoutSeconds: 180 }), options);
}
