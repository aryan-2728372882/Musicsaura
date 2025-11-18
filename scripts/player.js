// scripts/player.js - FINAL CLEAN VERSION: No Errors, No Alerts, Zero Lag
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "firebase/auth";
import { doc, updateDoc, increment, serverTimestamp } from "firebase/firestore";

const audio = document.getElementById('audio');
const titleEl = document.getElementById('player-title');
const thumbEl = document.querySelector('.thumb-placeholder');
const playBtn = document.getElementById('play-pause').querySelector('span');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const repeatBtn = document.getElementById('repeat').querySelector('span');
const seekBar = document.getElementById('seek');
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
let keepAliveInterval = null;

let audioContext = null;
let sourceNode = null;
let gainNode = null;
let isInitialized = false;
let isFading = false;

audio.volume = 1.0;

// ===========================
// AUDIO CONTEXT
// ===========================
function initAudioContext() {
  if (isInitialized) {
    if (audioContext?.state === 'suspended') audioContext.resume();
    return;
  }
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: 'playback' });
    gainNode = audioContext.createGain();
    sourceNode = audioContext.createMediaElementSource(audio);
    sourceNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    isInitialized = true;
  } catch (e) {}
}

function resumeAudioContext() {
  if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
}

['click', 'touchstart', 'keydown'].forEach(evt =>
  document.addEventListener(evt, resumeAudioContext, { passive: true })
);

// ===========================
// SMOOTH FADE
// ===========================
function fadeIn(duration = 7000) {
  if (!gainNode || isFading) return;
  isFading = true;
  gainNode.gain.cancelScheduledValues(audioContext.currentTime);
  gainNode.gain.setValueAtTime(0.001, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(1.0, audioContext.currentTime + duration / 1000);
  setTimeout(() => isFading = false, duration);
}

function fadeOut(duration = 5000, callback) {
  if (!gainNode || isFading) return callback?.();
  isFading = true;
  gainNode.gain.cancelScheduledValues(audioContext.currentTime);
  gainNode.gain.setValueAtTime(gainNode.gain.value, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration / 1000);
  setTimeout(() => {
    isFading = false;
    callback?.();
  }, duration + 100);
}

// ===========================
// KEEP ALIVE (12s = Perfect)
// ===========================
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    if (audioContext?.state === 'suspended') audioContext.resume();
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'KEEP_ALIVE' });
    }
    updatePositionState();
  }, 12000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ===========================
// MEDIA SESSION
// ===========================
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', pause);
  navigator.mediaSession.setActionHandler('nexttrack', playNextSong);
  navigator.mediaSession.setActionHandler('previoustrack', playPreviousSong);
}

function updateMediaSession(song) {
  if (!song || !('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || 'Unknown',
    artist: song.artist || 'Unknown Artist',
    album: song.genre || 'MelodyTunes',
    artwork: song.thumbnail ? [{ src: song.thumbnail, sizes: '512x512', type: 'image/jpeg' }] : []
  });
}

function updatePositionState() {
  if ('setPositionState' in navigator.mediaSession && audio.duration) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: audio.currentTime
      });
    } catch (e) {}
  }
}

function setPlaybackState(state) {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
}

// ===========================
// PLAYER UI
// ===========================
function showPlayer() {
  playerEl.hidden = false;
  playerEl.classList.add('visible');
}

function hidePlayer() {
  playerEl.classList.remove('visible');
  setTimeout(() => { if (!audio.src) playerEl.hidden = true; }, 300);
}

// ===========================
// MAIN PLAYER — CLEAN & SILENT
// ===========================
export const player = {
  setPlaylist(songs, index = 0) {
    playlist = songs;
    currentIndex = index;
  },

  async playSong(song) {
    if (!song?.link) return;

    currentSong = song;
    songPlayStartTime = Date.now();
    totalListenedTime = 0;
    hasCountedSong = false;

    initAudioContext();
    audio.crossOrigin = 'anonymous';
    audio.src = song.link;

    titleEl.textContent = song.title;
    thumbEl.style.backgroundImage = song.thumbnail ? `url(${song.thumbnail})` : '';
    updateMediaSession(song);
    showPlayer();

    audio.load();
    audio.play().then(() => {
      playBtn.textContent = 'pause';
      setPlaybackState('playing');
      startKeepAlive();
      fadeIn(7000);
    }).catch(() => {
      // Silently retry once
      setTimeout(() => {
        audio.play().then(() => {
          playBtn.textContent = 'pause';
          startKeepAlive();
          fadeIn(7000);
        });
      }, 300);
    });
  }
};

