/*
 * Offline shell for Align.
 *
 * Network first: a page load always prefers the newest published files, and the
 * cache is only used when the network fails, so a new version can never be held
 * back by an old copy. The cache is what lets the app start from the Home Screen
 * in a room with no usable signal.
 */
const CACHE = 'align-shell-v3';

const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/analyser.js',
  './js/audio-engine.js',
  './js/charts.js',
  './js/fft.js',
  './js/signals.js',
  './js/waterfall.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            await cache.add(url);
          } catch (err) {
            /* one unavailable file must not stop the install */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const shell = await caches.match('./index.html');
        if (shell) return shell;
        return Response.error();
      }),
  );
});
