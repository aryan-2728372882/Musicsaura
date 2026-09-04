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

  const SW_URL = "/service-worker.js?build=75";
  let reloadedForControllerChange = false;

  window.addEventListener("load", async () => {
    try {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadedForControllerChange) return;
        reloadedForControllerChange = true;
        window.location.reload();
      });
      const reg = await navigator.serviceWorker.register(SW_URL);
      await reg.update();
      console.log("[SW] Registered successfully:", reg.scope);

      // Check for updates on load and periodically
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            console.log("[SW] New version ready.");
            newWorker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
      // Request permanent storage persistence to prevent auto-eviction of downloaded songs
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then((granted) => {
          console.log("[SW] Storage persistence status:", granted ? "Persistent" : "Best-effort");
        }).catch(() => {});
      }
    } catch (err) {
      console.warn("[SW] Registration failed:", err);
    }
  });
})();