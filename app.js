/* L-Tech Waypoint — app.js (UI). Depends on WPStore, Solver, Messages, Providers. */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
  const BUILD_STAMP = 'f7650cb4'; // written by tools/stamp-sw.js (content hash of the app shell)
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
    plan: null, busy: false, days: {}, loc: { lastAt: null, origin: null, busy: false, reason: null }, timesFrom: null,
    fuelStations: [], // permanent station memory (see FUEL STOP below); in Export / Import, never shown in the Places tab
    lunch: null, // today's lunch-break state {date, startedAt, endedAt, skipped} (LUNCH BREAK below); stored as meta:lunchBreak
  };

  function defaultSettings() {
    return {
      googleKey: '', tomtomKey: '', defaultLang: 'ms',
      templates: Object.assign({}, Messages.DEFAULT_TEMPLATES),
      etaPaddingMin: 15, dwellDefaults: Object.assign({}, DEFAULT_DWELL),
      placesCallsToday: { date: todayStr(), count: 0 }, nav: 'waze', seeded: false, driverName: 'Calvin',
      fuelBrand: 'Caltex', fuelDwellMin: 7, fuelMaxSearches: 50,
      autoReach: true, // mark Reached automatically within 150 m (app open); stored on the device, in Export / Import
      // the driver's lunch break (Settings -> Lunch break; device-stored, in Export / Import)
      lunchBreakOn: LunchBreak.DEFAULTS.lunchBreakOn, lunchBreakFrom: LunchBreak.DEFAULTS.lunchBreakFrom, lunchBreakMin: LunchBreak.DEFAULTS.lunchBreakMin,
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
    const fm = await WPStore.get('meta', 'fuelStations');
    S.fuelStations = fm && Array.isArray(fm.list) ? fm.list : [];
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
    try { S.lunch = LunchBreak.forDay(await WPStore.get('meta', 'lunchBreak'), lunchDayKey()); } catch (e) { S.lunch = LunchBreak.fresh(lunchDayKey()); }
  }

  // ---------- closed windows: {days:[1..7] (ISO, Mon=1), from, to} ----------
  const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
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

  const placeCtx = () => ({ uid, dwellDefaults: S.settings.dwellDefaults, DEFAULT_DWELL });
  function newPlace(o) { return Geo.makePlace(o, placeCtx()); }

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
        .concat(localMatches(q0).map((p) => row(p.name, Messages.typeLabel(p.type) + (p.address ? ' · ' + p.address : ''), () => choose(p))));
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

    // pinned outside the scrolling list, just above Cancel: always visible (zero results, failed search, offline...)
    const manual = h('button', { class: 'pick-row manual', id: 'addManual', onclick: () => { const q = input.value.trim(); sh.close(); openManualPlace(q, (p) => onPick(p)); } },
      h('span', { class: 'title' }, "Can't find it? Add manually"));
    sh.body.append(input, status, list, manual, h('button', { style: 'margin-top:8px', onclick: sh.close }, 'Cancel'));
    paint();
    setTimeout(() => input.focus(), 50);
  }

  // ---------- manual place entry (no Google Places, no routing: a fix or pasted coordinates only) ----------
  const FIX_MSG = {
    denied: 'Location permission is off for this app. Paste the coordinates below instead.',
    timeout: "Couldn't get a location in time. Try again, or paste the coordinates below.",
    unavailable: "Couldn't get a location. Try again, or paste the coordinates below.",
  };
  const fmtLL = (lat, lng) => Number(lat).toFixed(5) + ', ' + Number(lng).toFixed(5);

  function openManualPlace(prefill, onSaved) {
    const sh = openSheet('Add place manually');
    let loc = null; // {lat, lng, accuracy|null}
    const name = h('input', { id: 'manualName', value: prefill || '', placeholder: 'Place name', autocomplete: 'off' });
    const addr = h('input', { id: 'manualAddr', placeholder: 'Optional - shown only, never looked up', autocomplete: 'off' });
    const type = h('select', { id: 'manualType', onchange: () => { salBox.hidden = type.value === 'supplier'; } }, TYPES.map((t) => h('option', { value: t, selected: t === 'other' }, Messages.typeLabel(t))));
    const sal = h('select', { id: 'manualSal' }, ['Encik', 'Puan', 'Cik'].map((t) => h('option', { value: t }, t)));
    const lang = h('select', { id: 'manualLang' }, [['default', 'Default (' + S.settings.defaultLang + ')'], ['ms', 'Bahasa Malaysia'], ['en', 'English']].map(([val, lab]) => h('option', { value: val }, lab)));
    const salBox = h('div', null, h('label', { class: 'field' }, 'Salutation'), sal, h('label', { class: 'field' }, 'Message language'), lang);
    const locStatus = h('div', { class: 'muted', id: 'manualLocStatus', role: 'status' });
    const check = h('a', { class: 'btn small', id: 'manualCheck', target: '_blank', rel: 'noopener', hidden: true }, 'Check in Google Maps');
    const nowBtn = h('button', { id: 'manualNow', type: 'button' }, 'Use where I am now');
    const paste = h('input', { id: 'manualPaste', placeholder: '3.1234, 101.5678  or a Google Maps link', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });

    function setLoc(l, msg, isError) {
      loc = l;
      locStatus.className = 'muted' + (isError ? ' error-text' : '');
      locStatus.textContent = msg || '';
      check.hidden = !l;
      if (l) check.href = Geo.mapsCheckUrl(l.lat, l.lng);
    }
    nowBtn.onclick = async () => {
      nowBtn.disabled = true; locStatus.className = 'muted'; locStatus.textContent = 'Getting your location…';
      const f = await Geo.getFix(navigator.geolocation);
      nowBtn.disabled = false;
      if (!f.ok) { setLoc(loc, FIX_MSG[f.code] || FIX_MSG.unavailable, true); return; } // the paste field stays usable
      paste.value = '';
      const acc = Math.round(f.accuracy);
      const poor = !(f.accuracy <= Geo.GOOD_ACCURACY_M);
      setLoc({ lat: f.lat, lng: f.lng, accuracy: f.accuracy }, 'Got it, accurate to about ' + acc + ' m' + (poor ? ' - that is not very accurate. Try again, or save it anyway.' : ''));
      nowBtn.textContent = poor ? 'Try again' : 'Use where I am now';
    };
    paste.addEventListener('input', () => {
      const t = paste.value.trim();
      if (!t) return;
      nowBtn.textContent = 'Use where I am now';
      const r = Geo.parseCoords(t);
      if (r.ok) setLoc({ lat: r.lat, lng: r.lng, accuracy: null }, 'Location: ' + fmtLL(r.lat, r.lng) + (r.outsideMalaysia ? ' (outside Malaysia)' : ''));
      else setLoc(null, r.error, true);
    });
    async function save() {
      if (!name.value.trim()) { toast('Name is required'); return; }
      if (!loc || !Geo.inRange(loc.lat, loc.lng)) { toast('Set the location first: use where you are now, or paste coordinates.'); return; }
      if (Geo.outsideMalaysia(loc.lat, loc.lng) && !confirm('This is outside Malaysia. Save anyway?')) return;
      const p = Geo.manualPlace({ name: name.value, address: addr.value, type: type.value, salutation: sal.value, lang: lang.value, lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy }, placeCtx());
      await savePlace(p);
      sh.close();
      toast('Saved ' + p.name);
      if (onSaved) onSaved(p);
    }
    salBox.hidden = type.value === 'supplier';
    sh.body.append(
      h('label', { class: 'field' }, 'Name'), name,
      h('label', { class: 'field' }, 'Type'), type, salBox,
      h('label', { class: 'field' }, 'Location'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, nowBtn)),
      h('label', { class: 'field' }, 'or paste coordinates / a Google Maps link'), paste,
      locStatus, h('div', { class: 'row', style: 'margin-top:6px' }, check),
      h('label', { class: 'field' }, 'Address / landmark note'), addr,
      h('div', { class: 'sticky-actions' }, h('button', { onclick: sh.close }, 'Cancel'), h('button', { class: 'primary', id: 'manualSave', onclick: save }, 'Save place')));
    setTimeout(() => { if (!name.value) name.focus(); }, 50);
  }

  // ---------- job helpers ----------
  const pName = (id) => (S.places[id] ? S.places[id].name : (S.plan && S.plan.ctx.places[id]) ? S.plan.ctx.places[id].name : '(deleted place)');
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
    if (openDayKey()) v.append(h('button', { class: 'end-day', id: 'endDayBtn', onclick: endDayTap }, 'End day'));

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
  async function getGps() { // same fix rules as everywhere (Geo.getFix: high accuracy 10 s, then low accuracy 5 s)
    if (!navigator.geolocation) throw new Error('Location is not available on this device. Pick a start place instead.');
    const f = await Geo.getFix(navigator.geolocation);
    if (!f.ok) throw new Error('Could not get your location (' + FIX_ERR[f.code] + '). Pick a start place instead.');
    return { lat: f.lat, lng: f.lng };
  }
  const FIX_ERR = { denied: 'permission denied', timeout: 'timed out', unavailable: 'no position available' };

  async function doPlan(opts) {
    if (S.busy) return;
    const replan = !!opts.replan;
    const s = S.settings;
    banner(null);
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
      const prevCtxPlaces = replan && S.plan ? S.plan.ctx.places : null; // (the fuel station lives there)
      // the run's day = local date it departed; a replan stays in its run's day (even past midnight)
      const dayKey = replan && planDayKey() ? planDayKey() : DL.dateKey(departAt.getTime());
      const fetchedAt = new Date().toISOString();
      got.matrices.forEach((x) => { if (!x.fetchedAt) x.fetchedAt = fetchedAt; });
      S.plan = { ctx: { start, end, jobs, places, departAtISO: input.departAtISO, matrices: got.matrices, dayKey }, noDetour: replan ? prevNoDetour : false, idx: 0, prompt: null, shiftMs: 0, alt: null, provider: { calls: got.calls, fromCache: got.fromCache, partial: !!got.partial } };
      solveFresh();
      if (prevPlan) {
        S.plan.result.plans = S.plan.result.plans.map((p) => compose(prevPlan, p));
        await keepFuelAfterReplan(prevPlan, prevCtxPlaces, points); // silent: the chosen station only, no Places calls
      }
      banner('Travel times: TomTom live traffic — ' + (got.fromCache ? 'from session cache (0 calls)' : got.calls + ' calls') + (got.partial ? ' · some legs missing, treated as very long' : '') + '.', 'info');
      S.loc.origin = null; S.loc.lastAt = null; S.loc.reason = null;
      retimeNow(); // the shared timing path (the lunch break included)
      logPlan(replan, { start, departAt, places, points, matrices: got.matrices, jobs: Solver.buildStops(jobs, places).jobs });
      S.tab = 'route';
      await savePlan(); // after the tab switch, so a restore reopens the Route tab
    } catch (e) {
      banner(e.message || String(e), 'error');
    } finally {
      S.busy = false;
      render();
      if (S.tab === 'route' && S.plan) refreshFromLocation();
    }
  }

  // ---------- plan state: persistence, live re-timing, re-solving from the cached matrices ----------
  // S.plan = { ctx:{start,end,jobs,places,departAtISO,matrices}, noDetour, idx, prompt, alt, provider,
  //            result:{plans:[plan,...]} }.  plan = solver plan + per-stop status ('done'|'skipped') / doneAt + plan.model.
  // Invariant: plan.model.matrices === ctx.matrices (the matrices the current problem was solved with).
  const curPlan = () => (S.plan && S.plan.result && !S.plan.result.error && S.plan.result.plans[S.plan.idx]) || null;
  const iso = (ms) => new Date(ms).toISOString();
  const STALE_MS = 30 * 60000; // travel times older than this are re-fetched at a DONE

  function lastDoneIdx(plan, skipFuel) { // stop most recently marked done; -1 = none yet (= the start point)
    let best = -1, bt = -1;
    plan.stops.forEach((s, i) => { if (s.status === 'done' && !(skipFuel && s.fuel)) { const t = Date.parse(s.doneAt) || 0; if (t >= bt) { bt = t; best = i; } } });
    return best;
  }

  // done/skipped stops stay at the top (old order); the freshly solved stops follow
  function compose(oldPlan, plan0) {
    // a stop reached (or flagged "no auto-reach", or with a navigation tap) but not done keeps that state through a re-solve;
    // so does the end point's navigation tap
    let plan = oldPlan ? Object.assign({}, plan0, { stops: Reached.keepStateOf(oldPlan.stops, plan0.stops) }) : plan0;
    if (oldPlan && oldPlan.endNavStartedAt != null) plan = Object.assign({}, plan, { endNavStartedAt: oldPlan.endNavStartedAt });
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
    opts = opts || {}; // opts.shiftMs: start the re-solve later/earlier (live-location offset)
    const P = S.plan, plan = curPlan(), m = plan.model;
    const from = lastDoneIdx(plan, true); // the fuel stop has no row in the matrices: anchor at the last real stop
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
    const at = (from >= 0 ? now : Math.max(now, Date.parse(P.ctx.departAtISO))) + (opts.shiftMs || 0);
    const respect = opts.respect != null ? opts.respect : !!m.respectClosed;
    const res = Solver.solve({ start: anchor, end: { lat: m.end.lat, lng: m.end.lng }, jobs, places: S.places, matrices, departAtISO: iso(at), noDetour: P.noDetour, respectClosedWindows: respect });
    return { res, jobs: JSON.parse(JSON.stringify(jobs)), anchor, matrices, departAtISO: iso(at), from };
  }

  function adoptResult(r) { // make a resolveRemaining() result the current plan (done stops stay on top)
    const P = S.plan, old = curPlan();
    P.result = { plans: r.res.plans.map((p) => compose(old, p)), error: null, stats: r.res.stats, stopIds: r.res.stopIds };
    P.idx = 0; P.alt = null; P.shiftMs = 0;
    P.ctx = Object.assign({}, P.ctx, { start: r.anchor, jobs: r.jobs, matrices: r.matrices, departAtISO: r.departAtISO });
    P.result.plans = P.result.plans.map((p) => carryFuel(old, p)); // the fuel stop (if any) survives a re-solve from the cache
  }

  async function reSolveFromCache() { // No-detour toggle
    const r = resolveRemaining({});
    if (r.res.error) banner(r.res.error, 'error');
    else { adoptResult(r); S.loc.origin = null; retimeNow(); banner('Re-solved from cached travel times — 0 API calls.', 'info'); await logReplanVia('no-detour'); }
    await savePlan();
    render();
  }

  // Live re-timing from the last done stop (or the start) at the current time. Order never changes.
  // The live-location origin (S.loc.origin) only applies while it was measured for the CURRENT target (the next not-done
  // stop, or the end point once every stop is done / skipped) and is at most 5 minutes old.
  const END_ID = '__end__';
  const targetId = (plan) => { const nx = plan.stops.find((s) => !s.status); return nx ? nx.placeId : END_ID; };
  function originFor(plan, at) {
    const o = S.loc.origin, now = Date.now();
    if (!o || o.placeId !== targetId(plan) || at > now || !Solver.originFresh(o, now)) return null;
    return { durationToNextSec: Math.max(0, (o.arriveMs - at) / 1000) };
  }
  // The ONE timing path: Solver.retime, then the driver's lunch break (assumed or real; LunchBreak.applyBreak), so the Route
  // ETAs, LATE, the end arrival and the WhatsApp ETA all see it.
  function timedPlan(plan, from, atIso, org) {
    return LunchBreak.applyBreak(Solver.retime(plan, from, atIso, org), curLunch(), S.settings, Date.now());
  }
  function retimeNow() { // also with nothing left to visit: the end arrival is then re-timed (from the last done stop, or the live origin)
    const P = S.plan, plan = curPlan();
    if (!plan) return false;
    const from = lastDoneIdx(plan), now = Date.now();
    const at = from < 0 ? Math.max(now, Date.parse(P.ctx.departAtISO)) : now; // before the planned departure: keep the planned times
    const org = originFor(plan, at);
    P.result.plans[P.idx] = timedPlan(plan, from, iso(at), org);
    S.timesFrom = org ? S.loc.origin.usedAt : null;
    P.alt = null; P.shiftMs = 0;
    return true;
  }

  // ---------- ETAs from the current location ----------
  // Geolocation fix under the shared rules (Geo.getFix). Without `prompt` it NEVER asks for permission (only if already
  // granted); a tap on the status line passes prompt. Returns {ok:true, lat, lng, accuracy} | {ok:false, code}.
  async function quickFix(prompt, fresh) { // fresh = no cached position (maximumAge 0)
    try {
      if (!navigator.geolocation) return { ok: false, code: 'unavailable' };
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: 'geolocation' });
        if (st.state === 'denied' || (st.state !== 'granted' && !prompt)) return { ok: false, code: 'denied' };
      } else if (!prompt) return { ok: false, code: 'denied' };
      return await Geo.getFix(navigator.geolocation, { fresh: !!fresh });
    } catch (e) { return { ok: false, code: 'unavailable' }; }
  }
  // Fix -> ONE routing request (fix -> next not-done stop, or the end point when every stop is done / skipped; live
  // traffic, depart now) -> first ETA = now + duration, later stops follow through the existing legs and dwell times.
  // No solver run, same order. Never blocks: on any failure it records WHY (S.loc.reason) for the status line.
  // opts.force = bypass the 2-minute / 300 m throttle (DONE, SKIP, status-line tap); opts.prompt = may ask for permission.
  async function refreshFromLocation(opts) {
    opts = opts || {};
    const P = S.plan, L = S.loc;
    if (!P || L.busy || !Solver.refreshDue(Date.now(), L.lastAt, opts.force)) return;
    const plan0 = curPlan();
    if (!plan0) return;
    const nx0 = plan0.stops.find((s) => !s.status), tid = targetId(plan0);
    const target = nx0 ? (S.places[nx0.placeId] || P.ctx.places[nx0.placeId]) : P.ctx.end;
    if (!target) return;
    L.busy = true; L.lastAt = Date.now();
    paintTimesLine(); // "getting location…" while the fix is fetched (e.g. location just came back on)
    const fail = async (reason) => {
      L.reason = reason;
      // denied, or a live origin older than 5 min: fall back to the last DONE (a fresher origin may still stand)
      if (L.origin && (reason === 'denied' || !Solver.originFresh(L.origin, Date.now()))) { L.origin = null; if (S.plan === P) { retimeNow(); await savePlan(); } }
      if (S.tab === 'route') render();
    };
    try {
      const fix = opts.fix || await quickFix(!!opts.prompt); // opts.fix = a position the GPS watch / the foreground fix already took
      if (S.plan !== P) return;
      if (!fix.ok) return await fail(fix.code === 'denied' ? 'denied' : 'nofix');
      if (!opts.fix) autoReachCheck(fix); // every GPS update: auto-Reached when the rules in Reached.autoReachTarget hold (takeFix did it already)
      { const c0 = curPlan(), n0 = c0 && c0.stops.find((s) => !s.status); if (n0 && n0.reachedAt != null) { L.reason = null; L.origin = null; S.timesFrom = null; return; } } // on site: no routing to where we already are
      const o = L.origin && L.origin.placeId === tid ? L.origin : null;
      const verdict = Solver.judgeFix(fix, o && { lat: o.lat, lng: o.lng }, target, { force: !!opts.force });
      if (verdict === 'ignore') return await fail('nofix');
      if (verdict === 'unmoved') { o.usedAt = Date.now(); L.reason = null; S.timesFrom = o.usedAt; if (S.tab === 'route') render(); return; }
      let dur = 0;
      if (verdict === 'route') {
        if (navigator.onLine === false) return await fail('offline');
        try {
          const legs = await Providers.routeLegs([{ lat: fix.lat, lng: fix.lng }, { lat: target.lat, lng: target.lng }], S.settings.tomtomKey);
          if (!legs[0] || legs[0].s == null) throw new Error('no duration');
          dur = legs[0].s;
        } catch (e) { return await fail(navigator.onLine === false || /network error/i.test(e.message || '') ? 'offline' : 'routing'); }
      }
      const cur = S.plan === P ? curPlan() : null;
      if (!cur || targetId(cur) !== tid) return; // the plan moved on while we waited
      const hadAlt = !!P.alt, now = Date.now();
      L.origin = { placeId: tid, lat: fix.lat, lng: fix.lng, arriveMs: now + dur * 1000, usedAt: now };
      L.reason = null;
      retimeNow();
      if (hadAlt && cur.stops.some((s) => !s.status)) computeAvoidLunch(); // the Avoid-lunch delta follows the new times
      await savePlan();
      if (S.tab === 'route') render();
    } finally { L.busy = false; paintTimesLine(); }
  }
  // Location allowed again (permission flips to granted): fetch a fix at once; the line says "getting location…" meanwhile.
  function watchLocationPermission() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return;
      navigator.permissions.query({ name: 'geolocation' }).then((st) => {
        st.addEventListener('change', () => { if (st.state === 'granted' && S.plan) refreshFromLocation({ force: true }); });
      }).catch(() => {});
    } catch (e) { /* not supported */ }
  }
  // repaint only the status line (no full render): keeps it in step with S.loc.busy / reason
  function paintTimesLine() {
    const el = document.getElementById('timesFrom'), plan = curPlan();
    if (!el || !plan) return;
    el.textContent = timesLineFor(plan);
  }
  // The status line: "On site at <name> since 14:10" while a stop is reached and not done, else where the times come from.
  function timesLineFor(plan) {
    const lb = curLunch();
    if (LunchBreak.phase(lb, S.settings, Date.now()) === 'active') return 'Lunch break until ' + fmt(LunchBreak.untilMs(lb, S.settings));
    const os = Reached.onSiteStop(plan.stops);
    if (os) return 'On site at ' + dName(((S.places[os.placeId] || (S.plan && S.plan.ctx.places[os.placeId])) || {}).name || '') + ' since ' + fmt(os.reachedAt);
    const di = lastDoneIdx(plan);
    return Solver.timesLine({ liveAt: S.timesFrom, lastDoneAt: di >= 0 ? Date.parse(plan.stops[di].doneAt) : null, reason: S.loc.reason, busy: S.loc.busy });
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
    const P = S.plan, cur = stripFuel(curPlan()); // compare like with like: the alternative is solved without the fuel stop
    const from0 = lastDoneIdx(cur), at0 = from0 >= 0 ? Date.now() : Math.max(Date.now(), Date.parse(P.ctx.departAtISO));
    const org = originFor(cur, at0);
    const base = timedPlan(cur, from0, iso(at0), org); // current plan, timed from the same place and moment (live origin included)
    let shiftMs = 0;
    if (org) { // the alternative is solved from the last done stop: shift it by what the live fix changed for the next stop
      const b0 = timedPlan(cur, from0, iso(at0)), n0 = b0.stops.find((s) => !s.status), n1 = base.stops.find((s) => !s.status);
      if (n0 && n1) shiftMs = n1.arriveAt - n0.arriveAt;
    }
    const r = resolveRemaining({ respect: true, shiftMs });
    const alt = r.res.plans && r.res.plans[0] && LunchBreak.applyBreak(r.res.plans[0], curLunch(), S.settings, Date.now()); // the same lunch break as the current plan
    if (r.res.error || !alt) { P.alt = { ok: false, message: 'No feasible alternative: ' + (r.res.error || 'nothing left to re-plan') + '.' }; return; }
    if (alt.violations.length) { P.alt = { ok: false, message: 'No feasible alternative: avoiding the closed windows would break a time window (' + alt.violations[0] + ').' }; return; }
    P.alt = { ok: true, r, plan: alt, deltaMs: alt.endArrival - base.endArrival, baseEnd: base.endArrival };
  }
  async function useAlt() {
    adoptResult(S.plan.alt.r);
    S.loc.origin = null;
    retimeNow();
    await logReplanVia('avoid-lunch');
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
    if (snap.savedAt && DayLog.dateKey(Date.parse(snap.savedAt)) !== DayLog.dateKey(Date.now())) { // a plan carried over to another day starts fresh
      snap.plan.stops = snap.plan.stops.map((s) => (s.status ? s : Reached.carryForward(s)));
      delete snap.plan.endNavStartedAt; // the end point's navigation tap belongs to that day too
    }
    S.plan = {
      ctx: snap.ctx, noDetour: !!snap.noDetour, idx: 0, prompt: null, shiftMs: 0, alt: null, provider: snap.provider || null,
      result: { plans: [snap.plan], error: null, stats: null, stopIds: snap.plan.model.stopIds },
    };
    if (['plan', 'route', 'places', 'settings'].includes(snap.tab)) S.tab = snap.tab;
  }
  async function clearPlan() {
    S.plan = null; S.loc.origin = null; S.loc.reason = null; S.timesFrom = null;
    await WPStore.remove('plan', 'current');
    banner(null);
    render();
  }

  // ---------- DAY LOG: record events, undo, close (model + maths live in daylog.js) ----------
  const DL = DayLog;
  const saveDay = (d) => { // activity merged into a closed record: its stored totals are recomputed
    if (d.closed) { try { DL.refreshTotals(d, S.jobs, S.places); } catch (e) { /* totals are a cache */ } }
    return WPStore.set('daylogs', d.date, d);
  };
  const bgSaveDay = (d) => { saveDay(d).catch(() => {}); };

  async function loadDays() {
    try { await DL.runRepairOnce(WPStore, S.jobs, S.places, new Date().toISOString()); } catch (e) { /* repair retries next launch */ }
    S.days = {};
    (await WPStore.list('daylogs')).forEach((d) => { if (d && d.date && Array.isArray(d.events)) S.days[d.date] = d; });
    for (const k of DL.pruneDates(Object.keys(S.days), DL.dateKey(Date.now()))) { delete S.days[k]; await WPStore.remove('daylogs', k); } // keep 120 days
  }
  // The local date of the current plan run (the date it departed; a replan keeps its run's date).
  const planDayKey = () => (S.plan && S.plan.ctx ? (S.plan.ctx.dayKey || DL.dateKey(Date.parse(S.plan.ctx.departAtISO))) : null);
  // The record activity at nowMs belongs to: the current run's date (even past midnight), else that moment's local date.
  // A closed record is NOT reopened: the activity is merged into it. create=false never makes a record.
  function dayFor(nowMs, create) {
    const key = DL.activityKey(nowMs, planDayKey());
    if (S.days[key] || !create) return S.days[key] || null;
    return DL.recordFor(S.days, key, S.settings.driverName || 'Calvin');
  }
  const openDayKey = () => DL.openDayKey(S.days, planDayKey());
  function endDayTap() { // End day closes the open day whenever it is tapped; with nothing open it saves nothing
    const k = openDayKey();
    if (k) openSummary(k); else toast('Nothing to close — no open day with activity.');
  }
  async function reopenDay(day) { // undo of "Close day": carried / dropped jobs go back exactly as they were
    const changed = DL.reopenDay(day, S.jobs, new Date().toISOString());
    for (const j of changed) await saveJob(j);
    await saveDay(day);
  }

  async function logReplanVia(via) { // "No detour" / "Avoid lunch" re-solves count as replans in the day log
    try {
      const d = dayFor(Date.now(), false);
      if (!d) return;
      DL.recordReplan(d, { nowIso: new Date().toISOString(), via });
      bgSaveDay(d);
    } catch (e) { /* never break planning */ }
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

  const coordPlace = (id) => S.places[id] || (S.plan && S.plan.ctx.places[id]) || null;
  function coordOf(id, day) { const p = S.places[id] || (S.plan && S.plan.ctx.places[id]) || day.places[id]; return p ? { lat: p.lat, lng: p.lng } : null; }
  function logDone(stop, nowIso) {
    try {
      const nowMs = Date.parse(nowIso), day = dayFor(nowMs, true);
      const groups = DL.doneGroups(day), lastG = groups[groups.length - 1];
      const coord = (id) => coordOf(id, day);
      const prev = lastG ? coord(lastG.stopId) : (day.planSnapshot && day.planSnapshot.start);
      const to = coord(stop.placeId), plan = curPlan();
      const dsec = plan && plan.model && plan.model.dwellSec ? plan.model.dwellSec[stop.placeId] : null; // planned dwell, for the on-site split
      const rch = { reachedAt: stop.reachedAt != null ? stop.reachedAt : null, reachedSource: stop.reachedSource || null, navStartedAt: stop.navStartedAt != null ? stop.navStartedAt : null,
        dwellMin: dsec != null ? dsec / 60 : ((coordPlace(stop.placeId) || {}).dwellMin != null ? coordPlace(stop.placeId).dwellMin : null) };
      const evs = stop.fuel // the fuel stop is logged as a stop (kind 'fuel'), never as a job action
        ? [DL.recordFuel(day, Object.assign({ nowIso, stopId: stop.placeId, name: (coordPlace(stop.placeId) || {}).name || '', places: Object.assign({}, S.plan && S.plan.ctx.places, S.places) }, rch))]
        : DL.recordDone(day, Object.assign({ nowIso, stopId: stop.placeId, actions: stop.actions, places: S.places }, rch));
      if (plan && prev && to) { // keep the leg just driven if the plan's own routing matrices cover that exact pair
        const m = plan.model;
        const pts = [m.start].concat(m.stopIds.map(coord), [m.end]);
        if (pts.every(Boolean)) DL.captureLeg(day, prev, to, m.matrices, pts, nowMs);
      }
      bgSaveDay(day);
      attachFix(evs, day);
    } catch (e) { /* never break DONE */ }
  }
  // Geolocation fix for a DONE / ARRIVED: only if the permission is ALREADY granted (never prompts), shared fix rules,
  // fire-and-forget (never blocks the tap).
  function attachFix(evs, day) {
    quickFix(false).then((f) => {
      if (!f.ok) return;
      evs.forEach((e) => { e.lat = f.lat; e.lng = f.lng; e.accuracy = f.accuracy; });
      bgSaveDay(day);
    }).catch(() => {});
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
    cur.stops[li] = Reached.undoDone(stop); // pending again; reachedAt / reachedSource stay (the stop is back to "reached")
    S.loc.origin = null;
    P.prompt = null;
    retimeNow();
    banner(null);
    await savePlan();
    render();
    refreshFromLocation({ force: true });
  }

  // ARRIVED at the end point: a day-log event (+ a never-blocking fix), the final leg for the summary, the Day complete
  // banner. It does NOT close the day (Close day stays its own tap) and works with stops still undone / skipped.
  async function markArrivedEnd() {
    const P = S.plan;
    if (!P) return;
    const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString(), end = P.ctx.end;
    const day = dayFor(nowMs, true);
    if (DL.arrivedEnd(day)) return;
    const cp = curPlan();
    const ev = DL.recordArrivedEnd(day, { nowIso, endPoint: { lat: end.lat, lng: end.lng, name: end.name || '' }, navStartedAt: cp && cp.endNavStartedAt != null ? cp.endNavStartedAt : null });
    try { // keep the final leg if the plan's own routing matrices cover that exact pair (else the summary routes it once)
      const plan = curPlan(), groups = DL.doneGroups(day), lastG = groups[groups.length - 1];
      const prev = lastG ? coordOf(lastG.stopId, day) : (day.planSnapshot && day.planSnapshot.start);
      if (plan && prev) {
        const m = plan.model, pts = [m.start].concat(m.stopIds.map((id) => coordOf(id, day)), [m.end]);
        if (pts.every(Boolean)) DL.captureLeg(day, prev, { lat: end.lat, lng: end.lng }, m.matrices, pts, nowMs);
      }
    } catch (e) { /* the summary falls back to one routing request */ }
    bgSaveDay(day);
    attachFix([ev], day);
    banner('Day complete - view summary', 'info', () => openSummary(day.date));
    render();
  }
  async function undoArrivedEnd() {
    const day = dayFor(Date.now(), false);
    if (!day || !DL.arrivedEnd(day)) return;
    if (day.closed) await reopenDay(day);
    DL.recordUndoArrivedEnd(day, { nowIso: new Date().toISOString() });
    bgSaveDay(day);
    banner(null);
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
      // ONE driving figure: a day with time-split data shows the four buckets of its timeline (the older estimate is not shown);
      // a day without it keeps the old "Drive (est.) vs at stops/other" bar.
      const sp = Reached.splitOfSummary(s, Date.now());
      let splitTile;
      if (sp && sp.v === 2) {
        const t = sp.totals;
        const buckets = [['Driving', t.driveMin, 'b-drive'], ['On site', t.onSiteMin, 'b-site'], ['Between stops', t.betweenMin, 'b-between'], ['Lunch', t.lunchMin, 'b-lunch']];
        splitTile = h('div', { class: 'tile split', id: 'sumSplitTile' }, h('div', { class: 'tl' }, 'Time split'),
          h('div', { class: 'split-bar four', 'aria-hidden': 'true' }, buckets.filter((b) => b[1] > 0.0001).map((b) => h('span', { class: b[2], style: 'flex:' + b[1] }))),
          h('div', { class: 'split-legend' }, buckets.map((b) => h('span', { class: 'lg' }, h('i', { class: 'sw ' + b[2] }), b[0] + ' ' + DL.fmtDur(b[1])))));
      } else {
        const bar = total && drv != null ? h('div', { class: 'split-bar', 'aria-hidden': 'true' },
          h('span', { class: 'drive', style: 'flex:' + Math.max(drv, 0.01) }), h('span', { class: 'stops', style: 'flex:' + Math.max(total - drv, 0.01) })) : null;
        splitTile = h('div', { class: 'tile split' }, h('div', { class: 'tl' }, 'Drive (est.) vs at stops/other'),
          h('div', { class: 'tv2' }, h('span', { class: 'dv' }, DL.fmtDur(s.driveMin) + ' est.'), h('span', { class: 'sv' }, DL.fmtDur(s.atStopsMin))), bar);
      }
      const tiles = h('div', { class: 'tiles' },
        tile('Jobs done', s.jobsDone + ' of ' + s.jobsTotal, 'jobs'),
        tile('Stops visited', String(s.stopsVisited), 'stops'),
        kmTile,
        tile('Hours out', DL.fmtDur(s.hoursOutMin), 'hours'),
        splitTile);
      const replansLine = s.plan.replans > 0 ? h('div', { class: 'muted sum-replans', id: 'sumReplans' }, 'Replans: ' + s.plan.replans) : null;
      const timeRow = h('div', { class: 'row time-edit' },
        h('button', { class: 'small grow', disabled: ro(), onclick: () => editTime('startedAt', s.startedAt) }, 'Started ' + (s.startedAt != null ? hm(s.startedAt) : '—') + (ro() ? '' : ' ✎')),
        h('button', { class: 'small grow', disabled: ro(), onclick: () => editTime('finishedAt', s.finishedAt) }, 'Finished ' + (s.finishedAt != null ? hm(s.finishedAt) : '—') + (ro() ? '' : ' ✎')));

      // driving vs on site: only for days where a stop has a Reached time (days closed before this feature show nothing, nothing is backfilled)
      // days recorded with the navigation-tap timing (v2): driving / on site / between stops (+ lunch), per stop
      // "left prev · nav · arr · done"; days closed before it keep the old driving-vs-on-site card (v1)
      // each stop is a block: its name on its own full-width line (normal wrapping), its times on the line below
      const tsStop = (name, times) => h('div', { class: 'ts-stop' }, h('div', { class: 'ts-name' }, name), h('div', { class: 'ts-times' }, times));
      const ae = DL.arrivedEnd(day), endName = (ae && ae.endPoint && ae.endPoint.name) || 'End';
      const endLine = sp && sp.v === 2 && sp.totals.end ? tsStop(dName(endName), Reached.stopLine(sp.totals.end, 2, hm)) : null;
      const splitCard = sp ? h('div', { class: 'card sum-sec split', id: 'sumSplit' }, h('div', { class: 'eyebrow' }, sp.v === 2 ? 'Time split' : 'Driving vs on site'),
        h('div', { class: 'sum-split', id: 'sumSplitLine' }, Reached.splitLine(sp, DL.fmtDur)),
        sp.stops.filter((x) => !(x.skipped && x.arrivalMs == null)).map((x) => tsStop(x.name, Reached.stopLine(x, sp.v, hm))), endLine) : null;

      const urgentChip = h('span', { class: 'chip urgent' }, 'URGENT'), lateChip = h('span', { class: 'chip late' }, 'LATE');
      const collected = sec('Collected', 'collect', s.collected.map((c) => line(h('span', null, c.item || '(item)', ' - ', c.place), hm(c.t))), 'Nothing collected');
      const delivered = sec('Delivered', 'deliver', s.delivered.map((d) => line(h('span', null, d.item || '(item)', ' - ', d.place), hm(d.t),
        [d.urgent ? urgentChip.cloneNode(true) : null, d.late ? lateChip.cloneNode(true) : null].filter(Boolean))), 'Nothing delivered');
      const errands = sec('Errands done', 'errand', s.errands.map((e) => line(h('span', null, e.item, ' - ', e.place), hm(e.t))), 'No errands');
      const fuelLine = s.fuel ? h('div', { class: 'card sum-sec fuel', id: 'sumFuel' }, line('Fuel: ' + s.fuel.place + ' ' + hm(s.fuel.t))) : null;
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

      // (the stored plan-vs-actual data stays in the day log; the section itself is no longer shown)
      const copyBtn = h('button', { class: 'grow', onclick: async () => {
        const cs = sum(), csp = Reached.splitOfSummary(cs, Date.now());
        toast((await copyText(DL.toWhatsApp(cs, csp && csp.v === 2 ? Reached.splitLine(csp, DL.fmtDur) : null))) ? 'Summary copied — paste into WhatsApp' : 'Could not copy');
      } }, 'Copy summary');
      const csvBtn = h('button', { class: 'grow', onclick: () => downloadCsv(sum()) }, 'Download CSV');
      const main = ro() ? null : day.closed
        ? h('button', { class: 'big grow', id: 'reopenDay', onclick: async () => { await reopenDay(day); render(); draw(); toast('Day reopened'); } }, 'Reopen day')
        : h('button', { class: 'primary big grow', id: 'closeDay', onclick: async () => {
          const res = DL.endDay(S.days, { key: day.date, jobs: S.jobs, places: S.places, nowIso: new Date().toISOString() });
          if (!res.key) { toast('Nothing to close — no activity on this day. Nothing saved.'); sh.close(); return; }
          const changed = res.changed;
          for (const j of changed) await saveJob(j);
          await saveDay(day); banner(null); render(); draw();
          toast('Day closed' + (day.carried.length ? ' · ' + day.carried.filter((c) => c.mode !== 'dropped').length + ' job(s) carried' : ''));
        } }, 'Close day');
      // replaceChildren() turns a null into the text "null": only real nodes go in
      sh.body.replaceChildren(...[
        h('div', { class: 'muted sum-sub' }, day.driverId + ' · ' + (day.closed ? 'closed ' + (day.endedAt ? DL.fmtDate(DL.dateKey(Date.parse(day.endedAt))) + ' ' + hm(Date.parse(day.endedAt)) : '') : 'open') + (ro() ? ' · read-only' : '')),
        tiles, timeRow, replansLine, splitCard, collected, delivered, errands, fuelLine, withYou, notDone,
        h('div', { class: 'sum-actions' }, h('div', { class: 'row' }, copyBtn, csvBtn), h('div', { class: 'row' }, main, h('button', { onclick: sh.close }, 'Back')))].filter(Boolean));
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
    const now = Date.now();
    // everything below follows the CURRENT re-timed plan (never the first snapshot); nothing may show a time in the past
    const view = Solver.liveView(plan, now);
    const remaining = view.stops.filter((s) => !s.status);
    const day = dayFor(now, false), arrEv = day ? DL.arrivedEnd(day) : null;
    const departMs = day && day.startedAt ? Date.parse(day.startedAt) : Date.parse(ctx.departAtISO);

    // which anchor the times come from (and why not the phone's location); a tap retries at once, bypassing the throttle
    v.append(h('button', { class: 'times-from', id: 'timesFrom', type: 'button', onclick: () => { if (S.loc.busy) toast('Checking your location…'); else refreshFromLocation({ force: true, prompt: true }); } },
      timesLineFor(plan)));
    v.append(
      h('div', { class: 'card' },
        h('div', { class: 'totals', id: 'routeTotals' },
          h('div', null, h('b', { id: 'stopsLeft' }, view.left), h('span', { class: 'muted' }, 'stops left')),
          h('div', null, h('b', { id: 'minLeft' }, Solver.formatDuration(view.leftSec)), h('span', { class: 'muted' }, 'left')),
          h('div', null, h('b', { id: 'endArrive' }, fmt(view.endArrival)), h('span', { class: 'muted' }, 'arrive ' + (ctx.end.name || 'end')))),
        h('div', { class: 'muted', id: 'departedAt', style: 'margin-top:8px' }, (departMs > now ? 'Departs ' : 'Departed ') + fmt(departMs)),
        P.shiftMs > 60000 ? h('div', { class: 'chip detour' }, 'Running ' + Math.round(P.shiftMs / 60000) + ' min behind plan') : null,
        lunchSkippedLine()),
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
    const fuelNow = plan.stops.find((s) => s.fuel);
    if (!(fuelNow && fuelNow.status === 'done')) { // one fuel stop per plan; once it is done there is nothing to add or change
      navRow.append(h('button', { class: 'grow', id: 'fuelBtn', onclick: () => fuelTap() }, fuelNow ? 'Change fuel stop' : 'Add fuel stop'));
    }
    // a CLOSED stop still ahead: offer the closed-windows-respected alternative (re-solved from the cached matrices)
    if (!P.alt && remaining.some((s) => s.closedWarning)) navRow.append(h('button', { class: 'grow', id: 'avoidLunch', onclick: () => { computeAvoidLunch(); render(); } }, 'Avoid lunch'));
    v.append(navRow);
    if (P.alt) v.append(altCard(P));

    if (view.left > 0 && plan.stops.some((s) => s.status === 'skipped' && !s.fuel)) v.append(h('div', { class: 'prompt' }, 'A stop was skipped. ', h('button', { class: 'small', onclick: () => replanFromHere() }, 'Replan from here')));
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
    const lbar = lunchBar(plan);
    if (lbar) v.append(lbar); // above the stop list, never over a card
    const tl = h('div', { class: 'timeline' });
    const lm = lunchMarker(plan), lmBefore = plan.lunch ? plan.lunch.beforePlaceId : null;
    view.stops.forEach((stop, i) => { if (lm && lmBefore != null && !stop.status && stop.placeId === lmBefore) tl.append(lm); tl.append(stopCard(stop, i)); });
    if (lm && lmBefore == null) tl.append(lm); // the break is after the last stop (before the end point)
    v.append(tl);
    v.append(endCard(view.endArrival, arrEv));
    v.append(h('button', { class: 'end-day', id: 'routeEndDay', onclick: endDayTap }, 'End day'));
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

  // WAZE / MAPS per the Settings choice (same on stop cards and the end card). onTap = stamps the stop's navStartedAt
  // (the whole-route "Open in Google Maps" button has none: it never starts a stop's travel time).
  function navButtons(place, onTap) {
    const nav = S.settings.nav || 'waze', btns = [];
    if (nav === 'waze' || nav === 'both') btns.push(h('a', { class: 'btn small nav-btn', href: wazeUrl(place), target: '_blank', rel: 'noopener', onclick: onTap || null }, 'WAZE'));
    if (nav === 'google' || nav === 'both') btns.push(h('a', { class: 'btn small nav-btn', href: gmapsUrl(S.plan.ctx.start, place, []).replace(/origin=[^&]*&/, ''), target: '_blank', rel: 'noopener', onclick: onTap || null }, 'MAPS'));
    return btns;
  }
  // The previous departure for travel timing: the last done stop's done time, else the day's start / the plan's departure.
  function prevDepartureMs(plan) {
    const di = lastDoneIdx(plan);
    if (di >= 0) return Date.parse(plan.stops[di].doneAt);
    const day = dayFor(Date.now(), false);
    return day && day.startedAt ? Date.parse(day.startedAt) : Date.parse(S.plan.ctx.departAtISO);
  }
  // A tap on a stop's own WAZE / MAPS: the FIRST one after the previous departure is that stop's navStartedAt (the link
  // still opens). Later taps, and taps on a reached / done / skipped stop, change nothing (Reached.stampNav).
  // Every tap is also a day-log event (type nav) - the day's timeline (Reached.dayTimeline) decides what it means.
  function logNav(stopId, nowMs, isEnd) {
    try {
      const day = dayFor(nowMs, false);
      if (!day) return;
      DL.recordNav(day, { nowIso: new Date(nowMs).toISOString(), at: nowMs, stopId, end: isEnd });
      bgSaveDay(day);
    } catch (e) { /* never block the navigation link */ }
  }
  function navTap(stop0, i0) {
    try {
      const ls = liveStop(stop0, i0);
      if (!ls) return;
      const nowMs = Date.now();
      if (!ls.stop.status) logNav(ls.stop.placeId, nowMs, false);
      const cur = curPlan(), next = Reached.stampNav(ls.stop, nowMs, prevDepartureMs(cur));
      if (next === ls.stop) return;
      ls.stop.navStartedAt = next.navStartedAt;
      savePlan();
    } catch (e) { /* never block the navigation link */ }
  }
  function navTapEnd() {
    try {
      const cur = curPlan(), day = dayFor(Date.now(), false);
      if (!cur || (day && DL.arrivedEnd(day))) return; // after ARRIVED: ignored
      const nowMs = Date.now();
      logNav(null, nowMs, true);
      const next = Reached.stampNav({ navStartedAt: cur.endNavStartedAt }, nowMs, prevDepartureMs(cur));
      if (next.navStartedAt === cur.endNavStartedAt) return;
      cur.endNavStartedAt = next.navStartedAt;
      savePlan();
    } catch (e) { /* never block the navigation link */ }
  }

  // The end point is a real card: re-timed arrival, WAZE and ARRIVED (arrived = a day-log event + "arrived HH:MM" with Undo)
  function endCard(endArrival, arrEv) {
    const end = S.plan.ctx.end;
    const arrivedMs = arrEv ? Date.parse(arrEv.t) : null;
    const btns = navButtons(end, () => navTapEnd());
    btns.push(arrEv
      ? h('button', { class: 'small undo', id: 'undoArrived', 'aria-label': 'Undo arrived', onclick: () => undoArrivedEnd() }, 'Undo')
      : h('button', { class: 'small ok', id: 'arrivedBtn', onclick: () => markArrivedEnd() }, 'ARRIVED'));
    return h('div', { class: 'card stop endcard' + (arrEv ? ' arrived' : ''), id: 'endCard' },
      h('div', { class: 'stop-head' },
        h('span', { class: 'nm' }, dName(end.name || 'End')),
        h('span', { class: 'times', id: 'endCardTime' }, arrEv ? 'arrived ' + fmt(arrivedMs) : fmt(endArrival))),
      h('div', { class: 'muted end-label' }, 'End of route'),
      h('div', { class: 'stop-btns' }, btns));
  }

  function stopCard(stop, i) {
    const P = S.plan;
    const place = S.places[stop.placeId] || P.ctx.places[stop.placeId];
    const st = stop.status;
    const tag = stop.fuel ? 'Fuel · ' : '';
    if (st === 'skipped') { // greyed, no ETA (it is out of the re-time chain), Undo skip puts it back
      return h('div', { class: 'card stop skipped compact' }, h('div', { class: 'row spread' },
        h('div', { class: 'title' }, (i + 1) + '. ' + tag + dName(place.name)),
        h('span', { class: 'chip' }, 'Skipped'),
        h('button', { class: 'small undo', 'aria-label': 'Undo skip', onclick: () => undoSkip(stop, i) }, 'Undo skip')));
    }
    if (st === 'done') { // done stops collapse to one line: tick, name, actual done time
      const undoable = i === lastDoneIdx(curPlan());
      return h('div', { class: 'card stop done compact' }, h('div', { class: 'row spread' },
        h('div', { class: 'title' }, '✓ ' + (i + 1) + '. ' + tag + dName(place.name)),
        h('div', { class: 'muted times' }, 'done ' + fmt(Date.parse(stop.doneAt))),
        undoable ? h('button', { class: 'small undo', 'aria-label': 'Undo done', onclick: () => undoDone(stop, i) }, 'Undo') : null));
    }
    if (stop.fuel) return fuelCard(stop, i, place);
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
    if (stop.late) pills.push(h('span', { class: 'pill closed' }, 'LATE'));
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
    const btns = navButtons(place, () => navTap(stop, i));
    if (hasDelivery) btns.push(h('button', { class: 'small', onclick: () => { const m = stopMessage(stop, P.shiftMs); shareMessage(m.place, m.text); } }, 'MSG'));
    btns.push(primaryBtn(stop, i)); // REACHED, then DONE: one button, the place and size DONE always had
    btns.push(h('button', { class: 'small', onclick: () => skipStop(stop, i) }, 'SKIP'));
    const rin = reachedInline(stop, i); // "Reached 14:10 · auto  Undo" at the end of the card's action lines (no extra row)
    return h('div', { class: 'card stop ' + (st || '') + (stop.detour ? ' detour' : '') + (rin ? ' reached' : '') },
      head, more,
      lines.length || rin ? h('div', { class: 'stop-acts' }, lines, rin ? h('div', { class: 'muted reached-line' }, rin) : null) : null,
      h('div', { class: 'stop-btns' }, btns));
  }

  // ---------- REACHED before DONE ----------
  const primaryBtn = (stop, i) => h('button', { class: 'small ok', 'data-act': Reached.isReached(stop) ? 'done' : 'reached', onclick: () => primaryTap(stop, i) }, Reached.buttonLabel(stop));
  function reachedInline(stop, i) { // text + a small Undo, or null while the stop is not reached
    return Reached.isReached(stop)
      ? [Reached.reachedText(stop, fmt), ' ', h('button', { class: 'link-undo', type: 'button', 'aria-label': 'Undo reached', onclick: () => undoReachedTap(stop, i) }, 'Undo')]
      : null;
  }
  const placeOfStop = (s) => S.places[s.placeId] || (S.plan && S.plan.ctx.places[s.placeId]) || null;

  async function afterReachChange() { // shared tail of Reached / Undo reached: re-time (on site = departure from reached + dwell), repaint, save
    S.loc.origin = null;
    retimeNow();
    if (S.tab === 'route') render();
    await savePlan();
  }
  function reachStop(stop, source) { // stamps the live stop; false when it cannot be reached (done, skipped, already reached)
    if (!stop || stop.status || Reached.isReached(stop)) return false;
    Object.assign(stop, Reached.stampReached(stop, Date.now(), source));
    return true;
  }
  async function markReached(stop0, i0) { // REACHED: nothing but the stamp, the re-time and the repaint (no message, no day-log entry)
    const ls = liveStop(stop0, i0);
    if (!ls || !reachStop(ls.stop, 'tap')) return;
    await afterReachChange();
  }
  async function undoReachedTap(stop0, i0) { // back to REACHED; this stop is never auto-reached again in this plan
    const ls = liveStop(stop0, i0);
    if (!ls || ls.stop.status || !Reached.isReached(ls.stop)) return;
    Object.assign(ls.stop, Reached.undoReached(ls.stop));
    await afterReachChange();
    refreshFromLocation({ force: true });
  }
  // The one primary button: REACHED first, then DONE. For 500 ms after the stop became reached it ignores taps.
  function primaryTap(stop0, i0) {
    const ls = liveStop(stop0, i0);
    if (!ls) return;
    if (!Reached.isReached(ls.stop)) return markReached(stop0, i0);
    if (Reached.tapIgnored(ls.stop, Date.now())) return;
    return markDone(stop0, i0);
  }
  function toastUndo(msg, fn) {
    const t = document.getElementById('toast');
    t.replaceChildren(msg + ' · ', h('button', { class: 'toast-undo', type: 'button', onclick: () => { t.hidden = true; fn(); } }, 'Undo'));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
  }
  // Auto-reach (setting on, app open): called with every fresh GPS fix. Reached.autoReachTarget holds the rules.
  function autoReachCheck(fix) {
    try {
      const P = S.plan, plan = curPlan();
      if (!P || !plan || !fix || !fix.ok) return false;
      const stops = plan.stops.map((s) => { const pl = placeOfStop(s); return pl ? { id: s.placeId, lat: pl.lat, lng: pl.lng, status: s.status, reachedAt: s.reachedAt, noAutoReach: s.noAutoReach } : null; }).filter(Boolean);
      if (P.ctx.end) stops.push({ id: END_ID, lat: P.ctx.end.lat, lng: P.ctx.end.lng, isEnd: true });
      const id = Reached.autoReachTarget(fix, stops, { enabled: S.settings.autoReach !== false, visible: document.visibilityState === 'visible', now: Date.now() });
      if (!id) return false;
      const idx = plan.stops.findIndex((s) => s.placeId === id && !s.status), live = plan.stops[idx];
      if (!reachStop(live, 'auto')) return false;
      afterReachChange();
      toastUndo('Reached ' + dName((placeOfStop(live) || {}).name || '') + ' ' + fmt(live.reachedAt) + ' (auto)', () => undoReachedTap(live, idx));
      return true;
    } catch (e) { return false; }
  }
  // ---------- GPS WATCH: auto-reach while the app stays open ----------
  // Before this, positions came only from one-off getCurrentPosition calls (Route tab opened, launch, back in the foreground,
  // DONE / SKIP / Undo, status-line tap; at most one per 2 min) and the minute tick only repainted, so with the app left
  // open no new fix arrived and auto-reach never re-ran. Now ONE navigator.geolocation.watchPosition runs while the page is
  // visible, a stop is pending and the day is open (Reached.shouldWatch), and is cleared otherwise: never in the background,
  // never two. It starts only when the location permission is already granted (it never prompts). Every position takes
  // the same path as any fix (takeFix): stored with its time, auto-reach evaluated at once, the route re-timed at most
  // once per 30 s (an auto-reach re-times at once). Errors never toast: denied / unavailable stop it until the next
  // visibility change; a timeout leaves it running (the platform keeps trying).
  const W = { id: null, starting: false, blocked: false, lastRetimeAt: null };
  function watchWanted() {
    const day = S.plan ? S.days[planDayKey()] : null;
    return Reached.shouldWatch({ visible: document.visibilityState === 'visible', hasPendingStop: hasPendingStop(curPlan()), dayClosed: !!(day && day.closed) });
  }
  function stopWatch() {
    if (W.id == null) return;
    try { navigator.geolocation.clearWatch(W.id); } catch (e) { /* ignore */ }
    W.id = null;
  }
  async function syncWatch() {
    try {
      const geo = navigator.geolocation;
      if (!watchWanted()) { stopWatch(); return; }
      if (W.id != null || W.starting || W.blocked || !geo || typeof geo.watchPosition !== 'function') return;
      W.starting = true;
      let granted = false;
      try { granted = !!(navigator.permissions && navigator.permissions.query) && (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch (e) { granted = false; }
      W.starting = false;
      if (!granted || W.id != null || !watchWanted()) return;
      W.id = geo.watchPosition(onWatchPosition, onWatchError, Reached.WATCH_OPTS);
    } catch (e) { W.starting = false; }
  }
  function onWatchPosition(p) {
    try {
      if (W.id == null || !watchWanted() || !p || !p.coords) return; // a late callback after clearWatch
      takeFix({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp != null ? p.timestamp : Date.now() }, 'watch');
    } catch (e) { /* never break the page */ }
  }
  function onWatchError(e) {
    const code = e && e.code;
    if (code === 3) return; // TIMEOUT: the watch keeps trying by itself
    stopWatch(); W.blocked = true; // denied / unavailable: retried on the next visibility change
    const reason = code === 1 ? 'denied' : 'nofix';
    if (S.loc.reason !== reason) { S.loc.reason = reason; paintTimesLine(); } // the status line says why, as before (no toast)
  }
  // One fix (watch update, or the fresh foreground fix): store it, auto-reach, then re-time (throttled for the watch).
  function takeFix(fix, src) {
    S.loc.lastFix = fix;
    const now = Date.now();
    if (autoReachCheck(fix)) { W.lastRetimeAt = now; return; } // auto-reach re-times at once (afterReachChange)
    if (src === 'watch') {
      if (!Reached.retimeDue(W.lastRetimeAt, now)) return;
      W.lastRetimeAt = now;
      if (S.plan && retimeNow()) { savePlan(); if (S.tab === 'route' && !document.querySelector('.backdrop')) render(); }
    }
    refreshFromLocation({ fix }); // the usual live-origin path (its own 2-min / 300 m throttle on routing requests)
  }
  // Back in the foreground: one immediate FRESH fix (no cached position); auto-reach is evaluated when it arrives.
  async function freshFixNow() {
    const P = S.plan;
    if (!P) return;
    const fix = await quickFix(false, true);
    if (S.plan !== P) return;
    if (fix.ok) takeFix(fix, 'visible'); else refreshFromLocation({ fix });
  }

  // ---------- LUNCH BREAK (the driver's; the rules live in lunchbreak.js) ----------
  // Today's state {date, startedAt, endedAt, skipped} survives reloads (meta:lunchBreak). The day log gets the REAL break
  // only (breakStartedAt / breakEndedAt on the day record); an assumed break that never started is not logged.
  function lunchDayKey() { return planDayKey() || DL.dateKey(Date.now()); }
  function curLunch() {
    const k = lunchDayKey();
    if (!S.lunch || S.lunch.date !== k) S.lunch = LunchBreak.forDay(S.lunch, k);
    return S.lunch;
  }
  const saveLunch = () => WPStore.set('meta', 'lunchBreak', S.lunch).catch(() => {});
  const hasPendingStop = (plan) => !!(plan && plan.stops.some((s) => !s.status));
  async function lunchChanged() { // re-time from now with the new break state, repaint, save
    retimeNow(); // a live origin stays valid: the break only moves the departure
    await saveLunch();
    await savePlan();
    if (S.tab === 'route') render();
  }
  async function lunchStart() {
    const st = curLunch(), now = Date.now();
    if (LunchBreak.phase(st, S.settings, now) !== 'assumed') return;
    S.lunch = LunchBreak.start(st, now);
    try { const d = dayFor(now, true); DL.recordBreakStart(d, { nowIso: iso(now) }); bgSaveDay(d); } catch (e) { /* never break the bar */ }
    await lunchChanged();
  }
  async function lunchEnd(auto) { // End break (or the length elapsed: auto)
    const st = curLunch(), now = Date.now();
    if (st.startedAt == null || st.endedAt != null) return;
    S.lunch = auto ? LunchBreak.autoEnd(st, S.settings, now) : LunchBreak.end(st, S.settings, now);
    if (S.lunch.endedAt == null) return;
    try { const d = dayFor(st.startedAt, false) || dayFor(now, true); DL.recordBreakEnd(d, { nowIso: iso(S.lunch.endedAt) }); bgSaveDay(d); } catch (e) { /* ignore */ }
    await lunchChanged();
  }
  async function lunchSkip() { S.lunch = LunchBreak.skip(curLunch()); await lunchChanged(); }
  async function lunchUndoSkip() { S.lunch = LunchBreak.unskip(curLunch()); await lunchChanged(); }
  // once a minute, on launch and back in the foreground: a break whose length elapsed ends by itself
  function lunchTick() {
    const st = curLunch();
    if (st.startedAt != null && st.endedAt == null && LunchBreak.phase(st, S.settings, Date.now()) === 'taken') lunchEnd(true);
  }
  // The slim bar above the stop list (never a modal): Start / Skip today, then "Lunch until 13:20 · End break".
  function lunchBar(plan) {
    const b = LunchBreak.bar(curLunch(), S.settings, Date.now(), hasPendingStop(plan));
    if (!b || b.kind === 'skipped') return null;
    if (b.kind === 'active') {
      return h('div', { class: 'lunch-bar active', id: 'lunchBar' }, h('span', { class: 'lunch-text' }, 'Lunch until ' + fmt(b.untilMs)),
        ' · ', h('button', { class: 'link-btn', type: 'button', id: 'lunchEnd', onclick: () => lunchEnd(false) }, 'End break'));
    }
    return h('div', { class: 'lunch-bar', id: 'lunchBar' },
      h('button', { class: 'small lunch-start', type: 'button', id: 'lunchStart', onclick: () => lunchStart() }, b.label),
      h('button', { class: 'link-btn', type: 'button', id: 'lunchSkip', onclick: () => lunchSkip() }, 'Skip today'));
  }
  // "Lunch skipped · Undo" in the Route header area, until End day closes the day
  function lunchSkippedLine() {
    const day = S.days[lunchDayKey()];
    if (LunchBreak.phase(curLunch(), S.settings, Date.now()) !== 'skipped' || (day && day.closed)) return null;
    return h('div', { class: 'muted lunch-skipped', id: 'lunchSkipped' }, 'Lunch skipped · ',
      h('button', { class: 'link-undo', type: 'button', id: 'lunchUndoSkip', 'aria-label': 'Undo lunch skipped', onclick: () => lunchUndoSkip() }, 'Undo'));
  }
  // where the break sits in the timeline (assumed: "Lunch break ~12:40–13:40"; real: "Lunch break until 13:20")
  function lunchMarker(plan) {
    const L = plan && plan.lunch;
    if (!L) return null;
    return h('div', { class: 'muted lunch-marker', id: 'lunchMarker' }, L.kind === 'active' ? 'Lunch break until ' + fmt(L.endMs) : 'Lunch break ~' + fmt(L.startMs) + '–' + fmt(L.endMs));
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
    S.loc.origin = null;
    logDone(stop, nowIso); // synchronous, in memory: never delays DONE (save + geolocation fix happen in the background)
    P.alt = null;
    P.result.plans = [P.result.plans[P.idx]]; P.idx = 0; // alternatives pre-date this DONE: drop them
    // live re-timing: from this stop, at the DONE time, order unchanged - shown at once, never waiting for the network
    P.result.plans[0] = timedPlan(P.result.plans[0], i, nowIso);
    P.shiftMs = 0;
    render();
    await refreshIfStale(P.result.plans[0]);              // travel times older than 30 min are re-fetched, then re-timed again
    P.result.plans[0] = timedPlan(P.result.plans[0], i, nowIso);
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
    refreshFromLocation({ force: true }); // after DONE: ETAs from where we are now (a new target, so not throttled; never blocks)
  }

  // A stop becomes skipped ONLY by this explicit tap (nothing else - DONE order, timing, replan - ever sets it).
  async function skipStop(stop0, i0) { // actions stay pending; skipped stops leave the re-time chain and the header counts
    const P = S.plan;
    const ls = liveStop(stop0, i0);
    if (!ls) return;
    if (ls.stop.reachedAt != null) { // a stop skipped after it was reached is a departure; one skipped without Reached changes nothing
      try {
        const now = Date.now(), day = dayFor(now, false);
        if (day) { DL.recordSkip(day, { nowIso: new Date(now).toISOString(), stopId: ls.stop.placeId, name: ls.stop.fuel ? 'Fuel: ' + ((coordPlace(ls.stop.placeId) || {}).name || '') : '', reachedAt: ls.stop.reachedAt, places: Object.assign({}, S.plan && S.plan.ctx.places, S.places) }); bgSaveDay(day); }
      } catch (e) { /* never break SKIP */ }
    }
    ls.stop.status = 'skipped';
    S.loc.origin = null;
    P.alt = null;
    P.result.plans = [P.result.plans[P.idx]]; P.idx = 0;
    retimeNow(); // from the last DONE (never from the skipped stop: we did not go there)
    toast(ls.stop.fuel ? 'Fuel stop skipped. Undo skip to bring it back.' : 'Skipped — actions stay pending. Undo skip, or replan to bring it back.');
    await savePlan();
    render();
    refreshFromLocation({ force: true });
  }
  async function undoSkip(stop0, i0) { // puts the stop back in the chain and re-times
    const P = S.plan, cur = curPlan();
    const stop = cur && cur.stops[i0] && cur.stops[i0].placeId === stop0.placeId ? cur.stops[i0] : null;
    if (!stop || stop.status !== 'skipped') return;
    if (stop.reachedAt != null) { try { const d = dayFor(Date.now(), false); if (d) { DL.recordUndoSkip(d, { nowIso: new Date().toISOString(), stopId: stop.placeId }); bgSaveDay(d); } } catch (e) { /* ignore */ } }
    delete stop.status;
    S.loc.origin = null;
    P.alt = null;
    retimeNow();
    banner(null);
    await savePlan();
    render();
    refreshFromLocation({ force: true });
  }

  async function replanFromHere() {
    if (!pendingJobs().length) { toast('Nothing left to plan.'); return; }
    await doPlan({ replan: true });
  }

  // ---------- FUEL STOP ----------
  // "Add fuel stop": the station of the chosen brand, and the place in today's remaining route, that adds the fewest minutes.
  // The maths lives in fuel.js. The stop is a normal plan stop with stop.fuel = true and placeId FUEL_ID; its place sits in the
  // plan's ctx.places (never in S.places, so it is not in the Places tab) and its travel times in plan.model.fuelT (see
  // Solver.retime). Nothing is ever added without the tap on "Add".
  const FUEL_ID = Fuel.FUEL_ID;
  const FUEL_RADIUS_M = 3000;
  let fuelBusy = false;
  let fuelRun = null; // {key, at, searched}: the last finished search; reused for 10 minutes for the same remaining route
  let forgetAsk = false;
  const llKey = (p) => Number(p.lat).toFixed(5) + ',' + Number(p.lng).toFixed(5);
  const saveStations = () => WPStore.set('meta', 'fuelStations', { list: S.fuelStations });
  const fuelBrand = () => (S.settings.fuelBrand || '').trim() || 'Caltex';
  const fuelDwell = () => { const d = Number(S.settings.fuelDwellMin); return isFinite(d) && d >= 0 ? d : 7; };
  const keyed = (pts) => pts.map((p) => Object.assign({}, p, { key: llKey(p) }));
  const estimateSec = (a, b) => Math.round(Fuel.haversineKm(a, b) * 1.4 / 35 * 3600); // last resort: 35 km/h x 1.4
  const stripFuel = (plan) => (plan.stops.some((s) => s.fuel && s.status !== 'done')
    ? Object.assign({}, plan, { stops: plan.stops.filter((s) => !(s.fuel && s.status !== 'done')) }) : plan);
  const urgentHere = (stop) => stop.actions.some((a) => {
    if (a.kind !== 'deliver') return false;
    const j = S.jobs.find((x) => x.id === a.jobId) || ((S.plan && S.plan.ctx.jobs) || []).find((x) => x.id === a.jobId);
    return !!(j && j.urgent);
  });
  const nearestSlice = (slices, ms, at) => slices.reduce((b, s) => (b == null || Math.abs(at(s) - ms) < Math.abs(at(b) - ms) ? s : b), null);

  // The remaining route for the fuel maths: origin (live fix if fresh, else the last done stop, else the plan origin),
  // each stop not done / skipped (urgent = an urgent delivery still pending there), the end point. The fuel stop itself is left out.
  function fuelRouteOf(plan) {
    const P = S.plan, m = plan.model, now = Date.now();
    const placeOf = (id) => S.places[id] || P.ctx.places[id];
    let origin = null;
    const lo = S.loc.origin;
    if (lo && Solver.originFresh(lo, now)) origin = { lat: lo.lat, lng: lo.lng, id: 'live', name: 'your location' };
    if (!origin) {
      const di = lastDoneIdx(plan), ds = di >= 0 ? plan.stops[di] : null;
      const pl = ds && (ds.fuel || m.stopIds.indexOf(ds.placeId) >= 0) ? placeOf(ds.placeId) : null;
      origin = pl ? { lat: pl.lat, lng: pl.lng, id: ds.placeId, name: dName(pl.name) } : { lat: m.start.lat, lng: m.start.lng, id: 'start', name: 'the start' };
    }
    const stops = plan.stops.filter((s) => !s.fuel).map((s) => {
      const pl = placeOf(s.placeId) || {};
      return { id: s.placeId, name: dName(pl.name || ''), lat: pl.lat, lng: pl.lng, status: s.status, urgent: urgentHere(s) };
    }).filter((s) => s.lat != null);
    const e = P.ctx.end;
    return { origin, stops, end: { lat: e.lat, lng: e.lng, id: 'end', name: dName(e.name || 'the end') } };
  }

  // seconds between two model points of the plan (nearest time slice), or null when either is not one of its points
  function planLegSec(plan, a, b, nowMs) {
    const m = plan.model;
    if (!m || !m.matrices || !m.matrices.length) return null;
    const idx = new Map([[llKey(m.start), 0]]);
    m.stopIds.forEach((id, i) => { const pl = S.places[id] || S.plan.ctx.places[id]; if (pl && !idx.has(llKey(pl))) idx.set(llKey(pl), i + 1); });
    if (!idx.has(llKey(m.end))) idx.set(llKey(m.end), m.stopIds.length + 1);
    const ia = idx.get(a.key), ib = idx.get(b.key);
    if (ia == null || ib == null) return null;
    const sl = nearestSlice(m.matrices, nowMs, (s) => Date.parse(s.departAt));
    const v = sl && sl.m[ia] ? sl.m[ia][ib] : null;
    return v == null || !isFinite(v) ? null : v;
  }
  const fuelCellSec = (fz, a, b, nowMs) => { // a or b is the station
    const other = a.fuel ? b : a, sl = nearestSlice(fz.slices, nowMs, (s) => s.at);
    const v = sl ? (a.fuel ? sl.from : sl.to)[other.key] : null;
    return v == null || !isFinite(v) ? null : v;
  };
  // travel minutes for Fuel.pickInsertion. t(A,B): the plan's own matrices where both are its points, else the fresh table.
  function makeTT(plan, nowMs, fzOf, tableGet) {
    return (a, b) => {
      if (a.key === b.key) return 0;
      let sec;
      if (a.fuel || b.fuel) { const fz = fzOf(a.fuel ? a : b); sec = fz ? fuelCellSec(fz, a, b, nowMs) : null; }
      else { sec = planLegSec(plan, a, b, nowMs); if (sec == null && tableGet) sec = tableGet(a.key, b.key, nowMs); }
      return (sec == null ? estimateSec(a, b) : sec) / 60;
    };
  }
  // ONE existing TomTom lookup (+ its cache) over the plan's points, the route's points and the stations
  async function fuelTable(extra, plan) {
    const m = plan.model, P = S.plan;
    const all = [m.start].concat(m.stopIds.map((id) => S.places[id] || P.ctx.places[id]).filter(Boolean), [m.end], extra);
    const idx = new Map(), points = [];
    all.forEach((p) => { const k = llKey(p); if (!idx.has(k)) { idx.set(k, points.length); points.push({ lat: p.lat, lng: p.lng }); } });
    const got = await Providers.getMatrices(points, new Date().toISOString(), S.settings.tomtomKey);
    return { points, idx, matrices: got.matrices };
  }
  const tableGetOf = (t) => (ka, kb, ms) => {
    const ia = t.idx.get(ka), ib = t.idx.get(kb);
    if (ia == null || ib == null) return null;
    const sl = nearestSlice(t.matrices, ms, (s) => Date.parse(s.departAt));
    const v = sl ? sl.m[ia][ib] : null;
    return v == null || !isFinite(v) ? null : v;
  };
  // the station's times to / from every point of the table, keyed by coordinates (what Solver.retime reads)
  function makeFuelT(st, table, plan) {
    const P = S.plan, sIdx = table.idx.get(llKey(st));
    const ll = {}, pid2key = {};
    table.points.forEach((p) => { ll[llKey(p)] = { lat: p.lat, lng: p.lng }; });
    plan.model.stopIds.forEach((id) => { const pl = S.places[id] || P.ctx.places[id]; if (pl) pid2key[id] = llKey(pl); });
    const slices = table.matrices.map((sl) => {
      const to = {}, from = {};
      table.points.forEach((p, i) => {
        if (i === sIdx) return;
        const k = llKey(p);
        if (sl.m[i][sIdx] != null) to[k] = sl.m[i][sIdx];
        if (sl.m[sIdx][i] != null) from[k] = sl.m[sIdx][i];
      });
      return { at: Date.parse(sl.departAt), to, from };
    });
    return { lat: st.lat, lng: st.lng, pid2key, ll, slices };
  }
  // the plan with the fuel stop put in front of point b (b = the leg's destination; the end point = after the last stop)
  function withFuel(plan, b, fz, place) {
    let idx = b && b.role === 'stop' ? plan.stops.findIndex((s) => s.placeId === b.id && !s.status) : -1;
    if (idx < 0) idx = plan.stops.length;
    const stop = { placeId: FUEL_ID, fuel: true, arriveAt: 0, departAt: 0, waitSec: 0, actions: [], detour: false, closedWarning: false };
    const stops = plan.stops.slice(); stops.splice(idx, 0, stop);
    const m = plan.model;
    const model = Object.assign({}, m, { fuelT: fz, dwellSec: Object.assign({}, m.dwellSec, { [FUEL_ID]: (place.dwellMin || 0) * 60 }), names: Object.assign({}, m.names, { [FUEL_ID]: place.name }) });
    return Object.assign({}, plan, { stops, model });
  }
  function retimeLocal(plan) { // like retimeNow(), for a plan that is not (yet) the current one
    const P = S.plan, from = lastDoneIdx(plan), now = Date.now();
    return timedPlan(plan, from, iso(from < 0 ? Math.max(now, Date.parse(P.ctx.departAtISO)) : now));
  }
  // the already chosen station put back by the same rule (lowest detour over the allowed legs), from its stored times only
  function insertBestFuel(plan, fz, place) {
    const route = fuelRouteOf(plan), pts = keyed(Fuel.remainingPoints(route)), legs = Fuel.allowedLegs(route);
    const st = { placeId: FUEL_ID, name: place.name, lat: place.lat, lng: place.lng, fuel: true, key: llKey(place) };
    const sorted = Fuel.pickInsertion(legs.map((l) => ({ station: st, a: pts[l.from], b: pts[l.to], legIndex: l.index })), makeTT(plan, Date.now(), () => fz, null));
    return sorted.length ? withFuel(plan, sorted[0].b, fz, place) : plan;
  }
  // after a re-solve from the cache (No detour / Avoid lunch): carry the fuel times and put a pending fuel stop back
  function carryFuel(old, p) {
    const fz = old && old.model && old.model.fuelT, place = S.plan.ctx.places[FUEL_ID];
    if (!fz) return p;
    let q = Object.assign({}, p, { model: Object.assign({}, p.model, { fuelT: fz }) });
    if (place && old.stops.some((s) => s.fuel && !s.status)) q = retimeLocal(reinsertFuel(old, q, fz, place));
    return q;
  }
  // The pending fuel stop put back into a re-solved plan. Reached (you are at the station) = it goes first among the
  // pending stops; else the lowest-detour leg. Its reached / navigation state is kept (Reached.keepStateOf).
  function reinsertFuel(prevPlan, q, fz, place) {
    const old = prevPlan.stops.find((s) => s.fuel && !s.status);
    let r;
    if (old && old.reachedAt != null) {
      const first = q.stops.find((s) => !s.status);
      r = withFuel(q, first ? { role: 'stop', id: first.placeId } : null, fz, place);
    } else r = insertBestFuel(q, fz, place);
    return Object.assign({}, r, { stops: Reached.keepStateOf(prevPlan.stops, r.stops) });
  }
  // Replan from here: keep the fuel stop, silently re-placed (fresh times for the chosen station only; no Places calls)
  async function keepFuelAfterReplan(prevPlan, prevPlaces, points) {
    const P = S.plan, place = prevPlaces && prevPlaces[FUEL_ID], fz0 = prevPlan.model && prevPlan.model.fuelT;
    if (!place || !fz0) return;
    P.ctx.places = Object.assign({}, P.ctx.places, { [FUEL_ID]: place });
    const pending = prevPlan.stops.some((s) => s.fuel && !s.status);
    let fz = fz0;
    if (pending && S.settings.tomtomKey) {
      try {
        const base = P.result.plans[0], st = { lat: place.lat, lng: place.lng };
        fz = makeFuelT(st, await fuelTable([st], base), base);
      } catch (e) { fz = fz0; } // keep the stored times (anything not in them is estimated)
    }
    P.result.plans = P.result.plans.map((p) => {
      const q = Object.assign({}, p, { model: Object.assign({}, p.model, { fuelT: fz }) });
      return pending ? retimeLocal(reinsertFuel(prevPlan, q, fz, place)) : q;
    });
  }

  async function fuelTap() {
    if (fuelBusy) return;
    const P = S.plan, plan0 = curPlan();
    banner(null);
    if (!P || !plan0) { toast('Make a plan first, then add a fuel stop.'); return; }
    const s = S.settings, brand = fuelBrand();
    const base = stripFuel(plan0); // a stop being replaced is not part of the route we plan around
    const route = fuelRouteOf(base);
    const pts = keyed(Fuel.remainingPoints(route));
    const legs = Fuel.allowedLegs(route);
    if (!legs.length) { banner('No part of the route can take a fuel stop right now.', 'error'); return; }
    if (!s.tomtomKey) { banner('TomTom API key missing — add it in Settings. (The fuel stop is chosen by travel time.)', 'error'); return; }
    fuelBusy = true;
    let cancelled = false;
    const sh = openSheet(plan0.stops.some((x) => x.fuel) ? 'Change fuel stop' : 'Add fuel stop', () => { cancelled = true; fuelBusy = false; });
    const status = h('div', { class: 'muted', id: 'fuelStatus', role: 'status' }, 'Starting…');
    sh.body.append(status, h('div', { class: 'sticky-actions' }, h('button', { onclick: sh.close }, 'Cancel')));
    const fail = (msg) => { sh.close(); banner(msg, 'error'); };
    try {
      // --- 4b: search the whole remaining route (unless a search of this same route finished under 10 minutes ago) ---
      const samples = Fuel.samplePoints(pts, 4, 50);
      const maxPerTap = Math.min(50, Math.max(1, Math.round(Number(s.fuelMaxSearches)) || 50));
      const budget = Fuel.searchBudget(samples.length, maxPerTap, placesCallsToday());
      const limited = budget < Math.min(samples.length, maxPerTap);
      const rkey = brand.toLowerCase() + '|' + Fuel.sameRouteKey(pts);
      const reuse = !!(fuelRun && fuelRun.key === rkey && Date.now() - fuelRun.at < Fuel.REUSE_MS);
      let searched = reuse ? fuelRun.searched : 0, rememberedOnly = false, failNote = '';
      if (!reuse) {
        if (!s.googleKey || navigator.onLine === false || budget < 1) rememberedOnly = true;
        else {
          const targets = Fuel.evenIndices(samples.length, budget).map((i) => samples[i]);
          const found = [];
          const run = await Fuel.mapLimit(targets, 5, async (pt) => {
            const res = await Providers.searchGoogle(brand, s.googleKey, bumpPlacesCalls, { bias: { lat: pt.lat, lng: pt.lng, radius: FUEL_RADIUS_M } });
            res.filter((r) => Fuel.nameHasBrand(r.name, brand)).forEach((r) => found.push({ placeId: r.id || ('ll:' + llKey(r)), name: r.name, address: r.address, lat: r.lat, lng: r.lng, brand }));
          }, (d, n) => { status.textContent = 'Searching ' + d + ' of ' + n + '…'; }, () => cancelled);
          if (cancelled) return;
          if (run.errors.length >= targets.length) { rememberedOnly = true; failNote = 'Google search failed (' + (run.errors[0].message || 'error') + ')'; }
          else fuelRun = { key: rkey, at: Date.now(), searched: targets.length };
          searched = targets.length;
          S.fuelStations = Fuel.mergeStations(S.fuelStations, found);
          await saveStations();
        }
      }
      // --- 4c: shortlist from the whole memory, then real travel times ---
      status.textContent = 'Getting travel times…';
      const known = Fuel.stationsOfBrand(S.fuelStations, brand);
      if (!known.length) { fail('No ' + brand + ' found near this route.'); return; }
      const short = Fuel.shortlist(pts, known, legs, 5);
      const stationPts = short.map((r) => Object.assign({}, r.station, { fuel: true, key: llKey(r.station) }));
      let table;
      try { table = await fuelTable(pts.concat(stationPts), base); } catch (e) { if (!cancelled) fail('Could not get travel times: ' + (e.message || e)); return; }
      if (cancelled) return;
      const fzs = {};
      const fzOf = (st) => fzs[st.placeId] || (fzs[st.placeId] = makeFuelT(st, table, base));
      const cands = [];
      short.forEach((r, i) => r.legs.forEach((l) => cands.push({ station: stationPts[i], a: pts[l.from], b: pts[l.to], legIndex: l.index })));
      const sorted = Fuel.pickInsertion(cands, makeTT(base, Date.now(), fzOf, tableGetOf(table)));
      if (!sorted.length) { fail('Could not work out travel times to the ' + brand + ' stations.'); return; }
      // --- 4d: preview ---
      let cur = 0;
      const draw = () => {
        const c = sorted[cur], mins = Math.max(0, Math.round(c.detourMin));
        sh.body.replaceChildren(
          h('div', { class: 'title', id: 'fuelName' }, c.station.name),
          c.station.address ? h('div', { class: 'muted', id: 'fuelAddr' }, c.station.address) : null,
          h('div', { class: 'fuel-detour', id: 'fuelDetour' }, '+' + mins + ' min · between ' + (c.a.name || 'here') + ' and ' + (c.b.name || 'the end')),
          h('div', { class: 'muted fuel-small', id: 'fuelSearched' }, 'Searched ' + searched + ' points · ' + S.fuelStations.length + ' stations remembered' + (reuse ? ' (recent search reused)' : '')),
          rememberedOnly ? h('div', { class: 'muted fuel-small', id: 'fuelNote' }, (failNote ? failNote + ' - ' : '') + 'Using remembered stations only') : null,
          limited && !reuse ? h('div', { class: 'muted fuel-small', id: 'fuelLimited' }, 'Search limited today (Places daily guard) - result may not be the best') : null,
          h('div', { class: 'sticky-actions' },
            h('button', { class: 'primary', id: 'fuelAdd', onclick: async () => { const pick = sorted[cur]; sh.close(); await commitFuel(pick, fzOf(pick.station)); } }, 'Add'),
            h('button', { id: 'fuelNext', disabled: sorted.length < 2, onclick: () => { cur = (cur + 1) % sorted.length; draw(); } }, 'Next best'),
            h('button', { id: 'fuelCancel', onclick: sh.close }, 'Cancel')));
      };
      draw();
    } catch (e) {
      if (!cancelled) fail(e.message || String(e));
    }
  }

  // --- 4e: the tap on "Add": insert, re-time with the existing logic (LATE / lunch warnings follow), persist ---
  async function commitFuel(c, fz) {
    const P = S.plan, cur = curPlan();
    if (!P || !cur) return;
    const st = c.station;
    const place = { id: FUEL_ID, name: st.name, address: st.address || '', lat: st.lat, lng: st.lng, type: 'fuel', dwellMin: fuelDwell(), closedWindows: [], placeId: st.placeId };
    P.ctx = Object.assign({}, P.ctx, { places: Object.assign({}, P.ctx.places, { [FUEL_ID]: place }) });
    P.result.plans = [withFuel(stripFuel(cur), c.b, fz, place)]; P.idx = 0; // alternatives pre-date the fuel stop: dropped (as at DONE)
    P.alt = null; S.loc.origin = null;
    retimeNow();
    toast('Fuel stop added: ' + dName(st.name));
    await savePlan();
    render();
    refreshFromLocation({ force: true });
  }
  async function removeFuel() {
    const P = S.plan, cur = curPlan();
    if (!P || !cur) return;
    const next = stripFuel(cur);
    if (!next.stops.some((s) => s.fuel)) { // none left (a done one would stay): forget its place and times
      const places = Object.assign({}, P.ctx.places); delete places[FUEL_ID];
      P.ctx = Object.assign({}, P.ctx, { places });
      const model = Object.assign({}, next.model); delete model.fuelT;
      next.model = model;
    }
    P.result.plans = [next]; P.idx = 0; P.alt = null; S.loc.origin = null;
    retimeNow();
    toast('Fuel stop removed.');
    await savePlan();
    render();
    refreshFromLocation({ force: true });
  }

  function fuelCard(stop, i, place) { // fuel tag, station, ETA, navigation, DONE / SKIP / REMOVE (no WhatsApp message)
    const btns = navButtons(place, () => navTap(stop, i));
    btns.push(primaryBtn(stop, i));
    btns.push(h('button', { class: 'small', onclick: () => skipStop(stop, i) }, 'SKIP'));
    btns.push(h('button', { class: 'small danger', 'aria-label': 'Remove fuel stop', onclick: () => removeFuel() }, 'REMOVE'));
    const rin = reachedInline(stop, i); // shares the card's address line (no extra row)
    return h('div', { class: 'card stop fuel' + (rin ? ' reached' : '') },
      h('div', { class: 'stop-head' }, h('span', { class: 'num' }, (i + 1) + '.'), h('span', { class: 'nm' }, dName(place.name)), h('span', { class: 'pill fuel' }, 'FUEL'), h('span', { class: 'times' }, fmt(stop.arriveAt))),
      place.address || rin ? h('div', { class: 'muted fuel-addr' }, place.address || '', place.address && rin ? ' · ' : '', rin) : null,
      h('div', { class: 'stop-btns' }, btns));
  }

  function fuelSettingsCard(s, field) {
    const brand = h('input', { id: 'fuelBrand', value: s.fuelBrand || '', autocomplete: 'off' });
    brand.addEventListener('change', () => { s.fuelBrand = brand.value.trim() || 'Caltex'; brand.value = s.fuelBrand; saveSettings(); });
    const num = (id, key, min, max, def) => {
      const el = h('input', { id, type: 'number', inputmode: 'numeric', min: String(min), max: max != null ? String(max) : null, value: String(s[key]) });
      el.addEventListener('change', () => {
        let v = Math.round(Number(el.value));
        if (!isFinite(v)) v = def;
        v = Math.max(min, max != null ? Math.min(max, v) : v);
        s[key] = v; el.value = String(v); saveSettings();
      });
      return el;
    };
    const n = S.fuelStations.length;
    const forget = forgetAsk
      ? h('div', { class: 'row', id: 'forgetConfirm', style: 'margin-top:8px' }, h('span', { class: 'grow' }, 'Forget ' + n + ' remembered stations?'),
        h('button', { class: 'small', id: 'forgetNo', onclick: () => { forgetAsk = false; render(); } }, 'Cancel'),
        h('button', { class: 'small danger', id: 'forgetYes', onclick: async () => { S.fuelStations = []; fuelRun = null; await saveStations(); forgetAsk = false; toast('Stations forgotten'); render(); } }, 'Forget'))
      : h('button', { id: 'forgetBtn', style: 'margin-top:8px', disabled: !n, onclick: () => { forgetAsk = true; render(); } }, 'Forget stations');
    return h('div', { class: 'card', id: 'fuelCard' }, h('h2', { style: 'margin-top:0' }, 'Fuel'),
      field('Fuel brand', brand),
      field('Fuel stop dwell (minutes)', num('fuelDwell', 'fuelDwellMin', 0, null, 7)),
      field('Max searches per tap', num('fuelMax', 'fuelMaxSearches', 1, 50, 50)),
      h('div', { class: 'muted', id: 'fuelCount' }, n + ' stations remembered'),
      forget);
  }

  // ---------- PLACES tab ----------
  let placeFilter = '';
  function renderPlaces(v) {
    const input = h('input', { type: 'search', placeholder: 'Search saved places…', value: placeFilter, oninput: (e) => { placeFilter = e.target.value; drawList(); } });
    const list = h('div');
    function drawList() {
      const q = placeFilter.trim().toLowerCase();
      const items = Object.values(S.places).filter((p) => !q || (p.name + ' ' + p.address).toLowerCase().includes(q)).sort(byName);
      const none = Object.keys(S.places).length ? 'No places match.' : 'No places yet.';
      list.replaceChildren(...(items.length ? items.map((p) => h('div', { class: 'card', onclick: () => openPlaceEditor(p) },
        h('div', { class: 'title place-name' }, p.name),
        h('div', { class: 'place-tag' }, h('span', { class: 'chip' }, Messages.typeLabel(p.type))),
        h('div', { class: 'muted' }, p.address || (p.lat.toFixed(4) + ', ' + p.lng.toFixed(4))),
        p.whatsapp ? h('div', { class: 'muted place-wa' }, 'WA ' + Messages.compactNumber(p.whatsapp)) : null,
        Geo.lunchCardText(p.closedWindows) ? h('div', { class: 'place-closed' }, 'Lunch ' + Geo.lunchCardText(p.closedWindows)) : null)) : [h('div', { class: 'empty card' }, none)]));
    }
    v.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, input), h('button', { class: 'primary', onclick: () => openPlacePicker((p) => openPlaceEditor(p), 'Add place') }, '+ Add')), list);
    drawList();
  }

  function openPlaceEditor(p) {
    const sh = openSheet('Edit place');
    const simple0 = Geo.storedToSimple(p.closedWindows);
    let keepCustom = !simple0.fits; // stored hours do not fit the simple form: leave them untouched unless replaced
    const name = h('input', { value: p.name });
    const addr = h('input', { value: p.address });
    const dwell = h('input', { type: 'number', inputmode: 'numeric', min: '0', value: String(p.dwellMin) });
    const type = h('select', { onchange: (e) => { dwell.value = String(S.settings.dwellDefaults[e.target.value] != null ? S.settings.dwellDefaults[e.target.value] : 10); syncType(); } }, TYPES.map((t) => h('option', { value: t, selected: p.type === t }, Messages.typeLabel(t))));
    const wa = h('input', { type: 'tel', inputmode: 'tel', value: Messages.compactNumber(p.whatsapp), placeholder: '+60123456789' });
    const sal = h('select', null, ['Encik', 'Puan', 'Cik'].map((t) => h('option', { value: t, selected: (p.salutation || 'Encik') === t }, t)));
    const lang = h('select', null, [['default', 'Default (' + S.settings.defaultLang + ')'], ['ms', 'Bahasa Malaysia'], ['en', 'English']].map(([val, lab]) => h('option', { value: val, selected: (p.lang || 'default') === val }, lab)));
    // suppliers are collected from, never messaged: hide salutation + language for them (WhatsApp stays)
    const salBox = h('div', null, h('label', { class: 'field' }, 'Salutation'), sal, h('label', { class: 'field' }, 'Message language'), lang);
    function syncType() { salBox.hidden = type.value === 'supplier'; }
    syncType();
    // Lunch / closed window: one Mon-Fri window + an optional different Friday window (stored format unchanged: see Geo.simpleToStored)
    const timeIn = (v) => h('input', { type: 'time', value: v || '' });
    const lFrom = timeIn(simple0.from), lTo = timeIn(simple0.to), fFrom = timeIn(simple0.friFrom), fTo = timeIn(simple0.friTo);
    const friOn = h('input', { type: 'checkbox', id: 'friDiff', checked: !!(simple0.friFrom || simple0.friTo), style: 'width:auto;min-height:0' });
    const lunchErr = h('div', { class: 'error-text', role: 'alert', hidden: true });
    const quick = (picks, fi, ti) => h('div', { class: 'quick' }, picks.map((r) => h('button', { type: 'button', class: 'small', onclick: () => { const [x, y] = r.split('-'); fi.value = x; ti.value = y; lunchErr.hidden = true; } }, r)));
    const fridayBox = h('div', { hidden: !friOn.checked },
      quick(['12:30-14:30', '13:00-14:30'], fFrom, fTo),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Friday from'), fFrom), h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Friday to'), fTo)));
    friOn.addEventListener('change', () => { fridayBox.hidden = !friOn.checked; });
    const simpleForm = h('div', null,
      h('label', { class: 'field' }, 'Lunch / closed window (Mon-Fri)'),
      quick(['12:00-13:00', '12:30-13:30', '13:00-14:00'], lFrom, lTo),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', { class: 'field' }, 'From'), lFrom), h('div', { class: 'grow' }, h('label', { class: 'field' }, 'To'), lTo),
        h('button', { type: 'button', class: 'small', onclick: () => { lFrom.value = ''; lTo.value = ''; lunchErr.hidden = true; } }, 'Clear')),
      h('label', { class: 'check-row' }, friOn, ' Different on Friday'),
      fridayBox);
    const customBox = h('div', null,
      h('label', { class: 'field' }, 'Lunch / closed window'),
      h('div', null, 'Custom hours kept: ' + Geo.formatWindows(p.closedWindows)),
      h('button', { type: 'button', class: 'small', onclick: () => { keepCustom = false; syncLunch(); } }, 'Replace with simple window'));
    const lunchBox = h('div', null, customBox, simpleForm, lunchErr);
    function syncLunch() { customBox.hidden = !keepCustom; simpleForm.hidden = keepCustom; if (keepCustom) lunchErr.hidden = true; }
    syncLunch();
    // -> stored windows, or null (and an inline message) when the simple form is invalid
    function lunchValue() {
      const s = { from: lFrom.value, to: lTo.value, friFrom: friOn.checked ? fFrom.value : '', friTo: friOn.checked ? fTo.value : '' };
      const errs = Geo.validateSimple(s, friOn.checked);
      lunchErr.hidden = !errs.length; lunchErr.textContent = errs.join(' ');
      return errs.length ? null : Geo.simpleToStored(s);
    }
    // wrong pin? re-take it where you stand (saved at once; the old coordinates are kept so it can be undone once)
    const adopt = (np) => { Object.keys(p).forEach((k) => { delete p[k]; }); Object.assign(p, np); };
    const pinInfo = h('div', { class: 'muted', id: 'pinInfo' });
    const pinMsg = h('div', { class: 'muted', id: 'pinMsg', role: 'status' });
    const undoLoc = h('button', { class: 'small', id: 'undoLoc', type: 'button', hidden: !p.previousLocation }, 'Undo location update');
    const updLoc = h('button', { id: 'updateLoc', type: 'button' }, 'Update location to where I am now');
    const drawPin = () => { pinInfo.textContent = 'Pin: ' + fmtLL(p.lat, p.lng) + (p.accuracy != null ? ' (accuracy about ' + p.accuracy + ' m)' : ''); undoLoc.hidden = !p.previousLocation; };
    updLoc.onclick = async () => {
      updLoc.disabled = true; pinMsg.textContent = 'Getting your location…';
      const f = await Geo.getFix(navigator.geolocation);
      updLoc.disabled = false;
      if (!f.ok) { pinMsg.textContent = FIX_MSG[f.code] || FIX_MSG.unavailable; return; }
      pinMsg.textContent = '';
      const metres = Math.round(Solver.distanceM({ lat: p.lat, lng: p.lng }, f));
      if (!confirm('Move the pin of ' + p.name + ' by about ' + metres + ' m? (new fix accurate to about ' + Math.round(f.accuracy) + ' m)')) return;
      adopt(Geo.moveLocation(p, f, new Date().toISOString()));
      await savePlace(p); drawPin(); pinMsg.textContent = 'Pin moved ' + metres + ' m.';
    };
    undoLoc.onclick = async () => { adopt(Geo.undoMove(p)); await savePlace(p); drawPin(); pinMsg.textContent = 'Back to the old location.'; };
    drawPin();
    sh.body.append(
      h('label', { class: 'field' }, 'Name'), name, h('label', { class: 'field' }, 'Address'), addr,
      h('label', { class: 'field' }, 'Type'), type, h('label', { class: 'field' }, 'Dwell (minutes)'), dwell,
      lunchBox,
      h('label', { class: 'field' }, 'WhatsApp number'), wa,
      salBox,
      h('label', { class: 'field' }, 'Location'), pinInfo, h('div', { class: 'row', style: 'margin-top:6px' }, h('div', { class: 'grow' }, updLoc), undoLoc), pinMsg,
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
          if (!keepCustom) { const cw = lunchValue(); if (!cw) return; p.closedWindows = cw; }
          Object.assign(p, { name: name.value.trim(), address: addr.value.trim(), type: type.value, dwellMin: Number(dwell.value) || 0, whatsapp: Messages.compactNumber(wa.value), salutation: sal.value, lang: lang.value });
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
      return h('div', { class: 'grow' }, h('label', { class: 'field' }, Messages.typeLabel(t)), inp);
    });
    const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: (e) => importJson(e.target.files[0]) });
    v.append(
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'API keys'),
        field('Google Places key (place search only)', bind(h('input', { type: 'password', autocomplete: 'off', value: s.googleKey }), 'googleKey')),
        field('TomTom key (all travel times)', bind(h('input', { type: 'password', autocomplete: 'off', value: s.tomtomKey }), 'tomtomKey')),
        h('div', { class: 'muted' }, 'Keys stay on this device (never in the code, never exported).')),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Google Places calls today'),
        h('div', { class: 'title' }, String(placesCallsToday())),
        h('div', { class: 'muted' }, 'Counted on this device only. No Google-side cap is set yet.')),
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
      h('div', { class: 'card', id: 'reachedCard' }, h('h2', { style: 'margin-top:0' }, 'Reached'),
        h('label', { class: 'check-row' },
          h('input', { type: 'checkbox', id: 'autoReach', checked: s.autoReach !== false, style: 'width:auto;min-height:0', onchange: (e) => { s.autoReach = e.target.checked; saveSettings(); } }),
          " Mark Reached automatically when I'm within 150 m (app open)")),
      lunchSettingsCard(s, field),
      fuelSettingsCard(s, field),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Data'),
        h('div', { class: 'row' }, h('button', { class: 'grow', onclick: exportJson }, 'Export JSON'), h('button', { class: 'grow', onclick: () => fileIn.click() }, 'Import JSON'), fileIn),
        h('button', { style: 'margin-top:8px', onclick: () => { Providers.clearCache(); toast('Travel-time cache cleared'); } }, 'Clear travel-time cache')),
      h('div', { class: 'muted', id: 'lastPlan', style: 'text-align:center;font-size:12px' }, lastPlanText()),
      h('div', { class: 'muted', style: 'text-align:center' }, 'L-Tech Waypoint v' + APP_VERSION + ' · build ' + BUILD_STAMP),
      h('div', { class: 'muted', id: 'swBuild', style: 'text-align:center;font-size:12px' }, 'Service worker: checking…'));
    describeServiceWorker().then((t) => { const el = document.getElementById('swBuild'); if (el) el.textContent = t; });
  }

  // Settings -> Lunch break (the driver's own break; a customer's lunch is the place's closed window). Device-stored, in Export / Import.
  function lunchSettingsCard(s, field) {
    const changed = () => { saveSettings(); if (S.plan && retimeNow()) savePlan(); };
    const cfg = LunchBreak.settingsOf(s);
    return h('div', { class: 'card', id: 'lunchCard' }, h('h2', { style: 'margin-top:0' }, 'Lunch break'),
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', id: 'lunchOn', checked: cfg.on, style: 'width:auto;min-height:0', onchange: (e) => { s.lunchBreakOn = e.target.checked; changed(); } }),
        ' Plan a lunch break'),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, field('Available from', h('input', { type: 'time', id: 'lunchFrom', value: cfg.from, onchange: (e) => { if (/^\d{1,2}:\d{2}$/.test(e.target.value)) { s.lunchBreakFrom = e.target.value; changed(); } } }))),
        h('div', { class: 'grow' }, field('Length (minutes)', h('input', { type: 'number', id: 'lunchLen', inputmode: 'numeric', min: '5', max: '240', value: String(cfg.lenMin), onchange: (e) => { const n = Math.round(Number(e.target.value)); if (n > 0) { s.lunchBreakMin = n; changed(); } } })))));
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
    const data = Object.assign({ app: 'waypoint', version: APP_VERSION, exportedAt: new Date().toISOString(), places: Object.values(S.places), jobs: S.jobs, settings, fuelStations: S.fuelStations },
      DL.exportPayload(S.days, S.jobs, S.places)); // + dayLog (records) and dayHistory (per-day totals); keys never included
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'waypoint-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.append(a); a.click(); a.remove();
  }
  async function importJson(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'waypoint' || !Array.isArray(data.places) || !Array.isArray(data.jobs)) throw new Error('Not a Waypoint export.');
      const dl = DL.importPayload(data); // older exports have no day log: the current one is kept
      if (!confirm('Replace current places and jobs with ' + data.places.length + ' places and ' + data.jobs.length + ' jobs' + (dl.present ? ' and ' + dl.records.length + ' day record(s)' : '') + ' from this file?')) return;
      await WPStore.clear('places'); await WPStore.clear('jobs');
      S.places = {}; S.jobs = [];
      for (const p of data.places) { normalizeWindows(p); await savePlace(p); }
      await WPStore.remove('plan', 'current');
      for (const j of data.jobs) { S.jobs.push(j); await saveJob(j); }
      if (dl.present) {
        await WPStore.clear('daylogs'); S.days = {};
        for (const d of dl.records) { S.days[d.date] = d; await WPStore.set('daylogs', d.date, d); }
      }
      if (data.settings) {
        const keep = { googleKey: S.settings.googleKey, tomtomKey: S.settings.tomtomKey, placesCallsToday: S.settings.placesCallsToday };
        S.settings = Object.assign(defaultSettings(), data.settings, keep);
        await saveSettings();
      }
      if (Array.isArray(data.fuelStations)) { // older exports have none: the current memory is kept
        S.fuelStations = data.fuelStations.filter((x) => x && x.placeId != null && x.lat != null && x.lng != null);
        fuelRun = null;
        await saveStations();
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
    syncWatch(); // the GPS watch follows the state (plan, pending stops, day closed) after every change
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.tab = b.dataset.tab;
    window.scrollTo(0, 0);
    render();
    if (S.plan) savePlan(); // the stored plan remembers which tab you were on
    if (S.tab === 'route' && S.plan) refreshFromLocation(); // opening the Route tab
  });

  // Back in the foreground: re-time what is left from the last done stop (or the start) at the current time.
  // Hidden: the GPS watch stops. Visible: the watch starts again and one fresh fix is requested (auto-reach on it).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { stopWatch(); return; }
    W.blocked = false; // a watch stopped by an error is retried now
    if (!S.plan) return;
    lunchTick();
    if (retimeNow()) { savePlan(); if (S.tab === 'route') render(); }
    syncWatch();
    freshFixNow(); // back in the foreground: one fresh fix -> auto-reach, then the live-origin path
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

  // Route tab open: re-render once a minute (NO network call) so no time shown has slipped into the past.
  setInterval(() => {
    if (S.plan) lunchTick(); // a lunch break whose length elapsed ends by itself
    if (S.tab === 'route' && S.plan && document.visibilityState === 'visible' && !document.querySelector('.backdrop')) render();
  }, 60000);

  load().then(() => {
    if (S.plan) lunchTick();
    if (S.plan && retimeNow()) savePlan(); // restored plan: re-time from the last done stop (or start) at the current time
    render();
    if (S.tab === 'route' && S.plan) refreshFromLocation();
    watchLocationPermission();
    setupServiceWorker();
  }).catch((e) => banner('Startup failed: ' + e.message, 'error'));

  window.WaypointDebug = { S, doPlan, render };
})();
