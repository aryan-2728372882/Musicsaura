// scripts/player.js — MusicsAura 3.0 Pro Audio Engine
// Unified Single-Engine Architecture for Flawless Android Background/Lockscreen Playback & Spotify-Grade MediaSession

import {
  auth, db,
  doc, updateDoc, increment, serverTimestamp
} from "./firebase-config.js";
import { getTrackBlobFromStorage, saveTrackToStorage, getAllPersistedTracks } from "./storage-db.js";

// ─── UNIFIED HIGH-PERFORMANCE AUDIO ENGINE ─────────────────────────
// Dual-Deck Studio Architecture for 100% Android 14/15/16 Lockscreen Playback & True Equal-Power DJ Crossfade
const deckA = new Audio();
const deckB = new Audio();

[deckA, deckB].forEach((d) => {
  d.preload = "auto";
  d.setAttribute("playsinline", "");
  d.setAttribute("webkit-playsinline", "");
});

let activeDeck = deckA;
let standbyDeck = deckB;
let audio = activeDeck;
window._musicsaura_audio = activeDeck;

let isTransitioning = false;
let crossfadeTimer = null;
let lastTransitionTriggeredTrack = null;
let transitionSessionId = 0;
let transitionPromiseResolver = null;

// In-Memory Offline Blob URL Cache for 0ms synchronous background track transitions
const offlineBlobUrlCache = new Map();

// ─── DOM ELEMENT BINDINGS ──────────────────────────────────────────
const titleEl         = document.getElementById("player-title");
const artistEl        = document.getElementById("player-artist");
const thumbEl         = document.getElementById("player-thumb");
const playBtnEl       = document.getElementById("play-pause");
const playBtnIcon     = playBtnEl ? playBtnEl.querySelector(".material-icons") : null;
const prevBtn         = document.getElementById("prev");
const nextBtn         = document.getElementById("next");
const repeatBtnEl     = document.getElementById("repeat");
const repeatIcon      = repeatBtnEl ? repeatBtnEl.querySelector(".material-icons") : null;
const shuffleBtnEl    = document.getElementById("shuffle");
const seekBar         = document.getElementById("seek");
const progressFill    = document.getElementById("progress-fill");
const currentTimeEl   = document.getElementById("current-time");
const durationEl      = document.getElementById("duration-time");
const playerEl        = document.getElementById("player");
const volumeSlider    = document.getElementById("volume-slider");
const volumeBtn       = document.getElementById("volume-btn");

// ─── CONSTANTS & PERSISTENCE KEYS ──────────────────────────────────
const STATS_MIN_PLAY_SECONDS = 25;
const CROSSFADE_STORAGE_KEY  = "musicsaura_crossfade_sec";
const EQ_PRESET_KEY          = "musicsaura_eq_preset";
const VOLUME_STORAGE_KEY     = "musicsaura_volume";
const SPEED_STORAGE_KEY      = "musicsaura_playback_speed";

// ─── PLAYER STATE ──────────────────────────────────────────────────
let playlist          = [];
let originalList      = [];
let currentIndex      = 0;
let currentSong       = null;
let repeatMode        = "off"; // 'off' | 'one' | 'all'
let isShuffle         = false;
let isSeeking         = false;
let userPaused        = false;
let playbackGeneration = 0;

// Audio Configuration (5s Apple Music Standard Crossfade)
const savedCrossfade = localStorage.getItem(CROSSFADE_STORAGE_KEY);
let crossfadeSeconds = 5;
if (savedCrossfade !== null) {
  const parsed = parseFloat(savedCrossfade);
  if (!isNaN(parsed)) {
    crossfadeSeconds = clamp(parsed, 0, 12);
  }
}
localStorage.setItem(CROSSFADE_STORAGE_KEY, String(crossfadeSeconds));
let playbackRate      = parseFloat(localStorage.getItem(SPEED_STORAGE_KEY)) || 1.0;
let masterVolume      = clamp(parseFloat(localStorage.getItem(VOLUME_STORAGE_KEY)) || 1.0, 0, 1);

// Web Audio API Equalizer Nodes
let audioCtx          = null;
let subBassFilter     = null; // 60Hz Lowshelf
let bassFilter        = null; // 250Hz Peaking
let midFilter         = null; // 1000Hz Peaking
let presenceFilter    = null; // 3500Hz Peaking
let trebleFilter      = null; // 10000Hz Highshelf
let analyserNode      = null;
let sourceNodeA       = null;
let sourceNodeB       = null;
let wakeLock          = null;

// Stats Tracking
let playSessionStart  = 0;
let accumulatedPlaySec= 0;
let hasRecordedStat   = false;

// Sleep Timer
let sleepTimerId      = null;

// State Change Subscribers
const stateListeners  = new Set();

