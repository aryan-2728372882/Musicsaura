// scripts/player.js — MusicsAura 2025
// ══════════════════════════════════════════════════════════════════
// DEEP ANDROID BACKGROUND FIX
//
// Root cause: Android throttles/kills browser JS when screen is off.
//   - timeupdate event stops firing
//   - ended event never fires
//   - audio.currentTime may freeze
//   - Result: current song "plays forever", next never starts
//
// Solution — Wall-Clock Tracker:
//   When song starts, record Date.now() + audio.currentTime.
//   A setInterval (1s) calculates position as:
//     pos = startAudioTime + (Date.now() - startWallTime) / 1000
//   This math works even when browser is completely suspended.
//   When remaining <= 3s → force advance to next song.
//   Multiple redundant mechanisms ensure it ALWAYS works.
// ══════════════════════════════════════════════════════════════════

import {
  auth, db, isAdmin, onAuthStateChanged,
  doc, updateDoc, increment, serverTimestamp
} from "./firebase-config.js";

// ─── DOM ──────────────────────────────────────────────────────────
const audio         = document.getElementById("audio");
const titleEl       = document.getElementById("player-title");
const artistEl      = document.getElementById("player-artist");
const thumbEl       = document.querySelector(".thumb-placeholder");
const playBtnEl     = document.getElementById("play-pause");
const playBtnIcon   = playBtnEl.querySelector("span");
const prevBtn       = document.getElementById("prev");
const nextBtn       = document.getElementById("next");
const repeatBtnEl   = document.getElementById("repeat");
const repeatIcon    = repeatBtnEl.querySelector("span");
const seekBar       = document.getElementById("seek");
const progressFill  = document.getElementById("progress-fill");
const currentTimeEl = document.getElementById("current-time");
const durationEl    = document.getElementById("duration-time");
const playerEl      = document.getElementById("player");
const navAvatar     = document.getElementById("nav-avatar");
const profileBtn    = document.getElementById("profile-btn");

// ─── CONSTANTS ────────────────────────────────────────────────────
const TARGET_VOL           = 1.0;
const FADE_IN_MS           = 800;
const FADE_OUT_MS          = 1000;
const WC_ADVANCE_S         = 3;      // fire next-song N secs before end (wall clock)
const WC_TICK_MS           = 1000;   // wall-clock tick interval
const TIMEUPDATE_DEAD_MS   = 4000;   // after this → assume screen off
const STALL_MS             = 10000;
const STALL_HIDDEN_MS      = 35000;
const MAX_STALL_RETRIES    = 5;
const MAX_BG_RETRIES       = 16;
const MAX_ADV_RETRIES      = 8;
const STATS_MIN_S          = 30;
const PLAYBACK_KEY         = "musicsaura-pb";
const LOCAL_STATS_KEY      = "musicsaura-stats";

// ─── STATE ────────────────────────────────────────────────────────
let playlist        = [];
let currentIndex    = 0;
let currentSong     = null;
let repeatMode      = "off";   // off | one | all

let userPaused      = false;
let trackTransition = false;
let interruptedSys  = false;
let shouldResume    = false;
let callInterrupt   = false;

// Wall-clock tracker state
let wc = {
  startWall:  0,      // Date.now() when audio started (or last sync)
  startAudio: 0,      // audio.currentTime at that moment
  duration:   0,      // song duration in seconds
  playing:    false,  // is wc actively tracking?
  fired:      false,  // did we already fire advance for this song?
  timer:      null    // setInterval handle
};

// Stall / resume
let lastTimeupdateAt = Date.now();
let lastAudioTime    = 0;
let lastProgressAt   = Date.now();
let stallTimer       = null;
let stallAttempts    = 0;
let recovering       = false;
let bgTimer          = null;
let bgRetries        = 0;
let advanceTimer     = null;
let advanceRetries   = 0;

// Fade
let currentVol      = TARGET_VOL;
let fadeTimer       = null;
let isFading        = false;

// AudioContext
let audioCtx        = null;
let ctxReady        = false;

// Wake lock
let wakeLock        = null;

// Background mode
let bgModeConfigured = false;

// Preload
let preloadAudio    = null;

// URL candidates
let candidates      = [];
let candidateIdx    = 0;
let warmedOrigins   = new Set();

// Stats
let listenStart     = 0;
let listenTotal     = 0;
let songCounted     = false;

// Prevent GC on audio element
window._audioEl = audio;

// ─── WALL-CLOCK WORKER ────────────────────────────────────────────
const workerCode = `
  let timer;
  self.onmessage = function(e) {
    if (e.data === 'start') { clearInterval(timer); timer = setInterval(() => postMessage('tick'), 1000); }
    if (e.data === 'stop') clearInterval(timer);
  };
`;
const workerBlob = new Blob([workerCode], { type: "application/javascript" });
const wcWorker = new Worker(URL.createObjectURL(workerBlob));
wcWorker.onmessage = () => _wcTick();

// ─── AUDIO BASE SETUP ─────────────────────────────────────────────
audio.preload     = "auto";
audio.crossOrigin = "anonymous";
audio.setAttribute("playsinline", "");
audio.setAttribute("webkit-playsinline", "");
audio.volume      = TARGET_VOL;

// ─── UTILS ────────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  return `${m}:${String(sec).padStart(2,"0")}`;
}

