const CACHE_NAME = "word-quiz-app-v1";

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./config.js",
  "./manifest.json",
  "./sample-words.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // 個別 addAll が失敗してもインストールを止めない（config.js などが無い場合への耐性）
      return Promise.all(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => {
            console.warn("Cache add failed:", url, err);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const requestUrl = new URL(event.request.url);

  // Apps Script API は常にネットワークから取得する（キャッシュしない）
  if (requestUrl.hostname.includes("script.google.com")) {
    return;
  }

  // 同一オリジン以外もキャッシュ対象外（Tailwind CDN等はネットワーク優先）
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      return cachedResponse || fetch(event.request);
    })
  );
});