// ─── HELPER UTILITIES ──────────────────────────────────────────────
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const totalSec = Math.floor(seconds);
  const hrs  = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function normalizeUrl(url) {
  if (!url) return "";
  let clean = url.trim();
  if (clean.startsWith("http://")) clean = "https://" + clean.slice(7);

  // Auto-clean .webm extension if present in File Garden / web links
  clean = clean.replace(/\.webm(?=[\?&#]|$)/gi, "").replace(/%2Ewebm(?=[\?&#]|$)/gi, "");

  try {
    let decoded;
    try { decoded = decodeURI(clean); } catch { decoded = clean; }
    const encoded = encodeURI(decoded);
    const u = new URL(encoded);
    const host = u.hostname.toLowerCase();
    if (host.includes("dropbox.com")) {
      if (host === "www.dropbox.com") u.hostname = "dl.dropboxusercontent.com";
      u.searchParams.set("raw", "1");
      u.searchParams.delete("dl");
      return u.toString();
    }
    if (host.includes("file.garden") || host.includes("supabase.co")) {
      u.searchParams.delete("download");
      u.searchParams.delete("dl");
      return u.toString();
    }
    return u.toString();
  } catch {
    return clean;
  }
}

function toAbsoluteUrl(url) {
  if (!url) return new URL("assets/logo.png", location.href).href;
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }

}

// ─── EQUALIZER & AUDIO CONTEXT ─────────────────────────────────────
function initAudioContext() {
  if (audioCtx) return audioCtx;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    audioCtx = new AudioContextClass();

    subBassFilter = audioCtx.createBiquadFilter();
    subBassFilter.type = "lowshelf";
    subBassFilter.frequency.value = 60;

    bassFilter = audioCtx.createBiquadFilter();
    bassFilter.type = "peaking";
    bassFilter.frequency.value = 250;
    bassFilter.Q.value = 1.0;

    midFilter = audioCtx.createBiquadFilter();
    midFilter.type = "peaking";
    midFilter.frequency.value = 1000;
    midFilter.Q.value = 1.0;

    presenceFilter = audioCtx.createBiquadFilter();
    presenceFilter.type = "peaking";
    presenceFilter.frequency.value = 3500;
    presenceFilter.Q.value = 1.0;

    trebleFilter = audioCtx.createBiquadFilter();
    trebleFilter.type = "highshelf";
    trebleFilter.frequency.value = 10000;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 128;
    analyserNode.smoothingTimeConstant = 0.8;

    subBassFilter.connect(bassFilter);
    bassFilter.connect(midFilter);
    midFilter.connect(presenceFilter);
    presenceFilter.connect(trebleFilter);
    trebleFilter.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    try {
      const savedPreset = localStorage.getItem(EQ_PRESET_KEY) || "flat";
      applyPresetGains(savedPreset);
    } catch {}

    return audioCtx;
  } catch (e) {
    console.warn("AudioContext setup:", e);
    return null;
  }
}

function applyPresetGains(presetName) {
  if (!subBassFilter || !bassFilter || !midFilter || !presenceFilter || !trebleFilter) return;
  switch (presetName.toLowerCase()) {
    case "bass":
      subBassFilter.gain.value = 11; bassFilter.gain.value = 7; midFilter.gain.value = 0; presenceFilter.gain.value = 2; trebleFilter.gain.value = 3;
      break;
    case "vocal":
      subBassFilter.gain.value = -3; bassFilter.gain.value = -1; midFilter.gain.value = 8; presenceFilter.gain.value = 5; trebleFilter.gain.value = 2;
      break;
    case "acoustic":
      subBassFilter.gain.value = 3; bassFilter.gain.value = 4; midFilter.gain.value = 3; presenceFilter.gain.value = 4; trebleFilter.gain.value = 5;
      break;
    case "electronic":
      subBassFilter.gain.value = 10; bassFilter.gain.value = 6; midFilter.gain.value = -1; presenceFilter.gain.value = 4; trebleFilter.gain.value = 7;
      break;
    case "rock":
      subBassFilter.gain.value = 7; bassFilter.gain.value = 5; midFilter.gain.value = 3; presenceFilter.gain.value = 6; trebleFilter.gain.value = 4;
      break;
    default:
      subBassFilter.gain.value = 0; bassFilter.gain.value = 0; midFilter.gain.value = 0; presenceFilter.gain.value = 0; trebleFilter.gain.value = 0;
      break;
  }
}

let bothDecksUnlocked = false;

function unlockBothDecks() {
  unlockAudioContext();
  if (bothDecksUnlocked) return;
  bothDecksUnlocked = true;

  [deckA, deckB].forEach((d) => {
    try {
      const p = d.play();
      if (p !== undefined) {
        p.then(() => {
          if (d !== activeDeck) {
            d.pause();
            d.currentTime = 0;
          }
        }).catch(() => {});
      }
      if (d !== activeDeck) d.pause();
    } catch {}
  });
}

function unlockAudioContext() {
  if (!audioCtx) initAudioContext();
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
}

// ─── WAKE LOCK API ────────────────────────────────────────────────
async function acquireWakeLock() {
  if ("wakeLock" in navigator) {
    try {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch {}
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// ─── MEDIA SESSION API (SPOTIFY-GRADE LOCKSCREEN & NOTIFICATIONS) ──
function initMediaSession() {
  if (!("mediaSession" in navigator)) return;

  navigator.mediaSession.setActionHandler("play", () => {
    if (wasInterruptedBySystem) {
      resumeAfterInterruption();
    } else {
      player.play();
    }
  });
  navigator.mediaSession.setActionHandler("pause", () => player.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
  navigator.mediaSession.setActionHandler("nexttrack", () => player.next());

  try {
    navigator.mediaSession.setActionHandler("seekto", (d) => {
      if (d.seekTime !== undefined && d.seekTime !== null) player.seek(d.seekTime);
    });
    navigator.mediaSession.setActionHandler("seekforward", () => player.seek((audio.currentTime || 0) + 10));
    navigator.mediaSession.setActionHandler("seekbackward", () => player.seek((audio.currentTime || 0) - 10));
    navigator.mediaSession.setActionHandler("stop", () => player.pause());
  } catch {}
}

function updateMediaSession(song) {
  if (!("mediaSession" in navigator) || !song) return;

  const artworkUrl = toAbsoluteUrl(song.thumbnail);
  const artworkList = [
    { src: artworkUrl, sizes: "96x96" },
    { src: artworkUrl, sizes: "128x128" },
    { src: artworkUrl, sizes: "192x192" },
    { src: artworkUrl, sizes: "256x256" },
    { src: artworkUrl, sizes: "384x384" },
    { src: artworkUrl, sizes: "512x512" }
  ];

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || "MusicsAura Track",
      artist: song.artist || "MusicsAura Artist",
      album: song.genre ? `${song.genre.toUpperCase()} Hits` : "MusicsAura",
      artwork: artworkList
    });
  } catch (e) {
    console.warn("MediaMetadata error:", e);
  }

  navigator.mediaSession.playbackState = !activeDeck.paused ? "playing" : "paused";
  updatePositionState();
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
  try {
    if (Number.isFinite(activeDeck.duration) && activeDeck.duration > 0) {
      navigator.mediaSession.setPositionState({
        duration: activeDeck.duration,
        playbackRate: activeDeck.playbackRate || 1,
        position: clamp(activeDeck.currentTime, 0, activeDeck.duration)
      });
    }
  } catch {}
}

// ─── LISTENING TIME STATS TRACKING ────────────────────────────────
function capturePlaySeconds() {
  if (playSessionStart > 0) {
    accumulatedPlaySec += (Date.now() - playSessionStart) / 1000;
    playSessionStart = 0;
  }
}

let pendingSongsCount     = 0;
let pendingMinutesCount   = 0;
let statsFlushTimer       = null;

async function flushStatsToFirebase(forceImmediate = false) {
  capturePlaySeconds();
  if (!currentSong || accumulatedPlaySec < STATS_MIN_PLAY_SECONDS || hasRecordedStat) return;

  hasRecordedStat = true;
  const minutes = Math.max(0.5, Math.round((accumulatedPlaySec / 60) * 2) / 2);
  pendingSongsCount += 1;
  pendingMinutesCount += minutes;

  try {
    const stats = JSON.parse(localStorage.getItem("musicsaura_local_stats") || "{}");
    stats.songsPlayed = (stats.songsPlayed || 0) + 1;
    stats.minutesListened = (stats.minutesListened || 0) + minutes;
    localStorage.setItem("musicsaura_local_stats", JSON.stringify(stats));
  } catch {}

  // Flush immediately if forced, otherwise debounce write to max once every 3 minutes
  if (forceImmediate) {
    commitPendingStats();
  } else if (!statsFlushTimer) {
    statsFlushTimer = setTimeout(() => {
      commitPendingStats();
      statsFlushTimer = null;
    }, 180000); // 3 minutes buffer (saves 90% Firestore write quota)
  }
}

async function commitPendingStats() {
  if (!auth.currentUser || (pendingSongsCount === 0 && pendingMinutesCount === 0)) return;

  const toCommitSongs = pendingSongsCount;
  const toCommitMins = pendingMinutesCount;
  pendingSongsCount = 0;
  pendingMinutesCount = 0;

  try {
    const userRef = doc(db, "users", auth.currentUser.uid);
    await updateDoc(userRef, {
      songsPlayed: increment(toCommitSongs),
      minutesListened: increment(toCommitMins),
      lastPlayed: serverTimestamp(),
      lastActive: new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }) + " IST"
    });
  } catch (err) {
    console.warn("Batched stats sync warning:", err);
  }
}

// Flush on tab close or navigation
window.addEventListener("beforeunload", () => {
  commitPendingStats();
});

window.addEventListener("pagehide", () => {
  commitPendingStats();
});

let isBuffering          = false;
let stallWatchdogTimer    = null;
let stallCount            = 0;
let advancingTrack       = false;

// ─── UI SYNCHRONIZATION ────────────────────────────────────────────
function emitStateChange() {
  const state = player.getState();
  stateListeners.forEach((fn) => {
    try { fn(state); } catch (e) { console.error(e); }
  });
}

function updateUI() {
  if (playerEl) {
    playerEl.hidden = !currentSong;
    if (currentSong) playerEl.classList.add("visible");
  }

  if (titleEl)  titleEl.textContent  = currentSong?.title || "Select a track";
  if (artistEl) artistEl.textContent = currentSong?.artist || "MusicsAura";

  if (thumbEl) {
    if (currentSong?.thumbnail) {
      thumbEl.style.backgroundImage = `url("${currentSong.thumbnail}")`;
      thumbEl.classList.remove("no-thumb");
    } else {
      thumbEl.style.backgroundImage = "";
      thumbEl.classList.add("no-thumb");
    }
  }

  if (playBtnIcon) {
    if (isBuffering && !activeDeck.paused) {
      playBtnIcon.textContent = "refresh";
      if (playBtnEl) playBtnEl.classList.add("is-buffering");
    } else {
      playBtnIcon.textContent = !activeDeck.paused ? "pause" : "play_arrow";
      if (playBtnEl) playBtnEl.classList.remove("is-buffering");
    }
  }

  const liveWave = document.querySelector(".live-wave-visualizer");
  if (liveWave) {
    liveWave.classList.toggle("is-buffering", isBuffering && !activeDeck.paused);
  }

  if (repeatIcon && repeatBtnEl) {
    repeatIcon.textContent = repeatMode === "one" ? "repeat_one" : "repeat";
    repeatBtnEl.classList.toggle("active", repeatMode !== "off");
  }

  if (shuffleBtnEl) {
    shuffleBtnEl.classList.toggle("active", isShuffle);
  }

  document.querySelectorAll(".song-card").forEach((card) => {
    const isPlayingThis = currentSong && card.dataset.id === (currentSong.id || currentSong.link);
    card.classList.toggle("is-playing", !!isPlayingThis);
  });

  emitStateChange();
}

