// scripts/player.js — MELODYTUNES 2025 - TRUE BACKGROUND PLAYBACK FIX
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

// SMOOTH FADE CONFIGURATION
let fadeInDuration = 15000;
let fadeOutDuration = 8000;
let fadeInterval = null;
let isFading = false;

// CRITICAL: Prevent garbage collection of audio
window.audioElement = audio; // Keep global reference

// RESET FADE STATE ON SONG CHANGE
function resetFadeState() {
  stopFade();
  audio.volume = 0;
}

function startFade(direction) {
  if (isFading) return;
  isFading = true;
  const startVol = direction === "in" ? 0 : 100;
  const endVol = direction === "in" ? 100 : 0;
  const duration = direction === "in" ? fadeInDuration : fadeOutDuration;
  const startTime = Date.now();

  clearInterval(fadeInterval);
  fadeInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    let progress = Math.min(elapsed / duration, 1);
    const eased = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    audio.volume = (startVol + (endVol - startVol) * eased) / 100;

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

// DROPBOX URL FIX
function fixDropboxUrl(url) {
  if (!url.includes('dropbox.com')) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'www.dropbox.com') {
      u.hostname = 'dl.dropboxusercontent.com';
      u.searchParams.set('raw', '1');
      return u.toString();
    }
  } catch (e) {}
  return url + (url.includes('?') ? '&raw=1' : '?raw=1');
}

// Audio Context - WITH GLOBAL REFERENCE TO PREVENT GC
let audioContext = null;
let sourceNode = null;
let gainNode = null;
let hasConnectedSource = false; // FIX: Track if source is already connected

function initAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioContext = new AC({ latencyHint: 'playback' });
    
    // FIX: Only create source node once
    if (!hasConnectedSource) {
      sourceNode = audioContext.createMediaElementSource(audio);
      gainNode = audioContext.createGain();
      
      // Connect: source -> gain -> destination
      sourceNode.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      hasConnectedSource = true;
      
      // Keep global references
      window.audioContext = audioContext;
      window.sourceNode = sourceNode;
      window.gainNode = gainNode;
    }
  }
  
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
}

// Initialize IMMEDIATELY on load
document.addEventListener('DOMContentLoaded', initAudioContext);
['click', 'touchstart', 'touchend'].forEach(evt => 
  document.addEventListener(evt, initAudioContext, { passive: true, once: true })
);

// AGGRESSIVE SERVICE WORKER KEEPALIVE
let swKeepAliveInterval = null;

function startServiceWorkerKeepAlive() {
  if (swKeepAliveInterval) return;
  
  swKeepAliveInterval = setInterval(() => {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ 
        type: 'KEEP_ALIVE',
        playing: !audio.paused,
        currentTime: audio.currentTime,
        song: currentSong?.title
      });
    }
    
    // Also ping audioContext
    if (audioContext?.state === 'suspended') {
      audioContext.resume();
    }
  }, 3000); // Every 3 seconds
}

function stopServiceWorkerKeepAlive() {
  if (swKeepAliveInterval) {
    clearInterval(swKeepAliveInterval);
    swKeepAliveInterval = null;
  }
}

// ENHANCED Media Session - THIS IS CRITICAL FOR BACKGROUND PLAYBACK
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
  } catch (e) {
    console.log('Seek actions not supported');
  }
}

function updateMediaSession(song) {
  if (!song || !('mediaSession' in navigator)) return;
  
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || 'Unknown',
    artist: song.artist || 'Unknown Artist',
    album: song.genre || 'MelodyTunes',
    artwork: song.thumbnail ? [
      { src: song.thumbnail, sizes: '96x96', type: 'image/jpeg' },
      { src: song.thumbnail, sizes: '128x128', type: 'image/jpeg' },
      { src: song.thumbnail, sizes: '192x192', type: 'image/jpeg' },
      { src: song.thumbnail, sizes: '256x256', type: 'image/jpeg' },
      { src: song.thumbnail, sizes: '384x384', type: 'image/jpeg' },
      { src: song.thumbnail, sizes: '512x512', type: 'image/jpeg' }
    ] : []
  });
  
  navigator.mediaSession.playbackState = 'playing';
}

function showPlayer() { 
  playerEl.hidden = false; 
  playerEl.classList.add('visible'); 
}

// PRELOAD NEXT SONG - CRITICAL FOR CONTINUOUS PLAYBACK
let preloadAudio = null;

function preloadNextSong() {
  if (!playlist.length || playlist.length < 2) return;
  
  const nextIndex = (currentIndex + 1) % playlist.length;
  const nextSong = playlist[nextIndex];
  
  if (!nextSong?.link) return;
  
  // Create new audio element for preloading
  if (!preloadAudio) {
    preloadAudio = new Audio();
    preloadAudio.crossOrigin = "anonymous";
    preloadAudio.preload = "auto";
    window.preloadAudio = preloadAudio; // Prevent GC
  }
  
  const fixedUrl = fixDropboxUrl(nextSong.link);
  preloadAudio.src = fixedUrl;
  preloadAudio.load();
  
  console.log('Preloaded next song:', nextSong.title);
}