// ===========================
// PLAY / PAUSE — Always Correct
// ===========================
function play() {
  resumeAudioContext();
  audio.play().then(() => {
    playBtn.textContent = 'pause';
    songPlayStartTime = Date.now();
    startKeepAlive();
    setPlaybackState('playing');
    if (audio.currentTime < 5) fadeIn(6000);
  });
}

function pause() {
  audio.pause();
  playBtn.textContent = 'play_arrow';
  if (songPlayStartTime) {
    totalListenedTime += (Date.now() - songPlayStartTime) / 1000;
    songPlayStartTime = 0;
  }
  stopKeepAlive();
  setPlaybackState('paused');
}

playBtn.parentElement.onclick = () => audio.paused ? play() : pause();
prevBtn.onclick = () => playlist.length && playPreviousSong();
nextBtn.onclick = () => playlist.length && playNextSong();

repeatBtn.parentElement.onclick = () => {
  repeat = repeat === 'off' ? 'one' : 'off';
  repeatBtn.textContent = repeat === 'one' ? 'repeat_one' : 'repeat';
};

// ===========================
// AUDIO EVENTS
// ===========================
audio.ontimeupdate = () => {
  if (!audio.duration) return;
  seekBar.value = (audio.currentTime / audio.duration) * 100;
  updatePositionState();

  const remaining = audio.duration - audio.currentTime;
  if (remaining <= 12 && remaining > 11 && !isFading) {
    fadeOut(5000, () => {
      if (repeat === 'one') {
        audio.currentTime = 0;
        audio.play();
        playBtn.textContent = 'pause';
        fadeIn(7000);
      }
    });
  }

  if (!hasCountedSong && !audio.paused && songPlayStartTime) {
    const total = totalListenedTime + (Date.now() - songPlayStartTime) / 1000;
    if (total >= 90) hasCountedSong = true;
  }
};

audio.onended = () => {
  if (songPlayStartTime) totalListenedTime += (Date.now() - songPlayStartTime) / 1000;

  if (hasCountedSong && totalListenedTime >= 90) {
    const minutes = Math.round((totalListenedTime / 60) * 2) / 2;
    updateUserStats(minutes);
  }

  if (repeat === 'one') {
    audio.currentTime = 0;
    songPlayStartTime = Date.now();
    totalListenedTime = 0;
    hasCountedSong = false;
    audio.play();
    playBtn.textContent = 'pause';
    fadeIn(7000);
  } else {
    setTimeout(playNextSong, 400);
  }
};

audio.onerror = () => setTimeout(playNextSong, 2000);

seekBar.oninput = () => {
  if (audio.duration) {
    audio.currentTime = (seekBar.value / 100) * audio.duration;
    updatePositionState();
  }
};

// ===========================
// PLAYLIST
// ===========================
function playNextSong() {
  if (!playlist.length) return pause();
  currentIndex = (currentIndex + 1) % playlist.length;
  player.playSong(playlist[currentIndex]);
}

function playPreviousSong() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    totalListenedTime = 0;
    hasCountedSong = false;
    songPlayStartTime = Date.now();
  } else if (playlist.length) {
    currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
    player.playSong(playlist[currentIndex]);
  }
}

// ===========================
// FIREBASE STATS
// ===========================
async function updateUserStats(minutes) {
  const user = auth.currentUser;
  if (!user || !currentSong) return;
  try {
    await updateDoc(doc(db, "users", user.uid), {
      songsPlayed: increment(1),
      minutesListened: increment(minutes),
      lastPlayed: serverTimestamp(),
      lastActive: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) + " IST"
    });
  } catch (e) {}
}

// ===========================
// AUTH
// ===========================
onAuthStateChanged(auth, user => {
  if (!user) return location.href = "auth.html";
  navAvatar.src = user.photoURL || `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><circle cx='28' cy='28' r='28' fill='%234a90e2'/><text x='50%' y='50%' font-size='28' fill='white' text-anchor='middle' dy='.3em'>${(user.email?.[0] || 'U').toUpperCase()}</text></svg>`;
  profileBtn.onclick = () => location.href = user.email === "prabhakararyan2007@gmail.com" ? "admin-dashboard.html" : "user-dashboard.html";
});

console.log('MelodyTunes Player — Clean, Silent, Perfect');