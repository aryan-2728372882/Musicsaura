// scripts/app.js — MusicsAura 3.0 Core App Controller
import {
  auth, db, isAdmin, onAuthStateChanged,
  collection, getDocs, query, orderBy, limit, onSnapshot, deleteDoc, doc, updateDoc
} from "./firebase-config.js";
import { player, formatTime } from "./player.js";
import {
  saveTrackToStorage,
  deleteTrackFromStorage,
  requestPersistentStorage,
  syncOfflineMetadataWithIndexedDB
} from "./storage-db.js";

/* ── DOM ELEMENTS ── */
const grid                 = document.getElementById("grid");
const searchGrid           = document.getElementById("search-grid");
const searchInp            = document.getElementById("search");
const searchClearBtn       = document.getElementById("search-clear-btn");
const mobileSearchInp      = document.getElementById("mobile-search");
const mobileSearchClearBtn = document.getElementById("mobile-search-clear-btn");
const profileBtn           = document.getElementById("profile-btn");
const navAvatar            = document.getElementById("nav-avatar");
const genrePills           = document.querySelectorAll(".genre-pill");
const pillOffline          = document.getElementById("pill-offline");

// Hero Banner Elements
const heroBanner           = document.getElementById("hero-banner");
const heroTitle            = document.getElementById("hero-title");
const heroDesc             = document.getElementById("hero-desc");
const heroImg              = document.getElementById("hero-img");
const heroPlayBtn          = document.getElementById("hero-play-btn");
const heroFxBtn            = document.getElementById("hero-fx-btn");

// Audio FX & Studio Modal
const audioFxModal         = document.getElementById("audio-fx-modal");
const audioFxBtn           = document.getElementById("audio-fx-btn");
const playerFxBtn          = document.getElementById("player-fx-btn");
const fsFxBtn              = document.getElementById("fs-fx-btn");
const closeFxBtn           = document.getElementById("close-fx-btn");
const crossfadeSlider      = document.getElementById("crossfade-slider");
const crossfadeVal         = document.getElementById("crossfade-val");
const speedVal             = document.getElementById("speed-val");

// Queue Drawer Elements
const queueDrawer          = document.getElementById("queue-drawer");
const queueBackdrop        = document.getElementById("queue-backdrop");
const queueBtn             = document.getElementById("queue-btn");
const closeQueueBtn        = document.getElementById("close-queue-btn");
const queueListEl          = document.getElementById("queue-list");
const queueCountEl         = document.getElementById("queue-count");

// Sleep Timer Elements
const sleepTimerBtn        = document.getElementById("sleep-timer-btn");
const sleepModal           = document.getElementById("sleep-modal");
const closeSleepBtn        = document.getElementById("close-sleep-btn");

// Fullscreen Mobile Player Sheet Elements
const fsSheet              = document.getElementById("fullscreen-player");
const fsCloseBtn           = document.getElementById("fs-close-btn");
const fsQueueBtn           = document.getElementById("fs-queue-btn");
const fsArtwork            = document.getElementById("fs-artwork");
const fsGlow               = document.getElementById("fs-glow");
const fsTitle              = document.getElementById("fs-title");
const fsArtist             = document.getElementById("fs-artist");
const fsFavBtn             = document.getElementById("fs-fav-btn");
const fsSeek               = document.getElementById("fs-seek");
const fsCurrentTime        = document.getElementById("fs-current-time");
const fsDurationTime       = document.getElementById("fs-duration-time");
const fsPlayPause          = document.getElementById("fs-play-pause");
const fsPlayIcon           = fsPlayPause ? fsPlayPause.querySelector(".material-icons") : null;
const fsPrev               = document.getElementById("fs-prev");
const fsNext               = document.getElementById("fs-next");
const fsShuffle            = document.getElementById("fs-shuffle");
const fsRepeat             = document.getElementById("fs-repeat");
const fsSleepBtn           = document.getElementById("fs-sleep-btn");

const playerMobileTrigger  = document.getElementById("player-mobile-trigger");
const expandPlayerBtn      = document.getElementById("expand-player-btn");
const playerHeartBtn       = document.getElementById("player-heart-btn");
const playerOfflineBtn     = document.getElementById("player-offline-btn");
const fsOfflineBtn         = document.getElementById("fs-offline-btn");
const fsOfflineText        = document.getElementById("fs-offline-text");

/* ── STATE & CONSTANTS ── */
const GENRE_FILES = {
  hindi:    "jsons/hindi.json",
  punjabi:  "jsons/punjabi.json",
  haryanvi: "jsons/haryanvi.json",
  rap:      "jsons/rap.json",
  bhojpuri: "jsons/bhojpuri.json"
};
const DEFAULT_GENRE        = "hindi";
const FAVORITES_KEY        = "musicsaura_favorites";
const OFFLINE_STORAGE_KEY  = "musicsaura_offline_songs";
const OFFLINE_CACHE_NAME   = "musicsaura-pwa-storage-v2";
const LOCAL_UPLOADS_KEY    = "musicsaura_local_uploads";

let allSongs = [];
const rawJsonSongs = {};
const songsByGenre = {};
let activeGenre = DEFAULT_GENRE;
let searchTimer = null;
let firestoreSongs = [];

/* ── IN-APP OFFLINE STORAGE (PWA SANDBOX) ── */
export function getOfflineSongs() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function isSongOffline(song) {
  if (!song) return false;
  const list = getOfflineSongs();
  const id = song.id || song.link;
  return list.some((s) => (s.id || s.link) === id);
}

function updateDownloadBadge() {
  const list = getOfflineSongs();
  if (pillOffline) {
    pillOffline.innerHTML = `
      <span class="material-icons" style="font-size:0.95rem;color:var(--cyan);margin-right:2px">download_for_offline</span>
      In-App Downloads 📥 (${list.length})
    `;
  }
}

/* ── ROBUST CONCURRENT-SAFE DOWNLOAD QUEUE MANAGER ── */
const downloadQueue = [];
const activeDownloads = new Set();
const queuedSongIds = new Set();
const MAX_CONCURRENT_DOWNLOADS = 2; // Optimal concurrency for mobile CDNs and avoids socket exhaustion

// Request permanent persistence and restore offline metadata from IndexedDB immediately on startup
requestPersistentStorage();
syncOfflineMetadataWithIndexedDB(OFFLINE_STORAGE_KEY).then((restored) => {
  if (restored && restored.length > 0) {
    updateDownloadBadge();
  }
});

// Remove only downloaded records whose remote file was explicitly deleted.
// The catalogue entry remains visible; it simply cannot resurrect old audio.
async function purgeDeletedOfflineTracks() {
  const offlineSongs = getOfflineSongs();
  const deletedIds = new Set();
  for (const song of offlineSongs) {
    if (!song?.link || !song.link.includes("file.garden")) continue;
    try {
      const response = await fetch(song.link, { method: "HEAD", cache: "no-store" });
      if (response.status === 404 || response.status === 410) {
        const id = song.id || song.link;
        await deleteTrackFromStorage(id);
        deletedIds.add(id);
      }
    } catch {}
  }
  if (deletedIds.size > 0) {
    const remaining = getOfflineSongs().filter((song) => !deletedIds.has(song.id || song.link));
    localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(remaining));
    updateDownloadBadge();
  }
}

