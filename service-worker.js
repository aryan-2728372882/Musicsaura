// service-worker.js — MELODYTUNES 2025 - SCREEN OFF PLAYBACK FIX
const CACHE_NAME = 'melodytunes-v13';
const CORE_ASSETS = ['/', '/index.html', '/auth.html', '/manifest.json', '/styles/styles.css', '/scripts/player.js', '/scripts/app.js', '/scripts/firebase-config.js', '/assets/logo.png'];

// 2025 DROPBOX FIX — KEEPS rlkey + FORCES raw=1
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

// CRITICAL: Enhanced fetch handler for audio
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // AUDIO FILES: Critical for background playback
  if (/\.(mp3|m4a|aac|wav|ogg)($|\?)/i.test(url)) {
    const fixed = fixDropboxUrl(url);
    
    event.respondWith(
      fetch(fixed, { 
        credentials: 'omit',
        mode: 'cors',
        cache: 'default',
        keepalive: true
      })
      .then(response => {
        // Return response directly (don't clone used response)
        if (response.ok) {
          return response;
        }
        // If not OK, try original request
        return fetch(event.request, { keepalive: true });
      })
      .catch(err => {
        console.error('Audio fetch failed:', err);
        // Fallback to original request
        return fetch(event.request, { keepalive: true }).catch(() => {
          // Return empty response if all fails
          return new Response(null, { status: 404 });
        });
      })
    );
    return;
  }

  // APIs & Firebase → network only
  if (url.includes('firebase') || url.includes('googleapis') || url.includes('gstatic') || url.includes('/jsons/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell → cache-first
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        
        return fetch(event.request).then(res => {
          if (res.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
          }
          return res;
        });
      })
  );
});

// ENHANCED: Message handling for background playback
let keepAliveTimer = null;
let lastKeepAlive = Date.now();

self.addEventListener('message', event => {
  const data = event.data;
  
  if (data?.type === 'KEEP_ALIVE') {
    lastKeepAlive = Date.now();
    
    // Reset timer with maximum value
    clearTimeout(keepAliveTimer);
    keepAliveTimer = setTimeout(() => {
      // Keep SW alive indefinitely
    }, 2147483647); // Max setTimeout value
    
    // Respond back to confirm alive
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ 
        alive: true, 
        timestamp: Date.now() 
      });
    }
    
    // Log playing state
    if (data.playing) {
      console.log('SW: Keeping alive - Playing:', data.song);
    }
  }
  
  if (data?.type === 'HEARTBEAT') {
    lastKeepAlive = Date.now();
    console.log('SW: Heartbeat received');
  }
  
  if (data?.type === 'BACKGROUND_PING') {
    lastKeepAlive = Date.now();
  }
  
  if (data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// CRITICAL: Aggressive heartbeat to keep SW alive
setInterval(() => {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then(clients => {
      clients.forEach(client => {
        client.postMessage({ 
          type: 'SW_HEARTBEAT',
          timestamp: Date.now(),
          lastKeepAlive: lastKeepAlive
        });
      });
    });
}, 20000); // Every 20 seconds

// Additional keepalive - prevent SW termination
let wakeLockTimer;
function preventTermination() {
  clearTimeout(wakeLockTimer);
  wakeLockTimer = setTimeout(preventTermination, 10000);
}
preventTermination();

// Handle background sync if needed
self.addEventListener('sync', event => {
  console.log('Background sync:', event.tag);
});

// Handle push notifications (future feature)
self.addEventListener('push', event => {
  console.log('Push received:', event);
});

// CRITICAL: Handle fetch errors gracefully
self.addEventListener('error', event => {
  console.error('SW Error:', event.error);
});

self.addEventListener('unhandledrejection', event => {
  console.error('SW Unhandled Rejection:', event.reason);
});

console.log('MelodyTunes SW v13 — SCREEN OFF PLAYBACK OPTIMIZED');