// scripts/player.js — MusicsAura 3.0 Pro Audio Engine (Gapless, Crossfade & 5-Band Web Audio Studio)
import {
  auth, db,
  doc, updateDoc, increment, serverTimestamp
} from "./firebase-config.js";

// ─── DUAL AUDIO ENGINE FOR SEAMLESS CROSSFADE ──────────────────────
let activeAudio  = new Audio();
let standbyAudio = new Audio();

activeAudio.preload   = "auto";
activeAudio.crossOrigin = "anonymous";
activeAudio.setAttribute("playsinline", "");
activeAudio.setAttribute("webkit-playsinline", "");

standbyAudio.preload  = "auto";
standbyAudio.crossOrigin = "anonymous";
standbyAudio.setAttribute("playsinline", "");
standbyAudio.setAttribute("webkit-playsinline", "");

window._musicsaura_audio = activeAudio;

// ─── DOM ELEMENTS ──────────────────────────────────────────────────
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

// ─── CONSTANTS & KEYS ──────────────────────────────────────────────
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
let isCrossfading     = false;

// Audio Settings
let crossfadeSeconds  = parseFloat(localStorage.getItem(CROSSFADE_STORAGE_KEY)) || 4; // default 4s crossfade
let playbackRate      = parseFloat(localStorage.getItem(SPEED_STORAGE_KEY)) || 1.0;
let masterVolume      = clamp(parseFloat(localStorage.getItem(VOLUME_STORAGE_KEY)) || 1.0, 0, 1);

// Web Audio API & 5-Band Equalizer Nodes
let audioCtx          = null;
let subBassFilter     = null; // 60Hz
let bassFilter        = null; // 250Hz
let midFilter         = null; // 1000Hz
let presenceFilter    = null; // 3500Hz
let trebleFilter      = null; // 10000Hz
let analyserNode      = null;
let sourceA           = null;
let sourceB           = null;
let wakeLock          = null;

// Stats tracking
let playSessionStart  = 0;
let accumulatedPlaySec= 0;
let hasRecordedStat   = false;

// Sleep timer
let sleepTimerId      = null;

// State listeners
const stateListeners  = new Set();

// ─── UTILITIES ─────────────────────────────────────────────────────
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const totalSec = Math.floor(seconds);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function normalizeUrl(url) {
  if (!url) return "";
  let clean = url.trim();
  if (clean.startsWith("http://")) clean = "https://" + clean.slice(7);
  try {
    const u = new URL(clean);
    const host = u.hostname.toLowerCase();
    if (host.includes("dropbox.com")) {
      if (host === "www.dropbox.com") u.hostname = "dl.dropboxusercontent.com";
      u.searchParams.set("raw", "1");
      u.searchParams.delete("dl");
      return u.toString();
    }
    if (host.includes("filegarden.com") || host.includes("supabase.co")) {
      u.searchParams.delete("download");
      u.searchParams.delete("dl");
      return u.toString();
    }
    return u.toString();
  } catch {
    return clean;
  }
}

