// service-worker.js — MusicsAura 3.0 Offline-First PWA Engine
const APP_SHELL_CACHE = "musicsaura-shell-v72";
const OFFLINE_PWA_STORAGE = "musicsaura-pwa-storage-v2";

const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/upload.html",
  "/styles/styles.css",
  "/scripts/app.js",
  "/scripts/player.js",
  "/scripts/storage-db.js",
  "/scripts/firebase-config.js",
  "/scripts/sw-manager.js",
  "/scripts/upload.js",
  "/scripts/github-sync.js",
  "/manifest.json",
  "/assets/logo.png",
  "/assets/favicon.ico",
  "/jsons/hindi.json",
  "/jsons/punjabi.json",
  "/jsons/haryanvi.json",
  "/jsons/rap.json",
  "/jsons/bhojpuri.json"
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

// ─── FETCH: SAME-ORIGIN APP SHELL & OFFLINE AUDIO STREAMING ────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Audio / Media requests: Check OFFLINE_PWA_STORAGE first to serve cached downloads offline
  const isAudio =
    request.destination === "audio" ||
    url.pathname.endsWith(".mp3") ||
    url.pathname.endsWith(".wav") ||
    url.pathname.endsWith(".ogg") ||
    url.hostname.includes("file.garden");

  if (isAudio) {
    event.respondWith(
      (async () => {
        // Network is authoritative. Cached audio is only an offline fallback.
        // Returning non-OK responses prevents a deleted URL from falling back
        // to an older downloaded copy.
        try {
          const networkResponse = await fetch(request, { cache: "no-store" });
          return networkResponse;
        } catch {}

        try {
          const offlineCache = await caches.open(OFFLINE_PWA_STORAGE);
          // This branch runs only after the network failed. Matching the base URL
          // here lets explicitly downloaded tracks work offline despite the
          // player's cache-busting query parameter.
          const cached = (await offlineCache.match(request, { ignoreSearch: true })) ||
                         (await offlineCache.match(url.href.split("?")[0], { ignoreSearch: true }));

          if (cached) {
            // Only serve cached audio that was explicitly saved for offline use.
            // Saved audio entries are marked with the `X-Offline-Saved` header by the app.
            const savedMarker = cached.headers && cached.headers.get && cached.headers.get('X-Offline-Saved');
            if (savedMarker) {
              // Attach CORS and Accept-Ranges headers to cached audio response
              const headers = new Headers(cached.headers);
              headers.set("Access-Control-Allow-Origin", "*");
              headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
              headers.set("Accept-Ranges", "bytes");
              if (!headers.get("Content-Type")) {
                headers.set("Content-Type", "audio/mpeg");
              }
              return new Response(cached.body, {
                status: cached.status || 200,
                statusText: cached.statusText || "OK",
                headers
              });
            }
            // If cached entry exists but wasn't explicitly saved, fall through to network
          }
        } catch (e) {
          console.warn("[SW] Cache audio lookup notice:", e);
        }

        // Not in offline cache — force network fetch and bypass browser HTTP cache
        return fetch(request, { cache: 'no-store' });
      })()
    );
    return;
  }

  // Cross-origin non-audio assets bypass SW completely
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