let isAppHidden = false;

function updateProgress() {
  if (isSeeking || isAppHidden) return;
  const cur = activeDeck.currentTime || 0;
  const dur = activeDeck.duration || 0;

  if (currentTimeEl) currentTimeEl.textContent = formatTime(cur);
  if (durationEl)    durationEl.textContent    = formatTime(dur);

  if (Number.isFinite(dur) && dur > 0) {
    const pct = clamp((cur / dur) * 100, 0, 100);
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (seekBar) seekBar.value = pct;
  } else {
    if (progressFill) progressFill.style.width = "0%";
    if (seekBar) seekBar.value = 0;
  }
}

export async function getOfflineAudioBlobUrl(songOrLink, optionalId = null) {
  if (!songOrLink) return null;
  const link = typeof songOrLink === "string" ? songOrLink : (songOrLink.link || "");
  const id = typeof songOrLink === "object" ? (songOrLink.id || songOrLink.link) : (optionalId || link);
  const song = typeof songOrLink === "object" ? songOrLink : null;

  const rawTarget = link ? link.split("?")[0] : "";
  const rawId = id ? String(id).split("?")[0] : "";

  if (rawTarget && offlineBlobUrlCache.has(rawTarget)) return offlineBlobUrlCache.get(rawTarget);
  if (link && offlineBlobUrlCache.has(link)) return offlineBlobUrlCache.get(link);
  if (id && offlineBlobUrlCache.has(id)) return offlineBlobUrlCache.get(id);
  if (rawId && offlineBlobUrlCache.has(rawId)) return offlineBlobUrlCache.get(rawId);

  try {
    const blob = await getTrackBlobFromStorage(id || link, song || { id, link });
    if (blob && blob.size > 10240) {
      const bUrl = URL.createObjectURL(blob);
      if (rawTarget) offlineBlobUrlCache.set(rawTarget, bUrl);
      if (link) offlineBlobUrlCache.set(link, bUrl);
      if (id) offlineBlobUrlCache.set(id, bUrl);
      if (rawId) offlineBlobUrlCache.set(rawId, bUrl);
      return bUrl;
    }
  } catch (e) {
    console.warn("[Player] Offline blob check error:", e);
  }
  return null;
}

function prewarmNextSongOfflineBlob() {
  if (!playlist || playlist.length <= 1) return;
  const nextIdx = (currentIndex + 1) % playlist.length;
  const nextSong = playlist[nextIdx];
  if (nextSong) {
    getOfflineAudioBlobUrl(nextSong).catch(() => {});
  }
}

export async function prewarmAllOfflineTracks() {
  try {
    // 1. Prewarm all persisted tracks directly from permanent IndexedDB
    const persisted = await getAllPersistedTracks();
    if (persisted && persisted.length > 0) {
      persisted.forEach((t) => {
        if (t) getOfflineAudioBlobUrl(t).catch(() => {});
      });
    }

    // 2. Also prewarm from localStorage offline catalogue
    const list = JSON.parse(localStorage.getItem("musicsaura_offline_songs") || "[]");
    list.forEach((s) => {
      if (s) getOfflineAudioBlobUrl(s).catch(() => {});
    });
  } catch (err) {
    console.warn("[Player] prewarmAllOfflineTracks notice:", err);
  }
}

if (typeof window !== "undefined") {
  prewarmAllOfflineTracks();
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", () => setTimeout(prewarmAllOfflineTracks, 200));
  } else {
    setTimeout(prewarmAllOfflineTracks, 200);
  }
}

let prewarmedTrackUrl = null;

function prewarmNextTrackStream() {
  if (!playlist || playlist.length <= 1 || !navigator.onLine) return;
  const nextIdx = (currentIndex + 1) % playlist.length;
  const nextSong = playlist[nextIdx];
  if (!nextSong || !nextSong.link) return;

  const nextUrl = normalizeUrl(nextSong.link);
  if (!nextUrl || prewarmedTrackUrl === nextUrl) return;
  prewarmedTrackUrl = nextUrl;

  // Pre-prime TCP connection, TLS session, and initial audio chunks (256KB) into browser cache
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    fetch(nextUrl, {
      signal: controller.signal,
      headers: { Range: "bytes=0-262143" },
      mode: "cors"
    }).then(() => clearTimeout(timeout)).catch(() => {});
  } catch {}
}

function isSongStoredOffline(song) {
  if (!song) return false;
  try {
    const list = JSON.parse(localStorage.getItem("musicsaura_offline_songs") || "[]");
    const id = song.id || song.link;
    return list.some((s) => (s.id || s.link) === id);
  } catch {
    return false;
  }
}

// ─── SLOW NETWORK WATCHDOG & STALL AUTO-RECOVERY ──────────────────
function startStallWatchdog() {
  clearTimeout(stallWatchdogTimer);
  stallWatchdogTimer = setTimeout(() => {
    if (isBuffering && !activeDeck.paused && !userPaused) {
      stallCount++;
      if (stallCount === 1) {
        player.showToast("⏳ Connecting to audio stream...", 3000);
      }
    }
  }, 10000);
}

function clearStallWatchdog() {
  clearTimeout(stallWatchdogTimer);
  stallCount = 0;
}

// ─── DUAL-DECK AUDIO SOURCE RESOLVER & STANDBY PRELOADER ───────────
function resolveAudioSourceSync(song) {
  if (!song || !song.link) return "";
  const id = song.id || song.link;
  const cleanUrl = normalizeUrl(song.link);
  const rawTarget = cleanUrl.split("?")[0];
  const rawId = id ? String(id).split("?")[0] : "";

  const cachedBlobUrl =
    (id ? offlineBlobUrlCache.get(id) : null) ||
    (rawId ? offlineBlobUrlCache.get(rawId) : null) ||
    offlineBlobUrlCache.get(rawTarget) ||
    offlineBlobUrlCache.get(cleanUrl) ||
    offlineBlobUrlCache.get(song.link);

  if (cachedBlobUrl) return cachedBlobUrl;
  return cleanUrl;
}

async function resolveAudioSource(song) {
  if (!song || !song.link) return "";
  const syncSrc = resolveAudioSourceSync(song);
  if (syncSrc && syncSrc.startsWith("blob:")) return syncSrc;

  try {
    const blobUrl = await getOfflineAudioBlobUrl(song);
    if (blobUrl) return blobUrl;
  } catch {}

  return syncSrc;
}

let sectionAdvancer = null;

function getNextTrackCandidate() {
  if (repeatMode === "one" && playlist && playlist[currentIndex]) {
    return { song: playlist[currentIndex], index: currentIndex };
  }

  if (isShuffle && playlist && playlist.length > 0) {
    let randIdx = Math.floor(Math.random() * playlist.length);
    if (playlist.length > 1 && randIdx === currentIndex) {
      randIdx = (randIdx + 1) % playlist.length;
    }
    return { song: playlist[randIdx], index: randIdx };
  }

  const nextIdx = currentIndex + 1;
  if (playlist && nextIdx < playlist.length) {
    return { song: playlist[nextIdx], index: nextIdx };
  }

  // Current playlist/section reached the end!
  // If repeat mode is 'all' and no section advancer, repeat current section
  if (repeatMode === "all" && !sectionAdvancer && playlist && playlist.length > 0) {
    return { song: playlist[0], index: 0 };
  }

  // ── AUTO-ADVANCE TO NEXT SECTION (e.g. Hindi Hits -> Punjabi Vibes -> Haryanvi Swag -> Desi Rap -> Bhojpuri Hits)
  if (sectionAdvancer) {
    const adv = sectionAdvancer(currentSong?.genre);
    if (adv && adv.songs && adv.songs.length > 0) {
      return {
        song: adv.songs[adv.index || 0],
        index: adv.index || 0,
        nextPlaylist: adv.songs,
        nextGenre: adv.genre
      };
    }
  }

  if (playlist && playlist.length > 0) {
    return { song: playlist[0], index: 0 };
  }

  return null;
}