const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// ─── URL HELPERS ──────────────────────────────────────────────────
function toHttps(raw) {
  try { const u = new URL(raw); if (u.protocol !== "https:") u.protocol = "https:"; return u.toString(); }
  catch { return raw || ""; }
}

function normUrl(raw) {
  const s = toHttps(raw);
  try {
    const u = new URL(s), h = u.hostname.toLowerCase();
    if (h.includes("dropbox.com")) {
      if (h === "www.dropbox.com") u.hostname = "dl.dropboxusercontent.com";
      u.searchParams.set("raw", "1");
      u.searchParams.delete("dl");
    }
    if (h.includes("supabase.co") || h.includes("filegarden")) {
      u.searchParams.delete("download");
      u.searchParams.delete("dl");
    }
    return u.toString();
  } catch { return s; }
}

function buildCandidates(raw) {
  const seen = new Set(), out = [];
  const add = v => { const c = normUrl(v); if (c && !seen.has(c)) { seen.add(c); out.push(c); } };
  add(raw);
  try {
    const u = new URL(toHttps(raw)), h = u.hostname.toLowerCase();
    if (h.includes("dropbox.com")) {
      const d = new URL(u.toString());
      d.hostname = "dl.dropboxusercontent.com"; d.searchParams.set("raw","1"); d.searchParams.delete("dl"); add(d.toString());
      const w = new URL(u.toString());
      w.hostname = "www.dropbox.com"; w.searchParams.set("dl","1"); w.searchParams.delete("raw"); add(w.toString());
    }
  } catch {}
  return out.length ? out : [raw];
}

function warmOrigin(raw) {
  try {
    const u = new URL(normUrl(raw));
    if (warmedOrigins.has(u.origin)) return;
    warmedOrigins.add(u.origin);
    const pc = document.createElement("link"); pc.rel = "preconnect"; pc.href = u.origin; pc.crossOrigin = "anonymous"; document.head.appendChild(pc);
    const dp = document.createElement("link"); dp.rel = "dns-prefetch"; dp.href = u.origin; document.head.appendChild(dp);
  } catch {}
}

function setCandidates(raw) {
  candidates = buildCandidates(raw); candidateIdx = 0; warmOrigin(candidates[0]); return candidates[0];
}

function getRecoveryUrl(reason = "") {
  if (!candidates.length && currentSong?.link) setCandidates(currentSong.link);
  if ((stallAttempts > 1 || /network|stall|wait/.test(reason)) && candidateIdx < candidates.length - 1) candidateIdx++;
  const u = candidates[candidateIdx] || candidates[0] || "";
  if (u) warmOrigin(u);
  return u;
}

// ─── WALL-CLOCK TRACKER ───────────────────────────────────────────
// Core background fix. Tracks song position using Date.now() math.
// Works even when browser JS is fully suspended (screen off).

function wcGetPos() {
  if (!wc.playing || !wc.startWall) return audio.currentTime || 0;
  return wc.startAudio + (Date.now() - wc.startWall) / 1000;
}

function wcGetRemaining() {
  if (!wc.duration) return Infinity;
  return Math.max(0, wc.duration - wcGetPos());
}

function wcSync(audioTime, duration) {
  // Sync wall clock to current audio position (call when timeupdate fires)
  wc.startWall  = Date.now();
  wc.startAudio = audioTime || 0;
  if (duration && Number.isFinite(duration) && duration > 0) wc.duration = duration;
}

function wcStart(audioTime, duration) {
  wc.startWall  = Date.now();
  wc.startAudio = audioTime || 0;
  wc.duration   = (duration && Number.isFinite(duration) && duration > 0) ? duration : wc.duration;
  wc.playing    = true;
  wc.fired      = false;
  _wcTickStart();
}

function wcPause() {
  wc.playing = false;
  _wcTickStop();
}

function wcStop() {
  wc.playing  = false;
  wc.duration = 0;
  wc.fired    = false;
  _wcTickStop();
}

function wcSeek(audioTime) {
  wc.startWall  = Date.now();
  wc.startAudio = audioTime || 0;
}

function _wcTickStart() {
  _wcTickStop();
  wcWorker.postMessage('start');
  _wcTick(); // immediate first tick
}

function _wcTickStop() {
  wcWorker.postMessage('stop');
}

function _wcTick() {
  if (!wc.playing || !currentSong || userPaused || trackTransition) return;

  const pos       = wcGetPos();
  const remaining = wcGetRemaining();

  // ── STALL DETECTION ────────────────────────────────────────────
  // If timeupdate is dead and audio is paused unexpectedly
  const timeupdateDead = Date.now() - lastTimeupdateAt > TIMEUPDATE_DEAD_MS;
  if (timeupdateDead && audio.paused && !userPaused && !trackTransition) {
    shouldResume = true;
    scheduleBgResume("wc-dead-paused", 300);
  }

  // ── PRIMARY ADVANCE MECHANISM ──────────────────────────────────
  if (!wc.fired && wc.duration > 0) {
    // Only force advance if timeupdate is dead (screen off) AND time is up.
    // If screen is on, let native 'ended' event handle it, unless it massively overshoots.
    const shouldForceAdvance = timeupdateDead ? (remaining <= 0) : false;

    if (shouldForceAdvance || pos > wc.duration + 1) {
      wc.fired   = true;
      wc.playing = false;

      if (repeatMode === "one") {
        const song = currentSong;
        setTimeout(() => { if (!trackTransition) player.playSong(song); }, 50);
      } else if (playlist.length > 1) {
        trackTransition = true;
        stopFade();
        setVol(TARGET_VOL); // must be audible during transition
        playNext();
      } else if (playlist.length === 1) {
        // Single song, repeat off → just go back to start
        audio.currentTime = 0;
        trackTransition = false;
      }
      return;
    }
  }

  // ── UPDATE PROGRESS BAR ────────────────────────────────────────
  // Only when visible (no point wasting CPU when screen off)
  if (!document.hidden && wc.duration > 0 && pos >= 0) {
    const pct = clamp((pos / wc.duration) * 100, 0, 100);
    if (progressFill) progressFill.style.width = pct + "%";
    seekBar.value = pct;
    if (currentTimeEl) currentTimeEl.textContent = fmt(pos);
    if (durationEl)    durationEl.textContent    = fmt(wc.duration);
  }
}

