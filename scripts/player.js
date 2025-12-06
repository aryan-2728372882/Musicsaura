// scripts/player.js — Musicsaura 2025 - Fixed AudioContext
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

// DJ Fade settings
let fadeInDuration = 10000;
let fadeOutDuration = 5000;
let fadeInterval = null;
let isFading = false;

// Prevent garbage collection
window.audioElement = audio;

// Reset fade state
function resetFadeState() {
  stopFade();
  audio.volume = 0.01;
}

function startFade(direction) {
  if (isFading) return;
  isFading = true;
  
  const startVol = direction === "in" ? 0.01 : 1;
  const endVol = direction === "in" ? 1 : 0.01;
  const duration = direction === "in" ? fadeInDuration : fadeOutDuration;
  const startTime = Date.now();

  clearInterval(fadeInterval);
  fadeInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    let progress = Math.min(elapsed / duration, 1);
    
    const eased = progress < 0.5 
      ? 4 * progress * progress * progress 
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    
    audio.volume = startVol + (endVol - startVol) * eased;

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

// Audio Context - FIXED: Only create on user gesture
let audioContext = null;
let sourceNode = null;
let gainNode = null;
let audioContextInitialized = false;

// This function only creates AudioContext AFTER user interaction
function initAudioContext() {
  if (audioContextInitialized) return audioContext;
  
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioContext = new AC({ 
      latencyHint: 'interactive', // Changed from 'playback'
      sampleRate: 44100
    });
    
    // Create nodes only once
    sourceNode = audioContext.createMediaElementSource(audio);
    gainNode = audioContext.createGain();
    gainNode.gain.value = 1;
    
    sourceNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    audioContextInitialized = true;
    
    // Store references
    window.audioContext = audioContext;
    window.sourceNode = sourceNode;
    window.gainNode = gainNode;
    
    console.log('AudioContext initialized');
    return audioContext;
  } catch (e) {
    console.error('AudioContext init error:', e);
    return null;
  }
}

// Resume AudioContext (call this on user gestures)
function resumeAudioContext() {
  if (!audioContext) {
    // Create AudioContext if it doesn't exist
    initAudioContext();
    return Promise.resolve();
  }
  
  if (audioContext.state === 'suspended') {
    return audioContext.resume().then(() => {
      console.log('AudioContext resumed');
    }).catch(err => {
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

// Preload next song
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

// MAIN PLAYER
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
    
    stopFade();
    audio.pause();
    
    currentSong = song;
    songPlayStartTime = Date.now();
    totalListenedTime = 0;
    hasCountedSong = false;

    const fixedUrl = fixDropboxUrl(song.link);
    
    if (!fixedUrl || fixedUrl === 'undefined') {
      console.error('Invalid URL:', fixedUrl);
      return;
    }
    
    audio.volume = 0.01;
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.currentTime = 0;
    audio.src = fixedUrl;

    titleEl.textContent = song.title;
    thumbEl.style.backgroundImage = song.thumbnail ? `url(${song.thumbnail})` : '';
    updateMediaSession(song);
    showPlayer();

    audio.load();
    
    return new Promise((resolve) => {
      let hasResolved = false;
      
      const attemptPlay = async () => {
        try {
          // Resume AudioContext if needed (this will work because it's triggered by play())
          if (audioContext && audioContext.state === 'suspended') {
            await audioContext.resume();
          }
          
          await audio.play();
          playBtn.textContent = 'pause';
          startServiceWorkerKeepAlive();
          startFade("in");
          
          setTimeout(() => preloadNextSong(), 3000);
          
          if (!hasResolved) {
            hasResolved = true;
            resolve();
          }
          
        } catch (err) {
          console.error('Play failed:', err);
          playBtn.textContent = 'play_arrow';
          if (!hasResolved) {
            hasResolved = true;
            resolve();
          }
        }
      };
      
      // Try to play immediately
      attemptPlay();
      
      // Fallback on canplay
      const canPlayHandler = () => {
        if (!audio.paused && !hasResolved) {
          attemptPlay();
        }
      };
      
      const errorHandler = () => {
        if (!hasResolved) {
          playBtn.textContent = 'play_arrow';
          resolve();
        }
      };
      
      audio.addEventListener('canplay', canPlayHandler, { once: true });
      audio.addEventListener('error', errorHandler, { once: true });
      
      setTimeout(() => {
        if (!hasResolved) {
          audio.removeEventListener('canplay', canPlayHandler);
          audio.removeEventListener('error', errorHandler);
          playBtn.textContent = 'play_arrow';
          resolve();
        }
      }, 8000);
    });
  }
};

// Controls - FIXED: Initialize AudioContext on first user gesture
function play() { 
  // Ensure AudioContext is created/resumed on user gesture
  resumeAudioContext().then(() => {
    audio.play().then(() => { 
      playBtn.textContent = 'pause'; 
      songPlayStartTime = Date.now(); 
      startServiceWorkerKeepAlive();
      startFade("in");
      updateMediaSession(currentSong);
    }).catch(err => {
      console.error('Play error:', err);
      playBtn.textContent = 'play_arrow';
    }); 
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

// Initialize AudioContext on first user interaction with player controls
[playBtn.parentElement, prevBtn, nextBtn, repeatBtn.parentElement, seekBar].forEach(element => {
  element.addEventListener('click', () => {
    resumeAudioContext();
  }, { once: true }); // Only need to do this once
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

  if (!hasCountedSong && !audio.paused && songPlayStartTime) {
    const total = totalListenedTime + (Date.now() - songPlayStartTime) / 1000;
    if (total >= 90) hasCountedSong = true;
  }
};

// Handle song end
audio.onended = () => {
  stopFade();
  
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
    audio.volume = 0.01;
    
    if (audioContext?.state === 'suspended') {
      audioContext.resume().then(() => {
        audio.play(); 
        playBtn.textContent = 'pause'; 
        startFade("in");
      });
    } else {
      audio.play(); 
      playBtn.textContent = 'pause'; 
      startFade("in");
    }
  } else if (repeat === 'all' || repeat === 'off') {
    audio.volume = 1;
    setTimeout(() => {
      playNextSong();
    }, 300);
  }
};

// Error handling
audio.onerror = (e) => {
  if (audio.error?.code === 4) return;
  
  console.error('Audio error:', audio.error);
  playBtn.textContent = 'play_arrow';
  
  if (audio.error && audio.error.code === audio.error.MEDIA_ERR_NETWORK) {
    setTimeout(() => {
      if (currentSong) {
        const retryUrl = fixDropboxUrl(currentSong.link);
        audio.src = retryUrl;
        audio.load();
        audio.play().then(() => {
          playBtn.textContent = 'pause';
        }).catch(() => {
          setTimeout(() => playNextSong(), 1000);
        });
      }
    }, 1000);
  } else if (audio.error?.code !== 4) {
    setTimeout(() => playNextSong(), 2000);
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
  if (!audio.ended) {
    playBtn.textContent = 'play_arrow';
  }
  
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused';
  }
});

audio.addEventListener('play', () => {
  playBtn.textContent = 'pause';
  
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

// Clean up
window.addEventListener('beforeunload', () => {
  clearInterval(heartbeatInterval);
  stopServiceWorkerKeepAlive();
});

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

console.log('MusicsAura Player — AudioContext Fixed');