// ─── WEB AUDIO API 5-BAND EQUALIZER & VISUALIZER SETUP ─────────────
function initAudioContext() {
  if (audioCtx) return audioCtx;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    audioCtx = new AudioContextClass();

    // 1. Sub-Bass (60 Hz Lowshelf)
    subBassFilter = audioCtx.createBiquadFilter();
    subBassFilter.type = "lowshelf";
    subBassFilter.frequency.value = 60;

    // 2. Bass (250 Hz Peaking)
    bassFilter = audioCtx.createBiquadFilter();
    bassFilter.type = "peaking";
    bassFilter.frequency.value = 250;
    bassFilter.Q.value = 1.0;

    // 3. Mid / Vocals (1000 Hz Peaking)
    midFilter = audioCtx.createBiquadFilter();
    midFilter.type = "peaking";
    midFilter.frequency.value = 1000;
    midFilter.Q.value = 1.0;

    // 4. Presence / Crispness (3500 Hz Peaking)
    presenceFilter = audioCtx.createBiquadFilter();
    presenceFilter.type = "peaking";
    presenceFilter.frequency.value = 3500;
    presenceFilter.Q.value = 1.0;

    // 5. Treble / Air (10000 Hz Highshelf)
    trebleFilter = audioCtx.createBiquadFilter();
    trebleFilter.type = "highshelf";
    trebleFilter.frequency.value = 10000;

    // Real-time Analyser
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 128;
    analyserNode.smoothingTimeConstant = 0.8;

    // Connect Filter Chain: SubBass -> Bass -> Mid -> Presence -> Treble -> Analyser -> Speakers
    subBassFilter.connect(bassFilter);
    bassFilter.connect(midFilter);
    midFilter.connect(presenceFilter);
    presenceFilter.connect(trebleFilter);
    trebleFilter.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    // Route active and standby audio elements through the equalizer filter chain!
    if (!sourceA && activeAudio) {
      sourceA = audioCtx.createMediaElementSource(activeAudio);
      sourceA.connect(subBassFilter);
    }
    if (!sourceB && standbyAudio) {
      sourceB = audioCtx.createMediaElementSource(standbyAudio);
      sourceB.connect(subBassFilter);
    }

    // Apply saved preset values quietly
    const savedPreset = localStorage.getItem(EQ_PRESET_KEY) || "flat";
    applyPresetGains(savedPreset);

    return audioCtx;
  } catch (e) {
    console.warn("Web Audio setup:", e);
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

async function unlockAudioContext() {
  if (!audioCtx) {
    initAudioContext();
  }
  if (audioCtx && audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch {}
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

// ─── MEDIA SESSION API ────────────────────────────────────────────
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
    navigator.mediaSession.setActionHandler("seekforward", () => player.seek((activeAudio.currentTime || 0) + 10));
    navigator.mediaSession.setActionHandler("seekbackward", () => player.seek((activeAudio.currentTime || 0) - 10));
    navigator.mediaSession.setActionHandler("stop", () => player.pause());
  } catch {}
}

function updateMediaSession(song) {
  if (!("mediaSession" in navigator) || !song) return;

  const artworkList = [];
  if (song.thumbnail) {
    [96, 128, 192, 256, 384, 512].forEach((size) => {
      artworkList.push({
        src: song.thumbnail,
        sizes: `${size}x${size}`,
        type: "image/jpeg"
      });
    });
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || "MusicsAura Track",
    artist: song.artist || "MusicsAura Artist",
    album: song.genre ? `${song.genre.toUpperCase()} Hits` : "MusicsAura",
    artwork: artworkList
  });

  navigator.mediaSession.playbackState = !activeAudio.paused ? "playing" : "paused";
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
  try {
    if (Number.isFinite(activeAudio.duration) && activeAudio.duration > 0) {
      navigator.mediaSession.setPositionState({
        duration: activeAudio.duration,
        playbackRate: activeAudio.playbackRate || 1,
        position: clamp(activeAudio.currentTime, 0, activeAudio.duration)
      });
    }
  } catch {}
}

// ─── STATS RECORDER ───────────────────────────────────────────────
function capturePlaySeconds() {
  if (playSessionStart > 0) {
    accumulatedPlaySec += (Date.now() - playSessionStart) / 1000;
    playSessionStart = 0;
  }
}

async function flushStatsToFirebase() {
  capturePlaySeconds();
  if (!currentSong || accumulatedPlaySec < STATS_MIN_PLAY_SECONDS || hasRecordedStat) return;

  hasRecordedStat = true;
  const minutes = Math.max(0.5, Math.round((accumulatedPlaySec / 60) * 2) / 2);

  try {
    const statsStr = localStorage.getItem("musicsaura_local_stats") || "{}";
    const stats = JSON.parse(statsStr);
    stats.songsPlayed = (stats.songsPlayed || 0) + 1;
    stats.minutesListened = (stats.minutesListened || 0) + minutes;
    localStorage.setItem("musicsaura_local_stats", JSON.stringify(stats));
  } catch {}

  if (auth.currentUser) {
    try {
      const userRef = doc(db, "users", auth.currentUser.uid);
      await updateDoc(userRef, {
        songsPlayed: increment(1),
        minutesListened: increment(minutes),
        lastPlayed: serverTimestamp(),
        lastActive: new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }) + " IST"
      });
    } catch (err) {
      console.warn("Could not sync play stats:", err);
    }
  }
}

// ─── GAPLESS PRELOADER & STANDBY WARMUP ────────────────────────────
function warmupStandbyNextTrack() {
  if (playlist.length <= 1) return;

  // On slow 2G/3G networks or Data Saver mode, preserve bandwidth exclusively for the active song!
  const conn = navigator.connection;
  if (conn && (conn.saveData || conn.effectiveType === "2g" || conn.effectiveType === "slow-2g")) {
    standbyAudio.preload = "none";
    return;
  }

  const nextIdx = (currentIndex + 1) % playlist.length;
  const nextSong = playlist[nextIdx];
  if (!nextSong?.link) return;

  const url = normalizeUrl(nextSong.link);
  if (standbyAudio.src !== url) {
    standbyAudio.src = url;
    standbyAudio.preload = "metadata";
    standbyAudio.volume = 0;
  }
}

