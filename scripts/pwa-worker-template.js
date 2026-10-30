/* Generated into the static export by prepare-pwa.mjs. */
const CACHE_NAME = __PAPERLOOM_CACHE_NAME__;
const CACHE_PREFIX = __PAPERLOOM_CACHE_PREFIX__;
const BASE_PATH = __PAPERLOOM_BASE_PATH__;
const PRECACHE = __PAPERLOOM_PRECACHE__;
const ASSETS = new Set(PRECACHE);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(PRECACHE);
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  let path = url.pathname;
  if (request.mode === 'navigate') {
    if (path === BASE_PATH || path === `${BASE_PATH}/`) path = `${BASE_PATH}/index.html`;
    else if (path === `${BASE_PATH}/editor` || path === `${BASE_PATH}/editor/`) path = `${BASE_PATH}/editor/index.html`;
  }
  if (!ASSETS.has(path)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(path)) || fetch(request);
  })());
});
