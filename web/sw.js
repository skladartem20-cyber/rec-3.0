'use strict';
/* Service worker: шифрует запросы картинок и видео к ПК. Ключ получает от страницы (postMessage). */
importScripts('/static/e2e.js');
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d === 'reset' || d.type === 'reset') E2E.reset();
  else if (d.type === 'key' && d.raw && d.sess) E2E.setFromPage(d.raw, d.sess);
});
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
    // 424 = у фонового модуля нет ключа (страница передаст его и повторит), не путать с «нет входа»
    const nokey = err && err.message === 'nokey';
    if (nokey) {
      const cs = await self.clients.matchAll();
      cs.forEach((c) => c.postMessage({ type: 'need-key' }));
    }
    return new Response(JSON.stringify({ error: nokey ? 'sw-nokey' : 'ошибка шифрования: ' + (err && err.message) }),
      { status: nokey ? 424 : 502, headers: { 'Content-Type': 'application/json' } });
  }
}
