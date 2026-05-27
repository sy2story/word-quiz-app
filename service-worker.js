const CACHE_NAME = "word-quiz-app-v9";

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./privacy.html",
  "./app.js",
  "./auth.js",
  "./sheets.js",
  "./ai.js",
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

  // Apps Script API / Google 認証・API 系は常にネットワークから取得する（キャッシュしない）
  const networkOnlyHosts = [
    "script.google.com",
    "accounts.google.com",
    "apis.google.com",
    "sheets.googleapis.com",
    "www.googleapis.com",
    "oauth2.googleapis.com"
  ];
  if (networkOnlyHosts.some(host => requestUrl.hostname.includes(host))) {
    return;
  }

  // 同一オリジン以外もキャッシュ対象外（Tailwind CDN等はネットワーク優先）
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  // ネットワーク優先: オンライン時は常に最新を取得し、取得成功時にキャッシュを更新する。
  // ネットワーク失敗（オフライン）時のみキャッシュにフォールバックする。
  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        // 正常応答のみキャッシュに保存（opaque/エラー応答は除外）
        if (networkResponse && networkResponse.ok) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