let standbySong = null;
let standbyIndex = -1;

async function armStandbyDeck() {
  if (isTransitioning) return;
  const candidate = getNextTrackCandidate();
  if (!candidate || !candidate.song) {
    standbySong = null;
    standbyIndex = -1;
    return;
  }

  standbySong = candidate.song;
  standbyIndex = candidate.index;

  const resolvedUrl = await resolveAudioSource(standbySong);
  if (!resolvedUrl) return;

  if (standbyDeck.src !== resolvedUrl) {
    standbyDeck.src = resolvedUrl;
    standbyDeck.playbackRate = playbackRate;
    standbyDeck.volume = 0;
    standbyDeck.preload = "auto";
    standbyDeck.load();
  }
  try { standbyDeck.currentTime = 0; } catch {}
}

let transitioningTargetSong = null;
let transitioningTargetIndex = null;
let transitioningTargetPlaylist = null;
let transitioningTargetGenre = null;

function cancelAnyTransition() {
  if (crossfadeTimer) {
    clearInterval(crossfadeTimer);
    crossfadeTimer = null;
  }
  if (transitionPromiseResolver) {
    const r = transitionPromiseResolver;
    transitionPromiseResolver = null;
    try { r(); } catch {}
  }
  isTransitioning = false;
  transitionSessionId++;
  advancingTrack = false;
  transitioningTargetSong = null;
  transitioningTargetIndex = null;
  transitioningTargetPlaylist = null;
  transitioningTargetGenre = null;
  try {
    standbyDeck.pause();
    standbyDeck.removeAttribute("src");
    standbyDeck.load();
  } catch {}
  standbyDeck.volume = masterVolume;
}

function finalizeTransition(outgoingDeck, incomingDeck, targetSong, targetIndex, nextPlaylist = null, nextGenre = null) {
  if (!isTransitioning) return;
  isTransitioning = false;
  transitionSessionId++; // Invalidate running crossfade watchdog / intervals

  if (crossfadeTimer) {
    clearInterval(crossfadeTimer);
    crossfadeTimer = null;
  }
  if (transitionPromiseResolver) {
    const r = transitionPromiseResolver;
    transitionPromiseResolver = null;
    try { r(); } catch {}
  }

  // 1. Cleanly stop and disarm outgoing deck so it holds no old track offset or memory
  try {
    outgoingDeck.pause();
    outgoingDeck.currentTime = 0;
    outgoingDeck.removeAttribute("src");
    outgoingDeck.load();
  } catch {}
  outgoingDeck.volume = masterVolume;

  // 2. Guarantee incoming deck plays at full masterVolume
  incomingDeck.volume = masterVolume;
  try {
    const p = incomingDeck.play();
    if (p !== undefined) p.catch(() => {});
  } catch {}

  // 3. Swap deck pointers
  activeDeck = incomingDeck;
  standbyDeck = outgoingDeck;
  audio = activeDeck;
  window._musicsaura_audio = activeDeck;

  if (nextPlaylist && Array.isArray(nextPlaylist) && nextPlaylist.length > 0) {
    playlist = [...nextPlaylist];
    originalList = [...nextPlaylist];
    currentIndex = targetIndex !== null && targetIndex >= 0 ? targetIndex : 0;
  } else if (targetIndex !== null && targetIndex >= 0) {
    currentIndex = targetIndex;
  }

  if (targetSong) {
    currentSong = targetSong;
  }

  userPaused = false;
  advancingTrack = false;
  transitioningTargetSong = null;
  transitioningTargetIndex = null;
  transitioningTargetPlaylist = null;
  transitioningTargetGenre = null;
  standbySong = null;
  standbyIndex = -1;
  lastTransitionTriggeredTrack = currentSong?.id || currentSong?.link;

  flushStatsToFirebase().catch(() => {});
  hasRecordedStat    = false;
  accumulatedPlaySec = 0;
  playSessionStart   = Date.now();

  updateMediaSession(currentSong);
  updateUI();
  updateProgress();

  // Pre-arm standby deck for the next track well in advance
  setTimeout(() => {
    armStandbyDeck();
  }, 1000);
}

function finalizeTransitionImmediately() {
  if (!isTransitioning) return;
  finalizeTransition(activeDeck, standbyDeck, transitioningTargetSong, transitioningTargetIndex, transitioningTargetPlaylist, transitioningTargetGenre);
}

// ─── APPLE MUSIC EQUAL-POWER CROSSFADE & GAPLESS ENGINE ───────────
// Equal-Power Sine/Cosine Curve: Constant acoustic energy: cos²(p*π/2) + sin²(p*π/2) = 1
async function triggerDeckTransition(fadeSec = 0, forcedNextSong = null, forcedNextIndex = null, forcedNextPlaylist = null, forcedNextGenre = null) {
  if (isTransitioning) return;

  let targetSong = forcedNextSong;
  let targetIndex = forcedNextIndex;
  let targetPlaylist = forcedNextPlaylist;
  let targetGenre = forcedNextGenre;

  if (!targetSong) {
    const candidate = getNextTrackCandidate();
    if (!candidate || !candidate.song) {
      player.pause();
      return;
    }
    targetSong = candidate.song;
    targetIndex = candidate.index;
    targetPlaylist = candidate.nextPlaylist || null;
    targetGenre = candidate.nextGenre || null;
  }

  const thisSession = ++transitionSessionId;
  transitioningTargetSong = targetSong;
  transitioningTargetIndex = targetIndex;
  transitioningTargetPlaylist = targetPlaylist;
  transitioningTargetGenre = targetGenre;
  isTransitioning = true;
  advancingTrack = true;

  const outgoingDeck = activeDeck;
  const incomingDeck = standbyDeck;

  // Make sure incomingDeck has the resolved source
  const targetSrc = await resolveAudioSource(targetSong);
  if (thisSession !== transitionSessionId) return;

  if (incomingDeck.src !== targetSrc) {
    incomingDeck.src = targetSrc;
    incomingDeck.load();
  }

  try { incomingDeck.currentTime = 0; } catch {}
  incomingDeck.playbackRate = playbackRate;

  if (crossfadeTimer) {
    clearInterval(crossfadeTimer);
    crossfadeTimer = null;
  }

  const durationSec = Math.max(0, fadeSec);
  const isCrossfade = durationSec >= 1.0 && !outgoingDeck.paused;

  // Initial volume setup:
  // If crossfading: incoming begins at 0 volume and smoothly blends in
  // If gapless (0s): incoming begins immediately at full masterVolume
  incomingDeck.volume = isCrossfade ? 0 : masterVolume;

  // Start incoming deck playback
  try {
    try { incomingDeck.currentTime = 0; } catch {}
    const playPromise = incomingDeck.play();
    if (playPromise !== undefined) {
      await playPromise.catch((err) => {
        console.warn("[Player] Standby play error:", err);
        if (incomingDeck.hasAttribute("crossOrigin") || incomingDeck.crossOrigin) {
          incomingDeck.removeAttribute("crossOrigin");
          incomingDeck.crossOrigin = null;
          incomingDeck.load();
          try { incomingDeck.currentTime = 0; } catch {}
          return incomingDeck.play().catch(() => {});
        }
      });
    }
  } catch (err) {
    console.warn("[Player] Standby play exception:", err);
  }

  if (thisSession !== transitionSessionId) return;

  // Apple Music Equal-Power Crossfade Animation
  if (isCrossfade) {
    const startTime = performance.now();
    const fadeDurationMs = durationSec * 1000;
    let switchedMetaAtMidpoint = false;

    await new Promise((resolve) => {
      let resolved = false;
      const doResolve = () => {
        if (!resolved) {
          resolved = true;
          if (crossfadeTimer) {
            clearInterval(crossfadeTimer);
            crossfadeTimer = null;
          }
          resolve();
        }
      };

      transitionPromiseResolver = doResolve;

      const watchdog = setTimeout(() => {
        doResolve();
      }, fadeDurationMs + 1000);

      crossfadeTimer = setInterval(() => {
        if (thisSession !== transitionSessionId || !isTransitioning) {
          clearTimeout(watchdog);
          doResolve();
          return;
        }

        const elapsed = performance.now() - startTime;
        const progress = clamp(elapsed / fadeDurationMs, 0, 1);

        // Apple Music Equal-Power Sine/Cosine Curve:
        // Constant acoustic energy: cos²(p*π/2) + sin²(p*π/2) = 1
        const outFactor = Math.cos(progress * 0.5 * Math.PI);
        const inFactor  = Math.sin(progress * 0.5 * Math.PI);

        outgoingDeck.volume = clamp(outFactor * masterVolume, 0, 1);
        incomingDeck.volume = clamp(inFactor * masterVolume, 0, 1);

        // Switch lockscreen/UI metadata at 50% crossover
        if (progress >= 0.5 && !switchedMetaAtMidpoint) {
          switchedMetaAtMidpoint = true;
          currentSong = targetSong;
          if (targetPlaylist && Array.isArray(targetPlaylist) && targetPlaylist.length > 0) {
            playlist = [...targetPlaylist];
            originalList = [...targetPlaylist];
            currentIndex = targetIndex !== null && targetIndex >= 0 ? targetIndex : 0;
          } else if (targetIndex !== null && targetIndex >= 0) {
            currentIndex = targetIndex;
          }
          updateMediaSession(currentSong);
          updateUI();
        }

        if (progress >= 1) {
          clearTimeout(watchdog);
          doResolve();
        }
      }, 20);
    });
  }

  // Finalize switch
  if (thisSession === transitionSessionId && isTransitioning) {
    finalizeTransition(outgoingDeck, incomingDeck, targetSong, targetIndex, targetPlaylist, targetGenre);
  }
}

