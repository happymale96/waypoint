/* L-Tech Waypoint service worker (scope = the folder it is served from, e.g. /waypoint/).
 *
 * - BUILD is written by tools/stamp-sw.js (content hash of the app shell): every release gets a new cache name.
 * - install: skipWaiting(). activate: delete old "waypoint-*" caches, then clients.claim().
 * - Navigations and same-origin .html/.js/.css/.json: NETWORK-FIRST (revalidating, bypassing the HTTP cache so
 *   GitHub Pages' max-age can't serve stale code), falling back to the cache when offline or on a 5xx.
 * - Icons / fonts / images: CACHE-FIRST.
 * - Cross-origin requests (TomTom, Google APIs, anything else) are never intercepted or cached.
 */
const BUILD = 'ee362ecf';
const CACHE = 'waypoint-' + BUILD;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'solver.js', 'reached.js', 'lunchbreak.js', 'budget.js', 'traveltimes.js', 'providers.js', 'storage.js', 'messages.js', 'daylog.js', 'geo.js', 'fuel.js', 'onboard.js', 'jobedit.js', 'wakelock.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'maskable-192.png', 'icon-512-maskable.png', 'apple-touch-icon-180.png', 'favicon-48.png', 'favicon-32.png', 'favicon.svg', 'symbol-on-light.svg', 'symbol-on-dark.svg', 'symbol-header-onlight.svg'];
const NEVER_CACHE = /(^|\.)(tomtom\.com|googleapis\.com)$/i; // belt and braces: these are cross-origin anyway
const CODE = /\.(html|js|css|json)$/i;
const STATIC = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf)$/i;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // only our own old caches: other sites on the same github.io origin share CacheStorage
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('waypoint-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page can ask which build is running (shown in Settings).
self.addEventListener('message', (e) => {
  if (e.data === 'build' && e.ports && e.ports[0]) e.ports[0].postMessage(BUILD);
});

const keyFor = (req) => { const u = new URL(req.url); return u.origin + u.pathname; };

async function networkFirst(e, isNav) {
  const req = e.request;
  const cache = await caches.open(CACHE);
  const key = keyFor(req);
  try {
    const res = await fetch(new Request(req, { cache: 'no-cache' }));
    if (res.ok) { e.waitUntil(cache.put(key, res.clone()).catch(() => {})); return res; }
    if (res.status >= 500) throw new Error('HTTP ' + res.status);
    return res; // 404 etc. are real answers, not offline
  } catch (err) {
    const hit = (await cache.match(key)) || (isNav ? await cache.match('index.html') : undefined);
    return hit || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirst(e) {
  const req = e.request;
  const cache = await caches.open(CACHE);
  const key = keyFor(req);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) e.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.test(url.hostname)) return; // never touch APIs
  const isNav = req.mode === 'navigate';
  if (isNav || CODE.test(url.pathname) || url.pathname.endsWith('/')) e.respondWith(networkFirst(e, isNav));
  else if (STATIC.test(url.pathname)) e.respondWith(cacheFirst(e));
});
