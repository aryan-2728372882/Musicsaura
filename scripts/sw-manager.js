// scripts/sw-manager.js
// Centralized service worker lifecycle + cache freshness manager.
(() => {
  if (window.__MUSICSAURA_SW_MANAGER__) return;
  window.__MUSICSAURA_SW_MANAGER__ = true;

  const isLocalhost =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]";
  const isSecureContext = location.protocol === "https:" || isLocalhost;

  if (!("serviceWorker" in navigator) || !isSecureContext) return;

  const SW_URL = "/service-worker.js";
  const SW_SIGNATURE_KEY = "musicsaura:sw-signature";
  const RELOAD_GUARD_KEY = "musicsaura:sw-reload-guard";
  const UPDATE_INTERVAL_MS = 60 * 1000;

  function storageGet(storage, key) {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch {
      // Ignore storage failures (private mode / quota).
    }
  }

  function fnv1aHash(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = (hash >>> 0) * 0x01000193;
    }
    return (hash >>> 0).toString(16);
  }

  function reloadOnce(reason) {
    const currentGuard = storageGet(sessionStorage, RELOAD_GUARD_KEY);
    if (currentGuard) {
      const [guardReason, guardAt] = currentGuard.split("@");
      const elapsedMs = Date.now() - Number(guardAt || 0);
      if (guardReason === reason && elapsedMs < 15000) return;
    }

    storageSet(sessionStorage, RELOAD_GUARD_KEY, `${reason}@${Date.now()}`);

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("_swv", Date.now().toString(36));
    window.location.replace(nextUrl.toString());
  }

  async function clearWindowCaches() {
    if (!("caches" in window)) return;
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  }

  function clearWorkerCaches() {
    if (!navigator.serviceWorker.controller) return Promise.resolve();

    return new Promise((resolve) => {
      const channel = new MessageChannel();
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      channel.port1.onmessage = finish;
      setTimeout(finish, 1200);

      try {
        navigator.serviceWorker.controller.postMessage(
          { type: "CLEAR_RUNTIME_CACHE" },
          [channel.port2]
        );
      } catch {
        finish();
      }
    });
  }

  async function getServiceWorkerSignature() {
    const res = await fetch(`${SW_URL}?_=${Date.now()}`, {
      cache: "no-store",
      headers: {
        "cache-control": "no-cache",
        pragma: "no-cache"
      }
    });

    if (!res.ok) return null;

    const etag = res.headers.get("etag");
    if (etag) return `etag:${etag}`;

    const lastModified = res.headers.get("last-modified") || "no-last-modified";
    const source = await res.text();
    return `${lastModified}:${source.length}:${fnv1aHash(source)}`;
  }

  async function activateWaitingWorker(registration) {
    if (!registration?.waiting) return false;
    try {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
      return true;
    } catch {
      return false;
    }
  }

  async function syncDeploySignature(registration) {
    try {
      const latestSignature = await getServiceWorkerSignature();
      if (!latestSignature) return;

      const savedSignature = storageGet(localStorage, SW_SIGNATURE_KEY);
      if (!savedSignature) {
        storageSet(localStorage, SW_SIGNATURE_KEY, latestSignature);
        return;
      }

      if (savedSignature === latestSignature) return;

      storageSet(localStorage, SW_SIGNATURE_KEY, latestSignature);
      await Promise.allSettled([clearWindowCaches(), clearWorkerCaches()]);
      await activateWaitingWorker(registration);
      await registration.update().catch(() => {});
      reloadOnce(`deploy-signature-changed:${latestSignature}`);
    } catch {
      // Ignore update signature errors to keep app usable.
    }
  }

  function wireRegistration(registration) {
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;

      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          worker.postMessage({ type: "SKIP_WAITING" });
        }
      });
    });

    const runUpdateCheck = () => {
      registration.update().catch(() => {});
      syncDeploySignature(registration).catch(() => {});
    };

    runUpdateCheck();
    setInterval(runUpdateCheck, UPDATE_INTERVAL_MS);

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") {
          runUpdateCheck();
        }
      },
      { passive: true }
    );
  }

  let isControllerRefreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (isControllerRefreshing) return;
    isControllerRefreshing = true;
    reloadOnce("controller-changed");
  });

  window.addEventListener(
    "pageshow",
    (event) => {
      if (event.persisted) {
        window.location.reload();
      }
    },
    { passive: true }
  );

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register(SW_URL, {
        updateViaCache: "none"
      });
      wireRegistration(registration);
      await activateWaitingWorker(registration);
    } catch {
      // Keep silent in production for benign registration failures.
    }
  });
})();
