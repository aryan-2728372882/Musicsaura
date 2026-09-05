// service-worker.js — MusicsAura 3.0 Offline-First PWA Engine (100% Airplane Mode Immune)
const APP_SHELL_CACHE = "musicsaura-shell-v79";
const OFFLINE_PWA_STORAGE = "musicsaura-pwa-storage-v2";

const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/upload.html",
  "/auth.html",
  "/admin-dashboard.html",
  "/user-dashboard.html",
  "/styles/styles.css",
  "/scripts/app.js",
  "/scripts/player.js",
  "/scripts/storage-db.js",
  "/scripts/firebase-config.js",
  "/scripts/firebase/firebase-app.js",
  "/scripts/firebase/firebase-auth.js",
  "/scripts/firebase/firebase-firestore.js",
  "/scripts/sw-manager.js",
  "/scripts/upload.js",
  "/scripts/github-sync.js",
  "/manifest.json",
  "/assets/logo.png",
  "/assets/favicon.ico",
  "/assets/fonts/material-icons.ttf",
  "/jsons/hindi.json",
  "/jsons/punjabi.json",
  "/jsons/haryanvi.json",
  "/jsons/rap.json",
  "/jsons/bhojpuri.json"
];

// ─── INSTALL: PRE-CACHE APP SHELL WITH INDEPENDENT FAULT TOLERANCE ─
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(async (cache) => {
      console.log("[SW] Pre-caching all essential app assets for offline playback...");
      await Promise.allSettled(
        PRECACHE_ASSETS.map(async (asset) => {
          try {
            const req = new Request(asset, { cache: "reload" });
            const res = await fetch(req);
            if (res && res.ok) {
              await cache.put(asset, res.clone());
              const fullUrl = new URL(asset, self.location.origin).href;
              await cache.put(fullUrl, res);
            }
          } catch (err) {
            console.warn("[SW] Notice precaching asset:", asset, err);
          }
        })
      );
    })
  );
});