purgeDeletedOfflineTracks();

export async function toggleOfflineStorage(song) {
  if (!song || !song.link) return;
  const songId = song.id || song.link;

  // 1. If song is already downloaded, remove it
  if (isSongOffline(song)) {
    try {
      await deleteTrackFromStorage(songId);
      const currentList = getOfflineSongs().filter((s) => (s.id || s.link) !== songId);
      localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(currentList));

      player.showToast(`Removed "${song.title}" from Downloads`);
      updateOfflineIcons(song, "not-downloaded");
      updateDownloadBadge();
      if (activeGenre === "offline") renderGenre("offline");
    } catch (err) {
      console.warn("Error removing offline track:", err);
    }
    return;
  }

  // 2. If already downloading or queued, inform the user
  if (activeDownloads.has(songId) || queuedSongIds.has(songId)) {
    player.showToast(`⏳ "${song.title}" is already in the download queue.`);
    return;
  }

  // 3. Request storage persistence on user gesture
  requestPersistentStorage();

  // 4. Enqueue the song
  queuedSongIds.add(songId);
  downloadQueue.push(song);
  updateOfflineIcons(song, "queued");

  const totalActive = downloadQueue.length + activeDownloads.size;
  player.showToast(`📥 Queued "${song.title}" (${totalActive} in queue)`);

  // 5. Trigger queue processing
  processDownloadQueue();
}

async function processDownloadQueue() {
  if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS || downloadQueue.length === 0) {
    return;
  }

  const song = downloadQueue.shift();
  if (!song) return;
  const songId = song.id || song.link;
  queuedSongIds.delete(songId);
  activeDownloads.add(songId);

  updateOfflineIcons(song, "downloading");

  // Run download in background worker
  (async () => {
    let blob = null;
    let attempts = 0;
    const maxAttempts = 3;

    while (!blob && attempts < maxAttempts) {
      attempts++;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

        const res = await fetch(song.link, {
          signal: controller.signal,
          mode: "cors",
          cache: "no-store"
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const b = await res.blob();
          if (b && b.size > 10240) {
            blob = b;
            break;
          }
        }
      } catch (fetchErr) {
        console.warn(`[DownloadQueue] Attempt ${attempts} failed for "${song.title}":`, fetchErr);
        if (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000 * attempts));
        }
      }
    }

    if (!blob) {
      console.error(`[DownloadQueue] Failed to download "${song.title}" after ${maxAttempts} attempts.`);
      updateOfflineIcons(song, "not-downloaded");
      player.showToast(`❌ Failed to download "${song.title}". Please check connection.`, 4000);
      return;
    }

    try {
      // Save track into both IndexedDB and Cache API
      await saveTrackToStorage(song, blob);

      // Cache thumbnail image for offline UI
      if (song.thumbnail && !song.thumbnail.startsWith("assets/")) {
        try {
          const tRes = await fetch(song.thumbnail, { mode: "no-cors" });
          if (tRes) {
            const cache = await caches.open(OFFLINE_CACHE_NAME);
            await cache.put(song.thumbnail, tRes);
          }
        } catch {}
      }

      // ATOMIC UPDATE to localStorage metadata (read fresh list to avoid overwriting concurrent downloads!)
      const freshList = getOfflineSongs();
      const existingIdx = freshList.findIndex((s) => (s.id || s.link) === songId);
      if (existingIdx >= 0) {
        freshList[existingIdx] = song;
      } else {
        freshList.unshift(song);
      }
      localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(freshList));

      updateOfflineIcons(song, "downloaded");
      updateDownloadBadge();
      if (activeGenre === "offline") renderGenre("offline");

      const remaining = downloadQueue.length + activeDownloads.size - 1;
      if (remaining > 0) {
        player.showToast(`⚡ Saved "${song.title}" (${remaining} remaining)`);
      } else {
        player.showToast(`🎉 Saved "${song.title}"! Ready for offline listening.`);
      }
    } catch (saveErr) {
      console.error(`[DownloadQueue] Error saving "${song.title}":`, saveErr);
      updateOfflineIcons(song, "not-downloaded");
      player.showToast(`❌ Could not save "${song.title}": ${saveErr.message}`, 3500);
    } finally {
      activeDownloads.delete(songId);
      // Process next in queue
      processDownloadQueue();
    }
  })();

  // Also spawn parallel worker if under MAX_CONCURRENT_DOWNLOADS
  if (activeDownloads.size < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
    processDownloadQueue();
  }
}

function updateOfflineIcons(song, state) {
  const songId = song?.id || song?.link;
  if (!songId) return;

  const isOff = state === "downloaded" || state === true;
  const isDownloading = state === "downloading";
  const isQueued = state === "queued";

  let iconName = "offline_bolt";
  let titleText = "Save in App Storage for Offline Listening";
  let sheetText = "Save Offline";

  if (isOff) {
    iconName = "offline_pin";
    titleText = "Downloaded in App Storage";
    sheetText = "Downloaded 📥";
  } else if (isDownloading) {
    iconName = "sync";
    titleText = "Downloading audio...";
    sheetText = "Downloading...";
  } else if (isQueued) {
    iconName = "hourglass_top";
    titleText = "Queued for download...";
    sheetText = "Queued...";
  }

  // Grid cards
  document.querySelectorAll(`.song-card[data-id="${songId}"] .card-offline-btn`).forEach((btn) => {
    btn.classList.toggle("active", isOff || isDownloading || isQueued);
    btn.classList.toggle("is-downloading", isDownloading || isQueued);
    btn.title = titleText;
    const icon = btn.querySelector(".material-icons");
    if (icon) icon.textContent = iconName;
  });

  // Footer player offline button
  if (playerOfflineBtn) {
    playerOfflineBtn.classList.toggle("active", isOff || isDownloading || isQueued);
    playerOfflineBtn.classList.toggle("is-downloading", isDownloading || isQueued);
    playerOfflineBtn.title = titleText;
    const icon = playerOfflineBtn.querySelector(".material-icons");
    if (icon) icon.textContent = iconName;
  }

  // Fullscreen mobile player offline button
  if (fsOfflineBtn) {
    fsOfflineBtn.classList.toggle("active", isOff || isDownloading || isQueued);
    fsOfflineBtn.classList.toggle("is-downloading", isDownloading || isQueued);
    fsOfflineBtn.title = titleText;
    const icon = fsOfflineBtn.querySelector(".material-icons");
    if (icon) icon.textContent = iconName;
    if (fsOfflineText) fsOfflineText.textContent = sheetText;
  }
}

/* ── FAVORITES SYSTEM ── */
export function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
  } catch {
    return [];
  }
}

export function isFavorite(song) {
  if (!song) return false;
  const favs = getFavorites();
  const id = song.id || song.link;
  return favs.some((f) => (f.id || f.link) === id);
}