// MAIN PLAYER
export const player = {
  setPlaylist(songs, index = 0) { 
    playlist = songs; 
    currentIndex = index; 
  },

  async playSong(song) {
    if (!song?.link) {
      console.error('No song link provided:', song);
      return;
    }

    console.log('Playing:', song.title);
    
    // FIX: Stop any ongoing fade and reset volume properly
    stopFade();
    audio.volume = 0; // Start from 0 for fade in
    
    currentSong = song;
    songPlayStartTime = Date.now();
    totalListenedTime = 0;
    hasCountedSong = false;

    initAudioContext();
    
    const fixedUrl = fixDropboxUrl(song.link);
    
    if (!fixedUrl || fixedUrl === 'undefined') {
      console.error('Invalid URL after fix:', fixedUrl);
      return;
    }
    
    // FIX: Properly pause and clear before setting new source
    audio.pause();
    audio.src = ''; // Clear source first
    
    // FIX: Wait a bit for cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // CRITICAL: Set these BEFORE src
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.autoplay = false;
    
    // Set new source
    audio.src = fixedUrl;

    titleEl.textContent = song.title;
    thumbEl.style.backgroundImage = song.thumbnail ? `url(${song.thumbnail})` : '';
    updateMediaSession(song);
    showPlayer();

    audio.load();
    
    // FIX: Better loading and playing logic
    return new Promise((resolve) => {
      let hasResolved = false;
      
      const canPlayHandler = async () => {
        if (hasResolved) return;
        hasResolved = true;
        
        audio.removeEventListener('canplay', canPlayHandler);
        audio.removeEventListener('loadeddata', loadedDataHandler);
        audio.removeEventListener('error', errorHandler);
        
        try {
          // FIX: Ensure AudioContext is ready
          if (audioContext?.state === 'suspended') {
            await audioContext.resume();
          }
          
          await audio.play();
          playBtn.textContent = 'pause'; // FIX: Update button immediately
          startServiceWorkerKeepAlive();
          startFade("in");
          
          // Preload next song after current starts
          setTimeout(() => preloadNextSong(), 5000);
          
          resolve();
        } catch (err) {
          console.error('Play failed:', err);
          // FIX: Retry with user interaction
          setTimeout(async () => {
            try {
              if (audioContext?.state === 'suspended') {
                await audioContext.resume();
              }
              await audio.play();
              playBtn.textContent = 'pause';
              startServiceWorkerKeepAlive();
              startFade("in");
              resolve();
            } catch (e) {
              console.error('Retry failed:', e);
              playBtn.textContent = 'play_arrow'; // FIX: Reset button on failure
              resolve();
            }
          }, 500);
        }
      };
      
      const loadedDataHandler = () => {
        canPlayHandler();
      };
      
      const errorHandler = (e) => {
        if (hasResolved) return;
        hasResolved = true;
        
        audio.removeEventListener('canplay', canPlayHandler);
        audio.removeEventListener('loadeddata', loadedDataHandler);
        audio.removeEventListener('error', errorHandler);
        console.error('Load error:', e);
        playBtn.textContent = 'play_arrow'; // FIX: Reset button on error
        resolve();
      };
      
      audio.addEventListener('canplay', canPlayHandler, { once: true });
      audio.addEventListener('loadeddata', loadedDataHandler, { once: true });
      audio.addEventListener('error', errorHandler, { once: true });
      
      // FIX: Extended timeout for slow networks
      setTimeout(() => {
        if (hasResolved) return;
        hasResolved = true;
        
        audio.removeEventListener('canplay', canPlayHandler);
        audio.removeEventListener('loadeddata', loadedDataHandler);
        audio.removeEventListener('error', errorHandler);
        
        audio.play().then(() => {
          playBtn.textContent = 'pause';
          startServiceWorkerKeepAlive();
          startFade("in");
        }).catch(() => {
          playBtn.textContent = 'play_arrow';
        });
        resolve();
      }, 5000); // Increased timeout
    });
  }
};

// Controls
function play() { 
  initAudioContext();
  
  // FIX: Resume AudioContext before play
  if (audioContext?.state === 'suspended') {
    audioContext.resume();
  }
  
  audio.play().then(() => { 
    playBtn.textContent = 'pause'; 
    songPlayStartTime = Date.now(); 
    startServiceWorkerKeepAlive();
    if (audio.currentTime < 5) startFade("in");
    updateMediaSession(currentSong);
  }).catch(err => {
    console.error('Play error:', err);
    playBtn.textContent = 'play_arrow'; // FIX: Reset on error
  }); 
}

