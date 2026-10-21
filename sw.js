// EdgeBot offline support: app shell cached; picks data network-first with the last copy as fallback.
const CACHE = "edgebot-v13";
const SHELL = ["./", "index.html", "engine.js", "manifest.json", "icons/icon-180.png", "icons/icon-192.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url), data = url.hostname === "raw.githubusercontent.com" && /\/(app|profiles)\.json$/.test(url.pathname);
  const same = url.origin === self.location.origin, lib = url.hostname === "cdnjs.cloudflare.com" || url.hostname.endsWith("gstatic.com") || url.hostname === "fonts.googleapis.com";
  if (!data && !same && !lib) return;
  const key = data ? new Request(url.origin + url.pathname) : req;
  e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); e.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy))); } return res; })
    .catch(() => caches.match(key).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});