// ─── CROSSFADE TRANSITION CONTROLLER ──────────────────────────────
function startCrossfadeTransition() {
  if (isCrossfading || playlist.length <= 1 || repeatMode === "one") return;
  isCrossfading = true;

  const nextIdx = (currentIndex + 1) % playlist.length;
  const nextSong = playlist[nextIdx];
  if (!nextSong?.link) {
    isCrossfading = false;
    return;
  }

  const nextUrl = normalizeUrl(nextSong.link);
  if (standbyAudio.src !== nextUrl) {
    standbyAudio.src = nextUrl;
  }

  standbyAudio.currentTime = 0;
  standbyAudio.volume = 0;
  standbyAudio.playbackRate = playbackRate;

  // Start fading in standby and fading out active
  standbyAudio.play().then(() => {
    const fadeSteps = 20;
    const stepTime = (crossfadeSeconds * 1000) / fadeSteps;
    let step = 0;

    const fadeTimer = setInterval(() => {
      step++;
      const progress = step / fadeSteps;

      activeAudio.volume = clamp(masterVolume * (1 - progress), 0, 1);
      standbyAudio.volume = clamp(masterVolume * progress, 0, 1);

      if (step >= fadeSteps) {
        clearInterval(fadeTimer);

        // Swap primary & standby audio references
        activeAudio.pause();
        activeAudio.currentTime = 0;
        activeAudio.volume = masterVolume;

        const temp = activeAudio;
        activeAudio = standbyAudio;
        standbyAudio = temp;
        window._musicsaura_audio = activeAudio;

        // Update state to next song
        currentIndex = nextIdx;
        currentSong = nextSong;
        isCrossfading = false;

        wireAudioEvents(activeAudio);
        updateMediaSession(currentSong);
        updateUI();

        // Warm up the new standby
        warmupStandbyNextTrack();
      }
    }, stepTime);
  }).catch((e) => {
    console.warn("Crossfade play:", e);
    isCrossfading = false;
  });
}

// ─── UI SYNC & NOTIFICATIONS ──────────────────────────────────────
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

  if (titleEl) titleEl.textContent = currentSong?.title || "Select a track";
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
    playBtnIcon.textContent = !activeAudio.paused ? "pause" : "play_arrow";
  }

  if (repeatIcon && repeatBtnEl) {
    repeatIcon.textContent = repeatMode === "one" ? "repeat_one" : "repeat";
    repeatBtnEl.classList.toggle("active", repeatMode !== "off");
  }

  if (shuffleBtnEl) {
    shuffleBtnEl.classList.toggle("active", isShuffle);
  }

  // Active song card indicator
  document.querySelectorAll(".song-card").forEach((card) => {
    const isPlayingThis = currentSong && card.dataset.id === (currentSong.id || currentSong.link);
    card.classList.toggle("is-playing", !!isPlayingThis);
  });

  emitStateChange();
}

function updateProgress() {
  if (isSeeking) return;
  const cur = activeAudio.currentTime || 0;
  const dur = activeAudio.duration || 0;

  if (currentTimeEl) currentTimeEl.textContent = formatTime(cur);
  if (durationEl) durationEl.textContent = formatTime(dur);

  if (Number.isFinite(dur) && dur > 0) {
    const pct = clamp((cur / dur) * 100, 0, 100);
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (seekBar) seekBar.value = pct;
  } else {
    if (progressFill) progressFill.style.width = "0%";
    if (seekBar) seekBar.value = 0;
  }
}

