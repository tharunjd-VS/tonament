// Tonament's service worker: lets the installed app (and the site) open
// when the venue Wi-Fi is down, without ever serving stale live data.
// - /api/… and anything not a same-origin GET: always the network, never cached.
// - Pages: always the network; offline, /offline (it reloads when the connection is back).
// - Scripts and styles: the network first (so a deploy shows at once), the cache offline.
// - Fonts, images, icons: the cache first (they rarely change), refreshed in the background.
// Bump VERSION to drop old caches.
const VERSION = 'v1';
const CACHE = `tonament-${VERSION}`;
const SHELL = [
  '/offline', '/styles.css', '/app.js', '/site.js', '/formats.js', '/schedule.js', '/regions.js', '/icons.svg',
  '/fonts/Outfit-Variable.woff2', '/brand/logo-white.svg', '/brand/mark-white.svg', '/brand/mark.svg', '/brand/icon-192.png', '/manifest.webmanifest',
  ...['badminton', 'rally', 'pickleball', 'table-tennis', 'squash', 'volleyball', 'beach-volleyball', 'throwball', 'sepak-takraw', 'tennis-core',
    'tennis', 'padel', 'frames', 'snooker', 'pool', 'carrom', 'timed', 'football', 'futsal', 'hockey', 'kabaddi', 'basketball', 'result', 'league', 'events', 'tie']
    .map((s) => `/sports/${s}.js`),
];

// Which way to fetch a request: 'skip' (the browser handles it), 'page', 'fresh' or 'cached'.
function strategy(url, request, origin) {
  if (request.method !== 'GET' || url.origin !== origin) return 'skip';
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return 'skip';
  if (request.mode === 'navigate') return 'page';
  if (/\.(js|css|webmanifest)$/.test(url.pathname)) return 'fresh';
  if (/\.(woff2|svg|png|jpg|jpeg|webp|ico)$/.test(url.pathname)) return 'cached';
  return 'skip';
}

if (typeof module === 'object' && module.exports) {
  module.exports = { strategy, SHELL, VERSION };
} else {
  self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tonament-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
  });
  const put = (request, response) => {
    if (response && response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return response;
  };
  // Notifications pushed from the server (server/notify.js): show it, and
  // open (or focus) the app on its page when it's tapped.
  self.addEventListener('push', (event) => {
    let n = {};
    try { n = event.data ? event.data.json() : {}; } catch { n = { title: event.data && event.data.text() }; }
    event.waitUntil(self.registration.showNotification(n.title || 'Tonament', {
      body: n.body || '', icon: '/brand/icon-192.png', badge: '/brand/icon-192.png', data: { url: n.url || '/' }, tag: n.url || undefined,
    }));
  });
  self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.location.origin));
      if (open) return open.focus().then((c) => (c && 'navigate' in c ? c.navigate(url) : null));
      return self.clients.openWindow(url);
    }));
  });
  self.addEventListener('fetch', (event) => {
    const { request } = event;
    const how = strategy(new URL(request.url), request, self.location.origin);
    if (how === 'skip') return;
    if (how === 'page') {
      event.respondWith(fetch(request).catch(() => caches.match('/offline')));
    } else if (how === 'fresh') {
      event.respondWith(fetch(request).then((r) => put(request, r)).catch(() => caches.match(request)));
    } else {
      event.respondWith(caches.match(request).then((hit) => {
        const network = fetch(request).then((r) => put(request, r));
        return hit || network;
      }));
    }
  });
}
