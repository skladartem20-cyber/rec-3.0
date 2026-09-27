'use strict';
/* Запуск облачного интерфейса: ключ есть? -> service worker шифрования -> приложение. */
(async () => {
  const fail = (t) => { document.body.insertAdjacentHTML('afterbegin', `<div style="padding:24px;color:#ffb3bd">${t}</div>`); };
  if (!('serviceWorker' in navigator) || !(window.crypto && crypto.subtle) || !window.indexedDB) {
    return fail('Этот браузер не поддерживает защищённый режим (нужен HTTPS и современный Chrome / Safari / Firefox, не приватная вкладка).');
  }
  if (!(await E2E.key())) {
    if (sessionStorage.getItem('sr-nokey')) { sessionStorage.removeItem('sr-nokey'); return fail('Ключ шифрования не сохранился в браузере. Выключите приватный режим Safari и войдите снова: <a href="/login" style="color:#9fc7ff">вход</a>'); }
    sessionStorage.setItem('sr-nokey', '1');
    return location.replace('/login');
  }
  sessionStorage.removeItem('sr-nokey');
  try { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch (e) { return fail('Не удалось включить шифрование: ' + e.message); }
  if (!navigator.serviceWorker.controller) {
    await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 5000); });
    if (!navigator.serviceWorker.controller) {
      const n = +(sessionStorage.getItem('sr-reload') || 0);
      if (n < 2) { sessionStorage.setItem('sr-reload', n + 1); location.reload(); return; }
      return fail('Service worker не активировался. Обновите страницу.');
    }
  }
  sessionStorage.removeItem('sr-reload');
  const s = document.createElement('script');
  s.src = '/static/app.js';
  document.body.appendChild(s);
})();