// ─── ATTACH AUDIO LISTENERS ───────────────────────────────────────
function wireAudioEvents(audioNode) {
  audioNode.onplay = () => {
    userPaused = false;
    playSessionStart = Date.now();
    acquireWakeLock();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    updateUI();
  };

  audioNode.onpause = () => {
    capturePlaySeconds();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    updateUI();
    if (userPaused) releaseWakeLock();
  };

  audioNode.ontimeupdate = () => {
    updateProgress();
    updatePositionState();

    const dur = audioNode.duration;
    const cur = audioNode.currentTime;

    // Trigger crossfade when remaining time matches crossfadeSeconds
    if (crossfadeSeconds > 0 && dur && (dur - cur <= crossfadeSeconds) && !isCrossfading && playlist.length > 1 && repeatMode !== "one") {
      startCrossfadeTransition();
    } else if (dur && (dur - cur <= 12) && !isCrossfading) {
      warmupStandbyNextTrack();
    }

    // Check stats threshold
    if (playSessionStart > 0 && !hasRecordedStat) {
      const currentSessionSec = (Date.now() - playSessionStart) / 1000;
      if (accumulatedPlaySec + currentSessionSec >= STATS_MIN_PLAY_SECONDS) {
        flushStatsToFirebase();
      }
    }
  };

  audioNode.onended = () => {
    if (isCrossfading) return;
    flushStatsToFirebase();

    if (repeatMode === "one") {
      audioNode.currentTime = 0;
      audioNode.play().catch(() => {});
    } else {
      player.next(true);
    }
  };

  audioNode.onerror = (e) => {
    console.warn("Audio node error:", e, audioNode.error);
    if (!userPaused && playlist.length > 1 && !isCrossfading) {
      setTimeout(() => player.next(true), 1000);
    }
  };
}

wireAudioEvents(activeAudio);

// Restore initial volume
activeAudio.volume = masterVolume;
standbyAudio.volume = 0;
if (volumeSlider) volumeSlider.value = Math.round(masterVolume * 100);

