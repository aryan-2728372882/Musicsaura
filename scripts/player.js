// scripts/player.js — Musicsaura 2025 - DJ-OPTIMIZED BACKGROUND PLAYBACK
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

// DJ-OPTIMIZED FADE: Songs start IMMEDIATELY but fade in
let fadeInDuration = 10000; // 10 seconds for DJ mixing (was 15)
let fadeOutDuration = 5000; // 5 seconds fade out
let fadeInterval = null;
let isFading = false;
let nextSongPreloaded = false; // Track if next song is ready

// CRITICAL: Prevent garbage collection
window.audioElement = audio;

// RESET FADE STATE ON SONG CHANGE
function resetFadeState() {
  stopFade();
  audio.volume = 0.01; // Start at 1% volume - NOT silent, but quiet enough for fade
}

function startFade(direction) {
  if (isFading) return;
  isFading = true;
  
  const startVol = direction === "in" ? 0.01 : 1; // Start from 1% or 100%
  const endVol = direction === "in" ? 1 : 0.01; // End at 100% or 1%
  const duration = direction === "in" ? fadeInDuration : fadeOutDuration;
  const startTime = Date.now();

  clearInterval(fadeInterval);
  fadeInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    let progress = Math.min(elapsed / duration, 1);
    
    // Smooth easing curve for DJ transitions
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

// DROPBOX URL FIX - SIMPLIFIED
function fixDropboxUrl(url) {
  if (!url.includes('dropbox.com')) return url;
  // Quick check if already fixed
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

// Audio Context - OPTIMIZED FOR BACKGROUND
let audioContext = null;
let sourceNode = null;
let gainNode = null;
let hasConnectedSource = false;

function initAudioContext() {
  try {
    if (!audioContext || audioContext.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioContext = new AC({ 
        latencyHint: 'playback',
        sampleRate: 44100
      });
      
      if (!hasConnectedSource) {
        sourceNode = audioContext.createMediaElementSource(audio);
        gainNode = audioContext.createGain();
        gainNode.gain.value = 1;
        
        sourceNode.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        hasConnectedSource = true;
        
        // Global references to prevent GC
        window.audioContext = audioContext;
        window.sourceNode = sourceNode;
        window.gainNode = gainNode;
      }
    }
    
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  } catch (e) {
    console.error('AudioContext init error:', e);
  }
}

// Initialize audio context on first interaction
let audioContextInitialized = false;
function initAudioContextOnce() {
  if (!audioContextInitialized) {
    initAudioContext();
    audioContextInitialized = true;
  }
}
['click', 'touchstart', 'keydown'].forEach(evt => 
  document.addEventListener(evt, initAudioContextOnce, { passive: true, once: true })
);

// Service Worker KeepAlive - CRITICAL FOR ANDROID BACKGROUND
let swKeepAliveInterval = null;

function startServiceWorkerKeepAlive() {
  if (swKeepAliveInterval) return;
  
  console.log('Starting SW keepalive for background playback');
  
  swKeepAliveInterval = setInterval(() => {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      // Send critical keepalive message
      navigator.serviceWorker.controller.postMessage({ 
        type: 'KEEP_ALIVE',
        playing: !audio.paused,
        currentTime: audio.currentTime,
        duration: audio.duration || 0,
        song: currentSong?.title,
        timestamp: Date.now()
      });
      
      // Also ping to prevent suspension
      navigator.serviceWorker.controller.postMessage({
        type: 'BACKGROUND_PING',
        timestamp: Date.now()
      });
    }
    
    // CRITICAL: Keep AudioContext alive on Android
    if (audioContext) {
      if (audioContext.state === 'suspended') {
        console.log('AudioContext suspended, resuming...');
        audioContext.resume().then(() => {
          console.log('AudioContext resumed successfully');
        }).catch(e => {
          console.error('Failed to resume AudioContext:', e);
        });
      }
      
      // Touch gain node to prevent GC
      if (gainNode) {
        gainNode.gain.value = gainNode.gain.value;
      }
    }
  }, 3000); // 3 seconds is optimal for Android Chrome
}

function stopServiceWorkerKeepAlive() {
  if (swKeepAliveInterval) {
    clearInterval(swKeepAliveInterval);
    swKeepAliveInterval = null;
    console.log('Stopped SW keepalive');
  }
}

// Media Session - CRITICAL FOR ANDROID LOCK SCREEN
if ('mediaSession' in navigator) {
  console.log('Media Session API available');
  
  navigator.mediaSession.setActionHandler('play', () => {
    console.log('Media Session: Play requested');
    play();
  });
  
  navigator.mediaSession.setActionHandler('pause', () => {
    console.log('Media Session: Pause requested');
    pause();
  });
  
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    console.log('Media Session: Previous track');
    playPreviousSong();
  });
  
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    console.log('Media Session: Next track');
    playNextSong();
  });
  
  try {
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      audio.currentTime = Math.max(0, audio.currentTime - 10);
    });
    
    navigator.mediaSession.setActionHandler('seekforward', () => {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
    });
    
    navigator.mediaSession.setActionHandler('stop', () => {
      console.log('Media Session: Stop requested');
      pause();
    });
  } catch (e) {
    console.log('Some media session actions not supported');
  }
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
        { src: song.thumbnail, sizes: '128x128', type: 'image/jpeg' },
        { src: song.thumbnail, sizes: '192x192', type: 'image/jpeg' },
        { src: song.thumbnail, sizes: '256x256', type: 'image/jpeg' },
        { src: song.thumbnail, sizes: '384x384', type: 'image/jpeg' },
        { src: song.thumbnail, sizes: '512x512', type: 'image/jpeg' }
      ] : []
    });
    
    navigator.mediaSession.playbackState = !audio.paused ? 'playing' : 'paused';
    console.log('Media Session updated for:', song.title);
  } catch (e) {
    console.error('Failed to update media session:', e);
  }
}

