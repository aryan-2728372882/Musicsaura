// service-worker.js - MusicsAura runtime cache
const CACHE_NAME = "musicsaura-runtime-v6";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/styles/styles.css",
  "/scripts/player.js",
  "/scripts/app.js",
  "/scripts/firebase-config.js",
  "/assets/logo.png"
];

function isAppDataRequest(url) {
  return (
    url.pathname.startsWith("/jsons/") ||
    url.hostname.includes("firebase") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("gstatic.com")
  );
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
    throw error;
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
  return network || Response.error();
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

  // Do not proxy audio requests through SW to preserve native streaming/range behavior.
  if (request.destination === "audio" || /\.(mp3|m4a|aac|wav|ogg|flac)($|\?)/i.test(url.pathname)) {
    return;
  }

  // Always fetch latest dynamic app data.
  if (isAppDataRequest(url)) {
    event.respondWith(fetch(request, { cache: "no-store" }));
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
    event.respondWith(networkFirst(request, { cache: "no-store" }));
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
