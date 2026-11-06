const VERSION = "__ASSET_VERSION__";
const ASSETS = __ASSETS__;
const PREFIX = `jigsaw-static:${self.registration.scope}:`;
const CACHE = PREFIX + VERSION;
const urls = ASSETS.map((asset) => new URL(asset, self.registration.scope).href);
const allowed = new Set(urls);
const indexUrl = new URL("index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(urls)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  url.search = "";
  const isEntry = url.href === scope.href || url.href === indexUrl;
  if (!allowed.has(url.href) && !isEntry) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(isEntry ? indexUrl : url.href);
    return saved || fetch(event.request);
  })());
});
