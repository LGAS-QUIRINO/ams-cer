// Keeps AMS working offline. Online it always loads the newest files; offline it uses the saved copy.
const RELEASE = 'v0.3.0-cer';
const VERSION = 'ams|' + self.registration.scope + '|' + RELEASE;
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'img/coa-logo.png', 'img/icon-192.png', 'img/icon-512.png',
  'js/app.js', 'js/config.js', 'js/db.js', 'js/auth.js', 'js/ui.js', 'js/modules.js', 'js/seed.js', 'js/store.js', 'js/api.js', 'js/sync.js', 'js/views/login.js', 'js/views/dashboard.js', 'js/views/admin.js', 'js/frame.js',
  'modules/cer/cer.js', 'modules/cer/forms.js', 'modules/cer/cer.css', 'lib/xlsx.full.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k.startsWith('ams|' + self.registration.scope + '|')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Online: always the newest version from the website (and keep a copy). Offline or very slow: the saved copy.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const net = await Promise.race([
        fetch(e.request, { cache: 'no-cache' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 6000))
      ]);
      if (net && net.ok) cache.put(e.request, net.clone());
      return net;
    } catch (err) {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
