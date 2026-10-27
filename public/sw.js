/*
 * DetailFlow service worker: lets the app open without a network in a browser over HTTPS
 * (the Android app has its own ShellCache). Data is not cached here: the app keeps its own
 * offline copy in IndexedDB and never asks this worker for /api/.
 *
 * - App pages: network first; without a network, the last app page that was loaded.
 * - /assets/ (hashed by Vite, never change): cache first. Assets the current page no longer
 *   references are removed after each successful load of the page.
 * - Fonts: cache first, refreshed in the background.
 * - Static pages beside the app (/landing/, /landing22/, /privacy/, /terms/, /consent/, /licenses/) are left to the network.
 */
const SHELL = 'detailflow-shell-v1';
const PAGE = '/index.html';

const assetsOf = (html) => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);

async function storePage(response) {
  const cache = await caches.open(SHELL);
  const html = await response.clone().text();
  await cache.put(PAGE, response.clone());
  const keep = new Set(assetsOf(html));
  await Promise.all(keep.size ? [...keep].map(async (path) => { if (!(await cache.match(path))) await cache.add(path).catch(() => {}); }) : []);
  // Drop assets of older builds.
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(request);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(fetch(PAGE, { cache: 'no-store' }).then((response) => response.ok ? storePage(response) : undefined).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== SHELL) await caches.delete(name); // also the old Google fonts cache
    await self.clients.claim();
  })());
});

const isAppPage = (url) => !/^\/(api|landing|landing22|privacy|terms|consent|licenses|admin)(\/|$)/.test(url.pathname) && !/\.[a-z0-9]+$/i.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    if (request.mode === 'navigate' && isAppPage(url)) {
      event.respondWith((async () => {
        try {
          const response = await fetch(request);
          if (response.ok && (response.headers.get('content-type') ?? '').includes('text/html')) event.waitUntil(storePage(response.clone()));
          return response;
        } catch {
          return (await caches.match(PAGE)) ?? Response.error();
        }
      })());
      return;
    }
    if (url.pathname.startsWith('/assets/')) {
      event.respondWith((async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) { const cache = await caches.open(SHELL); await cache.put(request, response.clone()); }
        return response;
      })());
    }
    return;
  }
});
