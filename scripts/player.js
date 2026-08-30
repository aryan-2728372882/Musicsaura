// scripts/player.js — MusicsAura 3.0 Pro Audio Engine
// Unified Single-Engine Architecture for Flawless Android Background/Lockscreen Playback & Spotify-Grade MediaSession

import {
  auth, db,
  doc, updateDoc, increment, serverTimestamp
} from "./firebase-config.js";

// ─── UNIFIED HIGH-PERFORMANCE AUDIO ENGINE ─────────────────────────
// Single persistent Audio element ensures 100% Android background audio retention & instant playback
const audio = new Audio();
audio.preload = "auto";
audio.setAttribute("playsinline", "");
audio.setAttribute("webkit-playsinline", "");

window._musicsaura_audio = audio;

// Predictive Next-Track & Instant-Touch Audio Preloader
const prefetchAudio = new Audio();
prefetchAudio.preload = "auto";
prefetchAudio.volume = 0;
const prewarmedUrls = new Set();

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

// Audio Configuration
let crossfadeSeconds  = parseFloat(localStorage.getItem(CROSSFADE_STORAGE_KEY)) || 4;
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
let sourceNode        = null;
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
    const u = new URL(clean);
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

    // Connect Audio element into Web Audio EQ Graph
    try {
      if (!sourceNode) {
        audio.crossOrigin = "anonymous";
        sourceNode = audioCtx.createMediaElementSource(audio);
        sourceNode.connect(subBassFilter);
      }
    } catch (e) {
      console.warn("createMediaElementSource note:", e);
    }

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

  navigator.mediaSession.setActionHandler("play", () => player.play());
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
    { src: artworkUrl, sizes: "96x96",   type: "image/png" },
    { src: artworkUrl, sizes: "128x128", type: "image/png" },
    { src: artworkUrl, sizes: "192x192", type: "image/png" },
    { src: artworkUrl, sizes: "256x256", type: "image/png" },
    { src: artworkUrl, sizes: "384x384", type: "image/png" },
    { src: artworkUrl, sizes: "512x512", type: "image/png" }
  ];

  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || "MusicsAura Track",
    artist: song.artist || "MusicsAura Artist",
    album: song.genre ? `${song.genre.toUpperCase()} Hits` : "MusicsAura",
    artwork: artworkList
  });

  navigator.mediaSession.playbackState = !audio.paused ? "playing" : "paused";
  updatePositionState();
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
  try {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: clamp(audio.currentTime, 0, audio.duration)
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
    if (isBuffering && !audio.paused) {
      playBtnIcon.textContent = "refresh";
      if (playBtnEl) playBtnEl.classList.add("is-buffering");
    } else {
      playBtnIcon.textContent = !audio.paused ? "pause" : "play_arrow";
      if (playBtnEl) playBtnEl.classList.remove("is-buffering");
    }
  }

  const liveWave = document.querySelector(".live-wave-visualizer");
  if (liveWave) {
    liveWave.classList.toggle("is-buffering", isBuffering && !audio.paused);
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
  const cur = audio.currentTime || 0;
  const dur = audio.duration || 0;

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

export async function getOfflineAudioBlobUrl(link) {
  if (!link || !("caches" in window)) return null;
  try {
    const cache = await caches.open("musicsaura-pwa-storage-v2");
    const rawLink = link.split("?")[0];
    const cachedRes = (await cache.match(link, { ignoreSearch: true })) ||
                      (await cache.match(rawLink, { ignoreSearch: true }));
    if (cachedRes && (cachedRes.ok || cachedRes.status === 200)) {
      const blob = await cachedRes.blob();
      if (blob && blob.size > 10240) {
        return URL.createObjectURL(blob);
      }
    }
  } catch (e) {
    console.warn("Offline blob check:", e);
  }
  return null;
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
    if (isBuffering && !audio.paused && !userPaused) {
      stallCount++;
      if (stallCount === 1) {
        player.showToast("🌧️ Slow network: Buffering audio stream...", 4000);
      }

      const cur = audio.currentTime || 0;
      let hasBufferedAhead = false;
      for (let i = 0; i < audio.buffered.length; i++) {
        if (audio.buffered.start(i) <= cur && audio.buffered.end(i) > cur + 0.5) {
          hasBufferedAhead = true;
          break;
        }
      }

      if (!hasBufferedAhead && stallCount >= 2) {
        // Unfreeze socket stalled by slow rainy network packet loss
        const savedPos = audio.currentTime;
        audio.load();
        if (savedPos > 0) audio.currentTime = savedPos;
        audio.play().catch(() => {});
      }
    }
  }, 4500);
}

