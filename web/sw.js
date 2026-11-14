// Field app service worker: caches the app shell so it opens without signal. API calls are never cached.
const CACHE = 'mt-agent-v3';
const SHELL = ['/agent.html', '/css/app.css', '/js/agent.js', '/js/core.js', '/js/vault.js', '/vendor/jsqr/jsQR.js', '/icon.svg', '/agent.webmanifest'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (!SHELL.includes(url.pathname)) return;
  // Network first so updates arrive; fall back to the cached shell offline.
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
