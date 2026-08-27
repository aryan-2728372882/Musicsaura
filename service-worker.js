// service-worker.js — MusicsAura 3.0 Offline-First PWA Engine
const APP_SHELL_CACHE = "musicsaura-shell-v3";
const OFFLINE_PWA_STORAGE = "musicsaura-pwa-storage-v1";

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
        } catch (e) {
          // Precache non-blocking
        }
      }
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

  // 1. Audio Streaming & PWA Downloaded Tracks
  if (request.destination === "audio" || /\.(mp3|m4a|aac|wav|ogg|flac)($|\?)/i.test(url.pathname)) {
    event.respondWith(
      (async () => {
        try {
          const pwaCache = await caches.open(OFFLINE_PWA_STORAGE);
          const cachedTrack = await pwaCache.match(request);
          if (cachedTrack) return cachedTrack;

          return await fetch(request);
        } catch {
          return new Response("", { status: 504, statusText: "Offline" });
        }
      })()
    );
    return;
  }

  // Only handle same-origin assets through cache; let third-party pass through
  if (url.origin !== self.location.origin) return;

  // 2. Navigation Request (App Open / Page Load)
  if (request.mode === "navigate") {
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
        const cached = (await cache.match(request)) || (await cache.match(url.pathname)) || (await cache.match("/index.html")) || (await cache.match("/"));
        if (cached) return cached;

        return new Response("MusicsAura Offline Mode", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      })()
    );
    return;
  }

  // 3. App Shell Files (Scripts, Styles, JSONs, Images) — Stale While Revalidate
  event.respondWith(
    (async () => {
      try {
        const cache = await caches.open(APP_SHELL_CACHE);
        const cached = (await cache.match(request)) || (await cache.match(url.pathname));

        const fetchPromise = fetch(request).then((networkRes) => {
          if (networkRes && networkRes.ok && request.method === "GET") {
            cache.put(request, networkRes.clone());
          }
          return networkRes;
        }).catch(() => null);

        if (cached) {
          return cached;
        }

        const networkRes = await fetchPromise;
        if (networkRes) return networkRes;

        return new Response("", { status: 504, statusText: "Gateway Timeout" });
      } catch {
        return new Response("", { status: 504, statusText: "Offline" });
      }
    })()
  );
});

// ─── MESSAGE EVENT ────────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});