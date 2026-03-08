// service-worker.js - MusicsAura runtime cache
const CACHE_NAME = "musicsaura-runtime-v8";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/assets/logo.png"
];

function isAppDataRequest(url) {
  return url.pathname.startsWith("/jsons/");
}

async function networkFirst(request, options = {}) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, options);
    if (response && response.ok && request.method === "GET") {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response("", { status: 504, statusText: "Gateway Timeout" });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const network = await networkPromise;
  if (network) return network;
  return new Response("", { status: 504, statusText: "Gateway Timeout" });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Let browser handle third-party requests directly (fonts/Firebase/etc.)
  // to avoid SW-level uncaught fetch failures from ad blockers/privacy filters.
  if (!isSameOrigin) return;

  // Do not proxy audio requests through SW to preserve native streaming/range behavior.
  if (request.destination === "audio" || /\.(mp3|m4a|aac|wav|ogg|flac)($|\?)/i.test(url.pathname)) {
    return;
  }

  // Always fetch latest dynamic app data.
  if (isAppDataRequest(url)) {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store"
          }
        });
      })
    );
    return;
  }

  // Always check network first for app shell files so deployments show immediately.
  const isNavigation = request.mode === "navigate";
  const isAppShellAsset =
    request.destination === "document" ||
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "worker";

  if (isNavigation || isAppShellAsset) {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;

        if (isNavigation) {
          return (await caches.match("/index.html")) || new Response("", { status: 503 });
        }

        if (request.destination === "style") {
          return new Response("/* offline fallback */", {
            status: 200,
            headers: { "content-type": "text/css" }
          });
        }

        return new Response("", { status: 503 });
      })
    );
    return;
  }

  if (request.destination === "image" || request.destination === "font") {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(networkFirst(request));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
