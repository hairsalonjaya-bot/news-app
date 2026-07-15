const CACHE_NAME = 'news-app-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// ニュースアプリは更新頻度が高いため、まずネットワークから最新を取得し、
// オフライン時のみキャッシュにフォールバックする(ネットワーク優先)。
// キャッシュ優先だと、GASからの記事データは毎回最新でもアプリ本体(index.html等)の
// 見た目の修正が反映されなくなるため。
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, resClone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