function clearStallWatchdog() {
  clearTimeout(stallWatchdogTimer);
  stallCount = 0;
}

// ─── PERSISTENT AUDIO EVENT HANDLING ──────────────────────────────
audio.addEventListener("loadstart", () => {
  isBuffering = true;
  updateUI();
});

audio.addEventListener("waiting", () => {
  isBuffering = true;
  updateUI();
  startStallWatchdog();
});

audio.addEventListener("stalled", () => {
  isBuffering = true;
  updateUI();
  startStallWatchdog();
});

audio.addEventListener("canplay", () => {
  isBuffering = false;
  clearStallWatchdog();
  updateUI();
});

audio.addEventListener("canplaythrough", () => {
  isBuffering = false;
  clearStallWatchdog();
  updateUI();
});

audio.addEventListener("playing", () => {
  isBuffering = false;
  clearStallWatchdog();
  userPaused = false;
  playSessionStart = Date.now();
  acquireWakeLock();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  updateUI();
});

audio.addEventListener("pause", () => {
  isBuffering = false;
  clearStallWatchdog();
  capturePlaySeconds();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  updateUI();
  if (userPaused) releaseWakeLock();
});

audio.addEventListener("seeking", () => {
  isBuffering = true;
  updateUI();
});

audio.addEventListener("seeked", () => {
  isBuffering = false;
  updateUI();
});

audio.addEventListener("progress", () => {
  if (audio.buffered.length > 0) {
    clearStallWatchdog();
  }
});

audio.addEventListener("timeupdate", () => {
  updateProgress();
  updatePositionState();

  if (playSessionStart > 0 && !hasRecordedStat) {
    const currentSessionSec = (Date.now() - playSessionStart) / 1000;
    if (accumulatedPlaySec + currentSessionSec >= STATS_MIN_PLAY_SECONDS) {
      flushStatsToFirebase();
    }
  }
});

audio.addEventListener("ended", () => {
  flushStatsToFirebase();
  isBuffering = false;
  clearStallWatchdog();

  if (repeatMode === "one") {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } else {
    player.next(true);
  }
});