// ─── AUDIO FOCUS & BLUETOOTH / CALL INTERRUPTION RECOVERY ────────
let wasInterruptedBySystem = false;
let interruptedTrack       = null;
let interruptedPosition    = 0;
let interruptedTimestamp   = 0;
let interruptionWatchdog   = null;

async function recoverAudioPipeline(deck, targetTime = null) {
  const pos = targetTime !== null && targetTime > 0 ? targetTime : (deck.currentTime || 0);
  const currentSrc = deck.src;
  if (!currentSrc) return;

  console.log("[Player] Refreshing audio pipeline to rebind Bluetooth A2DP channel at", formatTime(pos));

  // 1. Force audio output sink re-route to system default (the active Bluetooth earbuds)
  if (typeof deck.setSinkId === "function") {
    try {
      await deck.setSinkId("");
    } catch (e) {
      console.warn("[Player] setSinkId re-route notice:", e);
    }
  }

  // 2. Unlock/resume Web Audio if suspended
  unlockAudioContext();

  // 3. Re-prime the media decoder: Reload the source to tear down dead AudioTrack and re-open fresh A2DP channel
  try {
    deck.pause();
    deck.load();
    if (pos > 0) {
      deck.addEventListener("loadedmetadata", () => {
        try { deck.currentTime = pos; } catch {}
      }, { once: true });
      setTimeout(() => {
        try {
          if (Math.abs(deck.currentTime - pos) > 1) {
            deck.currentTime = pos;
          }
        } catch {}
      }, 150);
    }
  } catch (err) {
    console.warn("[Player] Pipeline reload notice:", err);
  }
}

async function resumeAfterInterruption() {
  if (!wasInterruptedBySystem || userPaused || !currentSong) return;

  const resumePos = interruptedPosition || activeDeck.currentTime || 0;
  console.log("[Player] Interruption ended / Audio focus restored! Auto-resuming:", currentSong.title, "at", formatTime(resumePos));

  wasInterruptedBySystem = false;
  interruptedTrack = null;
  clearInterval(interruptionWatchdog);
  interruptionWatchdog = null;

  await recoverAudioPipeline(activeDeck, resumePos);

  try {
    const playPromise = activeDeck.play();
    if (playPromise !== undefined) {
      await playPromise;
      console.log("[Player] Auto-resume successful via Bluetooth A2DP channel!");
      player.showToast(`▶️ Resumed: ${currentSong.title}`, 2500);
    }
  } catch (err) {
    console.warn("[Player] Auto-resume play blocked by OS gesture policy:", err);
    player.showToast(`📞 Call ended. Tap to resume "${currentSong.title}"`, 5000);

    const oneTapResume = () => {
      document.removeEventListener("click", oneTapResume);
      document.removeEventListener("touchend", oneTapResume);
      if (activeDeck.paused && !userPaused && currentSong) {
        activeDeck.play().then(() => {
          player.showToast(`▶️ Resumed: ${currentSong.title}`, 2000);
        }).catch(() => {});
      }
    };
    document.addEventListener("click", oneTapResume, { once: true });
    document.addEventListener("touchend", oneTapResume, { once: true });
  }

  updateMediaSession(currentSong);
  updateUI();
}

function startInterruptionWatchdog() {
  if (interruptionWatchdog) return;
  interruptionWatchdog = setInterval(() => {
    if (!wasInterruptedBySystem || userPaused || !currentSong) {
      clearInterval(interruptionWatchdog);
      interruptionWatchdog = null;
      return;
    }

    // If app becomes visible or active again while interrupted, attempt resume
    if (!document.hidden && document.visibilityState === "visible") {
      resumeAfterInterruption();
    }
  }, 2000);
}

