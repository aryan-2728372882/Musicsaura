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

// ─── 6. LIST ALL PERSISTED TRACKS FROM INDEXEDDB ─────────────────
export async function getAllPersistedTracks() {
  try {
    const db = await getDB();
    if (!db) return [];
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) {
        console.warn('[StorageDB] getAllPersistedTracks notice:', e);
        resolve([]);
      }
    });
  } catch (err) {
    console.warn('[StorageDB] getAllPersistedTracks error:', err);
    return [];
  }
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
          "Accept-Ranges": "bytes",
          // Marker used by the service worker to identify explicitly saved offline files
          "X-Offline-Saved": "1"
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
export async function getTrackBlobFromStorage(idOrLink, song = null) {
  if (!idOrLink && !song) return null;

  // Extract all possible identifier variations
  let targetId = "";
  let targetLink = "";
  let targetTitle = "";

  if (typeof idOrLink === "object" && idOrLink !== null) {
    targetId = idOrLink.id || "";
    targetLink = idOrLink.link || "";
    targetTitle = idOrLink.title || "";
  } else if (typeof idOrLink === "string") {
    targetId = idOrLink;
    targetLink = idOrLink;
  }

  if (song && typeof song === "object") {
    if (song.id) targetId = targetId || song.id;
    if (song.link) targetLink = targetLink || song.link;
    if (song.title) targetTitle = targetTitle || song.title;
  }

  const rawLink = targetLink ? targetLink.split("?")[0] : "";
  const rawId = targetId ? String(targetId).split("?")[0] : "";

  // Layer 1: Check IndexedDB (Primary & Permanent Storage)
  try {
    const db = await getDB();
    if (db) {
      // 1. Try direct primary key lookups
      const keysToTry = Array.from(new Set([targetId, targetLink, rawLink, rawId].filter(Boolean)));
      for (const k of keysToTry) {
        const track = await new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(k);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        });

        if (track && track.blob && track.blob.size > 10240) {
          return track.blob;
        }
      }

      // 2. Try index lookup on 'link'
      const linksToTry = Array.from(new Set([targetLink, rawLink, targetId, rawId].filter(Boolean)));
      for (const l of linksToTry) {
        const track = await new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            if (store.indexNames.contains("link")) {
              const index = store.index("link");
              const req = index.get(l);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve(null);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });

        if (track && track.blob && track.blob.size > 10240) {
          return track.blob;
        }
      }

      // 3. Resilient fallback scan: matches ID, link, baseLink or normalized title
      const allTracks = await getAllPersistedTracks();
      for (const t of allTracks) {
        if (!t || !t.blob || t.blob.size <= 10240) continue;
        const tId = t.id || "";
        const tLink = t.link || "";
        const tBase = t.baseLink || (tLink ? tLink.split("?")[0] : "");
        const tTitle = (t.title || "").toLowerCase().trim();

        const matches =
          (targetId && (tId === targetId || tId === rawId)) ||
          (targetLink && (tLink === targetLink || tBase === rawLink)) ||
          (rawLink && (tBase === rawLink || (tLink && tLink.split("?")[0] === rawLink))) ||
          (targetTitle && tTitle && tTitle === targetTitle.toLowerCase().trim());

        if (matches) {
          return t.blob;
        }
      }
    }
  } catch (e) {
    console.warn("[StorageDB] IndexedDB get notice:", e);
  }

  // Layer 2: Check Cache API (Offline Cache Fallback)
  try {
    if ("caches" in window) {
      const cache = await caches.open(CACHE_NAME);
      const urlsToTry = Array.from(new Set([targetLink, rawLink, targetId, rawId].filter(Boolean)));
      for (const u of urlsToTry) {
        const cachedRes =
          (await cache.match(u, { ignoreSearch: true })) ||
          (await cache.match(u));

        if (cachedRes && (cachedRes.ok || cachedRes.status === 200)) {
          const blob = await cachedRes.blob();
          if (blob && blob.size > 10240) {
            rehydrateIndexedDB(targetId || targetLink, blob);
            return blob;
          }
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
    const id = typeof idOrLink === "string" ? idOrLink : (idOrLink.id || idOrLink.link);
    const link = typeof idOrLink === "string" ? idOrLink : (idOrLink.link || idOrLink.id);
    store.put({
      id,
      link,
      baseLink: link ? link.split("?")[0] : id,
      blob,
      size: blob.size,
      savedAt: Date.now()
    });
  } catch {}
}

// ─── 5. DELETE TRACK FROM STORAGE ─────────────────────────────────
export async function deleteTrackFromStorage(idOrLink) {
  if (!idOrLink) return;
  const rawTarget = typeof idOrLink === "string" ? idOrLink.split("?")[0] : "";
  const idStr = typeof idOrLink === "string" ? idOrLink : (idOrLink.id || idOrLink.link);

  // Delete from IndexedDB
  try {
    const db = await getDB();
    if (db) {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      if (idStr) store.delete(idStr);
      if (rawTarget && rawTarget !== idStr) store.delete(rawTarget);
    }
  } catch (e) {
    console.warn("[StorageDB] IndexedDB delete notice:", e);
  }

  // Delete from Cache API
  try {
    if ("caches" in window) {
      const cache = await caches.open(CACHE_NAME);
      if (idStr) await cache.delete(idStr, { ignoreSearch: true });
      if (rawTarget && rawTarget !== idStr) await cache.delete(rawTarget, { ignoreSearch: true });
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