// ─── CORE PLAYER API ──────────────────────────────────────────────
export const player = {
  subscribe(fn) {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  },

  getState() {
    return {
      currentSong,
      isPlaying: !activeAudio.paused,
      currentTime: activeAudio.currentTime || 0,
      duration: activeAudio.duration || 0,
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
    warmupStandbyNextTrack();
  },

  async playSong(song, playlistContext = null, index = null) {
    if (!song || !song.link) return;

    await flushStatsToFirebase();
    hasRecordedStat = false;
    accumulatedPlaySec = 0;
    playSessionStart = 0;
    isCrossfading = false;

    currentSong = song;

    if (playlistContext) {
      if (index !== null) {
        player.setPlaylist(playlistContext, index);
      } else {
        const found = playlistContext.findIndex((s) => (s.id || s.link) === (song.id || song.link));
        player.setPlaylist(playlistContext, found >= 0 ? found : 0);
      }
    }

    const cleanUrl = normalizeUrl(song.link);
    if (!cleanUrl) return;

    let streamUrl = cleanUrl;
    try {
      if ("caches" in window) {
        const cache = await caches.open("musicsaura-pwa-storage-v1");
        const cachedRes = await cache.match(cleanUrl);
        if (cachedRes) {
          const blob = await cachedRes.blob();
          streamUrl = URL.createObjectURL(blob);
        }
      }
    } catch (e) {
      console.warn("Offline cache check:", e);
    }

    activeAudio.src = streamUrl;
    activeAudio.playbackRate = playbackRate;
    activeAudio.volume = masterVolume;
    activeAudio.load();

    await unlockAudioContext();
    updateMediaSession(song);
    updateUI();

    try {
      await activeAudio.play();
    } catch (err) {
      console.warn("Playback gesture required:", err);
      updateUI();
    }

    warmupStandbyNextTrack();
  },

  async play() {
    if (!currentSong && playlist.length > 0) {
      return player.playSong(playlist[currentIndex]);
    }
    userPaused = false;
    await unlockAudioContext();
    try {
      await activeAudio.play();
    } catch (err) {
      console.warn("Play error:", err);
    }
    updateUI();
  },

  pause() {
    userPaused = true;
    activeAudio.pause();
    updateUI();
  },

  togglePlay() {
    if (activeAudio.paused) {
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
    if (activeAudio.currentTime > 3.5) {
      activeAudio.currentTime = 0;
      updateProgress();
      return;
    }
    if (!playlist.length) return;
    currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
    player.playSong(playlist[currentIndex]);
  },

  seek(seconds) {
    if (!Number.isFinite(activeAudio.duration) || activeAudio.duration <= 0) return;
    const clamped = clamp(seconds, 0, activeAudio.duration);
    activeAudio.currentTime = clamped;
    updateProgress();
    updatePositionState();
  },

  setVolume(vol) {
    masterVolume = clamp(vol, 0, 1);
    activeAudio.volume = masterVolume;
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
      activeAudio._prevVol = masterVolume;
      player.setVolume(0);
    } else {
      player.setVolume(activeAudio._prevVol || 1.0);
    }
  },

  setCrossfade(sec) {
    crossfadeSeconds = clamp(parseFloat(sec) || 0, 0, 30);
    localStorage.setItem(CROSSFADE_STORAGE_KEY, String(crossfadeSeconds));
    player.showToast(crossfadeSeconds === 0 ? "⚡ Gapless mode active" : `🎚️ Crossfade set to ${crossfadeSeconds}s`);
  },

  setPlaybackSpeed(speed) {
    playbackRate = clamp(parseFloat(speed) || 1.0, 0.5, 2.0);
    activeAudio.playbackRate = playbackRate;
    standbyAudio.playbackRate = playbackRate;
    localStorage.setItem(SPEED_STORAGE_KEY, String(playbackRate));
    player.showToast(`⏩ Playback speed: ${playbackRate}x`);
  },

  setEqualizerPreset(presetName) {
    initAudioContext();
    if (!subBassFilter || !bassFilter || !midFilter || !presenceFilter || !trebleFilter) return;

    localStorage.setItem(EQ_PRESET_KEY, presetName);

    switch (presetName.toLowerCase()) {
      case "bass": // Mega Sub-Bass & Low-End Punch
        subBassFilter.gain.value = 11;
        bassFilter.gain.value = 7;
        midFilter.gain.value = 0;
        presenceFilter.gain.value = 2;
        trebleFilter.gain.value = 3;
        player.showToast("🔥 Bass Boost Active (+11dB Sub-Bass)");
        break;
      case "vocal": // Crystal Vocals
        subBassFilter.gain.value = -3;
        bassFilter.gain.value = -1;
        midFilter.gain.value = 8;
        presenceFilter.gain.value = 5;
        trebleFilter.gain.value = 2;
        player.showToast("🎤 Vocal Focus Active");
        break;
      case "acoustic": // Natural Warmth
        subBassFilter.gain.value = 3;
        bassFilter.gain.value = 4;
        midFilter.gain.value = 3;
        presenceFilter.gain.value = 4;
        trebleFilter.gain.value = 5;
        player.showToast("🎸 Acoustic Warmth Active");
        break;
      case "electronic": // Club & EDM
        subBassFilter.gain.value = 10;
        bassFilter.gain.value = 6;
        midFilter.gain.value = -1;
        presenceFilter.gain.value = 4;
        trebleFilter.gain.value = 7;
        player.showToast("🪩 Club / EDM Profile Active");
        break;
      case "rock": // Rock Swag
        subBassFilter.gain.value = 7;
        bassFilter.gain.value = 5;
        midFilter.gain.value = 3;
        presenceFilter.gain.value = 6;
        trebleFilter.gain.value = 4;
        player.showToast("⚡ Rock & Swag Profile Active");
        break;
      default: // Pure flat reference
        subBassFilter.gain.value = 0;
        bassFilter.gain.value = 0;
        midFilter.gain.value = 0;
        presenceFilter.gain.value = 0;
        trebleFilter.gain.value = 0;
        player.showToast("🎧 Pure Flat Studio Reference");
        break;
    }
  },

  setEqualizerCustom(subBass, bass, mid, presence, treble) {
    initAudioContext();
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
    warmupStandbyNextTrack();
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

// ─── HARDWARE / EVENT BINDINGS ────────────────────────────────────
initMediaSession();

["click", "touchstart", "keydown"].forEach((evt) => {
  document.addEventListener(evt, () => unlockAudioContext(), { once: true, passive: true });
});

if (playBtnEl) playBtnEl.onclick = () => player.togglePlay();
if (prevBtn) prevBtn.onclick = () => player.prev();
if (nextBtn) nextBtn.onclick = () => player.next();
if (repeatBtnEl) repeatBtnEl.onclick = () => player.cycleRepeat();
if (shuffleBtnEl) shuffleBtnEl.onclick = () => player.toggleShuffle();

if (seekBar) {
  seekBar.addEventListener("input", () => {
    isSeeking = true;
    if (Number.isFinite(activeAudio.duration) && activeAudio.duration > 0) {
      const sec = (seekBar.value / 100) * activeAudio.duration;
      if (progressFill) progressFill.style.width = `${seekBar.value}%`;
      if (currentTimeEl) currentTimeEl.textContent = formatTime(sec);
    }
  });

  seekBar.addEventListener("change", () => {
    isSeeking = false;
    if (Number.isFinite(activeAudio.duration) && activeAudio.duration > 0) {
      const sec = (seekBar.value / 100) * activeAudio.duration;
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
  if (document.hidden) {
    if (!activeAudio.paused) acquireWakeLock();
  } else {
    if (!activeAudio.paused) updateMediaSession(currentSong);
  }
});