function showPlayer() { 
  playerEl.hidden = false; 
  playerEl.classList.add('visible'); 
}

// PRELOAD SYSTEM - CRITICAL FOR CONTINUOUS PLAYBACK
let preloadAudio = null;
let preloadTimeout = null;

function preloadNextSong() {
  if (!playlist.length || playlist.length < 2) return;
  
  const nextIndex = (currentIndex + 1) % playlist.length;
  const nextSong = playlist[nextIndex];
  
  if (!nextSong?.link) return;
  
  console.log('Preloading next song:', nextSong.title);
  
  // Cancel any existing preload
  if (preloadTimeout) {
    clearTimeout(preloadTimeout);
  }
  
  // Wait a bit before preloading to avoid network contention
  preloadTimeout = setTimeout(() => {
    if (!preloadAudio) {
      preloadAudio = new Audio();
      preloadAudio.crossOrigin = "anonymous";
      preloadAudio.preload = "auto";
      preloadAudio.volume = 0; // Silent preload
      window.preloadAudio = preloadAudio;
    }
    
    const fixedUrl = fixDropboxUrl(nextSong.link);
    if (preloadAudio.src !== fixedUrl) {
      preloadAudio.src = fixedUrl;
      preloadAudio.load();
      nextSongPreloaded = true;
      console.log('Next song preloaded successfully');
    }
  }, 2000); // Wait 2 seconds after current song starts
}

