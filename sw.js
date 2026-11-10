// --- PUSHALERT INTEGRATION ---
importScripts("https://cdn.pushalert.co/sw-91694.js");
// -----------------------------

// --- YOUR EXISTING PWA CACHE CODE ---
const CACHE_NAME = 'biashara-v43'; // Updated version to force refresh
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/admin-approve.html',
  '/manifest.json',
  '/privacy.html',
  '/terms.html',
  '/thank-you.html'
];

// Install — cache core files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(URLS_TO_CACHE).catch(err => {
        console.log('Cache add failed for some URLs:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate — remove old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch — CACHE FIRST for static files, network for API
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go to network for API calls
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip external origins (i.ibb.co images, etc.)
  if (url.origin !== self.location.origin) return;

  // Cache-first strategy for everything else
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Return cached version, but update cache in background
        event.waitUntil(
          fetch(event.request).then((response) => {
            if (response && response.status === 200) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, copy);
              });
            }
          }).catch(() => {})
        );
        return cached;
      }

      // Not in cache — fetch from network and cache it
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200) return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, copy);
        });
        return response;
      }).catch(() => {
        // Offline fallback
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});