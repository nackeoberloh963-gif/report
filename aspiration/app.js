/* Мониторинг аспирационных установок — оболочка сайта: вход, расшифровка, живые данные, счётчик, панель администратора */
(function () {
  'use strict';
  const CFG = window.SITE_CONFIG || {};
  const $ = (q) => document.querySelector(q);
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* no storage */ } }, del: (k) => { try { sessionStorage.removeItem(k); } catch (e) { /* no storage */ } } };

  /* ---------------- счётчик посещений ---------------- */
  let geoP = null;
  function geo() {
    if (geoP) return geoP;
    geoP = (async () => {
      try {
        const r = await fetch('https://ipapi.co/json/');
        if (r.ok) { const j = await r.json(); if (j && j.ip) return { ip: j.ip, country: j.country_name || '', country_code: j.country_code || '', city: j.city || '', region: j.region || '', org: j.org || '' }; }
      } catch (e) { /* next provider */ }
      try {
        const r = await fetch('https://ipwho.is/');
        if (r.ok) { const j = await r.json(); if (j && j.ip) return { ip: j.ip, country: j.country || '', country_code: j.country_code || '', city: j.city || '', region: j.region || '', org: (j.connection && (j.connection.org || j.connection.isp)) || '' }; }
      } catch (e) { /* give up */ }
      return { ip: '', country: '', country_code: '', city: '', region: '', org: '' };
    })();
    return geoP;
  }
  async function track(event) {
    if (!CFG.COUNTER_URL) return;
    try {
      const g = await geo();
      const tz = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '';
      await fetch(CFG.COUNTER_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(Object.assign({ action: 'visit', event, ua: navigator.userAgent, lang: navigator.language, tz, screen: screen.width + 'x' + screen.height, page: location.pathname, ref: document.referrer }, g)) });
    } catch (e) { /* счётчик не должен мешать сайту */ }
  }
  if (!ss.get('mon_open')) { ss.set('mon_open', '1'); track('open'); }

  /* ---------------- расшифровка ---------------- */
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  let ENC = null;
  async function loadEnc() { if (!ENC) ENC = await (await fetch('data.enc.json?v=' + Date.now(), { cache: 'no-cache' })).json(); return ENC; }
  async function decrypt(pw) {
    const enc = await loadEnc();
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(enc.salt), iterations: enc.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.ct));
    const stream = new Blob([pt]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  /* ---------------- живые данные из Google-таблицы ---------------- */
  function num(x) { x = String(x == null ? '' : x).trim().replace(',', '.'); if (!x) return ''; const v = Number(x); return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '?' + x; }
  function convertSheet(rows, units) {
    const head = rows[0] || [];
    const dates = [];
    for (let j = 2; j < head.length; j++) {
      const h = String(head[j] || '').trim();
      const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(h);
      if (m) dates.push({ j, iso: '20' + m[3] + '-' + m[2] + '-' + m[1] });
    }
    if (!dates.length) throw new Error('в заголовке таблицы не найдены даты');
    for (let i = 1; i < dates.length; i++) if (dates[i].j - dates[i - 1].j !== 3) throw new Error('у даты ' + dates[i].iso + ' не три столбца');
    const byUnit = new Map();
    rows.slice(1).forEach((r) => { const u = String(r[1] || '').trim(); if (u) byUnit.set(u, r); });
    const missing = units.filter((u) => !byUnit.has(u.unit));
    if (missing.length) throw new Error('в таблице нет установок: ' + missing.slice(0, 3).map((u) => u.unit).join(', '));
    dates.sort((a, b) => (a.iso < b.iso ? -1 : 1));
    const out = [];
    dates.forEach((d, i) => {
      units.forEach((u) => {
        const r = byUnit.get(u.unit);
        const code = num(r[d.j]), ppl = num(r[d.j + 1]), hrs = num(r[d.j + 2]);
        const kind = code ? 'код' : (ppl || hrs ? 'без кода' : '');
        const ph = ppl && hrs && ppl[0] !== '?' && hrs[0] !== '?' ? String(Math.round(Number(ppl) * Number(hrs) * 100) / 100) : '';
        out.push({ obs: String(i + 1), date: d.iso, system: u.system, unit: u.unit, value: code, code, kind, people: ppl, hours: hrs, person_hours: ph });
      });
    });
    out.columns = ['obs', 'date', 'system', 'unit', 'value', 'code', 'kind', 'people', 'hours', 'person_hours'];
    return { rows: out, first: dates[0].iso, last: dates[dates.length - 1].iso };
  }
  async function liveIncidents(sheetId, units) {
    const url = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/gviz/tq?tqx=out:csv&headers=1&cb=' + Date.now();
    const r = await fetch(url);
    if (!r.ok) throw new Error('Google ответил ' + r.status);
    const txt = await r.text();
    if (/^\s*</.test(txt)) throw new Error('таблица закрыта для чтения по ссылке');
    return convertSheet(d3.csvParseRows(txt), units);
  }

  /* ---------------- замена среды дашборда ---------------- */
  const DEFAULTS = { src: 'inc', metric: 'n', scope: 'faults', group: null, start: null, end: null, system: null, unit: null, code: null, mode: 'all', grain: 'day', norm: 'abs' };
  function makeDash(datasets) {
    const calcs = {}, cbs = [];
    let params = Object.assign({}, DEFAULTS), pending = false;
    const run = () => { pending = false; cbs.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); };
    const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(run); } };
    let rt = null; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(schedule, 150); });
    const css = getComputedStyle(document.documentElement);
    return {
      colors: ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'].map((v) => 'var(' + v + ')'),
      data(id) {
        if (datasets[id]) return { status: 'ok', data: datasets[id], columns: datasets[id].columns, refreshing: false, meta: [] };
        const c = calcs[id];
        if (c) {
          if (!c.result) {
            try { c.result = { status: 'ok', data: c.fn.apply(null, c.inputs.map((i) => (datasets[i] || (calcs[i] && this.data(i).data) || []))), meta: [] }; }
            catch (e) { console.error(e); c.result = { status: 'error', data: [], message: String(e) }; }
          }
          return c.result;
        }
        return { status: 'missing', data: [], meta: [] };
      },
      calc(id, o) { calcs[id] = { inputs: o.inputs || [], fn: o.fn }; },
      loader() {},
      onData(fn) { cbs.push(fn); try { fn(); } catch (e) { console.error(e); } },
      params() { return Object.assign({}, params); },
      setParams(o) { Object.assign(params, o); schedule(); },
      resetParams() { params = Object.assign({}, DEFAULTS); schedule(); },
      setLink(name) { try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ } },
      refresh() {},
      _css: css,
    };
  }
  function mountPage(html) {
    const root = $('#dash-root');
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const scripts = [...tpl.content.querySelectorAll('script')];
    scripts.forEach((s) => s.remove());
    root.replaceChildren(tpl.content);
    scripts.forEach((s) => {
      if (s.src || s.getAttribute('src')) return; // hmi.js приходит из пакета
      const n = document.createElement('script');
      n.textContent = s.textContent;
      document.body.appendChild(n);
    });
  }

  /* ---------------- вход ---------------- */
  const fmtD = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
  async function start(bundle) {
    $('#gate').hidden = true; $('#app').hidden = false; $('#admin').hidden = true;
    window.AM_HMI = bundle.hmi;
    const codes = d3.csvParse(bundle.codes);
    const obs = d3.csvParse(bundle.observations);
    let inc = d3.csvParse(bundle.incidents);
    const badge = $('#src-badge');
    const units = []; const seen = new Set();
    inc.forEach((r) => { if (!seen.has(r.unit)) { seen.add(r.unit); units.push({ unit: r.unit, system: r.system }); } });
    try {
      const live = await liveIncidents(bundle.sheet_id, units);
      inc = live.rows;
      badge.textContent = 'Живые данные таблицы · по ' + fmtD(live.last);
      badge.className = 'badge-src live';
      badge.title = 'Журнал аварий прочитан из Google-таблицы при открытии страницы';
    } catch (e) {
      badge.textContent = 'Снимок от ' + fmtD(bundle.snapshot_date) + ' · таблица не прочиталась';
      badge.className = 'badge-src snap';
      badge.title = 'Причина: ' + (e && e.message ? e.message : e);
      console.warn('live sheet failed', e);
    }
    window.dash = makeDash({ incidents: inc, observations: obs, codes });
    mountPage(bundle.page);
  }
  async function tryLogin(pw, silent) {
    const btn = $('#go'), err = $('#gate-err');
    btn.disabled = true; err.textContent = silent ? '' : 'Проверка…';
    try {
      const bundle = await decrypt(pw);
      ss.set('mon_pw', pw);
      if (!silent) track('login');
      err.textContent = '';
      await start(bundle);
    } catch (e) {
      ss.del('mon_pw');
      if (!silent) { err.textContent = e && e.name === 'OperationError' ? 'Неверный пароль' : 'Не удалось открыть данные: ' + (e.message || e); track('bad_password'); }
      else err.textContent = '';
    } finally { btn.disabled = false; }
  }
  $('#go').addEventListener('click', () => { const v = $('#pw').value.trim(); if (v) tryLogin(v, false); });
  $('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });
  $('#logout').addEventListener('click', () => { ss.del('mon_pw'); location.hash = ''; location.reload(); });
  const saved = ss.get('mon_pw');
  if (saved) tryLogin(saved, true);

  /* ---------------- администратор ---------------- */
  let back = 'gate';
  function openAdmin(from) { back = from; $('#gate').hidden = true; $('#app').hidden = true; $('#admin').hidden = false; window.scrollTo(0, 0); setTimeout(() => $('#apw').focus(), 50); }
  $('#to-admin-gate').addEventListener('click', () => openAdmin('gate'));
  $('#to-admin').addEventListener('click', () => openAdmin('app'));
  $('#admin-back').addEventListener('click', () => { $('#admin').hidden = true; $('#' + back).hidden = false; });
  $('#ago').addEventListener('click', loadStats);
  $('#apw').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadStats(); });
  let ROWS = [], PERIOD = '30';
  async function loadStats() {
    const err = $('#a-err'), pw = $('#apw').value.trim();
    if (!CFG.COUNTER_URL) { err.textContent = 'Счётчик ещё не подключён: в файле config.js не указан адрес Google Apps Script.'; return; }
    if (!pw) return;
    err.textContent = 'Загрузка…';
    try {
      const r = await fetch(CFG.COUNTER_URL, { method: 'POST', body: JSON.stringify({ action: 'stats', key: pw }) });
      const j = await r.json();
      if (!j.ok) { err.textContent = j.error === 'auth' ? 'Неверный пароль администратора' : 'Ошибка счётчика: ' + (j.error || '?'); return; }
      err.textContent = ''; ROWS = j.rows || []; $('#a-login').hidden = true; renderStats();
    } catch (e) { err.textContent = 'Счётчик не ответил: ' + (e.message || e); }
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fInt = (n) => Number(n).toLocaleString('ru-RU');
  const dt = (t) => { const d = new Date(t); return isNaN(d) ? String(t) : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const flag = (cc) => (cc && cc.length === 2 ? cc.toUpperCase() : '—');
  function renderStats() {
    const body = $('#a-body'); body.hidden = false;
    const now = Date.now();
    const rows = ROWS.map((r) => ({ t: new Date(r[0]).getTime(), ts: r[0], event: r[1], ip: r[2], country: r[3], cc: r[4], city: r[5], region: r[6], org: r[7], ua: r[8], tz: r[10] }))
      .filter((r) => PERIOD === 'all' || now - r.t <= +PERIOD * 864e5).sort((a, b) => b.t - a.t);
    const opens = rows.filter((r) => r.event === 'open'), logins = rows.filter((r) => r.event === 'login'), bad = rows.filter((r) => r.event === 'bad_password');
    const ips = new Set(rows.map((r) => r.ip).filter(Boolean)), countries = new Set(rows.map((r) => r.country).filter(Boolean));
    const group = (key) => { const m = new Map(); rows.forEach((r) => { const k = key(r) || '—'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return [...m]; };
    const byCountry = group((r) => r.country).map(([k, rs]) => ({ k, cc: rs[0].cc, open: rs.filter((r) => r.event === 'open').length, login: rs.filter((r) => r.event === 'login').length, bad: rs.filter((r) => r.event === 'bad_password').length, ips: new Set(rs.map((r) => r.ip)).size })).sort((a, b) => b.open - a.open || b.login - a.login);
    const byIp = group((r) => r.ip).map(([k, rs]) => ({ k, country: rs[0].country, cc: rs[0].cc, city: rs[0].city, org: rs[0].org, open: rs.filter((r) => r.event === 'open').length, login: rs.filter((r) => r.event === 'login').length, bad: rs.filter((r) => r.event === 'bad_password').length, first: rs[rs.length - 1].ts, last: rs[0].ts })).sort((a, b) => b.open + b.login - a.open - a.login);
    const days = new Map(); opens.forEach((r) => { const d = new Date(r.t).toISOString().slice(0, 10); days.set(d, (days.get(d) || 0) + 1); });
    const dayList = []; const span = PERIOD === 'all' ? Math.max(1, Math.ceil((now - Math.min(now, ...rows.map((r) => r.t))) / 864e5) + 1) : +PERIOD;
    for (let i = span - 1; i >= 0; i--) { const d = new Date(now - i * 864e5).toISOString().slice(0, 10); dayList.push([d, days.get(d) || 0]); }
    const maxDay = Math.max(1, ...dayList.map((d) => d[1]));
    const maxC = Math.max(1, ...byCountry.map((c) => c.open));
    const seg = ['7', '30', '90', 'all'].map((p) => `<button type="button" data-p="${p}" aria-pressed="${p === PERIOD}">${p === 'all' ? 'Всё время' : p + ' дн.'}</button>`).join('');
    body.innerHTML = `
      <div class="a-seg" id="a-period">${seg}</div>
      <div class="a-kpis" style="margin-top:12px">
        <div class="a-kpi"><span>Визитов (открытий сайта)</span><b>${fInt(opens.length)}</b></div>
        <div class="a-kpi"><span>Успешных входов</span><b>${fInt(logins.length)}</b></div>
        <div class="a-kpi"><span>Неверный пароль</span><b>${fInt(bad.length)}</b></div>
        <div class="a-kpi"><span>Уникальных IP</span><b>${fInt(ips.size)}</b></div>
        <div class="a-kpi"><span>Стран</span><b>${fInt(countries.size)}</b></div>
      </div>
      <div class="a-card" style="margin-top:12px"><h3>Визиты по дням</h3><p class="note">Открытия сайта за выбранный период, по UTC. Наведите на столбец — число.</p>
        <div class="a-days">${dayList.map(([d, n]) => `<div style="height:${n ? Math.max(4, n / maxDay * 100) : 1}%;opacity:${n ? 1 : .25}" title="${d.slice(8, 10)}.${d.slice(5, 7)}: ${n}"></div>`).join('')}</div></div>
      <div class="a-grid" style="margin-top:12px">
        <div class="a-card"><h3>По странам</h3><p class="note">Визиты, входы, неудачные попытки и уникальные IP.</p><div class="a-tw"><table class="a-tb"><thead><tr><th>Страна</th><th class="num">Визитов</th><th class="num">Входов</th><th class="num">Неверный пароль</th><th class="num">IP</th></tr></thead><tbody>
          ${byCountry.map((c) => `<tr><td>${esc(flag(c.cc))} ${esc(c.k)}</td><td class="num"><span class="a-bar" style="width:${c.open / maxC * 60}px"></span>${fInt(c.open)}</td><td class="num">${fInt(c.login)}</td><td class="num">${fInt(c.bad)}</td><td class="num">${fInt(c.ips)}</td></tr>`).join('') || '<tr><td colspan="5">Нет данных</td></tr>'}
        </tbody></table></div></div>
        <div class="a-card"><h3>По IP-адресам</h3><p class="note">Страна и провайдер определяются по IP и могут быть неточны (VPN, мобильные сети).</p><div class="a-tw"><table class="a-tb"><thead><tr><th>IP</th><th>Страна, город</th><th>Провайдер</th><th class="num">Визитов</th><th class="num">Входов</th><th class="num">Неверн.</th><th>Последний</th></tr></thead><tbody>
          ${byIp.map((r) => `<tr><td>${esc(r.k)}</td><td>${esc(flag(r.cc))} ${esc(r.country)}${r.city ? ', ' + esc(r.city) : ''}</td><td>${esc(r.org)}</td><td class="num">${fInt(r.open)}</td><td class="num">${fInt(r.login)}</td><td class="num">${fInt(r.bad)}</td><td>${esc(dt(r.last))}</td></tr>`).join('') || '<tr><td colspan="7">Нет данных</td></tr>'}
        </tbody></table></div></div>
      </div>
      <div class="a-card" style="margin-top:12px"><h3>Последние события</h3><p class="note">Последние 100 записей журнала счётчика.</p><div class="a-tw"><table class="a-tb"><thead><tr><th>Время</th><th>Событие</th><th>IP</th><th>Страна, город</th><th>Часовой пояс</th><th>Браузер</th></tr></thead><tbody>
        ${rows.slice(0, 100).map((r) => `<tr><td>${esc(dt(r.ts))}</td><td><span class="ev ${esc(r.event)}">${esc({ open: 'открыл сайт', login: 'вход', bad_password: 'неверный пароль' }[r.event] || r.event)}</span></td><td>${esc(r.ip)}</td><td>${esc(r.country)}${r.city ? ', ' + esc(r.city) : ''}</td><td>${esc(r.tz)}</td><td title="${esc(r.ua)}">${esc(String(r.ua || '').slice(0, 48))}</td></tr>`).join('') || '<tr><td colspan="6">Нет данных</td></tr>'}
      </tbody></table></div></div>`;
    body.querySelector('#a-period').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { PERIOD = b.dataset.p; renderStats(); } });
  }
})();
