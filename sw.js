// --- PUSHALERT INTEGRATION ---
importScripts("https://cdn.pushalert.co/sw-91694.js");
// -----------------------------

// --- YOUR EXISTING PWA CACHE CODE ---
const CACHE_NAME = 'biashara-v48'; // Bumped: faster images + chat label
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
      // Add files one by one: if a single page is missing (404), the rest still get cached.
      return Promise.allSettled(URLS_TO_CACHE.map((u) => cache.add(u)));
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

  // Always go to network for API calls and live chat traffic
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket.io/') ||
      url.pathname.startsWith('/chat-image/') ||
      url.pathname === '/chat-widget.js') {
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