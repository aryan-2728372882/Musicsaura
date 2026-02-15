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
const MAX_AUTO_ADVANCE_RETRIES = 4;

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

// DJ Fade settings - OPTIMIZED
let fadeInDuration = 800;
let fadeOutDuration = 3000;
let fadeInterval = null;
let isFading = false;

// Prevent garbage collection
window.audioElement = audio;

// CRITICAL: Set audio element for instant streaming
audio.preload = "metadata";
audio.crossOrigin = "anonymous";
audio.setAttribute("playsinline", "");
audio.setAttribute("webkit-playsinline", "");

// FIXED: Volume fade with proper bounds checking
function startFade(direction) {
  if (isFading) return;
  isFading = true;
  
  const startVol = direction === "in" ? 0.3 : 1.0;
  const endVol = direction === "in" ? 1.0 : 0.01;
  const duration = direction === "in" ? fadeInDuration : fadeOutDuration;
  const startTime = Date.now();

  clearInterval(fadeInterval);
  fadeInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    let progress = Math.min(elapsed / duration, 1);
    
    // Easing functions
    const eased = direction === "in" 
      ? progress * progress // Quadratic
      : 1 - Math.pow(-2 * progress + 2, 3) / 2; // Cubic
    
    // CRITICAL FIX: Clamp volume between 0 and 1
    const newVolume = startVol + (endVol - startVol) * eased;
    audio.volume = Math.max(0, Math.min(1, newVolume));

    if (progress >= 1) {
      clearInterval(fadeInterval);
      isFading = false;
      
      if (direction === "out" && repeat === 'one') {
        audio.currentTime = 0;
        audio.play();
        playBtn.textContent = 'pause';
        startFade("in");
      }
    }
  }, 16);
}

function stopFade() { 
  clearInterval(fadeInterval); 
  isFading = false; 
}

// Dropbox URL fix
function fixDropboxUrl(url) {
  if (!url.includes('dropbox.com')) return url;
  if (url.includes('dl.dropboxusercontent.com') && url.includes('raw=1')) {
    return url;
  }
  
  try {
    const u = new URL(url);
    if (u.hostname === 'www.dropbox.com') {
      u.hostname = 'dl.dropboxusercontent.com';
      u.searchParams.set('raw', '1');
      return u.toString();
    }
  } catch (e) {}
  return url.replace('www.dropbox.com', 'dl.dropboxusercontent.com') + 
         (url.includes('?') ? '&raw=1' : '?raw=1');
}

// Audio Context - Lazy init
let audioContext = null;
let sourceNode = null;
let gainNode = null;
let audioContextInitialized = false;

function initAudioContext() {
  if (audioContextInitialized) return audioContext;
  
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioContext = new AC({ 
      latencyHint: 'interactive',
      sampleRate: 44100
    });
    
    sourceNode = audioContext.createMediaElementSource(audio);
    gainNode = audioContext.createGain();
    gainNode.gain.value = 1;
    
    sourceNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    audioContextInitialized = true;
    window.audioContext = audioContext;
    window.sourceNode = sourceNode;
    window.gainNode = gainNode;
    
    return audioContext;
  } catch (e) {
    console.error('AudioContext init error:', e);
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
  if (swKeepAliveInterval) return;
  
  swKeepAliveInterval = setInterval(() => {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ 
        type: 'KEEP_ALIVE',
        playing: !audio.paused,
        song: currentSong?.title
      });
    }
  }, 3000);
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
  if (!("wakeLock" in navigator)) return;
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
    enableBackgroundMode();
    startServiceWorkerKeepAlive();
  }
});

// Media Session
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => play());
  navigator.mediaSession.setActionHandler('pause', () => pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => playPreviousSong());
  navigator.mediaSession.setActionHandler('nexttrack', () => playNextSong());
  
  try {
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      audio.currentTime = Math.max(0, audio.currentTime - 10);
    });
    navigator.mediaSession.setActionHandler('seekforward', () => {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
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
  
  const fixedUrl = fixDropboxUrl(nextSong.link);
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

    const fixedUrl = fixDropboxUrl(song.link);
    
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
    
    // Set initial volume (clamped)
    audio.volume = 0.3;

    const markTrackStarted = () => {
      trackTransitioning = false;
      autoAdvanceRetryCount = 0;
      clearAutoAdvanceRetry();
    };

    const scheduleRetryForCurrentTrack = () => {
      trackTransitioning = false;

      if (autoAdvanceRetryCount >= MAX_AUTO_ADVANCE_RETRIES) {
        playBtn.textContent = 'play_arrow';
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
        console.error('Preloaded play failed:', err);
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
    
    const fixedUrl = fixDropboxUrl(state.currentSong.link);
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
  }
};

// Controls
function play() { 
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
  userInitiatedPause = true;
  trackTransitioning = false;
  clearAutoAdvanceRetry();
  audio.pause(); 
  playBtn.textContent = 'play_arrow'; 
  stopFade(); 
  releaseWakeLock();
  disableBackgroundMode();
  
  // Track listen time
  if (songPlayStartTime) {
    totalListenedTime += (Date.now() - songPlayStartTime) / 1000;
  }
  songPlayStartTime = 0;
  
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
  
  seekBar.value = (audio.currentTime / audio.duration) * 100;
  
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
  if (remaining <= fadeOutDuration/1000 + 2 && !isFading) {
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
    audio.volume = 0.3;
    
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
    audio.volume = 0.3;
    playNextSong();
  }
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
    setTimeout(() => {
      if (currentSong) {
        const retryUrl = fixDropboxUrl(currentSong.link);
        audio.src = retryUrl;
        audio.play().then(() => {
          playBtn.textContent = 'pause';
          trackTransitioning = false;
          autoAdvanceRetryCount = 0;
          startFade("in");
        }).catch(() => {
          trackTransitioning = true;
          setTimeout(() => playNextSong(), 500);
        });
      }
    }, 500);
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
    audio.play().catch(() => {});
  }
});

// Handle audio interruptions
audio.addEventListener('pause', () => {
  const naturalEnd = audio.ended;
  const shouldKeepBackground = trackTransitioning || naturalEnd;

  if (!naturalEnd) {
    playBtn.textContent = 'play_arrow';
  }

  if (userInitiatedPause && !shouldKeepBackground) {
    releaseWakeLock();
    disableBackgroundMode();
    stopServiceWorkerKeepAlive();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  } else {
    enableBackgroundMode();
    startServiceWorkerKeepAlive();
  }

  userInitiatedPause = false;
});

audio.addEventListener('play', () => {
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
});

seekBar.oninput = () => {
  if (audio.duration) {
    audio.currentTime = (seekBar.value / 100) * audio.duration;
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

// Keep service worker alive
let heartbeatInterval = setInterval(() => {
  if (!audio.paused) {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'HEARTBEAT',
        time: Date.now()
      });
    }
  }
}, 5000);

// FIXED: Save stats and playback state when user leaves (important for PWA)
window.addEventListener('beforeunload', () => {
  clearInterval(heartbeatInterval);
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

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

// Preload first song on page load
window.addEventListener('load', () => {
  if (playlist.length > 0) {
    setTimeout(() => preloadNextSong(), 2000);
  }
});
