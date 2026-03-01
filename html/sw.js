const CACHE_NAME = 'helpdesk-v1';
const PRE_CACHE = [
  './dev-edu-book-dashboard.html',
  '../img/preview-full-256.png',
  '../img/favicon-48.png',
  '../img/smail.png',
  '../img/sad.png',
  '../img/angry.png',
  '../img/working.gif',
  '../img/dance1.gif',
  '../img/dance2.gif',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRE_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET' || !(url.startsWith('http://') || url.startsWith('https://'))) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
