const CACHE_NAME = 'emro-life-v3';
const PRE_CACHE = [
  './edu-book-dashboard.html',
  'img/preview-full-256.png',
  'img/favicon-48.png',
  'img/smail.png',
  'img/sad.png',
  'img/angry.png',
  'img/working.gif',
  'img/dance1.gif',
  'img/dance2.gif',
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

/** ?v=xxx 등 캐시버스팅 파라미터를 제거한 URL로 캐시 키 통일 */
function stripCacheBuster(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('v');
    return u.toString();
  } catch (_) { return url; }
}

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET' || !(url.startsWith('http://') || url.startsWith('https://'))) return;

  // GAS API 호출은 캐시하지 않음
  if (url.includes('script.google.com/macros/')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        const cacheKey = stripCacheBuster(url);
        caches.open(CACHE_NAME).then(cache => {
          // ?v= 제거된 URL로 캐시 저장 → 오프라인 시 히트
          const cleanReq = new Request(cacheKey);
          cache.put(cleanReq, clone);
        });
        return res;
      })
      .catch(() => {
        // 오프라인: ?v= 제거된 URL로 캐시 조회
        const cacheKey = stripCacheBuster(url);
        return caches.match(new Request(cacheKey));
      })
  );
});