// ─── VOLUME / FADE ────────────────────────────────────────────────
function setVol(v) { currentVol = clamp(v, 0, 1); audio.volume = currentVol; }

function fadeTo(target, ms) {
  clearInterval(fadeTimer);
  const from = currentVol, to = clamp(target, 0, 1);
  if (!ms || ms <= 0) { setVol(to); isFading = false; return; }
  const start = Date.now(); isFading = true;
  fadeTimer = setInterval(() => {
    const p = Math.min((Date.now() - start) / ms, 1);
    setVol(from + (to - from) * p);
    if (p >= 1) { clearInterval(fadeTimer); fadeTimer = null; isFading = false; }
  }, 16);
}

function fadeIn()  { if (document.hidden) { setVol(TARGET_VOL); return; } setVol(0); fadeTo(TARGET_VOL, FADE_IN_MS); }
function fadeOut() { if (document.hidden) { setVol(TARGET_VOL); return; } fadeTo(0, FADE_OUT_MS); }
function stopFade(){ clearInterval(fadeTimer); fadeTimer = null; isFading = false; }

// ─── DISPLAY ──────────────────────────────────────────────────────
function updateDisplay() {
  if (currentTimeEl) currentTimeEl.textContent = fmt(audio.currentTime || 0);
  if (durationEl)    durationEl.textContent    = fmt(audio.duration || 0);
}

function updateProgress() {
  if (!audio.duration || isNaN(audio.duration)) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  if (progressFill) progressFill.style.width = pct + "%";
  seekBar.value = pct;
  updateDisplay();
}

// ─── STALL RECOVERY ───────────────────────────────────────────────
function clearStall() { clearTimeout(stallTimer); stallTimer = null; }
function resetStall() { clearStall(); recovering = false; stallAttempts = 0; }
function stallTimeout() { return document.hidden ? STALL_HIDDEN_MS : STALL_MS; }

function scheduleStall(reason, delay = 1500) {
  if (!currentSong?.link || userPaused || trackTransition || recovering) return;
  clearStall();
  stallTimer = setTimeout(() => { stallTimer = null; doStallRecover(reason); }, Math.max(0, delay));
}

function doStallRecover(reason = "stall") {
  if (!currentSong?.link || userPaused || trackTransition || recovering) return;
  const stale = Date.now() - lastProgressAt > stallTimeout();
  if (!audio.paused && !stale) return;
  if (stallAttempts >= MAX_STALL_RETRIES) {
    recovering = false;
    if (playlist.length > 1) { trackTransition = true; playNext(); }
    else playBtnIcon.textContent = "play_arrow";
    return;
  }
  recovering = true; stallAttempts++; clearStall();

  const resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : wcGetPos();
  const url = getRecoveryUrl(reason);
  if (!url) { recovering = false; if (playlist.length > 1) { trackTransition = true; playNext(); } return; }

  const tryResume = () => {
    try { audio.currentTime = Math.max(0, resumeAt); } catch {}
    updateDisplay();
    resumeAudioCtx().then(() => audio.play())
      .then(() => { recovering = false; lastProgressAt = Date.now(); })
      .catch(() => { recovering = false; scheduleStall(`${reason}-retry`, 2500); });
  };

  try {
    stopFade(); audio.pause();
    audio.src = url; audio.load();
    if (audio.readyState >= 2) { tryResume(); return; }
    const h = () => { audio.removeEventListener("canplay", h); tryResume(); };
    audio.addEventListener("canplay", h, { once: true });
    setTimeout(() => { audio.removeEventListener("canplay", h); if (recovering) { recovering = false; scheduleStall(`${reason}-to`, 2500); } }, 6000);
  } catch { recovering = false; scheduleStall(`${reason}-exc`, 2500); }
}

// ─── BACKGROUND RESUME ────────────────────────────────────────────
function clearBgTimer() { clearTimeout(bgTimer); bgTimer = null; }
function resetBgResume() { clearBgTimer(); bgRetries = 0; }

function scheduleBgResume(reason = "pause", delay = 800) {
  if (userPaused || trackTransition || !currentSong?.link || callInterrupt) return;
  if (bgRetries >= MAX_BG_RETRIES) return;
  clearBgTimer();
  bgTimer = setTimeout(() => { bgTimer = null; attemptBgResume(reason); }, Math.max(0, delay));
}

