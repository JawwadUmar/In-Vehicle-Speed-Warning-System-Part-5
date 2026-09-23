'use strict';

/**
 * Part 4's worker had two faults that made the offline claim untrue and the
 * data unsafe:
 *
 *  1. It precached './images/speedometer.png', which does not exist in the
 *     repository. `cache.addAll` rejects atomically, so install always failed
 *     and the worker never activated -- nothing was ever cached.
 *
 *  2. Its fetch handler was cache-first for *every* request, including
 *     /api/road-ahead. Had it activated, it would have served stale road
 *     geometry indefinitely.
 *
 * Here the app shell is precached (each entry added individually so one missing
 * file cannot take the whole install down), API requests are network-only, and
 * both the shell and the curve layer use stale-while-revalidate: offline still
 * serves from cache, while a corrected safety module reaches installed clients
 * on the next load. Cache-first with no revalidation left every installed PWA
 * running the old logic indefinitely unless VERSION below happened to be bumped
 * in the same commit -- nothing enforced that, so a fix to safespeed.js alone
 * would never have shipped.
 */

const VERSION = 'v5.0.0';
const SHELL_CACHE = `curve-warning-shell-${VERSION}`;
const DATA_CACHE = `curve-warning-data-${VERSION}`;
const EXPECTED = [SHELL_CACHE, DATA_CACHE];

const SHELL = [
  '/',
  '/index.html',
  '/index.css',
  '/index.js',
  '/manifest.webmanifest',
  '/lib/geo.js',
  '/lib/curvature.js',
  '/lib/safespeed.js',
  '/lib/roadgraph.js',
  '/lib/pipeline.js',
  '/lib/curvelayer.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map(async url => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (error) {
        // Tolerated so one missing asset cannot fail the whole install, but it
        // leaves the app incomplete offline, so make it loud.
        console.error('Precache FAILED for', url, error.message,
          '— this asset will be unavailable offline.');
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('curve-warning-') && !EXPECTED.includes(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/api/road-ahead') {
    event.respondWith(networkOnly(request));
    return;
  }
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE, request.mode === 'navigate'));
});

/**
 * Never serve cached corridor geometry: an out-of-date corridor is worse than
 * no corridor, because the client would treat it as current.
 */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Offline: no live road geometry.', source: 'none' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function staleWhileRevalidate(request, cacheName, navigationFallback = false) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  const response = cached || (await network);
  if (response) return response;

  // Only a navigation may fall back to the shell. Returning index.html for a
  // failed *module* request — which the previous catch-all did — makes the
  // browser reject the script on MIME type, so the whole module graph fails to
  // evaluate and the page renders with no handlers, no status text and no
  // error: the Start button simply does nothing.
  if (navigationFallback) {
    const shell = await cache.match('/index.html');
    if (shell) return shell;
  }
  return new Response('Offline and not cached', {
    status: 503, headers: { 'Content-Type': 'text/plain' }
  });
}
