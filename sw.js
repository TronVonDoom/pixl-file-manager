/* Service worker: makes the app work offline and installable.
   App files: network first (so updates show up), cache as fallback.
   Amiibo pictures: cache first. Amiibo name list: network first. */
const VERSION = 'pixlfm-v2';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/protocol.js',
  'js/transport-ble.js',
  'js/mock-device.js',
  'js/zip.js',
  'js/unzip.js',
  'js/amiibo.js',
  'js/dfu.js',
  'js/mock-dfu.js',
  'js/sync.js',
  'js/firmware-ui.js',
  'js/app.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];
const IMAGES = 'pixlfm-images';
const DATA = 'pixlfm-data';

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pixlfm-v') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    ev.respondWith(networkFirst(req, VERSION));
  } else if (url.hostname === 'raw.githubusercontent.com' && url.pathname.includes('/AmiiboAPI/')) {
    if (url.pathname.includes('/images/')) ev.respondWith(cacheFirst(req, IMAGES));
    else ev.respondWith(networkFirst(req, DATA));
  }
});