function attemptBgResume(reason = "pause") {
  if (userPaused || trackTransition || !currentSong?.link || callInterrupt) return;
  if (!audio.paused) { resetBgResume(); return; }
  if (bgRetries >= MAX_BG_RETRIES) return;
  bgRetries++;

  // Re-establish audio src if OS cleared it (common on Samsung, Xiaomi, Oppo, Vivo)
  const ensureSrc = () => {
    const dead = !audio.src || audio.src === window.location.href || audio.src === "about:blank" || audio.networkState === 3;
    if (dead) {
      const url = candidates[candidateIdx] || (currentSong?.link ? normUrl(currentSong.link) : "");
      if (url) { audio.src = url; audio.load(); return true; }
    }
    return false;
  };

  const srcReset = ensureSrc();

  const tryPlay = () => {
    resumeAudioCtx()
      .then(() => audio.play())
      .then(() => {
        resetBgResume();
        playBtnIcon.textContent = "pause";
        lastProgressAt = Date.now(); lastTimeupdateAt = Date.now();
        requestWakeLock(); enableBgMode();
        if (document.hidden) setVol(TARGET_VOL);
        updateMediaSession(currentSong);
        // Restart wall clock from estimated position
        if (!wc.playing && wc.duration > 0) {
          const est = wcGetPos();
          wcStart(est, wc.duration);
        }
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      })
      .catch(() => {
        const backoff = Math.min(7000, 1000 + bgRetries * 600);
        scheduleBgResume(`${reason}-retry`, backoff);
      });
  };

  if (srcReset) {
    const h = () => { audio.removeEventListener("canplay", h); tryPlay(); };
    audio.addEventListener("canplay", h, { once: true });
    setTimeout(() => { audio.removeEventListener("canplay", h); tryPlay(); }, 3000);
  } else {
    tryPlay();
  }
}

// ─── ADVANCE RETRY ────────────────────────────────────────────────
function clearAdvance() { clearTimeout(advanceTimer); advanceTimer = null; }
function scheduleAdvanceRetry() {
  trackTransition = false;
  if (advanceRetries >= MAX_ADV_RETRIES) {
    if (playlist.length > 1) { trackTransition = true; playNext(); }
    else playBtnIcon.textContent = "play_arrow";
    return;
  }
  advanceRetries++;
  clearAdvance();
  advanceTimer = setTimeout(() => { advanceTimer = null; if (audio.paused && playlist[currentIndex]) player.playSong(playlist[currentIndex]); }, 1500);
}

// ─── AUDIO CONTEXT ────────────────────────────────────────────────
function initAudioCtx() {
  if (ctxReady) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC({ latencyHint: "playback" });
    ctxReady = true;
    window._audioCtx = audioCtx;
  } catch {}
}

function resumeAudioCtx() {
  if (!audioCtx) { initAudioCtx(); return Promise.resolve(); }
  if (audioCtx.state === "suspended") return audioCtx.resume().catch(() => {});
  if (audioCtx.state === "closed") { ctxReady = false; initAudioCtx(); return Promise.resolve(); }
  return Promise.resolve();
}

// ─── WAKE LOCK ────────────────────────────────────────────────────
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; }
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {}
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && !audio.paused) requestWakeLock(); });

// ─── CAPACITOR / CORDOVA BACKGROUND MODE ──────────────────────────
function configureBgMode() {
  const bg = window.cordova?.plugins?.backgroundMode;
  if (!bg || bgModeConfigured) return;
  try {
    bg.setDefaults?.({ title: "MusicsAura", text: "Playing…", resume: true, hidden: false, silent: false });
    bg.on?.("activate", () => { try { bg.disableWebViewOptimizations?.(); } catch {} });
    bgModeConfigured = true;
  } catch {}
}
function enableBgMode() {
  const bg = window.cordova?.plugins?.backgroundMode;
  if (!bg) return;
  try {
    configureBgMode();
    bg.setDefaults?.({ title: "MusicsAura", text: currentSong?.title ? `Playing: ${currentSong.title}` : "Playing…", resume: true, hidden: false, silent: false });
    bg.disableWebViewOptimizations?.();
    if (!bg.isEnabled()) bg.enable();
  } catch {}
}
function disableBgMode() {
  const bg = window.cordova?.plugins?.backgroundMode;
  if (!bg) return;
  try { if (bg.isEnabled()) bg.disable(); } catch {}
}
document.addEventListener("deviceready", configureBgMode, { once: true });

// ─── AUDIO SESSION (iOS 16+ / Safari) ─────────────────────────────
if ("audioSession" in navigator) {
  try {
    navigator.audioSession.type = "playback";
    navigator.audioSession.addEventListener("statechange", () => {
      const s = navigator.audioSession.state;
      if (s === "interrupted" || s === "inactive") {
        if (!audio.paused && !userPaused && !trackTransition) shouldResume = true;
        callInterrupt = true;
        if (!audio.paused) {
          clearStall(); recovering = false; interruptedSys = true;
          userPaused = false; trackTransition = false; clearAdvance();
          stopFade(); captureListenTime(); audio.pause(); wcPause();
        }
      } else if (s === "active") {
        if (shouldResume) { shouldResume = false; callInterrupt = false; interruptedSys = false; _play(); }
        else { callInterrupt = false; interruptedSys = false; }
      }
    });
  } catch {}
}

