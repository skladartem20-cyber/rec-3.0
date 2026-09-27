'use strict';
/* Service worker: прозрачно шифрует все запросы интерфейса к ПК (данные, превью, видео). */
importScripts('/static/e2e.js');
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => { if (e.data === 'reset') E2E.reset(); });
const RE = /^\/(api\/|preview\/|thumb\/|files\/|hls\/)/;
const SKIP = /^\/api\/(login|logout|logout_all|e2e_salt)$/;
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin || !RE.test(u.pathname) || SKIP.test(u.pathname)) return;
  e.respondWith(handle(e.request, u));
});
async function handle(req, u) {
  try {
    const headers = {};
    const rg = req.headers.get('Range');
    if (rg) headers.Range = rg;
    const body = req.method === 'POST' ? await req.text() : null;
    return await E2E.request(req.method, u.pathname + u.search, headers, body);
  } catch (err) {
    const nokey = err && err.message === 'nokey';
    return new Response(JSON.stringify({ error: nokey ? 'auth' : 'ошибка шифрования: ' + (err && err.message) }),
      { status: nokey ? 401 : 502, headers: { 'Content-Type': 'application/json' } });
  }
}