export function toggleFavorite(song) {
  if (!song) return false;
  let favs = getFavorites();
  const id = song.id || song.link;
  const existsIndex = favs.findIndex((f) => (f.id || f.link) === id);

  if (existsIndex >= 0) {
    favs.splice(existsIndex, 1);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
    player.showToast(`Removed from favorites`);
    updateHeartIcons(song, false);
    if (activeGenre === "favorites") renderGenre("favorites");
    return false;
  } else {
    favs.unshift(song);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
    player.showToast(`Added to favorites ❤️`);
    updateHeartIcons(song, true);
    if (activeGenre === "favorites") renderGenre("favorites");
    return true;
  }
}

function updateHeartIcons(song, isFav) {
  const songId = song.id || song.link;

  // Grid cards
  document.querySelectorAll(`.song-card[data-id="${songId}"] .card-fav-btn:not(.card-offline-btn)`).forEach((btn) => {
    btn.classList.toggle("active", isFav);
    const icon = btn.querySelector(".material-icons");
    if (icon) icon.textContent = isFav ? "favorite" : "favorite_border";
  });

  // Footer player heart
  if (playerHeartBtn) {
    playerHeartBtn.classList.toggle("active", isFav);
    const icon = playerHeartBtn.querySelector(".material-icons");
    if (icon) icon.textContent = isFav ? "favorite" : "favorite_border";
  }

  // Fullscreen sheet heart
  if (fsFavBtn) {
    fsFavBtn.classList.toggle("active", isFav);
    const icon = fsFavBtn.querySelector(".material-icons");
    if (icon) icon.textContent = isFav ? "favorite" : "favorite_border";
  }
}

/* ── NORMALIZATION ── */
function normalizeSong(song, genre = "hindi", source = "json") {
  if (!song || !song.title) return null;

  let kw = song.keywords || [];
  if (typeof kw === "string") kw = kw.split(/[,;]/).map((x) => x.trim());
  else if (Array.isArray(kw)) kw = kw.flatMap((k) => (typeof k === "string" ? k.split(/[,;]/).map((x) => x.trim()) : []));
  else kw = [];

  const titleWords  = song.title ? song.title.split(/\s+/) : [];
  const artistWords = song.artist ? song.artist.split(/[,&/]+|\s+/) : [];
  const keywords = Array.from(new Set([...kw, ...titleWords, ...artistWords].map((w) => w.toLowerCase().trim()).filter(Boolean)));

  const cleanGenre = (song.genre || genre || "hindi").toLowerCase().trim();

  return {
    ...song,
    id: song.id || song.link,
    title: song.title || "Untitled",
    artist: song.artist || "MusicsAura",
    thumbnail: song.thumbnail || "assets/logo.png",
    genre: cleanGenre,
    keywords,
    source,
    _search: `${song.title || ""} ${song.artist || ""} ${cleanGenre} ${keywords.join(" ")}`.toLowerCase()
  };
}

/* ── LOCAL BACKUP BUFFER LOADER ── */
function getLocalUploads() {
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_UPLOADS_KEY) || "[]");
    return list.filter((s) => s && s.link && !isDeletedSong(s));
  } catch {
    return [];
  }
}

const BLOCKED_SONG_LINKS = new Set([
  "https://file.garden/argaqiyidd0tulqv/hindi/mujhe%20tumse%20mohabbat%20hai.mp3"
]);
const BLOCKED_SONG_TITLES = new Set(["mujhe tumse mohabbat hai"]);
let deletedSongLinks = new Set(BLOCKED_SONG_LINKS);

function isDeletedSong(song) {
  if (!song) return true;
  const link = (song.link || "").split("?")[0].toLowerCase().trim();
  const title = (song.title || "").toLowerCase().trim();
  return deletedSongLinks.has(link) || BLOCKED_SONG_LINKS.has(link) || BLOCKED_SONG_TITLES.has(title);
}

async function loadDeletedSongLinks() {
  try {
    const snapshot = await getDocs(collection(db, "deleted_songs"));
    snapshot.forEach((entry) => {
      const data = entry.data();
      if (data?.link) deletedSongLinks.add(data.link.split("?")[0].toLowerCase().trim());
    });
  } catch (err) {
    console.warn("Deleted-song blacklist notice:", err);
  }

  async function removeMissingJsonSongsFromFirestore() {
    const loadedGenres = Object.keys(GENRE_FILES).every((genre) => Array.isArray(rawJsonSongs[genre]));
    if (!loadedGenres) {
      console.warn("Skipping Firestore catalogue reconciliation because a JSON catalogue failed to load.");
      return;
    }

    const jsonLinks = new Set(
      Object.values(rawJsonSongs)
        .flat()
        .map((song) => (song?.link || "").split("?")[0].toLowerCase().trim())
        .filter(Boolean)
    );

    try {
      const snapshot = await getDocs(collection(db, "songs"));
      const removals = [];
      snapshot.forEach((entry) => {
        const data = entry.data();
        const link = (data?.link || "").split("?")[0].toLowerCase().trim();
        if (isDeletedSong(data) || (data?.catalogManaged === true && link && !jsonLinks.has(link))) {
          removals.push(deleteDoc(doc(db, "songs", entry.id)));
        } else if (link && jsonLinks.has(link) && data?.catalogManaged !== true) {
          removals.push(updateDoc(doc(db, "songs", entry.id), { catalogManaged: true }));
        }
      });
      if (removals.length) {
        await Promise.all(removals);
        console.log(`[Catalogue] Removed ${removals.length} JSON-deleted song(s) from Firestore.`);
      }
    } catch (err) {
      console.warn("Firestore catalogue reconciliation notice:", err);
    }
  }
}

function getSongTimestamp(song) {
  if (!song) return 0;
  const c = song.createdAt;
  if (!c) {
    if (typeof song.id === "string" && song.id.startsWith("local_")) {
      const ts = parseInt(song.id.split("_")[1], 10);
      if (!isNaN(ts)) return ts;
    }
    return song._timestamp || 0;
  }
  if (typeof c.toMillis === "function") return c.toMillis();
  if (typeof c.toDate === "function") return c.toDate().getTime();
  if (typeof c === "number") return c;
  if (typeof c.seconds === "number") return c.seconds * 1000 + (c.nanoseconds ? c.nanoseconds / 1000000 : 0);
  if (c instanceof Date) return c.getTime();
  if (typeof c === "string") {
    const parsed = Date.parse(c);
    if (!isNaN(parsed)) return parsed;
  }
  return song._timestamp || 0;
}

