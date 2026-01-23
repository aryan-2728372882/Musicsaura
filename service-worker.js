// service-worker.js — MusicsAura 2025 - OPTIMIZED
const CACHE_NAME = 'MusicsAura-v15';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/auth.html',
  '/manifest.json',
  '/styles/styles.css',
  '/scripts/player.js',
  '/scripts/app.js',
  '/scripts/firebase-config.js',
  '/assets/logo.png'
];

// Optimized Dropbox URL fix
function fixDropboxUrl(url) {
  if (!url.includes('dropbox.com')) return url;
  if (url.includes('dl.dropboxusercontent.com') && url.includes('raw=1')) return url;
  
  try {
    const u = new URL(url);
    if (u.hostname === 'www.dropbox.com') {
      u.hostname = 'dl.dropboxusercontent.com';
      u.searchParams.set('raw', '1');
      return u.toString();
    }
  } catch (e) {
    return url.replace('www.dropbox.com', 'dl.dropboxusercontent.com') + 
           (url.includes('?') ? '&raw=1' : '?raw=1');
  }
  
  return url;
}

// Install - fast and minimal
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate - clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// OPTIMIZED fetch handler
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // AUDIO: Fast streaming with Range support
  if (/\.(mp3|m4a|aac|wav|ogg|flac)($|\?)/i.test(url)) {
    event.respondWith(
      (async () => {
        try {
          // Check if it's a Dropbox URL that needs fixing
          const isDropbox = url.includes('dropbox.com');
          const needsFix = isDropbox && !url.includes('dl.dropboxusercontent.com');
          
          if (needsFix) {
            // Fix URL immediately for Dropbox
            const fixedUrl = fixDropboxUrl(url);
            const response = await fetch(fixedUrl, {
              credentials: 'omit',
              mode: 'cors',
              cache: 'default', // Allow browser caching
              keepalive: true,
              priority: 'high'
            });
            
            if (response.ok) return response;
          }
          
          // Direct fetch for non-Dropbox or already-fixed URLs
          return await fetch(event.request, {
            credentials: 'omit',
            mode: 'cors',
            cache: 'default',
            keepalive: true,
            priority: 'high'
          });
          
        } catch (error) {
          // Fallback: try fixing the URL if not already done
          const fixedUrl = fixDropboxUrl(url);
          if (fixedUrl !== url) {
            return fetch(fixedUrl, {
              credentials: 'omit',
              mode: 'cors',
              cache: 'default',
              keepalive: true
            });
          }
          
          // Last resort
          return fetch(event.request);
        }
      })()
    );
    return;
  }

  // Firebase & APIs - network only, no caching
  if (url.includes('firebase') || 
      url.includes('googleapis') || 
      url.includes('gstatic') || 
      url.includes('/jsons/') ||
      url.includes('firestore')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell - cache first with background update
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) {
          // Background update - don't await
          fetch(event.request)
            .then(response => {
              if (response.status === 200 && response.type === 'basic') {
                caches.open(CACHE_NAME).then(cache => {
                  cache.put(event.request, response);
                });
              }
            })
            .catch(() => {});
          
          return cached;
        }
        
        // Not cached - fetch and cache
        return fetch(event.request).then(response => {
          if (response.status === 200 && response.type === 'basic') {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        });
      })
  );
});

// Keep-alive state
let keepAliveTimer = null;
let lastActivity = Date.now();

// Message handling - minimal
self.addEventListener('message', event => {
  const { type, url } = event.data || {};
  
  if (type === 'KEEP_ALIVE' || type === 'HEARTBEAT' || type === 'BACKGROUND_PING') {
    lastActivity = Date.now();
    clearTimeout(keepAliveTimer);
    keepAliveTimer = setTimeout(() => {}, 2147483647);
    
    if (event.ports?.[0]) {
      event.ports[0].postMessage({ 
        alive: true, 
        timestamp: lastActivity 
      });
    }
  }
  
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (type === 'PRELOAD_AUDIO' && url) {
    // Preload in background
    fetch(url, { 
      mode: 'cors',
      priority: 'low',
      credentials: 'omit',
      cache: 'default'
    }).catch(() => {});
  }
});

// Periodic heartbeat to keep SW alive during playback
setInterval(() => {
  if (Date.now() - lastActivity < 30000) {
    self.clients.matchAll({ type: 'window' })
      .then(clients => {
        if (clients.length > 0) {
          clients[0].postMessage({ 
            type: 'SW_HEARTBEAT',
            timestamp: Date.now()
          });
        }
      })
      .catch(() => {});
  }
}, 20000);

// Keep SW alive indefinitely
(function keepAlive() {
  setTimeout(keepAlive, 20000);
})();