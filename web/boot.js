'use strict';
/* Запуск облачного интерфейса: ключ и вход есть? -> фоновый модуль (для картинок и видео) -> приложение. */
(async () => {
  const fail = (t) => { document.body.insertAdjacentHTML('afterbegin', `<div style="padding:24px;color:#ffb3bd">${t}</div>`); };
  if (!(window.crypto && crypto.subtle) || !window.indexedDB) {
    return fail('Этот браузер не поддерживает защищённый режим (нужен HTTPS и современный браузер, не приватная вкладка).');
  }
  const key = await E2E.key();
  if (!key) {
    sessionStorage.setItem('sr-why', 'ключ шифрования не найден в браузере — войдите заново');
    await E2E.forget();
    return location.replace('/login');
  }
  if (!(await E2E.session())) { sessionStorage.setItem('sr-why', 'нет сохранённого входа'); return location.replace('/login'); }

  // передаём ключ фоновому модулю (Safari не даёт ему прочитать хранилище самому)
  window.srPushKey = async () => {
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    const k = await E2E.exportForWorker();
    if (sw && k) sw.postMessage({ type: 'key', raw: k.raw, sess: k.sess });
  };
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      if (!navigator.serviceWorker.controller) {
        await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 4000); });
      }
      navigator.serviceWorker.addEventListener('controllerchange', () => window.srPushKey());
      navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'need-key') window.srPushKey(); });
      await window.srPushKey();
      setInterval(window.srPushKey, 20000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') window.srPushKey(); });
    } catch (e) { /* без фонового модуля: данные работают, картинки/видео — нет */ }
  }
  // запасной путь для картинок, если фоновый модуль не работает: страница сама грузит и расшифровывает
  const needFallback = () => !(navigator.serviceWorker && navigator.serviceWorker.controller);
  const IMG = /^\/(preview|thumb)\//;
  const fix = async (img) => {
    const src = img.getAttribute('src') || '';
    if (!IMG.test(src) || !needFallback()) return;
    img.dataset.srSrc = src;
    img.removeAttribute('src');
    try {
      const r = await E2E.request('GET', src, {}, null);
      if (r.status !== 200) { img.dispatchEvent(new Event('error')); return; }
      if (img.dataset.srSrc !== src) return;
      img.src = URL.createObjectURL(await r.blob());
      img.addEventListener('load', () => setTimeout(() => URL.revokeObjectURL(img.src), 1000), { once: true });
    } catch (e) { img.dispatchEvent(new Event('error')); }
  };
  new MutationObserver((ms) => {
    if (!needFallback()) return;
    for (const m of ms) {
      if (m.type === 'attributes' && m.target.tagName === 'IMG') fix(m.target);
      for (const n of m.addedNodes || []) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') fix(n);
        n.querySelectorAll && n.querySelectorAll('img').forEach(fix);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

  const s = document.createElement('script');
  s.src = '/static/app.js';
  document.body.appendChild(s);
})();