/* ── REBUILD ALL CATALOGUES & GLOBAL SEARCH INDEX ── */
function rebuildAllCatalogues() {
  // Purge any legacy placeholder uploads from local storage
  try {
    const local = JSON.parse(localStorage.getItem(LOCAL_UPLOADS_KEY) || "[]");
    const cleaned = local.filter((s) => s && s.link && s.thumbnail && !s.thumbnail.includes("logo.png") && s.artist !== "Various Artists");
    if (cleaned.length !== local.length) {
      localStorage.setItem(LOCAL_UPLOADS_KEY, JSON.stringify(cleaned));
    }
  } catch {}

  const localUploads = getLocalUploads()
    .map((s) => normalizeSong(s, s?.genre, "local"))
    .filter((s) => s && s.link && !isDeletedSong(s));

  // Merge Firestore songs and local uploads
  const allCustom = [...firestoreSongs, ...localUploads]
    .filter((s) => s && s.link && !isDeletedSong(s));

  // Remove duplicate custom songs by link and keep the latest
  const uniqueMap = new Map();
  allCustom.forEach((s) => {
    if (s && s.link) {
      const cleanLink = s.link.split("?")[0].toLowerCase();
      if (!uniqueMap.has(cleanLink)) {
        uniqueMap.set(cleanLink, s);
      } else {
        const existing = uniqueMap.get(cleanLink);
        if (getSongTimestamp(s) > getSongTimestamp(existing)) {
          uniqueMap.set(cleanLink, s);
        }
      }
    }
  });

  // STRICTLY SORT ALL UPLOADS: Newest releases / uploads ALWAYS on top!
  const uniqueCustom = Array.from(uniqueMap.values()).sort((a, b) => {
    return getSongTimestamp(b) - getSongTimestamp(a);
  });

  // Build each genre preserving raw JSON catalog top order + newest community uploads
  Object.keys(GENRE_FILES).forEach((genre) => {
    const raw = (rawJsonSongs[genre] || []).filter((s) => s && s.link && !isDeletedSong(s));
    const rawLinks = new Set(raw.map((s) => s.link.split("?")[0].toLowerCase().trim()));
    const rawTitles = new Set(raw.map((s) => (s.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim()).filter(Boolean));

    const genreUploads = uniqueCustom.filter((s) => s && (s.genre || "").toLowerCase() === genre.toLowerCase());
    const brandNewCommunityUploads = genreUploads.filter((s) => {
      const cleanLink = s.link.split("?")[0].toLowerCase().trim();
      const cleanTitle = (s.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
      return !rawLinks.has(cleanLink) && (!cleanTitle || !rawTitles.has(cleanTitle));
    });

    songsByGenre[genre] = [...brandNewCommunityUploads, ...raw];
  });

  // Rebuild global search index containing ALL songs (strictly unique)
  allSongs = [];
  const globalSeenLinks = new Set();
  const globalSeenTitles = new Set();

  // 1. Add all songs from all JSONs (guaranteeing official order)
  Object.values(songsByGenre).forEach((list) => {
    list.forEach((s) => {
      if (!s || !s.link || isDeletedSong(s)) return;
      const cleanLink = s.link.split("?")[0].toLowerCase().trim();
      const cleanTitle = (s.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
      if (!globalSeenLinks.has(cleanLink) && (!cleanTitle || !globalSeenTitles.has(cleanTitle))) {
        globalSeenLinks.add(cleanLink);
        if (cleanTitle) globalSeenTitles.add(cleanTitle);
        allSongs.push(s);
      }
    });
  });

  // Re-render the active view with latest songs
  if (!searchGrid.hidden && (searchInp?.value || mobileSearchInp?.value)) {
    searchSongs(searchInp?.value || mobileSearchInp?.value);
  } else {
    renderGenre(activeGenre);
  }
}

/* ── LOAD RAW JSON FILES ── */
async function loadRawJson(genre) {
  const file = GENRE_FILES[genre];
  if (!file) return [];

  try {
    const res = await fetch(`${file}?v=${Date.now()}`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data)) {
      rawJsonSongs[genre] = data
        .map((s, i) => normalizeSong(s, genre, `json_${genre}_${i}`))
        .filter((s) => s && s.link);
      return rawJsonSongs[genre];
    }
  } catch (err) {
    console.warn(`Failed loading catalogue for ${genre}:`, err);
  }
  return [];
}

/* ── ULTRA LOW-QUOTA FIRESTORE SYNCHRONIZATION WITH 30-MIN CACHE ── */
const FIRESTORE_CACHE_KEY      = "musicsaura_firestore_songs_cache";
const FIRESTORE_CACHE_TIME_KEY = "musicsaura_firestore_cache_time";
const CACHE_VALIDITY_MS        = 30 * 60 * 1000; // 30 minutes cache validity (0 reads for 30 mins)

function loadCachedFirestoreSongs() {
  try {
    const raw = localStorage.getItem(FIRESTORE_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        firestoreSongs = parsed.filter((s) => s && s.link && !isDeletedSong(s));
        rebuildAllCatalogues();
      }
    }
  } catch {}
}

function saveCachedFirestoreSongs(songs) {
  try {
    localStorage.setItem(FIRESTORE_CACHE_KEY, JSON.stringify(songs.slice(0, 300)));
    localStorage.setItem(FIRESTORE_CACHE_TIME_KEY, Date.now().toString());
  } catch {}
}

async function subscribeToFirestoreSongs() {
  // 0. Load cached songs immediately
  loadCachedFirestoreSongs();

  // Check cache freshness: Skip network query completely if refreshed within 3 hours (0 reads!)
  const lastTime = parseInt(localStorage.getItem(FIRESTORE_CACHE_TIME_KEY) || "0", 10);
  const isFresh = Date.now() - lastTime < 3 * 60 * 60 * 1000;
  if (isFresh && firestoreSongs.length > 0) {
    return;
  }

  try {
    // 1. Fetch only recent 15 community uploads to minimize Firestore reads
    const songsQuery = query(collection(db, "songs"), orderBy("createdAt", "desc"), limit(15));
    const snap = await getDocs(songsQuery);

    const newSongs = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      if (data && data.link && !isDeletedSong(data)) {
        const norm = normalizeSong({ id: docSnap.id, ...data }, data.genre, "firestore");
        if (norm && norm.link) {
          newSongs.push(norm);
        }
      }
    });

    if (newSongs.length > 0) {
      firestoreSongs = newSongs;
      saveCachedFirestoreSongs(firestoreSongs);
      rebuildAllCatalogues();
      renderGenre(activeGenre);
    }
  } catch (err) {
    console.warn("Firestore sync notice (using local catalogue):", err);
  }
}

