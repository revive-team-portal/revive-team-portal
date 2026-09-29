// Service worker for the Revive Tasks app. Scope is /tasks/ only, so nothing else on
// the portal is affected.
//
// Caches the app shell (this page plus the CDN scripts and images it needs) so the app
// opens with no connection. It deliberately never caches the data API — the page keeps
// its own snapshot of your tasks and shows that, read-only, when offline.

const CACHE = 'revive-tasks-v1';

const SHELL = [
  '/tasks/',
  '/tasks/manifest.webmanifest',
  '/tasks/icon-192.png',
  '/tasks/icon-512.png',
  '/tasks/apple-touch-icon.png',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/vue@3/dist/vue.global.prod.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://revivealicious.com/cdn/shop/files/revivealicious-foods-logo-white-rgb-900px-w-72ppi.png',
  'https://cdn.shopify.com/s/files/1/0181/2735/files/Wopples_4x2_banner.jpg?v=1742107130',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One unreachable CDN shouldn't abort the whole install.
    await Promise.all(SHELL.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache the data API or auth — offline data comes from the page's own snapshot.
  if (url.pathname.startsWith('/.netlify/functions/') || url.hostname.endsWith('.supabase.co')) return;

  // Page loads: fresh when possible, the cached shell when not.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('/tasks/', net.clone());
        return net;
      } catch (_) {
        return (await caches.match('/tasks/')) || Response.error();
      }
    })());
    return;
  }

  // Scripts, icons, images: serve cached, refresh in the background.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
