const CACHE = "gacha-checklist-v50";

const PRECACHE_URLS = [
    "./",
    "./index.html",
    "./styles.css",
    "./script.js",
    "./data.js",
    "./manifest.json",
    "./images/icon-192.png",
    "./images/icon-512.png",
    "./images/icon-192-maskable.png",
    "./images/icon-512-maskable.png",
    "./images/gi-icon.png",
    "./images/hi3-icon.png",
    "./images/hsr-icon.png",
    "./images/zzz-icon.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Cache-first for same-origin assets, network-first (falling back to cache) for everything else.
self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;

    const url = new URL(event.request.url);

    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((res) => {
                    const clone = res.clone();
                    caches.open(CACHE).then((cache) => cache.put(event.request, clone));
                    return res;
                }).catch(() => cached);
            })
        );
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((res) => {
                const clone = res.clone();
                caches.open(CACHE).then((cache) => cache.put(event.request, clone));
                return res;
            })
            .catch(() => caches.match(event.request))
    );
});

// Reset reminders and low-progress nudges sent by sync-worker/worker.js.
self.addEventListener("push", (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        // Ignore - fall back to the generic title/body below.
    }
    event.waitUntil(
        self.registration.showNotification(data.title || "Gacha Checklist", {
            body: data.body || "",
            icon: "./images/icon-192.png",
            badge: "./images/icon-192-maskable.png",
            tag: data.tag,
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(self.clients.openWindow("./"));
});
