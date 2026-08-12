// Service Worker — litfeed
const CACHE_NAME = 'litfeed-v1';

const APP_SHELL = [
    './',
    './index.html',
    './app.js',
    './style.css',
    './manifest.json',
];

// JSON the app reads at runtime. Kept in one list so a new data file cannot be
// forgotten and then silently served from a stale cache.
const DATA_FILES = ['config.json', 'feed.json', 'toc.json', 'todos.json', 'library.json', 'done.json'];

// Install: cache app shell.
//
// Deliberately not cache.addAll(), which is atomic: one 404 rejects the whole
// call, the install fails, and the new worker never activates. That would pin
// the app to an old worker exactly when the host is misbehaving, which is when
// an update is most needed. Cache what is reachable, carry on regardless.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.all(APP_SHELL.map((url) =>
                fetch(url)
                    .then((response) => (response.ok ? cache.put(url, response) : null))
                    .catch(() => null)
            ))
        )
    );
    self.skipWaiting();
});

// Activate: clean old caches, but only once this version actually has a shell
// to serve. If install could not reach the host, the previous cache is the only
// working copy of the app and deleting it would leave nothing at all.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.match('./index.html'))
            .then((shell) => {
                if (!shell) return null;
                return caches.keys().then((keys) =>
                    Promise.all(
                        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
                    )
                );
            })
    );
    self.clients.claim();
});

// Everything is network-first, falling back to cache when offline.
//
// The shell used to be cache-first, so a shipped change only reached the browser
// once CACHE_NAME was manually bumped — and forgetting that bump pinned the app
// to an old build with no visible symptom other than "the new thing isn't there".
// Serving the right code matters more than shaving milliseconds off a warm load,
// and the cache still covers going offline.
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Only ever handle our own origin. Cross-origin GETs — above all the GitHub
    // API token check and sync — must reach the network untouched. If they pass
    // through the handler below, a real 401/403/404 hits the not-ok branch, finds
    // nothing in cache, and returns Response.error(), which rejects the caller's
    // fetch. That masked every GitHub auth failure as "Could not reach GitHub".
    if (url.origin !== self.location.origin) return;

    const isData = DATA_FILES.some((f) => url.pathname.endsWith(f));

    const fromCache = () => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // A navigation must still resolve offline, or the browser shows its own
        // error page instead of the app shell.
        if (!isData && event.request.mode === 'navigate') {
            return caches.match('./index.html');
        }
        return Response.error();
    });

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // A 404 or 500 RESOLVES the fetch promise, it does not reject, so
                // an unreachable origin must be handled here and not just in
                // .catch(). Without this, a host that starts serving 404s would
                // replace a working cached app with error pages. Falling back to
                // cache keeps the app usable until the host is fixed.
                if (!response.ok) return fromCache();
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                return response;
            })
            .catch(fromCache)
    );
});