// ─── MEDIA SESSION (Lock screen controls) ─────────────────────────
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play",          () => _play());
  navigator.mediaSession.setActionHandler("pause",         () => _pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => playPrev());
  navigator.mediaSession.setActionHandler("nexttrack",     () => playNext());
  try {
    navigator.mediaSession.setActionHandler("seekbackward", () => seekTo(audio.currentTime - 10));
    navigator.mediaSession.setActionHandler("seekforward",  () => seekTo(audio.currentTime + 10));
    navigator.mediaSession.setActionHandler("seekto", d => {
      const t = Number(d?.seekTime);
      if (!Number.isFinite(t)) return;
      if (d?.fastSeek && typeof audio.fastSeek === "function") { audio.fastSeek(t); updateDisplay(); return; }
      seekTo(t);
    });
    navigator.mediaSession.setActionHandler("stop", () => _pause());
  } catch {}
}

function updateMediaSession(song) {
  if (!song || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:   song.title  || "Unknown",
      artist:  song.artist || "Unknown Artist",
      album:   song.genre  || "MusicsAura",
      artwork: song.thumbnail
        ? [{ src: song.thumbnail, sizes: "512x512", type: "image/jpeg" },
           { src: song.thumbnail, sizes: "256x256", type: "image/jpeg" }]
        : []
    });
    navigator.mediaSession.playbackState = !audio.paused ? "playing" : "paused";
  } catch {}
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
  try {
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    navigator.mediaSession.setPositionState({ duration: dur, playbackRate: 1, position: clamp(audio.currentTime, 0, dur) });
  } catch {}
}

// ─── STATS ────────────────────────────────────────────────────────
function captureListenTime() { if (listenStart) { listenTotal += (Date.now() - listenStart) / 1000; } listenStart = 0; }

function saveLocalStats(mins, songs) {
  try {
    const s = JSON.parse(lsGet(LOCAL_STATS_KEY) || "{}");
    lsSet(LOCAL_STATS_KEY, JSON.stringify({
      minutesListened: Math.max(0, (s.minutesListened || 0) + mins),
      songsPlayed:     Math.max(0, (s.songsPlayed || 0) + songs),
      updatedAt: Date.now()
    }));
  } catch {}
}

async function saveSongStats() {
  if (!currentSong || !auth.currentUser) return;
  captureListenTime();
  if (listenTotal < STATS_MIN_S) return;
  const mins = Math.max(0.5, Math.round((listenTotal / 60) * 2) / 2);
  saveLocalStats(mins, 1);
  try {
    await Promise.race([
      updateDoc(doc(db, "users", auth.currentUser.uid), {
        songsPlayed: increment(1), minutesListened: increment(mins),
        lastPlayed: serverTimestamp(),
        lastActive: new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }) + " IST"
      }),
      new Promise(r => setTimeout(r, 2500))
    ]);
  } catch {}
}

function savePlaybackState() {
  if (!currentSong) return;
  try { lsSet(PLAYBACK_KEY, JSON.stringify({ song: currentSong, isPlaying: !audio.paused, currentTime: audio.currentTime || 0, playlist, currentIndex, savedAt: Date.now() })); } catch {}
}

// ─── PRELOAD NEXT ─────────────────────────────────────────────────
function preloadNext() {
  if (playlist.length < 2) return;
  const nxt = playlist[(currentIndex + 1) % playlist.length];
  if (!nxt?.link) return;
  if (!preloadAudio) {
    preloadAudio = new Audio();
    preloadAudio.crossOrigin = "anonymous"; preloadAudio.preload = "auto"; preloadAudio.volume = 0;
    window._preloadAudio = preloadAudio;
  }
  const url = buildCandidates(nxt.link)[0];
  if (!url || preloadAudio.src === url) return;
  warmOrigin(url); preloadAudio.src = url; preloadAudio.load();
}

// ─── PLAYER UI ────────────────────────────────────────────────────
function showPlayer() {
  playerEl.hidden = false;
  requestAnimationFrame(() => playerEl.classList.add("visible"));
  updateDisplay();
}

function highlightCard(song) {
  document.querySelectorAll(".song-card.is-playing").forEach(c => c.classList.remove("is-playing"));
  if (!song) return;
  document.querySelectorAll(".song-card").forEach(card => {
    const idx = parseInt(card.dataset.index || "-1", 10);
    const cont = card.closest("#grid, #search-grid");
    if (!cont) return;
    if ((cont._songs || [])[idx] === song) card.classList.add("is-playing");
  });
}

function seekTo(t) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const next = clamp(t, 0, audio.duration);
  audio.currentTime = next;
  wcSeek(next); // resync wall clock
  updateDisplay();
}

// ─── PLAY / PAUSE ─────────────────────────────────────────────────
function _play() {
  resetStall(); resetBgResume();
  shouldResume = false; callInterrupt = false; interruptedSys = false;
  userPaused = false; trackTransition = false; clearAdvance();
  resumeAudioCtx().then(() => {
    audio.play()
      .then(() => {
        playBtnIcon.textContent = "pause";
        listenStart = Date.now();
        requestWakeLock(); enableBgMode(); fadeIn();
        updateMediaSession(currentSong);
        if (Number.isFinite(audio.duration) && audio.duration > 0)
          wcStart(audio.currentTime, audio.duration);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      })
      .catch(() => {
        playBtnIcon.textContent = "play_arrow";
        const noSrc = !audio.src || audio.src === window.location.href;
        if (noSrc && currentSong?.link) {
          const url = candidates[candidateIdx] || normUrl(currentSong.link);
          if (url) { audio.src = url; audio.load(); scheduleBgResume("play-nosrc", 800); }
        }
      });
  });
}

