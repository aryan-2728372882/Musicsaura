// scripts/player.js
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
let wakeLock = null;
let songPlayStartTime = 0; // When song actually started playing
let totalListenedTime = 0; // Total seconds listened
let hasCountedSong = false;
let fadeInterval = null;
let targetVolume = 1.0;
let playlist = [];
let currentIndex = 0;

audio.volume = 0; // Start at 0 for fade-in

// Media Session API for system controls
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', pause);
  navigator.mediaSession.setActionHandler('previoustrack', null);
  navigator.mediaSession.setActionHandler('nexttrack', () => playNextSong());
}

// Wake Lock to prevent screen sleep during playback
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    console.error('Wake Lock error:', e);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().then(() => wakeLock = null);
  }
}

// Show/Hide Player UI
function showPlayer() {
  playerEl.hidden = false;
  playerEl.classList.add('visible');
}

function hidePlayer() {
  playerEl.classList.remove('visible');
  setTimeout(() => {
    if (!audio.src) playerEl.hidden = true;
  }, 300);
}

// Fade in audio (0 to max volume over 15 seconds)
function fadeIn() {
  if (fadeInterval) clearInterval(fadeInterval);
  
  audio.volume = 0;
  const fadeDuration = 15000; // 15 seconds
  const steps = 150;
  const stepDuration = fadeDuration / steps;
  const volumeIncrement = targetVolume / steps;
  
  let currentStep = 0;
  
  fadeInterval = setInterval(() => {
    currentStep++;
    audio.volume = Math.min(currentStep * volumeIncrement, targetVolume);
    
    if (currentStep >= steps) {
      clearInterval(fadeInterval);
      fadeInterval = null;
    }
  }, stepDuration);
}

// Fade out audio (max volume to 0 over 8 seconds)
function fadeOut(callback) {
  if (fadeInterval) clearInterval(fadeInterval);
  
  const fadeDuration = 8000; // 8 seconds
  const steps = 80;
  const stepDuration = fadeDuration / steps;
  const startVolume = audio.volume;
  const volumeDecrement = startVolume / steps;
  
  let currentStep = 0;
  
  fadeInterval = setInterval(() => {
    currentStep++;
    audio.volume = Math.max(startVolume - (currentStep * volumeDecrement), 0);
    
    if (currentStep >= steps || audio.volume <= 0) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      if (callback) callback();
    }
  }, stepDuration);
}

// Main player export
export const player = {
  setPlaylist(songs, index = 0) {
    playlist = songs;
    currentIndex = index;
  },
  
  async playSong(song) {
    currentSong = song;
    songPlayStartTime = Date.now();
    totalListenedTime = 0;
    hasCountedSong = false;

    // Set audio source
    audio.crossOrigin = 'anonymous';
    audio.src = song.link;
    titleEl.textContent = song.title;

    // Set thumbnail
    const thumbUrl = song.thumbnail || '';
    thumbEl.style.backgroundImage = `url(${thumbUrl})`;
    thumbEl.style.backgroundSize = 'cover';
    thumbEl.style.backgroundPosition = 'center';

    // Handle thumbnail load errors
    const img = new Image();
    img.onload = () => {
      // Thumbnail loaded successfully
    };
    img.onerror = () => {
      thumbEl.style.backgroundImage = `url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2748%27 height=%2748%27%3E%3Crect width=%27100%25%27 height=%27100%25%27 fill=%27%23ccc%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 font-size=%2714%27 fill=%27%23999%27 text-anchor=%27middle%27 dy=%27.3em%27%3ENo Thumb%3C/text%3E%3C/svg%3E')`;
    };
    img.src = thumbUrl;

    // Update Media Session metadata
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist || 'Unknown Artist',
        artwork: [
          { src: thumbUrl, sizes: '96x96', type: 'image/jpeg' },
          { src: thumbUrl, sizes: '128x128', type: 'image/jpeg' },
          { src: thumbUrl, sizes: '192x192', type: 'image/jpeg' },
          { src: thumbUrl, sizes: '256x256', type: 'image/jpeg' },
          { src: thumbUrl, sizes: '384x384', type: 'image/jpeg' },
          { src: thumbUrl, sizes: '512x512', type: 'image/jpeg' }
        ]
      });
    }

    showPlayer();

    // Play audio with fade-in
    audio.play().then(() => {
      playBtn.textContent = 'pause';
      songPlayStartTime = Date.now(); // Reset when actually starts playing
      fadeIn();
      requestWakeLock();
    }).catch(e => {
      console.error('Play failed:', e);
      alert('Playback failed. Please try again.');
    });
  }
};

// Playback controls
function play() {
  audio.play();
  playBtn.textContent = 'pause';
  songPlayStartTime = Date.now(); // Reset play start time
  if (audio.currentTime < 15) {
    fadeIn();
  }
  requestWakeLock();
}

function pause() {
  audio.pause();
  playBtn.textContent = 'play_arrow';
  
  // Add time listened during this play session
  if (songPlayStartTime > 0) {
    const sessionTime = (Date.now() - songPlayStartTime) / 1000;
    totalListenedTime += sessionTime;
    songPlayStartTime = 0; // Reset
    console.log('Paused. Total listened so far:', totalListenedTime.toFixed(2), 'seconds');
  }
  
  if (fadeInterval) clearInterval(fadeInterval);
  releaseWakeLock();
}

// Play/Pause button
playBtn.parentElement.onclick = () => {
  if (audio.paused) {
    play();
  } else {
    pause();
  }
};

// Disable prev button
prevBtn.disabled = true;
prevBtn.style.opacity = '0.5';
prevBtn.style.cursor = 'not-allowed';

