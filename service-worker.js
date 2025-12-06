// service-worker.js — MusicsAura 2025 - SCREEN OFF PLAYBACK FIX (OPTIMIZED)
const CACHE_NAME = 'MusicsAuras-v14';
const CORE_ASSETS = ['/', '/index.html', '/auth.html', '/manifest.json', '/styles/styles.css', '/scripts/player.js', '/scripts/app.js', '/scripts/firebase-config.js', '/assets/logo.png'];

// FAST Dropbox URL fix - only modify if needed
function fixDropboxUrl(url) {
  if (!url.includes('dropbox.com')) return url;
  
  // Already a direct link? Return as-is
  if (url.includes('dl.dropboxusercontent.com') && url.includes('raw=1')) {
    return url;
  }
  
  try {
    const u = new URL(url);
    // Only modify if it's a www.dropbox.com link
    if (u.hostname === 'www.dropbox.com') {
      u.hostname = 'dl.dropboxusercontent.com';
      if (!u.searchParams.has('raw')) {
        u.searchParams.set('raw', '1');
      }
      return u.toString();
    }
  } catch (e) {
    // If URL parsing fails, try simple fix
    return url.replace('www.dropbox.com', 'dl.dropboxusercontent.com') + 
           (url.includes('?') ? '&raw=1' : '?raw=1');
  }
  
  return url;
}

// Install
self.addEventListener('install', e => {
  console.log('SW installing...');
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate
self.addEventListener('activate', e => {
  console.log('SW activating...');
  e.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// ULTRA-FAST fetch handler for audio - minimal processing
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // AUDIO FILES: Direct fetch with minimal processing
  if (/\.(mp3|m4a|aac|wav|ogg|flac)($|\?)/i.test(url)) {
    // FAST PATH: Use the original request if possible
    event.respondWith(
      (async () => {
        try {
          // Try original request first (fastest)
          const directFetch = fetch(event.request, {
            credentials: 'omit',
            mode: 'cors',
            cache: 'no-cache',  // Changed from 'default' for freshness
            keepalive: true,
            priority: 'high'    // Audio is high priority
          });
          
          // Set a timeout for faster fallback
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 5000)
          );
          
          const response = await Promise.race([directFetch, timeoutPromise]);
          
          // If successful, return it
          if (response.ok) {
            return response;
          }
          
          // If not successful, try Dropbox fix
          throw new Error('Direct fetch failed');
        } catch (directError) {
          console.log('Trying Dropbox fix for:', url);
          // Fallback to Dropbox fix
          const fixedUrl = fixDropboxUrl(url);
          
          if (fixedUrl !== url) {
            try {
              const fixedResponse = await fetch(fixedUrl, {
                credentials: 'omit',
                mode: 'cors',
                cache: 'no-cache',
                keepalive: true,
                priority: 'high'
              });
              
              if (fixedResponse.ok) {
                return fixedResponse;
              }
            } catch (fixedError) {
              console.warn('Fixed URL also failed:', fixedError);
            }
          }
          
          // Last resort: original request without optimizations
          return fetch(event.request);
        }
      })()
    );
    return;
  }

  // APIs & Firebase → network only (no caching)
  if (url.includes('firebase') || url.includes('googleapis') || url.includes('gstatic') || url.includes('/jsons/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell → cache-first (optimized)
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) {
        // Update cache in background for next time
        fetchAndCache(event.request);
        return cached;
      }
      
      // Not in cache, fetch fresh
      const response = await fetch(event.request);
      
      // Only cache successful, same-origin responses
      if (response.status === 200 && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      
      return response;
    })()
  );
});

// Background cache update (non-blocking)
async function fetchAndCache(request) {
  try {
    const response = await fetch(request);
    if (response.status === 200 && response.type === 'basic') {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response);
    }
  } catch (err) {
    // Silent fail - background update only
  }
}

// ENHANCED: Message handling — ONLY ONE LOG PER SONG
let keepAliveTimer = null;
let lastKeepAlive = Date.now();
let currentSong = null;

self.addEventListener('message', event => {
  const data = event.data;
  
  if (data?.type === 'KEEP_ALIVE') {
    lastKeepAlive = Date.now();
    
    // ← ONLY LOG WHEN SONG CHANGES → exactly 1 line per song
    if (data.playing && data.song && currentSong !== data.song) {
      currentSong = data.song;
      console.log(`%cSW: Playing - ${data.song}`, 'color: #4CAF50; font-weight: bold;');
    }
    
    clearTimeout(keepAliveTimer);
    keepAliveTimer = setTimeout(() => {}, 2147483647);
    
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ 
        alive: true, 
        timestamp: Date.now(),
        currentSong: currentSong
      });
    }
  }
  
  // HEARTBEAT - silent
  if (data?.type === 'HEARTBEAT') {
    lastKeepAlive = Date.now();
  }
  
  if (data?.type === 'BACKGROUND_PING') {
    lastKeepAlive = Date.now();
  }
  
  if (data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  // NEW: Audio preload hint
  if (data?.type === 'PRELOAD_AUDIO') {
    if (data.url) {
      // Pre-fetch in background
      fetch(data.url, { 
        mode: 'cors',
        priority: 'low',
        credentials: 'omit'
      }).catch(() => {}); // Silent fail
    }
  }
});

// Optimized heartbeat - less aggressive but still effective
setInterval(() => {
  const now = Date.now();
  // Only send heartbeat if we've received a message recently
  if (now - lastKeepAlive < 30000) { // 30 seconds
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
      .then(clients => {
        if (clients.length > 0) {
          clients[0].postMessage({ 
            type: 'SW_HEARTBEAT',
            timestamp: now
          });
        }
      });
  }
}, 15000); // Every 15 seconds (reduced from 20)

// Keep service worker alive during playback
function keepAlive() {
  setTimeout(keepAlive, 10000);
}
keepAlive();

// Handle errors
self.addEventListener('error', event => {
  console.error('SW Error:', event.error);
});

self.addEventListener('unhandledrejection', event => {
  console.error('SW Unhandled Rejection:', event.reason);
});

console.log('MusicsAura SW v14 — ULTRA-FAST AUDIO LOADING');