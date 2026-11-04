/* L-Tech Waypoint — app.js (UI). Depends on WPStore, Solver, Messages, Providers. */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
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
    plan: null, busy: false,
  };

  function defaultSettings() {
    return {
      googleKey: '', tomtomKey: '', defaultLang: 'ms',
      templates: Object.assign({}, Messages.DEFAULT_TEMPLATES),
      etaPaddingMin: 15, dwellDefaults: Object.assign({}, DEFAULT_DWELL),
      placesCallsToday: { date: todayStr(), count: 0 }, nav: 'waze', seeded: false,
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
  function banner(msg, kind) {
    const b = document.getElementById('banner');
    if (!msg) { b.hidden = true; b.textContent = ''; return; }
    b.className = 'banner' + (kind ? ' ' + kind : '');
    b.replaceChildren(h('span', null, msg), kind === 'busy' ? null : h('button', { onclick: () => banner(null) }, 'OK'));
    b.hidden = false;
  }

  // ---------- sheets ----------
  function openSheet(title) {
    const body = h('div');
    const sheet = h('div', { class: 'sheet', role: 'dialog' }, h('h3', null, title), body);
    const back = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === back) close(); } }, sheet);
    document.body.append(back);
    function close() { back.remove(); }
    return { body, close, sheet };
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

  // ---------- place picker (local first, Google on demand) ----------
  async function savePlaceFromSearch(r) {
    const dup = Object.values(S.places).find((p) => Math.abs(p.lat - r.lat) < 1e-4 && Math.abs(p.lng - r.lng) < 1e-4);
    if (dup) return dup;
    const p = newPlace({ name: r.name, address: r.address, lat: r.lat, lng: r.lng, type: 'other' });
    await savePlace(p);
    return p;
  }

  function openPlacePicker(onPick, title) {
    const sh = openSheet(title || 'Pick a place');
    const input = h('input', { type: 'search', placeholder: 'Search saved places…', autocomplete: 'off' });
    const list = h('div', { class: 'card' });
    const gres = h('div');
    const gbtn = h('button', { class: 'primary', style: 'width:100%;margin-top:8px' }, 'Search Google');
    function row(name, sub, label, fn) {
      return h('div', { class: 'result' }, h('div', null, h('div', { class: 'title' }, name), h('div', { class: 'muted' }, sub || '')), h('button', { class: 'small', onclick: fn }, label));
    }
    function showLocal() {
      const q = input.value.trim().toLowerCase();
      const items = Object.values(S.places).filter((p) => !q || (p.name + ' ' + p.address).toLowerCase().includes(q)).sort(byName);
      list.replaceChildren(...(items.length ? items.map((p) => row(p.name, p.type + (p.address ? ' · ' + p.address : ''), 'Use', () => { sh.close(); onPick(p); })) : [h('div', { class: 'empty' }, 'No saved place matches. Try Search Google.')]));
    }
    input.addEventListener('input', showLocal);
    gbtn.onclick = async () => {
      const q = input.value.trim();
      if (!q) { toast('Type something to search'); return; }
      if (!S.settings.googleKey) { gres.replaceChildren(h('div', { class: 'violations' }, 'Google Places key missing — add it in Settings.')); return; }
      gbtn.disabled = true; gbtn.textContent = 'Searching…';
      try {
        const res = await Providers.searchGoogle(q, S.settings.googleKey, bumpPlacesCalls);
        gres.replaceChildren(h('div', { class: 'card' }, res.length ? res.map((r) => row(r.name, r.address, 'Save & use', async () => { const p = await savePlaceFromSearch(r); sh.close(); onPick(p); })) : h('div', { class: 'empty' }, 'Google found nothing.')));
      } catch (e) {
        gres.replaceChildren(h('div', { class: 'violations' }, e.message));
      } finally { gbtn.disabled = false; gbtn.textContent = 'Search Google'; }
    };
    sh.body.append(input, list, gbtn, gres, h('div', { class: 'sticky-actions' }, h('button', { onclick: sh.close }, 'Cancel')));
    showLocal();
    setTimeout(() => input.focus(), 50);
  }

  // ---------- job helpers ----------
  const pName = (id) => (S.places[id] ? S.places[id].name : '(deleted place)');
  function jobTitle(j) {
    if (j.errandPlaceId) return h('span', null, 'Errand @ ', pName(j.errandPlaceId), ' (', j.dwellMin != null ? j.dwellMin : S.places[j.errandPlaceId] ? S.places[j.errandPlaceId].dwellMin : 10, ' min)');
    const pk = (j.pickups || []).map((p) => (p.done ? '✓ ' : '') + pName(p.placeId) + (p.item ? ' (' + p.item + ')' : ''));
    const left = pk.length ? pk.join(' + ') : 'In hand';
    return h('span', null, left, ' → ', j.deliveryPlaceId ? pName(j.deliveryPlaceId) : 'collect only');
  }
  const pendingJobs = () => S.jobs.filter((j) => !j.status || j.status === 'pending');
  const urgentSorted = () => pendingJobs().filter((j) => j.urgent).sort((a, b) => (a.urgentRank || 0) - (b.urgentRank || 0));

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
  function renderPlan(v) {
    const places = Object.values(S.places).sort(byName);
    const startSel = h('select', { onchange: (e) => { if (e.target.value === '__pick') { e.target.value = S.startSel; openPlacePicker((p) => { S.startSel = p.id; render(); }, 'Pick start'); } else S.startSel = e.target.value; } },
      h('option', { value: 'gps', selected: S.startSel === 'gps' }, '📍 Use my location'),
      places.map((p) => h('option', { value: p.id, selected: S.startSel === p.id }, p.name)),
      h('option', { value: '__pick' }, 'Pick another place…'));
    const endSel = h('select', { onchange: (e) => { if (e.target.value === '__pick') { e.target.value = S.endSel; openPlacePicker((p) => { S.endSel = p.id; render(); }, 'Pick end'); } else S.endSel = e.target.value; } },
      places.map((p) => h('option', { value: p.id, selected: S.endSel === p.id }, p.name)),
      h('option', { value: '__pick' }, 'Pick another place…'));
    const dep = h('input', { type: 'time', value: S.departTime, oninput: (e) => { S.departTime = e.target.value; } });

    v.append(
      h('div', { class: 'card' },
        h('label', { class: 'field' }, 'Start'), startSel,
        h('label', { class: 'field' }, 'End'), endSel,
        h('label', { class: 'field' }, 'Depart at (empty = now)'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, dep), h('button', { onclick: () => { S.departTime = ''; dep.value = ''; } }, 'Now'))),
      h('button', { class: 'primary big', id: 'planBtn', disabled: S.busy, onclick: () => doPlan({}) }, S.busy ? 'PLANNING…' : 'PLAN')
    );

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

  function jobCard(j, urgentList) {
    const parked = j.status === 'parked';
    const chips = [];
    if (j.urgent) chips.push(h('span', { class: 'chip urgent' }, 'URGENT #' + (urgentList.indexOf(j) + 1 || '–')));
    if (j.arriveAfter) chips.push(h('span', { class: 'chip' }, 'after ' + j.arriveAfter));
    if (j.arriveBefore) chips.push(h('span', { class: 'chip' }, 'before ' + j.arriveBefore));
    const arrows = j.urgent && !parked ? [
      h('button', { class: 'small', 'aria-label': 'Move up', onclick: () => moveUrgent(j, -1) }, '▲'),
      h('button', { class: 'small', 'aria-label': 'Move down', onclick: () => moveUrgent(j, 1) }, '▼')] : [];
    return h('div', { class: 'card' },
      h('div', { class: 'title' }, jobTitle(j)),
      j.notes ? h('div', { class: 'muted' }, j.notes) : null,
      h('div', null, chips),
      h('div', { class: 'row', style: 'margin-top:8px' }, arrows,
        h('button', { class: 'small', onclick: async () => { j.status = parked ? 'pending' : 'parked'; await saveJob(j); render(); } }, parked ? 'Unpark' : 'Park'),
        h('button', { class: 'small danger', onclick: async () => { if (!confirm('Delete this job?')) return; await WPStore.remove('jobs', j.id); S.jobs = S.jobs.filter((x) => x !== j); render(); } }, 'Delete')));
  }

  // ---------- Add job sheet ----------
  function openJobSheet() {
    let mode = 'delivery';
    const st = { pickups: [{ placeId: null, item: '' }], deliveryPlaceId: null, errandPlaceId: null, dwellMin: '', notes: '', urgent: false, after: '', before: '' };
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
      S.plan = { ctx: { start, end, jobs, places, departAtISO: input.departAtISO, matrices: got.matrices }, noDetour: replan ? prevNoDetour : false, idx: 0, status: {}, prompt: null, shiftMs: 0, provider: { calls: got.calls, fromCache: got.fromCache, partial: !!got.partial } };
      solveCurrent();
      banner('Travel times: TomTom live traffic — ' + (got.fromCache ? 'from session cache (0 calls)' : got.calls + ' calls') + (got.partial ? ' · some legs missing, treated as very long' : '') + '.', 'info');
      S.tab = 'route';
    } catch (e) {
      banner(e.message || String(e), 'error');
    } finally {
      S.busy = false;
      render();
    }
  }

  function solveCurrent() {
    const p = S.plan;
    const c = p.ctx;
    p.result = Solver.solve({ start: c.start, end: c.end, jobs: c.jobs, places: c.places, matrices: c.matrices, departAtISO: c.departAtISO, noDetour: p.noDetour });
    p.idx = 0;
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
  function stopMessage(stop, shiftMs) {
    const place = S.plan.ctx.places[stop.placeId] || S.places[stop.placeId];
    const items = stop.actions.filter((a) => a.kind === 'deliver').map((a) => a.item).filter(Boolean).join(', ');
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
    const remaining = plan.stops.filter((s) => !P.status[s.placeId]);

    v.append(
      h('div', { class: 'card' },
        h('div', { class: 'totals' },
          h('div', null, h('b', null, totalStops), h('span', { class: 'muted' }, 'stops')),
          h('div', null, h('b', null, Solver.formatDuration(plan.totalSec)), h('span', { class: 'muted' }, 'total')),
          h('div', null, h('b', null, fmt(plan.endArrival)), h('span', { class: 'muted' }, 'arrive ' + (ctx.end.name || 'end')))),
        h('div', { class: 'muted', style: 'margin-top:8px' }, 'Depart ' + fmt(Date.parse(ctx.departAtISO)) + ' · ' + (r.stats ? r.stats.nodes + ' nodes, ' + r.stats.ms + ' ms' + (r.stats.truncated ? ' (time-limited, best found)' : '') : '')),
        P.shiftMs > 60000 ? h('div', { class: 'chip detour' }, 'Running ' + Math.round(P.shiftMs / 60000) + ' min behind plan') : null),
      h('label', { class: 'toggle card' }, h('input', { type: 'checkbox', checked: P.noDetour, onchange: (e) => { P.noDetour = e.target.checked; solveCurrent(); banner('Re-solved from cached travel times — 0 API calls.', 'info'); render(); } }), 'No detour (urgent deliveries first, nothing else in between)'));

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
    v.append(navRow);

    if (Object.values(P.status).includes('skipped')) v.append(h('div', { class: 'prompt' }, 'A stop was skipped. ', h('button', { class: 'small', onclick: () => replanFromHere() }, 'Replan from here')));
    if (P.prompt) {
      const stop = plan.stops.find((s) => s.placeId === P.prompt.placeId);
      const place = S.places[P.prompt.placeId];
      if (stop && place) {
        v.append(h('div', { class: 'prompt' }, h('div', { class: 'title' }, 'Send ETA to ' + place.name + '?'),
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

    // alternatives
    if (r.plans.length > 1) {
      v.append(h('details', null, h('summary', null, 'Alternatives (' + (r.plans.length - 1) + ')'),
        r.plans.map((alt, i) => i === P.idx ? null : h('div', { class: 'card' },
          h('div', { class: 'row spread' }, h('b', null, 'Plan ' + (i + 1) + ' · ' + Solver.formatDuration(alt.totalSec)), h('span', { class: 'times' }, '→ ' + fmt(alt.endArrival))),
          h('div', { class: 'muted' }, alt.order.map(pName).join(' → ')),
          alt.violations.length ? h('div', { class: 'chip closed' }, alt.violations.length + ' window issue(s)') : null,
          h('button', { class: 'small', style: 'margin-top:8px', onclick: () => { P.idx = i; render(); } }, 'Use this plan')))));
    }
  }

  function stopCard(stop, i) {
    const P = S.plan;
    const place = S.places[stop.placeId] || P.ctx.places[stop.placeId];
    const st = P.status[stop.placeId];
    const hasDelivery = stop.actions.some((a) => a.kind === 'deliver');
    const chips = stop.actions.map((a) => {
      const label = a.kind === 'pickup' ? 'Collect: ' + (a.item || 'items') : a.kind === 'deliver' ? 'Deliver' + (a.item ? ': ' + a.item : '') : 'Errand: ' + (a.item || '');
      return h('span', { class: 'chip ' + (a.kind === 'deliver' ? 'deliver' : a.kind === 'errand' ? 'errand' : '') }, label);
    });
    if (stop.detour) chips.push(h('span', { class: 'chip detour' }, 'DETOUR'));
    if (stop.closedWarning) chips.push(h('span', { class: 'chip closed' }, 'CLOSED'));
    const nav = S.settings.nav || 'waze';
    const btns = [];
    if (nav === 'waze' || nav === 'both') btns.push(h('a', { class: 'btn small', href: wazeUrl(place), target: '_blank', rel: 'noopener' }, 'WAZE'));
    if (nav === 'google' || nav === 'both') btns.push(h('a', { class: 'btn small', href: gmapsUrl(P.ctx.start, place, []).replace(/origin=[^&]*&/, ''), target: '_blank', rel: 'noopener' }, 'MAPS'));
    if (hasDelivery) btns.push(h('button', { class: 'small', onclick: () => { const m = stopMessage(stop, P.shiftMs); shareMessage(m.place, m.text); } }, 'MSG'));
    if (!st) {
      btns.push(h('button', { class: 'small ok', onclick: () => markDone(stop, i) }, 'DONE'));
      btns.push(h('button', { class: 'small', onclick: () => { P.status[stop.placeId] = 'skipped'; toast('Skipped — actions stay pending. Replan to refresh.'); render(); } }, 'SKIP'));
    } else {
      btns.push(h('span', { class: 'chip' }, st === 'done' ? '✓ Done' : 'Skipped'));
    }
    return h('div', { class: 'card stop ' + (st || '') + (stop.detour ? ' detour' : '') },
      h('div', { class: 'row spread' }, h('div', { class: 'title' }, (i + 1) + '. ' + place.name), h('div', { class: 'times' }, fmt(stop.arriveAt) + ' → ' + fmt(stop.departAt))),
      place.address ? h('div', { class: 'muted' }, place.address) : null,
      stop.waitSec > 60 ? h('div', { class: 'muted' }, 'Wait ~' + Math.round(stop.waitSec / 60) + ' min for the time window to open') : null,
      h('div', null, chips),
      h('div', { class: 'row', style: 'margin-top:8px' }, btns));
  }

  async function markDone(stop, i) {
    const P = S.plan;
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
    P.status[stop.placeId] = 'done';
    P.shiftMs = Math.max(0, Date.now() - stop.departAt);
    // offer to send the ETA to the next stop if it is a delivery and has a WhatsApp number
    const plan = P.result.plans[P.idx];
    const next = plan.stops.slice(i + 1).find((s) => !P.status[s.placeId]);
    P.prompt = null;
    if (next && next.actions.some((a) => a.kind === 'deliver')) {
      const np = S.places[next.placeId];
      if (np && np.whatsapp) P.prompt = { placeId: next.placeId };
    }
    if (!plan.stops.some((s) => !P.status[s.placeId])) toast('Run complete 🎉');
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
        h('div', { class: 'muted' }, 'Dwell ' + p.dwellMin + ' min' + (p.whatsapp ? ' · WA ' + p.whatsapp : '') + ((p.closedWindows || []).length ? ' · closed ' + p.closedWindows.map((w) => w.from + '–' + w.to).join(', ') : '')))) : [h('div', { class: 'empty card' }, 'No places yet.')]));
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
    const type = h('select', { onchange: (e) => { dwell.value = String(S.settings.dwellDefaults[e.target.value] != null ? S.settings.dwellDefaults[e.target.value] : 10); } }, TYPES.map((t) => h('option', { value: t, selected: p.type === t }, t)));
    const wa = h('input', { type: 'tel', inputmode: 'tel', value: p.whatsapp || '', placeholder: '012-345 6789' });
    const sal = h('select', null, ['Encik', 'Puan', 'Cik'].map((t) => h('option', { value: t, selected: (p.salutation || 'Encik') === t }, t)));
    const lang = h('select', null, [['default', 'Default (' + S.settings.defaultLang + ')'], ['ms', 'Bahasa Malaysia'], ['en', 'English']].map(([val, lab]) => h('option', { value: val, selected: (p.lang || 'default') === val }, lab)));
    const wBox = h('div');
    function drawW() {
      wBox.replaceChildren(...w.map((x, i) => h('div', { class: 'row', style: 'margin-bottom:6px' },
        h('div', { class: 'grow' }, h('input', { type: 'time', value: x.from, oninput: (e) => { x.from = e.target.value; } })),
        h('div', { class: 'grow' }, h('input', { type: 'time', value: x.to, oninput: (e) => { x.to = e.target.value; } })),
        h('button', { class: 'small danger', onclick: () => { w.splice(i, 1); drawW(); } }, '✕'))));
    }
    drawW();
    sh.body.append(
      h('label', { class: 'field' }, 'Name'), name, h('label', { class: 'field' }, 'Address'), addr,
      h('label', { class: 'field' }, 'Type'), type, h('label', { class: 'field' }, 'Dwell (minutes)'), dwell,
      h('label', { class: 'field' }, 'Closed windows (warning only)'), wBox,
      h('button', { class: 'small', onclick: () => { w.push({ from: '12:00', to: '13:00' }); drawW(); } }, '+ Add closed window'),
      h('label', { class: 'field' }, 'WhatsApp number'), wa,
      h('label', { class: 'field' }, 'Salutation'), sal, h('label', { class: 'field' }, 'Message language'), lang,
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
          Object.assign(p, { name: name.value.trim(), address: addr.value.trim(), type: type.value, dwellMin: Number(dwell.value) || 0, closedWindows: w.filter((x) => x.from && x.to), whatsapp: wa.value.trim(), salutation: sal.value, lang: lang.value });
          await savePlace(p); sh.close(); render();
        } }, 'Save')));
  }

  // ---------- SETTINGS tab ----------
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
      h('div', { class: 'muted', style: 'text-align:center' }, 'L-Tech Waypoint v' + APP_VERSION));
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
      for (const p of data.places) await savePlace(p);
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
  });

  load().then(() => {
    render();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  }).catch((e) => banner('Startup failed: ' + e.message, 'error'));

  window.WaypointDebug = { S, doPlan, render };
})();
