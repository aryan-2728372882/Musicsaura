// scripts/player.js — Musicsaura 2025 - FIXED Volume & Stats
import {
  auth,
  db,
  onAuthStateChanged,
  doc,
  updateDoc,
  increment,
  serverTimestamp
} from "./firebase-config.js";

const audio = document.getElementById('audio');
const titleEl = document.getElementById('player-title');
const thumbEl = document.querySelector('.thumb-placeholder');
const playBtn = document.getElementById('play-pause').querySelector('span');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const repeatBtn = document.getElementById('repeat').querySelector('span');
const seekBar = document.getElementById('seek');
const currentTimeEl = document.getElementById('current-time');
const durationTimeEl = document.getElementById('duration-time');
const playerEl = document.getElementById('player');
const navAvatar = document.getElementById('nav-avatar');
const profileBtn = document.getElementById('profile-btn');

let currentSong = null;
let repeat = 'off';
let songPlayStartTime = 0;
let totalListenedTime = 0;
let hasCountedSong = false;
let playlist = [];
let currentIndex = 0;
let userInitiatedPause = false;
let trackTransitioning = false;
let backgroundModeConfigured = false;
let autoAdvanceRetryTimer = null;
let autoAdvanceRetryCount = 0;
const MAX_AUTO_ADVANCE_RETRIES = 8;
const TARGET_PLAYBACK_VOLUME = 1;
const MIN_PLAYBACK_VOLUME = 0;
const ENABLE_WEB_AUDIO_PIPELINE = false;
let interruptedBySystem = false;
let callInterruptionActive = false;
let shouldResumeAfterInterruption = false;
let lastKnownTime = 0;
let lastProgressAt = Date.now();
let stallRecoveryTimer = null;
let recoveringStall = false;
let stallRecoveryAttempts = 0;
const MAX_STALL_RECOVERY_ATTEMPTS = 4;
const STALL_PROGRESS_TIMEOUT_MS = 12000;
const HIDDEN_STALL_PROGRESS_TIMEOUT_MS = 45000;
const STALL_RECOVERY_DELAY_MS = 1500;
const BACKGROUND_AUTO_ADVANCE_LEAD_SECONDS = 1.1;
const ENABLE_SCREEN_WAKE_LOCK = false;
const MAX_BACKGROUND_RESUME_ATTEMPTS = 12;
const warmedOrigins = new Set();
let currentPlaybackUrls = [];
let currentPlaybackUrlIndex = 0;
let backgroundResumeTimer = null;
let backgroundResumeAttempts = 0;

const PLAYBACK_STATE_KEY = "musicsaura-playback-state";
const LOCAL_STATS_KEY = "musicsaura-local-stats";

function savePlaybackState(song, isPlaying, currentTime, songs, index) {
  try {
    const payload = {
      song,
      isPlaying,
      currentTime: Number.isFinite(currentTime) ? currentTime : 0,
      playlist: Array.isArray(songs) ? songs : [],
      currentIndex: Number.isInteger(index) ? index : 0,
      updatedAt: Date.now()
    };
    localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(payload));
  } catch (e) {}
}

function syncPlaybackStats(minutes = 0, songsPlayed = 0) {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_STATS_KEY) || "{}");
    const next = {
      minutesListened: Math.max(0, Number(saved.minutesListened || 0) + Number(minutes || 0)),
      songsPlayed: Math.max(0, Number(saved.songsPlayed || 0) + Number(songsPlayed || 0)),
      updatedAt: Date.now()
    };
    localStorage.setItem(LOCAL_STATS_KEY, JSON.stringify(next));
  } catch (e) {}
}

function clearAutoAdvanceRetry() {
  if (autoAdvanceRetryTimer) {
    clearTimeout(autoAdvanceRetryTimer);
    autoAdvanceRetryTimer = null;
  }
}

function getStallProgressTimeoutMs() {
  return document.hidden ? HIDDEN_STALL_PROGRESS_TIMEOUT_MS : STALL_PROGRESS_TIMEOUT_MS;
}

function isNearTrackEnd() {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return false;
  return audio.currentTime >= Math.max(0, audio.duration - 1);
}

function getFadeOutTriggerWindowSeconds() {
  return fadeOutDuration / 1000 + 2;
}

function formatClockTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function updateTimeDisplay() {
  if (currentTimeEl) currentTimeEl.textContent = formatClockTime(audio.currentTime || 0);
  if (durationTimeEl) durationTimeEl.textContent = formatClockTime(audio.duration || 0);
}

function recoverFromNearEndFadeIfNeeded(previousTime, nextTime) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;

  const triggerWindow = getFadeOutTriggerWindowSeconds();
  const wasNearEnd = audio.duration - previousTime <= triggerWindow;
  const isNowNearEnd = audio.duration - nextTime <= triggerWindow;
  const jumpedBackward = nextTime < previousTime - 0.25;

  if (wasNearEnd && jumpedBackward && !isNowNearEnd) {
    stopFade();
    setPlaybackVolume(TARGET_PLAYBACK_VOLUME);
  }
}

function seekToTime(targetTime) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;

  const previousTime = audio.currentTime;
  const nextTime = Math.max(0, Math.min(audio.duration, Number(targetTime) || 0));
  audio.currentTime = nextTime;
  recoverFromNearEndFadeIfNeeded(previousTime, nextTime);
  updateTimeDisplay();
}

// DJ Fade settings
let fadeInDuration = 10000;
let fadeOutDuration = 10000;
let fadeInterval = null;
let isFading = false;

// Prevent garbage collection
window.audioElement = audio;