// MAIN PLAYER - DJ OPTIMIZED
export const player = {
  setPlaylist(songs, index = 0) { 
    playlist = songs; 
    currentIndex = index; 
    console.log('Playlist set with', songs.length, 'songs');
  },

  async playSong(song) {
    if (!song?.link) {
      console.error('No song link provided:', song);
      return;
    }
    
    console.log('Playing song:', song.title);
    
    // Stop any ongoing fade
    stopFade();
    
    // Store current song data
    currentSong = song;
    songPlayStartTime = Date.now();
    totalListenedTime = 0;
    hasCountedSong = false;
    nextSongPreloaded = false;

    // Initialize AudioContext if needed
    initAudioContext();
    
    // Force resume AudioContext for Android
    if (audioContext?.state === 'suspended') {
      await audioContext.resume();
    }
    
    const fixedUrl = fixDropboxUrl(song.link);
    
    if (!fixedUrl || fixedUrl === 'undefined') {
      console.error('Invalid URL after fix:', fixedUrl);
      return;
    }
    
    // Set volume to 1% immediately (will fade in)
    audio.volume = 0.01;
    
    // Set audio attributes
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    
    // Use currentTime trick for faster loading
    audio.currentTime = 0;
    
    // Set the new source
    audio.src = fixedUrl;
    
    // Update UI
    titleEl.textContent = song.title;
    thumbEl.style.backgroundImage = song.thumbnail ? `url(${song.thumbnail})` : '';
    updateMediaSession(song);
    showPlayer();

    // Load the audio
    audio.load();
    
    // CRITICAL: Return a promise that resolves when playing starts
    return new Promise((resolve) => {
      let hasResolved = false;
      let playAttempts = 0;
      const maxAttempts = 2;
      
      const attemptPlay = async () => {
        playAttempts++;
        console.log(`Play attempt ${playAttempts} for:`, song.title);
        
        try {
          // Ensure AudioContext is active
          if (audioContext?.state === 'suspended') {
            await audioContext.resume();
          }
          
          // Try to play
          await audio.play();
          
          // SUCCESS!
          console.log('Playback started successfully:', song.title);
          playBtn.textContent = 'pause';
          startServiceWorkerKeepAlive();
          startFade("in");
          
          // Start preloading next song
          preloadNextSong();
          
          if (!hasResolved) {
            hasResolved = true;
            resolve();
          }
          
        } catch (err) {
          console.error(`Play failed (attempt ${playAttempts}):`, err);
          
          if (playAttempts < maxAttempts) {
            // Wait and retry
            setTimeout(() => attemptPlay(), 1000);
          } else {
            // Final failure
            playBtn.textContent = 'play_arrow';
            if (!hasResolved) {
              hasResolved = true;
              resolve();
            }
          }
        }
      };
      
      // Try immediate play (fast path)
      attemptPlay();
      
      // Also listen for canplay as backup
      const canPlayHandler = () => {
        if (!audio.paused) return; // Already playing
        
        console.log('canplay event fired for:', song.title);
        if (!hasResolved) {
          attemptPlay();
        }
      };
      
      const errorHandler = (e) => {
        console.error('Audio error during load:', e);
        if (!hasResolved) {
          hasResolved = true;
          playBtn.textContent = 'play_arrow';
          resolve();
        }
      };
      
      // Add event listeners
      audio.addEventListener('canplay', canPlayHandler, { once: true });
      audio.addEventListener('error', errorHandler, { once: true });
      
      // Timeout fallback
      setTimeout(() => {
        if (!hasResolved) {
          audio.removeEventListener('canplay', canPlayHandler);
          audio.removeEventListener('error', errorHandler);
          console.warn('Play timeout for:', song.title);
          playBtn.textContent = 'play_arrow';
          resolve();
        }
      }, 10000); // 10 second timeout
    });
  }
};

// Controls
function play() { 
  console.log('Manual play requested');
  
  initAudioContext();
  
  if (audioContext?.state === 'suspended') {
    audioContext.resume().then(() => {
      audio.play().then(() => { 
        playBtn.textContent = 'pause'; 
        songPlayStartTime = Date.now(); 
        startServiceWorkerKeepAlive();
        startFade("in");
        updateMediaSession(currentSong);
      }).catch(err => {
        console.error('Play after resume failed:', err);
        playBtn.textContent = 'play_arrow';
      });
    });
  } else {
    audio.play().then(() => { 
      playBtn.textContent = 'pause'; 
      songPlayStartTime = Date.now(); 
      startServiceWorkerKeepAlive();
      if (audio.currentTime < 5) startFade("in");
      updateMediaSession(currentSong);
    }).catch(err => {
      console.error('Play error:', err);
      playBtn.textContent = 'play_arrow';
    }); 
  }
}

function pause() { 
  console.log('Manual pause');
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
  repeat = repeat === 'off' ? 'one' : repeat === 'one' ? 'all' : 'off'; 
  repeatBtn.textContent = repeat === 'one' ? 'repeat_one' : repeat === 'all' ? 'repeat' : 'repeat'; 
  console.log('Repeat mode:', repeat);
};

