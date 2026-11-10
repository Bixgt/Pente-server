/* Service worker de Pente: permite jugar sin conexión.
 * Estrategia: red primero (así las actualizaciones llegan apenas hay internet) y caché como respaldo.
 * Para forzar que todos reciban una versión nueva: cambiar CACHE_VERSION. */
const CACHE_VERSION = 'pente-v155';
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './config.js', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon.svg', './icons/favicon-32.png', './icons/favicon-48.png', './icons/favicon-96.png', './icons/favicon-192.png', './icons/favicon-16.png', './favicon.ico'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const STATIC = /\.(webp|png|jpe?g|svg|ico|wav|mp3|ogg|woff2?|ttf)$/i.test(new URL(req.url).pathname);
  if (STATIC) {
    // Imágenes y audio: primero lo guardado (aparecen al instante) y en segundo plano se baja la versión nueva para la próxima vez.
    e.respondWith(caches.open(CACHE_VERSION).then((c) => c.match(req).then((hit) => {
      const net = fetch(req).then((res) => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
    return;
  }
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