function _pause() {
  clearStall(); resetBgResume(); recovering = false;
  shouldResume = false; callInterrupt = false; interruptedSys = false;
  userPaused = true; trackTransition = false; clearAdvance();
  audio.pause();
  playBtnIcon.textContent = "play_arrow";
  stopFade(); releaseWakeLock(); disableBgMode(); captureListenTime(); wcPause();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
}

// ─── NEXT / PREV ──────────────────────────────────────────────────
function playNext() {
  if (!playlist.length) { _pause(); return; }
  userPaused = false; trackTransition = true;
  currentIndex = (currentIndex + 1) % playlist.length;
  player.playSong(playlist[currentIndex]);
}

function playPrev() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0; listenTotal = 0; songCounted = false; listenStart = Date.now(); wcSeek(0); return;
  }
  if (!playlist.length) return;
  userPaused = false; trackTransition = true;
  currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
  player.playSong(playlist[currentIndex]);
}

// ─── REPEAT ───────────────────────────────────────────────────────
const REPEAT_MESSAGES = {
  off: "🔀 Repeat off — playing through playlist",
  one: "🔂 Repeating this song only",
  all: "🔁 Repeating entire playlist"
};

function showRepeatToast(mode) {
  let toast = document.getElementById("repeat-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "repeat-toast";
    toast.style.cssText = [
      "position:fixed",
      "bottom:calc(var(--player-h) + 14px)",
      "left:50%",
      "transform:translateX(-50%) translateY(10px)",
      "background:var(--surface2)",
      "border:1px solid var(--border2)",
      "border-radius:100px",
      "padding:0.55rem 1.2rem",
      "font-size:0.85rem",
      "font-family:DM Sans,sans-serif",
      "color:var(--text-primary)",
      "white-space:nowrap",
      "z-index:9999",
      "opacity:0",
      "transition:opacity .25s,transform .25s",
      "pointer-events:none",
      "box-shadow:0 4px 20px rgba(0,0,0,0.4)"
    ].join(";");
    document.body.appendChild(toast);
  }
  toast.textContent = REPEAT_MESSAGES[mode] || "";
  toast.style.opacity = "1";
  toast.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-50%) translateY(10px)";
  }, 3000);
}

function cycleRepeat() {
  repeatMode = repeatMode === "off" ? "one" : repeatMode === "one" ? "all" : "off";
  repeatIcon.textContent = repeatMode === "one" ? "repeat_one" : "repeat";
  repeatBtnEl.classList.toggle("active", repeatMode !== "off");
  showRepeatToast(repeatMode);
}

// ─── MAIN playSong ────────────────────────────────────────────────
export const player = {
  setPlaylist(songs, index = 0) { playlist = songs; currentIndex = index; },

  async playSong(song) {
    if (!song?.link) return;

    clearAdvance(); resetBgResume(); resetStall(); wcStop();
    shouldResume = false; callInterrupt = false; interruptedSys = false;
    userPaused = false; trackTransition = true; advanceRetries = 0;

    await saveSongStats().catch(() => {});

    stopFade(); audio.pause();

    currentSong = song; listenStart = Date.now(); listenTotal = 0; songCounted = false;

    const url = setCandidates(song.link);
    if (!url || url === "undefined") return;

    // Instant UI
    if (titleEl)  titleEl.textContent  = song.title  || "";
    if (artistEl) artistEl.textContent = song.artist || "";
    if (thumbEl)  thumbEl.style.backgroundImage = song.thumbnail ? `url(${song.thumbnail})` : "";
    updateMediaSession(song); showPlayer(); highlightCard(song); enableBgMode();

    setVol(document.hidden ? TARGET_VOL : 0);
    if (progressFill) progressFill.style.width = "0%";
    seekBar.value = 0; updateDisplay();

    const onStarted = () => {
      trackTransition = false; advanceRetries = 0;
      clearAdvance(); resetBgResume(); resetStall();
      lastProgressAt = Date.now(); lastTimeupdateAt = Date.now();
      // Start wall clock — may need to wait for metadata
      const kickWc = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          wc.duration = audio.duration;
          wcStart(audio.currentTime || 0, audio.duration);
        }
      };
      if (Number.isFinite(audio.duration) && audio.duration > 0) kickWc();
      else audio.addEventListener("loadedmetadata", kickWc, { once: true });
    };

    audio.src = url;
    resumeAudioCtx();
    const p = audio.play();
    playBtnIcon.textContent = "pause";
    requestWakeLock(); enableBgMode();

    p.then(() => {
      onStarted(); fadeIn();
      setTimeout(() => preloadNext(), 1200);
    }).catch(err => {
      if (`${err?.name} ${err?.message}`.toLowerCase().includes("video-only background")) setVol(TARGET_VOL);
      const h = () => {
        audio.play()
          .then(() => { playBtnIcon.textContent = "pause"; fadeIn(); onStarted(); setTimeout(() => preloadNext(), 1200); })
          .catch(() => scheduleAdvanceRetry());
      };
      audio.addEventListener("canplay", h, { once: true });
      setTimeout(() => { audio.removeEventListener("canplay", h); if (audio.paused) scheduleAdvanceRetry(); }, 6000);
    });
  },

  getState() {
    return { currentSong, isPlaying: !audio.paused, currentTime: audio.currentTime, playlist, currentIndex };
  },

  async restoreState(state) {
    if (!state?.currentSong) return;
    playlist = state.playlist || []; currentIndex = state.currentIndex || 0;
    currentSong = state.currentSong;
    const url = setCandidates(state.currentSong.link);
    audio.src = url; audio.currentTime = state.currentTime || 0;
    if (titleEl)  titleEl.textContent  = state.currentSong.title  || "";
    if (artistEl) artistEl.textContent = state.currentSong.artist || "";
    if (thumbEl)  thumbEl.style.backgroundImage = state.currentSong.thumbnail ? `url(${state.currentSong.thumbnail})` : "";
    updateMediaSession(state.currentSong); showPlayer(); highlightCard(state.currentSong); updateDisplay();
    if (state.isPlaying) resumeAudioCtx().then(() => audio.play().catch(() => {}));
  }
};