// Update position state for lock screen
audio.ontimeupdate = () => {
  if (!audio.duration || isNaN(audio.duration)) return;
  
  seekBar.value = (audio.currentTime / audio.duration) * 100;
  
  // Update Media Session position state (for Android lock screen)
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: 1,
        position: audio.currentTime
      });
    } catch (e) {
      // Ignore errors
    }
  }
  
  // Start fade out near the end (for DJ mixing)
  const remaining = audio.duration - audio.currentTime;
  if (remaining <= fadeOutDuration/1000 + 2 && !isFading) {
    console.log('Starting fade out, remaining:', remaining.toFixed(1), 's');
    startFade("out");
  }

  // Track listening time for stats
  if (!hasCountedSong && !audio.paused && songPlayStartTime) {
    const total = totalListenedTime + (Date.now() - songPlayStartTime) / 1000;
    if (total >= 90) {
      hasCountedSong = true;
      console.log('Song counted as listened (90+ seconds)');
    }
  }
};

// CRITICAL: Handle song end PROPERLY
audio.onended = () => {
  console.log('Song ended:', currentSong?.title);
  
  stopFade();
  
  // Calculate listening time
  if (songPlayStartTime) {
    totalListenedTime += (Date.now() - songPlayStartTime) / 1000;
  }
  
  // Update stats if listened for enough time
  if (hasCountedSong && totalListenedTime >= 90) {
    const minutes = Math.round((totalListenedTime / 60) * 2) / 2;
    updateUserStats(minutes);
  }
  
  // Handle repeat modes
  if (repeat === 'one') {
    console.log('Repeat one: replaying current song');
    audio.currentTime = 0; 
    songPlayStartTime = Date.now(); 
    totalListenedTime = 0; 
    hasCountedSong = false;
    audio.volume = 0.01; // Reset for fade in
    
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
    // Reset volume for next song
    audio.volume = 1;
    
    // Small delay for smooth transition
    setTimeout(() => {
      playNextSong();
    }, 300);
  }
};

// Better error handling for Android
audio.onerror = (e) => {
  // Ignore empty src errors (happen during transitions)
  if (audio.error?.code === 4) {
    console.log('Ignoring empty src error during transition');
    return;
  }
  
  console.error('Audio error:', audio.error?.message || e);
  
  // Update button state
  playBtn.textContent = 'play_arrow';
  
  // Only skip if it's a network error
  if (audio.error && audio.error.code === audio.error.MEDIA_ERR_NETWORK) {
    console.log('Network error detected, retrying in 1 second...');
    
    // Retry current song once
    setTimeout(() => {
      if (currentSong) {
        const retryUrl = fixDropboxUrl(currentSong.link);
        audio.src = retryUrl;
        audio.load();
        
        audio.play().then(() => {
          console.log('Retry successful');
          playBtn.textContent = 'pause';
        }).catch((retryErr) => {
          console.error('Retry failed:', retryErr);
          // If retry fails, skip to next after delay
          setTimeout(() => {
            console.log('Skipping to next song due to persistent error');
            playNextSong();
          }, 1000);
        });
      }
    }, 1000);
  } else if (audio.error?.code !== 4) {
    // Other errors (except empty src) - skip to next
    console.log('Non-network error, skipping to next song');
    setTimeout(() => playNextSong(), 2000);
  }
};

// Handle visibility changes - CRITICAL FOR ANDROID
document.addEventListener('visibilitychange', () => {
  console.log('Visibility changed:', document.hidden ? 'hidden' : 'visible');
  
  if (!document.hidden && !audio.paused) {
    // App came to foreground, resume audio context
    if (audioContext?.state === 'suspended') {
      console.log('Resuming AudioContext after visibility change');
      audioContext.resume().then(() => {
        console.log('AudioContext resumed successfully');
        audio.play().catch(e => {
          console.error('Failed to play after resume:', e);
        });
      }).catch(e => {
        console.error('Failed to resume AudioContext:', e);
      });
    } else {
      audio.play().catch(e => {
        console.error('Failed to play:', e);
      });
    }
  }
});

// Handle audio interruptions (calls, notifications)
audio.addEventListener('pause', () => {
  console.log('Audio paused (possibly by system)');
  
  // Only update button if pause wasn't triggered by user or end of song
  if (!audio.ended && playBtn.textContent !== 'play_arrow') {
    playBtn.textContent = 'play_arrow';
  }
  
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused';
  }
});

