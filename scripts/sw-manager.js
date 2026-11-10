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

  const SW_URL = "/service-worker.js?build=100";
  let reloadedForControllerChange = false;

  window.addEventListener("load", async () => {
    try {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadedForControllerChange) return;
        reloadedForControllerChange = true;
        window.location.reload();
      });
      const reg = await navigator.serviceWorker.register(SW_URL);
      await reg.update().catch(() => {});

      // Check for updates on visibility and focus change
      const checkUpdate = () => { reg.update().catch(() => {}); };
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) checkUpdate();
      });
      window.addEventListener("focus", checkUpdate);

      // Check for updates on load and periodically
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            newWorker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });

      // Request permanent storage persistence to prevent auto-eviction of downloaded songs
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }
    } catch (err) {
      // Silent error handling
    }
  });
})();
