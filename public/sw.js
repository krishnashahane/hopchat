/*
 * HopChat service worker — offline-first app shell.
 *
 * Strategy:
 *   - Immutable build assets (/_next/static/*): cache-first (hashed URLs never change).
 *   - Navigations: network-first, falling back to the cached shell when offline, so the
 *     app launches with no connectivity. All messaging is peer-to-peer anyway.
 *   - Everything else same-origin: stale-while-revalidate.
 * Cross-origin (e.g. STUN) requests and /api/* are never intercepted: relay responses
 * carry live ciphertext and must never be cached or replayed.
 */
const VERSION = "hopchat-v5";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const APP_SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

const pathOf = (request) => new URL(request.url).pathname;

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) (await caches.open(RUNTIME)).put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok && pathOf(request) === "/") (await caches.open(SHELL)).put("/", res.clone());
    return res;
  } catch {
    return (await caches.match(request)) || (await caches.match("/")) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (res) => {
      if (res.ok) (await caches.open(RUNTIME)).put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}