// ─── CONTROL WIRING ───────────────────────────────────────────────
["click", "touchstart"].forEach(ev =>
  document.addEventListener(ev, () => { resumeAudioCtx(); initAudioCtx(); }, { once: true, passive: true })
);

playBtnEl.onclick    = () => audio.paused ? _play() : _pause();
prevBtn.onclick      = () => playlist.length && playPrev();
nextBtn.onclick      = () => playlist.length && playNext();
repeatBtnEl.onclick  = cycleRepeat;
seekBar.oninput      = () => { if (audio.duration) seekTo((seekBar.value / 100) * audio.duration); };

// ─── AUDIO EVENTS ─────────────────────────────────────────────────
audio.addEventListener("timeupdate", () => {
  if (!audio.duration || isNaN(audio.duration)) return;

  lastTimeupdateAt = Date.now();

  // Track progress (stall detection)
  if (Math.abs(audio.currentTime - lastAudioTime) > 0.1) {
    lastAudioTime = audio.currentTime; lastProgressAt = Date.now();
    if (recovering || stallAttempts > 0) { clearStall(); recovering = false; stallAttempts = 0; }
  }

  updateProgress(); updatePositionState();

  // Keep wall clock in sync while timeupdate is alive (screen on)
  // When screen turns off, wc runs independently from last known sync point
  if (wc.playing) wcSync(audio.currentTime, audio.duration);

  // Ensure wc has duration
  if (wc.duration === 0 && Number.isFinite(audio.duration) && audio.duration > 0) {
    wc.duration = audio.duration;
    if (!wc.playing && !audio.paused) wcStart(audio.currentTime, audio.duration);
  }

  const rem = audio.duration - audio.currentTime;
  // Fade-out near end (visible only)
  if (!document.hidden && !trackTransition && rem <= (FADE_OUT_MS / 1000 + 1.5) && !isFading) fadeOut();

  // Stats count
  if (!songCounted && !audio.paused && listenStart) {
    if (listenTotal + (Date.now() - listenStart) / 1000 >= STATS_MIN_S) songCounted = true;
  }
});

audio.addEventListener("loadedmetadata", () => {
  updateDisplay();
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    wc.duration = audio.duration;
    if (wc.playing) wcStart(audio.currentTime, audio.duration);
  }
});
audio.addEventListener("durationchange", () => {
  updateDisplay();
  if (Number.isFinite(audio.duration) && audio.duration > 0) wc.duration = audio.duration;
});

audio.addEventListener("playing", () => {
  clearStall(); recovering = false; stallAttempts = 0;
  lastProgressAt = Date.now(); lastTimeupdateAt = Date.now();
  playBtnIcon.textContent = "pause";
  if (Number.isFinite(audio.duration) && audio.duration > 0) wcStart(audio.currentTime, audio.duration);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});

audio.addEventListener("waiting", () => { if (!audio.paused && !trackTransition) scheduleStall("waiting", document.hidden ? 6000 : 2000); });
audio.addEventListener("stalled", () => { if (!audio.paused && !trackTransition) scheduleStall("stalled", document.hidden ? 5000 : 1200); });
audio.addEventListener("suspend", () => {
  const thresh = document.hidden ? 12000 : 3500;
  if (!audio.paused && !trackTransition && Date.now() - lastProgressAt > thresh) scheduleStall("suspend", document.hidden ? 7000 : 1500);
});

audio.addEventListener("error", () => {
  if (audio.error?.code === 4) return;
  playBtnIcon.textContent = "play_arrow";
  if (!userPaused) {
    if (audio.error?.code === audio.error?.MEDIA_ERR_NETWORK) scheduleStall("media-net", 400);
    else { trackTransition = true; setTimeout(() => playNext(), 1200); }
  } else { releaseWakeLock(); disableBgMode(); }
});

// SINGLE ended handler (no double-fire)
audio.addEventListener("ended", () => {
  if (wc.fired) return; // Prevent double-fire if wall-clock already handled it
  wc.fired = true;

  stopFade(); resetBgResume(); wcStop();
  userPaused = false; enableBgMode();
  saveSongStats().catch(() => {});

  if (repeatMode === "one") {
    audio.currentTime = 0; listenTotal = 0; songCounted = false; listenStart = Date.now();
    setVol(document.hidden ? TARGET_VOL : 0);
    audio.play()
      .then(() => { playBtnIcon.textContent = "pause"; trackTransition = false; advanceRetries = 0; if (!document.hidden) fadeIn(); if (Number.isFinite(audio.duration)) wcStart(0, audio.duration); })
      .catch(() => { if (playlist[currentIndex]) player.playSong(playlist[currentIndex]); });
  } else {
    setVol(document.hidden ? TARGET_VOL : 0);
    trackTransition = true; playNext();
  }
  updateDisplay();
});