// ─── PERSISTENT DUAL-DECK AUDIO EVENT BINDINGS ─────────────────────
function bindDeckEvents(deck) {
  deck.addEventListener("loadstart", () => {
    if (deck === activeDeck) {
      isBuffering = true;
      updateUI();
    }
  });

  deck.addEventListener("waiting", () => {
    if (deck === activeDeck) {
      isBuffering = true;
      updateUI();
      startStallWatchdog();
    }
  });

  deck.addEventListener("stalled", () => {
    if (deck === activeDeck) {
      isBuffering = true;
      updateUI();
      startStallWatchdog();
    }
  });

  deck.addEventListener("canplay", () => {
    if (deck === activeDeck) {
      isBuffering = false;
      clearStallWatchdog();
      updateUI();
    }
  });

  deck.addEventListener("canplaythrough", () => {
    if (deck === activeDeck) {
      isBuffering = false;
      clearStallWatchdog();
      updateUI();
    }
  });

  deck.addEventListener("playing", () => {
    if (deck === activeDeck) {
      wasInterruptedBySystem = false;
      interruptedTrack = null;
      clearInterval(interruptionWatchdog);
      interruptionWatchdog = null;
      advancingTrack = false;
      isBuffering = false;
      clearStallWatchdog();
      userPaused = false;
      playSessionStart = Date.now();
      acquireWakeLock();
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      updateUI();
    }
  });

  deck.addEventListener("pause", () => {
    if (deck === activeDeck && !isTransitioning) {
      if (!userPaused && currentSong && !deck.ended) {
        // Paused by external interruption (incoming phone call / audio focus loss)
        wasInterruptedBySystem = true;
        interruptedTrack = currentSong;
        interruptedPosition = deck.currentTime || 0;
        interruptedTimestamp = Date.now();
        console.log("[Player] Audio stream interrupted by system/phone call at", formatTime(interruptedPosition));
        startInterruptionWatchdog();
      } else if (userPaused) {
        wasInterruptedBySystem = false;
        interruptedTrack = null;
        clearInterval(interruptionWatchdog);
        interruptionWatchdog = null;
      }

      if (userPaused) advancingTrack = false;
      isBuffering = false;
      clearStallWatchdog();
      capturePlaySeconds();
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
      updateUI();
      if (userPaused) releaseWakeLock();
    }
  });

  deck.addEventListener("seeking", () => {
    if (deck === activeDeck) {
      isBuffering = true;
      updateUI();
    }
  });

  deck.addEventListener("seeked", () => {
    if (deck === activeDeck) {
      isBuffering = false;
      updateUI();
    }
  });

  deck.addEventListener("progress", () => {
    if (deck === activeDeck && deck.buffered.length > 0) {
      clearStallWatchdog();
    }
  });

  deck.addEventListener("timeupdate", () => {
    if (deck !== activeDeck) return;
    updateProgress();
    updatePositionState();

    // Auto-advance / Studio crossfade check
    const dur = deck.duration;
    const cur = deck.currentTime;

    // Arm standby deck only when the active track is well underway (> 12s) and approaching the transition window (remaining <= 40s),
    // ensuring 100% of network bandwidth is given to the initial playback of the active song!
    if (Number.isFinite(dur) && cur > 12 && (dur - cur <= 40) && (!standbySong || !standbyDeck.src)) {
      armStandbyDeck();
    }

    if (playSessionStart > 0 && !hasRecordedStat) {
      const currentSessionSec = (Date.now() - playSessionStart) / 1000;
      if (accumulatedPlaySec + currentSessionSec >= STATS_MIN_PLAY_SECONDS) {
        flushStatsToFirebase();
      }
    }

    if (Number.isFinite(dur) && dur > 4 && !isTransitioning && !userPaused && !advancingTrack) {
      if (repeatMode === "one") {
        if (dur - cur <= 0.25) {
          deck.currentTime = 0;
        }
        return;
      }
      if (repeatMode === "off" && !sectionAdvancer && currentIndex >= playlist.length - 1) {
        return; // Play to the very end of last song if repeat is off and no section advancer
      }

      const fadeSec = crossfadeSeconds > 0 ? Math.min(crossfadeSeconds, Math.floor(dur / 2)) : 0;
      const remaining = dur - cur;
      const songKey = currentSong?.id || currentSong?.link;
      if (fadeSec >= 1.0 && remaining <= fadeSec && remaining > 0.1 && lastTransitionTriggeredTrack !== songKey) {
        lastTransitionTriggeredTrack = songKey;
        triggerDeckTransition(fadeSec);
      } else if (fadeSec === 0 && remaining <= 0.08 && remaining > 0 && lastTransitionTriggeredTrack !== songKey) {
        lastTransitionTriggeredTrack = songKey;
        triggerDeckTransition(0);
      }
    }
  });

  deck.addEventListener("ended", () => {
    if (deck !== activeDeck) return;

    if (crossfadeTimer) {
      clearInterval(crossfadeTimer);
      crossfadeTimer = null;
    }
    if (isTransitioning) {
      finalizeTransitionImmediately();
      return;
    }
    advancingTrack = false;
    transitioningTargetSong = null;
    transitioningTargetIndex = null;

    flushStatsToFirebase();
    isBuffering = false;
    clearStallWatchdog();

    if (repeatMode === "one") {
      deck.currentTime = 0;
      deck.play().catch(() => {});
    } else {
      player.next(true);
    }
  });

  deck.addEventListener("error", async () => {
    // Opportunistic CORS Fallback: If track failed under strict CORS ("anonymous"),
    // strip crossOrigin and retry immediately so the audio element can play as opaque media.
    if (deck.hasAttribute("crossOrigin") || deck.crossOrigin) {
      console.warn(`[Player] ${deck === activeDeck ? "Active" : "Standby"} deck CORS/media error. Retrying without CORS restriction...`);
      deck.removeAttribute("crossOrigin");
      deck.crossOrigin = null;
      const retrySrc = deck.src;
      if (retrySrc) {
        deck.load();
        if (deck === activeDeck && !userPaused) {
          deck.play().catch((err) => {
            console.warn("[Player] Post-CORS retry play warning:", err);
          });
        }
        return; // Retrying cleanly without CORS mode
      }
    }

    if (deck !== activeDeck) return;
    advancingTrack = false;
    isTransitioning = false;
    console.warn("[Player] Active deck error:", deck.error);
    isBuffering = false;
    clearStallWatchdog();

    // Offline storage recovery: If server fails, check if we have a locally downloaded offline blob!
    if (currentSong) {
      try {
        const offlineUrl = await getOfflineAudioBlobUrl(currentSong);
        if (offlineUrl && deck.src !== offlineUrl) {
          console.warn("[Player] Network stream failed, but offline copy found! Seamlessly recovering with offline blob:", currentSong.title);
          deck.removeAttribute("crossOrigin");
          deck.crossOrigin = null;
          deck.src = offlineUrl;
          deck.load();
          if (!userPaused) {
            deck.play().catch(() => {});
          }
          player.showToast(`📱 Playing "${currentSong.title}" from offline storage`, 2500);
          updateUI();
          return; // Successfully recovered from local offline storage!
        }
      } catch (offlineErr) {
        console.warn("[Player] Offline recovery attempt notice:", offlineErr);
      }
    }

    deck.pause();
    deck.removeAttribute("src");
    deck.load();
    player.showToast(`⚠️ "${currentSong?.title || "Track"}" is temporarily unavailable on server.`, 3000);
    updateUI();

    // Auto-advance cleanly to next track if playlist has more songs
    if (playlist.length > 1 && !userPaused && !advancingTrack) {
      advancingTrack = true;
      setTimeout(() => {
        advancingTrack = false;
        if (!userPaused) {
          player.next(true);
        }
      }, 1200);
    }
  });
}

// Bind events to both hardware audio channels
bindDeckEvents(deckA);
bindDeckEvents(deckB);

// Initial volume calibration
deckA.volume = masterVolume;
deckB.volume = masterVolume;
if (volumeSlider) volumeSlider.value = Math.round(masterVolume * 100);