// CRITICAL: Set audio element for instant streaming
audio.preload = "auto";
audio.crossOrigin = "anonymous";
audio.setAttribute("playsinline", "");
audio.setAttribute("webkit-playsinline", "");
audio.volume = TARGET_PLAYBACK_VOLUME;

function clampPlaybackVolume(value) {
  return Math.max(MIN_PLAYBACK_VOLUME, Math.min(TARGET_PLAYBACK_VOLUME, Number(value)));
}

function getCurrentPlaybackVolume() {
  if (gainNode) return clampPlaybackVolume(gainNode.gain.value);
  return clampPlaybackVolume(audio.volume);
}

function setPlaybackVolume(value) {
  const next = clampPlaybackVolume(value);
  if (gainNode) {
    gainNode.gain.value = next;
  }
  audio.volume = next;
}

function isBackgroundPowerAbort(error) {
  const text = `${error?.name || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("video-only background media was paused to save power");
}

function fadeTo(targetVolume, durationMs) {
  clearInterval(fadeInterval);
  const from = getCurrentPlaybackVolume();
  const to = clampPlaybackVolume(targetVolume);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    setPlaybackVolume(to);
    isFading = false;
    return;
  }
  const startTime = Date.now();

  isFading = true;
  fadeInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    const eased = progress;
    setPlaybackVolume(from + (to - from) * eased);

    if (progress >= 1) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      isFading = false;
    }
  }, 16);
}

function startFade(direction) {
  const duration = direction === "in" ? fadeInDuration : fadeOutDuration;
  const endVolume = direction === "in" ? TARGET_PLAYBACK_VOLUME : MIN_PLAYBACK_VOLUME;
  // Timed JS fades are heavily throttled while screen is off; keep playback audible instead.
  if (document.hidden) {
    stopFade();
    setPlaybackVolume(endVolume);
    return;
  }
  if (direction === "in") {
    setPlaybackVolume(MIN_PLAYBACK_VOLUME);
  }
  fadeTo(endVolume, duration);
}

function stopFade() { 
  clearInterval(fadeInterval); 
  fadeInterval = null;
  isFading = false; 
}

function captureListenProgressOnPause() {
  if (songPlayStartTime) {
    totalListenedTime += (Date.now() - songPlayStartTime) / 1000;
  }
  songPlayStartTime = 0;
}

function clearStallRecoveryTimer() {
  if (!stallRecoveryTimer) return;
  clearTimeout(stallRecoveryTimer);
  stallRecoveryTimer = null;
}

function resetStallRecoveryState() {
  clearStallRecoveryTimer();
  recoveringStall = false;
  stallRecoveryAttempts = 0;
}

function clearBackgroundResumeTimer() {
  if (!backgroundResumeTimer) return;
  clearTimeout(backgroundResumeTimer);
  backgroundResumeTimer = null;
}

function resetBackgroundResumeState() {
  clearBackgroundResumeTimer();
  backgroundResumeAttempts = 0;
}

function scheduleBackgroundResume(reason = "pause", delayMs = 800) {
  if (userInitiatedPause || trackTransitioning || !currentSong?.link || callInterruptionActive) return;
  if (backgroundResumeAttempts >= MAX_BACKGROUND_RESUME_ATTEMPTS) return;
  clearBackgroundResumeTimer();
  backgroundResumeTimer = setTimeout(() => {
    backgroundResumeTimer = null;
    attemptBackgroundResume(reason);
  }, Math.max(0, delayMs));
}

function attemptBackgroundResume(reason = "pause") {
  if (userInitiatedPause || trackTransitioning || !currentSong?.link || callInterruptionActive) return;
  if (!audio.paused) {
    resetBackgroundResumeState();
    return;
  }
  if (backgroundResumeAttempts >= MAX_BACKGROUND_RESUME_ATTEMPTS) return;

  backgroundResumeAttempts += 1;
  resumeAudioContext()
    .then(() => audio.play())
    .then(() => {
      resetBackgroundResumeState();
      playBtn.textContent = "pause";
      lastProgressAt = Date.now();
      enableBackgroundMode();
      startServiceWorkerKeepAlive();
      if (document.hidden) {
        setPlaybackVolume(TARGET_PLAYBACK_VOLUME);
      }
    })
    .catch(() => {
      const backoffMs = Math.min(5000, 900 + backgroundResumeAttempts * 500);
      scheduleBackgroundResume(`${reason}-retry`, backoffMs);
    });
}

function scheduleStallRecovery(reason, delayMs = STALL_RECOVERY_DELAY_MS) {
  if (!currentSong?.link || userInitiatedPause || trackTransitioning || recoveringStall) return;
  clearStallRecoveryTimer();
  stallRecoveryTimer = setTimeout(() => {
    stallRecoveryTimer = null;
    recoverStalledPlayback(reason);
  }, Math.max(0, delayMs));
}

function recoverStalledPlayback(reason = "stall") {
  if (!currentSong?.link || userInitiatedPause || trackTransitioning || recoveringStall) return;

  const stalledLongEnough = Date.now() - lastProgressAt > getStallProgressTimeoutMs();
  if (!audio.paused && !stalledLongEnough) return;

  if (stallRecoveryAttempts >= MAX_STALL_RECOVERY_ATTEMPTS) {
    recoveringStall = false;
    if (playlist.length > 1) {
      trackTransitioning = true;
      playNextSong();
    } else {
      playBtn.textContent = "play_arrow";
    }
    return;
  }

  recoveringStall = true;
  stallRecoveryAttempts += 1;
  clearStallRecoveryTimer();

  const resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const retryUrl = getRecoveryPlaybackUrl(reason) || normalizeAudioUrl(currentSong.link);
  if (!retryUrl) {
    recoveringStall = false;
    if (playlist.length > 1) {
      trackTransitioning = true;
      playNextSong();
    }
    return;
  }

  const attemptResume = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      seekToTime(resumeAt);
    } else {
      try {
        audio.currentTime = Math.max(0, resumeAt);
      } catch (e) {}
      updateTimeDisplay();
    }
    resumeAudioContext()
      .then(() => audio.play())
      .then(() => {
        recoveringStall = false;
        lastProgressAt = Date.now();
      })
      .catch(() => {
        recoveringStall = false;
        scheduleStallRecovery(`${reason}-retry`, STALL_RECOVERY_DELAY_MS + 500);
      });
  };

  try {
    stopFade();
    audio.pause();
    audio.src = retryUrl;
    audio.load();

    if (audio.readyState >= 2) {
      attemptResume();
      return;
    }

    const canPlayHandler = () => {
      audio.removeEventListener("canplay", canPlayHandler);
      attemptResume();
    };

    audio.addEventListener("canplay", canPlayHandler, { once: true });
    setTimeout(() => {
      audio.removeEventListener("canplay", canPlayHandler);
      if (recoveringStall) {
        recoveringStall = false;
        scheduleStallRecovery(`${reason}-timeout`, STALL_RECOVERY_DELAY_MS + 500);
      }
    }, 5000);
  } catch (e) {
    recoveringStall = false;
    scheduleStallRecovery(`${reason}-exception`, STALL_RECOVERY_DELAY_MS + 500);
  }
}

function pauseForInterruption() {
  if (audio.paused) return;
  clearStallRecoveryTimer();
  recoveringStall = false;
  interruptedBySystem = true;
  userInitiatedPause = false;
  trackTransitioning = false;
  clearAutoAdvanceRetry();
  stopFade();
  captureListenProgressOnPause();
  audio.pause();
}

function toHttpsUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") parsed.protocol = "https:";
    return parsed.toString();
  } catch (e) {
    return rawUrl || "";
  }
}

function normalizeAudioUrl(rawUrl) {
  const safeUrl = toHttpsUrl(rawUrl);
  try {
    const url = new URL(safeUrl);
    const host = url.hostname.toLowerCase();

    if (host.includes("dropbox.com")) {
      if (host === "www.dropbox.com") {
        url.hostname = "dl.dropboxusercontent.com";
      }
      url.searchParams.set("raw", "1");
      url.searchParams.delete("dl");
      return url.toString();
    }

    if (host.includes("supabase.co")) {
      // Keep storage URLs stream-friendly.
      url.searchParams.delete("download");
      url.searchParams.delete("dl");
      return url.toString();
    }

    if (host.includes("filegarden")) {
      url.searchParams.delete("download");
      url.searchParams.delete("dl");
      return url.toString();
    }

    return url.toString();
  } catch (e) {
    return safeUrl;
  }
}

function buildAudioUrlCandidates(rawUrl) {
  const unique = new Set();
  const candidates = [];
  const push = (value) => {
    const cleaned = normalizeAudioUrl(value);
    if (!cleaned || unique.has(cleaned)) return;
    unique.add(cleaned);
    candidates.push(cleaned);
  };

  push(rawUrl);

  try {
    const original = new URL(toHttpsUrl(rawUrl));
    const host = original.hostname.toLowerCase();

    if (host.includes("dropbox.com")) {
      const direct = new URL(original.toString());
      direct.hostname = "dl.dropboxusercontent.com";
      direct.searchParams.set("raw", "1");
      direct.searchParams.delete("dl");
      push(direct.toString());

      const dlVersion = new URL(original.toString());
      dlVersion.hostname = "www.dropbox.com";
      dlVersion.searchParams.set("dl", "1");
      dlVersion.searchParams.delete("raw");
      push(dlVersion.toString());
    }

    if (host.includes("supabase.co")) {
      const streamVersion = new URL(original.toString());
      streamVersion.searchParams.delete("download");
      streamVersion.searchParams.delete("dl");
      push(streamVersion.toString());
    }

    if (host.includes("filegarden")) {
      const streamVersion = new URL(original.toString());
      streamVersion.searchParams.delete("download");
      streamVersion.searchParams.delete("dl");
      push(streamVersion.toString());
    }
  } catch (e) {}

  return candidates.length ? candidates : [rawUrl];
}

function warmOriginForAudio(rawUrl) {
  try {
    const normalized = normalizeAudioUrl(rawUrl);
    const url = new URL(normalized);
    if (warmedOrigins.has(url.origin)) return;
    warmedOrigins.add(url.origin);

    const preconnect = document.createElement("link");
    preconnect.rel = "preconnect";
    preconnect.href = url.origin;
    preconnect.crossOrigin = "anonymous";
    document.head.appendChild(preconnect);

    const dnsPrefetch = document.createElement("link");
    dnsPrefetch.rel = "dns-prefetch";
    dnsPrefetch.href = url.origin;
    document.head.appendChild(dnsPrefetch);
  } catch (e) {}
}

function setCurrentPlaybackCandidates(rawUrl) {
  currentPlaybackUrls = buildAudioUrlCandidates(rawUrl);
  currentPlaybackUrlIndex = 0;
  const primary = currentPlaybackUrls[0] || normalizeAudioUrl(rawUrl);
  warmOriginForAudio(primary);
  return primary;
}

function getRecoveryPlaybackUrl(reason = "") {
  if (!currentPlaybackUrls.length && currentSong?.link) {
    setCurrentPlaybackCandidates(currentSong.link);
  }

  const wantsProviderFallback =
    reason.includes("network") || reason.includes("stalled") || reason.includes("waiting");

  if (
    (stallRecoveryAttempts > 1 || wantsProviderFallback) &&
    currentPlaybackUrlIndex < currentPlaybackUrls.length - 1
  ) {
    currentPlaybackUrlIndex += 1;
  }

  const chosen = currentPlaybackUrls[currentPlaybackUrlIndex] || currentPlaybackUrls[0] || "";
  if (chosen) warmOriginForAudio(chosen);
  return chosen;
}

// Audio Context - Lazy init
let audioContext = null;
let sourceNode = null;
let gainNode = null;
let audioContextInitialized = false;

function initAudioContext() {
  if (!ENABLE_WEB_AUDIO_PIPELINE) return null;
  if (audioContextInitialized) return audioContext;
  
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioContext = new AC({ 
      latencyHint: 'interactive',
      sampleRate: 44100
    });
    
    sourceNode = audioContext.createMediaElementSource(audio);
    gainNode = audioContext.createGain();
    gainNode.gain.value = getCurrentPlaybackVolume();
    
    sourceNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    // Keep element volume aligned with current playback value.
    audio.volume = gainNode.gain.value;
    
    audioContextInitialized = true;
    window.audioContext = audioContext;
    window.sourceNode = sourceNode;
    window.gainNode = gainNode;
    
    return audioContext;
  } catch (e) {
    console.error('AudioContext init error:', e);
    audioContext = null;
    sourceNode = null;
    gainNode = null;
    audioContextInitialized = false;
    return null;
  }
}

function resumeAudioContext() {
  if (!audioContext) {
    initAudioContext();
    return Promise.resolve();
  }
  
  if (audioContext.state === 'suspended') {
    return audioContext.resume().catch(err => {
      console.error('Failed to resume AudioContext:', err);
    });
  }
  
  return Promise.resolve();
}

// Service Worker KeepAlive
let swKeepAliveInterval = null;

function startServiceWorkerKeepAlive() {
  // Intentionally no-op: modern browsers manage SW lifecycle.
}

function stopServiceWorkerKeepAlive() {
  if (swKeepAliveInterval) {
    clearInterval(swKeepAliveInterval);
    swKeepAliveInterval = null;
  }
}

// Cordova/Capacitor background mode (Android native wrapper)
function configureBackgroundMode() {
  const bg = window.cordova?.plugins?.backgroundMode;
  if (!bg || backgroundModeConfigured) return;

  try {
    bg.setDefaults?.({
      title: "MusicsAura",
      text: "Playback running in background",
      resume: true,
      hidden: false,
      silent: false
    });

    if (typeof bg.on === "function") {
      bg.on("activate", () => {
        try {
          bg.disableWebViewOptimizations?.();
        } catch (e) {}
      });
    }

    backgroundModeConfigured = true;
  } catch (e) {}
}

function enableBackgroundMode() {
  const bg = window.cordova?.plugins?.backgroundMode;
  if (!bg) return;
  try {
    configureBackgroundMode();
    bg.setDefaults?.({
      title: "MusicsAura",
      text: currentSong?.title ? `Playing: ${currentSong.title}` : "Playback running in background",
      resume: true,
      hidden: false,
      silent: false
    });
    bg.disableWebViewOptimizations?.();
    if (!bg.isEnabled()) bg.enable();
  } catch (e) {}
}

function disableBackgroundMode() {
  const bg = window.cordova?.plugins?.backgroundMode;
  if (!bg) return;
  try {
    if (bg.isEnabled()) bg.disable();
  } catch (e) {}
}

document.addEventListener("deviceready", () => {
  configureBackgroundMode();
}, { once: true });

// Wake Lock to reduce sleep interruptions during playback
let wakeLock = null;

async function requestWakeLock() {
  if (!ENABLE_SCREEN_WAKE_LOCK || document.hidden || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (e) {
    // Ignore; not supported or denied
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !audio.paused) {
    requestWakeLock();
    enableBackgroundMode();
  } else if (document.hidden && !audio.paused) {
    stopFade();
    setPlaybackVolume(TARGET_PLAYBACK_VOLUME);
    enableBackgroundMode();
    startServiceWorkerKeepAlive();
  }
});

function resumeAfterInterruptionIfNeeded() {
  if (!shouldResumeAfterInterruption) return;
  if (userInitiatedPause || !audio.paused || !currentSong || trackTransitioning) return;

  shouldResumeAfterInterruption = false;
  callInterruptionActive = false;
  interruptedBySystem = false;
  play();
}

if ("audioSession" in navigator) {
  try {
    navigator.audioSession.type = "playback";
    navigator.audioSession.addEventListener("statechange", () => {
      const state = navigator.audioSession.state;
      const interruptionState = state === "interrupted" || state === "inactive";
      if (interruptionState) {
        const wasPlayingBeforeInterruption = !audio.paused && !userInitiatedPause && !trackTransitioning;
        if (wasPlayingBeforeInterruption) {
          shouldResumeAfterInterruption = true;
        }
        callInterruptionActive = true;
        if (!audio.paused) {
          pauseForInterruption();
        }
        return;
      }

      if (state === "active") {
        if (shouldResumeAfterInterruption) {
          resumeAfterInterruptionIfNeeded();
        } else {
          callInterruptionActive = false;
          interruptedBySystem = false;
        }
      }
    });
  } catch (e) {}
}

window.addEventListener("focus", () => {
  resumeAfterInterruptionIfNeeded();
});

// Media Session
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => play());
  navigator.mediaSession.setActionHandler('pause', () => pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => playPreviousSong());
  navigator.mediaSession.setActionHandler('nexttrack', () => playNextSong());
  
  try {
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      seekToTime(audio.currentTime - 10);
    });
    navigator.mediaSession.setActionHandler('seekforward', () => {
      seekToTime(audio.currentTime + 10);
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      const target = Number(details?.seekTime);
      if (!Number.isFinite(target)) return;
      if (details?.fastSeek && typeof audio.fastSeek === "function") {
        audio.fastSeek(target);
        updateTimeDisplay();
        return;
      }
      seekToTime(target);
    });
  } catch (e) {}
}

function updateMediaSession(song) {
  if (!song || !('mediaSession' in navigator)) return;
  
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'Unknown',
      artist: song.artist || 'Unknown Artist',
      album: song.genre || 'MusicsAura',
      artwork: song.thumbnail ? [
        { src: song.thumbnail, sizes: '96x96', type: 'image/jpeg' },
        { src: song.thumbnail, sizes: '256x256', type: 'image/jpeg' }
      ] : []
    });
    
    navigator.mediaSession.playbackState = !audio.paused ? 'playing' : 'paused';
  } catch (e) {}
}

function showPlayer() { 
  playerEl.hidden = false; 
  playerEl.classList.add('visible'); 
  updateTimeDisplay();
}

// Aggressive preloading
let preloadAudio = null;

function preloadNextSong() {
  if (!playlist.length || playlist.length < 2) return;
  
  const nextIndex = (currentIndex + 1) % playlist.length;
  const nextSong = playlist[nextIndex];
  
  if (!nextSong?.link) return;
  
  if (!preloadAudio) {
    preloadAudio = new Audio();
    preloadAudio.crossOrigin = "anonymous";
    preloadAudio.preload = "auto";
    preloadAudio.volume = 0;
    window.preloadAudio = preloadAudio;
  }
  
  const fixedUrl = buildAudioUrlCandidates(nextSong.link)[0];
  if (!fixedUrl) return;
  warmOriginForAudio(fixedUrl);
  if (preloadAudio.src !== fixedUrl) {
    preloadAudio.src = fixedUrl;
    preloadAudio.load();
  }
}

// MAIN PLAYER - OPTIMIZED FOR SPEED
export const player = {
  setPlaylist(songs, index = 0) { 
    playlist = songs; 
    currentIndex = index; 
  },

  async playSong(song) {
    if (!song?.link) {
      console.error('No song link');
      return;
    }

    clearAutoAdvanceRetry();
    resetBackgroundResumeState();
    resetStallRecoveryState();
    shouldResumeAfterInterruption = false;
    callInterruptionActive = false;
    interruptedBySystem = false;
    userInitiatedPause = false;
    trackTransitioning = true;

    // Update stats for previous song without blocking playback
    saveSongStats();
    
    // Stop previous playback
    stopFade();
    audio.pause();
    
    // Reset tracking for new song
    currentSong = song;
    songPlayStartTime = Date.now();
    totalListenedTime = 0;
    hasCountedSong = false;

    const fixedUrl = setCurrentPlaybackCandidates(song.link);
    
    if (!fixedUrl || fixedUrl === 'undefined') {
      console.error('Invalid URL:', fixedUrl);
      return;
    }
    
    // INSTANT UI UPDATE
    titleEl.textContent = song.title;
    thumbEl.style.backgroundImage = song.thumbnail ? `url(${song.thumbnail})` : '';
    updateMediaSession(song);
    showPlayer();
    enableBackgroundMode();
    
    // Start from low volume and fade in to avoid sudden spikes on speakers.
    setPlaybackVolume(document.hidden ? TARGET_PLAYBACK_VOLUME : MIN_PLAYBACK_VOLUME);
    seekBar.value = 0;
    updateTimeDisplay();

    const markTrackStarted = () => {
      trackTransitioning = false;
      autoAdvanceRetryCount = 0;
      clearAutoAdvanceRetry();
      resetBackgroundResumeState();
      resetStallRecoveryState();
      lastProgressAt = Date.now();
    };

    const scheduleRetryForCurrentTrack = () => {
      trackTransitioning = false;

      if (autoAdvanceRetryCount >= MAX_AUTO_ADVANCE_RETRIES) {
        if (playlist.length > 1) {
          trackTransitioning = true;
          playNextSong();
        } else {
          playBtn.textContent = 'play_arrow';
        }
        return;
      }

      autoAdvanceRetryCount += 1;
      clearAutoAdvanceRetry();
      autoAdvanceRetryTimer = setTimeout(() => {
        autoAdvanceRetryTimer = null;
        if (audio.paused && playlist[currentIndex]) {
          player.playSong(playlist[currentIndex]);
        }
      }, 1500);
    };
    
    // Check if preloaded
    const isPreloaded = preloadAudio && preloadAudio.src === fixedUrl && 
                        preloadAudio.readyState >= 2;
    
    if (isPreloaded) {
      audio.src = preloadAudio.src;
      audio.currentTime = 0;
      
      resumeAudioContext();
      audio.play().then(() => {
        playBtn.textContent = 'pause';
        startServiceWorkerKeepAlive();
        requestWakeLock();
        enableBackgroundMode();
        startFade("in");
        markTrackStarted();
        setTimeout(() => preloadNextSong(), 1000);
      }).catch(err => {
        if (isBackgroundPowerAbort(err)) {
          setPlaybackVolume(TARGET_PLAYBACK_VOLUME);
        } else {
          console.error('Preloaded play failed:', err);
        }
        scheduleRetryForCurrentTrack();
      });
      
      return;
    }
    
    // Fast load path
    audio.src = fixedUrl;
    resumeAudioContext();
    
    const playPromise = audio.play();
    playBtn.textContent = 'pause';
    startServiceWorkerKeepAlive();
    requestWakeLock();
    enableBackgroundMode();
    
    playPromise.then(() => {
      markTrackStarted();
      startFade("in");
      setTimeout(() => preloadNextSong(), 1000);
    }).catch(err => {
      if (isBackgroundPowerAbort(err)) {
        setPlaybackVolume(TARGET_PLAYBACK_VOLUME);
      }
      const canPlayHandler = () => {
        audio.play().then(() => {
          playBtn.textContent = 'pause';
          startFade("in");
          markTrackStarted();
          setTimeout(() => preloadNextSong(), 1000);
        }).catch(e => {
          console.error('Delayed play failed:', e);
          scheduleRetryForCurrentTrack();
        });
      };
      
      audio.addEventListener('canplay', canPlayHandler, { once: true });
      
      setTimeout(() => {
        audio.removeEventListener('canplay', canPlayHandler);
        if (audio.paused) {
          scheduleRetryForCurrentTrack();
        }
      }, 5000);
    });
  },

  getState() {
    return {
      currentSong,
      isPlaying: !audio.paused,
      currentTime: audio.currentTime,
      playlist,
      currentIndex
    };
  },

  async restoreState(state) {
    if (!state?.currentSong) return;
    
    playlist = state.playlist || [];
    currentIndex = state.currentIndex || 0;
    currentSong = state.currentSong;
    
    const fixedUrl = setCurrentPlaybackCandidates(state.currentSong.link);
    audio.src = fixedUrl;
    audio.currentTime = state.currentTime || 0;
    
    // Update UI
    titleEl.textContent = state.currentSong.title;
    thumbEl.style.backgroundImage = state.currentSong.thumbnail ? `url(${state.currentSong.thumbnail})` : '';
    updateMediaSession(state.currentSong);
    showPlayer();
    
    if (state.isPlaying) {
      resumeAudioContext().then(() => {
        audio.play().catch(err => {
          console.error('Restore playback failed:', err);
        });
      });
    }
    updateTimeDisplay();
  }
};

// Controls
function play() { 
  resetStallRecoveryState();
  resetBackgroundResumeState();
  shouldResumeAfterInterruption = false;
  callInterruptionActive = false;
  interruptedBySystem = false;
  userInitiatedPause = false;
  trackTransitioning = false;
  clearAutoAdvanceRetry();
  resumeAudioContext().then(() => {
    audio.play().then(() => { 
      playBtn.textContent = 'pause'; 
      songPlayStartTime = Date.now(); 
      startServiceWorkerKeepAlive();
      requestWakeLock();
      enableBackgroundMode();
      startFade("in");
      updateMediaSession(currentSong);
    }).catch(err => {
      console.error('Play error:', err);
      playBtn.textContent = 'play_arrow';
    }); 
  });
}

function pause() { 
  clearStallRecoveryTimer();
  resetBackgroundResumeState();
  recoveringStall = false;
  shouldResumeAfterInterruption = false;
  callInterruptionActive = false;
  interruptedBySystem = false;
  userInitiatedPause = true;
  trackTransitioning = false;
  clearAutoAdvanceRetry();
  audio.pause(); 
  playBtn.textContent = 'play_arrow'; 
  stopFade(); 
  releaseWakeLock();
  disableBackgroundMode();
  
  captureListenProgressOnPause();
  
  stopServiceWorkerKeepAlive();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused';
  }
}

// Initialize AudioContext on first interaction
[playBtn.parentElement, prevBtn, nextBtn, repeatBtn.parentElement, seekBar].forEach(element => {
  element.addEventListener('click', () => {
    resumeAudioContext();
  }, { once: true });
});

playBtn.parentElement.onclick = () => audio.paused ? play() : pause();
prevBtn.onclick = () => playlist.length && playPreviousSong();
nextBtn.onclick = () => playlist.length && playNextSong();
repeatBtn.parentElement.onclick = () => { 
  repeat = repeat === 'off' ? 'one' : repeat === 'one' ? 'all' : 'off'; 
  repeatBtn.textContent = repeat === 'one' ? 'repeat_one' : repeat === 'all' ? 'repeat' : 'repeat'; 
};

// Update position
audio.ontimeupdate = () => {
  if (!audio.duration || isNaN(audio.duration)) return;

  if (Math.abs(audio.currentTime - lastKnownTime) > 0.2) {
    lastKnownTime = audio.currentTime;
    lastProgressAt = Date.now();
    if (stallRecoveryAttempts > 0 || recoveringStall) {
      clearStallRecoveryTimer();
      recoveringStall = false;
      stallRecoveryAttempts = 0;
    }
  }
  
  seekBar.value = (audio.currentTime / audio.duration) * 100;
  updateTimeDisplay();
  
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: 1,
        position: audio.currentTime
      });
    } catch (e) {}
  }
  
  const remaining = audio.duration - audio.currentTime;
  // On some Android PWAs, ended-triggered transitions are deferred while locked.
  // Trigger the next track slightly before natural end to keep playback continuous.
  if (
    document.hidden &&
    !trackTransitioning &&
    repeat !== "one" &&
    playlist.length > 1 &&
    remaining > 0 &&
    remaining <= BACKGROUND_AUTO_ADVANCE_LEAD_SECONDS
  ) {
    trackTransitioning = true;
    stopFade();
    setPlaybackVolume(TARGET_PLAYBACK_VOLUME);
    playNextSong();
    return;
  }

  if (!document.hidden && !trackTransitioning && remaining <= getFadeOutTriggerWindowSeconds() && !isFading) {
    startFade("out");
  }

  // Track listening progress
  if (!hasCountedSong && !audio.paused && songPlayStartTime) {
    const currentListenTime = totalListenedTime + (Date.now() - songPlayStartTime) / 1000;
    if (currentListenTime >= 60) { // Count after 60 seconds
      hasCountedSong = true;
    }
  }
};

audio.addEventListener("loadedmetadata", updateTimeDisplay);
audio.addEventListener("durationchange", updateTimeDisplay);
audio.addEventListener("playing", () => {
  clearStallRecoveryTimer();
  recoveringStall = false;
  stallRecoveryAttempts = 0;
  lastProgressAt = Date.now();
});
audio.addEventListener("waiting", () => {
  if (!audio.paused && !trackTransitioning) {
    scheduleStallRecovery("waiting", document.hidden ? 6500 : 2000);
  }
});
audio.addEventListener("stalled", () => {
  if (!audio.paused && !trackTransitioning) {
    scheduleStallRecovery("stalled", document.hidden ? 5500 : 1200);
  }
});
audio.addEventListener("suspend", () => {
  const suspendThreshold = document.hidden ? 10000 : 3000;
  if (!audio.paused && !trackTransitioning && Date.now() - lastProgressAt > suspendThreshold) {
    scheduleStallRecovery("suspend", document.hidden ? 7000 : 1500);
  }
});

// FIXED: Save song stats function with localStorage fallback for PWA offline
async function saveSongStats() {
  if (!currentSong || !auth.currentUser) return;
  
  // Calculate total time listened
  if (songPlayStartTime) {
    totalListenedTime += (Date.now() - songPlayStartTime) / 1000;
  }
  
  // Only save if listened for at least 30 seconds
  if (totalListenedTime < 30) return;
  
  let minutes = 0.5;
  try {
    minutes = Math.max(0.5, Math.round((totalListenedTime / 60) * 2) / 2);

    // Always try Firebase first for real-time updates
    const updatePromise = updateDoc(doc(db, "users", auth.currentUser.uid), {
      songsPlayed: increment(1),
      minutesListened: increment(minutes),
      lastPlayed: serverTimestamp(),
      lastActive: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) + " IST"
    });

    // Don't let stats update block playback flow
    await Promise.race([
      updatePromise,
      new Promise((resolve) => setTimeout(resolve, 2500))
    ]);
    
    // Also update localStorage for PWA offline support
    syncPlaybackStats(minutes, 1);
    
  } catch (e) {
    console.error('Stats update error:', e);
    // Fallback to localStorage if Firebase fails (offline)
    syncPlaybackStats(minutes || 0.5, 1);
  }
}

// Handle song end
audio.onended = () => {
  stopFade();
  resetBackgroundResumeState();
  userInitiatedPause = false;
  trackTransitioning = true;
  enableBackgroundMode();
  startServiceWorkerKeepAlive();
  
  // Save stats without blocking next song
  saveSongStats();
  
  if (repeat === 'one') {
    audio.currentTime = 0; 
    songPlayStartTime = Date.now(); 
    totalListenedTime = 0; 
    hasCountedSong = false;
    setPlaybackVolume(document.hidden ? TARGET_PLAYBACK_VOLUME : MIN_PLAYBACK_VOLUME);
    
    audio.play().then(() => {
      playBtn.textContent = 'pause';
      trackTransitioning = false;
      autoAdvanceRetryCount = 0;
      startFade("in");
    }).catch(() => {
      if (playlist[currentIndex]) {
        player.playSong(playlist[currentIndex]);
      }
    });
  } else if (repeat === 'all' || repeat === 'off') {
    setPlaybackVolume(document.hidden ? TARGET_PLAYBACK_VOLUME : MIN_PLAYBACK_VOLUME);
    playNextSong();
  }
  updateTimeDisplay();
};

// Error handling
audio.onerror = (e) => {
  if (audio.error?.code === 4) return;
  
  console.error('Audio error:', audio.error);
  playBtn.textContent = 'play_arrow';
  
  if (userInitiatedPause && !trackTransitioning) {
    releaseWakeLock();
    disableBackgroundMode();
  } else {
    enableBackgroundMode();
    startServiceWorkerKeepAlive();
  }
  
  if (audio.error && audio.error.code === audio.error.MEDIA_ERR_NETWORK) {
    scheduleStallRecovery("media-network-error", 300);
  } else if (audio.error?.code !== 4) {
    trackTransitioning = true;
    setTimeout(() => playNextSong(), 1000);
  }
};

// Handle visibility changes
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !audio.paused) {
    if (audioContext?.state === 'suspended') {
      audioContext.resume();
    }
  }
  if (!document.hidden) {
    resumeAfterInterruptionIfNeeded();
  } else if (document.hidden && audio.paused && shouldResumeAfterInterruption && !userInitiatedPause) {
    scheduleBackgroundResume("visibility-hidden", 600);
  }
});

// Handle audio interruptions
audio.addEventListener('pause', () => {
  const naturalEnd = audio.ended;
  const fallbackAutoAdvance = !naturalEnd && !userInitiatedPause && !trackTransitioning && isNearTrackEnd();
  const pausedDuringCallInterruption =
    !naturalEnd && !userInitiatedPause && !trackTransitioning && callInterruptionActive;
  const pausedWhileHidden =
    !naturalEnd && !userInitiatedPause && !trackTransitioning && document.hidden;
  const pausedFromFocusLoss =
    !naturalEnd && !userInitiatedPause && !trackTransitioning && !document.hidden && !document.hasFocus();

  if (fallbackAutoAdvance) {
    trackTransitioning = true;
    enableBackgroundMode();
    startServiceWorkerKeepAlive();

    if (repeat === 'one' && currentSong?.link) {
      player.playSong(currentSong);
    } else {
      playNextSong();
    }
    return;
  }

  if (!naturalEnd) {
    playBtn.textContent = 'play_arrow';
  }

  if (userInitiatedPause || interruptedBySystem) {
    releaseWakeLock();
    disableBackgroundMode();
    stopServiceWorkerKeepAlive();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    return;
  }

  if (trackTransitioning || naturalEnd) {
    enableBackgroundMode();
    startServiceWorkerKeepAlive();
    return;
  }

  if (pausedDuringCallInterruption) {
    interruptedBySystem = true;
    shouldResumeAfterInterruption = true;
    enableBackgroundMode();
    startServiceWorkerKeepAlive();
    return;
  }

  if (pausedWhileHidden || pausedFromFocusLoss) {
    shouldResumeAfterInterruption = true;
    enableBackgroundMode();
    startServiceWorkerKeepAlive();
    scheduleBackgroundResume(pausedWhileHidden ? "hidden-pause" : "focus-pause", 700);
    return;
  }

  // Unexpected pause while a track should continue: retry automatically.
  shouldResumeAfterInterruption = true;
  enableBackgroundMode();
  startServiceWorkerKeepAlive();
  scheduleBackgroundResume("unexpected-pause", 900);
});

document.addEventListener("resume", () => {
  resumeAfterInterruptionIfNeeded();
});

audio.addEventListener('play', () => {
  resetStallRecoveryState();
  resetBackgroundResumeState();
  shouldResumeAfterInterruption = false;
  callInterruptionActive = false;
  interruptedBySystem = false;
  userInitiatedPause = false;
  trackTransitioning = false;
  clearAutoAdvanceRetry();
  autoAdvanceRetryCount = 0;
  playBtn.textContent = 'pause';
  requestWakeLock();
  enableBackgroundMode();
  
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
  }
  
  if (audioContext?.state === 'suspended') {
    audioContext.resume();
  }
  lastProgressAt = Date.now();
});

seekBar.oninput = () => {
  if (audio.duration) {
    seekToTime((seekBar.value / 100) * audio.duration);
  }
};

function playNextSong() { 
  if (!playlist.length) {
    return pause(); 
  }

  userInitiatedPause = false;
  trackTransitioning = true;
  currentIndex = (currentIndex + 1) % playlist.length; 
  player.playSong(playlist[currentIndex]); 
}

function playPreviousSong() {
  if (audio.currentTime > 3) { 
    audio.currentTime = 0; 
    totalListenedTime = 0; 
    hasCountedSong = false; 
    songPlayStartTime = Date.now(); 
  }
  else if (playlist.length) { 
    userInitiatedPause = false;
    trackTransitioning = true;
    currentIndex = (currentIndex - 1 + playlist.length) % playlist.length; 
    player.playSong(playlist[currentIndex]); 
  }
}

onAuthStateChanged(auth, user => {
  if (!user) return location.href = "auth.html";
  navAvatar.src = user.photoURL || `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><circle cx='28' cy='28' r='28' fill='%234a90e2'/><text x='50%25' y='50%25' font-size='28' fill='white' text-anchor='middle' dy='.3em'>${(user.email?.[0] || 'U').toUpperCase()}</text></svg>`;
  profileBtn.onclick = () => {
    // Save playback state before navigating
    const state = player.getState();
    if (state.currentSong) {
      savePlaybackState(state.currentSong, state.isPlaying, state.currentTime, state.playlist, state.currentIndex);
    }
    location.href = user.email === "prabhakararyan2007@gmail.com" ? "admin-dashboard.html" : "user-dashboard.html";
  };
});

// Playback watchdog for long background sessions and lock-screen transitions.
let playbackWatchdogInterval = setInterval(() => {
  if (!currentSong) return;

  if (!audio.paused && !trackTransitioning) {
    // Hidden PWAs can throttle timeupdate events; read currentTime directly here.
    if (Math.abs(audio.currentTime - lastKnownTime) > 0.2) {
      lastKnownTime = audio.currentTime;
      lastProgressAt = Date.now();
      if (stallRecoveryAttempts > 0 || recoveringStall) {
        clearStallRecoveryTimer();
        recoveringStall = false;
        stallRecoveryAttempts = 0;
      }
    }

    const stalled = Date.now() - lastProgressAt > getStallProgressTimeoutMs();
    if (!stalled) return;

    const remaining = Number.isFinite(audio.duration) ? audio.duration - audio.currentTime : Infinity;
    if (remaining <= 1.5 || isNearTrackEnd()) {
      trackTransitioning = true;
      playNextSong();
      return;
    }

    if (document.hidden && audio.readyState >= 2 && !audio.seeking) {
      return;
    }

    recoverStalledPlayback("watchdog");
    return;
  }

  if (!userInitiatedPause && !trackTransitioning && isNearTrackEnd()) {
    trackTransitioning = true;
    playNextSong();
  }
}, 4000);

// FIXED: Save stats and playback state when user leaves (important for PWA)
window.addEventListener('beforeunload', () => {
  clearInterval(playbackWatchdogInterval);
  clearStallRecoveryTimer();
  clearBackgroundResumeTimer();
  stopServiceWorkerKeepAlive();
  clearAutoAdvanceRetry();
  
  // Save current playback state to localStorage for PWA persistence
  if (currentSong) {
    savePlaybackState(currentSong, !audio.paused, audio.currentTime, playlist, currentIndex);
  }
  
  // Try to save stats before leaving (may or may not complete)
  if (currentSong && totalListenedTime >= 30) {
    navigator.sendBeacon && saveSongStats();
  }
});

// Preload first song on page load
window.addEventListener('load', () => {
  if (playlist.length > 0) {
    setTimeout(() => preloadNextSong(), 2000);
  }
});
