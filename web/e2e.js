'use strict';
/* StreamRec — сквозное шифрование в браузере (страница и service worker).
   Ключ AES-256-GCM получается из пароля на этом устройстве. Хранится в IndexedDB этого сайта;
   фоновому модулю (service worker) страница передаёт его напрямую — так работает и в Safari. */
(function (G) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sr-e2e', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('k');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function tx(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => {
      let out;
      try {
        const t = db.transaction('k', mode);
        out = fn(t.objectStore('k'));
        t.oncomplete = () => res(out && out.result);
        t.onerror = () => rej(t.error || new Error('IndexedDB'));
        t.onabort = () => rej(t.error || new Error('IndexedDB abort'));
      } catch (e) { rej(e); }
    });
  }
  const importRaw = (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  let cached = null, raw = null, sess = null;

  const E2E = {
    async derive(password, saltB64, iter) {
      const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: iter || 600000 }, base, 512));
      const r = bits.slice(0, 32);
      const auth = b64(bits.slice(32));
      bits.fill(0);
      return { key: await importRaw(r), auth, raw: r };
    },
    // хранение: байты ключа + пропуск (только на этом устройстве)
    async save(key, rawBytes) {
      cached = key; raw = new Uint8Array(rawBytes);
      await tx('readwrite', (s) => s.put({ raw }, 'enc'));
    },
    async saveSession(t) { sess = t; await tx('readwrite', (s) => s.put(t, 'sess')); },
    async key() {
      if (cached) return cached;
      if (raw) { cached = await importRaw(raw); return cached; }
      let v = null;
      try { v = await tx('readonly', (s) => s.get('enc')); } catch (e) { v = null; }
      if (v && v.raw) { raw = new Uint8Array(v.raw); cached = await importRaw(raw); }
      return cached;
    },
    async session() {
      if (sess) return sess;
      try { sess = (await tx('readonly', (s) => s.get('sess'))) || null; } catch (e) { sess = null; }
      return sess;
    },
    async exportForWorker() { await E2E.key(); await E2E.session(); return raw && sess ? { raw, sess } : null; },
    async setFromPage(r, s) { raw = new Uint8Array(r); cached = await importRaw(raw); sess = s; },
    async forget() { cached = null; raw = null; sess = null; try { await tx('readwrite', (s) => { s.delete('enc'); s.delete('sess'); }); } catch (e) { } },
    reset() { cached = null; raw = null; sess = null; },
    async seal(bytes, aad) {
      const k = await E2E.key(); if (!k) throw new Error('nokey');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, k, bytes));
      const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
    },
    async open(blob, aad) {
      const k = await E2E.key(); if (!k) throw new Error('nokey');
      const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: enc.encode(aad) }, k, b.slice(12)));
    },
    async openState(s) { return JSON.parse(dec.decode(await E2E.open(unb64(s), 'state'))); },
    async request(method, path, headers, body) {
      const id = b64(crypto.getRandomValues(new Uint8Array(12)));
      const plain = enc.encode(JSON.stringify({ id, ts: Date.now(), method, path, headers, body }));
      const hdr = { 'Content-Type': 'application/octet-stream' };
      const st = await E2E.session();
      if (st) hdr['X-SR-Session'] = st;
      const r = await fetch('/rpc', { method: 'POST', body: await E2E.seal(plain, 'req'), credentials: 'same-origin', cache: 'no-store', headers: hdr });
      if (r.status === 401) E2E.why = 'сервер не принял вход при запросе ' + path + (st ? '' : ' (пропуск не найден)');
      if (r.status !== 200) return new Response(await r.arrayBuffer(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
      const pt = await E2E.open(new Uint8Array(await r.arrayBuffer()), 'res');
      const hl = new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getUint32(0);
      const head = JSON.parse(dec.decode(pt.subarray(4, 4 + hl)));
      if (head.id !== id) throw new Error('ответ не соответствует запросу');
      const noBody = [101, 204, 205, 304].includes(head.status);
      return new Response(noBody ? null : pt.subarray(4 + hl), { status: head.status, headers: head.headers });
    },
  };
  G.E2E = E2E;
})(typeof window !== 'undefined' ? window : self);