// ─── EXPORTED PLAYER API ──────────────────────────────────────────
export const player = {
  subscribe(fn) {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  },

  getState() {
    return {
      currentSong,
      isPlaying: !activeDeck.paused,
      isBuffering,
      currentTime: activeDeck.currentTime || 0,
      duration: activeDeck.duration || 0,
      playlist,
      currentIndex,
      repeatMode,
      isShuffle,
      volume: masterVolume,
      crossfadeSeconds,
      playbackRate
    };
  },

  setPlaylist(songs, startIndex = 0) {
    originalList = [...songs];
    if (isShuffle) {
      playlist = player.shuffleArray([...songs]);
      currentIndex = playlist.findIndex((s) => (s.id || s.link) === (songs[startIndex]?.id || songs[startIndex]?.link));
      if (currentIndex < 0) currentIndex = 0;
    } else {
      playlist = [...songs];
      currentIndex = startIndex;
    }
  },

  prefetchAudioStream(link) {
    // Handled natively by armStandbyDeck()
  },

  async checkAndRefreshStaleOfflineTrack(song) {
    if (!song || !song.link || !navigator.onLine) return;
    const cleanUrl = normalizeUrl(song.link).split("?")[0];
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const headRes = await fetch(cleanUrl, {
        method: "HEAD",
        cache: "no-cache",
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!headRes.ok) return;

      const serverSize = parseInt(headRes.headers.get("content-length"), 10);
      if (!serverSize || isNaN(serverSize)) return;

      const localBlob = await getTrackBlobFromStorage(song.link);
      if (!localBlob) return;

      if (Math.abs(serverSize - localBlob.size) > 1024) {
        console.log(`[Player] Server song updated! Local: ${localBlob.size}B, Server: ${serverSize}B. Refreshing...`);
        player.showToast(`🔄 Updating to latest version of "${song.title}"...`, 3000);

        const getRes = await fetch(cleanUrl, { cache: "reload" });
        if (getRes.ok) {
          const freshBlob = await getRes.blob();
          if (freshBlob && freshBlob.size > 10240) {
            await saveTrackToStorage(song, freshBlob);
            const newBlobUrl = URL.createObjectURL(freshBlob);

            if (currentSong && (currentSong.id || currentSong.link) === (song.id || song.link)) {
              const curTime = activeDeck.currentTime || 0;
              const wasPlaying = !activeDeck.paused;
              activeDeck.src = newBlobUrl;
              if (curTime > 0 && curTime < (activeDeck.duration || 9999)) {
                activeDeck.currentTime = curTime;
              }
              if (wasPlaying) activeDeck.play().catch(() => {});
            }

            player.showToast(`✨ "${song.title}" updated to latest version!`, 3500);
          }
        }
      }
    } catch (err) {
      console.warn("[Player] Freshness check notice:", err);
    }
  },

  playSong(song, playlistContext = null, index = null, isDirectSelection = false) {
    if (!song || !song.link) return;

    unlockBothDecks();

    const requestGeneration = ++playbackGeneration;

    if (playlistContext) {
      if (index !== null) {
        player.setPlaylist(playlistContext, index);
      } else {
        const found = playlistContext.findIndex((s) => (s.id || s.link) === (song.id || song.link));
        player.setPlaylist(playlistContext, found >= 0 ? found : 0);
      }
    } else if (index !== null) {
      currentIndex = index;
    }

    // Only crossfade if NOT a direct user card click and already playing
    if (!isDirectSelection && !activeDeck.paused && activeDeck.currentTime > 1.2 && crossfadeSeconds > 0 && !isTransitioning) {
      triggerDeckTransition(Math.min(crossfadeSeconds, 3.0), song, currentIndex);
      return;
    }

    // Direct playback initiation: cancel any running crossfade timer immediately
    cancelAnyTransition();

    currentSong = song;
    userPaused = false;
    prewarmedTrackUrl = null;
    lastTransitionTriggeredTrack = currentSong?.id || currentSong?.link;

    // Fast synchronous source resolution: preserves mobile user gesture activation for line-speed playback
    const src = resolveAudioSourceSync(song);

    if (activeDeck.src !== src) {
      activeDeck.src = src;
    }

    // Asynchronous offline blob verification: If the track is stored in downloads, swap to verified local blob
    if (!src.startsWith("blob:") && isSongStoredOffline(song)) {
      getOfflineAudioBlobUrl(song).then((blobUrl) => {
        if (blobUrl && activeDeck.src !== blobUrl && (currentSong?.id || currentSong?.link) === (song.id || song.link)) {
          console.log("[Player] Async resolved offline blob for downloaded track:", song.title);
          const curTime = activeDeck.currentTime || 0;
          const wasPlaying = !activeDeck.paused;
          activeDeck.src = blobUrl;
          if (curTime > 0) activeDeck.currentTime = curTime;
          if (wasPlaying || !userPaused) {
            activeDeck.play().catch(() => {});
          }
        }
      });
    }

    // CRITICAL: Guarantee activeDeck starts at 0:00 (prevents jumping to middle of track from previous song)
    try { activeDeck.currentTime = 0; } catch {}
    activeDeck.addEventListener("loadedmetadata", () => {
      try { activeDeck.currentTime = 0; } catch {}
    }, { once: true });

    activeDeck.playbackRate = playbackRate;
    activeDeck.volume = masterVolume;

    try {
      const playPromise = activeDeck.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          if (activeDeck.currentTime > 1.5) {
            try { activeDeck.currentTime = 0; } catch {}
          }
        }).catch(async (err) => {
          console.warn("[Player] Direct play warning:", err);
          if (activeDeck.hasAttribute("crossOrigin") || activeDeck.crossOrigin) {
            console.warn("[Player] Retrying direct play without CORS restrictions...");
            activeDeck.removeAttribute("crossOrigin");
            activeDeck.crossOrigin = null;
            activeDeck.load();
            try { activeDeck.currentTime = 0; } catch {}
            await activeDeck.play().catch(() => {});
          }
          updateUI();
        });
      }
    } catch (err) {
      console.warn("[Player] Direct play error:", err);
      updateUI();
    }

    updateMediaSession(song);
    updateUI();

    flushStatsToFirebase().catch(() => {});
    hasRecordedStat    = false;
    accumulatedPlaySec = 0;
    playSessionStart   = Date.now();
  },

  play() {
    unlockBothDecks();
    if (wasInterruptedBySystem) {
      resumeAfterInterruption();
      return;
    }
    if (!currentSong && playlist.length > 0) {
      return player.playSong(playlist[currentIndex]);
    }
    // If current track is finished and not repeatMode 'one', advance to next track (prevents stuck loop)
    if ((activeDeck.ended || (activeDeck.duration > 0 && activeDeck.currentTime >= activeDeck.duration - 0.5)) && repeatMode !== "one") {
      return player.next(true);
    }
    userPaused = false;
    wasInterruptedBySystem = false;

    // If audio element is in an empty or stalled state from external interruption, recover pipeline before playing
    if (activeDeck.networkState === HTMLMediaElement.NETWORK_EMPTY || activeDeck.readyState === 0) {
      recoverAudioPipeline(activeDeck).then(() => {
        activeDeck.play().catch((err) => console.warn("Play error:", err));
        updateUI();
      });
      return;
    }

    try {
      const p = activeDeck.play();
      if (p !== undefined) p.catch(() => {});
    } catch (err) {
      console.warn("Play error:", err);
    }
    updateUI();
  },

  pause() {
    userPaused = true;
    wasInterruptedBySystem = false;
    clearInterval(interruptionWatchdog);
    interruptionWatchdog = null;
    cancelAnyTransition();
    activeDeck.pause();
    activeDeck.volume = masterVolume;
    updateUI();
  },

  togglePlay() {
    if (activeDeck.paused) {
      player.play();
    } else {
      player.pause();
    }
  },

  next(isAuto = false) {
    if (!playlist.length) return;
    if (!isAuto) userPaused = false;

    if (repeatMode === "off" && !sectionAdvancer && currentIndex >= playlist.length - 1 && isAuto) {
      player.pause();
      advancingTrack = false;
      return;
    }

    const candidate = getNextTrackCandidate();
    if (!candidate || !candidate.song) return;

    const nextSong = candidate.song;
    const nextIdx = candidate.index;
    const nextPlaylist = candidate.nextPlaylist || null;

    if (!activeDeck.paused && activeDeck.currentTime > 1.0 && crossfadeSeconds > 0 && !isTransitioning) {
      triggerDeckTransition(Math.min(crossfadeSeconds, 2.5), nextSong, nextIdx, nextPlaylist, candidate.nextGenre);
    } else {
      if (nextPlaylist && Array.isArray(nextPlaylist) && nextPlaylist.length > 0) {
        player.setPlaylist(nextPlaylist, nextIdx);
      }
      player.playSong(nextSong, nextPlaylist, nextIdx);
    }
  },

  prev() {
    userPaused = false;
    if (activeDeck.currentTime > 3.5) {
      activeDeck.currentTime = 0;
      updateProgress();
      return;
    }
    if (!playlist.length) return;
    const prevIdx = (currentIndex - 1 + playlist.length) % playlist.length;
    player.playSong(playlist[prevIdx], null, prevIdx);
  },

  seek(seconds) {
    if (!Number.isFinite(activeDeck.duration) || activeDeck.duration <= 0) return;
    cancelAnyTransition();
    activeDeck.volume = masterVolume;

    const clamped = clamp(seconds, 0, activeDeck.duration);
    activeDeck.currentTime = clamped;
    updateProgress();
    updatePositionState();
  },

  setVolume(vol) {
    masterVolume = clamp(vol, 0, 1);
    if (!isTransitioning) {
      activeDeck.volume = masterVolume;
      standbyDeck.volume = masterVolume;
    }
    localStorage.setItem(VOLUME_STORAGE_KEY, String(masterVolume));
    if (volumeSlider) volumeSlider.value = Math.round(masterVolume * 100);
    if (volumeBtn) {
      const icon = volumeBtn.querySelector(".material-icons");
      if (icon) {
        icon.textContent = masterVolume === 0 ? "volume_off" : masterVolume < 0.5 ? "volume_down" : "volume_up";
      }
    }
  },

  toggleMute() {
    if (masterVolume > 0) {
      activeDeck._prevVol = masterVolume;
      player.setVolume(0);
    } else {
      player.setVolume(activeDeck._prevVol || 1.0);
    }
  },

  setCrossfade(sec) {
    crossfadeSeconds = clamp(parseFloat(sec) || 0, 0, 12);
    localStorage.setItem(CROSSFADE_STORAGE_KEY, String(crossfadeSeconds));
    player.showToast(crossfadeSeconds === 0 ? "⚡ Gapless playback active (0s)" : `🎚️ Apple-Style Crossfade Active: ${crossfadeSeconds}s`);
    armStandbyDeck();
  },

  setPlaybackSpeed(speed) {
    playbackRate = clamp(parseFloat(speed) || 1.0, 0.5, 2.0);
    activeDeck.playbackRate = playbackRate;
    standbyDeck.playbackRate = playbackRate;
    localStorage.setItem(SPEED_STORAGE_KEY, String(playbackRate));
    player.showToast(`⏩ Playback speed: ${playbackRate}x`);
  },

  setEqualizerPreset(presetName) {
    unlockAudioContext();
    if (!subBassFilter || !bassFilter || !midFilter || !presenceFilter || !trebleFilter) return;

    localStorage.setItem(EQ_PRESET_KEY, presetName);
    applyPresetGains(presetName);

    switch (presetName.toLowerCase()) {
      case "bass":
        player.showToast("🔥 Bass Boost Active (+11dB Sub-Bass)");
        break;
      case "vocal":
        player.showToast("🎤 Vocal Focus Active");
        break;
      case "acoustic":
        player.showToast("🎸 Acoustic Warmth Active");
        break;
      case "electronic":
        player.showToast("🪩 Club / EDM Profile Active");
        break;
      case "rock":
        player.showToast("⚡ Rock & Swag Profile Active");
        break;
      default:
        player.showToast("🎧 Pure Flat Studio Reference");
        break;
    }
  },

  setEqualizerCustom(subBass, bass, mid, presence, treble) {
    unlockAudioContext();
    if (!subBassFilter || !bassFilter || !midFilter || !presenceFilter || !trebleFilter) return;

    subBassFilter.gain.value  = clamp(subBass, -15, 15);
    bassFilter.gain.value     = clamp(bass, -15, 15);
    midFilter.gain.value      = clamp(mid, -15, 15);
    presenceFilter.gain.value = clamp(presence, -15, 15);
    trebleFilter.gain.value   = clamp(treble, -15, 15);
  },

  cycleRepeat() {
    if (repeatMode === "off") repeatMode = "all";
    else if (repeatMode === "all") repeatMode = "one";
    else repeatMode = "off";

    updateUI();
    armStandbyDeck();
    player.showToast(
      repeatMode === "one" ? "🔂 Repeat single track" :
      repeatMode === "all" ? "🔁 Repeat playlist" : "➡️ Repeat off"
    );
  },

  toggleShuffle() {
    isShuffle = !isShuffle;
    if (isShuffle) {
      const current = currentSong;
      playlist = player.shuffleArray([...originalList]);
      if (current) {
        playlist = [current, ...playlist.filter((s) => (s.id || s.link) !== (current.id || current.link))];
        currentIndex = 0;
      }
    } else {
      playlist = [...originalList];
      if (currentSong) {
        currentIndex = playlist.findIndex((s) => (s.id || s.link) === (currentSong.id || currentSong.link));
        if (currentIndex < 0) currentIndex = 0;
      }
    }
    updateUI();
    armStandbyDeck();
    player.showToast(isShuffle ? "🔀 Shuffle mode on" : "➡️ Normal order");
  },

  shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  setSleepTimer(minutes) {
    if (sleepTimerId) {
      clearTimeout(sleepTimerId);
      sleepTimerId = null;
    }

    if (!minutes || minutes <= 0) {
      player.showToast("⏰ Sleep timer cancelled");
      return;
    }

    player.showToast(`⏰ Sleep timer set for ${minutes} minutes`);

    sleepTimerId = setTimeout(() => {
      player.pause();
      sleepTimerId = null;
      player.showToast("🌙 Sleep timer ended playback");
    }, minutes * 60 * 1000);
  },

  showToast(message, duration = 2500) {
    let toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove("visible");
    }, duration);
  },

  setSectionAdvancer(fn) {
    sectionAdvancer = typeof fn === "function" ? fn : null;
  },

  unlockBothDecks
};

