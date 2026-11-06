const rootScope = new URL(self.registration.scope);
const rootCachePrefix = `jigsaw-static:${rootScope.href}:`;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(rootCachePrefix)).map((name) => caches.delete(name)));
    await self.clients.claim();
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window" });
    await Promise.all(clients.map((client) => {
      const url = new URL(client.url);
      if (url.origin === rootScope.origin &&
        (url.pathname === rootScope.pathname || url.pathname === rootScope.pathname + "index.html")) {
        return client.navigate(client.url);
      }
      return Promise.resolve();
    }));
  })());
});
