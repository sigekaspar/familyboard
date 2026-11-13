// Service Worker: hält die App-Hülle (HTML, CSS, JS, Icons, Microsoft-Anmeldebibliothek) offline verfügbar.
// Daten aus OneDrive werden NICHT hier gecacht (das macht die App selbst).
// Der Cache-Name hängt an APP_VERSION (js/config.js): neue Version -> neuer Cache, alter wird beim Aktivieren entfernt.
try{ importScripts('js/config.js'); }catch(e){}
const CACHE_NAME = 'family-board-shell-' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'v3');
const SHELL_FILES = [
  './', './index.html', './style.css', './manifest.json', './icon-192.png', './icon-512.png',
  './js/lib/msal-browser-2.39.0.min.js',
  './js/config.js', './js/graph.js', './js/data.js', './js/ui.js', './js/extras.js', './js/main.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)));
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
  // Fremde Anfragen (Graph, Login, OneDrive, Azure) unangetastet lassen
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
