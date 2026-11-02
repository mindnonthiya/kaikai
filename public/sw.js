const CACHE_NAME = "kaikai-static-v1";
const PRECACHE_URLS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

const OFFLINE_HTML = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>kaikai — ออฟไลน์</title>
  <style>
    :root { --bg: #f7f5f0; --surface: #fffdfa; --ink: #1f2823; --muted: #6f776f; --primary: #e66729; --line: #e8e3da; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--bg);
      color: var(--ink);
      font-family: "Leelawadee UI", "Noto Sans Thai", system-ui, sans-serif;
    }
    .card {
      max-width: 380px;
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 28px 24px;
      text-align: center;
      box-shadow: 0 8px 30px rgba(47, 39, 28, .06);
    }
    .logo {
      width: 64px;
      height: 64px;
      border-radius: 18px;
      margin: 0 auto 16px;
      display: block;
    }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 20px; color: var(--muted); font-size: 14px; line-height: 1.6; }
    button {
      width: 100%;
      min-height: 46px;
      border: 0;
      border-radius: 12px;
      background: var(--primary);
      color: #fff;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="card">
    <img src="/icons/icon-192.png" alt="kaikai" class="logo" />
    <h1>ไม่มีสัญญาณอินเทอร์เน็ต</h1>
    <p>ไม่สามารถโหลดข้อมูลร้านได้ในขณะนี้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่อีกครั้ง</p>
    <button type="button" onclick="window.location.reload()">ลองเชื่อมต่อใหม่</button>
  </div>
</body>
</html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API routes, auth callbacks, or RSC data fetches
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    request.headers.get("RSC") === "1"
  ) {
    return;
  }

  // Static immutable build assets & app icons: Cache-first, fallback to network
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/apple-touch-icon.png"
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response && response.status === 200) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Full page navigations: Network-first, fallback to offline screen if completely disconnected
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        return new Response(OFFLINE_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }),
    );
  }
});