/* ── HTML ESCAPER ── */
function escapeHtml(s) {
  return (s || "").toString().replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ── SONG CARD CREATOR ── */
function createCard(song, index) {
  const el = document.createElement("div");
  el.className = "song-card";
  el.dataset.id = song.id || song.link;
  el.dataset.index = String(index);

  const isFav = isFavorite(song);
  const songId = song.id || song.link;
  const isOff = isSongOffline(song);
  const isDownloading = activeDownloads.has(songId);
  const isQueued = queuedSongIds.has(songId);

  let offIcon = "offline_bolt";
  let offClass = "";
  let offTitle = "Save in App Storage for Offline Listening";

  if (isOff) {
    offIcon = "offline_pin";
    offClass = "active";
    offTitle = "Downloaded in App Storage";
  } else if (isDownloading) {
    offIcon = "sync";
    offClass = "active is-downloading";
    offTitle = "Downloading audio...";
  } else if (isQueued) {
    offIcon = "hourglass_top";
    offClass = "active is-downloading";
    offTitle = "Queued for download...";
  }

  const playerState = player.getState();
  const isPlayingThis = playerState.currentSong && (playerState.currentSong.id || playerState.currentSong.link) === (song.id || song.link);

  if (isPlayingThis) el.classList.add("is-playing");

  const thumbUrl = song.thumbnail || "assets/logo.png";

  el.innerHTML = `
    <div class="card-img-wrap">
      <img
        src="${escapeHtml(thumbUrl)}"
        alt="${escapeHtml(song.title)}"
        loading="lazy"
        decoding="async"
        onerror="this.onerror=null;this.src='assets/logo.png';"
      >
      <div class="card-play-overlay">
        <span class="material-icons play-icon">${isPlayingThis && playerState.isPlaying ? "pause" : "play_arrow"}</span>
      </div>
      <button class="card-fav-btn ${isFav ? "active" : ""}" aria-label="Favorite" title="${isFav ? "Remove Favorite" : "Favorite"}">
        <span class="material-icons">${isFav ? "favorite" : "favorite_border"}</span>
      </button>
      <button class="card-fav-btn card-offline-btn ${offClass}" style="top:auto;bottom:8px;right:8px;background:rgba(12,12,22,0.85);color:${(isOff || isDownloading || isQueued) ? "var(--cyan)" : "var(--text-muted)"}" aria-label="Offline Storage" title="${offTitle}">
        <span class="material-icons" style="font-size:1.1rem">${offIcon}</span>
      </button>
    </div>
    <div class="card-info">
      <div class="card-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>
      <div class="card-artist" title="${escapeHtml(song.artist || "MusicsAura")}">${escapeHtml(song.artist || "MusicsAura")}</div>
    </div>
  `;

  // Favorite button click
  const favBtn = el.querySelector(".card-fav-btn:not(.card-offline-btn)");
  if (favBtn) {
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(song);
    });
  }

  // Offline Storage button click
  const offlineBtn = el.querySelector(".card-offline-btn");
  if (offlineBtn) {
    offlineBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleOfflineStorage(song);
    });
  }

  // Instant Hover / Touch Stream Pre-warmer for 0ms start latency
  el.addEventListener("pointerenter", () => {
    if (song.link) player.prefetchAudioStream(song.link);
  }, { passive: true, once: true });

  el.addEventListener("pointerdown", () => {
    if (song.link) player.prefetchAudioStream(song.link);
  }, { passive: true, once: true });

  return el;
}

/* ── GLITCH-FREE SYNCHRONOUS RENDERER ── */
function renderSongList(container, songs, emptyMsg = "No tracks available.") {
  const cleanSongs = (songs || []).filter((s) => s && s.title && s.link);
  container._songs = cleanSongs;

  if (!cleanSongs.length) {
    const p = document.createElement("div");
    p.className = "state-msg empty-msg";
    p.innerHTML = `<span class="material-icons" style="font-size:2.5rem;display:block;margin-bottom:0.5rem;opacity:0.6">library_music</span>${escapeHtml(emptyMsg)}`;
    container.replaceChildren(p);
    return;
  }

  // Render all cards in one atomic DocumentFragment for completely stable scrolling
  const frag = document.createDocumentFragment();
  cleanSongs.forEach((song, i) => frag.appendChild(createCard(song, i)));
  container.replaceChildren(frag);
}

/* ── HERO BANNER UPDATE ── */
function updateHeroBanner(songs) {
  if (!songs || !songs.length) return;
  const topSong = songs[0];
  if (heroTitle) heroTitle.textContent = topSong.title || "Immersive Soundscapes";
  if (heroDesc) heroDesc.textContent = `Trending in ${topSong.genre?.toUpperCase() || "HINDI"} — Featuring ${topSong.artist || "Top Artists"}`;
  if (heroImg) heroImg.src = topSong.thumbnail || "assets/logo.png";

  if (heroPlayBtn) {
    heroPlayBtn.onclick = () => {
      player.setPlaylist(songs, 0);
      player.playSong(topSong);
    };
  }
}

/* ── GENRE SWITCHER ── */
function selectGenre(genre) {
  activeGenre = genre;

  genrePills.forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.genre === genre);
  });

  grid.hidden = false;
  grid.style.display = "";
  searchGrid.hidden = true;
  searchGrid.style.display = "none";
  if (heroBanner) heroBanner.style.display = "";
  if (searchInp) searchInp.value = "";
  if (mobileSearchInp) mobileSearchInp.value = "";
  if (searchClearBtn) searchClearBtn.style.display = "none";
  if (mobileSearchClearBtn) mobileSearchClearBtn.style.display = "none";

  renderGenre(genre);
}

function renderGenre(genre) {
  if (genre === "favorites") {
    const favs = getFavorites().map((s) => normalizeSong(s, s.genre || "favorites", "fav"));
    renderSongList(grid, favs, "No favorite songs yet! Tap the heart icon on any song to add it here.");
    updateHeroBanner(favs);
    return;
  }

  if (genre === "offline") {
    const offList = getOfflineSongs().map((s) => normalizeSong(s, s.genre || "offline", "offline"));
    renderSongList(grid, offList, "No songs downloaded in App Storage yet. Tap the ⚡ icon on any song to download it for offline play (even on Airplane Mode)!");
    updateHeroBanner(offList);

    // Auto-recover from IndexedDB if PWA standalone / OS evicted temporary localStorage
    syncOfflineMetadataWithIndexedDB(OFFLINE_STORAGE_KEY).then((syncedList) => {
      if (syncedList && syncedList.length > offList.length && activeGenre === "offline") {
        const fullList = syncedList.map((s) => normalizeSong(s, s.genre || "offline", "offline"));
        renderSongList(grid, fullList, "No songs downloaded in App Storage yet. Tap the ⚡ icon on any song to download it for offline play (even on Airplane Mode)!");
        updateHeroBanner(fullList);
        updateDownloadBadge();
      }
    });
    return;
  }

  const songs = songsByGenre[genre] || [];
  const emptyMsg = "No songs available in this category.";
  renderSongList(grid, songs, emptyMsg);
  updateHeroBanner(songs);
}

/* ── SEARCH ENGINE ── */
function getAllSearchableSongs() {
  if (allSongs && allSongs.length > 0) return allSongs;
  const list = [];
  const seen = new Set();

  getOfflineSongs().forEach((s) => {
    if (s && s.link && !seen.has(s.link)) {
      seen.add(s.link);
      const norm = normalizeSong(s, s.genre || "offline", "offline");
      if (norm) list.push(norm);
    }
  });

  Object.values(songsByGenre).forEach((genreList) => {
    (genreList || []).forEach((s) => {
      if (s && s.link && !seen.has(s.link)) {
        seen.add(s.link);
        list.push(s);
      }
    });
  });

  return list;
}

