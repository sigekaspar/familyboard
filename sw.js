// Service Worker: hält die App-Hülle (HTML, CSS, JS, Icons) und die Microsoft-Anmeldebibliothek
// offline verfügbar. Daten aus OneDrive werden NICHT hier gecacht (das macht die App selbst).
const CACHE_NAME = 'family-board-shell-v2';
const SHELL_FILES = [
  './', './index.html', './style.css', './manifest.json', './icon-192.png', './icon-512.png',
  './js/config.js', './js/graph.js', './js/data.js', './js/ui.js', './js/main.js'
];
const MSAL_URL = 'https://alcdn.msauth.net/browser/2.28.1/js/msal-browser.min.js';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_FILES);
    try{ const res = await fetch(new Request(MSAL_URL, { mode: 'no-cors' })); await cache.put(MSAL_URL, res); }catch(err){}
  })());
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Microsoft-Anmeldebibliothek (feste Versionsnummer in der URL -> ändert sich nie): Cache zuerst
  if(url.href === MSAL_URL){
    e.respondWith(caches.match(MSAL_URL).then(cached => cached || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(MSAL_URL, clone));
      return res;
    })));
    return;
  }
  // Alle anderen fremden Anfragen (Graph, Login, OneDrive) unangetastet lassen
  if(url.origin !== location.origin) return;
  // Anfragen mit Parametern (z.B. Versions-Check) immer frisch vom Netz
  if(url.search) return;

  // App-Hülle: sofort aus dem Cache, im Hintergrund aktualisieren
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if(res && res.ok){
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => cached || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined));
      return cached || networkFetch;
    })
  );
});