// ─── ACTIVATE: PURGE OBSOLETE SHELL CACHES IMMEDIATELY ────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.map((name) => {
          if (name !== APP_SHELL_CACHE && name !== OFFLINE_PWA_STORAGE) {
            console.log("[SW] Purging stale cache:", name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ─── HELPER: SLICE RANGE FOR ANDROID/IOS PARTIAL AUDIO PLAYBACK ──
async function handleAudioRangeRequest(cachedResponse, rangeHeader) {
  try {
    const arrayBuffer = await cachedResponse.arrayBuffer();
    const total = arrayBuffer.byteLength;
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10) || 0;
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

    if (start >= total || end >= total) {
      return new Response(null, {
        status: 416,
        statusText: "Range Not Satisfiable",
        headers: { "Content-Range": `bytes */${total}` }
      });
    }

    const chunk = arrayBuffer.slice(start, end + 1);
    const headers = new Headers(cachedResponse.headers);
    headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", chunk.byteLength.toString());
    if (!headers.get("Content-Type")) {
      headers.set("Content-Type", "audio/mpeg");
    }
    headers.set("Access-Control-Allow-Origin", "*");

    return new Response(chunk, {
      status: 206,
      statusText: "Partial Content",
      headers
    });
  } catch (err) {
    console.warn("[SW] Range handling notice:", err);
    return cachedResponse;
  }
}

// ─── FETCH: ROUTED BY TYPE (NO MIME CORRUPTION & TOTAL OFFLINE) ───
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 1. AUDIO STREAM & DOWNLOADS (File Garden & In-App Downloaded Songs)
  const isAudio =
    request.destination === "audio" ||
    url.pathname.endsWith(".mp3") ||
    url.pathname.endsWith(".wav") ||
    url.pathname.endsWith(".ogg") ||
    url.hostname.includes("file.garden");

  if (isAudio) {
    event.respondWith(
      (async () => {
        // If device is online, try network first (network authoritative)
        if (navigator.onLine) {
          try {
            const networkResponse = await fetch(request);
            if (networkResponse && (networkResponse.ok || networkResponse.status === 206)) {
              return networkResponse;
            }
          } catch {}
        }

        // Offline / Airplane Mode Fallback: retrieve from In-App Download Storage
        try {
          const offlineCache = await caches.open(OFFLINE_PWA_STORAGE);
          const rawUrl = url.href.split("?")[0];
          const cached =
            (await offlineCache.match(request, { ignoreSearch: true })) ||
            (await offlineCache.match(rawUrl, { ignoreSearch: true })) ||
            (await offlineCache.match(url.pathname, { ignoreSearch: true }));

          if (cached) {
            const range = request.headers.get("range");
            if (range) {
              return await handleAudioRangeRequest(cached, range);
            }

            const headers = new Headers(cached.headers);
            headers.set("Access-Control-Allow-Origin", "*");
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
        } catch (err) {
          console.warn("[SW] Offline audio check error:", err);
        }

        // Neither network nor downloaded copy is accessible
        return new Response("Audio stream offline", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "Content-Type": "text/plain" }
        });
      })()
    );
    return;
  }

  // 2. MATERIAL ICONS FONT (Google Fonts & CDN Fallback)
  if (url.href.includes("materialicons") || url.pathname.includes("material-icons")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(APP_SHELL_CACHE);
        const cachedFont =
          (await cache.match("/assets/fonts/material-icons.ttf")) ||
          (await cache.match(new URL("/assets/fonts/material-icons.ttf", self.location.origin).href));
        if (cachedFont) return cachedFont;

        try {
          const net = await fetch(request);
          if (net && net.ok) {
            cache.put(request, net.clone());
            return net;
          }
        } catch {}

        return (await cache.match(request)) || new Response("", { status: 404 });
      })()
    );
    return;
  }

  // Ignore unrelated cross-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // 3. NAVIGATION REQUESTS (Single-Page App Routing)
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
        const cached =
          (await cache.match(request, { ignoreSearch: true })) ||
          (await cache.match(url.pathname, { ignoreSearch: true })) ||
          (await cache.match("/index.html")) ||
          (await cache.match("/"));

        if (cached) return cached;

        return new Response("MusicsAura is running offline", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      })()
    );
    return;
  }

  // 4. STYLESHEET REQUESTS (Guaranteed text/css, NEVER HTML)
  const isCSS = request.destination === "style" || url.pathname.endsWith(".css");
  if (isCSS) {
    event.respondWith(
      (async () => {
        try {
          const networkRes = await fetch(request);
          if (networkRes && networkRes.ok) {
            const cache = await caches.open(APP_SHELL_CACHE);
            cache.put(request, networkRes.clone());
            cache.put("/styles/styles.css", networkRes.clone());
            return networkRes;
          }
        } catch {}

        const cache = await caches.open(APP_SHELL_CACHE);
        const cached =
          (await cache.match(request, { ignoreSearch: true })) ||
          (await cache.match(url.pathname, { ignoreSearch: true })) ||
          (await cache.match("/styles/styles.css")) ||
          (await cache.match(new URL("/styles/styles.css", self.location.origin).href));

        if (cached) {
          // Ensure correct stylesheet MIME type to prevent browser dropping styles
          const headers = new Headers(cached.headers);
          headers.set("Content-Type", "text/css; charset=utf-8");
          return new Response(cached.body, {
            status: cached.status || 200,
            statusText: cached.statusText || "OK",
            headers
          });
        }

        // Return empty CSS instead of HTML fallback to prevent MIME type parse errors
        return new Response("/* Offline CSS placeholder */", {
          status: 200,
          headers: { "Content-Type": "text/css; charset=utf-8" }
        });
      })()
    );
    return;
  }

  // 5. JAVASCRIPT MODULES & SCRIPTS (Guaranteed application/javascript, NEVER HTML)
  const isScript = request.destination === "script" || url.pathname.endsWith(".js");
  if (isScript) {
    event.respondWith(
      (async () => {
        try {
          const networkRes = await fetch(request);
          if (networkRes && networkRes.ok) {
            const cache = await caches.open(APP_SHELL_CACHE);
            cache.put(request, networkRes.clone());
            cache.put(url.pathname, networkRes.clone());
            return networkRes;
          }
        } catch {}

        const cache = await caches.open(APP_SHELL_CACHE);
        const cached =
          (await cache.match(request, { ignoreSearch: true })) ||
          (await cache.match(url.pathname, { ignoreSearch: true })) ||
          (await cache.match(url.href.split("?")[0], { ignoreSearch: true }));

        if (cached) {
          const headers = new Headers(cached.headers);
          headers.set("Content-Type", "application/javascript; charset=utf-8");
          return new Response(cached.body, {
            status: cached.status || 200,
            statusText: cached.statusText || "OK",
            headers
          });
        }

        return new Response("console.warn('[SW] Offline script missing:', " + JSON.stringify(url.pathname) + ");", {
          status: 200,
          headers: { "Content-Type": "application/javascript; charset=utf-8" }
        });
      })()
    );
    return;
  }

  // 6. ALL OTHER STATIC ASSETS (Images, Manifest, JSONs)
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
      const cached =
        (await cache.match(request, { ignoreSearch: true })) ||
        (await cache.match(url.pathname, { ignoreSearch: true })) ||
        (await cache.match(url.href.split("?")[0], { ignoreSearch: true }));

      if (cached) return cached;

      return new Response("", { status: 404, statusText: "Offline Not Found" });
    })()
  );
});

// ─── MESSAGE: IMMEDIATE ACTIVATION ON UPDATE ──────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});