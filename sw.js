// 앱 파일을 저장해 두고 오프라인에서도 열리게 한다.
// 캐시에서 바로 보여주고 뒤에서 새 버전을 받아 두므로, 수정한 내용은 다음 실행부터 반영된다.
const CACHE = 'nokchwi-v2';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'lib/lame.min.js',
  'lib/neodgm.woff2',
  'lib/neodgm.woff',
  'tools/transcribe.bat',
  'tools/transcribe.py',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // 같은 사이트의 카카시 캐시는 건드리지 않는다
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('nokchwi-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