// ─── PAUSE EVENT ──────────────────────────────────────────────────
audio.addEventListener("pause", () => {
  const nat = audio.ended;
  if (nat || trackTransition) { enableBgMode(); return; }

  playBtnIcon.textContent = "play_arrow"; wcPause();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  if (userPaused || interruptedSys) { releaseWakeLock(); disableBgMode(); return; }

  // Near-end fallback
  if (!nat && !trackTransition && Number.isFinite(audio.duration) && audio.duration - audio.currentTime <= 1.5) {
    trackTransition = true; enableBgMode();
    if (repeatMode === "one") player.playSong(currentSong); else playNext();
    return;
  }
  if (callInterrupt) { interruptedSys = true; shouldResume = true; enableBgMode(); return; }

  // Unexpected pause → schedule resume
  shouldResume = true; enableBgMode();
  scheduleBgResume(document.hidden ? "screen-off" : "focus-loss", document.hidden ? 600 : 900);
});

// ─── VISIBILITY CHANGE ────────────────────────────────────────────
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // Screen turning off
    if (!audio.paused) {
      stopFade();
      setVol(TARGET_VOL); // CRITICAL: full volume in background
      enableBgMode();
      // Wall clock already running — will fire advance when song ends
    } else if (!userPaused && !trackTransition && currentSong) {
      scheduleBgResume("vis-hidden", 500);
    }
  } else {
    // Screen turning on
    if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
    if (!audio.paused) {
      requestWakeLock();
      updateMediaSession(currentSong);
      // Re-sync wall clock with actual position
      if (Number.isFinite(audio.duration) && audio.duration > 0)
        wcStart(audio.currentTime, audio.duration);
    }
    if (shouldResume && !userPaused) { shouldResume = false; _play(); }
  }
});

document.addEventListener("resume", () => {
  if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
  if (shouldResume && !userPaused) { shouldResume = false; _play(); }
  else if (!audio.paused) { requestWakeLock(); updateMediaSession(currentSong); }
}, false);

window.addEventListener("pageshow", e => { if (e.persisted && !audio.paused) requestWakeLock(); });
window.addEventListener("focus",    () => { if (shouldResume && !userPaused) { shouldResume = false; _play(); } if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {}); });

// ─── HARD WATCHDOG (3s) ───────────────────────────────────────────
// Belt-and-suspenders: catches any edge case wall clock + wc tick misses
setInterval(() => {
  if (!currentSong) return;

  // Zombie ended
  if (!audio.paused && !trackTransition && audio.ended && playlist.length > 1) {
    trackTransition = true; playNext(); return;
  }

  if (!audio.paused && !trackTransition) {
    if (Math.abs(audio.currentTime - lastAudioTime) > 0.1) {
      lastAudioTime = audio.currentTime; lastProgressAt = Date.now();
      if (recovering || stallAttempts > 0) { clearStall(); recovering = false; stallAttempts = 0; }
    }

    const stale = Date.now() - lastProgressAt > stallTimeout();
    if (!stale) return;

    const rem = Number.isFinite(audio.duration) ? audio.duration - audio.currentTime : Infinity;
    if (rem <= 2 || (!isNaN(audio.duration) && audio.currentTime >= audio.duration - 0.5)) {
      trackTransition = true; playNext(); return;
    }

    // Hidden + high readyState: timeupdate throttled, audio fine
    // Wall clock will handle end — avoid false stall recovery
    if (document.hidden && audio.readyState >= 3 && !audio.seeking) {
      // But if wall clock says song ended and wc.fired hasn't triggered → force advance
      if (wc.duration > 0 && wcGetRemaining() <= 0 && !wc.fired) {
        wc.fired = true; trackTransition = true; playNext();
      }
      return;
    }

    doStallRecover("watchdog");
    return;
  }

  // Paused when shouldn't be
  if (!userPaused && !trackTransition && shouldResume && currentSong) {
    scheduleBgResume("watchdog-paused", 500);
  }
}, 3000);

// ─── AUTH ─────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  if (!user) return (location.href = "auth.html");
  navAvatar.src = user.photoURL
    || `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Ccircle cx='28' cy='28' r='28' fill='%238a5cf6'/%3E%3Ctext x='50%25' y='50%25' font-size='26' fill='white' text-anchor='middle' dy='.35em'%3E${(user.email?.[0] || "U").toUpperCase()}%3C/text%3E%3C/svg%3E`;
  profileBtn.onclick = () => {
    savePlaybackState();
    location.href = isAdmin(user.email) ? "admin-dashboard.html" : "user-dashboard.html";
  };
});

// ─── BEFORE UNLOAD ────────────────────────────────────────────────
window.addEventListener("beforeunload", () => {
  clearStall(); clearBgTimer(); clearAdvance(); wcStop();
  savePlaybackState();
  if (currentSong && listenTotal >= STATS_MIN_S) {
    captureListenTime();
    const m = Math.max(0.5, Math.round((listenTotal / 60) * 2) / 2);
    saveLocalStats(m, 1);
  }
});

window.addEventListener("load", () => { if (playlist.length > 1) setTimeout(() => preloadNext(), 2500); });