audio.addEventListener('play', () => {
  console.log('Audio playing');
  
  // Always update button on play
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
  console.log('Playing next song');
  
  if (!playlist.length) {
    console.log('No playlist, pausing');
    return pause(); 
  }
  
  currentIndex = (currentIndex + 1) % playlist.length; 
  player.playSong(playlist[currentIndex]); 
}

function playPreviousSong() {
  console.log('Playing previous song');
  
  if (audio.currentTime > 3) { 
    // Restart current song
    audio.currentTime = 0; 
    totalListenedTime = 0; 
    hasCountedSong = false; 
    songPlayStartTime = Date.now(); 
    console.log('Restarting current song');
  }
  else if (playlist.length) { 
    // Go to previous song
    currentIndex = (currentIndex - 1 + playlist.length) % playlist.length; 
    player.playSong(playlist[currentIndex]); 
  }
}

async function updateUserStats(minutes) {
  const user = auth.currentUser;
  if (!user || !currentSong) return;
  
  console.log('Updating user stats:', minutes, 'minutes');
  
  try {
    await updateDoc(doc(db, "users", user.uid), {
      songsPlayed: increment(1),
      minutesListened: increment(minutes),
      lastPlayed: serverTimestamp(),
      lastActive: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) + " IST"
    });
    console.log('Stats updated successfully');
  } catch (e) {
    console.error('Stats update error:', e);
  }
}

onAuthStateChanged(auth, user => {
  if (!user) {
    console.log('No user, redirecting to auth');
    return location.href = "auth.html";
  }
  
  console.log('User authenticated:', user.email);
  
  navAvatar.src = user.photoURL || `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><circle cx='28' cy='28' r='28' fill='%234a90e2'/><text x='50%' y='50%' font-size='28' fill='white' text-anchor='middle' dy='.3em'>${(user.email?.[0] || 'U').toUpperCase()}</text></svg>`;
  
  profileBtn.onclick = () => {
    if (user.email === "prabhakararyan2007@gmail.com") {
      location.href = "admin-dashboard.html";
    } else {
      location.href = "user-dashboard.html";
    }
  };
});

// ANDROID-SPECIFIC FIXES
// ======================

// 1. Keep service worker alive with aggressive pings
let heartbeatInterval = setInterval(() => {
  if (!audio.paused) {
    // Touch the audio element to prevent GC
    if (audio.volume > 0) {
      audio.volume = audio.volume;
    }
    
    // Ping service worker (critical for Android background)
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'HEARTBEAT',
        time: Date.now(),
        song: currentSong?.title
      });
    }
    
    // Keep AudioContext alive
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(e => {
        console.log('Heartbeat resume failed:', e);
      });
    }
  }
}, 4000); // Every 4 seconds - optimal for Android

// 2. Request wake lock for Android (if supported)
let wakeLock = null;
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock acquired');
      
      wakeLock.addEventListener('release', () => {
        console.log('Wake Lock released');
      });
    } catch (err) {
      console.error('Wake Lock error:', err.message);
    }
  }
}

// Request wake lock when playing starts
audio.addEventListener('play', () => {
  requestWakeLock();
});

// 3. Handle page unload
window.addEventListener('beforeunload', () => {
  console.log('Page unloading, cleaning up...');
  clearInterval(heartbeatInterval);
  stopServiceWorkerKeepAlive();
  
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
});

// 4. Handle page freeze/suspend (Android specific)
window.addEventListener('freeze', () => {
  console.log('Page frozen by browser');
});

window.addEventListener('resume', () => {
  console.log('Page resumed from frozen state');
  
  // Try to resume playback if it was playing
  if (!audio.paused && audioContext?.state === 'suspended') {
    audioContext.resume().then(() => {
      console.log('AudioContext resumed after page resume');
    });
  }
});

// 5. Register service worker for background playback
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(registration => {
        console.log('ServiceWorker registered:', registration.scope);
        
        // Send initial message to activate
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'INIT',
            timestamp: Date.now()
          });
        }
      })
      .catch(error => {
        console.error('ServiceWorker registration failed:', error);
      });
  });
}

console.log('MusicsAura Player — DJ-OPTIMIZED BACKGROUND PLAYBACK (Android Ready)');