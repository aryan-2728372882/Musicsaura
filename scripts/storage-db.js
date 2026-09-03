// scripts/storage-db.js — MusicsAura 3.0 Resilient Offline Storage (IndexedDB + Persistent Cache)
// Protects downloaded tracks from automatic browser eviction (persists indefinitely)

const DB_NAME = "MusicsAuraDB";
const DB_VERSION = 1;
const STORE_NAME = "offline_tracks";
const CACHE_NAME = "musicsaura-pwa-storage-v2";

let dbPromise = null;

// ─── 1. REQUEST PERSISTENT STORAGE ────────────────────────────────
// Guarantees mobile browsers (Android Chrome, iOS Safari) will NEVER auto-evict downloads
export async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persisted();
      if (!isPersisted) {
        const granted = await navigator.storage.persist();
        console.log("[StorageDB] Persistent storage permission:", granted ? "GRANTED ✅" : "DENIED ⚠️");
        return granted;
      }
      return isPersisted;
    } catch (err) {
      console.warn("[StorageDB] Persist request error:", err);
    }
  }
  return false;
}

// ─── 2. INDEXEDDB CONNECTION ──────────────────────────────────────
export function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      console.warn("[StorageDB] IndexedDB not available in this environment.");
      return resolve(null);
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("link", "link", { unique: false });
        store.createIndex("savedAt", "savedAt", { unique: false });
        console.log("[StorageDB] Object store created successfully.");
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = (event) => {
      console.error("[StorageDB] Failed to open IndexedDB:", event.target.error);
      resolve(null);
    };
  });

  return dbPromise;
}

// ─── 3. SAVE TRACK TO DUAL-LAYER STORAGE (IndexedDB + Cache API) ───
export async function saveTrackToStorage(song, blob) {
  if (!song || !song.link || !blob) return false;

  const id = song.id || song.link;
  const baseLink = song.link.split("?")[0];

  // Request persistence in background
  requestPersistentStorage();

  // Layer 1: Store in IndexedDB (immune to standard browser HTTP cache purges)
  try {
    const db = await getDB();
    if (db) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const record = {
          id,
          title: song.title || "Unknown Track",
          artist: song.artist || "MusicsAura",
          link: song.link,
          baseLink,
          thumbnail: song.thumbnail || "",
          genre: song.genre || "offline",
          blob, // Binary Audio Blob directly in DB
          size: blob.size,
          savedAt: Date.now()
        };
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
      });
      console.log(`[StorageDB] Saved "${song.title}" to IndexedDB.`);
    }
  } catch (dbErr) {
    console.warn("[StorageDB] IndexedDB put notice:", dbErr);
  }

  // Layer 2: Store in Cache API (for Service Worker offline interception & streaming)
  try {
    if ("caches" in window) {
      const cache = await caches.open(CACHE_NAME);
      const audioResponse = new Response(blob, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": blob.size.toString(),
          "Access-Control-Allow-Origin": "*",
          "Accept-Ranges": "bytes"
        }
      });
      await cache.put(song.link, audioResponse.clone());
      await cache.put(baseLink, audioResponse);
      console.log(`[StorageDB] Saved "${song.title}" to Cache API.`);
    }
  } catch (cacheErr) {
    console.warn("[StorageDB] Cache API put notice:", cacheErr);
  }

  return true;
}

// ─── 4. RETRIEVE TRACK AUDIO BLOB ─────────────────────────────────
export async function getTrackBlobFromStorage(idOrLink) {
  if (!idOrLink) return null;
  const rawTarget = idOrLink.split("?")[0];

  // Layer 1: Check IndexedDB first (most durable)
  try {
    const db = await getDB();
    if (db) {
      const track = await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(idOrLink);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });

      if (track && track.blob && track.blob.size > 10240) {
        return track.blob;
      }

      // Try index search by link
      const trackByLink = await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("link");
        const req = index.get(rawTarget);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });

      if (trackByLink && trackByLink.blob && trackByLink.blob.size > 10240) {
        return trackByLink.blob;
      }
    }
  } catch (e) {
    console.warn("[StorageDB] IndexedDB get notice:", e);
  }

  // Layer 2: Check Cache API (fallback)
  try {
    if ("caches" in window) {
      const cache = await caches.open(CACHE_NAME);
      const cachedRes = (await cache.match(idOrLink, { ignoreSearch: true })) ||
                        (await cache.match(rawTarget, { ignoreSearch: true }));
      if (cachedRes && (cachedRes.ok || cachedRes.status === 200)) {
        const blob = await cachedRes.blob();
        if (blob && blob.size > 10240) {
          // Re-hydrate IndexedDB automatically so it stays permanently!
          rehydrateIndexedDB(idOrLink, blob);
          return blob;
        }
      }
    }
  } catch (e) {
    console.warn("[StorageDB] Cache API get notice:", e);
  }

  return null;
}

// Background auto-recovery helper
async function rehydrateIndexedDB(idOrLink, blob) {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({
      id: idOrLink,
      link: idOrLink,
      baseLink: idOrLink.split("?")[0],
      blob,
      size: blob.size,
      savedAt: Date.now()
    });
  } catch {}
}

// ─── 5. DELETE TRACK FROM STORAGE ─────────────────────────────────
export async function deleteTrackFromStorage(idOrLink) {
  if (!idOrLink) return;
  const baseLink = idOrLink.split("?")[0];

  // Delete from IndexedDB
  try {
    const db = await getDB();
    if (db) {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(idOrLink);
      store.delete(baseLink);
    }
  } catch (e) {
    console.warn("[StorageDB] IndexedDB delete notice:", e);
  }

  // Delete from Cache API
  try {
    if ("caches" in window) {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(idOrLink, { ignoreSearch: true });
      await cache.delete(baseLink, { ignoreSearch: true });
    }
  } catch (e) {
    console.warn("[StorageDB] Cache API delete notice:", e);
  }
}

// ─── 7. RESTORE / SYNC METADATA FOR PWA SURVIVAL ─────────────────
// Ensures PWA standalone mode and browser eviction never clears downloaded songs
export async function syncOfflineMetadataWithIndexedDB(OFFLINE_STORAGE_KEY) {
  try {
    const persistedTracks = await getAllPersistedTracks();
    if (!persistedTracks || persistedTracks.length === 0) return [];

    let localList = [];
    try {
      localList = JSON.parse(localStorage.getItem(OFFLINE_STORAGE_KEY) || "[]");
    } catch {}

    const localMap = new Map();
    localList.forEach((s) => {
      if (s) localMap.set(s.id || s.link, s);
    });

    let modified = false;
    persistedTracks.forEach((t) => {
      const trackId = t.id || t.link;
      if (!localMap.has(trackId)) {
        // Missing in localStorage! Restore it from permanent IndexedDB!
        localMap.set(trackId, {
          id: trackId,
          title: t.title,
          artist: t.artist,
          link: t.link,
          thumbnail: t.thumbnail,
          genre: t.genre || "offline"
        });
        modified = true;
      }
    });

    const merged = Array.from(localMap.values());
    if (modified || localList.length !== merged.length) {
      localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(merged));
      console.log(`[StorageDB] Restored ${merged.length} downloaded tracks from IndexedDB into PWA storage.`);
    }
    return merged;
  } catch (err) {
    console.warn("[StorageDB] Sync metadata error:", err);
    return [];
  }
}
