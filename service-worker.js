// service-worker.js — MusicsAura 3.0 Offline-First PWA Engine
const APP_SHELL_CACHE = "musicsaura-shell-v18";
const OFFLINE_PWA_STORAGE = "musicsaura-pwa-storage-v2";

const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/upload.html",
  "/styles/styles.css",
  "/scripts/app.js",
  "/scripts/player.js",
  "/scripts/firebase-config.js",
  "/scripts/sw-manager.js",
  "/scripts/upload.js",
  "/manifest.json",
  "/assets/logo.png",
  "/assets/favicon.ico",
  "/jsons/hindi.json",
  "/jsons/punjabi.json",
  "/jsons/haryanvi.json"
];

// ─── INSTALL: PRE-CACHE COMPLETE APP SHELL ─────────────────────────
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(async (cache) => {
      for (const asset of PRECACHE_ASSETS) {
        try {
          await cache.add(new Request(asset, { cache: "reload" }));
        } catch {}
      }
    })
  );
});

// ─── ACTIVATE: PURGE ALL OLD CACHES IMMEDIATELY ───────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.map((name) => {
          if (name !== APP_SHELL_CACHE && name !== OFFLINE_PWA_STORAGE) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ─── FETCH: SAME-ORIGIN APP SHELL ONLY ────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin assets (File Garden audio, CDNs, Firebase) bypass SW completely for 100% native HTTP streaming
  if (url.origin !== self.location.origin) {
    return;
  }

  // App Shell & Scripts — Network-First with Cache Fallback
  event.respondWith(
    (async () => {
      try {
        const networkRes = await fetch(request);
        if (networkRes && networkRes.ok) {
          const cache = await caches.open(APP_SHELL_CACHE);
          cache.put(request, networkRes.clone());
          return networkRes;
        }
      } catch {}

      const cache = await caches.open(APP_SHELL_CACHE);
      const cached = (await cache.match(request, { ignoreSearch: true })) ||
                     (await cache.match(url.pathname, { ignoreSearch: true })) ||
                     (await cache.match("/index.html")) ||
                     (await cache.match("/"));
      if (cached) return cached;

      return new Response("MusicsAura Offline Mode", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    })()
  );
});

// ─── MESSAGE EVENT ────────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});