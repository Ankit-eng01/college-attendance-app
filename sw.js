// ==========================================================================
// ATTENDIFY SERVICE WORKER — HIGH RELIABILITY & SECURE OFFLINE ENGINE
// Strategy:
// 1. Navigation (HTML): Network-First with cached offline fallback
// 2. Static Shell Assets (app.js, icons, manifest): Stale-While-Revalidate
// 3. Cloud Sync REST APIs: Network-Only (no static cache poisoning)
// 4. Non-GET requests: Direct bypass
// ==========================================================================

const CACHE_NAME = 'attendify-v31-sync-cal-fix';

// Critical core assets to precache on install
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './app.js?v=20261127r10',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png'
];

// 1. Install Event: Precache core shell assets bypassing HTTP cache & activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        PRECACHE_ASSETS.map((asset) =>
          cache.add(new Request(asset, { cache: 'reload' }))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Clean up outdated cache versions immediately and take control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Attendify SW] Purging outdated cache version:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Event: Intelligent Strategy Routing
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // A. Non-GET methods (POST, PUT, DELETE, RPC) always bypass cache
  if (request.method !== 'GET') {
    return;
  }

  // B. Cloud API calls (Neon Functions): Network-only, never poisoned in static cache
  if (url.hostname.includes('neon.tech')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(JSON.stringify({ error: 'Network unavailable. Running in offline mode.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // C. HTML Navigation Requests: Network-First (bypassing HTTP max-age cache) with Offline Cache Fallback
  // Guarantees users always see the latest version when connected, while remaining 100% functional offline
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, copy);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
          return caches.match('./');
        })
    );
    return;
  }

  // D. Static Assets (app.js, icons, fonts, manifest): Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const networkReq = url.origin === self.location.origin
        ? new Request(request, { cache: 'no-cache' })
        : request;
      const fetchPromise = fetch(networkReq)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, copy);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // If offline and request fails, cachedResponse will be returned
          return cachedResponse;
        });

      return cachedResponse || fetchPromise;
    })
  );
});