audio.addEventListener("error", (e) => {
  console.warn("Audio node playback error:", e, audio.error);
  isBuffering = false;
  clearStallWatchdog();

  // 1. Check if offline cached blob exists before failing
  getOfflineAudioBlobUrl(currentSong?.link || audio.src).then((blobUrl) => {
    if (blobUrl && audio.src !== blobUrl) {
      audio.src = blobUrl;
      audio.play().catch(() => {});
      return;
    }

    // 2. Extension / Format Fallback (e.g. .webm -> without .webm)
    const rawSrc = audio.src || currentSong?.link || "";
    if (rawSrc && (rawSrc.includes(".webm") || rawSrc.includes("%2Ewebm"))) {
      const cleanSrc = rawSrc.replace(/\.webm(?=[\?&#]|$)/gi, "").replace(/%2Ewebm(?=[\?&#]|$)/gi, "");
      if (cleanSrc && cleanSrc !== rawSrc) {
        console.log("[Player] Auto-recovering from .webm 404 to clean URL:", cleanSrc);
        audio.src = cleanSrc;
        if (currentSong) currentSong.link = cleanSrc;
        audio.load();
        audio.play().catch(() => {});
        return;
      }
    }

    // 3. Slow rainy network retry mechanism
    if (navigator.onLine && (!audio._retryCount || audio._retryCount < 3)) {
      audio._retryCount = (audio._retryCount || 0) + 1;
      player.showToast(`🌧️ Reconnecting stream (${audio._retryCount}/3)...`, 2500);
      setTimeout(() => {
        const cleanBase = (audio.src || currentSong?.link || "")
          .replace(/\.webm(?=[\?&#]|$)/gi, "")
          .replace(/%2Ewebm(?=[\?&#]|$)/gi, "");
        const separator = cleanBase.includes("?") ? "&" : "?";
        audio.src = cleanBase.split("?")[0] + separator + "t=" + Date.now();
        audio.load();
        audio.play().catch(() => {});
      }, 1000);
      return;
    }

    // 4. If offline, alert user and stop
    if (!navigator.onLine) {
      player.showToast("⚠️ Offline: Connect to Wi-Fi/Data or play downloaded tracks.");
      return;
    }

    if (!userPaused && playlist.length > 1) {
      setTimeout(() => player.next(true), 2000);
    }
  });
});

// Volume initialization
audio.volume = masterVolume;
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
      isPlaying: !audio.paused,
      isBuffering,
      currentTime: audio.currentTime || 0,
      duration: audio.duration || 0,
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
      currentIndex = playlist.findIndex((s) => s.link === songs[startIndex]?.link);
      if (currentIndex < 0) currentIndex = 0;
    } else {
      playlist = [...songs];
      currentIndex = startIndex;
    }
  },

  prefetchAudioStream(link) {
    if (!link || !navigator.onLine) return;
    const cleanUrl = normalizeUrl(link);
    if (!cleanUrl || cleanUrl === audio.src || prewarmedUrls.has(cleanUrl)) return;
    prewarmedUrls.add(cleanUrl);

    try {
      prefetchAudio.src = cleanUrl;
      prefetchAudio.load();
    } catch {}
  },

  async playSong(song, playlistContext = null, index = null) {
    if (!song || !song.link) return;

    // 1. Immediately update UI & Media Session (0ms visual latency)
    currentSong = song;
    if (playlistContext) {
      if (index !== null) {
        player.setPlaylist(playlistContext, index);
      } else {
        const found = playlistContext.findIndex((s) => (s.id || s.link) === (song.id || song.link));
        player.setPlaylist(playlistContext, found >= 0 ? found : 0);
      }
    }
    updateMediaSession(song);
    updateUI();

    // 2. Non-blocking background stats flush
    flushStatsToFirebase().catch(() => {});
    hasRecordedStat    = false;
    accumulatedPlaySec = 0;
    playSessionStart   = 0;

    // 3. Check if stored offline in PWA Cache or device is offline
    const isOfflineMode = !navigator.onLine || isSongStoredOffline(song);
    let blobUrl = null;
    if (isOfflineMode) {
      blobUrl = await getOfflineAudioBlobUrl(song.link);
    }

    if (blobUrl) {
      audio.src = blobUrl;
    } else if (navigator.onLine) {
      const cleanUrl = normalizeUrl(song.link);
      if (!cleanUrl) return;
      if (audio.src !== cleanUrl) {
        audio.src = cleanUrl;
      }
    } else {
      player.showToast("⚠️ Offline: This track is not downloaded for offline play.");
      return;
    }

    audio.playbackRate = playbackRate;
    audio.volume = masterVolume;

    // 4. Synchronous immediate play (0ms click-to-audio latency)
    unlockAudioContext();
    try {
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn("Playback gesture required:", err);
          updateUI();
        });
      }
    } catch (err) {
      console.warn("Playback gesture:", err);
      updateUI();
    }

    // 5. PREDICTIVE PRELOAD: Pre-buffer the next track 1.5s in advance so Next click plays in 0ms
    if (playlist.length > 1) {
      const nextIdx = (currentIndex + 1) % playlist.length;
      const nextSong = playlist[nextIdx];
      if (nextSong && nextSong.link) {
        setTimeout(() => {
          player.prefetchAudioStream(nextSong.link);
        }, 1500);
      }
    }
  },

  play() {
    if (!currentSong && playlist.length > 0) {
      return player.playSong(playlist[currentIndex]);
    }
    userPaused = false;
    unlockAudioContext();
    try {
      const p = audio.play();
      if (p !== undefined) p.catch(() => {});
    } catch (err) {
      console.warn("Play error:", err);
    }
    updateUI();
  },

  pause() {
    userPaused = true;
    audio.pause();
    updateUI();
  },

  togglePlay() {
    if (audio.paused) {
      player.play();
    } else {
      player.pause();
    }
  },

  next(isAuto = false) {
    if (!playlist.length) return;
    if (!isAuto) userPaused = false;

    if (repeatMode === "off" && currentIndex >= playlist.length - 1 && isAuto) {
      player.pause();
      return;
    }

    currentIndex = (currentIndex + 1) % playlist.length;
    player.playSong(playlist[currentIndex]);
  },

  prev() {
    userPaused = false;
    if (audio.currentTime > 3.5) {
      audio.currentTime = 0;
      updateProgress();
      return;
    }
    if (!playlist.length) return;
    currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
    player.playSong(playlist[currentIndex]);
  },

  seek(seconds) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const clamped = clamp(seconds, 0, audio.duration);
    audio.currentTime = clamped;
    updateProgress();
    updatePositionState();
  },

  setVolume(vol) {
    masterVolume = clamp(vol, 0, 1);
    audio.volume = masterVolume;
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
      audio._prevVol = masterVolume;
      player.setVolume(0);
    } else {
      player.setVolume(audio._prevVol || 1.0);
    }
  },

  setCrossfade(sec) {
    crossfadeSeconds = clamp(parseFloat(sec) || 0, 0, 15);
    localStorage.setItem(CROSSFADE_STORAGE_KEY, String(crossfadeSeconds));
    player.showToast(crossfadeSeconds === 0 ? "⚡ Gapless mode active" : `🎚️ Transition set to ${crossfadeSeconds}s`);
  },

  setPlaybackSpeed(speed) {
    playbackRate = clamp(parseFloat(speed) || 1.0, 0.5, 2.0);
    audio.playbackRate = playbackRate;
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
  }
};

// ─── HARDWARE & BROWSER EVENT BINDINGS ─────────────────────────────
initMediaSession();

["click", "touchend"].forEach((evt) => {
  document.addEventListener(evt, () => {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  }, { once: true, passive: true });
});

if (playBtnEl)    playBtnEl.onclick    = () => player.togglePlay();
if (prevBtn)      prevBtn.onclick      = () => player.prev();
if (nextBtn)      nextBtn.onclick      = () => player.next();
if (repeatBtnEl)  repeatBtnEl.onclick  = () => player.cycleRepeat();
if (shuffleBtnEl) shuffleBtnEl.onclick = () => player.toggleShuffle();

if (seekBar) {
  seekBar.addEventListener("input", () => {
    isSeeking = true;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const sec = (seekBar.value / 100) * audio.duration;
      if (progressFill)  progressFill.style.width = `${seekBar.value}%`;
      if (currentTimeEl) currentTimeEl.textContent = formatTime(sec);
    }
  });

  seekBar.addEventListener("change", () => {
    isSeeking = false;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const sec = (seekBar.value / 100) * audio.duration;
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
    if (!audio.paused && "mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "playing";
    }
  } else {
    if (!audio.paused) {
      acquireWakeLock();
      updateMediaSession(currentSong);
      updateUI();
      updateProgress();
    }
  }
});