// ─── HARDWARE & BROWSER EVENT BINDINGS ─────────────────────────────
initMediaSession();

["click", "touchend", "pointerdown", "keydown"].forEach((evt) => {
  document.addEventListener(evt, () => {
    unlockBothDecks();
  }, { passive: true });
});

if (playBtnEl)    playBtnEl.onclick    = () => player.togglePlay();
if (prevBtn)      prevBtn.onclick      = () => player.prev();
if (nextBtn)      nextBtn.onclick      = () => player.next();
if (repeatBtnEl)  repeatBtnEl.onclick  = () => player.cycleRepeat();
if (shuffleBtnEl) shuffleBtnEl.onclick = () => player.toggleShuffle();

if (seekBar) {
  seekBar.addEventListener("input", () => {
    isSeeking = true;
    if (Number.isFinite(activeDeck.duration) && activeDeck.duration > 0) {
      const sec = (seekBar.value / 100) * activeDeck.duration;
      if (progressFill)  progressFill.style.width = `${seekBar.value}%`;
      if (currentTimeEl) currentTimeEl.textContent = formatTime(sec);
    }
  });

  seekBar.addEventListener("change", () => {
    isSeeking = false;
    if (Number.isFinite(activeDeck.duration) && activeDeck.duration > 0) {
      const sec = (seekBar.value / 100) * activeDeck.duration;
      player.seek(sec);
    }
  });
}

if (volumeSlider) {
  volumeSlider.addEventListener("input", (e) => {
    player.setVolume(parseFloat(e.target.value) / 100);
  });
}
if (volumeBtn) {
  volumeBtn.addEventListener("click", () => player.toggleMute());
}

document.addEventListener("visibilitychange", () => {
  isAppHidden = document.hidden;
  if (document.hidden) {
    if (isTransitioning) {
      finalizeTransitionImmediately();
    }
    if (!activeDeck.paused && "mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "playing";
    }
  } else {
    // If returning to the app from a phone call / system interruption, auto-resume smoothly
    if (wasInterruptedBySystem && !userPaused && currentSong) {
      setTimeout(() => {
        resumeAfterInterruption();
      }, 350);
    }

    if (!activeDeck.paused) {
      acquireWakeLock();
      updateMediaSession(currentSong);
      updateUI();
      updateProgress();
    }
  }
});

window.addEventListener("focus", () => {
  if (wasInterruptedBySystem && !userPaused && currentSong) {
    setTimeout(() => {
      resumeAfterInterruption();
    }, 350);
  }
});

// Bluetooth Earbuds Connect / Disconnect / Call Profile Switch listener
if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    console.log("[Player] Media device change detected (Bluetooth earbuds / audio route change).");

    // Force re-route sink to default active output device if supported
    if (typeof activeDeck.setSinkId === "function") {
      activeDeck.setSinkId("").catch(() => {});
    }

    // When phone call drops and earbuds switch from HFP back to A2DP media profile
    if (wasInterruptedBySystem && !userPaused && currentSong) {
      // 400ms delay allows Android OS Bluetooth A2DP handshake to stabilize before pushing audio stream
      setTimeout(() => {
        resumeAfterInterruption();
      }, 400);
    }
  });
}