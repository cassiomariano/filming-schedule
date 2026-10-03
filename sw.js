/* Service worker: keeps the app itself on the phone so it opens (even offline).
   Your calls are NOT stored here – Firebase keeps its own offline copy.
   Change VERSION when you change the list below, so phones drop the old copies. */
const VERSION = "fs-shell-v9";
const SHELL = ["./", "index.html", "parser.js", "money.js", "firebase-config.js", "manifest.webmanifest", "icon-180.png", "icon.svg"];

// install: save the app files (one missing file doesn't stop the others)
self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(cache =>
    Promise.all(SHELL.map(f => cache.add(f).catch(() => {})))
  ).then(() => self.skipWaiting()));
});

// activate: delete caches from older versions
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  // only our own files: Firebase and Google requests always go straight to the internet, never saved
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // the page itself, or one of the app files?
  const isPage = req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("/index.html");
  const file = url.pathname.split("/").pop();
  if (!isPage && !SHELL.includes(file)) return;
  const cacheKey = isPage ? "index.html" : file;

  // internet first (so updates show straight away); save a fresh copy; use the saved copy when offline
  event.respondWith(
    fetch(req, {cache: "no-cache"}).then(res => {          // asks the server, never an old copy in the browser
      if (res.ok){ const copy = res.clone(); caches.open(VERSION).then(c => c.put(cacheKey, copy)); }
      return res;
    }).catch(() => caches.match(cacheKey).then(hit => hit || caches.match("./")))
  );
});
