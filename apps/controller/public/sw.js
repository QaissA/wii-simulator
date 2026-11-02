/**
 * Service worker — offline shell for the controller PWA.
 *
 * Strategy is network-first with a cache fallback, not cache-first. A controller
 * that silently runs a stale build against an updated protocol would fail in the
 * confusing way `docs/layer-4-backend.md` §Gotchas warns about: schema mismatch
 * breaking sync without an obvious cause. Freshness wins; the cache exists so a
 * flaky connection at the venue does not leave a player staring at a blank page.
 */

const CACHE = 'controller-v1';

const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  // Take over immediately rather than waiting for every tab to close.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch the WebSocket upgrade or anything cross-origin.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => undefined);
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('./index.html'))),
  );
});