function searchSongs(query) {
  const q = (query || "").trim().toLowerCase();

  if (searchClearBtn) searchClearBtn.style.display = q ? "block" : "none";
  if (mobileSearchClearBtn) mobileSearchClearBtn.style.display = q ? "block" : "none";

  if (!q) {
    searchGrid.hidden = true;
    searchGrid.style.display = "none";
    grid.hidden = false;
    grid.style.display = "";
    if (heroBanner) heroBanner.style.display = "";
    return;
  }

  const pool = getAllSearchableSongs();
  const terms = q.split(/\s+/).filter(Boolean);

  const matches = pool.filter((song) => {
    if (!song) return false;
    const title = (song.title || "").toLowerCase();
    const artist = (song.artist || "").toLowerCase();
    const genre = (song.genre || "").toLowerCase();
    const kw = Array.isArray(song.keywords) ? song.keywords.join(" ").toLowerCase() : "";
    const searchTarget = `${title} ${artist} ${genre} ${kw} ${song._search || ""}`.toLowerCase();
    return terms.every((term) => searchTarget.includes(term));
  });

  renderSongList(searchGrid, matches, `No songs found matching "${escapeHtml(query)}". Try another track title, artist, or genre.`);
  grid.hidden = true;
  grid.style.display = "none";
  searchGrid.hidden = false;
  searchGrid.style.display = "grid";
  if (heroBanner) heroBanner.style.display = "none";
}

/* ── CARD CLICK DELEGATION ── */
function setupContainerClickHandler(container) {
  if (container._bound) return;
  container._bound = true;

  container.addEventListener("click", (e) => {
    if (e.target.closest(".card-fav-btn")) return;
    const card = e.target.closest(".song-card");
    if (!card) return;

    const songs = container._songs || [];
    const idx = parseInt(card.dataset.index || "-1", 10);
    if (idx < 0 || !songs[idx]) return;

    const selectedSong = songs[idx];
    const playerState = player.getState();

    // If clicking current song, toggle play/pause
    if (playerState.currentSong && (playerState.currentSong.id || playerState.currentSong.link) === (selectedSong.id || selectedSong.link)) {
      player.togglePlay();
    } else {
      player.playSong(selectedSong, songs, idx);
    }
    updateQueueDrawer();
  });
}

/* ── FULLSCREEN MOBILE PLAYER SHEET ── */
function openFullscreenPlayer() {
  if (fsSheet) fsSheet.classList.add("open");
}

function closeFullscreenPlayer() {
  if (fsSheet) fsSheet.classList.remove("open");
}

if (playerMobileTrigger) {
  playerMobileTrigger.addEventListener("click", (e) => {
    if (window.innerWidth <= 768 && !e.target.closest(".player-fav-btn")) {
      openFullscreenPlayer();
    }
  });
}

if (expandPlayerBtn) expandPlayerBtn.onclick = openFullscreenPlayer;
if (fsCloseBtn) fsCloseBtn.onclick = closeFullscreenPlayer;
if (fsQueueBtn) fsQueueBtn.onclick = () => { closeFullscreenPlayer(); openQueue(); };

if (playerHeartBtn) {
  playerHeartBtn.onclick = (e) => {
    e.stopPropagation();
    const state = player.getState();
    if (state.currentSong) toggleFavorite(state.currentSong);
  };
}

if (playerOfflineBtn) {
  playerOfflineBtn.onclick = (e) => {
    e.stopPropagation();
    const state = player.getState();
    if (state.currentSong) toggleOfflineStorage(state.currentSong);
  };
}

if (fsFavBtn) {
  fsFavBtn.onclick = () => {
    const state = player.getState();
    if (state.currentSong) toggleFavorite(state.currentSong);
  };
}

if (fsOfflineBtn) {
  fsOfflineBtn.onclick = () => {
    const state = player.getState();
    if (state.currentSong) toggleOfflineStorage(state.currentSong);
  };
}

if (fsPlayPause) fsPlayPause.onclick = () => player.togglePlay();
if (fsPrev) fsPrev.onclick = () => player.prev();
if (fsNext) fsNext.onclick = () => player.next();
if (fsShuffle) fsShuffle.onclick = () => player.toggleShuffle();
if (fsRepeat) fsRepeat.onclick = () => player.cycleRepeat();
if (fsSleepBtn) fsSleepBtn.onclick = () => { closeFullscreenPlayer(); sleepModal?.classList.add("open"); };

if (fsSeek) {
  fsSeek.addEventListener("input", () => {
    const dur = player.getState().duration;
    if (dur > 0) {
      const sec = (fsSeek.value / 100) * dur;
      if (fsCurrentTime) fsCurrentTime.textContent = formatTime(sec);
    }
  });
  fsSeek.addEventListener("change", () => {
    const dur = player.getState().duration;
    if (dur > 0) {
      const sec = (fsSeek.value / 100) * dur;
      player.seek(sec);
    }
  });
}

/* ── AUDIO FX & EQUALIZER MODAL ── */
function openFxModal() {
  if (audioFxModal) audioFxModal.classList.add("open");
}

function closeFxModal() {
  if (audioFxModal) audioFxModal.classList.remove("open");
}

if (audioFxBtn) audioFxBtn.onclick = openFxModal;
if (playerFxBtn) playerFxBtn.onclick = openFxModal;
if (heroFxBtn) heroFxBtn.onclick = openFxModal;
if (fsFxBtn) fsFxBtn.onclick = () => { closeFullscreenPlayer(); openFxModal(); };
if (closeFxBtn) closeFxBtn.onclick = closeFxModal;

const clearCacheBtn = document.getElementById("clear-cache-btn");
if (clearCacheBtn) {
  clearCacheBtn.addEventListener("click", async () => {
    player.showToast("🧹 Purging audio cache & refreshing...", 2500);
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) {
          await reg.unregister();
        }
      }
      player.showToast("✅ Audio cache cleared! Reloading fresh stream...", 1500);
      setTimeout(() => {
        location.href = location.pathname + "?refresh=" + Date.now();
      }, 800);
    } catch {
      location.reload();
    }
  });
}

if (audioFxModal) {
  audioFxModal.addEventListener("click", (e) => {
    if (e.target === audioFxModal) closeFxModal();
  });
}

if (crossfadeSlider && crossfadeVal) {
  const currentCrossfade = player.getState().crossfadeSeconds;
  crossfadeSlider.value = currentCrossfade;
  crossfadeVal.textContent = currentCrossfade === 0 ? "0s (Gapless)" : `${currentCrossfade}s`;

  crossfadeSlider.addEventListener("input", (e) => {
    let sec = parseInt(e.target.value, 10);
    if (sec > 0 && sec < 3) sec = 3; // Least active crossfade is 3 seconds (0s is off / gapless)
    crossfadeSlider.value = sec;
    crossfadeVal.textContent = sec === 0 ? "0s (Gapless)" : `${sec}s`;
    player.setCrossfade(sec);
  });
}

