// scripts/sw-manager.js — MusicsAura 3.0 Service Worker Lifecycle Manager
(() => {
  if (window.__MUSICSAURA_SW_MANAGER__) return;
  window.__MUSICSAURA_SW_MANAGER__ = true;

  const isLocalhost =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]";
  const isSecureContext = location.protocol === "https:" || isLocalhost;

  if (!("serviceWorker" in navigator) || !isSecureContext) return;

  const SW_URL = "/service-worker.js?build=103";

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register(SW_URL);
      await reg.update().catch(() => {});

      // Request permanent storage persistence to prevent auto-eviction of downloaded songs
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }
    } catch (err) {
      // Silent error handling
    }
  });
})();
