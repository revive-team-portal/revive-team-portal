/* The Inspiration Project — offline support.
   Shell (page + song list + art): network first, cached copy when offline.
   Audio: served from the download cache when saved (with byte-range support so
   iOS Safari will play it), otherwise straight from the network. The page itself
   fills AUDIO_CACHE when the listener taps "Download all". */
const SHELL_CACHE = 'music-shell-v1';
const AUDIO_CACHE = 'music-audio-v1';   // page uses the same name — keep in sync
const FONT_CACHE  = 'music-fonts-v1';
const BASE = new URL('./', self.location).href;          // .../music/
const SHELL = [BASE, BASE + 'songs.json', BASE + 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE)
    .then(c => Promise.all(SHELL.map(u => fetch(u, {cache:'reload'})
      .then(r => r.ok && c.put(u, clean(r))).catch(()=>{}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  const keep = [SHELL_CACHE, AUDIO_CACHE, FONT_CACHE];
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('music-') && !keep.includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Safari refuses a redirected response for a navigation */
function clean(r){
  return r.redirected ? new Response(r.body, {status:r.status, statusText:r.statusText, headers:r.headers}) : r;
}

function timeout(ms){ return new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms)); }

async function networkFirst(req, key, wait){
  const cache = await caches.open(SHELL_CACHE);
  try {
    const net = await Promise.race([fetch(req), timeout(wait)]);
    if(net && net.ok){ cache.put(key, clean(net.clone())).catch(()=>{}); return clean(net); }
    throw new Error('bad');
  } catch(err){
    const hit = await cache.match(key, {ignoreSearch:true});
    if(hit) return hit;
    return fetch(req);
  }
}

async function ranged(req, res){
  const range = req.headers.get('range');
  if(!range) return res;
  const blob = await res.blob();
  const size = blob.size;
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start, end;
  if(m[1] === '' && m[2]){ start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1] || 0); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if(start >= size || start > end){
    return new Response(null, {status:416, headers:{'Content-Range':'bytes */' + size}});
  }
  return new Response(blob.slice(start, end + 1), {status:206, headers:{
    'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
    'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes'
  }});
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);

  /* Google Fonts: cache first (looks right offline, falls back to system font anyway) */
  if(url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'){
    e.respondWith(caches.open(FONT_CACHE).then(c => c.match(req).then(hit => hit ||
      fetch(req).then(r => { if(r.ok || r.type === 'opaque') c.put(req, r.clone()).catch(()=>{}); return r; }))));
    return;
  }
  if(url.origin !== self.location.origin || !url.href.startsWith(BASE)) return;
  const path = url.pathname.slice(new URL(BASE).pathname.length);

  if(path.startsWith('audio/')){
    const key = BASE + path;
    e.respondWith(caches.open(AUDIO_CACHE).then(c => c.match(key)).then(hit => hit ? ranged(req, hit) : fetch(req)));
    return;
  }
  if(req.mode === 'navigate' || path === '' || path === 'index.html'){
    e.respondWith(networkFirst(req, BASE, 4000));
    return;
  }
  if(path === 'songs.json' || path === 'manifest.webmanifest'){
    e.respondWith(networkFirst(req, BASE + path, 4000));
    return;
  }
  if(path.startsWith('art/')){
    /* stale-while-revalidate: instant from cache, refreshed in the background */
    const key = BASE + path;
    e.respondWith(caches.open(SHELL_CACHE).then(c => c.match(key).then(hit => {
      const net = fetch(req).then(r => { if(r.ok) c.put(key, r.clone()).catch(()=>{}); return r; });
      if(hit){ net.catch(()=>{}); return hit; }
      return net;
    })));
  }
});
