'use strict';
const $ = (id) => document.getElementById(id);
(async () => {
  const why = sessionStorage.getItem('sr-why');
  if (why) { $('err').textContent = 'Причина возврата на вход: ' + why; sessionStorage.removeItem('sr-why'); }
  try {
    const i = await (await fetch('/api/e2e_salt')).json();
    $('code').hidden = !i.totp;
  } catch { }
})();
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('err'), go = $('go');
  err.textContent = ''; go.disabled = true; go.textContent = 'Вычисляю ключ шифрования…';
  try {
    if (!(window.crypto && crypto.subtle)) throw new Error('Нужен HTTPS и современный браузер');
    const info = await (await fetch('/api/e2e_salt', { cache: 'no-store' })).json();
    if (!info.salt) throw new Error('Облако не настроено (нет E2E_SALT)');
    const { key, auth, raw } = await E2E.derive($('pw').value, info.salt, info.iter);
    go.textContent = 'Проверка…';
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ auth, code: $('code').value }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'Ошибка входа');
    await E2E.save(key, raw);
    if (d.session) await E2E.saveSession(d.session);
    E2E.reset();
    if (!(await E2E.key())) throw new Error('Браузер не сохранил ключ. Выключите приватный режим и разрешите данные сайтов.');
    E2E.reset();
    if (!(await E2E.session())) throw new Error('Браузер не сохранил вход. Выключите приватный режим Safari и повторите.');
    sessionStorage.removeItem('sr-401');
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'key', raw, sess: d.session });
    }
    location.replace('/');
    return;
  } catch (x) {
    err.textContent = x.message || 'Нет связи с сервером';
    $('pw').value = '';
  }
  go.disabled = false; go.textContent = 'Войти';
});