function pause() { 
  audio.pause(); 
  playBtn.textContent = 'play_arrow'; 
  stopFade(); 
  if (songPlayStartTime) totalListenedTime += (Date.now() - songPlayStartTime) / 1000; 
  songPlayStartTime = 0; 
  stopServiceWorkerKeepAlive();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused';
  }
}

playBtn.parentElement.onclick = () => audio.paused ? play() : pause();
prevBtn.onclick = () => playlist.length && playPreviousSong();
nextBtn.onclick = () => playlist.length && playNextSong();
repeatBtn.parentElement.onclick = () => { 
  repeat = repeat === 'off' ? 'one' : 'off'; 
  repeatBtn.textContent = repeat === 'one' ? 'repeat_one' : 'repeat'; 
};

// Update position state for lock screen
audio.ontimeupdate = () => {
  if (!audio.duration || isNaN(audio.duration)) return;
  
  seekBar.value = (audio.currentTime / audio.duration) * 100;
  
  // Update Media Session position state
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: 1,
        position: audio.currentTime
      });
    } catch (e) {
      // Ignore
    }
  }
  
  const remaining = audio.duration - audio.currentTime;
  if (remaining <= 8 && remaining > 7.5 && !isFading) {
    startFade("out");
  }

  if (!hasCountedSong && !audio.paused && songPlayStartTime) {
    const total = totalListenedTime + (Date.now() - songPlayStartTime) / 1000;
    if (total >= 90) hasCountedSong = true;
  }
};

// CRITICAL: Handle song end PROPERLY
audio.onended = () => {
  console.log('Song ended, repeat:', repeat);
  
  // FIX: Stop fade and reset volume
  stopFade();
  audio.volume = 1; // Reset to full volume
  
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
    audio.volume = 0; // Start fade
    audio.play(); 
    playBtn.textContent = 'pause'; 
    startFade("in");
  } else {
    // FIX: Ensure next song plays with clean state
    playNextSong();
  }
};

// Better error handling - DON'T skip song immediately
audio.onerror = (e) => {
  console.error('Audio error:', e, audio.error);
  
  // FIX: Update button state on error
  playBtn.textContent = 'play_arrow';
  
  // Only skip if it's a real error, not just loading
  if (audio.error && audio.error.code === audio.error.MEDIA_ERR_NETWORK) {
    console.log('Network error, retrying current song...');
    
    // Retry current song once
    setTimeout(() => {
      if (currentSong) {
        const retryUrl = fixDropboxUrl(currentSong.link);
        audio.src = retryUrl;
        audio.load();
        audio.play().then(() => {
          playBtn.textContent = 'pause';
        }).catch(() => {
          // If retry fails, skip to next
          setTimeout(() => playNextSong(), 1000);
        });
      }
    }, 1000);
  } else {
    // Other errors - skip to next
    setTimeout(() => playNextSong(), 2000);
  }
};

// Handle visibility changes
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !audio.paused) {
    // Resume on return
    if (audioContext?.state === 'suspended') {
      audioContext.resume();
    }
    audio.play().catch(() => {});
  }
});

// Handle audio interruptions (calls, notifications)
audio.addEventListener('pause', () => {
  // FIX: Only update button if pause wasn't triggered by user
  if (!audio.ended) {
    playBtn.textContent = 'play_arrow';
  }
  
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused';
  }
});

audio.addEventListener('play', () => {
  // FIX: Always update button on play
  playBtn.textContent = 'pause';
  
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
  }
  
  // Resume context if needed
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
    console.log('No playlist');
    return pause(); 
  }
  
  console.log('Playing next song...');
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
    currentIndex = (currentIndex - 1 + playlist.length) % playlist.length; 
    player.playSong(playlist[currentIndex]); 
  }
}

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
  } catch (e) {
    console.error('Stats update error:', e);
  }
}

onAuthStateChanged(auth, user => {
  if (!user) return location.href = "auth.html";
  navAvatar.src = user.photoURL || `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><circle cx='28' cy='28' r='28' fill='%234a90e2'/><text x='50%' y='50%' font-size='28' fill='white' text-anchor='middle' dy='.3em'>${(user.email?.[0] || 'U').toUpperCase()}</text></svg>`;
  profileBtn.onclick = () => location.href = user.email === "prabhakararyan2007@gmail.com" ? "admin-dashboard.html" : "user-dashboard.html";
});

// Keep a heartbeat going to prevent sleep
let heartbeatInterval = setInterval(() => {
  if (!audio.paused) {
    // Touch the audio element
    audio.volume = audio.volume;
    
    // Ping service worker
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'HEARTBEAT',
        time: Date.now()
      });
    }
  }
}, 5000);

// Keep heartbeat alive forever
window.addEventListener('beforeunload', () => {
  clearInterval(heartbeatInterval);
});

console.log('MelodyTunes Player — TRUE BACKGROUND PLAYBACK (Screen Off Compatible)');