// Enable next button for manual skip
nextBtn.disabled = false;
nextBtn.style.opacity = '1';
nextBtn.style.cursor = 'pointer';
nextBtn.onclick = () => {
  if (playlist.length > 0) {
    playNextSong();
  }
};

// Repeat button
repeatBtn.parentElement.onclick = () => {
  if (repeat === 'off') {
    repeat = 'one';
    repeatBtn.textContent = 'repeat_one';
  } else {
    repeat = 'off';
    repeatBtn.textContent = 'repeat';
  }
};

// Seek bar updates
audio.ontimeupdate = () => {
  if (audio.duration) {
    seekBar.value = (audio.currentTime / audio.duration) * 100;
    
    // Start fade-out 8 seconds before song ends
    const timeRemaining = audio.duration - audio.currentTime;
    if (timeRemaining <= 8 && timeRemaining > 7.9 && !fadeInterval && audio.volume > 0) {
      fadeOut(() => {
        if (repeat === 'one') {
          audio.currentTime = 0;
          songPlayStartTime = Date.now();
          totalListenedTime = 0;
          hasCountedSong = false;
          audio.play().then(() => fadeIn());
        }
      });
    }
  }

  // Check if user has listened for more than 1:30 (90 seconds) total - just mark as eligible
  if (!hasCountedSong && !audio.paused && songPlayStartTime > 0) {
    const currentSessionTime = (Date.now() - songPlayStartTime) / 1000;
    const totalTime = totalListenedTime + currentSessionTime;
    
    if (totalTime >= 90) {
      hasCountedSong = true; // Mark as eligible for counting
      console.log('✅ 90 seconds reached! Will count full play time when song ends or is skipped.');
    }
  }
};

// Seek bar control
seekBar.oninput = () => {
  if (audio.duration) {
    audio.currentTime = (seekBar.value / 100) * audio.duration;
  }
};

// Handle audio end
audio.onended = () => {
  if (fadeInterval) clearInterval(fadeInterval);
  
  // Calculate final listened time when song ends
  if (songPlayStartTime > 0) {
    const sessionTime = (Date.now() - songPlayStartTime) / 1000;
    totalListenedTime += sessionTime;
    songPlayStartTime = 0;
  }
  
  // If song was listened to for at least 90 seconds, count the FULL time
  if (hasCountedSong && totalListenedTime >= 90) {
    const exactMinutes = totalListenedTime / 60;
    const roundedMinutes = Math.round(exactMinutes * 2) / 2;
    console.log('🎵 Song ended. Total time:', totalListenedTime.toFixed(2), 'seconds =', roundedMinutes, 'minutes');
    updateUserStats(roundedMinutes);
  }
  
  if (repeat === 'one') {
    audio.currentTime = 0;
    songPlayStartTime = Date.now();
    totalListenedTime = 0;
    hasCountedSong = false;
    audio.play().then(() => fadeIn());
  } else {
    playNextSong();
  }
};

// Handle audio pause
audio.onpause = () => {
  if (fadeInterval) clearInterval(fadeInterval);
  if (audio.currentTime === 0 || audio.ended) {
    hidePlayer();
  }
};

// Play next song in playlist
function playNextSong() {
  // Before switching songs, count current song if eligible
  if (hasCountedSong && songPlayStartTime > 0) {
    const sessionTime = (Date.now() - songPlayStartTime) / 1000;
    totalListenedTime += sessionTime;
    
    if (totalListenedTime >= 90) {
      const exactMinutes = totalListenedTime / 60;
      const roundedMinutes = Math.round(exactMinutes * 2) / 2;
      console.log('⏭️ Skipping song. Total time:', totalListenedTime.toFixed(2), 'seconds =', roundedMinutes, 'minutes');
      updateUserStats(roundedMinutes);
    }
  }
  
  if (playlist.length === 0) {
    pause();
    return;
  }
  
  currentIndex = (currentIndex + 1) % playlist.length;
  const nextSong = playlist[currentIndex];
  
  if (nextSong) {
    player.playSong(nextSong);
  } else {
    pause();
  }
}

// Update user statistics in Firestore
async function updateUserStats(minutesListened) {
  const user = auth.currentUser;
  if (!user || !currentSong) return;

  try {
    const userRef = doc(db, "users", user.uid);

    await updateDoc(userRef, {
      songsPlayed: increment(1),
      minutesListened: increment(minutesListened),
      lastPlayed: serverTimestamp(),
      country: "IN",
      xHandle: "@DesiDiamondSave",
      lastActive: new Date().toLocaleString('en-US', { 
        timeZone: 'Asia/Kolkata',
        month: 'long',
        day: 'numeric', 
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }) + " IST"
    });
    console.log('✅ Stats updated: +1 song, +' + minutesListened.toFixed(2) + ' minutes');
  } catch (e) {
    console.error('Failed to update user stats:', e);
  }
}

// Authentication & User Display
onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = "auth.html";
    return;
  }

  // Display user avatar
  if (user.photoURL) {
    navAvatar.src = user.photoURL;
  } else {
    const initial = user.email?.[0]?.toUpperCase() || 'U';
    navAvatar.src = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Ccircle cx='28' cy='28' r='28' fill='%234a90e2'/%3E%3Ctext x='50%25' y='50%25' font-size='24' fill='white' text-anchor='middle' dy='.35em'%3E${initial}%3C/text%3E%3C/svg%3E`;
  }

  // Profile button click
  profileBtn.onclick = () => {
    if (user.email === "prabhakararyan2007@gmail.com") {
      location.href = "admin-dashboard.html";
    } else {
      location.href = "user-dashboard.html";
    }
  };
});