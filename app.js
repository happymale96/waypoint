/* L-Tech Waypoint — app.js (UI). Depends on WPStore, Solver, Messages, Providers. */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
  const BUILD_STAMP = 'f3bd180f'; // written by tools/stamp-sw.js (content hash of the app shell)
  const TYPES = ['factory', 'supplier', 'office', 'home', 'other'];
  const DEFAULT_DWELL = { factory: 20, supplier: 5, other: 10, office: 10, home: 0 };

  // ---------- tiny DOM helper ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') e[k] = v;
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    });
    kids.flat(Infinity).forEach((c) => {
      if (c == null || c === false) return;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return e;
  }
  const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const fmt = (ms) => Solver.formatETA(ms);
  const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

  // ---------- state ----------
  const S = {
    tab: 'plan', places: {}, jobs: [], settings: null,
    startSel: 'gps', endSel: 'home', departTime: '',
    plan: null, busy: false, days: {},
  };

  function defaultSettings() {
    return {
      googleKey: '', tomtomKey: '', defaultLang: 'ms',
      templates: Object.assign({}, Messages.DEFAULT_TEMPLATES),
      etaPaddingMin: 15, dwellDefaults: Object.assign({}, DEFAULT_DWELL),
      placesCallsToday: { date: todayStr(), count: 0 }, nav: 'waze', seeded: false, driverName: 'Calvin',
    };
  }
  const saveSettings = () => WPStore.set('settings', 'main', S.settings);
  const savePlace = (p) => { S.places[p.id] = p; return WPStore.set('places', p.id, p); };
  const saveJob = (j) => WPStore.set('jobs', j.id, j);

  async function load() {
    const stored = (await WPStore.get('settings', 'main')) || {};
    const s = Object.assign(defaultSettings(), stored);
    s.dwellDefaults = Object.assign({}, DEFAULT_DWELL, stored.dwellDefaults || {});
    s.templates = Object.assign({}, Messages.DEFAULT_TEMPLATES, stored.templates || {});
    S.settings = s;
    (await WPStore.list('places')).forEach((p) => { S.places[p.id] = p; });
    if (!s.seeded && !Object.keys(S.places).length) {
      await savePlace(newPlace({ id: 'home', name: 'Home (Bloomsvale)', address: 'Bloomsvale', lat: 3.0757673, lng: 101.6609445, type: 'home' }));
      await savePlace(newPlace({ id: 'office', name: 'Office (L-Tech)', address: 'L-Tech Automation', lat: 3.09941, lng: 101.73900, type: 'office' }));
    }
    s.seeded = true;
    await saveSettings();
    S.jobs = (await WPStore.list('jobs')).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!S.places[S.endSel]) S.endSel = Object.keys(S.places)[0] || '';
    await runMigrations();
    await loadDays();
    await restorePlan(); // the Route tab comes back exactly as it was left
  }

  // ---------- closed windows: {days:[1..7] (ISO, Mon=1), from, to} ----------
  const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
  const DAY_CHIPS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function daysLabel(days) { // [] / all seven -> '' ; [1,2,3,4] -> "Mon–Thu" ; [5] -> "Fri"
    const d = Array.from(new Set(days || [])).sort((a, b) => a - b);
    if (d.length === 7 || !d.length) return d.length ? '' : 'never';
    const out = [];
    for (let i = 0; i < d.length;) {
      let j = i;
      while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
      out.push(j === i ? DAY3[d[i] - 1] : (j === i + 1 ? DAY3[d[i] - 1] + ', ' + DAY3[d[j] - 1] : DAY3[d[i] - 1] + '–' + DAY3[d[j] - 1]));
      i = j + 1;
    }
    return out.join(', ');
  }
  function normalizeWindows(p) { // legacy entries (no days) -> every day. Returns true if anything changed.
    let changed = false;
    p.closedWindows = (p.closedWindows || []).map((w) => {
      if (Array.isArray(w.days)) return w;
      changed = true;
      return { days: ALL_DAYS.slice(), from: w.from, to: w.to };
    });
    return changed;
  }

  // One-off seed migrations, recorded in storage (meta/migrations) so each runs once.
  const SEED_JEMARAMAS = 'seed-jemaramas-lunch-2026-11';
  async function runMigrations() {
    for (const p of Object.values(S.places)) if (normalizeWindows(p)) await savePlace(p);
    const rec = (await WPStore.get('meta', 'migrations')) || { done: [] };
    if (rec.done.includes(SEED_JEMARAMAS)) return;
    const p = Object.values(S.places).find((x) => /^Jemaramas Jaya/i.test(x.name || ''));
    if (!p) return; // not saved yet: stays pending until the place exists
    if (!(p.closedWindows || []).length) {
      p.closedWindows = [{ days: [1, 2, 3, 4], from: '12:30', to: '13:30' }, { days: [5], from: '13:00', to: '14:30' }];
      await savePlace(p);
    }
    rec.done.push(SEED_JEMARAMAS);
    await WPStore.set('meta', 'migrations', rec);
  }

  function newPlace(o) {
    const type = o.type || 'other';
    return Object.assign({
      id: uid('p'), name: '', address: '', lat: 0, lng: 0, type,
      dwellMin: S.settings.dwellDefaults[type] != null ? S.settings.dwellDefaults[type] : DEFAULT_DWELL[type],
      closedWindows: [], whatsapp: '', salutation: 'Encik', lang: 'default',
    }, o);
  }

  // ---------- banner / toast ----------
  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }
  function banner(msg, kind, action) {
    const b = document.getElementById('banner');
    if (!msg) { b.hidden = true; b.textContent = ''; return; }
    b.className = 'banner' + (kind ? ' ' + kind : '');
    const text = action ? h('button', { class: 'banner-link', onclick: () => { banner(null); action(); } }, msg) : h('span', null, msg);
    b.replaceChildren(text, kind === 'busy' ? null : h('button', { onclick: () => banner(null) }, 'OK'));
    b.hidden = false;
  }

  // ---------- sheets ----------
  function openSheet(title, onClose) {
    const body = h('div');
    const sheet = h('div', { class: 'sheet', role: 'dialog' }, h('h3', null, title), body);
    const back = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === back) close(); } }, sheet);
    document.body.append(back);
    function close() { back.remove(); if (onClose) onClose(); }
    return { body, close, sheet, back };
  }

  // ---------- Google calls counter ----------
  function bumpPlacesCalls() {
    const c = S.settings.placesCallsToday;
    if (c.date !== todayStr()) { c.date = todayStr(); c.count = 0; }
    c.count++;
    saveSettings();
  }
  function placesCallsToday() {
    const c = S.settings.placesCallsToday;
    return c.date === todayStr() ? c.count : 0;
  }

  // ---------- place picker (single autocomplete box) ----------
  async function savePlaceFromSearch(r) {
    const dup = Object.values(S.places).find((p) => Math.abs(p.lat - r.lat) < 1e-4 && Math.abs(p.lng - r.lng) < 1e-4);
    if (dup) return dup;
    const p = newPlace({ name: r.name, address: r.address, lat: r.lat, lng: r.lng, type: 'other' });
    await savePlace(p);
    return p;
  }

  function openPlacePicker(onPick, title, extras) {
    // Single autocomplete box: saved places filter instantly; Google is searched automatically
    // (800 ms debounce) only when the query is >= 3 chars and nothing saved matches; Enter searches at once.
    let timer = null, token = 0, closed = false, busy = false, sh = null;
    let g = { state: 'idle', results: [], error: '' };
    const vv = window.visualViewport;
    const fit = () => {
      if (!vv || !sh) return; // size the sheet to what the on-screen keyboard leaves visible
      const b = sh.back.style;
      b.inset = 'auto'; b.top = vv.offsetTop + 'px'; b.left = vv.offsetLeft + 'px';
      b.width = vv.width + 'px'; b.height = vv.height + 'px';
    };
    function cleanup() {
      closed = true; token++; clearTimeout(timer);
      if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
    }
    sh = openSheet(title || 'Pick a place', cleanup);
    sh.sheet.classList.add('picker');
    sh.body.className = 'picker-body';
    if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit(); }

    const input = h('input', { type: 'search', placeholder: 'Type a place name…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    const status = h('div', { class: 'muted picker-status', role: 'status' });
    const list = h('div', { class: 'picker-list' });
    const localMatches = (q) => {
      const ql = q.toLowerCase();
      return Object.values(S.places).filter((p) => !ql || (p.name + ' ' + p.address).toLowerCase().includes(ql)).sort(byName);
    };
    const choose = (p) => { sh.close(); onPick(p); };
    const row = (name, sub, fn) => h('button', { class: 'pick-row', onclick: fn },
      h('span', { class: 'title' }, name), h('span', { class: 'muted' }, sub || ''));

    function paint() {
      const q0 = input.value.trim();
      // optional fixed rows (e.g. "Use my location" for the start chip) shown while the box is empty
      const kids = (extras && !q0 ? extras.map((x) => row(x.label, '', () => { sh.close(); x.fn(); })) : [])
        .concat(localMatches(q0).map((p) => row(p.name, p.type + (p.address ? ' · ' + p.address : ''), () => choose(p))));
      if (g.state === 'done' && g.results.length) {
        kids.push(h('div', { class: 'divider' }, 'Google'));
        g.results.forEach((r) => kids.push(row(r.name, r.address, async () => {
          if (busy) return;
          busy = true;
          try { choose(await savePlaceFromSearch(r)); } finally { busy = false; }
        })));
      }
      list.replaceChildren(...kids);
      status.className = 'muted picker-status' + (g.state === 'error' ? ' error' : '');
      status.textContent = g.state === 'searching' ? 'Searching Google…' : g.state === 'error' ? g.error : (g.state === 'done' && !g.results.length) ? 'No results' : '';
    }

    function googleSearch(q) {
      clearTimeout(timer);
      const mine = ++token;
      if (!S.settings.googleKey) { g = { state: 'error', results: [], error: 'Google Places key missing — add it in Settings.' }; paint(); return; }
      g = { state: 'searching', results: [], error: '' };
      paint();
      const current = () => !closed && mine === token && input.value.trim() === q; // ignore stale responses
      Providers.searchGoogle(q, S.settings.googleKey, bumpPlacesCalls).then((res) => {
        if (!current()) return;
        g = { state: 'done', results: res, error: '' }; paint();
      }).catch((e) => {
        if (!current()) return;
        g = { state: 'error', results: [], error: e.message }; paint();
      });
    }

    input.addEventListener('input', () => {
      clearTimeout(timer); token++;
      g = { state: 'idle', results: [], error: '' };
      paint();
      const q = input.value.trim();
      if (q.length >= 3 && !localMatches(q).length) timer = setTimeout(() => googleSearch(q), 800);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = input.value.trim();
      if (q) googleSearch(q);
    });

    sh.body.append(input, status, list, h('button', { style: 'margin-top:8px', onclick: sh.close }, 'Cancel'));
    paint();
    setTimeout(() => input.focus(), 50);
  }

  // ---------- job helpers ----------
  const pName = (id) => (S.places[id] ? S.places[id].name : '(deleted place)');
  const openStops = new Set(); // place ids of expanded Route cards (in memory only, not persisted)
  // DISPLAY-only: drop a trailing company suffix (Sdn Bhd / Sdn. Bhd. / S/B / Bhd, any case, dots optional). Stored names are untouched.
  const SUFFIX_RE = /[\s,]+(?:sdn\.?\s*bhd\.?|s\/b\.?|bhd\.?)\s*$/i;
  const dName = (n) => { const s = String(n == null ? '' : n); const t = s.replace(SUFFIX_RE, '').trim(); return t || s; };
  function jobTitle(j) {
    if (j.errandPlaceId) return h('span', null, 'Errand @ ', pName(j.errandPlaceId), ' (', j.dwellMin != null ? j.dwellMin : S.places[j.errandPlaceId] ? S.places[j.errandPlaceId].dwellMin : 10, ' min)');
    const pk = (j.pickups || []).map((p) => (p.done ? '✓ ' : '') + pName(p.placeId) + (p.item ? ' (' + p.item + ')' : ''));
    const left = pk.length ? pk.join(' + ') : 'In hand' + (j.inHandItem ? ' (' + j.inHandItem + ')' : '');
    return h('span', null, left, ' → ', j.deliveryPlaceId ? pName(j.deliveryPlaceId) : 'collect only');
  }
  const pendingJobs = () => S.jobs.filter((j) => !j.status || j.status === 'pending');
  const urgentSorted = () => pendingJobs().filter((j) => j.urgent).sort((a, b) => (a.urgentRank || 0) - (b.urgentRank || 0));

  // Toggle urgent from the card: on = next rank (max + 1); off = clear and renumber the rest 1..n. Persisted.
  async function setUrgent(j, on) {
    if (on) {
      const max = Math.max(0, ...S.jobs.filter((x) => x !== j && x.urgent && x.status !== 'done').map((x) => x.urgentRank || 0));
      j.urgent = true; j.urgentRank = max + 1;
      await saveJob(j);
    } else {
      j.urgent = false; j.urgentRank = 0;
      const rest = S.jobs.filter((x) => x.urgent && x.status !== 'done').sort((a, b) => (a.urgentRank || 0) - (b.urgentRank || 0));
      rest.forEach((x, i) => { x.urgentRank = i + 1; });
      await Promise.all([j].concat(rest).map(saveJob));
    }
    render();
  }

  async function moveUrgent(j, dir) {
    const list = urgentSorted();
    list.forEach((x, i) => { x.urgentRank = i + 1; });
    const i = list.indexOf(j), k = i + dir;
    if (k < 0 || k >= list.length) return;
    const t = list[i].urgentRank; list[i].urgentRank = list[k].urgentRank; list[k].urgentRank = t;
    await Promise.all(list.map(saveJob));
    render();
  }

  // ---------- PLAN tab ----------
  function openDepartSheet() {
    const sh = openSheet('Depart at');
    const t = h('input', { type: 'time', value: S.departTime });
    sh.body.append(h('label', { class: 'field' }, 'Time today (empty = now)'), t,
      h('div', { class: 'sticky-actions' },
        h('button', { onclick: () => { S.departTime = ''; sh.close(); render(); } }, 'Now'),
        h('button', { class: 'primary', onclick: () => { S.departTime = t.value; sh.close(); render(); } }, 'Set')));
  }

  function renderPlan(v) {
    const startLabel = S.startSel === 'gps' ? '📍 My location' : '📍 ' + (S.places[S.startSel] ? S.places[S.startSel].name : 'Pick start');
    const endLabel = '→ ' + (S.places[S.endSel] ? S.places[S.endSel].name : 'Pick end');
    const departLabel = S.departTime || 'Now';
    const chip = (label, cls, fn) => h('button', { class: 'chip-btn ' + cls, title: label, onclick: fn }, h('span', null, label));

    v.append(
      h('div', { class: 'chips-row', id: 'headerChips' },
        chip(startLabel, 'start', () => openPlacePicker((p) => { S.startSel = p.id; render(); }, 'Start from',
          [{ label: '📍 Use my location', fn: () => { S.startSel = 'gps'; render(); } }])),
        chip(endLabel, 'end', () => openPlacePicker((p) => { S.endSel = p.id; render(); }, 'Drive to')),
        chip(departLabel, 'depart', () => openDepartSheet())),
      h('button', { class: 'primary big', id: 'planBtn', disabled: S.busy, onclick: () => doPlan({}) }, S.busy ? 'PLANNING…' : 'PLAN')
    );
    const openDay = dayFor(Date.now(), false);
    if (openDay && !openDay.closed && openDay.events.length) v.append(h('button', { class: 'end-day', id: 'endDayBtn', onclick: () => openSummary(openDay.date) }, 'End day'));

    const pending = pendingJobs().sort((a, b) => (b.urgent - a.urgent) || ((a.urgentRank || 0) - (b.urgentRank || 0)) || String(a.createdAt).localeCompare(String(b.createdAt)));
    const parked = S.jobs.filter((j) => j.status === 'parked');
    const done = S.jobs.filter((j) => j.status === 'done');
    const urgentList = urgentSorted();

    v.append(h('div', { class: 'row spread' }, h('h2', null, 'Jobs (' + pending.length + ')'), h('button', { class: 'primary', onclick: () => openJobSheet() }, '+ Add job')));
    if (!pending.length) v.append(h('div', { class: 'empty card' }, 'No pending jobs. Tap “Add job”.'));
    pending.forEach((j) => v.append(jobCard(j, urgentList)));
    if (parked.length) v.append(h('details', null, h('summary', null, 'Parked (' + parked.length + ')'), parked.map((j) => jobCard(j, urgentList))));
    if (done.length) {
      v.append(h('details', null, h('summary', null, 'Done (' + done.length + ')'),
        done.map((j) => h('div', { class: 'card muted' }, jobTitle(j), h('div', null, 'Done ' + (j.doneAt ? new Date(j.doneAt).toLocaleString() : '')))),
        h('button', { class: 'danger', onclick: async () => { if (!confirm('Delete all done jobs?')) return; for (const j of done) await WPStore.remove('jobs', j.id); S.jobs = S.jobs.filter((j) => j.status !== 'done'); render(); } }, 'Clear done')));
    }
  }

  function svgIcon(d) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '20'); s.setAttribute('height', '20');
    s.setAttribute('fill', 'currentColor'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d); s.append(p);
    return s;
  }
  const ICON_PARK = 'M6 5h4v14H6zM14 5h4v14h-4z';
  const ICON_UNPARK = 'M7 4l13 8-13 8z';
  const ICON_TRASH = 'M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9z';

  // Two-column card: COLLECT (amber) -> DELIVER (teal); errands get one full-width ERRAND box.
  function jobCard(j, urgentList) {
    const parked = j.status === 'parked';
    const win = (j.arriveAfter || j.arriveBefore)
      ? h('span', { class: 'chip win' }, [j.arriveAfter && 'after ' + j.arriveAfter, j.arriveBefore && 'before ' + j.arriveBefore].filter(Boolean).join(' · ')) : null;
    let grid;
    if (j.errandPlaceId) {
      const dw = j.dwellMin != null ? j.dwellMin : (S.places[j.errandPlaceId] || {}).dwellMin;
      grid = h('div', { class: 'job-grid' }, h('div', { class: 'box errand' },
        h('div', { class: 'eyebrow' }, 'ERRAND'),
        h('div', { class: 'name' }, dName(pName(j.errandPlaceId))),
        dw != null ? h('div', { class: 'muted sub' }, dw + ' min there') : null,
        win));
    } else {
      const pk = j.pickups || [];
      // no pickups = already in hand: green IN HAND box (not the amber COLLECT box)
      const left = pk.length
        ? h('div', { class: 'box collect' },
          h('div', { class: 'eyebrow' }, 'COLLECT'),
          pk.map((p) => h('div', { class: 'pick' + (p.done ? ' done' : '') },
            h('div', { class: 'name' }, (p.done ? '✓ ' : '') + dName(pName(p.placeId))),
            p.item ? h('div', { class: 'muted sub' }, p.item) : null)))
        : h('div', { class: 'box inhand' },
          h('div', { class: 'eyebrow' }, 'IN HAND'),
          j.inHandItem ? h('div', { class: 'muted sub' }, j.inHandItem) : null);
      grid = h('div', { class: 'job-grid' },
        left,
        h('div', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        h('div', { class: 'box deliver' },
          h('div', { class: 'eyebrow' }, 'DELIVER'),
          j.deliveryPlaceId ? h('div', { class: 'name' }, dName(pName(j.deliveryPlaceId))) : h('div', { class: 'muted' }, 'Collect only'),
          win));
    }
    const idx = urgentList.indexOf(j);
    // tapping the badge clears urgent; the arrows (stopPropagation) change the rank instead
    const head = j.urgent ? h('div', { class: 'job-head' }, h('div', { class: 'urgent-badge', onclick: () => setUrgent(j, false) },
      parked ? null : h('button', { 'aria-label': 'Raise urgent rank', onclick: (e) => { e.stopPropagation(); moveUrgent(j, -1); } }, '▲'),
      h('button', { class: 'urgent-label', 'aria-label': 'Urgent ' + (idx >= 0 ? idx + 1 : '') + ', tap to clear', title: 'Tap to clear urgent' }, 'URGENT ' + (idx >= 0 ? idx + 1 : '–')),
      parked ? null : h('button', { 'aria-label': 'Lower urgent rank', onclick: (e) => { e.stopPropagation(); moveUrgent(j, 1); } }, '▼'))) : null;

    const foot = h('div', { class: 'job-foot' });
    function drawFoot(confirming) {
      const park = h('button', { class: 'icon-btn', 'aria-label': parked ? 'Unpark job' : 'Park job', title: parked ? 'Unpark' : 'Park',
        onclick: async () => { j.status = parked ? 'pending' : 'parked'; await saveJob(j); render(); } }, svgIcon(parked ? ICON_UNPARK : ICON_PARK));
      const del = h('button', { class: 'icon-btn danger', 'aria-label': 'Delete job', title: 'Delete', onclick: () => drawFoot(true) }, svgIcon(ICON_TRASH));
      const actions = confirming
        ? h('div', { class: 'job-actions' }, h('span', { class: 'sub' }, 'Delete this job?'),
          h('button', { class: 'small', onclick: () => drawFoot(false) }, 'Cancel'),
          h('button', { class: 'small danger', onclick: async () => { await WPStore.remove('jobs', j.id); S.jobs = S.jobs.filter((x) => x !== j); render(); } }, 'Delete'))
        : h('div', { class: 'job-actions' },
          j.errandPlaceId ? null : h('button', { class: 'small urgent-toggle', 'aria-pressed': j.urgent ? 'true' : 'false', title: j.urgent ? 'Clear urgent' : 'Mark urgent', onclick: () => setUrgent(j, !j.urgent) }, 'Urgent'),
          park, del);
      foot.replaceChildren(...[j.notes ? h('div', { class: 'job-notes' }, j.notes) : null,
        j.carriedFrom ? h('div', { class: 'job-notes carried' }, 'Carried from ' + DayLog.fmtDate(j.carriedFrom) + (j.carryReason ? ' · ' + j.carryReason : '')) : null, actions].filter(Boolean));
    }
    drawFoot(false);
    return h('div', { class: 'card job' + (parked ? ' parked' : '') + (j.urgent ? ' urgent' : '') }, head, grid, foot);
  }

  // ---------- Add job sheet ----------
  function openJobSheet() {
    let mode = 'delivery';
    const st = { pickups: [{ placeId: null, item: '' }], deliveryPlaceId: null, errandPlaceId: null, dwellMin: '', notes: '', urgent: false, after: '', before: '', inHandItem: '' };
    const sh = openSheet('Add job');
    function placeBtn(id, placeholder, onPick) {
      return h('button', { style: 'width:100%;text-align:left', onclick: () => openPlacePicker((p) => { onPick(p); draw(); }) }, id ? pName(id) : placeholder);
    }
    function draw() {
      const body = sh.body;
      body.replaceChildren();
      body.append(h('div', { class: 'seg' },
        h('button', { class: mode === 'delivery' ? 'on' : '', onclick: () => { mode = 'delivery'; draw(); } }, 'Delivery'),
        h('button', { class: mode === 'errand' ? 'on' : '', onclick: () => { mode = 'errand'; draw(); } }, 'Errand')));
      if (mode === 'delivery') {
        body.append(h('label', { class: 'field' }, 'Pickups (none = item already in hand)'));
        st.pickups.forEach((p, i) => {
          body.append(h('div', { class: 'card' },
            placeBtn(p.placeId, 'Pick pickup place', (pl) => { p.placeId = pl.id; }),
            h('input', { placeholder: 'Item (e.g. 2 pcs sensor)', value: p.item, style: 'margin-top:8px', oninput: (e) => { p.item = e.target.value; } }),
            st.pickups.length > 0 ? h('button', { class: 'small danger', style: 'margin-top:8px', onclick: () => { st.pickups.splice(i, 1); draw(); } }, 'Remove pickup') : null));
        });
        body.append(h('button', { onclick: () => { st.pickups.push({ placeId: null, item: '' }); draw(); } }, '+ Add pickup'),
          h('label', { class: 'field' }, 'Deliver to'),
          h('div', { class: 'row' }, h('div', { class: 'grow' }, placeBtn(st.deliveryPlaceId, 'Pick delivery place', (pl) => { st.deliveryPlaceId = pl.id; })),
            st.deliveryPlaceId ? h('button', { onclick: () => { st.deliveryPlaceId = null; draw(); } }, '✕') : null));
        // no pickup place chosen = the item is already in hand: optional item name for the delivery itself
        if (!st.pickups.some((p) => p.placeId)) {
          body.append(h('label', { class: 'field' }, 'Item (optional — already in hand)'),
            h('input', { placeholder: 'e.g. Test gasket', value: st.inHandItem, oninput: (e) => { st.inHandItem = e.target.value; } }));
        }
      } else {
        body.append(h('label', { class: 'field' }, 'Errand place (bank, meeting…)'),
          placeBtn(st.errandPlaceId, 'Pick errand place', (pl) => { st.errandPlaceId = pl.id; if (st.dwellMin === '') st.dwellMin = String(pl.dwellMin != null ? pl.dwellMin : 10); }),
          h('label', { class: 'field' }, 'Time needed there (minutes)'),
          h('input', { type: 'number', inputmode: 'numeric', min: '0', value: st.dwellMin, oninput: (e) => { st.dwellMin = e.target.value; } }));
      }
      body.append(...[
        h('label', { class: 'field' }, 'Notes'),
        h('input', { value: st.notes, placeholder: 'Optional', oninput: (e) => { st.notes = e.target.value; } }),
        mode === 'delivery' ? h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: st.urgent, onchange: (e) => { st.urgent = e.target.checked; } }), 'Urgent') : null,
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Arrive after'), h('input', { type: 'time', value: st.after, oninput: (e) => { st.after = e.target.value; } })),
          h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Arrive before'), h('input', { type: 'time', value: st.before, oninput: (e) => { st.before = e.target.value; } }))),
        h('div', { class: 'sticky-actions' }, h('button', { onclick: sh.close }, 'Cancel'), h('button', { class: 'primary', onclick: save }, 'Save job'))].filter(Boolean));
    }
    async function save() {
      const j = {
        id: uid('j'), pickups: [], deliveryPlaceId: null, notes: st.notes.trim(), urgent: false, urgentRank: 0,
        arriveBefore: st.before || null, arriveAfter: st.after || null, status: 'pending', doneAt: null, createdAt: new Date().toISOString(),
      };
      if (mode === 'errand') {
        if (!st.errandPlaceId) { toast('Pick the errand place'); return; }
        j.errandPlaceId = st.errandPlaceId;
        j.dwellMin = st.dwellMin === '' ? (S.places[st.errandPlaceId].dwellMin || 10) : Number(st.dwellMin);
      } else {
        if (st.pickups.some((p) => !p.placeId && p.item.trim())) { toast('A pickup has an item but no place'); return; }
        j.pickups = st.pickups.filter((p) => p.placeId).map((p) => ({ placeId: p.placeId, item: p.item.trim(), done: false }));
        j.deliveryPlaceId = st.deliveryPlaceId;
        if (!j.pickups.length && !j.deliveryPlaceId) { toast('Add a pickup or a delivery place'); return; }
        if (!j.pickups.length) j.inHandItem = st.inHandItem.trim();
        if (st.urgent) { j.urgent = true; j.urgentRank = urgentSorted().length + 1; }
      }
      S.jobs.push(j);
      await saveJob(j);
      sh.close();
      render();
    }
    draw();
  }

  // ---------- planning ----------
  function getGps() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Location is not available on this device. Pick a start place instead.'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        (e) => reject(new Error('Could not get your location (' + e.message + '). Pick a start place instead.')),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
    });
  }

  async function doPlan(opts) {
    if (S.busy) return;
    const replan = !!opts.replan;
    const s = S.settings;
    banner(null);
    await reopenIfClosed();
    if (!s.tomtomKey) { banner('TomTom API key missing — add it in Settings. (Travel times come from TomTom Matrix Routing v2.)', 'error'); return; }
    const end = S.places[S.endSel];
    if (!end) { banner('Pick an end place.', 'error'); return; }
    const jobs = JSON.parse(JSON.stringify(S.jobs));
    const stopIds = Solver.buildStops(jobs, S.places).stopIds;
    if (!stopIds.length) { toast('No pending jobs to plan.'); return; }
    if (stopIds.length > Solver.MAX_STOPS) { banner('Too many stops: ' + stopIds.length + ' distinct places (max ' + Solver.MAX_STOPS + '). Park some jobs first.', 'error'); return; }
    S.busy = true;
    if (S.tab === 'plan') render();
    try {
      let start;
      if (replan || S.startSel === 'gps') {
        banner('Getting your location…', 'busy');
        start = await getGps();
      } else {
        const sp = S.places[S.startSel];
        if (!sp) throw new Error('Pick a start place.');
        start = { lat: sp.lat, lng: sp.lng };
      }
      let departAt = new Date();
      if (!replan && S.departTime) {
        const [hh, mm] = S.departTime.split(':').map(Number);
        const d = new Date(); d.setHours(hh, mm, 0, 0);
        if (d > departAt) departAt = d;
      }
      const places = JSON.parse(JSON.stringify(S.places));
      const input = { start, end, jobs, places, departAtISO: departAt.toISOString(), noDetour: false };
      const points = Solver.pointsFor(input);
      banner('Asking TomTom for travel times (live traffic, 3 time slices)…', 'busy');
      const got = await Providers.getMatrices(points, input.departAtISO, s.tomtomKey, { force: replan });
      const prevNoDetour = S.plan ? S.plan.noDetour : false;
      const prevPlan = replan ? curPlan() : null; // a replan keeps the stops already done on top
      const fetchedAt = new Date().toISOString();
      got.matrices.forEach((x) => { if (!x.fetchedAt) x.fetchedAt = fetchedAt; });
      S.plan = { ctx: { start, end, jobs, places, departAtISO: input.departAtISO, matrices: got.matrices }, noDetour: replan ? prevNoDetour : false, idx: 0, prompt: null, shiftMs: 0, alt: null, provider: { calls: got.calls, fromCache: got.fromCache, partial: !!got.partial } };
      solveFresh();
      if (prevPlan) S.plan.result.plans = S.plan.result.plans.map((p) => compose(prevPlan, p));
      banner('Travel times: TomTom live traffic — ' + (got.fromCache ? 'from session cache (0 calls)' : got.calls + ' calls') + (got.partial ? ' · some legs missing, treated as very long' : '') + '.', 'info');
      logPlan(replan, { start, departAt, places, points, matrices: got.matrices, jobs: Solver.buildStops(jobs, places).jobs });
      S.tab = 'route';
      await savePlan(); // after the tab switch, so a restore reopens the Route tab
    } catch (e) {
      banner(e.message || String(e), 'error');
    } finally {
      S.busy = false;
      render();
    }
  }

  // ---------- plan state: persistence, live re-timing, re-solving from the cached matrices ----------
  // S.plan = { ctx:{start,end,jobs,places,departAtISO,matrices}, noDetour, idx, prompt, alt, provider,
  //            result:{plans:[plan,...]} }.  plan = solver plan + per-stop status ('done'|'skipped') / doneAt + plan.model.
  // Invariant: plan.model.matrices === ctx.matrices (the matrices the current problem was solved with).
  const curPlan = () => (S.plan && S.plan.result && !S.plan.result.error && S.plan.result.plans[S.plan.idx]) || null;
  const iso = (ms) => new Date(ms).toISOString();
  const STALE_MS = 30 * 60000; // travel times older than this are re-fetched at a DONE

  function lastDoneIdx(plan) { // stop most recently marked done; -1 = none yet (= the start point)
    let best = -1, bt = -1;
    plan.stops.forEach((s, i) => { if (s.status === 'done') { const t = Date.parse(s.doneAt) || 0; if (t >= bt) { bt = t; best = i; } } });
    return best;
  }

  // done/skipped stops stay at the top (old order); the freshly solved stops follow
  function compose(oldPlan, plan) {
    const hist = oldPlan ? oldPlan.stops.filter((s) => s.status) : [];
    if (!hist.length) return plan;
    const t0 = oldPlan.model.t0ms;
    return Object.assign({}, plan, {
      order: hist.map((s) => s.placeId).concat(plan.order),
      stops: hist.map((s) => Object.assign({}, s)).concat(plan.stops),
      model: Object.assign({}, plan.model, { t0ms: t0 }),
      totalSec: Math.round((plan.endArrival - t0) / 1000),
    });
  }

  function solveFresh() { // PLAN: solve the whole problem held in ctx
    const P = S.plan, c = P.ctx;
    P.result = Solver.solve({ start: c.start, end: c.end, jobs: c.jobs, places: c.places, matrices: c.matrices, departAtISO: c.departAtISO, noDetour: P.noDetour });
    P.idx = 0; P.alt = null;
  }

  // Re-solve what is left (not done / skipped) from where we are, using the plan's OWN matrices — no API call.
  function resolveRemaining(opts) {
    opts = opts || {};
    const P = S.plan, plan = curPlan(), m = plan.model;
    const from = lastDoneIdx(plan);
    const live = new Set(plan.stops.filter((s) => !s.status).map((s) => s.placeId));
    const inModel = new Set(m.stopIds);
    let aIdx = 0, anchor = { lat: m.start.lat, lng: m.start.lng }; // where we are: last done stop, else the start
    if (from >= 0) {
      const pid = plan.stops[from].placeId, ix = m.stopIds.indexOf(pid), pl = S.places[pid] || P.ctx.places[pid];
      if (ix >= 0 && pl) { aIdx = ix + 1; anchor = { lat: pl.lat, lng: pl.lng }; }
    }
    const placesOf = (j) => (j.errandPlaceId ? [j.errandPlaceId]
      : (j.pickups || []).filter((p) => !p.done).map((p) => p.placeId).concat(j.deliveryPlaceId ? [j.deliveryPlaceId] : []));
    const jobs = S.jobs.filter((j) => !j.status || j.status === 'pending').filter((j) => {
      const ps = placesOf(j); // only jobs the cached matrices cover, with something still to do at a live stop
      return ps.length && ps.every((p) => inModel.has(p)) && ps.some((p) => live.has(p));
    });
    const stopIds = Solver.buildStops(jobs, S.places).stopIds;
    const idxList = [aIdx].concat(stopIds.map((pid) => m.stopIds.indexOf(pid) + 1), [m.stopIds.length + 1]);
    const matrices = Solver.reindexMatrices(m.matrices, idxList);
    const now = Date.now();
    const at = from >= 0 ? now : Math.max(now, Date.parse(P.ctx.departAtISO));
    const respect = opts.respect != null ? opts.respect : !!m.respectClosed;
    const res = Solver.solve({ start: anchor, end: { lat: m.end.lat, lng: m.end.lng }, jobs, places: S.places, matrices, departAtISO: iso(at), noDetour: P.noDetour, respectClosedWindows: respect });
    return { res, jobs: JSON.parse(JSON.stringify(jobs)), anchor, matrices, departAtISO: iso(at), from };
  }

  function adoptResult(r) { // make a resolveRemaining() result the current plan (done stops stay on top)
    const P = S.plan, old = curPlan();
    P.result = { plans: r.res.plans.map((p) => compose(old, p)), error: null, stats: r.res.stats, stopIds: r.res.stopIds };
    P.idx = 0; P.alt = null; P.shiftMs = 0;
    P.ctx = Object.assign({}, P.ctx, { start: r.anchor, jobs: r.jobs, matrices: r.matrices, departAtISO: r.departAtISO });
  }

  async function reSolveFromCache() { // No-detour toggle
    const r = resolveRemaining({});
    if (r.res.error) banner(r.res.error, 'error');
    else { adoptResult(r); banner('Re-solved from cached travel times — 0 API calls.', 'info'); }
    await savePlan();
    render();
  }

  // Live re-timing from the last done stop (or the start) at the current time. Order never changes.
  function retimeNow() {
    const P = S.plan, plan = curPlan();
    if (!plan || !plan.stops.some((s) => !s.status)) return false;
    const from = lastDoneIdx(plan), now = Date.now();
    const at = from < 0 ? Math.max(now, Date.parse(P.ctx.departAtISO)) : now; // before the planned departure: keep the planned times
    P.result.plans[P.idx] = Solver.retime(plan, from, iso(at));
    P.alt = null; P.shiftMs = 0;
    return true;
  }

  // travel times older than 30 min are re-fetched (3 slices, like PLAN) before re-timing at a DONE
  async function refreshIfStale(plan) {
    const P = S.plan, m = plan.model;
    const oldest = Math.min.apply(null, m.matrices.map((x) => Date.parse(x.fetchedAt) || 0));
    if (Date.now() - oldest <= STALE_MS) return;
    if (!S.settings.tomtomKey) { banner('Travel times are older than 30 min but the TomTom key is missing — keeping them.', 'error'); return; }
    try {
      banner('Travel times are older than 30 min — refreshing from TomTom (live traffic, 3 time slices)…', 'busy');
      const pt = (pid) => { const pl = S.places[pid] || P.ctx.places[pid]; return { lat: pl.lat, lng: pl.lng }; };
      const points = [m.start].concat(m.stopIds.map(pt), [m.end]);
      const got = await Providers.getMatrices(points, new Date().toISOString(), S.settings.tomtomKey, { force: true });
      const stamp = new Date().toISOString();
      got.matrices.forEach((x) => { x.fetchedAt = stamp; });
      m.matrices = got.matrices; P.ctx.matrices = got.matrices; // keep plan.model.matrices === ctx.matrices
      P.provider = { calls: got.calls, fromCache: false, partial: !!got.partial };
      banner('Travel times: TomTom live traffic — ' + got.calls + ' calls (refreshed)' + (got.partial ? ' · some legs missing, treated as very long' : '') + '.', 'info');
    } catch (e) {
      banner(e.message || String(e), 'error'); // keep going with the older matrices
    }
  }

  // "Avoid lunch": re-solve what is left with closed windows respected (arrival inside a window waits it out)
  function computeAvoidLunch() {
    const P = S.plan, cur = curPlan();
    const r = resolveRemaining({ respect: true });
    const alt = r.res.plans && r.res.plans[0];
    if (r.res.error || !alt) { P.alt = { ok: false, message: 'No feasible alternative: ' + (r.res.error || 'nothing left to re-plan') + '.' }; return; }
    if (alt.violations.length) { P.alt = { ok: false, message: 'No feasible alternative: avoiding the closed windows would break a time window (' + alt.violations[0] + ').' }; return; }
    const at = r.from >= 0 ? Date.now() : Math.max(Date.now(), Date.parse(P.ctx.departAtISO));
    const base = Solver.retime(cur, r.from, iso(at)); // current plan timed from the same place and moment
    P.alt = { ok: true, r, plan: alt, deltaMs: alt.endArrival - base.endArrival, baseEnd: base.endArrival };
  }
  async function useAlt() {
    adoptResult(S.plan.alt.r);
    await savePlan();
    banner('Using the avoid-lunch plan (closed windows respected).', 'info');
    render();
  }

  // ---- persistence: the plan survives closing the app and the service-worker reload ----
  function planSnapshot() {
    const P = S.plan, plan = curPlan();
    if (!P || !plan) return null;
    return {
      v: 1, savedAt: new Date().toISOString(), tab: S.tab, noDetour: P.noDetour, provider: P.provider || null, ctx: P.ctx,
      plan: Object.assign({}, plan, { model: Object.assign({}, plan.model, { matrices: null }) }), // matrices are stored once, in ctx
    };
  }
  async function savePlan() {
    const snap = planSnapshot();
    if (!snap) return WPStore.remove('plan', 'current');
    return WPStore.set('plan', 'current', snap);
  }
  async function restorePlan() {
    let snap = null;
    try { snap = await WPStore.get('plan', 'current'); } catch (e) { snap = null; }
    if (!snap || snap.v !== 1 || !snap.plan || !snap.plan.model || !snap.ctx || !snap.ctx.matrices) return;
    snap.plan.model.matrices = snap.ctx.matrices;
    S.plan = {
      ctx: snap.ctx, noDetour: !!snap.noDetour, idx: 0, prompt: null, shiftMs: 0, alt: null, provider: snap.provider || null,
      result: { plans: [snap.plan], error: null, stats: null, stopIds: snap.plan.model.stopIds },
    };
    if (['plan', 'route', 'places', 'settings'].includes(snap.tab)) S.tab = snap.tab;
  }
  async function clearPlan() {
    S.plan = null;
    await WPStore.remove('plan', 'current');
    banner(null);
    render();
  }

  // ---------- DAY LOG: record events, undo, close (model + maths live in daylog.js) ----------
  const DL = DayLog;
  const saveDay = (d) => WPStore.set('daylogs', d.date, d);
  const bgSaveDay = (d) => { saveDay(d).catch(() => {}); };
  const SIX_H = 6 * 3600e3;
  const lastEventMs = (d) => d.events.reduce((a, e) => Math.max(a, Date.parse(e.t) || 0), 0);

  async function loadDays() {
    S.days = {};
    (await WPStore.list('daylogs')).forEach((d) => { if (d && d.date && Array.isArray(d.events)) S.days[d.date] = d; });
    for (const k of DL.pruneDates(Object.keys(S.days), DL.dateKey(Date.now()))) { delete S.days[k]; await WPStore.remove('daylogs', k); } // keep 120 days
  }
  // The day an event belongs to: an unclosed day with activity in the last 6 h (a run past midnight stays on the
  // date it started), else today's record, else (create) a new one.
  function dayFor(nowMs, create) {
    const recent = Object.values(S.days).filter((d) => !d.closed && lastEventMs(d) > 0 && nowMs - lastEventMs(d) <= SIX_H).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (recent) return recent;
    const key = DL.dateKey(nowMs);
    if (S.days[key]) return S.days[key];
    if (!create) return null;
    const d = DL.newDay({ date: key, driverId: S.settings.driverName || 'Calvin' });
    S.days[key] = d;
    return d;
  }
  async function reopenDay(day) { // undo of "Close day": carried / dropped jobs go back exactly as they were
    const changed = DL.reopenDay(day, S.jobs, new Date().toISOString());
    for (const j of changed) await saveJob(j);
    await saveDay(day);
  }
  async function reopenIfClosed() { // new activity on a closed day reopens it
    try {
      const d = dayFor(Date.now(), false);
      if (d && d.closed) { await reopenDay(d); toast('Day reopened'); }
    } catch (e) { /* the day log must never break an action */ }
  }

  function logPlan(replan, o) {
    try {
      const now = Date.now(), day = dayFor(now, true);
      const plan = curPlan();
      const order = plan ? plan.order : [];
      let pk = { plannedKm: null, plannedDriveMin: null };
      if (!day.planSnapshot && plan) {
        const seq = [o.start].concat(order.map((id) => o.places[id]).filter(Boolean).map((p) => ({ lat: p.lat, lng: p.lng })));
        pk = DL.plannedFromMatrices(o.matrices, o.points, seq, o.departAt.getTime());
      }
      DL.recordPlan(day, { nowIso: new Date(now).toISOString(), replan: !!replan, start: o.start, departAtIso: o.departAt.toISOString(), jobs: o.jobs, places: o.places, stopOrder: order, plannedKm: pk.plannedKm, plannedDriveMin: pk.plannedDriveMin });
      bgSaveDay(day);
    } catch (e) { /* never break planning */ }
  }

  function logDone(stop, nowIso) {
    try {
      const nowMs = Date.parse(nowIso), day = dayFor(nowMs, true);
      const groups = DL.doneGroups(day), lastG = groups[groups.length - 1];
      const coord = (id) => { const p = S.places[id] || (S.plan && S.plan.ctx.places[id]) || day.places[id]; return p ? { lat: p.lat, lng: p.lng } : null; };
      const prev = lastG ? coord(lastG.stopId) : (day.planSnapshot && day.planSnapshot.start);
      const to = coord(stop.placeId), plan = curPlan();
      const evs = DL.recordDone(day, { nowIso, stopId: stop.placeId, actions: stop.actions, places: S.places });
      if (plan && prev && to) { // keep the leg just driven if the plan's own routing matrices cover that exact pair
        const m = plan.model;
        const pts = [m.start].concat(m.stopIds.map(coord), [m.end]);
        if (pts.every(Boolean)) DL.captureLeg(day, prev, to, m.matrices, pts, nowMs);
      }
      bgSaveDay(day);
      attachFix(evs, day);
    } catch (e) { /* never break DONE */ }
  }
  // Geolocation fix for a DONE: only if the permission is ALREADY granted (never prompts), 3 s timeout, fire-and-forget.
  function attachFix(evs, day) {
    try {
      if (!navigator.geolocation || !navigator.permissions || !navigator.permissions.query) return;
      navigator.permissions.query({ name: 'geolocation' }).then((st) => {
        if (st.state !== 'granted') return;
        navigator.geolocation.getCurrentPosition((p) => {
          evs.forEach((e) => { e.lat = p.coords.latitude; e.lng = p.coords.longitude; e.accuracy = p.coords.accuracy; });
          bgSaveDay(day);
        }, () => {}, { timeout: 3000, maximumAge: 60000 });
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // Undo the most recent DONE: the job actions go back to pending, the day log gets an `undo`, the summary recomputes.
  async function undoDone(stop0, i0) {
    const P = S.plan, cur = curPlan();
    if (!cur) return;
    const li = lastDoneIdx(cur);
    if (li < 0 || li !== i0) return;
    const stop = cur.stops[li];
    const day = Object.values(S.days).find((d) => DL.hasActiveDone(d, stop.placeId, stop.doneAt));
    if (day && day.closed) await reopenDay(day); // reopening restores carried / dropped jobs first
    for (const a of stop.actions) {
      const j = S.jobs.find((x) => x.id === a.jobId);
      if (!j) continue;
      if (a.kind === 'pickup') {
        const mine = (j.pickups || []).filter((p) => p.placeId === stop.placeId && p.done);
        const p = mine.filter((q) => (q.item || '') === (a.item || '')).pop() || mine.pop();
        if (p) p.done = false;
        if (j.status === 'done') { j.status = 'pending'; j.doneAt = null; }
      } else { j.status = 'pending'; j.doneAt = null; }
      await saveJob(j);
    }
    if (day) { DL.recordUndo(day, { nowIso: new Date().toISOString(), stopId: stop.placeId }); bgSaveDay(day); }
    delete stop.status; delete stop.doneAt;
    P.prompt = null;
    retimeNow();
    banner(null);
    await savePlan();
    render();
  }

  function dayCompleteBanner() {
    try {
      if (pendingJobs().length) return;
      const d = dayFor(Date.now(), false);
      if (d && !d.closed && DL.summarise(d, S.jobs, S.places).jobsDone > 0) banner('Day complete - view summary', 'info', () => openSummary(d.date));
    } catch (e) { /* ignore */ }
  }

  // ---------- DAY SUMMARY screen ----------
  function openSummary(date, opts) {
    opts = opts || {};
    const day = S.days[date];
    if (!day) return;
    const sh = openSheet('Day summary · ' + DL.fmtDate(date));
    sh.sheet.classList.add('summary');
    let routing = false;
    const sum = () => DL.summarise(day, S.jobs, S.places);
    const ro = () => !!opts.readOnly;
    const hm = DL.fmtTime;

    async function routeNow(manual) { // ONE routing request for the whole driven sequence (only when held leg data is missing)
      const s = sum();
      if (!s.route.needs || routing) return;
      if (!S.settings.tomtomKey) { if (manual) toast('TomTom key missing — add it in Settings.'); return; }
      routing = true; draw();
      try {
        const legs = await Providers.routeLegs(s.route.points, S.settings.tomtomKey);
        day.routed = { key: s.route.key, legs, at: new Date().toISOString() };
        await saveDay(day);
      } catch (e) { if (manual) toast(e.message || 'Routing failed'); }
      routing = false; draw();
    }

    function editTime(field, current) {
      const e = openSheet(field === 'startedAt' ? 'Started at' : 'Finished at');
      const inp = h('input', { type: 'time', value: current != null ? hm(current) : '' });
      e.body.append(h('label', { class: 'field' }, '24-hour time (Asia/Kuala_Lumpur)'), inp, h('div', { class: 'sticky-actions' },
        h('button', { onclick: e.close }, 'Cancel'),
        h('button', { onclick: async () => { delete day.edits[field]; await saveDay(day); e.close(); draw(); } }, 'Reset'),
        h('button', { class: 'primary', onclick: async () => {
          if (!inp.value) { toast('Pick a time'); return; }
          const [hh, mm] = inp.value.split(':').map(Number), s = sum();
          const baseMs = (current != null ? current : DL.dayStartMs(day.date));
          const dayMs = DL.dayStartMs(DL.dateKey(baseMs));
          let t = dayMs + (hh * 60 + mm) * 60000;
          if (field === 'finishedAt' && s.startedAt != null && t < s.startedAt) t += 86400000; // finished after midnight
          day.edits[field] = new Date(t).toISOString();
          await saveDay(day); e.close(); draw();
        } }, 'Save')));
    }

    const tile = (label, value, cls, fn) => h('div', { class: 'tile ' + (cls || '') + (fn ? ' tappable' : ''), role: fn ? 'button' : null, tabindex: fn ? '0' : null, onclick: fn || null },
      h('div', { class: 'tv' }, value), h('div', { class: 'tl' }, label));
    const sec = (title, cls, kids, empty) => h('div', { class: 'card sum-sec ' + cls }, h('div', { class: 'eyebrow' }, title),
      kids.length ? kids : h('div', { class: 'muted' }, empty || 'None'));
    const line = (main, time, chips) => h('div', { class: 'sum-line' }, h('div', { class: 'sl-main' }, main, chips || null), time ? h('div', { class: 'sl-time' }, time) : null);

    function draw() {
      const s = sum();
      const kmVal = s.km.status === 'ok' ? s.km.value.toFixed(1) + ' km' : s.km.status === 'none' ? '0.0 km' : routing ? 'Routing…' : 'km unavailable - tap to retry';
      const kmTile = tile('Est. km (road route between stops, not odometer)', kmVal, 'wide km' + (s.km.status === 'unavailable' ? ' unavailable' : ''),
        s.km.status === 'unavailable' && !routing ? () => routeNow(true) : null);
      const total = s.hoursOutMin, drv = s.driveMin;
      const bar = total && drv != null ? h('div', { class: 'split-bar', 'aria-hidden': 'true' },
        h('span', { class: 'drive', style: 'flex:' + Math.max(drv, 0.01) }), h('span', { class: 'stops', style: 'flex:' + Math.max(total - drv, 0.01) })) : null;
      const tiles = h('div', { class: 'tiles' },
        tile('Jobs done', s.jobsDone + ' of ' + s.jobsTotal, 'jobs'),
        tile('Stops visited', String(s.stopsVisited), 'stops'),
        kmTile,
        tile('Hours out', DL.fmtDur(s.hoursOutMin), 'hours'),
        h('div', { class: 'tile split' }, h('div', { class: 'tl' }, 'Drive (est.) vs at stops/other'),
          h('div', { class: 'tv2' }, h('span', { class: 'dv' }, DL.fmtDur(s.driveMin) + ' est.'), h('span', { class: 'sv' }, DL.fmtDur(s.atStopsMin))), bar));
      const timeRow = h('div', { class: 'row time-edit' },
        h('button', { class: 'small grow', disabled: ro(), onclick: () => editTime('startedAt', s.startedAt) }, 'Started ' + (s.startedAt != null ? hm(s.startedAt) : '—') + (ro() ? '' : ' ✎')),
        h('button', { class: 'small grow', disabled: ro(), onclick: () => editTime('finishedAt', s.finishedAt) }, 'Finished ' + (s.finishedAt != null ? hm(s.finishedAt) : '—') + (ro() ? '' : ' ✎')));

      const urgentChip = h('span', { class: 'chip urgent' }, 'URGENT'), lateChip = h('span', { class: 'chip late' }, 'LATE');
      const collected = sec('Collected', 'collect', s.collected.map((c) => line(h('span', null, c.item || '(item)', ' - ', c.place), hm(c.t))), 'Nothing collected');
      const delivered = sec('Delivered', 'deliver', s.delivered.map((d) => line(h('span', null, d.item || '(item)', ' - ', d.place), hm(d.t),
        [d.urgent ? urgentChip.cloneNode(true) : null, d.late ? lateChip.cloneNode(true) : null].filter(Boolean))), 'Nothing delivered');
      const errands = sec('Errands done', 'errand', s.errands.map((e) => line(h('span', null, e.item, ' - ', e.place), hm(e.t))), 'No errands');
      const withYou = sec('Still with you', 'inhand', s.stillWithYou.map((r) => line(h('span', null, r.item || '(item)', ' → ', r.to), null, r.urgent ? [urgentChip.cloneNode(true)] : null)), 'Nothing in the van');

      const notDone = sec('Not done', 'notdone', s.notDone.map((r) => {
        const dec = () => (day.decisions[r.jobId] = day.decisions[r.jobId] || {});
        const chips = h('div', { class: 'reasons' }, DL.REASONS.map((rs) => h('button', { type: 'button', class: 'chip-btn-r' + (r.reason === rs ? ' on' : ''), disabled: ro(), 'aria-pressed': r.reason === rs ? 'true' : 'false',
          onclick: (ev) => {
            const d = dec(); d.reason = d.reason === rs ? '' : rs; bgSaveDay(day);
            chips.querySelectorAll('button').forEach((b) => { const on = b.textContent === d.reason; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
          } }, rs)));
        const carry = h('label', { class: 'toggle carry' }, h('input', { type: 'checkbox', checked: r.carry, disabled: ro(), onchange: (ev) => { dec().carry = ev.target.checked; bgSaveDay(day); } }), 'Carry to tomorrow');
        return h('div', { class: 'nd-job' },
          h('div', { class: 'sl-main' }, h('b', null, (r.item || (r.type === 'errand' ? 'Errand' : '(item)')) + (r.to ? ' → ' + r.to : '')), r.urgent ? h('span', { class: 'chip urgent' }, 'URGENT') : null,
            r.withYou ? h('span', { class: 'chip inhand' }, 'WITH YOU') : null),
          h('div', { class: 'muted' }, r.from && r.from !== 'in hand' ? 'from ' + r.from : r.type === 'in-hand' ? 'in hand' : ''), chips, carry);
      }), 'Every job is done 🎉');

      const pv = s.plan;
      const pvl = (label, planned, actual) => h('div', { class: 'pv-row' }, h('span', null, label), h('span', { class: 'pv-vals' }, h('span', { class: 'muted' }, 'plan ' + planned), h('b', null, actual)));
      const planVs = h('div', { class: 'card sum-sec' }, h('div', { class: 'eyebrow' }, 'Plan vs actual'),
        pvl('Distance (est. km)', pv.plannedKm != null ? pv.plannedKm.toFixed(1) : '—', s.km.status === 'ok' ? s.km.value.toFixed(1) : s.km.status === 'none' ? '0.0' : '—'),
        pvl('Drive time (est.)', pv.plannedDriveMin != null ? DL.fmtDur(pv.plannedDriveMin) : '—', DL.fmtDur(s.driveMin)),
        pvl('Stops done', pv.stopsPlanned + ' planned', String(pv.stopsDone)),
        pvl('Replans', '', String(pv.replans)),
        pvl('Stops done out of the first plan’s order', '', String(pv.outOfOrder)));

      const copyBtn = h('button', { class: 'grow', onclick: async () => { toast((await copyText(DL.toWhatsApp(sum()))) ? 'Summary copied — paste into WhatsApp' : 'Could not copy'); } }, 'Copy summary');
      const csvBtn = h('button', { class: 'grow', onclick: () => downloadCsv(sum()) }, 'Download CSV');
      const main = ro() ? null : day.closed
        ? h('button', { class: 'big grow', id: 'reopenDay', onclick: async () => { await reopenDay(day); render(); draw(); toast('Day reopened'); } }, 'Reopen day')
        : h('button', { class: 'primary big grow', id: 'closeDay', onclick: async () => {
          const changed = DL.closeDay(day, S.jobs, S.places, new Date().toISOString());
          for (const j of changed) await saveJob(j);
          await saveDay(day); banner(null); render(); draw();
          toast('Day closed' + (day.carried.length ? ' · ' + day.carried.filter((c) => c.mode !== 'dropped').length + ' job(s) carried' : ''));
        } }, 'Close day');
      sh.body.replaceChildren(
        h('div', { class: 'muted sum-sub' }, day.driverId + ' · ' + (day.closed ? 'closed ' + (day.endedAt ? DL.fmtDate(DL.dateKey(Date.parse(day.endedAt))) + ' ' + hm(Date.parse(day.endedAt)) : '') : 'open') + (ro() ? ' · read-only' : '')),
        tiles, timeRow, collected, delivered, errands, withYou, notDone, planVs,
        h('div', { class: 'sum-actions' }, h('div', { class: 'row' }, copyBtn, csvBtn), h('div', { class: 'row' }, main, h('button', { onclick: sh.close }, 'Back'))));
    }
    draw();
    if (!ro() && !day.closed) routeNow(false);
  }

  function downloadCsv(s) {
    const a = h('a', { href: URL.createObjectURL(new Blob([DL.toCSV(s)], { type: 'text/csv;charset=utf-8' })), download: 'waypoint-' + s.date + '.csv' });
    document.body.append(a); a.click(); a.remove();
  }

  // Settings: current-week totals (Mon–Sun) + the last 30 days; a row reopens that day's summary read-only
  function historyCard() {
    const today = DL.dateKey(Date.now());
    const sums = Object.values(S.days).map((d) => ({ d, s: DL.summarise(d, S.jobs, S.places) }));
    const rowOf = (x) => ({ date: x.d.date, jobsDone: x.s.jobsDone, jobsTotal: x.s.jobsTotal, km: x.s.km.status === 'ok' ? x.s.km.value : x.s.km.status === 'none' ? 0 : null, hoursOutMin: x.s.hoursOutMin });
    const w = DL.weekTotals(sums.map(rowOf), today);
    const keys = DL.historyKeys(Object.keys(S.days), today, 30);
    return h('div', { class: 'card', id: 'historyCard' }, h('h2', { style: 'margin-top:0' }, 'Day history'),
      h('div', { class: 'week', id: 'weekTotals' }, h('div', { class: 'muted' }, 'This week · ' + DL.fmtDate(w.from) + ' – ' + DL.fmtDate(w.to)),
        h('div', { class: 'title' }, w.jobsDone + ' of ' + w.jobsTotal + ' jobs · ' + w.km.toFixed(1) + ' km' + (w.kmMissing ? '*' : '') + ' · ' + DL.fmtDur(w.hoursOutMin) + ' out'),
        w.kmMissing ? h('div', { class: 'muted' }, '* ' + w.kmMissing + ' day(s) without km') : null),
      keys.length ? keys.map((k) => { const x = sums.find((y) => y.d.date === k), r = rowOf(x);
        return h('button', { class: 'hist-row', onclick: () => openSummary(k, { readOnly: true }) },
          h('span', { class: 'hd' }, DL.fmtDate(k)), h('span', { class: 'hj' }, r.jobsDone + '/' + r.jobsTotal), h('span', { class: 'hk' }, r.km == null ? 'km —' : r.km.toFixed(1) + ' km'), h('span', { class: 'hh' }, DL.fmtDur(r.hoursOutMin))); })
        : h('div', { class: 'muted' }, 'No days recorded yet.'));
  }

  // ---------- messaging ----------
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
      document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }
  async function shareMessage(place, text) {
    const link = Messages.waLink(place.whatsapp, text);
    if (link) { window.open(link, '_blank', 'noopener'); return; }
    const ok = await copyText(text);
    toast(ok ? 'Copied — paste into WhatsApp' : 'Could not copy. Add a WhatsApp number to the place.');
  }
  // The solver only knows pickup items; an in-hand job carries its own item on the job (inHandItem).
  function deliverItem(a) {
    if (a.item) return a.item;
    const j = ((S.plan && S.plan.ctx.jobs) || []).find((x) => x.id === a.jobId) || S.jobs.find((x) => x.id === a.jobId);
    return (j && j.inHandItem) || '';
  }
  function stopMessage(stop, shiftMs) {
    const place = S.plan.ctx.places[stop.placeId] || S.places[stop.placeId];
    const items = stop.actions.filter((a) => a.kind === 'deliver').map(deliverItem).filter(Boolean).join(', ');
    const live = S.places[stop.placeId] || place; // latest edits to number/salutation win
    const text = Messages.buildMessage({ place: live, settings: S.settings, arriveAt: new Date(stop.arriveAt + (shiftMs || 0)), items });
    return { place: live, text };
  }

  // ---------- ROUTE tab ----------
  const mapsLl = (p) => p.lat + ',' + p.lng;
  function gmapsUrl(origin, dest, waypoints) {
    return 'https://www.google.com/maps/dir/?api=1&origin=' + mapsLl(origin) + '&destination=' + mapsLl(dest) +
      (waypoints.length ? '&waypoints=' + waypoints.map(mapsLl).join('%7C') : '') + '&travelmode=driving';
  }
  const wazeUrl = (p) => 'https://waze.com/ul?ll=' + mapsLl(p) + '&navigate=yes';

  function renderRoute(v) {
    const P = S.plan;
    if (!P) { v.append(h('div', { class: 'empty card' }, 'No plan yet. Add jobs on the Plan tab and tap PLAN.')); return; }
    const r = P.result;
    if (r.error) {
      v.append(h('div', { class: 'violations' }, r.error), h('button', { onclick: () => { S.tab = 'plan'; render(); } }, 'Back to Plan'));
      return;
    }
    const plan = r.plans[P.idx];
    const ctx = P.ctx;
    const totalStops = plan.stops.length;
    const remaining = plan.stops.filter((s) => !s.status);

    v.append(
      h('div', { class: 'card' },
        h('div', { class: 'totals' },
          h('div', null, h('b', null, totalStops), h('span', { class: 'muted' }, 'stops')),
          h('div', null, h('b', null, Solver.formatDuration(plan.totalSec)), h('span', { class: 'muted' }, 'total')),
          h('div', null, h('b', null, fmt(plan.endArrival)), h('span', { class: 'muted' }, 'arrive ' + (ctx.end.name || 'end')))),
        h('div', { class: 'muted', style: 'margin-top:8px' }, 'Depart ' + fmt(Date.parse(ctx.departAtISO))),
        P.shiftMs > 60000 ? h('div', { class: 'chip detour' }, 'Running ' + Math.round(P.shiftMs / 60000) + ' min behind plan') : null),
      h('label', { class: 'toggle card' }, h('input', { type: 'checkbox', checked: P.noDetour, onchange: (e) => { P.noDetour = e.target.checked; reSolveFromCache(); } }), 'No detour (urgent deliveries first, nothing else in between)'));

    if (plan.violations.length) v.append(h('div', { class: 'violations' }, h('b', null, 'No plan meets every time window:'), plan.violations.map((t) => h('div', null, '• ' + t))));

    // navigation
    const wps = remaining.map((s) => S.places[s.placeId] || ctx.places[s.placeId]);
    const navRow = h('div', { class: 'row' });
    if (wps.length <= 9) {
      navRow.append(h('a', { class: 'btn primary grow', href: gmapsUrl(ctx.start, ctx.end, wps), target: '_blank', rel: 'noopener' }, 'Open in Google Maps'));
    } else {
      const half = Math.ceil(wps.length / 2);
      navRow.append(
        h('a', { class: 'btn primary grow', href: gmapsUrl(ctx.start, wps[half - 1], wps.slice(0, half - 1)), target: '_blank', rel: 'noopener' }, 'Google Maps — Leg 1'),
        h('a', { class: 'btn primary grow', href: gmapsUrl(wps[half - 1], ctx.end, wps.slice(half)), target: '_blank', rel: 'noopener' }, 'Google Maps — Leg 2'));
    }
    navRow.append(h('button', { class: 'grow', onclick: () => replanFromHere() }, 'Replan from here'));
    // a CLOSED stop still ahead: offer the closed-windows-respected alternative (re-solved from the cached matrices)
    if (!P.alt && remaining.some((s) => s.closedWarning)) navRow.append(h('button', { class: 'grow', id: 'avoidLunch', onclick: () => { computeAvoidLunch(); render(); } }, 'Avoid lunch'));
    v.append(navRow);
    if (P.alt) v.append(altCard(P));

    if (plan.stops.some((s) => s.status === 'skipped')) v.append(h('div', { class: 'prompt' }, 'A stop was skipped. ', h('button', { class: 'small', onclick: () => replanFromHere() }, 'Replan from here')));
    if (P.prompt) {
      const stop = plan.stops.find((s) => s.placeId === P.prompt.placeId);
      const place = S.places[P.prompt.placeId];
      if (stop && place) {
        v.append(h('div', { class: 'prompt' }, h('div', { class: 'title' }, 'Send ETA to ' + dName(place.name) + '?'),
          h('div', { class: 'row', style: 'margin-top:8px' },
            h('button', { class: 'primary grow', onclick: () => { const m = stopMessage(stop, P.shiftMs); P.prompt = null; shareMessage(m.place, m.text); render(); } }, 'Send'),
            h('button', { class: 'grow', onclick: () => { P.prompt = null; render(); } }, 'Dismiss'))));
      }
    }

    // timeline
    const tl = h('div', { class: 'timeline' });
    plan.stops.forEach((stop, i) => tl.append(stopCard(stop, i)));
    v.append(tl);
    v.append(h('div', { class: 'card muted' }, 'Then to ' + (ctx.end.name || 'end') + ', arriving ' + fmt(plan.endArrival) + '.'));
    v.append(h('button', { class: 'text-btn', id: 'clearPlan', onclick: () => { if (confirm('Clear the current plan? Stops marked done will be forgotten.')) clearPlan(); } }, 'Clear plan'));

    // alternatives
    if (r.plans.length > 1) {
      v.append(h('details', null, h('summary', null, 'Alternatives (' + (r.plans.length - 1) + ')'),
        r.plans.map((alt, i) => i === P.idx ? null : h('div', { class: 'card' },
          h('div', { class: 'row spread' }, h('b', null, 'Plan ' + (i + 1) + ' · ' + Solver.formatDuration(alt.totalSec)), h('span', { class: 'times' }, '→ ' + fmt(alt.endArrival))),
          h('div', { class: 'muted' }, alt.order.map((id) => dName(pName(id))).join(' → ')),
          alt.violations.length ? h('div', { class: 'chip closed' }, alt.violations.length + ' window issue(s)') : null,
          h('button', { class: 'small', style: 'margin-top:8px', onclick: () => { P.idx = i; render(); } }, 'Use this plan')))));
    }
  }

  function altCard(P) { // the "Avoid lunch" alternative, next to the current plan
    const A = P.alt, dismiss = () => { P.alt = null; render(); };
    if (!A.ok) {
      return h('div', { class: 'prompt', id: 'altCard' }, h('div', { class: 'title' }, 'Avoid lunch'), h('div', null, A.message),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'small', onclick: dismiss }, 'OK')));
    }
    const d = Math.round(A.deltaMs / 60000);
    const delta = d === 0 ? 'same total time' : (d > 0 ? '+' + d : '−' + Math.abs(d)) + ' min total';
    return h('div', { class: 'card alt', id: 'altCard' },
      h('div', { class: 'row spread' }, h('div', { class: 'title' }, 'Avoid lunch alternative'), h('span', { class: 'chip alt-delta' + (d > 0 ? ' detour' : '') }, delta)),
      h('div', { class: 'muted' }, 'Arrive ' + ((P.ctx.end && P.ctx.end.name) || 'end') + ' ' + fmt(A.plan.endArrival) + ' (now ' + fmt(A.baseEnd) + ')'),
      A.plan.stops.map((s, i) => h('div', { class: 'alt-stop' },
        h('div', { class: 'row spread' }, h('b', null, (i + 1) + '. ' + dName(pName(s.placeId))), h('span', { class: 'times' }, fmt(s.arriveAt) + ' → ' + fmt(s.departAt))),
        s.waitSec >= 60 ? h('div', { class: 'muted' }, 'wait ' + Math.round(s.waitSec / 60) + ' min at ' + dName(pName(s.placeId))) : null)),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'primary grow', onclick: () => useAlt() }, 'Use this'),
        h('button', { class: 'grow', onclick: dismiss }, 'Keep current')));
  }

  function stopCard(stop, i) {
    const P = S.plan;
    const place = S.places[stop.placeId] || P.ctx.places[stop.placeId];
    const st = stop.status;
    if (st === 'done') { // done stops collapse to one line: tick, name, actual done time
      const undoable = i === lastDoneIdx(curPlan());
      return h('div', { class: 'card stop done compact' }, h('div', { class: 'row spread' },
        h('div', { class: 'title' }, '✓ ' + (i + 1) + '. ' + dName(place.name)),
        h('div', { class: 'muted times' }, 'done ' + fmt(Date.parse(stop.doneAt))),
        undoable ? h('button', { class: 'small undo', 'aria-label': 'Undo done', onclick: () => undoDone(stop, i) }, 'Undo') : null));
    }
    const hasDelivery = stop.actions.some((a) => a.kind === 'deliver');
    // Actions as boxes (same tokens as the Plan cards): COLLECT "item → customer", DELIVER items, ERRAND.
    const jobOf = (id) => (P.ctx.jobs || []).find((x) => x.id === id) || S.jobs.find((x) => x.id === id);
    const customerOf = (a) => {
      const j = jobOf(a.jobId), pid = j && j.deliveryPlaceId;
      return pid ? ((P.ctx.places[pid] || S.places[pid] || {}).name || '(unknown)') : '(no delivery)';
    };
    // one line per action; colour rule + arrow carry the meaning (amber pickup, teal delivery, green errand)
    const ofKind = (k) => stop.actions.filter((a) => a.kind === k);
    const line = (cls, t) => h('div', { class: 'act ' + cls }, t);
    const lines = [].concat(
      ofKind('pickup').map((a) => line('collect', (a.item || 'items') + ' → ' + dName(customerOf(a)))),
      ofKind('deliver').map((a) => line('deliver', deliverItem(a) || '—')),
      ofKind('errand').map((a) => line('errand', a.item || 'Errand')));
    const pills = [];
    if (stop.detour) pills.push(h('span', { class: 'pill detour' }, 'DETOUR'));
    if (stop.closedWarning) pills.push(h('span', { class: 'pill closed' }, 'CLOSED'));
    // expanded section (state lives in openStops for this session only, keyed by place; not persisted)
    const wd = (() => { const d = new Date(stop.arriveAt).getDay(); return d === 0 ? 7 : d; })();
    const todays = (place.closedWindows || []).filter((w) => (Array.isArray(w.days) ? w.days : ALL_DAYS).indexOf(wd) >= 0);
    const more = h('div', { class: 'stop-more', hidden: !openStops.has(stop.placeId) },
      place.address ? h('div', null, place.address) : null,
      h('div', { class: 'times' }, fmt(stop.arriveAt) + ' → ' + fmt(stop.departAt)),
      todays.length ? h('div', null, 'Closed today: ' + todays.map((w) => w.from + '–' + w.to).join(', ')) : null,
      stop.waitSec > 60 ? h('div', null, 'Wait ~' + Math.round(stop.waitSec / 60) + ' min here before service starts.') : null,
      stop.detour ? h('div', null, 'Detour: not urgent, but visited before the last urgent delivery.') : null,
      stop.closedWarning ? h('div', null, 'Closed: expected arrival falls inside a closed window.') : null);
    const head = h('div', { class: 'stop-head', role: 'button', tabindex: '0', 'aria-expanded': String(openStops.has(stop.placeId)) },
      h('span', { class: 'num' }, (i + 1) + '.'),
      h('span', { class: 'nm' }, dName(place.name)),
      pills,
      h('span', { class: 'times' }, fmt(stop.arriveAt)));
    const toggle = () => {
      const on = more.hidden; more.hidden = !on;
      head.setAttribute('aria-expanded', String(on));
      if (on) openStops.add(stop.placeId); else openStops.delete(stop.placeId);
    };
    head.onclick = toggle;
    head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
    const nav = S.settings.nav || 'waze';
    const btns = [];
    if (nav === 'waze' || nav === 'both') btns.push(h('a', { class: 'btn small', href: wazeUrl(place), target: '_blank', rel: 'noopener' }, 'WAZE'));
    if (nav === 'google' || nav === 'both') btns.push(h('a', { class: 'btn small', href: gmapsUrl(P.ctx.start, place, []).replace(/origin=[^&]*&/, ''), target: '_blank', rel: 'noopener' }, 'MAPS'));
    if (hasDelivery) btns.push(h('button', { class: 'small', onclick: () => { const m = stopMessage(stop, P.shiftMs); shareMessage(m.place, m.text); } }, 'MSG'));
    if (!st) {
      btns.push(h('button', { class: 'small ok', onclick: () => markDone(stop, i) }, 'DONE'));
      btns.push(h('button', { class: 'small', onclick: () => skipStop(stop, i) }, 'SKIP'));
    } else {
      btns.push(h('span', { class: 'chip' }, 'Skipped'));
    }
    return h('div', { class: 'card stop ' + (st || '') + (stop.detour ? ' detour' : '') },
      head, more,
      lines.length ? h('div', { class: 'stop-acts' }, lines) : null,
      h('div', { class: 'stop-btns' }, btns));
  }

  // the stop object a button was rendered with may belong to an older plan object (re-timing replaces them): re-find it
  function liveStop(stop, i) {
    const cur = curPlan();
    if (!cur) return null;
    const ci = cur.stops[i] && cur.stops[i].placeId === stop.placeId ? i : cur.stops.findIndex((s) => s.placeId === stop.placeId && !s.status);
    return ci < 0 ? null : { stop: cur.stops[ci], i: ci };
  }

  async function markDone(stop0, i0) {
    const P = S.plan;
    const ls = liveStop(stop0, i0);
    if (!ls) return;
    const stop = ls.stop, i = ls.i;
    await reopenIfClosed();
    const nowIso = new Date().toISOString();
    for (const a of stop.actions) {
      const j = S.jobs.find((x) => x.id === a.jobId);
      if (!j) continue;
      if (a.kind === 'pickup') {
        const mine = (j.pickups || []).filter((p) => p.placeId === stop.placeId && !p.done);
        const p = mine.find((q) => (q.item || '') === (a.item || '')) || mine[0];
        if (p) p.done = true;
        if (!j.deliveryPlaceId && !j.errandPlaceId && j.pickups.every((q) => q.done)) { j.status = 'done'; j.doneAt = nowIso; }
      } else { j.status = 'done'; j.doneAt = nowIso; }
      await saveJob(j);
    }
    stop.status = 'done';
    stop.doneAt = nowIso;
    logDone(stop, nowIso); // synchronous, in memory: never delays DONE (save + geolocation fix happen in the background)
    P.alt = null;
    P.result.plans = [P.result.plans[P.idx]]; P.idx = 0; // alternatives pre-date this DONE: drop them
    await refreshIfStale(P.result.plans[0]);              // travel times older than 30 min are re-fetched first
    // live re-timing: from this stop, at the current time, order unchanged
    P.result.plans[0] = Solver.retime(P.result.plans[0], i, nowIso);
    P.shiftMs = 0;
    // offer to send the ETA to the next stop if it is a delivery and has a WhatsApp number
    const plan = P.result.plans[0];
    const next = plan.stops.slice(i + 1).find((s) => !s.status);
    P.prompt = null;
    if (next && next.actions.some((a) => a.kind === 'deliver')) {
      const np = S.places[next.placeId];
      if (np && np.whatsapp) P.prompt = { placeId: next.placeId };
    }
    if (!plan.stops.some((s) => !s.status)) toast('Run complete 🎉');
    await savePlan();
    render();
    dayCompleteBanner();
  }

  async function skipStop(stop0, i0) { // actions stay pending; ETAs re-timed from this stop at the current time
    const P = S.plan;
    const ls = liveStop(stop0, i0);
    if (!ls) return;
    const stop = ls.stop, i = ls.i;
    stop.status = 'skipped';
    P.alt = null;
    P.result.plans = [P.result.plans[P.idx]]; P.idx = 0;
    P.result.plans[0] = Solver.retime(P.result.plans[0], i, new Date().toISOString());
    P.shiftMs = 0;
    toast('Skipped — actions stay pending. Replan to bring it back.');
    await savePlan();
    render();
  }

  async function replanFromHere() {
    if (!pendingJobs().length) { toast('Nothing left to plan.'); return; }
    await doPlan({ replan: true });
  }

  // ---------- PLACES tab ----------
  let placeFilter = '';
  function renderPlaces(v) {
    const input = h('input', { type: 'search', placeholder: 'Search saved places…', value: placeFilter, oninput: (e) => { placeFilter = e.target.value; drawList(); } });
    const list = h('div');
    function drawList() {
      const q = placeFilter.trim().toLowerCase();
      const items = Object.values(S.places).filter((p) => !q || (p.name + ' ' + p.address).toLowerCase().includes(q)).sort(byName);
      list.replaceChildren(...(items.length ? items.map((p) => h('div', { class: 'card', onclick: () => openPlaceEditor(p) },
        h('div', { class: 'row spread' }, h('div', { class: 'title' }, p.name), h('span', { class: 'chip' }, p.type)),
        h('div', { class: 'muted' }, p.address || (p.lat.toFixed(4) + ', ' + p.lng.toFixed(4))),
        h('div', { class: 'muted' }, 'Dwell ' + p.dwellMin + ' min' + (p.whatsapp ? ' · WA ' + p.whatsapp : '') + ((p.closedWindows || []).length ? ' · closed ' + p.closedWindows.map((w) => (daysLabel(w.days) ? daysLabel(w.days) + ' ' : '') + w.from + '–' + w.to).join(', ') : '')))) : [h('div', { class: 'empty card' }, 'No places yet.')]));
    }
    v.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, input), h('button', { class: 'primary', onclick: () => openPlacePicker((p) => openPlaceEditor(p), 'Add place') }, '+ Add')), list);
    drawList();
  }

  function openPlaceEditor(p) {
    const sh = openSheet('Edit place');
    const w = JSON.parse(JSON.stringify(p.closedWindows || []));
    const name = h('input', { value: p.name });
    const addr = h('input', { value: p.address });
    const dwell = h('input', { type: 'number', inputmode: 'numeric', min: '0', value: String(p.dwellMin) });
    const type = h('select', { onchange: (e) => { dwell.value = String(S.settings.dwellDefaults[e.target.value] != null ? S.settings.dwellDefaults[e.target.value] : 10); syncType(); } }, TYPES.map((t) => h('option', { value: t, selected: p.type === t }, t)));
    const wa = h('input', { type: 'tel', inputmode: 'tel', value: p.whatsapp || '', placeholder: '012-345 6789' });
    const sal = h('select', null, ['Encik', 'Puan', 'Cik'].map((t) => h('option', { value: t, selected: (p.salutation || 'Encik') === t }, t)));
    const lang = h('select', null, [['default', 'Default (' + S.settings.defaultLang + ')'], ['ms', 'Bahasa Malaysia'], ['en', 'English']].map(([val, lab]) => h('option', { value: val, selected: (p.lang || 'default') === val }, lab)));
    // suppliers are collected from, never messaged: hide salutation + language for them (WhatsApp stays)
    const salBox = h('div', null, h('label', { class: 'field' }, 'Salutation'), sal, h('label', { class: 'field' }, 'Message language'), lang);
    function syncType() { salBox.hidden = type.value === 'supplier'; }
    syncType();
    const wBox = h('div');
    w.forEach((x) => { if (!Array.isArray(x.days)) x.days = ALL_DAYS.slice(); });
    function drawW() { // each window: M T W T F S S toggle chips (ISO Mon=1) + from / to
      wBox.replaceChildren(...w.map((x, i) => h('div', { class: 'win-row' },
        h('div', { class: 'days' }, DAY_CHIPS.map((lab, d) => {
          const on = x.days.includes(d + 1);
          return h('button', { class: 'day' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', 'aria-label': DAY_NAMES[d],
            onclick: () => { x.days = on ? x.days.filter((n) => n !== d + 1) : x.days.concat(d + 1).sort((a, b) => a - b); drawW(); } }, lab);
        })),
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('input', { type: 'time', value: x.from, oninput: (e) => { x.from = e.target.value; } })),
          h('div', { class: 'grow' }, h('input', { type: 'time', value: x.to, oninput: (e) => { x.to = e.target.value; } })),
          h('button', { class: 'small danger', 'aria-label': 'Remove window', onclick: () => { w.splice(i, 1); drawW(); } }, '✕')))));
    }
    drawW();
    sh.body.append(
      h('label', { class: 'field' }, 'Name'), name, h('label', { class: 'field' }, 'Address'), addr,
      h('label', { class: 'field' }, 'Type'), type, h('label', { class: 'field' }, 'Dwell (minutes)'), dwell,
      h('label', { class: 'field' }, 'Closed windows (by weekday)'), wBox,
      h('button', { class: 'small', onclick: () => { w.push({ days: ALL_DAYS.slice(), from: '12:00', to: '13:00' }); drawW(); } }, '+ Add closed window'),
      h('label', { class: 'field' }, 'WhatsApp number'), wa,
      salBox,
      h('div', { class: 'sticky-actions' },
        h('button', { class: 'danger', onclick: async () => {
          const used = S.jobs.some((j) => j.status !== 'done' && (j.deliveryPlaceId === p.id || j.errandPlaceId === p.id || (j.pickups || []).some((x) => x.placeId === p.id)));
          if (used) { toast('Used by an open job — delete or finish that job first.'); return; }
          if (!confirm('Delete ' + p.name + '?')) return;
          delete S.places[p.id]; await WPStore.remove('places', p.id); sh.close(); render();
        } }, 'Delete'),
        h('button', { onclick: sh.close }, 'Cancel'),
        h('button', { class: 'primary', onclick: async () => {
          if (!name.value.trim()) { toast('Name is required'); return; }
          Object.assign(p, { name: name.value.trim(), address: addr.value.trim(), type: type.value, dwellMin: Number(dwell.value) || 0, closedWindows: w.filter((x) => x.from && x.to && x.days.length), whatsapp: wa.value.trim(), salutation: sal.value, lang: lang.value });
          await savePlace(p); sh.close(); render();
        } }, 'Save')));
  }

  // ---------- SETTINGS tab ----------
  function lastPlanText() {
    const res = S.plan && S.plan.result;
    if (!res) return 'Last plan: none yet';
    if (!res.stats) return 'Last plan: restored from storage';
    const st = res.stats;
    return 'Last plan: ' + st.nodes + ' nodes, ' + st.ms + ' ms (' + st.mode + (st.truncated ? ', time-limited — best found' : '') + ')';
  }
  function renderSettings(v) {
    const s = S.settings;
    const field = (label, el) => [h('label', { class: 'field' }, label), el];
    const bind = (el, key, conv) => { el.addEventListener('change', () => { s[key] = conv ? conv(el.value) : el.value; saveSettings(); }); return el; };
    const tplHelp = h('div', { class: 'muted' }, 'Placeholders: {salam} greeting · {salutation} Encik/Puan/Cik · {items} item names · {time} ETA · {name} place name');
    const tpl = (lang, label) => {
      const ta = h('textarea', { value: s.templates[lang] });
      ta.addEventListener('change', () => { s.templates[lang] = ta.value; saveSettings(); });
      return [h('label', { class: 'field' }, label), ta, h('button', { class: 'small', onclick: () => { s.templates[lang] = Messages.DEFAULT_TEMPLATES[lang]; saveSettings(); render(); } }, 'Reset to default')];
    };
    const dd = TYPES.map((t) => {
      const inp = h('input', { type: 'number', inputmode: 'numeric', min: '0', value: String(s.dwellDefaults[t]) });
      inp.addEventListener('change', () => { s.dwellDefaults[t] = Number(inp.value) || 0; saveSettings(); });
      return h('div', { class: 'grow' }, h('label', { class: 'field' }, t), inp);
    });
    const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: (e) => importJson(e.target.files[0]) });
    v.append(
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'API keys'),
        field('Google Places key (place search only)', bind(h('input', { type: 'password', autocomplete: 'off', value: s.googleKey }), 'googleKey')),
        field('TomTom key (all travel times)', bind(h('input', { type: 'password', autocomplete: 'off', value: s.tomtomKey }), 'tomtomKey')),
        h('div', { class: 'muted' }, 'Keys stay on this device (never in the code, never exported).')),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Google Places calls today'),
        h('div', { class: 'title' }, String(placesCallsToday())),
        h('div', { class: 'muted' }, 'Counted on this device only. Google quota cap 150/day set in Cloud console.')),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Driver'),
        field('Driver name (day log + summary)', bind(h('input', { value: s.driverName || 'Calvin', autocomplete: 'off' }), 'driverName', (x) => x.trim() || 'Calvin'))),
      historyCard(),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Messages'),
        field('Default language', bind(h('select', null, [['ms', 'Bahasa Malaysia'], ['en', 'English']].map(([val, lab]) => h('option', { value: val, selected: s.defaultLang === val }, lab))), 'defaultLang')),
        field('ETA padding (minutes)', bind(h('input', { type: 'number', inputmode: 'numeric', min: '0', value: String(s.etaPaddingMin) }), 'etaPaddingMin', (x) => Number(x) || 0)),
        tplHelp, tpl('ms', 'Template — Bahasa Malaysia'), tpl('en', 'Template — English')),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Default dwell (minutes) for new places'), h('div', { class: 'row' }, dd)),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Navigation'),
        field('Per-stop navigation button', bind(h('select', null, [['waze', 'Waze'], ['google', 'Google Maps'], ['both', 'Both']].map(([val, lab]) => h('option', { value: val, selected: s.nav === val }, lab))), 'nav'))),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Data'),
        h('div', { class: 'row' }, h('button', { class: 'grow', onclick: exportJson }, 'Export JSON'), h('button', { class: 'grow', onclick: () => fileIn.click() }, 'Import JSON'), fileIn),
        h('button', { style: 'margin-top:8px', onclick: () => { Providers.clearCache(); toast('Travel-time cache cleared'); } }, 'Clear travel-time cache')),
      h('div', { class: 'muted', id: 'lastPlan', style: 'text-align:center;font-size:12px' }, lastPlanText()),
      h('div', { class: 'muted', style: 'text-align:center' }, 'L-Tech Waypoint v' + APP_VERSION + ' · build ' + BUILD_STAMP),
      h('div', { class: 'muted', id: 'swBuild', style: 'text-align:center;font-size:12px' }, 'Service worker: checking…'));
    describeServiceWorker().then((t) => { const el = document.getElementById('swBuild'); if (el) el.textContent = t; });
  }

  // Which build is the service worker running? (compare with the build above; they match once an update has applied)
  async function describeServiceWorker() {
    if (!('serviceWorker' in navigator)) return 'Service worker: not supported here';
    const ctl = navigator.serviceWorker.controller;
    if (!ctl) return 'Service worker: not active (offline cache off)';
    try {
      const build = await new Promise((resolve, reject) => {
        const ch = new MessageChannel();
        const t = setTimeout(() => reject(new Error('timeout')), 1500);
        ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
        ctl.postMessage('build', [ch.port2]);
      });
      return 'Service worker: build ' + build + (build === BUILD_STAMP ? '' : ' (update pending)');
    } catch (e) { return 'Service worker: active'; }
  }

  function exportJson() {
    const settings = Object.assign({}, S.settings); delete settings.googleKey; delete settings.tomtomKey;
    const data = { app: 'waypoint', version: APP_VERSION, exportedAt: new Date().toISOString(), places: Object.values(S.places), jobs: S.jobs, settings };
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'waypoint-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.append(a); a.click(); a.remove();
  }
  async function importJson(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'waypoint' || !Array.isArray(data.places) || !Array.isArray(data.jobs)) throw new Error('Not a Waypoint export.');
      if (!confirm('Replace current places and jobs with ' + data.places.length + ' places and ' + data.jobs.length + ' jobs from this file?')) return;
      await WPStore.clear('places'); await WPStore.clear('jobs');
      S.places = {}; S.jobs = [];
      for (const p of data.places) { normalizeWindows(p); await savePlace(p); }
      await WPStore.remove('plan', 'current');
      for (const j of data.jobs) { S.jobs.push(j); await saveJob(j); }
      if (data.settings) {
        const keep = { googleKey: S.settings.googleKey, tomtomKey: S.settings.tomtomKey, placesCallsToday: S.settings.placesCallsToday };
        S.settings = Object.assign(defaultSettings(), data.settings, keep);
        await saveSettings();
      }
      S.plan = null;
      toast('Imported.');
      render();
    } catch (e) { toast('Import failed: ' + e.message); }
  }

  // ---------- shell ----------
  function render() {
    const v = document.getElementById('view');
    const scroll = window.scrollY;
    v.replaceChildren();
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
    if (S.tab === 'plan') renderPlan(v);
    else if (S.tab === 'route') renderRoute(v);
    else if (S.tab === 'places') renderPlaces(v);
    else renderSettings(v);
    window.scrollTo(0, scroll);
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.tab = b.dataset.tab;
    window.scrollTo(0, 0);
    render();
    if (S.plan) savePlan(); // the stored plan remembers which tab you were on
  });

  // Back in the foreground: re-time what is left from the last done stop (or the start) at the current time.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.plan) return;
    if (retimeNow()) { savePlan(); if (S.tab === 'route') render(); }
  });

  // Service worker: register, look for updates on every launch and whenever the app comes back to the
  // foreground, and reload once when a NEW worker takes control (so the fresh code is what you see).
  function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker;
    const hadController = !!sw.controller; // first install also fires controllerchange (clients.claim): nothing stale then
    let reloaded = false;
    const recentlyReloaded = () => { try { return Date.now() - Number(sessionStorage.getItem('wp-sw-reload') || 0) < 10000; } catch (e) { return false; } };
    function reloadOnce() {
      if (reloaded || recentlyReloaded()) return; // flag + sessionStorage stamp: never loop
      // don't wipe a sheet the user is typing in, or a plan that is being computed: wait until it is idle
      if (S.busy || document.querySelector('.backdrop')) { setTimeout(reloadOnce, 1500); return; }
      reloaded = true;
      try { sessionStorage.setItem('wp-sw-reload', String(Date.now())); } catch (e) { /* ignore */ }
      location.reload();
    }
    sw.addEventListener('controllerchange', () => { if (hadController) reloadOnce(); });
    sw.register('sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
      const check = () => reg.update().catch(() => {});
      check(); // every launch
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    }).catch(() => {});
  }

  load().then(() => {
    if (S.plan && retimeNow()) savePlan(); // restored plan: re-time from the last done stop (or start) at the current time
    render();
    setupServiceWorker();
  }).catch((e) => banner('Startup failed: ' + e.message, 'error'));

  window.WaypointDebug = { S, doPlan, render };
})();