// EQ Presets & 5-Band Slider Elements
const eqActiveLabel = document.getElementById("eq-active-label");
const b60  = document.getElementById("eq-band-60");
const b250 = document.getElementById("eq-band-250");
const b1k  = document.getElementById("eq-band-1k");
const b3k  = document.getElementById("eq-band-3k");
const b10k = document.getElementById("eq-band-10k");

const v60  = document.getElementById("eq-val-60");
const v250 = document.getElementById("eq-val-250");
const v1k  = document.getElementById("eq-val-1k");
const v3k  = document.getElementById("eq-val-3k");
const v10k = document.getElementById("eq-val-10k");

function syncSlidersToPreset(preset) {
  let g60 = 0, g250 = 0, g1k = 0, g3k = 0, g10k = 0;
  if (preset === "bass")       { g60 = 11; g250 = 7; g1k = 0; g3k = 2; g10k = 3; }
  else if (preset === "vocal") { g60 = -3; g250 = -1; g1k = 8; g3k = 5; g10k = 2; }
  else if (preset === "acoustic") { g60 = 3; g250 = 4; g1k = 3; g3k = 4; g10k = 5; }
  else if (preset === "electronic") { g60 = 10; g250 = 6; g1k = -1; g3k = 4; g10k = 7; }
  else if (preset === "rock")  { g60 = 7; g250 = 5; g1k = 3; g3k = 6; g10k = 4; }

  if (b60)  b60.value  = g60;
  if (b250) b250.value = g250;
  if (b1k)  b1k.value  = g1k;
  if (b3k)  b3k.value  = g3k;
  if (b10k) b10k.value = g10k;

  if (v60)  v60.textContent  = `${g60 > 0 ? "+" : ""}${g60}dB`;
  if (v250) v250.textContent = `${g250 > 0 ? "+" : ""}${g250}dB`;
  if (v1k)  v1k.textContent  = `${g1k > 0 ? "+" : ""}${g1k}dB`;
  if (v3k)  v3k.textContent  = `${g3k > 0 ? "+" : ""}${g3k}dB`;
  if (v10k) v10k.textContent = `${g10k > 0 ? "+" : ""}${g10k}dB`;
}

document.querySelectorAll(".eq-preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".eq-preset-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const preset = btn.dataset.preset;
    if (eqActiveLabel) eqActiveLabel.textContent = btn.textContent;
    syncSlidersToPreset(preset);
    player.setEqualizerPreset(preset);
  });
});

[b60, b250, b1k, b3k, b10k].forEach((slider) => {
  if (!slider) return;
  slider.addEventListener("input", () => {
    document.querySelectorAll(".eq-preset-btn").forEach((b) => b.classList.remove("active"));
    if (eqActiveLabel) eqActiveLabel.textContent = "Custom Profile";

    const g60  = parseFloat(b60?.value || 0);
    const g250 = parseFloat(b250?.value || 0);
    const g1k  = parseFloat(b1k?.value || 0);
    const g3k  = parseFloat(b3k?.value || 0);
    const g10k = parseFloat(b10k?.value || 0);

    if (v60)  v60.textContent  = `${g60 > 0 ? "+" : ""}${g60}dB`;
    if (v250) v250.textContent = `${g250 > 0 ? "+" : ""}${g250}dB`;
    if (v1k)  v1k.textContent  = `${g1k > 0 ? "+" : ""}${g1k}dB`;
    if (v3k)  v3k.textContent  = `${g3k > 0 ? "+" : ""}${g3k}dB`;
    if (v10k) v10k.textContent = `${g10k > 0 ? "+" : ""}${g10k}dB`;

    player.setEqualizerCustom(g60, g250, g1k, g3k, g10k);
  });
});

// Speed Buttons
document.querySelectorAll(".speed-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".speed-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const spd = btn.dataset.speed;
    if (speedVal) speedVal.textContent = `${spd}x`;
    player.setPlaybackSpeed(spd);
  });
});

