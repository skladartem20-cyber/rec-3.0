'use strict';
/* StreamRec web UI — ПК и телефон */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ico = (n) => `<svg class="i"><use href="#i-${n}"/></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  data: null, skew: 0, recvAt: 0, tab: 'recs', local: false, settings: null,
  lastToast: Date.now() / 1000, cards: new Map(), wcells: new Map(), savedSig: '', files: [],
};
const isMobile = () => matchMedia('(max-width: 760px)').matches;

// ------------------------------------------------------------ formatting
function fmtBytes(b) {
  if (!b) return '0 МБ';
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0) + ' МБ';
  return (b / 1024 ** 3).toFixed(2) + ' ГБ';
}
function fmtDur(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
function fmtDate(t) {
  const d = new Date(t * 1000);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
const nowSrv = () => Date.now() / 1000 + S.skew;

// ------------------------------------------------------------ net
async function api(path, data) {
  const opt = data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  const r = await fetch(path, opt);
  if (r.status === 401) { authLost(); throw new Error('auth'); }
  return r.json();
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

function copy(text) {
  const done = () => toast('Скопировано');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
    document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
    try { document.execCommand('copy'); done(); } catch { toast('Не удалось скопировать', 'error'); }
    ta.remove();
  }
}

let ws, wsTimer, wsBackoff = 500;
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { wsBackoff = 500; S.wsOpen = true; $('#offline').classList.remove('show'); };
  ws.onmessage = async (e) => {
    let d = JSON.parse(e.data);
    if (d.type === 'meta') {        // облако: открытые служебные данные (онлайн ли ПК)
      S.meta = d;
      if (!S.cloud) { S.cloud = true; applyMode(); }
      if (!S.data) S.data = { type: 'state', now: 0, recs: [], watch: [], monitors: [], toasts: [], status: {} };
      applyMeta(S.data);
      render();
      return;
    }
    if (d.type === 'enc') {         // облако: состояние зашифровано на ПК
      try { d = await window.E2E.openState(d.d); } catch (err) { keyProblem(); return; }
      if (S.data && S.data.now && d.now < S.data.now) return;
      applyMeta(d);
    }
    if (d.type !== 'state') return;
    S.skew = d.now - Date.now() / 1000;
    S.recvAt = Date.now();
    S.data = d;
    if (d.status?.cloud_mode && !S.cloud) { S.cloud = true; applyMode(); }
    render();
  };
  ws.onclose = (e) => {
    S.wsOpen = false;
    $('#offline').textContent = S.cloud ? 'Нет связи с облаком — переподключение…' : 'Нет связи с сервером — переподключение…';
    $('#offline').classList.add('show');
    if (S.data) { S.data.status.server = false; renderStatus(); }
    clearTimeout(wsTimer);
    wsTimer = setTimeout(async () => {
      try { const r = await fetch(S.cloud ? '/healthz' : '/api/ping'); if (r.status === 401) { authLost(); return; } } catch { }
      connect();
    }, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 1.7, 5000);
  };
}

// ------------------------------------------------------------ tabs
function setTab(t) {
  S.tab = t;
  $$('.tab, .bnav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + t));
  if (t === 'files') loadFiles();
  if (t === 'settings') loadSettings();
  if (t === 'phone') loadConnect();
  if (t === 'watch') renderWatch();
  if (t === 'mon') renderMon(true);
  if (t === 'journal') loadJournal();
  pauseGrid(t !== 'watch');
  history.replaceState(null, '', '#' + t);
}
$$('.tab, .bnav button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ------------------------------------------------------------ status
function renderStatus() {
  const st = S.data?.status || {};
  const pills = [];
  const pill = (on, label, val, cls = '', title = '') =>
    `<span class="pill ${on === true ? 'on' : on === 'warn' ? 'warn' : ''} ${cls}" title="${esc(title)}"><i></i>${label}${val ? ' <b>' + val + '</b>' : ''}</span>`;
  if (S.cloud) {
    pills.push(pill(!!S.wsOpen, 'Облако', st.viewers > 1 ? st.viewers : '', '', 'Связь этого устройства с облаком'));
    pills.push(pill(!!st.server, 'ПК', '', '', st.server ? 'Компьютер на связи' : 'Компьютер не на связи' + (st.pc_seen ? ', последний раз ' + fmtDate(st.pc_seen) : '')));
  } else pills.push(pill(!!st.server, S.local ? 'Сервер' : 'ПК', '', '', 'Связь с программой записи'));
  if (S.local && st.cloud?.enabled) pills.push(pill(st.cloud.connected ? true : 'warn', 'Облако', st.cloud.viewers ? st.cloud.viewers : '', '',
    st.cloud.connected ? `Подключено к облаку, удалённых зрителей: ${st.cloud.viewers}` : 'Облако: ' + (st.cloud.error || 'подключение…')));
  pills.push(pill(st.ext > 0, 'Расширение', '', '', st.ext ? 'Расширение Chrome подключено' : 'Откройте Chrome с установленным расширением'));
  if (S.local) pills.push(pill(st.phones > 0 ? true : 'warn', 'Телефон', st.phones > 1 ? st.phones : '', 'click', 'Подключённые телефоны'));
  if (st.capture_mode !== 'extension') pills.push(pill(st.headless ? true : 'warn', 'Скрытый Chrome', '', '', st.headless ? 'Резервный поиск потоков доступен' : 'Chrome/Edge не найден — резервный поиск недоступен'));
  if (st.health) {
    const h = st.health;
    pills.push(pill(h.ok ? true : 'warn', 'Система', h.ok ? '✓' : h.issues.length, 'click sys',
      h.ok ? `Всё работает. Память ${h.mem_mb || '?'} МБ, задержка ${h.lag_ms} мс, работает ${Math.floor(h.uptime / 3600)} ч ${Math.floor(h.uptime % 3600 / 60)} мин` : h.issues.join('\n')));
  }
  if (S.local && st.no_sleep) pills.push(pill(true, 'Защита ПК', '', '', 'Идёт запись: Windows не уйдёт в сон, выключение ПК будет заблокировано с предупреждением'));
  pills.push(pill(!!st.ffmpeg, 'ffmpeg', '', '', st.ffmpeg ? 'ffmpeg найден' : 'ffmpeg не найден — см. настройки'));
  if (st.disk?.total) {
    const low = st.disk.free < 20 * 1024 ** 3;
    pills.push(pill(low ? 'warn' : true, 'Диск', fmtBytes(st.disk.free), '', 'Свободно в папке записей'));
  }
  $('#pills').innerHTML = pills.join('');
  $$('#pills .pill.click').forEach((p) => p.onclick = () => {
    if (p.classList.contains('sys')) { J.kind = 'health,warn,app'; $$('#jChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.k === J.kind)); setTab('journal'); }
    else setTab('phone');
  });
  const mons = S.data?.monitors || [];
  $('#nMon').textContent = mons.length;
  const ml = mons.filter((m) => m.status === 'live').length;
  $('#bnMon').textContent = ml ? '● ' + ml : '';
  $('#counters').innerHTML =
    `<span class="c-rec">Пишется <b>${st.recording || 0}</b></span><span class="c-wait">Ожидают <b>${st.waiting || 0}</b></span>`;
  $('#brandDot').classList.toggle('idle', !st.recording);
  renderIssues(st);
  const cs = $('#cloudState');
  if (cs) { const c = st.cloud || {}; cs.textContent = c.enabled ? (c.connected ? `Подключено. Удалённых зрителей: ${c.viewers || 0}` : 'Не подключено: ' + (c.error || 'подключение…')) : 'Выключено (включите, сохраните настройки)'; cs.style.color = c.key_mismatch ? 'var(--err)' : c.connected ? 'var(--ok)' : ''; if (c.connected && c.e2e) cs.textContent += c.key_mismatch ? ' · ОШИБКА: пароль в Timeweb (AUTH_VERIFIER) не совпадает с паролем на ПК' : ' · шифрование включено' + (c.integrity === 'ok' ? ' · пароль и код облака совпадают ✓' : ''); }
  $('#nRecs').textContent = S.data?.recs.length || 0;
  const nw = $('#nWatch'); if (nw) nw.textContent = S.data?.watch.length || 0;
  $('#bnRecs').textContent = st.recording ? '● ' + st.recording : '';
  document.title = st.recording ? `● ${st.recording} — StreamRec` : 'StreamRec';
}

// ------------------------------------------------------------ records
const STATE_TXT = {
  recording: 'Запись', starting: 'Подключение', capturing: 'Поиск потока', retrying: 'Ожидание',
  stopped: 'Остановлено', ended: 'Завершено', error: 'Ошибка', interrupted: 'Прервано',
};
const isActive = (s) => ['recording', 'starting', 'capturing', 'retrying'].includes(s);

function mkCard(r) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = r.id;
  el.innerHTML = `
    <div class="thumb"><img alt="" loading="lazy" hidden><div class="ph"></div>
      <span class="badge tl"></span><span class="badge br"></span></div>
    <div class="body">
      <div class="row1"><span class="nick"></span><span class="state"></span><span class="acts"></span></div>
      <div class="stats"></div>
      <span class="link" data-k="page"><em>URL</em><span></span></span>
      <span class="link" data-k="m3u8"><em>M3U8</em><span></span></span>
      <div class="note"></div>
    </div>`;
  el.addEventListener('click', (e) => {
    const r = S.data.recs.find((x) => x.id === el.dataset.id);
    if (!r) return;
    const link = e.target.closest('.link');
    if (link) { const v = link.dataset.k === 'page' ? r.page_url : r.m3u8; if (v) copy(v); return; }
    const b = e.target.closest('[data-act]');
    if (b) { e.stopPropagation(); cardAction(b.dataset.act, r); return; }
    openRec(r);
  });
  return el;
}

async function cardAction(act, r) {
  if (act === 'stop') { toast(`Останавливаю ${r.nick}…`); await api('/api/rec/stop', { id: r.id }); }
  else if (act === 'delete') await api('/api/rec/delete', { id: r.id });
  else if (act === 'restart') { await api('/api/rec/restart', { id: r.id }); toast('Перезапуск записи'); }
}

function updateCard(el, r) {
  const sig = JSON.stringify([r.state, r.preview_t, r.nick, r.res, r.page_url, r.m3u8, r.error, r.retry_note, r.attempt, r.next_retry_at, r.size, r.dur, r.parts.length]);
  el.className = 'card s-' + r.state;
  if (el._sig === sig) { tickCard(el, r); return; }
  el._sig = sig;
  $('.nick', el).textContent = r.nick;
  $('.nick', el).title = r.title || r.nick;
  $('.state', el).textContent = STATE_TXT[r.state] || r.state;
  const img = $('.thumb img', el), ph = $('.thumb .ph', el);
  if (r.preview_t) {
    const src = `/preview/${r.id}.jpg?t=${r.preview_t}`;
    if (img.dataset.src !== src) {
      const pre = new Image();
      pre.onload = () => { img.src = src; img.hidden = false; ph.innerHTML = ''; };
      pre.src = src; img.dataset.src = src;
    }
  } else {
    img.hidden = true;
    ph.innerHTML = r.state === 'capturing' || r.state === 'starting' ? '<div class="spin"></div>' : 'нет превью';
  }
  let ov = $('.retry-ov', el);
  if (r.state === 'retrying') {
    if (!ov) { ov = document.createElement('div'); ov.className = 'retry-ov'; $('.thumb', el).append(ov); }
  } else if (ov) ov.remove();

  const acts = [];
  if (isActive(r.state)) acts.push(`<button class="btn sm icon danger" data-act="stop" title="Остановить запись">${ico('stop')}</button>`);
  else {
    if (r.page_url || r.m3u8) acts.push(`<button class="btn sm icon" data-act="restart" title="Записать снова">${ico('retry')}</button>`);
    acts.push(`<button class="btn sm icon ghost" data-act="delete" title="Убрать из списка">${ico('x')}</button>`);
  }
  $('.acts', el).innerHTML = acts.join('');
  const [pl, ml] = $$('.link', el);
  pl.hidden = !r.page_url; $('span', pl).textContent = r.page_url || '';
  ml.hidden = !r.m3u8; $('span', ml).textContent = r.m3u8 || '';
  pl.title = ml.title = 'Нажмите, чтобы скопировать';
  const br = $('.badge.br', el);
  br.textContent = r.res || ''; br.hidden = !r.res;
  tickCard(el, r);
}

function tickCard(el, r) {
  const live = r.state === 'recording';
  const drift = live ? Math.max(0, (Date.now() - S.recvAt) / 1000) : 0;
  const dur = r.dur + Math.min(drift, 3);
  const tl = $('.badge.tl', el);
  if (live) { tl.hidden = false; tl.innerHTML = `<span class="live"></span>${fmtDur(dur)}`; }
  else if (r.dur) { tl.hidden = false; tl.textContent = fmtDur(r.dur); }
  else tl.hidden = true;
  const parts = r.parts.length > 1 ? `<span>файлов <b>${r.parts.length}</b></span>` : '';
  const saving = r.parts.some((p) => p.state === 'saving') ? '<span>сохранение mp4…</span>' : '';
  const src = r.source === 'monitor' ? '<span class="tag">канал</span>' : '';
  $('.stats', el).innerHTML = `<span><b>${fmtBytes(r.size)}</b></span><span><b>${fmtDur(dur)}</b></span>${parts}${saving}${src}`;
  let note = '';
  if (r.state === 'retrying') {
    const left = r.next_retry_at ? Math.max(0, r.next_retry_at - nowSrv()) : 0;
    const ov = $('.retry-ov', el);
    if (ov) ov.innerHTML = r.next_retry_at ? `${fmtDur(left)}<small>${r.attempt ? 'попытка ' + r.attempt + '/' + r.attempts_total : 'повтор'}</small>` : `<div><div class="spin" style="margin:auto;border-top-color:var(--retry)"></div><small>поиск потока</small></div>`;
    note = (r.retry_note || 'Повторная попытка') + (r.next_retry_at ? ` через ${fmtDur(left)}` : '') + (r.error ? ` · ${r.error}` : '');
  } else if (r.state === 'capturing') note = 'Ищу поток на странице (фоновая вкладка / скрытый Chrome)…';
  else if (r.state === 'starting') note = 'Подключаюсь к потоку…';
  else if (r.state === 'error' || r.state === 'ended') note = r.error || '';
  $('.note', el).textContent = note;
  $('.note', el).hidden = !note;
}

function renderRecs() {
  const box = $('#recList');
  const recs = S.data.recs;
  if (!recs.length) {
    S.cards.clear();
    box.innerHTML = `<div class="empty"><h3>Записей пока нет</h3>Вставьте ссылку на трансляцию выше или нажмите «Записать» в расширении Chrome.</div>`;
    return;
  }
  if (box.querySelector('.empty')) box.innerHTML = '';
  const groups = [
    ['live', 'Идёт запись', recs.filter((r) => ['recording', 'starting', 'capturing'].includes(r.state))],
    ['wait', 'Повторные попытки', recs.filter((r) => r.state === 'retrying')],
    ['done', 'Завершённые', recs.filter((r) => !isActive(r.state))],
  ];
  const seen = new Set();
  for (const [key, title, list] of groups) {
    let sec = box.querySelector(`[data-g="${key}"]`);
    if (!sec) {
      sec = document.createElement('div');
      sec.dataset.g = key;
      sec.innerHTML = `<div class="group-h"><span class="gt"></span><span class="line"></span>${key === 'done' ? '<button class="btn sm ghost" data-clear>Очистить</button>' : ''}</div><div class="cards"></div>`;
      const clr = sec.querySelector('[data-clear]');
      if (clr) clr.onclick = () => api('/api/rec/clear', {});
      box.append(sec);
    }
    sec.hidden = !list.length;
    $('.gt', sec).textContent = `${title} — ${list.length}`;
    const grid = $('.cards', sec);
    list.forEach((r, i) => {
      let el = S.cards.get(r.id);
      if (!el) { el = mkCard(r); S.cards.set(r.id, el); }
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
      updateCard(el, r);
      seen.add(r.id);
    });
  }
  for (const [id, el] of S.cards) if (!seen.has(id)) { el.remove(); S.cards.delete(id); }
  // обновить открытый плеер (инфо)
  if (M.rec) { const r = recs.find((x) => x.id === M.rec); if (r) renderRecInfo(r); }
}

setInterval(() => {
  if (!S.data) return;
  for (const r of S.data.recs) {
    if (r.state === 'recording' || r.state === 'retrying') { const el = S.cards.get(r.id); if (el) tickCard(el, r); }
  }
}, 1000);

// ------------------------------------------------------------ add form
$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#addUrl').value.trim();
  if (!url) return;
  const st = $('#addStatus');
  st.className = 'addstatus';
  st.textContent = /\.m3u8/i.test(url) ? 'Подключаюсь к потоку…' : 'Отправлено в браузер: открываю страницу в фоне и ищу поток…';
  try {
    const r = await api('/api/record', { url });
    if (!r.ok) throw new Error(r.error || 'ошибка');
    $('#addUrl').value = '';
    st.textContent = r.dup ? 'Эта трансляция уже записывается.' : 'Добавлено — статус виден в блоке ниже.';
    setTimeout(() => { if (st.textContent.startsWith('Добавлено') || st.textContent.startsWith('Эта')) st.textContent = ''; }, 4000);
  } catch (err) { st.className = 'addstatus err'; st.textContent = 'Не удалось: ' + err.message; }
});
$('#addWatch').addEventListener('click', async () => {
  const url = $('#addUrl').value.trim();
  if (!url) return $('#addUrl').focus();
  const st = $('#addStatus');
  st.className = 'addstatus'; st.textContent = 'Ищу поток для просмотра…';
  const r = await api('/api/watch/add', { url });
  if (r.ok) { $('#addUrl').value = ''; st.textContent = ''; toast('Добавлено в сетку просмотра'); }
  else { st.className = 'addstatus err'; st.textContent = 'Не удалось: ' + (r.error || ''); }
});

$('#stopAll').addEventListener('click', async () => {
  const n = (S.data?.status.active || 0) + (S.data?.status.waiting || 0);
  if (!n) return toast('Нет активных записей');
  if (!confirm(`Остановить все записи (${n})?`)) return;
  await api('/api/rec/stop_all', {});
});

// ------------------------------------------------------------ player modal
const M = { hls: null, rec: null };
function playSrc(src, isHls) {
  const v = $('#mVideo');
  if (M.hls) { M.hls.destroy(); M.hls = null; }
  v.removeAttribute('src');
  if (isHls && window.Hls && Hls.isSupported()) {
    M.hls = new Hls({ liveSyncDurationCount: 3, maxBufferLength: 20, enableWorker: true, lowLatencyMode: false });
    M.hls.loadSource(src);
    M.hls.attachMedia(v);
    M.hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => M.hls && M.hls.startLoad(), 2000);
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) M.hls.recoverMediaError();
    });
  } else v.src = src;
  v.play().catch(() => { });
}
function openModal(title) {
  $('#mTitle').textContent = title;
  $('#modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  $('#modal').classList.remove('open');
  document.body.style.overflow = '';
  if (M.hls) { M.hls.destroy(); M.hls = null; }
  const v = $('#mVideo'); v.pause(); v.removeAttribute('src'); v.load();
  M.rec = null;
}
$('#mClose').onclick = closeModal;
$('#mFull').onclick = () => { const v = $('#mVideo'); (v.requestFullscreen || v.webkitEnterFullscreen)?.call(v); };
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openRec(r) {
  M.rec = r.id;
  openModal(r.nick + (r.res ? ' · ' + r.res : ''));
  $('#mInfo').innerHTML = '';
  if (r.m3u8) playSrc(`/hls/rec/${r.id}`, true);
  renderRecInfo(r);
}
function renderRecInfo(r) {
  const box = $('#mInfo');
  const sig = JSON.stringify([r.state, r.parts, r.page_url]);
  if (box._sig === sig) return;
  box._sig = sig;
  const parts = r.parts.map((p) => `
    <div class="part"><span class="pn">${esc(p.name)}</span><span>${fmtBytes(p.size)}</span><span>${p.dur ? fmtDur(p.dur) : ''}</span>
      ${p.state === 'saved' && p.name.endsWith('.mp4') ? `<button class="btn sm" data-play="${esc(p.name)}">${ico('play')}Смотреть</button>` : `<span>${{ recording: 'пишется', saving: 'сохранение…', failed: 'ошибка' }[p.state] || ''}</span>`}
    </div>`).join('');
  box.innerHTML = `
    <div class="stats"><span>${STATE_TXT[r.state] || r.state}</span>${r.page_url ? `<a href="${esc(r.page_url)}" target="_blank" rel="noopener">Открыть страницу</a>` : ''}</div>
    ${r.page_url ? `<span class="link" data-copy="${esc(r.page_url)}"><em>URL</em>${esc(r.page_url)}</span>` : ''}
    ${r.m3u8 ? `<span class="link" data-copy="${esc(r.m3u8)}"><em>M3U8</em>${esc(r.m3u8)}</span>` : ''}
    <div class="parts">${parts || '<span style="color:var(--muted)">Файлов пока нет</span>'}</div>
    <div style="display:flex;gap:8px;margin-top:6px">
      ${r.m3u8 ? `<button class="btn sm" data-live>${ico('eye')}Прямой эфир</button>` : ''}
      ${isActive(r.state) ? `<button class="btn sm danger" data-stop>${ico('stop')}Остановить запись</button>` : ''}
    </div>`;
  box.onclick = (e) => {
    const c = e.target.closest('[data-copy]'); if (c) return copy(c.dataset.copy);
    const p = e.target.closest('[data-play]'); if (p) return playSrc('/files/' + encodeURIComponent(p.dataset.play), false);
    if (e.target.closest('[data-live]')) return playSrc(`/hls/rec/${r.id}`, true);
    if (e.target.closest('[data-stop]')) cardAction('stop', r);
  };
}

// ------------------------------------------------------------ watch grid (ПК)
// Сетка просмотра: трансляции из «Смотреть» + (по желанию) идущие записи.
// Настройки сетки хранятся на каждом устройстве отдельно (телефону — свои).
const G = {
  cols() { return +(localStorage.getItem('sr-cols') || (isMobile() ? 2 : (S.data?.status.grid_columns || 4))); },
  max() { return +(localStorage.getItem('sr-gmax') || (isMobile() ? 4 : 16)); },
  recs() { const v = localStorage.getItem('sr-grecs'); return v === null ? true : v === '1'; },
};
function gridItems() {
  const items = S.data.watch.map((w) => ({ key: 'w:' + w.id, kind: 'watch', id: w.id, nick: w.nick || w.title, src: `/hls/watch/${w.id}`, m3u8: w.m3u8, page: w.page_url }));
  if (G.recs()) {
    const have = new Set(items.map((x) => x.m3u8).concat(items.map((x) => x.page)).filter(Boolean));
    for (const r of S.data.recs) {
      if (r.state !== 'recording' || !r.m3u8) continue;
      if (have.has(r.m3u8) || (r.page_url && have.has(r.page_url))) continue;
      items.push({ key: 'r:' + r.id, kind: 'rec', id: r.id, nick: r.nick, src: `/hls/rec/${r.id}`, m3u8: r.m3u8, page: r.page_url, rec: r });
    }
  }
  return items;
}
function renderWatch() {
  if (!S.data || S.tab !== 'watch') return;
  const list = gridItems();
  const grid = $('#wgrid');
  $('#wempty').hidden = list.length > 0;
  const cols = G.cols();
  grid.style.setProperty('--cols', cols); $('#cols').value = cols; $('#colsV').textContent = cols;
  if (document.activeElement !== $('#gridMax')) $('#gridMax').value = String(G.max());
  $('#gridRecs').checked = G.recs();
  const active = S.data.recs.filter((r) => isActive(r.state));
  const recUrls = new Set(active.map((r) => r.m3u8).concat(active.map((r) => r.page_url)).filter(Boolean));
  const seen = new Set();
  const limit = G.max();
  list.forEach((w, i) => {
    let c = S.wcells.get(w.key);
    if (!c) {
      c = document.createElement('div');
      c.className = 'wcell';
      c.innerHTML = `<video muted playsinline autoplay></video><div class="werr"></div>
        <button class="wstart">Нажмите, чтобы включить</button>
        <div class="wbar"><span class="nm"></span>
          <button class="btn sm icon" data-a="mute" title="Звук">${ico('mute')}</button>
          <button class="btn sm icon" data-a="full" title="Во весь экран">${ico('full')}</button>
          ${w.kind === 'watch' ? `<button class="btn sm primary" data-a="rec" title="Записать">${ico('rec')}</button>
          <button class="btn sm icon" data-a="del" title="Убрать">${ico('x')}</button>` : ''}</div>
        ${w.kind === 'rec' ? '<span class="wbadge"><i></i>запись</span>' : ''}`;
      const v = $('video', c);
      c._item = w;
      c.addEventListener('click', async (e) => {
        if (e.target.closest('.wstart')) { c._forced = true; startCell(c); c.classList.remove('off'); return; }
        const b = e.target.closest('[data-a]'); if (!b) return;
        const a = b.dataset.a;
        if (a === 'mute') {
          const on = v.muted;
          if (on) for (const o of S.wcells.values()) { if (o !== c) { $('video', o).muted = true; const mb = $('[data-a=mute]', o); if (mb) mb.innerHTML = ico('mute'); } }
          v.muted = !on; b.innerHTML = ico(v.muted ? 'mute' : 'vol');
        }
        else if (a === 'full') (v.requestFullscreen || v.webkitEnterFullscreen)?.call(v);
        else if (a === 'rec') { const r = await api('/api/watch/record', { id: c._item.id }); toast(r.ok === false ? 'Ошибка: ' + (r.error || '') : r.dup ? 'Уже записывается' : 'Запись начата'); }
        else if (a === 'del') { stopCell(c); await api('/api/watch/delete', { id: c._item.id }); }
      });
      S.wcells.set(w.key, c);
    }
    c._item = w;
    $('.nm', c).textContent = w.nick || '';
    $('.nm', c).title = w.page || w.m3u8 || '';
    c.classList.toggle('isrec', w.kind === 'rec' || recUrls.has(w.m3u8) || (w.page && recUrls.has(w.page)));
    // лимит одновременных плееров (экономия трафика и батареи)
    const allowed = i < limit || c._forced;
    if (allowed && !c._hls && !c._native && document.visibilityState === 'visible') startCell(c);
    if (!allowed && (c._hls || c._native)) stopCell(c);
    c.classList.toggle('off', !allowed);
    if (grid.children[i] !== c) grid.insertBefore(c, grid.children[i] || null);
    seen.add(w.key);
  });
  for (const [k, c] of S.wcells) if (!seen.has(k)) { stopCell(c); c.remove(); S.wcells.delete(k); }
}
function startCell(c) {
  const v = $('video', c);
  const src = c._item.src;
  if (window.Hls && Hls.isSupported()) {
    const h = new Hls({ liveSyncDurationCount: 3, maxBufferLength: S.cloud ? 6 : 10, maxMaxBufferLength: 20,
      capLevelToPlayerSize: true, startLevel: 0, enableWorker: true });
    h.loadSource(src); h.attachMedia(v);
    h.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      $('.werr', c).textContent = 'Поток недоступен, повтор…';
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { try { h.recoverMediaError(); } catch { } return; }
      setTimeout(() => { if (c._hls === h) h.startLoad(); }, 4000);
    });
    h.on(Hls.Events.FRAG_LOADED, () => { $('.werr', c).textContent = ''; });
    c._hls = h;
  } else { v.src = src; c._native = true; }
  v.play().catch(() => { });
}
function stopCell(c) {
  const we = $('.werr', c); if (we) we.textContent = '';
  if (c._hls) { c._hls.destroy(); c._hls = null; }
  if (c._native) { const v = $('video', c); v.pause(); v.removeAttribute('src'); v.load(); c._native = false; }
}
function pauseGrid(pause) {
  for (const c of S.wcells.values()) {
    const v = $('video', c);
    if (pause) { if (c._hls) c._hls.stopLoad(); v.pause(); }
    else { if (c._hls) c._hls.startLoad(); v.play().catch(() => { }); }
  }
}
// экран телефона погас / вкладка скрыта — останавливаем сетку (трафик и батарея)
document.addEventListener('visibilitychange', () => { if (S.tab === 'watch') pauseGrid(document.visibilityState !== 'visible'); });
$('#cols').addEventListener('input', (e) => {
  const n = +e.target.value;
  localStorage.setItem('sr-cols', n);
  $('#wgrid').style.setProperty('--cols', n); $('#colsV').textContent = n;
  if (S.local && !isMobile()) { clearTimeout(e.target._t); e.target._t = setTimeout(() => api('/api/settings', { grid_columns: n }), 500); }
});
$('#gridMax').addEventListener('change', (e) => { localStorage.setItem('sr-gmax', e.target.value); for (const c of S.wcells.values()) c._forced = false; renderWatch(); });
$('#gridRecs').addEventListener('change', (e) => { localStorage.setItem('sr-grecs', e.target.checked ? '1' : '0'); renderWatch(); });
$('#muteAll').onclick = () => { for (const c of S.wcells.values()) { $('video', c).muted = true; const b = $('[data-a=mute]', c); if (b) b.innerHTML = ico('mute'); } };
$('#clearWatch').onclick = async () => { if (confirm('Убрать все трансляции из сетки?')) await api('/api/watch/clear', {}); };

// ------------------------------------------------------------ files
async function loadFiles() {
  const d = await api('/api/files');
  S.files = d.files;
  const total = d.files.reduce((a, f) => a + f.size, 0);
  const tdur = d.files.reduce((a, f) => a + (f.dur || 0), 0);
  $('#filesInfo').textContent = `${d.files.length} файлов · ${fmtBytes(total)} · ${fmtDur(tdur)}` + (S.local ? ` — ${d.dir}` : '');
  const box = $('#files');
  if (!d.files.length) { box.innerHTML = '<div class="empty" style="grid-column:1/-1"><h3>Готовых записей нет</h3>Остановленные записи появятся здесь в MP4.</div>'; return; }
  box.innerHTML = d.files.map((f) => `
    <div class="file" data-n="${esc(f.name)}">
      <div class="thumb" data-a="play"><img src="/thumb/${encodeURIComponent(f.name)}" alt="" loading="lazy" data-rm>
        ${f.dur ? `<span class="badge br">${fmtDur(f.dur)}</span>` : ''}${f.res ? `<span class="badge tl">${esc(f.res)}</span>` : ''}
        ${f.playable ? `<div class="play-ov">${ico('play')}</div>` : ''}</div>
      <div class="fb"><span class="fn" title="${esc(f.title || f.nick)}">${esc(f.nick)}${f.src === 'monitor' ? ' <span class="tag">канал</span>' : ''}</span>
        <div class="stats"><span><b>${fmtBytes(f.size)}</b></span>${f.dur ? `<span><b>${fmtDur(f.dur)}</b></span>` : ''}<span>${fmtDate(f.mtime)}</span></div>
        <span class="link" data-copy="${esc(f.page_url || '')}" ${f.page_url ? '' : 'hidden'}><em>URL</em>${esc(f.page_url || '')}</span>
        <span class="link" data-copy="${esc(f.name)}"><em>ФАЙЛ</em>${esc(f.name)}</span>
        <div class="fa">
          ${f.playable ? `<button class="btn sm" data-a="play">${ico('play')}Смотреть</button>` : '<span class="btn sm ghost" style="cursor:default">.ts</span>'}
          ${S.cloud ? '' : `<a class="btn sm icon" href="/files/${encodeURIComponent(f.name)}?dl=1" title="Скачать">${ico('dl')}</a>`}
          ${S.local ? `<button class="btn sm icon only-pc" data-a="folder" title="Показать в папке">${ico('folder')}</button>` : ''}
          <button class="btn sm icon danger" data-a="del" title="Удалить файл" style="margin-left:auto">${ico('trash')}</button>
        </div></div></div>`).join('');
}
$('#files').addEventListener('click', async (e) => {
  const cp = e.target.closest('[data-copy]'); if (cp) return copy(cp.dataset.copy);
  const b = e.target.closest('[data-a]'); if (!b) return;
  const n = b.closest('.file').dataset.n;
  const f = S.files.find((x) => x.name === n);
  if (b.dataset.a === 'play' && f?.playable) { M.rec = null; openModal(n); $('#mInfo').innerHTML = ''; $('#mInfo')._sig = ''; playSrc('/files/' + encodeURIComponent(n), false); }
  else if (b.dataset.a === 'folder') api('/api/open-folder', { name: n });
  else if (b.dataset.a === 'del') { if (confirm(`Удалить файл ${n}?`)) { await api('/api/files/delete', { name: n }); loadFiles(); } }
});
$('#refreshFiles').onclick = loadFiles;
$('#openFolder').onclick = () => api('/api/open-folder', {});

// обновлять список готовых, когда сохраняется новый файл
function watchSaved() {
  const sig = S.data.recs.map((r) => r.parts.filter((p) => p.state === 'saved').length).join(',');
  if (sig !== S.savedSig) { S.savedSig = sig; if (S.tab === 'files') loadFiles(); }
}

// ------------------------------------------------------------ settings
const SCHEMA = [
  ['Запись', [
    ['quality', 'Качество записи', 'select', 'Выбирается из вариантов потока', [['best', 'Максимальное'], ['1080', 'До 1080p'], ['720', 'До 720p'], ['480', 'До 480p']]],
    ['remux_mp4', 'Сохранять в MP4', 'toggle', 'После остановки поток пересобирается в .mp4 без перекодирования'],
    ['keep_ts', 'Оставлять исходный .ts', 'toggle', 'Для подстраховки, занимает место'],
    ['min_part_kb', 'Минимальный размер файла, КБ', 'number', 'Более мелкие обрывки удаляются'],
    ['name_suffix_len', 'Случайных букв в имени', 'number', 'ник_xxxxx.mp4'],
    ['output_dir', 'Папка для записей', 'text', '', null, true],
  ]],
  ['Обрывы и повторы', [
    ['retry_delays_min', 'Попытки после окончания, мин', 'list', 'Через запятую. По умолчанию 1, 3, 5'],
    ['quick_retry_sec', 'Быстрое переподключение, сек', 'number', 'Сразу после обрыва; 0 — выключить'],
    ['stall_timeout_sec', 'Считать обрывом через, сек', 'number', 'Если файл перестал расти'],
    ['capture_mode', 'Как искать поток по ссылке', 'select', 'Авто: сначала расширение, если не нашло — скрытый Chrome', [['auto', 'Авто (рекомендуется)'], ['extension', 'Только расширение'], ['headless', 'Только скрытый Chrome']]],
    ['capture_timeout_sec', 'Ожидание m3u8 на странице, сек', 'number', 'Сколько ищется поток на одном этапе'],
    ['headless_idle_min', 'Закрывать скрытый Chrome через, мин', 'number', 'После простоя, чтобы не занимать память'],
    ['chrome_path', 'Путь к chrome.exe / msedge.exe', 'text', 'Пусто — автопоиск', null, true],
    ['resume_on_start', 'Возобновлять записи после перезапуска', 'toggle', ''],
  ]],
  ['Отслеживание каналов', [
    ['monitor_enabled', 'Отслеживание включено', 'toggle', 'Проверять ссылки со вкладки «Каналы» по расписанию'],
    ['monitor_interval_min', 'Проверять каждый канал раз в, мин', 'number', 'По умолчанию 60'],
    ['monitor_retry_min', 'Повторы после окончания эфира, мин', 'list', 'Через запятую. По умолчанию 1, 5, 10 — затем снова по расписанию'],
    ['monitor_parallel', 'Проверять одновременно', 'number', 'Сколько каналов проверяется параллельно (1–6)'],
    ['monitor_check_timeout_sec', 'Время на одну проверку, сек', 'number', 'Сколько ждать поток на странице канала'],
    ['health_interval_sec', 'Самопроверка программы, сек', 'number', 'Поиск и исправление зависаний; сводка в журнал раз в час'],
  ]],
  ['Превью и просмотр', [
    ['preview_interval_sec', 'Обновление превью, сек', 'number', ''],
    ['preview_width', 'Ширина превью, px', 'number', ''],
    ['grid_columns', 'Колонок в сетке просмотра', 'number', ''],
  ]],
  ['Программа', [
    ['password', 'Пароль для телефона', 'text', 'Смена пароля отключит подключённые телефоны', null, true],
    ['ffmpeg_path', 'Путь к ffmpeg.exe', 'text', 'Пусто — автопоиск (папка bin или PATH)', null, true],
    ['port', 'Порт', 'number', 'Применится после перезапуска', null, true],
    ['open_browser', 'Открывать интерфейс при запуске', 'toggle', '', null, true],
  ]],
];
async function loadSettings() {
  const s = await api('/api/settings');
  S.settings = s;
  const box = $('#settingsBox');
  box.innerHTML = SCHEMA.map(([g, rows]) => {
    const rs = rows.filter((r) => !r[5] || s._local).map(([k, label, type, hint, opts]) => {
      let ctl;
      const v = s[k];
      if (type === 'toggle') ctl = `<label class="switch"><input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}><span></span></label>`;
      else if (type === 'select') ctl = `<select data-k="${k}">${opts.map(([ov, ol]) => `<option value="${ov}" ${String(v) === ov ? 'selected' : ''}>${ol}</option>`).join('')}</select>`;
      else if (type === 'list') ctl = `<input type="text" data-k="${k}" value="${esc((v || []).join(', '))}">`;
      else ctl = `<input type="${type}" data-k="${k}" value="${esc(v)}">`;
      return `<div class="srow"><div class="lbl"><div>${label}</div>${hint ? `<small>${hint}</small>` : ''}</div>${ctl}</div>`;
    }).join('');
    return rs ? `<div class="sgroup"><h3>${g}</h3>${rs}</div>` : '';
  }).join('') + `
    ${s._local && !s._ffmpeg ? '<div class="sgroup"><h3 style="color:var(--err)">ffmpeg не найден</h3><div class="srow"><div class="lbl">Запустите start.bat — он скачает ffmpeg автоматически, или укажите путь к ffmpeg.exe выше.</div></div></div>' : ''}
    <div class="sgroup"><h3>Это устройство</h3>
      <div class="srow"><div class="lbl"><div>Интерфейс</div><small>${S.local ? 'Компьютер' : S.cloud ? 'Удалённый доступ через облако' : 'Телефон (Wi-Fi)'}, версия ${esc(S.data?.status.version || '')}</small></div>
      ${S.local ? '' : '<button class="btn sm" id="logout">Выйти</button>'}${S.cloud ? '<button class="btn sm danger" id="logoutAll">Выйти везде</button>' : ''}</div></div>
    ${S.local ? '<div class="sgroup" id="cloudTools"></div>' : ''}
    <div class="save-row"><button class="btn primary" id="saveSettings">Сохранить настройки</button><span id="saveMsg" style="color:var(--muted)"></span></div>`;
  $('#saveSettings').onclick = saveSettings;
  const lo = $('#logout'); if (lo) lo.onclick = async () => { await forgetKey(); try { await fetch('/api/logout', { method: 'POST' }); } catch { } location.href = '/login'; };
  const loa = $('#logoutAll'); if (loa) loa.onclick = async () => { if (!confirm('Выйти на всех устройствах?')) return; await forgetKey(); await fetch('/api/logout_all', { method: 'POST' }); location.href = '/login'; };
  if (S.local) renderCloudTools(s);
}
async function saveSettings() {
  const patch = {};
  $$('#settingsBox [data-k]').forEach((el) => {
    const k = el.dataset.k;
    patch[k] = el.type === 'checkbox' ? el.checked : el.value;
  });
  await api('/api/settings', patch);
  toast('Настройки сохранены');
  loadSettings();
}

// ------------------------------------------------------------ phone connect
async function loadConnect() {
  const d = await api('/api/connect');
  $('#pw').textContent = d.password || '—';
  const set = (u) => { $('#qrImg').src = '/api/qr.svg?u=' + encodeURIComponent(u); $$('#urlPick .btn').forEach((b) => b.classList.toggle('blue', b.dataset.u === u)); };
  $('#urlPick').innerHTML = d.urls.map((u) => `<button class="btn sm" data-u="${esc(u)}">${esc(u)}</button>`).join('');
  $$('#urlPick .btn').forEach((b) => b.onclick = () => set(b.dataset.u));
  set(d.urls[0]);
}

// ------------------------------------------------------------ toasts from server
function serverToasts() {
  for (const t of S.data.toasts || []) {
    if (t.t > S.lastToast) { toast(t.msg, t.kind); S.lastToast = t.t; }
  }
}

// ------------------------------------------------------------ main render
function render() {
  renderStatus();
  renderRecs();
  if (S.tab === 'watch') renderWatch();
  if (S.tab === 'mon') renderMon();
  if (S.tab === 'journal' && S.data.status.journal_n !== J.seen) loadJournalSoon();
  watchSaved();
  serverToasts();
}

(async function init() {
  try {
    const s = await api('/api/settings');
    S.local = !!s._local;
    S.cloud = !!s._cloud;
    S.settings = s;
  } catch { }
  try { if (!S.local && !S.cloud) { const p = await (await fetch('/healthz')).json(); if (p && 'pc' in p) S.cloud = true; } } catch { }
  applyMode();
  document.body.classList.toggle('is-local', S.local);
  if (!S.local) $$('.only-local').forEach((e) => e.remove());
  if (!S.local) $('.tab[data-tab="phone"]')?.remove();
  const h = location.hash.slice(1);
  setTab(['recs', 'mon', 'watch', 'files', 'journal', 'settings', 'phone'].includes(h) ? h : 'recs');
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) connect();
  });
})();

// ------------------------------------------------------------ каналы (отслеживание)
const MST = { live: 'Идёт запись', after: 'Повторы', checking: 'Проверка…', queued: 'В очереди', idle: 'Ожидание', error: 'Ошибка', off: 'Выключен' };
const MRES = { live: 'эфир найден', offline: 'нет эфира', busy: 'уже пишется', error: 'ошибка' };
const INTERVALS = [0, 15, 30, 60, 120, 180, 360];
function ago(t) {
  if (!t) return '—';
  const d = nowSrv() - t;
  if (d < 60) return 'только что';
  if (d < 3600) return Math.floor(d / 60) + ' мин назад';
  if (d < 86400) return Math.floor(d / 3600) + ' ч ' + Math.floor(d % 3600 / 60) + ' мин назад';
  return fmtDate(t);
}
function hhmm(t) { return t ? new Date(t * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''; }
const monRows = new Map();
function renderMon(force) {
  if (!S.data) return;
  const st = S.data.status;
  const list = S.data.monitors || [];
  const on = $('#monOn');
  if (document.activeElement !== on) on.checked = !!st.monitor_enabled;
  const sel = $('#monEvery');
  if (S.settings && document.activeElement !== sel) {
    const v = String(S.settings.monitor_interval_min);
    if (![...sel.options].some((o) => o.value === v)) sel.add(new Option(v, v));
    sel.value = v;
  }
  const c = (k) => list.filter((m) => m.status === k).length;
  $('#monSummary').textContent = list.length ? `каналов ${list.length} · пишется ${c('live')} · повторы ${c('after')} · проверяется ${c('checking') + c('queued')}` : '';
  const box = $('#monList');
  if (!list.length) { monRows.clear(); box.innerHTML = '<div class="empty"><h3>Каналов нет</h3>Вставьте ссылки выше — программа будет заходить на них по расписанию и записывать эфиры.</div>'; return; }
  if (box.querySelector('.empty')) box.innerHTML = '';
  const seen = new Set();
  list.forEach((m, i) => {
    let el = monRows.get(m.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'mrow';
      el.innerHTML = `<div class="mst"><i></i><span></span></div>
        <div class="mnick"><b></b><span class="link" title="Нажмите, чтобы скопировать"></span></div>
        <div class="mcell mlast"></div><div class="mcell mnext"></div><div class="mcell mstats"></div>
        <div class="mint"><select title="Интервал проверки">${INTERVALS.map((v) => `<option value="${v}">${v ? v + ' мин' : 'общий'}</option>`).join('')}</select></div>
        <div class="macts"><label class="switch" title="Отслеживать"><input type="checkbox"><span></span></label>
          <button class="btn sm icon" data-a="check" title="Проверить сейчас">${ico('retry')}</button>
          <button class="btn sm icon ghost" data-a="del" title="Удалить канал">${ico('x')}</button></div>`;
      el.addEventListener('click', async (e) => {
        const id = el.dataset.id;
        const mm = (S.data.monitors || []).find((x) => x.id === id); if (!mm) return;
        if (e.target.closest('.link')) return copy(mm.url);
        const b = e.target.closest('[data-a]'); if (!b) return;
        if (b.dataset.a === 'check') { await api('/api/mon/check', { id }); toast('Проверка поставлена в очередь'); }
        if (b.dataset.a === 'del' && confirm(`Удалить канал ${mm.nick}?`)) await api('/api/mon/delete', { id });
      });
      $('input[type=checkbox]', el).addEventListener('change', (e) => api('/api/mon/update', { id: el.dataset.id, enabled: e.target.checked }));
      $('select', el).addEventListener('change', (e) => api('/api/mon/update', { id: el.dataset.id, interval: +e.target.value }));
      monRows.set(m.id, el);
    }
    el.dataset.id = m.id;
    el.className = 'mrow m-' + (m.enabled ? m.status : 'off');
    $('.mst span', el).textContent = m.enabled ? (MST[m.status] || m.status) : 'Выключен';
    $('.mnick b', el).textContent = m.nick;
    $('.mnick .link', el).textContent = m.url;
    const res = m.last_result ? `<span class="r-${m.last_result}">${MRES[m.last_result] || m.last_result}</span>` : '';
    $('.mlast', el).innerHTML = `<span class="ell">Проверка: <b>${m.last_check ? hhmm(m.last_check) : '—'}</b> ${res}</span><span class="ell" title="${esc(m.last_msg || '')}">${esc(m.last_msg || '')}</span>`;
    let next = '';
    const rec = m.rec_id ? S.data.recs.find((r) => r.id === m.rec_id) : null;
    if (m.status === 'live' && rec) next = `Пишется <b>${fmtDur(rec.dur)}</b> · ${fmtBytes(rec.size)}`;
    else if (m.status === 'after' && rec) next = rec.next_retry_at ? `Повтор ${rec.attempt}/${rec.attempts_total} через <b>${fmtDur(rec.next_retry_at - nowSrv())}</b>` : 'Повтор: поиск потока…';
    else if (m.status === 'checking') next = 'Открываю страницу…';
    else if (m.status === 'queued') next = 'Ждёт очереди';
    else if (m.enabled && st.monitor_enabled && m.next_check) next = `Следующая: <b>${m.next_check <= nowSrv() ? 'сейчас' : hhmm(m.next_check)}</b>` + (m.next_check > nowSrv() ? ` (через ${fmtDur(m.next_check - nowSrv())})` : '');
    else if (!st.monitor_enabled) next = 'Отслеживание на паузе';
    $('.mnext', el).innerHTML = `<span class="ell">${next}</span>` + (m.last_live ? `<span class="ell">Эфир был: ${ago(m.last_live)}</span>` : '');
    $('.mstats', el).innerHTML = `<span class="ell">Проверок <b>${m.checks || 0}</b> · эфиров <b>${m.found || 0}</b></span><span class="ell">Записано <b>${fmtDur(m.rec_seconds || 0)}</b></span>`;
    const cb = $('input[type=checkbox]', el); if (document.activeElement !== cb) cb.checked = m.enabled;
    const sl = $('select', el); if (document.activeElement !== sl) sl.value = String(INTERVALS.includes(m.interval) ? m.interval : 0);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    seen.add(m.id);
  });
  for (const [id, el] of monRows) if (!seen.has(id)) { el.remove(); monRows.delete(id); }
}
setInterval(() => { if (S.tab === 'mon') renderMon(); }, 1000);
$('#monAdd').onclick = async () => {
  const urls = $('#monUrls').value.split(/\s+/).map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x));
  if (!urls.length) return toast('Вставьте ссылки (http/https), по одной в строке', 'error');
  const r = await api('/api/mon/add', { urls });
  $('#monUrls').value = '';
  toast(`Добавлено каналов: ${r.added}` + (r.dup ? `, уже были: ${r.dup}` : ''));
};
$('#monOn').onchange = async (e) => { await api('/api/settings', { monitor_enabled: e.target.checked }); toast(e.target.checked ? 'Отслеживание включено' : 'Отслеживание на паузе'); };
$('#monEvery').onchange = async (e) => { S.settings = await api('/api/settings', { monitor_interval_min: +e.target.value }); toast(`Проверка каждые ${e.target.value} мин`); };
$('#monCheckAll').onclick = async () => { await api('/api/mon/check', {}); toast('Все каналы поставлены в очередь проверки'); };

// ------------------------------------------------------------ журнал
const J = { kind: '', q: '', seen: -1, t: null };
const JRES = { live: 'эфир', offline: 'нет эфира', busy: 'уже пишется', ok: 'успешно', fail: 'неудачно', ended: 'эфир завершён', stopped: 'остановлено', problem: 'проблема', fixed: 'исправлено', start: 'запуск', stop: 'остановка', restart: 'перезапуск', error: 'ошибка' };
function loadJournalSoon() { clearTimeout(J.t); J.t = setTimeout(loadJournal, 700); }
async function loadJournal() {
  const d = await api(`/api/journal?limit=500&kind=${encodeURIComponent(J.kind)}&q=${encodeURIComponent(J.q)}`);
  J.seen = S.data?.status.journal_n ?? d.seq;
  const K = d.kinds;
  $('#jBody').innerHTML = d.items.length ? d.items.map((e) => {
    const det = [];
    if (e.dur) det.push(`длительность <b>${fmtDur(e.dur)}</b>`);
    if (e.size) det.push(`<b>${fmtBytes(e.size)}</b>`);
    if (e.parts > 1) det.push(`файлов ${e.parts}`);
    if (e.file) det.push(`<span class="f">${esc(e.file)}</span>`);
    if (e.msg) det.push(esc(e.msg));
    if (e.url && e.kind === 'check') det.push(`<span class="f">${esc(e.url)}</span>`);
    return `<tr><td>${esc(e.time)}</td><td class="ev">${esc(K[e.kind] || e.kind)}</td><td class="nk" title="${esc(e.url || '')}">${esc(e.nick || '')}</td>
      <td>${e.result ? `<span class="res x-${esc(e.result)}">${esc(JRES[e.result] || e.result)}</span>` : ''}</td><td class="jd">${det.join(' · ')}</td></tr>`;
  }).join('') : '<tr><td colspan="5" style="text-align:center;padding:30px">Записей нет</td></tr>';
}
$('#jChips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  J.kind = c.dataset.k;
  $$('#jChips .chip').forEach((x) => x.classList.toggle('active', x === c));
  loadJournal();
});
$('#jSearch').addEventListener('input', (e) => { J.q = e.target.value.trim(); loadJournalSoon(); });
$('#jClear').onclick = async () => { if (confirm('Очистить весь журнал?')) { await api('/api/journal', {}); loadJournal(); } };

// ------------------------------------------------------------ режимы: ПК / телефон в Wi-Fi / облако
function applyMode() {
  document.body.classList.toggle('is-cloud', !!S.cloud);
  if (S.cloud) {
    $$('.tab[data-tab="phone"]').forEach((e) => e.remove());
    if (S.tab === 'watch' || S.tab === 'phone') setTab('recs');
  }
}
document.addEventListener('error', (e) => { const t = e.target; if (t && t.tagName === 'IMG' && t.hasAttribute('data-rm')) t.remove(); }, true);

// ------------------------------------------------------------ индикатор проблем
function renderIssues(st) {
  const list = [];
  if (S.cloud && !st.server) list.push(['err', 'Компьютер не на связи с облаком' + (st.pc_seen ? ` (последний раз ${fmtDate(st.pc_seen)})` : '') + '. Показаны последние данные; команды не выполняются.']);
  if (!S.cloud || st.server) {
    if (st.ffmpeg === false) list.push(['err', 'ffmpeg не найден — запись невозможна. Запустите start.bat или укажите путь в настройках.']);
    if (st.ext === 0) list.push(['warn', st.headless ? 'Расширение Chrome не подключено — ссылки ищет только скрытый Chrome (сайты с входом в аккаунт не сработают).' : 'Расширение Chrome не подключено и Chrome не найден — запись по ссылкам на страницы не работает.']);
    for (const i of (st.health?.issues || [])) if (!/расширение/i.test(i)) list.push(['warn', i[0].toUpperCase() + i.slice(1) + '.']);
    if (st.errors) list.push(['warn', `Записей с ошибкой: ${st.errors} — описание в блоке записи (раздел «Завершённые»).`]);
    if (S.local && st.cloud?.enabled && !st.cloud.connected) list.push(['warn', 'Облако: ' + (st.cloud.error || 'подключение…')]);
  }
  const bar = $('#issues');
  if (!list.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const worst = list.some((x) => x[0] === 'err') ? 'err' : 'warn';
  bar.className = 'issues ' + worst;
  const sig = JSON.stringify(list);
  if (bar._sig === sig) return;
  bar._sig = sig;
  bar.innerHTML = `<button class="ihead"><b>${list.length === 1 ? 'Есть проблема' : 'Проблем: ' + list.length}</b><span>${esc(list[0][1])}</span><em>${list.length > 1 ? 'подробнее' : ''}</em></button>
    <ul>${list.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>`;
  $('.ihead', bar).onclick = () => bar.classList.toggle('open');
}

// ------------------------------------------------------------ облако: настройка (только на ПК)
function renderCloudTools(s) {
  const box = $('#cloudTools'); if (!box) return;
  const c = S.data?.status.cloud || {};
  box.innerHTML = `<h3>Удалённый доступ через облако (Timeweb)</h3>
    <div class="srow"><div class="lbl"><div>Состояние</div><small id="cloudState"></small></div></div>
    <div class="srow"><div class="lbl"><div>Включить удалённый доступ</div><small>ПК сам подключается к облаку по защищённому каналу</small></div><label class="switch"><input type="checkbox" data-k="cloud_enabled" ${s.cloud_enabled ? 'checked' : ''}><span></span></label></div>
    <div class="srow"><div class="lbl"><div>Адрес облака</div><small>Ссылка приложения из Timeweb, начинается с https://</small></div><input type="text" data-k="cloud_url" value="${esc(s.cloud_url || '')}" placeholder="https://…"></div>
    <div class="srow"><div class="lbl"><div>Токен ПК</div><small>Тот же, что AGENT_TOKEN в Timeweb. Никому не показывайте.</small></div><input type="text" data-k="cloud_token" id="cTok" value="${esc(s.cloud_token || '')}"><button class="btn sm" id="cGenTok">Создать</button></div>
    <div class="srow"><div class="lbl"><div>Пароль входа и шифрования</div><small>${s.cloud_auth ? 'Задан. ' : '<b style="color:var(--retry)">Не задан.</b> '}Из пароля на ПК и телефоне получается ключ шифрования — облако его не знает. Сам пароль нигде не сохраняется. От 10 символов, лучше 14+.</small></div>
      <input type="password" id="cPw" placeholder="новый пароль" autocomplete="new-password"><button class="btn sm" id="cGenHash">Задать пароль</button></div>
    <div id="cHashRow" hidden>
      <div class="srow"><div class="lbl"><div>AUTH_VERIFIER</div><small>Вставьте в переменную AUTH_VERIFIER в Timeweb и перезапустите приложение. Тот же пароль всегда даёт то же значение.</small></div><input type="text" id="cVer" readonly><button class="btn sm" data-cp="cVer">Копировать</button></div>
    </div>
    <div class="srow"><div class="lbl"><div>Проверка кода облака</div><small id="cInteg">ПК сверяет интерфейс, который отдаёт облако, с эталоном (защита от подмены). Автоматически каждые 10 минут.</small></div><button class="btn sm" id="cCheck">Проверить</button></div>
    <div class="srow"><div class="lbl"><div>Двухфакторный код (необязательно)</div><small>Создайте секрет, отсканируйте QR в Google Authenticator / Яндекс Ключ, секрет вставьте в TOTP_SECRET в Timeweb</small></div><button class="btn sm" id="cGenTotp">Создать</button></div>
    <div class="srow" id="cTotpRow" hidden><div class="qr" style="width:160px;padding:8px"><img id="cTotpQr" alt=""></div><div class="lbl"><div>TOTP_SECRET</div><small id="cTotpSec" style="font-size:14px;color:var(--text);word-break:break-all"></small><div style="margin-top:6px"><button class="btn sm" id="cCopyTotp">Копировать</button></div></div></div>`;
  const tool = (body) => fetch('/api/cloud/tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  $('#cGenTok').onclick = async () => { if ($('#cTok').value && !confirm('Заменить токен? Его нужно будет обновить и в Timeweb.')) return; $('#cTok').value = (await tool({ action: 'token' })).token; toast('Токен создан — нажмите «Сохранить настройки»'); };
  $('#cGenHash').onclick = async () => {
    const pw = $('#cPw').value;
    if (s.cloud_auth && !confirm('Задать пароль? Если он отличается от прежнего — обновите AUTH_VERIFIER в Timeweb.')) return;
    $('#cGenHash').disabled = true; $('#cGenHash').textContent = 'Вычисляю…';
    const r = await tool({ action: 'e2e', password: pw });
    $('#cGenHash').disabled = false; $('#cGenHash').textContent = 'Задать пароль';
    if (r.error) return toast(r.error, 'error');
    $('#cVer').value = r.verifier; $('#cHashRow').hidden = false; $('#cPw').value = '';
    toast('Пароль задан на ПК. Перенесите значения в Timeweb.');
  };
  box.querySelectorAll('[data-cp]').forEach((b) => b.onclick = () => copy($('#' + b.dataset.cp).value));
  $('#cCheck').onclick = async () => { $('#cInteg').textContent = 'Проверяю…'; const r = await tool({ action: 'integrity' }); $('#cInteg').textContent = r.result === 'ok' ? '✓ Код облака совпадает с эталоном' : 'Результат: ' + r.result; };
  $('#cGenTotp').onclick = async () => {
    const r = await tool({ action: 'totp' });
    $('#cTotpRow').hidden = false; $('#cTotpSec').textContent = r.secret;
    $('#cTotpQr').src = '/api/qr.svg?u=' + encodeURIComponent(r.uri);
  };
  $('#cCopyTotp').onclick = () => copy($('#cTotpSec').textContent);
}

// ------------------------------------------------------------ облако + сквозное шифрование
function applyMeta(d) {
  if (!S.meta || !d) return;
  d.status = d.status || {};
  d.status.server = !!S.meta.pc;
  d.status.cloud_mode = true;
  d.status.pc_seen = S.meta.pc_seen;
  d.status.viewers = S.meta.viewers;
}
async function forgetKey() {
  if (window.E2E) {
    await window.E2E.forget();
    navigator.serviceWorker?.controller?.postMessage('reset');
  }
}
let keyWarned = false;
async function keyProblem() {
  if (keyWarned) return;
  keyWarned = true;
  // без автоматического выхода — иначе получается бесконечный круг
  $('#offline').textContent = 'Ключ шифрования не совпадает с ключом на ПК. На ПК: Настройки → облако → «Задать пароль», скопируйте AUTH_VERIFIER в Timeweb, перезапустите приложение и войдите снова.';
  $('#offline').classList.add('show');
  await forgetKey();
}

// ------------------------------------------------------------ потеря входа: без бесконечного круга
function authLost() {
  const now = Date.now();
  const hist = JSON.parse(sessionStorage.getItem('sr-401') || '[]').filter((t) => now - t < 60000);
  hist.push(now);
  sessionStorage.setItem('sr-401', JSON.stringify(hist));
  if (hist.length >= 3) {
    $('#offline').textContent = 'Вход не сохраняется. На iPhone: Настройки → Safari → выключите «Блокировать все cookie», не используйте приватный режим, затем войдите снова.';
    $('#offline').classList.add('show');
    return;
  }
  location.href = '/login';
}
