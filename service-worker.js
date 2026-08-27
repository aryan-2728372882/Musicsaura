// service-worker.js — MusicsAura 3.0 Offline-First PWA Engine
const APP_SHELL_CACHE = "musicsaura-shell-v1";
const OFFLINE_PWA_STORAGE = "musicsaura-pwa-storage-v1";

const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/styles/styles.css",
  "/scripts/app.js",
  "/scripts/player.js",
  "/scripts/firebase-config.js",
  "/scripts/sw-manager.js",
  "/manifest.json",
  "/assets/logo.png",
  "/assets/favicon.ico",
  "/jsons/hindi.json",
  "/jsons/punjabi.json",
  "/jsons/haryanvi.json"
];

// ─── INSTALL: PRE-CACHE COMPLETE APP SHELL ─────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(async (cache) => {
      // Precache critical app files quietly
      for (const asset of PRECACHE_ASSETS) {
        try {
          await cache.add(new Request(asset, { cache: "reload" }));
        } catch (e) {
          console.warn("Precache failed for:", asset, e);
        }
      }
      return self.skipWaiting();
    })
  );
});

// ─── ACTIVATE: CLEANUP OLD CACHES & CLAIM CLIENTS ─────────────────
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

// ─── FETCH: OFFLINE-FIRST STRATEGY ────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 1. Check if it's an In-App Downloaded Audio Track from PWA Storage
  if (request.destination === "audio" || /\.(mp3|m4a|aac|wav|ogg|flac)($|\?)/i.test(url.pathname)) {
    event.respondWith(
      caches.open(OFFLINE_PWA_STORAGE).then(async (pwaCache) => {
        const cachedTrack = await pwaCache.match(request);
        if (cachedTrack) {
          return cachedTrack;
        }
        // If not in offline PWA storage, stream natively from network
        return fetch(request).catch(() => {
          return new Response("", { status: 504, statusText: "Offline" });
        });
      })
    );
    return;
  }

  // 2. Navigation Request (App Open / Page Load) — Network first, fallback to cached index.html
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(APP_SHELL_CACHE);
        const cachedIndex = await cache.match("/index.html") || await cache.match("/");
        if (cachedIndex) return cachedIndex;
        return new Response("MusicsAura Offline Mode", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      })
    );
    return;
  }

  // 3. App Shell Files (Scripts, Styles, JSONs) — Stale While Revalidate
  event.respondWith(
    caches.open(APP_SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(request);

      const networkFetch = fetch(request).then((networkRes) => {
        if (networkRes && networkRes.ok) {
          cache.put(request, networkRes.clone());
        }
        return networkRes;
      }).catch(() => null);

      return cached || networkFetch || new Response("", { status: 504 });
    })
  );
});

// ─── MESSAGE EVENT ────────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});