/* ── QUEUE DRAWER MANAGEMENT ── */
function updateQueueDrawer() {
  if (!queueListEl) return;
  const { playlist, currentIndex } = player.getState();

  if (queueCountEl) queueCountEl.textContent = `${playlist.length}`;

  if (!playlist.length) {
    queueListEl.innerHTML = `<div class="empty-state">Queue is empty. Select a song to start listening!</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  playlist.forEach((song, idx) => {
    const item = document.createElement("div");
    item.className = "queue-item";
    if (idx === currentIndex) item.classList.add("is-active");

    item.innerHTML = `
      <div class="queue-num">${idx === currentIndex ? '<span class="material-icons" style="font-size:1rem;color:var(--violet)">volume_up</span>' : idx + 1}</div>
      <img src="${escapeHtml(song.thumbnail || "assets/logo.png")}" alt="" class="queue-thumb" onerror="this.src='assets/logo.png'">
      <div class="queue-meta">
        <div class="queue-title">${escapeHtml(song.title)}</div>
        <div class="queue-artist">${escapeHtml(song.artist || "Unknown")}</div>
      </div>
    `;

    item.addEventListener("click", () => {
      player.playSong(song, playlist, idx);
      updateQueueDrawer();
    });

    frag.appendChild(item);
  });

  queueListEl.replaceChildren(frag);
}

function openQueue() {
  updateQueueDrawer();
  if (queueDrawer) queueDrawer.classList.add("open");
  if (queueBackdrop) queueBackdrop.classList.add("open");
}

function closeQueue() {
  if (queueDrawer) queueDrawer.classList.remove("open");
  if (queueBackdrop) queueBackdrop.classList.remove("open");
}

if (queueBtn) queueBtn.onclick = openQueue;
if (closeQueueBtn) closeQueueBtn.onclick = closeQueue;
if (queueBackdrop) queueBackdrop.onclick = closeQueue;

/* ── SLEEP TIMER MODAL ── */
if (sleepTimerBtn && sleepModal) {
  sleepTimerBtn.onclick = () => { sleepModal.classList.add("open"); };
}
if (closeSleepBtn && sleepModal) {
  closeSleepBtn.onclick = () => { sleepModal.classList.remove("open"); };
}
if (sleepModal) {
  sleepModal.addEventListener("click", (e) => {
    if (e.target === sleepModal) sleepModal.classList.remove("open");
    const optionBtn = e.target.closest("[data-timer-minutes]");
    if (optionBtn) {
      const mins = parseInt(optionBtn.dataset.timerMinutes, 10);
      player.setSleepTimer(mins);
      sleepModal.classList.remove("open");
    }
  });
}

/* ── GENRE PILL CLICKS ── */
genrePills.forEach((pill) => {
  pill.addEventListener("click", () => {
    selectGenre(pill.dataset.genre);
  });
});

/* ── SEARCH INPUT EVENTS ── */
function bindSearchInput(inputEl, clearBtnEl) {
  if (!inputEl) return;
  inputEl.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const val = e.target.value;
    if (searchInp && searchInp !== inputEl) searchInp.value = val;
    if (mobileSearchInp && mobileSearchInp !== inputEl) mobileSearchInp.value = val;
    searchTimer = setTimeout(() => searchSongs(val), 100);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(searchTimer);
      searchSongs(inputEl.value);
    }
    if (e.key === "Escape") {
      clearTimeout(searchTimer);
      inputEl.value = "";
      searchSongs("");
    }
  });

  if (clearBtnEl) {
    clearBtnEl.addEventListener("click", () => {
      inputEl.value = "";
      if (searchInp) searchInp.value = "";
      if (mobileSearchInp) mobileSearchInp.value = "";
      searchSongs("");
      inputEl.focus();
    });
  }
}

bindSearchInput(searchInp, searchClearBtn);
bindSearchInput(mobileSearchInp, mobileSearchClearBtn);

/* ── KEYBOARD SHORTCUTS ── */
document.addEventListener("keydown", (e) => {
  if (["input", "textarea", "select"].includes(document.activeElement?.tagName?.toLowerCase())) {
    return;
  }
  if (e.code === "Space") {
    e.preventDefault();
    player.togglePlay();
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    player.next();
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    player.prev();
  } else if (e.key.toLowerCase() === "m") {
    player.toggleMute();
  } else if (e.key.toLowerCase() === "s") {
    player.toggleShuffle();
  } else if (e.key.toLowerCase() === "r") {
    player.cycleRepeat();
  } else if (e.key.toLowerCase() === "f") {
    e.preventDefault();
    if (window.innerWidth >= 768) searchInp?.focus();
    else mobileSearchInp?.focus();
  }
});

/* ── PLAYER STATE SUBSCRIBER ── */
player.subscribe((state) => {
  // Update card playing overlays
  document.querySelectorAll(".song-card").forEach((card) => {
    const cardId = card.dataset.id;
    const isCurrent = state.currentSong && (state.currentSong.id || state.currentSong.link) === cardId;
    card.classList.toggle("is-playing", !!isCurrent);
    const playIcon = card.querySelector(".play-icon");
    if (playIcon) {
      playIcon.textContent = isCurrent && state.isPlaying ? "pause" : "play_arrow";
    }
  });

  // Sync Fullscreen Sheet state
  if (state.currentSong) {
    if (fsTitle) fsTitle.textContent = state.currentSong.title || "Untitled";
    if (fsArtist) fsArtist.textContent = state.currentSong.artist || "MusicsAura";
    if (fsArtwork) fsArtwork.src = state.currentSong.thumbnail || "assets/logo.png";
    if (fsGlow) fsGlow.style.backgroundImage = `url("${state.currentSong.thumbnail || "assets/logo.png"}")`;

    const isFav = isFavorite(state.currentSong);
    updateHeartIcons(state.currentSong, isFav);

    const isOff = isSongOffline(state.currentSong);
    const songId = state.currentSong.id || state.currentSong.link;
    const offState = isOff ? "downloaded" : (activeDownloads.has(songId) ? "downloading" : (queuedSongIds.has(songId) ? "queued" : "not-downloaded"));
    updateOfflineIcons(state.currentSong, offState);
  }

  if (fsPlayIcon) {
    if (state.isBuffering && state.isPlaying) {
      fsPlayIcon.textContent = "refresh";
      fsPlayIcon.parentElement?.classList.add("is-buffering");
    } else {
      fsPlayIcon.textContent = state.isPlaying ? "pause" : "play_arrow";
      fsPlayIcon.parentElement?.classList.remove("is-buffering");
    }
  }
  if (fsShuffle) fsShuffle.classList.toggle("active", state.isShuffle);
  if (fsRepeat) {
    fsRepeat.classList.toggle("active", state.repeatMode !== "off");
    const icon = fsRepeat.querySelector(".material-icons");
    if (icon) icon.textContent = state.repeatMode === "one" ? "repeat_one" : "repeat";
  }

  if (fsCurrentTime) fsCurrentTime.textContent = formatTime(state.currentTime);
  if (fsDurationTime) fsDurationTime.textContent = formatTime(state.duration);
  if (fsSeek && state.duration > 0) {
    fsSeek.value = (state.currentTime / state.duration) * 100;
  }

  // Update queue active indicator if drawer is open
  if (queueDrawer?.classList.contains("open")) {
    updateQueueDrawer();
  }
});

/* ── AUTH & USER PROFILE ── */
onAuthStateChanged(auth, (user) => {
  if (!user) {
    if (navAvatar) {
      navAvatar.src = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Ccircle cx='28' cy='28' r='28' fill='%238a5cf6'/%3E%3Ctext x='50%25' y='50%25' font-size='26' fill='white' text-anchor='middle' dy='.35em'%3E👤%3C/text%3E%3C/svg%3E`;
    }
    if (profileBtn) {
      profileBtn.onclick = () => { location.href = "auth.html"; };
    }
    return;
  }

  const initial = (user.displayName?.[0] || user.email?.[0] || "U").toUpperCase();
  const fallback = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Ccircle cx='28' cy='28' r='28' fill='%238a5cf6'/%3E%3Ctext x='50%25' y='50%25' font-size='24' fill='white' text-anchor='middle' dy='.35em'%3E${initial}%3C/text%3E%3C/svg%3E`;

  if (navAvatar) navAvatar.src = user.photoURL || fallback;
  if (profileBtn) {
    profileBtn.onclick = () => {
      location.href = isAdmin(user.email) ? "admin-dashboard.html" : "user-dashboard.html";
    };
  }
});

/* ── ONLINE / OFFLINE DETECTOR ── */
window.addEventListener("offline", () => {
  player.showToast("✈️ Offline Mode: Switched to In-App Downloads", 3500);
  selectGenre("offline");
});

window.addEventListener("online", () => {
  player.showToast("🌐 Connected to Internet", 2500);
  subscribeToFirestoreSongs();
});

/* ── INITIALIZATION ── */
(async () => {
  try {
    setupContainerClickHandler(grid);
    setupContainerClickHandler(searchGrid);
    updateDownloadBadge();

    grid.innerHTML = '<div class="state-msg"><div class="spinner"></div>Loading catalogue...</div>';

    // 1. If completely offline on launch, jump straight to In-App Downloads!
    if (!navigator.onLine) {
      selectGenre("offline");
      player.showToast("✈️ Offline Mode: Playing from In-App Storage", 3500);
      return;
    }

    // Load the deletion blacklist before JSON, Firestore, or local catalogues.
    await loadDeletedSongLinks();

    // 2. Load all 5 JSON catalogues immediately
    await Promise.allSettled([
      loadRawJson("hindi"),
      loadRawJson("punjabi"),
      loadRawJson("haryanvi"),
      loadRawJson("rap"),
      loadRawJson("bhojpuri")
    ]);
    await removeMissingJsonSongsFromFirestore();

    // 3. Connect Firestore sync and load cached/custom songs
    await subscribeToFirestoreSongs();

    // 4. Build initial catalogue & render immediately
    rebuildAllCatalogues();
    renderGenre(DEFAULT_GENRE);

  } catch (err) {
    console.warn("App init fallback:", err);
    renderGenre(DEFAULT_GENRE);
  }
})();
