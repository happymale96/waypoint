/* L-Tech Waypoint — app.js (UI). Depends on WPStore, Solver, Messages, Budget, TravelTimes, Providers. */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
  const BUILD_STAMP = '528bab74'; // written by tools/stamp-sw.js (content hash of the app shell)
  const TYPES = ['factory', 'supplier', 'office', 'home', 'other'];
  const DEFAULT_DWELL = { factory: 30, supplier: 10, other: 10, office: 10, home: 0 };

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
    loose: [], // items collected by a collect-only job, still with the driver (ITEMS WITH YOU below); collection "loose", in Export / Import
    tt: { down: false, lastLiveAt: null, status: null, noRoute: 0, planSess: null }, // status: the last failed answer's HTTP status; noRoute: 400 answers seen // TomTom: out (limit / unavailable) since the last failed call; the last live re-time (TOMTOM below)
    mem: null, // the learned travel times (TravelTimes pair memory), meta:travelMemory, in Export / Import
  };

  function defaultSettings() {
    return {
      googleKey: '', tomtomKey: '', defaultLang: 'ms',
      templates: Object.assign({}, Messages.DEFAULT_TEMPLATES),
      etaPaddingMin: 10, dwellDefaults: Object.assign({}, DEFAULT_DWELL),
      nav: 'waze', seeded: false, driverName: 'Calvin',
      usage: {}, // {routing, matrix, places}: requests per day and per UTC month on this device (Budget.bump), in Export / Import
      ttService: 'routing', // Settings -> TomTom service: 'routing' (default, Routing API) | 'matrix' (Matrix Routing v2)
      ttAllowance: Budget.ROUTING_ALLOWANCE, // TomTom Routing requests per month (free plan 20,000)
      afterStop: 'auto', // After each stop, look for a faster order: 'auto' (switch automatically) | 'ask' | 'off'
      fullRefreshMax: TravelTimes.FULL_REFRESH_MAX, // look-ahead: this many pending stops or fewer -> every needed pair is refreshed
      fuelBrand: 'Caltex', fuelDwellMin: 7, fuelMaxSearches: 50,
      autoReach: true, // mark Reached automatically within autoReachM metres and stopped (app open); stored on the device, in Export / Import
      autoReachM: Reached.RADIUS_M, // Settings -> Auto-Reached distance (m), whole number 30..300, default 80
      keepScreenOn: true, // Settings -> Keep screen on while a day is running (Screen Wake Lock; wakelock.js)
      proofCaptionFirst: false, // Settings -> Proof of delivery -> Send caption with first photo (2 steps): SEND TO GROUP in two shares
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
    delete s.tomtomUsage; // the old daily counter (replaced by settings.usage)
    // once per device: the learned samples saved before the historic-only rule (03077b48 stored the live figure) can't be told
    // from the later ones, so all of them go once (flag meta/migrations.learnedClear2026_11_24); places, jobs, days and counters untouched
    try { await TravelTimes.runLearnedClearOnce(WPStore); } catch (e) { /* never block the launch */ }
    try { S.mem = TravelTimes.normaliseMemory(await WPStore.get('meta', 'travelMemory')); } catch (e) { S.mem = TravelTimes.emptyMemory(); }
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
    const dwellRes = await runDwellMigration(false); // once per device (flag in meta/migrations)
    await runPinMigration(false); // once per device: every office-type place is pinned (no toast)
    await runTomTomMigration(); // once per device: TomTom service = Routing; the Bahasa Malaysia template's old default -> the new one
    await runPlacesRepair(); // once per device: Google Places "this month" never below "today"
    await runAutoReachMigration(); // once per device: Auto-Reached distance = 80 m
    try { await runFuelStationsClean(); } catch (e) { /* never block the launch */ } // once per device: no shops in the station memory
    await loadDays();
    S.loose = (await WPStore.list('loose')).filter((x) => x && x.id);
    await backfillLoose(); // once: today's / the latest closed day's collect-only jobs get their loose item
    await restorePlan(); // the Route tab comes back exactly as it was left
    if (dwellRes && dwellRes.changed) { dwellToPlan(); toast(dwellToastText(dwellRes)); }
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

  // One-time dwell migration (Geo.migrateDwell): supplier places 10 min, customer factories 30, the new-place defaults, ETA padding 10.
  // Guarded by the flag meta/migrations.dwell2026_11_23. force = an Import of data that predates the flag: runs on what was imported.
  // Returns null when it did not run, else {suppliers, customers, changed}.
  async function runDwellMigration(force) {
    const rec = (await WPStore.get('meta', 'migrations')) || { done: [] };
    if (rec[Geo.DWELL_FLAG] && !force) return null;
    const res = Geo.migrateDwell({ places: Object.values(S.places), settings: { dwellDefaults: S.settings.dwellDefaults, etaPaddingMin: S.settings.etaPaddingMin }, migrations: {} });
    for (const p of res.state.places) if (S.places[p.id].dwellMin !== p.dwellMin) await savePlace(p);
    S.settings.dwellDefaults = res.state.settings.dwellDefaults;
    S.settings.etaPaddingMin = res.state.settings.etaPaddingMin;
    await saveSettings();
    rec[Geo.DWELL_FLAG] = true;
    await WPStore.set('meta', 'migrations', rec);
    return res;
  }
  // One-time pin migration (Geo.migratePins): every saved place of type "office" gets pinned = true, nothing else. Flag meta/migrations.pinOffice2026_11_24.
  async function runPinMigration(force) {
    const rec = (await WPStore.get('meta', 'migrations')) || { done: [] };
    if (rec[Geo.PIN_FLAG] && !force) return null;
    const res = Geo.migratePins({ places: Object.values(S.places), migrations: {} });
    for (const p of res.state.places) if (!!S.places[p.id].pinned !== !!p.pinned) { S.places[p.id].pinned = true; await savePlace(S.places[p.id]); }
    const rec2 = (await WPStore.get('meta', 'migrations')) || { done: [] }; // read again: the dwell migration may have just written it
    rec2[Geo.PIN_FLAG] = true;
    await WPStore.set('meta', 'migrations', rec2);
    return res;
  }
  // One-time (2026-11-24): every existing device moves to the Routing API (Matrix Routing's monthly allowance is used up), and
  // the Bahasa Malaysia template becomes the owner's own wording if it is still exactly the old default (an edited one stays).
  const TT_FLAG = 'ttRouting2026_11_24';
  const PLACES_FLAG = 'placesMonth2026_11_24';
  async function runTomTomMigration() {
    const rec = (await WPStore.get('meta', 'migrations')) || { done: [] };
    let changed = false;
    if (!rec[TT_FLAG]) { S.settings.ttService = 'routing'; rec[TT_FLAG] = true; changed = true; }
    if (!rec[Messages.TEMPLATE_FLAG]) { S.settings.templates = Messages.migrateTemplates(S.settings.templates).templates; rec[Messages.TEMPLATE_FLAG] = true; changed = true; }
    if (!changed) return;
    await saveSettings();
    await WPStore.set('meta', 'migrations', rec);
  }
  // One-time (2026-11-25, flag meta/migrations.autoReach80_2026_11_25): the Auto-Reached distance is set to 80 m on every device that
  // already has the app (it behaved like 150 m before). A distance changed later in Settings is never touched again.
  async function runAutoReachMigration() {
    const rec = (await WPStore.get('meta', 'migrations')) || { done: [] };
    if (rec[Reached.RADIUS_FLAG]) return;
    S.settings.autoReachM = Reached.RADIUS_M;
    await saveSettings();
    rec[Reached.RADIUS_FLAG] = true;
    await WPStore.set('meta', 'migrations', rec);
  }
  // One-time (2026-11-26, flag meta/migrations.fuelStationsClean2026_11_26): the station memory (the app's own cache, never the
  // Places tab) loses the shops saved as stations ("ZUS Coffee - Caltex Pajam") and keeps one of two duplicate entries (40 m, or 150 m with the same name)
  // (Fuel.cleanStations). Only meta/fuelStations is written: a fuel stop in today's route (plan ctx.places) and the day history are untouched.
  async function runFuelStationsClean() {
    const r = await Fuel.cleanStationsOnce(WPStore, fuelBrand());
    if (r) S.fuelStations = r.list;
  }
  const dwellToastText = (r) => 'Updated: ' + r.suppliers + ' supplier places to 10 min, ' + r.customers + ' customer places to 30 min, ETA padding to 10 min';
  // An active plan: the stops not done take the new place dwell; the next re-time (existing path) moves the times. The order is kept.
  function dwellToPlan() {
    const plan = curPlan();
    if (!plan || !plan.model || !plan.model.dwellSec) return;
    plan.stops.forEach((s) => {
      const pl = S.places[s.placeId];
      if (!pl || s.fuel || s.status === 'done' || plan.model.dwellSec[s.placeId] == null) return;
      const placeDwell = Number(pl.dwellMin) * 60;
      let errand = null, hasOther = false;
      (s.actions || []).forEach((a) => {
        if (a.kind !== 'errand') { hasOther = true; return; }
        const j = S.jobs.find((x) => x.id === a.jobId);
        if (j && j.dwellMin != null && j.dwellMin !== '') errand = Math.max(errand || 0, Number(j.dwellMin));
      });
      plan.model.dwellSec[s.placeId] = errand != null ? (hasOther ? Math.max(placeDwell, errand * 60) : errand * 60) : placeDwell;
    });
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
  // One record (settings.usage.places) holds today AND this month, bumped through Budget like every TomTom request.
  function bumpPlacesCalls() {
    S.settings.usage = Budget.countPlaces(S.settings.usage, Date.now());
    saveSettings();
  }
  const placesCallsToday = () => Budget.placesCount(S.settings.usage, Date.now()).today;
  // One-time (flag meta/migrations.placesMonth2026_11_24): today used to come from the old settings.placesCallsToday and
  // this month from usage.places; raise this month to today where it is lower (never lowers), then drop the old counter.
  async function runPlacesRepair() {
    const rec = (await WPStore.get('meta', 'migrations')) || { done: [] };
    if (rec[PLACES_FLAG]) return;
    const r = Budget.repairPlacesMonth(S.settings.usage, S.settings.placesCallsToday, Date.now());
    S.settings.usage = r.usage;
    delete S.settings.placesCallsToday;
    await saveSettings();
    rec[PLACES_FLAG] = true;
    await WPStore.set('meta', 'migrations', rec);
  }

  // ---------- TOMTOM (rules: budget.js; travel times: traveltimes.js) ----------
  // Every TomTom response is counted per day and per UTC month (settings.usage: routing / matrix; Places in the same record).
  // From 90% of the monthly Routing allowance the automatic live re-times (visible, the 10-minute tick) and the after-stop
  // look-ahead pause for the rest of the month. A 401 / 403 / 429 (after retries) / 5xx / unreachable answer sets S.tt.down:
  // ONE notice on the Plan and Route tabs; PLAN uses estimated times; the next successful call clears it.
  const TT = TravelTimes;
  const ttAllowance = () => Budget.allowanceOf(S.settings.ttAllowance);
  const ttGuard = () => Budget.guardHit(S.settings.usage, Date.now(), ttAllowance());
  const ttService = () => (S.settings.ttService === 'matrix' ? 'matrix' : 'routing');
  function ttRepaint() { if ((S.tab === 'route' || S.tab === 'plan') && !S.busy && !document.querySelector('.backdrop')) render(); }
  Providers.setTomTomHook({
    count(kind, n) {
      const wasGuard = ttGuard();
      S.settings.usage = Budget.bump(S.settings.usage, kind === 'matrix' ? 'matrix' : 'routing', Date.now(), n);
      saveSettings();
      if (!wasGuard && ttGuard()) ttRepaint();
    },
    ok() { if (S.tt.down) { S.tt.down = false; ttRepaint(); } },
    down(status) { S.tt.status = status != null ? status : null; if (!S.tt.down) { S.tt.down = true; ttRepaint(); } },
    bad() { S.tt.noRoute++; }, // a 400 (no route for that leg): that pair uses an estimate; the plan says so in the one notice
  });
  // TomTom counts as out while the last call failed, or while the current plan was made on estimates because TomTom refused
  const ttOut = () => S.tt.down || !!(S.plan && S.plan.provider && S.plan.provider.refused && S.plan.provider.estimatedOrder);
  function ttNotice() { // the ONE TomTom notice (down wins over the guard); the guard one only on the Route tab
    const pv = S.plan && S.plan.provider;
    if (ttOut()) return h('div', { class: 'tt-notice down', id: 'ttNotice', role: 'status' }, Budget.downNotice(S.tt.down ? S.tt.status : pv && pv.downStatus));
    if (pv && pv.noRoute) return h('div', { class: 'tt-notice down', id: 'ttNotice', role: 'status' }, Budget.NO_ROUTE_MSG);
    if (S.tab === 'route' && ttGuard()) return h('div', { class: 'tt-notice', id: 'ttNotice', role: 'status' }, Budget.GUARD_MSG);
    return null;
  }
  // Is a live re-time (one TomTom request) allowed for this trigger now? Moves the throttle when it is.
  function liveDue(trigger) {
    const d = Budget.retimeDecision({ lastAt: S.tt.lastLiveAt }, { type: trigger, at: Date.now(), visible: document.visibilityState === 'visible', pending: hasPendingStop(curPlan()), guard: ttGuard() });
    if (d.call) S.tt.lastLiveAt = d.state.lastAt;
    return d.call;
  }
  // one leg from the chosen TomTom service -> {seconds, metres, typicalSeconds}; onCount(n) = every HTTP attempt (Routing)
  function ttLeg(a, b, departMs, onCount) {
    return ttService() === 'matrix' ? Providers.matrixLeg(a, b, departMs, S.settings.tomtomKey) : Providers.routeLeg(a, b, departMs, S.settings.tomtomKey, onCount);
  }
  // ONE PLAN's TomTom requests, from the PLAN tap to the end of the Route tab's first re-time (TT.planSession): the banner
  // number is every request it sent (a 429's retry included, as the Usage counter counts it), an identical request is
  // answered from memory, a learned sample is kept once per pair.
  const planFetch = (sess) => TT.sessionFetch(sess, ttLeg, Providers.legKey);
  function planBannerShow() { // (re)paint the PLAN banner with the session's count, only while it is still the one shown
    const pb = S.planBanner;
    if (!pb) return;
    const b = document.getElementById('banner'), text = TT.bannerText(pb.sess.requests, pb.live, pb.checked);
    if (pb.text != null && (!b || b.hidden || (b.firstChild && b.firstChild.textContent) !== pb.text)) return; // replaced or closed
    pb.text = text;
    banner(text, 'info');
  }
  // The learned travel times (meta:travelMemory, in Export / Import). A point within 150 m of a saved place IS that place.
  const saveMemory = () => WPStore.set('meta', 'travelMemory', S.mem).catch(() => {});
  function nodeOf(key, p, pid) {
    const id = pid != null && S.places[pid] ? pid : TT.snap(p, Object.values(S.places));
    return { key, pid: id, lat: p.lat, lng: p.lng };
  }
  // a delivery never goes before its own (pending) pickup: those reversed pairs are never fetched (stop keys: a second visit
  // to the First stop's place is its own key)
  const linksOf = (jobs, places) => Solver.linksOf(Solver.buildStops(jobs, places || S.places));

  // ---------- First stop / second visit (solver.js) ----------
  // A stop key '<placeId>#2' is a second visit to that saved place: same coordinates, its own card. Its place sits in
  // ctx.places under that key (a copy of the saved place), so every "S.places[id] || ctx.places[id]" lookup finds it.
  const baseId = (id) => Solver.baseId(id);
  function addVisitPlaces(places, stopIds) {
    (stopIds || []).forEach((k) => { const b = baseId(k); if (b !== k && places[b] && !places[k]) places[k] = Object.assign({}, places[b], { id: k }); });
    return places;
  }
  // The jobs the solver gets on a running day (copies; S.jobs untouched): a First stop already made or skipped has no further
  // effect (its job's flag is dropped), and a delivery that sits in a pending second visit keeps that visit (visit2).
  function planJobs(jobs, plan) {
    if (!plan) return jobs;
    const spent = new Set(), v2 = {};
    plan.stops.forEach((s) => {
      if (s.first && s.status) (s.actions || []).forEach((a) => spent.add(a.jobId));
      if (!s.status && s.visitOf) (s.actions || []).forEach((a) => { if (a.kind === 'deliver') v2[a.jobId] = s.visitOf; });
    });
    return jobs.map((j) => {
      const drop = j.firstStop && spent.has(j.id);
      if (!drop && !v2[j.id]) return j;
      const c = Object.assign({}, j);
      if (drop) delete c.firstStop;
      if (v2[j.id]) c.visit2 = v2[j.id];
      return c;
    });
  }
  let curEst = { stops: new Set(), end: false }; // which ETAs on the Route tab carry "est." (set by renderRoute)
  const estMark = (on) => (on ? ' est.' : '');

  // ---------- place picker (single autocomplete box) ----------
  const searchDup = (r) => Object.values(S.places).find((p) => Math.abs(p.lat - r.lat) < 1e-4 && Math.abs(p.lng - r.lng) < 1e-4);
  // A NEW place from Google search is saved with the type the driver taps (askPlaceType); its stop time is that type's
  // default (newPlace), and MSG follows the type as everywhere. A place already saved is returned as it is.
  async function savePlaceFromSearch(r, type) {
    const dup = searchDup(r);
    if (dup) return dup;
    const p = newPlace({ name: r.name, address: r.address, lat: r.lat, lng: r.lng, type });
    await savePlace(p);
    return p;
  }
  // One sheet titled with the place name, one button per place type of the place form (TYPES, Messages.typeLabel), nothing
  // preselected. A tap -> onType(type); dismissing (backdrop / Cancel) calls nothing, so nothing is saved.
  const capFirst = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  function askPlaceType(name, onType) {
    let picked = false;
    const sh = openSheet(name || 'New place');
    sh.sheet.id = 'placeTypeSheet';
    sh.body.append(h('div', { class: 'muted' }, 'What kind of place is this?'),
      h('div', { class: 'type-btns' }, TYPES.map((t) => h('button', { type: 'button', class: 'type-btn', 'data-type': t,
        onclick: () => { if (picked) return; picked = true; sh.close(); onType(t); } }, capFirst(Messages.typeLabel(t))))),
      h('button', { type: 'button', class: 'type-cancel', style: 'margin-top:8px', onclick: sh.close }, 'Cancel'));
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
    // pinned places first (name order, also while typing), then the normal matches without repeating a pinned place
    const localMatches = (q) => Geo.pickerOrder(Object.values(S.places), q);
    const textMatches = (q) => { // how many saved places match the text itself (a pinned place that does not match does not count)
      const ql = q.toLowerCase();
      return Object.values(S.places).filter((p) => !ql || (p.name + ' ' + p.address).toLowerCase().includes(ql)).length;
    };
    const choose = (p) => { sh.close(); onPick(p); };
    const row = (name, sub, fn, pinned) => h('button', { class: 'pick-row' + (pinned ? ' pinned' : ''), onclick: fn },
      h('span', { class: 'title' }, pinned ? h('span', { class: 'pin-glyph', 'aria-label': 'Pinned', title: 'Pinned' }, '📌') : null, pinned ? ' ' : null, name), h('span', { class: 'muted' }, sub || ''));

    function paint() {
      const q0 = input.value.trim();
      // optional fixed rows (e.g. "Use my location" for the start chip) shown while the box is empty
      const kids = (extras && !q0 ? extras.map((x) => row(x.label, '', () => { sh.close(); x.fn(); })) : [])
        .concat(localMatches(q0).map((p) => row(p.name, Messages.typeLabel(p.type) + (p.address ? ' · ' + p.address : ''), () => choose(p), !!p.pinned)));
      if (g.state === 'done' && g.results.length) {
        kids.push(h('div', { class: 'divider' }, 'Google'));
        g.results.forEach((r) => kids.push(row(r.name, r.address, () => {
          if (busy) return;
          const dup = searchDup(r);
          if (dup) { choose(dup); return; } // already saved: not asked again, not changed
          sh.close(); // then ask the type; dismissing saves nothing and onPick is never called (the field stays empty)
          askPlaceType(r.name, async (t) => {
            if (busy) return;
            busy = true;
            try { onPick(await savePlaceFromSearch(r, t)); } finally { busy = false; }
          });
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
      if (q.length >= 3 && !textMatches(q)) timer = setTimeout(() => googleSearch(q), 800);
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
    const pin = h('input', { type: 'checkbox', id: 'manualPin', style: 'width:auto;min-height:0' });
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
      if (pin.checked) p.pinned = true;
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
      h('label', { class: 'check-row' }, pin, ' Pin to top of search'),
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

  // ---------- ITEMS WITH YOU (the rules live in onboard.js) ----------
  // A slim bar on the Plan and Route tabs: "With you: N item(s)", tap to expand. A collect-only job marked DONE leaves a LOOSE
  // item (not a job, never counted as one, not cleared by End day) with two buttons: Dropped off (Undo) and Deliver to… (opens the
  // add-job form in in-hand mode; saving it converts the loose item into that job). Items of a pending delivery job show "→ destination".
  const placeNameOf = (id) => dName(pName(id));
  const boardState = () => ({ jobs: S.jobs, loose: S.loose, nameOf: placeNameOf });
  const onBoardNow = () => OnBoard.onBoard(boardState(), Date.now());
  async function setLoose(next) { // keep S.loose and the stored collection in step (changed items written, removed ones deleted)
    const before = S.loose;
    S.loose = next;
    for (const it of next) { const old = before.find((x) => x.id === it.id); if (!old || JSON.stringify(old) !== JSON.stringify(it)) await WPStore.set('loose', it.id, it); }
    for (const old of before) if (!next.some((x) => x.id === old.id)) await WPStore.remove('loose', old.id);
  }
  let boardOpen = false;
  // after a job was edited on a day that has a plan: the route is NOT re-planned by itself; this line stays until the next PLAN
  const JOBS_CHANGED_TEXT = 'Jobs changed - tap PLAN to update the route';
  // the After rules the last PLAN could not keep (Solver afterRules): the red banner, one line per impossible rule, until the next PLAN
  const afterBanner = () => (S.plan && (S.plan.afterConflicts || []).length && !routeClosed()
    ? h('div', { class: 'violations after-banner', id: 'afterBanner', role: 'alert' }, S.plan.afterConflicts.map((t) => h('div', null, t))) : null);
  const jobsChangedNote = () => (S.plan && S.plan.jobsChanged ? h('div', { class: 'jobs-changed', id: 'jobsChangedNote', role: 'status' }, JOBS_CHANGED_TEXT) : null);
  function onBoardBar() {
    const items = onBoardNow();
    if (!items.length) return null;
    return h('div', { class: 'onboard', id: 'onBoardBar' },
      h('button', { class: 'ob-head', id: 'onBoardToggle', type: 'button', 'aria-expanded': String(boardOpen), onclick: () => { boardOpen = !boardOpen; render(); } },
        h('span', null, OnBoard.barLabel(items.length)), h('span', { class: 'ob-chev', 'aria-hidden': 'true' }, boardOpen ? '▴' : '▾')),
      boardOpen ? h('div', { class: 'ob-list', id: 'onBoardList' }, items.map(boardRow)) : null);
  }
  function boardRow(it) {
    const when = it.fromAt ? OnBoard.whenLabel(it.fromAt) : '';
    const src = it.from ? 'from ' + dName(it.from) + (when ? ' · ' + when : '') : (it.kind === 'inhand' ? 'in hand' : '');
    const sub = [src, it.to ? '→ ' + dName(it.to) : ''].filter(Boolean).join(' ');
    return h('div', { class: 'ob-row', 'data-kind': it.kind },
      h('div', { class: 'ob-text' }, h('div', { class: 'ob-name' }, it.item || '(item)'), sub ? h('div', { class: 'muted ob-sub' }, sub) : null),
      it.kind === 'loose' ? h('div', { class: 'ob-btns' },
        h('button', { class: 'small', type: 'button', 'data-act': 'drop', onclick: () => looseDrop(it.looseId) }, 'Dropped off'),
        h('button', { class: 'small', type: 'button', 'data-act': 'deliver', onclick: () => looseDeliver(it.looseId) }, 'Deliver to…')) : null);
  }
  // the day event of a drop-off (only when the day has a record; the summary's "Dropped off" line comes from the loose store itself)
  function logDropoff(kind, it, at, place) {
    try {
      const day = dayFor(at, false);
      if (!day) return null;
      const info = { nowIso: iso(at), looseId: it.id, item: it.item, place: place || '' };
      const ev = kind === 'drop' ? DL.recordDropoff(day, info) : DL.recordUndoDropoff(day, info);
      bgSaveDay(day);
      return { day, ev };
    } catch (e) { return null; }
  }
  async function looseDrop(id) {
    const it = S.loose.find((x) => x.id === id);
    if (!it || it.status === 'dropped') return;
    const at = Date.now();
    await setLoose(OnBoard.dropOff(S.loose, id, at, ''));
    const logged = logDropoff('drop', it, at, '');
    toastUndo('Dropped off: ' + (it.item || '(item)'), () => looseUndoDrop(id, at));
    render();
    try { // where it was left: a fresh fix within 150 m of a saved place (never prompts, never blocks the tap)
      const f = await quickFix(false, true);
      const pl = f.ok ? OnBoard.nearestPlace(f, Object.values(S.places), OnBoard.DROP_RADIUS_M) : null;
      if (!pl) return;
      await setLoose(OnBoard.setDropPlace(S.loose, id, at, pl.name));
      if (logged) { logged.ev.place = pl.name; bgSaveDay(logged.day); }
    } catch (e) { /* the item is dropped off either way */ }
  }
  async function looseUndoDrop(id, at) {
    const it = S.loose.find((x) => x.id === id);
    if (!it || it.status !== 'dropped' || Date.parse(it.droppedAt) !== at) return;
    await setLoose(OnBoard.undoDrop(S.loose, id));
    logDropoff('undo', it, Date.now(), '');
    render();
  }
  function looseDeliver(id) {
    const it = S.loose.find((x) => x.id === id);
    if (it) openJobSheet({ looseId: it.id, item: it.item, notes: it.notes });
  }
  // once, on the first load after this update: collect-only jobs done today / on the most recent closed day get their loose item
  async function backfillLoose() {
    try {
      const keys = OnBoard.backfillKeys(DL.dateKey(Date.now()), Object.values(S.days).map((d) => ({ date: d.date, closed: !!d.closed })));
      const rows = [];
      keys.forEach((k) => {
        if (!S.days[k]) return;
        DL.summarise(S.days[k], S.jobs, S.places).rows.forEach((r) => { if (r.type === 'collect' && r.complete && r.doneMs != null) rows.push({ jobId: r.jobId, item: r.item, from: r.from, doneMs: r.doneMs, notes: r.notes }); });
      });
      const added = await OnBoard.runBackfillOnce(WPStore, { jobs: S.jobs, loose: S.loose }, { keys, dateKey: DL.dateKey, nameOf: placeNameOf, rows }, new Date().toISOString());
      if (added && added.length) S.loose = S.loose.concat(added);
    } catch (e) { /* retried on the next launch */ }
  }

  // ---------- run state: a RUNNING day, a CLOSED day (the predicates live in onboard.js) ----------
  const dayRunning = () => OnBoard.isDayRunning(curPlan(), S.plan ? S.days[planDayKey()] : null);
  function routeClosed() { // the Route tab of a closed day with no plan made since: {closedAtMs, dayKey}, else null
    if (!S.plan) return null;
    const day = dayFor(Date.now(), false), c = OnBoard.closedRouteCard(day);
    return c ? { closedAtMs: c.closedAtMs, dayKey: day.date } : null;
  }
  // opening the Plan tab on a running day: the chips tell the truth (PLAN then re-solves from where you are, now)
  function openPlanTab() { if (dayRunning()) { S.startSel = 'gps'; S.departTime = ''; } }
  function openTab(tab) {
    S.tab = tab;
    if (tab === 'plan') openPlanTab();
    window.scrollTo(0, 0);
    render();
    if (S.plan) savePlan(); // the stored plan remembers which tab you were on
    // opening the Route tab: no TomTom request (the times count down from the last live re-time; TOMTOM BUDGET)
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

    const bar = onBoardBar();
    if (bar) v.append(bar);
    const ttn = ttNotice();
    if (ttn) v.append(ttn);
    const note = jobsChangedNote();
    if (note) v.append(note);
    { const ab = afterBanner(); if (ab) v.append(ab); }
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
  const ICON_EDIT = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';
  const ICON_TRASH = 'M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9z';

  // Two-column card: COLLECT (amber) -> DELIVER (teal); errands get one full-width ERRAND box.
  function jobCard(j, urgentList) {
    const parked = j.status === 'parked';
    const win = (j.arriveAfter || j.arriveBefore)
      ? h('span', { class: 'chip win' }, [j.arriveAfter && 'after ' + j.arriveAfter, j.arriveBefore && 'before ' + j.arriveBefore].filter(Boolean).join(' · ')) : null;
    const editIt = () => openJobSheet(null, j); // a tap on either box (COLLECT / IN HAND, DELIVER) edits the job
    // the FIRST tag sits on the box of the stop it pins: the errand, the first pickup, or the delivery of a deliver-only job
    const firstTag = () => (j.firstStop ? [' ', h('span', { class: 'pill first first-tag' }, 'FIRST')] : null);
    let grid;
    if (j.errandPlaceId) {
      const dw = j.dwellMin != null ? j.dwellMin : (S.places[j.errandPlaceId] || {}).dwellMin;
      grid = h('div', { class: 'job-grid' }, h('div', { class: 'box errand tap', onclick: editIt },
        h('div', { class: 'eyebrow' }, 'ERRAND', firstTag()),
        h('div', { class: 'name' }, dName(pName(j.errandPlaceId))),
        dw != null ? h('div', { class: 'muted sub' }, dw + ' min there') : null,
        win));
    } else {
      const pk = j.pickups || [];
      // no pickups = already in hand: green IN HAND box (not the amber COLLECT box)
      const left = pk.length
        ? h('div', { class: 'box collect tap', onclick: editIt },
          h('div', { class: 'eyebrow' }, 'COLLECT', firstTag()),
          pk.map((p) => h('div', { class: 'pick' + (p.done ? ' done' : '') },
            h('div', { class: 'name' }, (p.done ? '✓ ' : '') + dName(pName(p.placeId))),
            p.item ? h('div', { class: 'muted sub' }, p.item) : null)))
        : h('div', { class: 'box inhand tap', onclick: editIt },
          h('div', { class: 'eyebrow' }, 'IN HAND'),
          j.inHandItem ? h('div', { class: 'muted sub' }, j.inHandItem) : null);
      grid = h('div', { class: 'job-grid' },
        left,
        h('div', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        h('div', { class: 'box deliver tap', onclick: editIt },
          h('div', { class: 'eyebrow' }, 'DELIVER', pk.length ? null : firstTag()),
          j.deliveryPlaceId ? h('div', { class: 'name' }, dName(pName(j.deliveryPlaceId))) : h('div', { class: 'muted' }, 'Just collect — stays with you'),
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
          h('button', { class: 'small danger', onclick: async () => {
            // deleted while the day runs and the job was in today's plan: the day log records it like Route -> Cancel job (status
            // "cancelled", no reason; never carried). No day running: simply deleted (OnBoard.cancelOnDelete says which).
            try {
              const running = !!(S.plan && dayRunning()), day = running ? S.days[planDayKey()] : null;
              const c = OnBoard.cancelOnDelete({ job: j, plan: curPlan(), day, running, nameOf: placeNameOf });
              if (c) { DL.recordCancel(day, { nowIso: new Date().toISOString(), jobId: c.jobId, item: c.item, place: c.place, via: 'plan-delete' }); if (day.decisions[c.jobId]) delete day.decisions[c.jobId].reason; await saveDay(day); }
            } catch (e) { /* never block the delete */ }
            await WPStore.remove('jobs', j.id); S.jobs = S.jobs.filter((x) => x !== j);
            if (S.plan && dayRunning()) { S.plan.jobsChanged = true; await savePlan(); } // the Route is NOT changed: the "tap PLAN" notice
            render();
          } }, 'Delete'))
        : h('div', { class: 'job-actions' },
          j.errandPlaceId ? null : h('button', { class: 'small urgent-toggle', 'aria-pressed': j.urgent ? 'true' : 'false', title: j.urgent ? 'Clear urgent' : 'Mark urgent', onclick: () => setUrgent(j, !j.urgent) }, 'Urgent'),
          h('button', { class: 'icon-btn edit-btn', 'aria-label': 'Edit job', title: 'Edit', onclick: editIt }, svgIcon(ICON_EDIT)), park, del);
      const aft = JobEdit.afterLine(j, (id) => dName(pName(id))); // the After rule: "after Asian Automotive, Carrier"
      foot.replaceChildren(...[aft ? h('div', { class: 'job-notes after-line' }, aft) : null, j.notes ? h('div', { class: 'job-notes' }, j.notes) : null,
        j.carriedFrom ? h('div', { class: 'job-notes carried' }, 'Carried from ' + DayLog.fmtDate(j.carriedFrom) + (j.carryReason ? ' · ' + j.carryReason : '')) : null, actions].filter(Boolean));
    }
    drawFoot(false);
    return h('div', { class: 'card job' + (parked ? ' parked' : '') + (j.urgent ? ' urgent' : '') }, head, grid, foot);
  }

  // ---------- Add job sheet ----------
  // pre = {looseId, item, notes}: "Deliver to…" on a loose item. The form opens in in-hand mode (no pickup) with the item and notes
  // filled in and the focus on the destination; saving converts the loose item into the new job, cancelling changes nothing.
  // edit = a pending or held job: the same form in EDIT mode, every field pre-filled (jobedit.js holds the rules). A pickup already
  // collected is shown read-only ("Collected 11:02 - cannot change"); saving updates the SAME job.
  function openJobSheet(pre, edit) {
    if (edit && !JobEdit.isEditable(edit)) return;
    const f0 = edit ? JobEdit.formOf(edit) : null;
    let mode = f0 ? f0.mode : 'delivery';
    const st = f0
      ? { pickups: f0.pickups, deliveryPlaceId: f0.deliveryPlaceId, errandPlaceId: f0.errandPlaceId, dwellMin: f0.dwellMin, notes: f0.notes, urgent: f0.urgent, after: f0.after, before: f0.before, inHandItem: f0.inHandItem, firstStop: f0.firstStop, afterPlaces: f0.afterPlaces.slice() }
      : { pickups: [{ placeId: null, item: '' }], deliveryPlaceId: null, errandPlaceId: null, dwellMin: '', notes: pre ? pre.notes || '' : '', urgent: false, after: '', before: '', inHandItem: pre ? pre.item || '' : '', firstStop: false, afterPlaces: [] };
    const hasDone = !!(edit && JobEdit.donePickups(edit).length);
    const sh = openSheet(edit ? 'Edit job' : 'Add job');
    if (edit) sh.sheet.id = 'editJobSheet';
    const formNow = () => ({ mode, pickups: st.pickups.map((p) => ({ ref: p.ref, placeId: p.placeId, item: p.item })), deliveryPlaceId: st.deliveryPlaceId, inHandItem: st.inHandItem,
      errandPlaceId: st.errandPlaceId, dwellMin: st.dwellMin, notes: st.notes, urgent: st.urgent, after: st.after, before: st.before, firstStop: !!st.firstStop, afterPlaces: st.afterPlaces.slice() });
    // After (today only): a multi-select of the places with an open job or errand today, not this entry's own place; empty = none
    function afterField() {
      const choices = JobEdit.afterChoices(S.jobs, formNow(), edit ? edit.id : null);
      const row = (pid) => {
        const on = st.afterPlaces.indexOf(pid) >= 0, pl = S.places[pid];
        return h('button', { type: 'button', class: 'pick-row after-opt' + (on ? ' on' : ''), 'aria-pressed': String(on), 'data-place': pid,
          onclick: () => { st.afterPlaces = on ? st.afterPlaces.filter((x) => x !== pid) : st.afterPlaces.concat([pid]); draw(); } },
        h('span', { class: 'title' }, (on ? '✓ ' : '') + dName(pName(pid))), h('span', { class: 'muted' }, pl ? Messages.typeLabel(pl.type) : ''));
      };
      return [h('label', { class: 'field' }, 'After (optional) — this stop comes after these places'),
        choices.length ? h('div', { class: 'after-list', id: 'afterList' }, choices.map(row)) : h('div', { class: 'muted', id: 'afterNone' }, 'No other place has an open job today')];
    }
    function placeBtn(id, placeholder, onPick, btnId) {
      return h('button', { id: btnId || null, style: 'width:100%;text-align:left', onclick: () => openPlacePicker((p) => { onPick(p); draw(); }) }, id ? pName(id) : placeholder);
    }
    function draw() {
      const body = sh.body;
      body.replaceChildren();
      if (!hasDone) body.append(h('div', { class: 'seg' },
        h('button', { class: mode === 'delivery' ? 'on' : '', onclick: () => { mode = 'delivery'; draw(); } }, 'Delivery'),
        h('button', { class: mode === 'errand' ? 'on' : '', onclick: () => { mode = 'errand'; draw(); } }, 'Errand')));
      if (mode === 'delivery') {
        body.append(h('label', { class: 'field' }, 'Pickups (none = item already in hand)'));
        st.pickups.forEach((p, i) => {
          if (p.done) { // already collected: shown, never changed
            body.append(h('div', { class: 'card done-pickup' }, h('div', { class: 'name' }, pName(p.placeId)), p.item ? h('div', { class: 'muted' }, p.item) : null,
              h('div', { class: 'muted' }, 'Collected ' + (p.doneAt ? DL.fmtTime(Date.parse(p.doneAt)) + ' ' : '') + '- cannot change')));
            return;
          }
          body.append(h('div', { class: 'card' },
            placeBtn(p.placeId, 'Pick pickup place', (pl) => { p.placeId = pl.id; }),
            h('input', { placeholder: 'Item (e.g. 2 pcs sensor)', value: p.item, style: 'margin-top:8px', oninput: (e) => { p.item = e.target.value; } }),
            st.pickups.length > 0 ? h('button', { class: 'small danger', style: 'margin-top:8px', onclick: () => { st.pickups.splice(i, 1); draw(); } }, 'Remove pickup') : null));
        });
        body.append(h('button', { onclick: () => { st.pickups.push({ placeId: null, item: '' }); draw(); } }, '+ Add pickup'),
          h('label', { class: 'field' }, 'Deliver to'),
          h('div', { class: 'row' }, h('div', { class: 'grow' }, placeBtn(st.deliveryPlaceId, 'Pick delivery place', (pl) => { st.deliveryPlaceId = pl.id; }, 'jobDest')),
            st.deliveryPlaceId ? h('button', { onclick: () => { st.deliveryPlaceId = null; draw(); } }, '✕') : null));
        // no delivery place = a "just collect" job: the item stays with you (the With you bar) until Dropped off / Deliver to…
        if (!st.deliveryPlaceId && st.pickups.some((p) => p.placeId || p.done)) body.append(h('div', { class: 'muted', id: 'justCollectHint' }, 'Just collect — stays with you'));
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
        // First stop (today only): this entry's first stop is the first visit after the start; only one entry has it at a time
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', id: 'firstStopToggle', checked: !!st.firstStop, onchange: (e) => { st.firstStop = e.target.checked; } }), 'First stop'),
        ...afterField(),
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Arrive after'), h('input', { type: 'time', value: st.after, oninput: (e) => { st.after = e.target.value; } })),
          h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Arrive before'), h('input', { type: 'time', value: st.before, oninput: (e) => { st.before = e.target.value; } }))),
        h('div', { class: 'sticky-actions' }, h('button', { onclick: sh.close }, 'Cancel'), h('button', { class: 'primary', id: 'saveJobBtn', onclick: save }, edit ? 'Save changes' : 'Save job'))].filter(Boolean));
    }
    async function saveEdit() {
      const res = JobEdit.updateJob(S.jobs, edit.id, formNow(), { placeDwell: (id) => (S.places[id] && S.places[id].dwellMin != null ? S.places[id].dwellMin : 10) });
      if (!res.ok) { toast(res.error); return; }
      const before = S.jobs;
      S.jobs = res.jobs;
      for (const id of res.changedIds) await saveJob(S.jobs.find((x) => x.id === id));
      if (before.length !== S.jobs.length) throw new Error('job count changed');
      if (S.plan) { S.plan.jobsChanged = true; await savePlan(); } // the route is NOT re-planned: the owner taps PLAN
      sh.close();
      render();
      if (res.movedFrom) toast(JobEdit.firstStopToast(res.movedFrom, res.job, placeNameOf));
    }
    async function save() {
      if (edit) return saveEdit();
      const err = JobEdit.validate(formNow());
      if (err) { toast(err); return; }
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
        if (pre && pre.looseId && !j.pickups.length) j.looseId = pre.looseId; // this in-hand job now tracks the loose item
      }
      const aft = JobEdit.afterToSave(Object.assign(formNow(), { mode })); // After (today only): stored only when chosen
      if (aft.length) j.afterPlaces = aft;
      S.jobs.push(j);
      let moved = null;
      if (st.firstStop) { // one First stop at a time: it leaves the entry that had it
        const r = JobEdit.setFirstStop(S.jobs, j.id, true);
        S.jobs = r.jobs; moved = r.movedFrom;
        for (const id of r.changedIds) if (id !== j.id) await saveJob(S.jobs.find((x) => x.id === id));
      }
      const j1 = S.jobs.find((x) => x.id === j.id);
      await saveJob(j1);
      if (j1.looseId) await setLoose(OnBoard.convert(S.loose, j1.looseId, j1.id, Date.now()));
      sh.close();
      render();
      if (moved) toast(JobEdit.firstStopToast(moved, j1, placeNameOf));
    }
    draw();
    if (pre) setTimeout(() => { const d = sh.body.querySelector('#jobDest'); if (d) d.focus(); }, 50); // the destination is what is left to choose
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
    // PLAN on a RUNNING day (a stop done / reached / skipped, or a navigation tap) is the old "Replan from here": it re-solves the
    // stops that are not done, keeps the done / reached stops, the fuel stop, the lunch state and the replan count (the code below).
    // The start / time chips are reset to "My location" / "Now" whenever the Plan tab opens on a running day (openPlanTab), so what
    // they show is what is used; a chip changed on purpose wins.
    const replan = !!opts.replan || dayRunning();
    const s = S.settings;
    banner(null);
    if (!s.tomtomKey) { banner('TomTom API key missing — add it in Settings. (Travel times come from the TomTom Routing API.)', 'error'); return; }
    const end = S.places[S.endSel];
    if (!end) { banner('Pick an end place.', 'error'); return; }
    const allJobs = JSON.parse(JSON.stringify(S.jobs));
    // on a running day a SKIPPED stop is left exactly as it is: what it holds is not solved again (only Undo skip brings it back)
    const jobs = replan ? planJobs(OnBoard.jobsForPlan(allJobs, curPlan()), curPlan()) : allJobs;
    const stopIds = Solver.buildStops(jobs, S.places).stopIds;
    if (!stopIds.length) { toast('No pending jobs to plan.'); return; }
    if (stopIds.length > Solver.MAX_STOPS) { banner('Too many stops: ' + stopIds.length + ' distinct places (max ' + Solver.MAX_STOPS + '). Park some jobs first.', 'error'); return; }
    S.busy = true;
    S.tt.planSess = TT.planSession(); S.planBanner = null; // this PLAN's requests (the banner number)
    if (S.tab === 'plan') render();
    try {
      let start;
      if (S.startSel === 'gps') {
        banner('Getting your location…', 'busy');
        start = await getGps();
      } else {
        const sp = S.places[S.startSel];
        if (!sp) throw new Error('Pick a start place.');
        start = { lat: sp.lat, lng: sp.lng };
      }
      let departAt = new Date();
      if (S.departTime) {
        const [hh, mm] = S.departTime.split(':').map(Number);
        const d = new Date(); d.setHours(hh, mm, 0, 0);
        if (d > departAt) departAt = d;
      }
      const places = addVisitPlaces(JSON.parse(JSON.stringify(S.places)), stopIds);
      const input = { start, end, jobs, places, departAtISO: departAt.toISOString(), noDetour: false };
      const points = Solver.pointsFor(input);
      const prevNoDetour = S.plan ? S.plan.noDetour : false;
      let got, routed = null;
      const noRoute0 = S.tt.noRoute;
      if (ttService() === 'matrix') { // Settings -> TomTom service: Matrix (the old path: 3 time slices)
        banner('Asking TomTom for travel times (Matrix, 3 time slices)…', 'busy');
        got = await Providers.getMatricesOrEstimate(points, input.departAtISO, s.tomtomKey, { force: replan });
        got.orderEstimated = !!got.estimated;
      } else { // the Routing API: learned / fetched table, order, then check the chosen route (TravelTimes)
        routed = await routingPlan(input, departAt, replan ? prevNoDetour : false);
        got = { matrices: routed.matrices, calls: routed.requests, fromCache: false, partial: false, estimated: routed.estimated, orderEstimated: routed.estimated };
      }
      const prevPlan = replan ? curPlan() : null; // a replan keeps the stops already done on top
      const carryLegs = prevPlan ? carriedLegs(prevPlan) : null; // the leg being driven stays held after this PLAN (End day km)
      const prevCtxPlaces = replan && S.plan ? S.plan.ctx.places : null; // (the fuel station lives there)
      // the run's day = local date it departed; a replan stays in its run's day (even past midnight)
      const dayKey = replan && planDayKey() ? planDayKey() : DL.dateKey(departAt.getTime());
      const fetchedAt = new Date().toISOString();
      got.matrices.forEach((x) => { if (!x.fetchedAt) x.fetchedAt = fetchedAt; });
      const msgAt = S.plan && S.plan.ctx && S.plan.ctx.msgAt && replan ? S.plan.ctx.msgAt : {}; // MSG taps of the day (look-ahead rule)
      S.plan = { ctx: { start, end, jobs, places, departAtISO: input.departAtISO, matrices: got.matrices, dayKey, msgAt }, noDetour: replan ? prevNoDetour : false, idx: 0, prompt: null, shiftMs: 0, alt: null, provider: { calls: got.calls, fromCache: got.fromCache, partial: !!got.partial, estimated: !!got.estimated, estimatedOrder: !!got.orderEstimated, refused: !!(routed ? routed.down : got.estimated), downStatus: routed ? (routed.down ? routed.down.status : null) : (got.error ? got.error.status : null), noRoute: S.tt.noRoute > noRoute0, service: ttService() } };
      if (routed) { S.plan.result = routed.res; S.plan.idx = 0; S.plan.alt = null; } else solveFresh();
      S.plan.afterConflicts = (S.plan.result && S.plan.result.afterConflicts) || []; // After rules left out (the red banner)
      if (jobs !== allJobs) S.plan.ctx.jobs = allJobs; // lookups by job id still find the whole job (the solve above used the trimmed copy)
      if (carryLegs) S.plan.ctx.carryLegs = carryLegs;
      if (prevPlan) {
        S.plan.result.plans = S.plan.result.plans.map((p) => compose(prevPlan, p));
        await keepFuelAfterReplan(prevPlan, prevCtxPlaces, points); // silent: the chosen station only, no Places calls
      }
      if (got.estimated) banner(null); // the one TomTom notice / the "Estimated order" header say it; no second banner
      else if (routed) { S.planBanner = { sess: S.tt.planSess, live: !!routed.live, checked: !!routed.checks, text: null }; planBannerShow(); }
      else banner('Travel times: TomTom Matrix — ' + (got.fromCache ? 'from session cache (0 calls)' : got.calls + ' calls') + (got.partial ? ' · some legs missing, treated as very long' : '') + '.', 'info');
      S.loc.origin = null; S.loc.lastAt = null; S.loc.reason = null;
      // the first leg was just fetched live from where you are (depart now): it is the live re-time, no second request
      const firstLive = routed && routed.firstLegLive && S.startSel === 'gps' && departAt.getTime() <= Date.now() + 60000 ? routed.firstLegLive : null;
      if (firstLive) {
        const p0 = curPlan(), nx = p0 && p0.stops.find((x) => !x.status), now = Date.now();
        if (nx && nx.placeId === firstLive.placeId) { S.loc.origin = { placeId: nx.placeId, lat: start.lat, lng: start.lng, arriveMs: now + firstLive.sec * 1000, usedAt: now }; S.tt.lastLiveAt = now; }
      }
      retimeNow(); // the shared timing path (the lunch break included)
      logPlan(replan, { start, departAt, places, points, matrices: got.matrices, jobs: Solver.buildStops(jobs, places).jobs });
      S.tab = 'route';
      await savePlan(); // after the tab switch, so a restore reopens the Route tab
    } catch (e) {
      banner(e.message || String(e), 'error');
    } finally {
      S.busy = false;
      render();
      wake.sync({ retry: true }).then(paintWake); // after PLAN: keep the screen on while the day runs
      const sess = S.tt.planSess;
      const first = S.tab === 'route' && S.plan && !(S.loc.origin && S.tt.lastLiveAt != null && Date.now() - S.tt.lastLiveAt < 5000)
        ? refreshFromLocation({ trigger: 'plan', sess }) : null; // the Route tab's first re-time is part of this PLAN
      Promise.resolve(first).catch(() => {}).then(() => {
        if (S.planBanner && S.planBanner.sess === sess) planBannerShow(); // its request (if one was sent) is in the number
        if (S.tt.planSess === sess) S.tt.planSess = null;
      });
    }
  }

  // PLAN with the Routing API (TravelTimes): the table for the plan's bucket (learned -> other bucket -> fetched), or live for
  // 5 stops or fewer; ORDER with the existing solver; CHECK the chosen order's legs at their planned departures; >15% off ->
  // one re-solve (+ one check of a changed order). Never mixed: a pair with no real time = the order on estimates for all.
  // Returns {res (solver result, plans timed on the timing table), matrices, estimated, requests, checks, live, firstLegLive}.
  async function routingPlan(input, departAt, noDetour) {
    const nowMs = Date.now(), t0 = departAt.getTime();
    // TomTom Routing is paced to one request start every 300 ms (Providers.createLimiter): a batch of more than 4 waits in its queue,
    // so the PLAN notice counts it ("Getting travel times 5 of 42…"); it goes when the PLAN's banner takes its place
    const progress = (d, n) => { if (n > 4) banner('Getting travel times ' + d + ' of ' + n + '…', 'busy'); };
    banner('Getting travel times…', 'busy');
    const sess = S.tt.planSess || (S.tt.planSess = TT.planSession());
    const r = await TT.planRoute({
      Solver, input: Object.assign({}, input, { noDetour }), nowMs, mem: S.mem, fetchLeg: planFetch(sess), seen: sess.learned, onProgress: progress,
      start: nodeOf('__start__', input.start, S.startSel !== 'gps' ? S.startSel : null),
      end: nodeOf('__end__', input.end, input.end.id),
      nodeOfStop: (pid) => nodeOf(pid, Solver.placeOf(input.places, pid), baseId(pid)), // a second visit = the same saved place (0 s, no request)
      timed: (p) => LunchBreak.applyBreak(p, curLunch(), S.settings, Date.now()),
    });
    saveMemory();
    let firstLegLive = null; // the plan's first leg, fetched for "now" from the start (live table, or the check of a plan departing now)
    const p0 = !r.res.error && r.res.plans[0];
    if (p0 && p0.order.length && !r.estimated && t0 <= nowMs + 60000) {
      const j = r.stopIds.indexOf(p0.order[0]) + 1;
      if (!r.matrices[0].est[0][j]) firstLegLive = { placeId: p0.order[0], sec: r.matrices[0].m[0][j] };
    }
    return Object.assign({}, r, { firstLegLive });
  }

  // ---------- plan state: persistence, live re-timing, re-solving from the cached matrices ----------
  // S.plan = { ctx:{start,end,jobs,places,departAtISO,matrices}, noDetour, idx, prompt, alt, provider,
  //            result:{plans:[plan,...]} }.  plan = solver plan + per-stop status ('done'|'skipped') / doneAt + plan.model.
  // Invariant: plan.model.matrices === ctx.matrices (the matrices the current problem was solved with).
  const curPlan = () => (S.plan && S.plan.result && !S.plan.result.error && S.plan.result.plans[S.plan.idx]) || null;
  const iso = (ms) => new Date(ms).toISOString();

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
    const live = new Set(plan.stops.filter((s) => !s.status).map((s) => baseId(s.placeId))); // saved places (a second visit = its place)
    const inModel = new Set(m.stopIds.map(baseId));
    let aIdx = 0, anchor = { lat: m.start.lat, lng: m.start.lng }; // where we are: last done stop, else the start
    if (from >= 0) {
      const pid = plan.stops[from].placeId, ix = m.stopIds.indexOf(pid), pl = S.places[pid] || P.ctx.places[pid];
      if (ix >= 0 && pl) { aIdx = ix + 1; anchor = { lat: pl.lat, lng: pl.lng }; }
    }
    const placesOf = (j) => (j.errandPlaceId ? [j.errandPlaceId]
      : (j.pickups || []).filter((p) => !p.done).map((p) => p.placeId).concat(j.deliveryPlaceId ? [j.deliveryPlaceId] : []));
    const jobs = planJobs(S.jobs.filter((j) => !j.status || j.status === 'pending').filter((j) => {
      const ps = placesOf(j); // only jobs the cached matrices cover, with something still to do at a live stop
      return ps.length && ps.every((p) => inModel.has(p)) && ps.some((p) => live.has(p));
    }), plan);
    const stopIds = Solver.buildStops(jobs, S.places).stopIds;
    addVisitPlaces(P.ctx.places, stopIds);
    const mi = (key) => { const x = m.stopIds.indexOf(key); return x >= 0 ? x : m.stopIds.findIndex((y) => baseId(y) === baseId(key)); }; // same coordinates
    const idxList = [aIdx].concat(stopIds.map((pid) => mi(pid) + 1), [m.stopIds.length + 1]);
    const matrices = Solver.reindexMatrices(m.matrices, idxList);
    const now = Date.now();
    const at = (from >= 0 ? now : Math.max(now, Date.parse(P.ctx.departAtISO))) + (opts.shiftMs || 0);
    const respect = opts.respect != null ? opts.respect : !!m.respectClosed;
    const sIn = { start: anchor, end: { lat: m.end.lat, lng: m.end.lng }, jobs, places: S.places, departAtISO: iso(at), noDetour: P.noDetour, respectClosedWindows: respect };
    let res;
    if (P.provider && P.provider.estimatedOrder) { // the plan was ordered on estimates: never mix when ordering again
      const pts = Solver.pointsFor(Object.assign({}, sIn, { matrices: [] }));
      const ordM = [{ departAt: iso(at), m: pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Budget.estSec(a, b)))) }];
      res = Solver.solve(Object.assign({}, sIn, { matrices: ordM }));
      if (!res.error) res = Object.assign({}, res, { plans: res.plans.map((p) => Solver.evaluate(Object.assign({}, sIn, { matrices }), p.order)) });
    } else res = Solver.solve(Object.assign({}, sIn, { matrices }));
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
  function originFor(plan, at) { // the last live TomTom time counts down until the next live re-time (Budget.originKept)
    const o = S.loc.origin, now = Date.now();
    if (!o || o.placeId !== targetId(plan) || at > now || !Budget.originKept(o, now)) return null;
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
  // The LIVE RE-TIME. Fix -> ONE 1 x 1 routing request (fix -> next not-done stop, or the end point when every stop is done /
  // skipped; live traffic, depart now) -> first ETA = now + duration, later stops follow through the plan's own stop-to-stop
  // times and dwell (never the whole matrix again). No solver run, same order. Never blocks: on any failure it records WHY
  // (S.loc.reason) for the status line. opts.trigger (Budget.retimeDecision): 'plan' | 'done' | 'skip' | 'undo' | 'tap'
  // (always; these also bypass the 300 m "unmoved" rule), 'visible' | 'tick' (automatic: 5-min gap, stopped by the daily
  // guard), 'edit' (fuel added / removed: 5-min gap). A GPS-watch position never comes here. opts.prompt = may ask for permission.
  async function refreshFromLocation(opts) {
    opts = opts || {};
    const P = S.plan, L = S.loc;
    if (!P || L.busy) return;
    if (routeClosed()) return; // a closed day with no plan since: no live times, no routing request
    const plan0 = curPlan();
    if (!plan0) return;
    if (S.tt.planSess && opts.sess !== S.tt.planSess) return; // a PLAN is still counting its own requests (seconds)
    if (!liveDue(opts.trigger || 'visible')) return;
    opts.force = Budget.isAlways(opts.trigger);
    const nx0 = plan0.stops.find((s) => !s.status), tid = targetId(plan0);
    const target = nx0 ? (S.places[nx0.placeId] || P.ctx.places[nx0.placeId]) : P.ctx.end;
    if (!target) return;
    L.busy = true; L.lastAt = Date.now();
    paintTimesLine(); // "getting location…" while the fix is fetched (e.g. location just came back on)
    const fail = async (reason) => {
      L.reason = reason;
      // denied, or a live origin older than 5 min: fall back to the last DONE (a fresher origin may still stand)
      if (L.origin && (reason === 'denied' || !Budget.originKept(L.origin, Date.now()))) { L.origin = null; if (S.plan === P) { retimeNow(); await savePlan(); } }
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
          const now0 = Date.now();
          const leg = opts.sess ? planFetch(opts.sess) : ttLeg; // the PLAN's re-time: an identical request it already sent is not sent again
          const r = await leg({ lat: fix.lat, lng: fix.lng }, { lat: target.lat, lng: target.lng }, null); // ONE request, depart now
          if (!r || r.seconds == null) throw new Error('no duration');
          dur = r.seconds;
          // a sample only between two saved places (the fix within 150 m of one); typical time when TomTom returns it
          const a = nodeOf('fix', fix, null), b = nodeOf('target', target, nx0 ? nx0.placeId : (P.ctx.end && P.ctx.end.id));
          TT.remember(S.mem, a, b, now0, r, now0, opts.sess ? opts.sess.learned : null); saveMemory(); // a sample only between saved places, only a typical time, once per pair per PLAN
        } catch (e) { return await fail(navigator.onLine === false || /network error/i.test(e.message || '') ? 'offline' : 'routing'); }
      }
      const cur = S.plan === P ? curPlan() : null;
      if (!cur || targetId(cur) !== tid) return; // the plan moved on while we waited
      const hadAlt = !!P.alt, now = Date.now();
      L.origin = { placeId: tid, lat: fix.lat, lng: fix.lng, arriveMs: now + dur * 1000, usedAt: now };
      L.reason = null;
      // (estimated legs further ahead keep their "est." until the next PLAN)
      if (S.plan !== P) return;
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
        st.addEventListener('change', () => { if (st.state === 'granted' && S.plan) refreshFromLocation({ trigger: 'visible' }); });
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
      v: 1, savedAt: new Date().toISOString(), tab: S.tab, jobsChanged: !!P.jobsChanged, manualOrder: !!P.manualOrder, noDetour: P.noDetour, provider: P.provider || null, ctx: P.ctx, afterConflicts: P.afterConflicts || [],
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
      ctx: snap.ctx, noDetour: !!snap.noDetour, jobsChanged: !!snap.jobsChanged, manualOrder: !!snap.manualOrder, idx: 0, prompt: null, shiftMs: 0, alt: null, provider: snap.provider || null, afterConflicts: Array.isArray(snap.afterConflicts) ? snap.afterConflicts : [],
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
  // A leg between two saved places from the learned memory (metres + seconds, any part of the day), else null. No request.
  function learnedLeg(a, b) {
    const list = Object.values(S.places), pa = TT.snap(a, list), pb = TT.snap(b, list);
    if (pa == null || pb == null) return null;
    if (pa === pb) return { m: 0, s: 0 };
    const l = TT.learned(S.mem, pa, pb, TT.bucketOf(Date.now()));
    return l && l.m != null ? { m: l.m, s: l.s } : null;
  }
  // The leg just driven (DONE / ARRIVED) into the day record: the plan's matrices, else the legs carried across a PLAN on a
  // running day (the plan made from a live position no longer holds the done stop), else the learned memory. Before this,
  // only the first was tried, so the first leg after such a PLAN was never held and the day's km stayed blank.
  function holdDriven(day, plan, prev, to, coord, nowMs) {
    const m = plan.model, pts = [m.start].concat(m.stopIds.map(coord), [m.end]);
    return DL.holdLeg(day, prev, to, { matrices: pts.every(Boolean) ? m.matrices : null, points: pts, atMs: nowMs, carry: S.plan && S.plan.ctx.carryLegs, learned: learnedLeg });
  }
  // PLAN on a running day: the previous plan's own legs from where you left (its last done stop, else its start) to every stop
  // not done and its end, kept with the new plan (ctx.carryLegs, with what an earlier PLAN carried).
  function carriedLegs(plan) {
    const prev = (S.plan && S.plan.ctx && S.plan.ctx.carryLegs) || {};
    const m = plan && plan.model;
    if (!m || !m.matrices) return prev;
    const c = (id) => { const p = coordPlace(id); return p ? { lat: p.lat, lng: p.lng } : null; };
    const pts = [m.start].concat(m.stopIds.map(c), [m.end]);
    if (!pts.every(Boolean)) return prev;
    const di = lastDoneIdx(plan, true), from = di >= 0 ? c(plan.stops[di].placeId) : { lat: m.start.lat, lng: m.start.lng };
    const tos = plan.stops.filter((s) => !s.status && !s.fuel).map((s) => c(s.placeId)).concat([{ lat: m.end.lat, lng: m.end.lng }]);
    return Object.assign({}, prev, DL.legsFrom(m.matrices, pts, from, tos, Date.now()));
  }
  function logDone(stop, nowIso, proof) {
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
        : DL.recordDone(day, Object.assign({ nowIso, stopId: stop.placeId, actions: stop.actions, places: Object.assign({}, S.plan && S.plan.ctx.places, S.places),
          proof: proof ? Proof.summaryOf(proof) : null, proofJobIds: proof ? proof.jobIds || [] : [] }, rch));
      if (plan && prev && to) holdDriven(day, plan, prev, to, coord, nowMs); // keep the leg just driven (zero requests)
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
        if (p) { p.done = false; delete p.doneAt; }
        if (j.status === 'done') { j.status = 'pending'; j.doneAt = null; }
        if (OnBoard.isCollectOnly(j)) await setLoose(OnBoard.removeForJob(S.loose, j.id)); // the DONE is undone: it was never collected
      } else { j.status = 'pending'; j.doneAt = null; }
      if (stop.proofId && j.proofId === stop.proofId) delete j.proofId;
      await saveJob(j);
    }
    if (day) { DL.recordUndo(day, { nowIso: new Date().toISOString(), stopId: stop.placeId }); bgSaveDay(day); }
    if (stop.proofId) voidProof(stop.proofId); // its photos stay; no SEND any more; a later PROOF makes a new one
    cur.stops[li] = Reached.undoDone(stop); // pending again; reachedAt / reachedSource stay (the stop is back to "reached")
    delete cur.stops[li].proofId;
    if (stop.leftOpen) { cur.stops[li].actions = stop.actions.concat(stop.leftOpen); delete cur.stops[li].leftOpen; } // the deliveries left open are back on the card
    S.loc.origin = null;
    P.prompt = null;
    retimeNow();
    banner(null);
    await savePlan();
    render();
    refreshFromLocation({ trigger: 'undo' });
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
      if (plan && prev) holdDriven(day, plan, prev, { lat: end.lat, lng: end.lng }, (id) => coordOf(id, day), nowMs);
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
    // STILL WITH YOU = what was with the driver when the day closed (now, while open): the day's own rows + loose items;
    // "Dropped off" = loose items dropped off on this date. Closed days are re-rendered with the same rule.
    const extraOf = () => {
      const closeMs = day.closed ? (Date.parse(day.closedAt != null ? day.closedAt : day.endedAt) || Date.now()) : Date.now();
      return OnBoard.summaryExtra(boardState(), closeMs, DL.dayStartMs(day.date), DL.dayStartMs(DL.addDaysKey(day.date, 1)));
    };
    const sum = () => DL.summarise(day, S.jobs, S.places, extraOf());
    const ro = () => !!opts.readOnly;
    const hm = DL.fmtTime;

    async function routeNow(manual) { // NO request: only the legs not held yet, from the learned times, kept per pair
      // (before: every leg of the chain had to be found in the learned times, held ones and the GPS start included, and the
      // result only counted for that exact chain, so one gap or a later stop on the same date left the km blank)
      const s = sum();
      if (!s.route.needs || routing) return;
      let added = 0, left = 0;
      DL.missingLegs(day, s).forEach((g) => {
        const l = learnedLeg(g.a, g.b), held = day.legs[g.key] || {};
        if (!l) { left++; return; }
        day.legs[g.key] = { m: held.m != null ? held.m : l.m, s: held.s != null ? held.s : (l.s != null ? l.s : null) };
        added++;
      });
      if (left && manual) toast('km unavailable: no stored distance for every leg driven');
      if (!added) return;
      await saveDay(day);
      draw();
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
      // a delivered item collected today lists its source on the same line, with the collected time: "· from Pacific Klang 10:05"
      const delivered = sec('Delivered', 'deliver', s.delivered.map((d) => line(h('span', null, d.item || '(item)', ' - ', d.place,
        d.from && d.collectedAt != null ? h('span', { class: 'muted sum-src' }, ' · from ' + d.from + ' ' + hm(d.collectedAt)) : null), hm(d.t),
        [d.urgent ? urgentChip.cloneNode(true) : null, d.late ? lateChip.cloneNode(true) : null].filter(Boolean))), 'Nothing delivered');
      const errands = sec('Errands done', 'errand', s.errands.map((e) => line(h('span', null, e.item, ' - ', e.place), hm(e.t))), 'No errands');
      const fuelLine = s.fuel ? h('div', { class: 'card sum-sec fuel', id: 'sumFuel' }, line('Fuel: ' + s.fuel.place + ' ' + hm(s.fuel.t))) : null;
      const withRows = s.stillWithYou.map((r) => (r.loose
        ? line(h('span', null, r.item || '(item)', r.to ? ' → ' + r.to : '', r.from ? ' · from ' + dName(r.from) : ''), r.fromAt != null ? hm(r.fromAt) : null)
        : line(h('span', null, r.item || '(item)', ' → ', r.to), null, r.urgent ? [urgentChip.cloneNode(true)] : null)));
      const droppedRows = (s.droppedOff || []).map((d) => h('div', { class: 'muted sum-dropped' }, 'Dropped off: ' + (d.item || '(item)') + ' ' + hm(d.t) + (d.place ? ' (' + dName(d.place) + ')' : '')));
      const withYou = h('div', { class: 'card sum-sec inhand', id: 'sumWithYou' }, h('div', { class: 'eyebrow' }, 'Still with you'),
        withRows.length ? withRows : h('div', { class: 'muted' }, 'Nothing in the van'), droppedRows);
      // jobs cancelled mid-day (SKIP -> Cancel job): item and place; never carried to tomorrow
      const cancelledSec = (s.cancelled || []).length ? h('div', { class: 'card sum-sec cancelled', id: 'sumCancelled' }, h('div', { class: 'eyebrow' }, 'Cancelled'),
        s.cancelled.map((c) => line(h('span', { class: 'cancelled-line' }, (c.item || '(item)') + (c.place ? ' - ' + dName(c.place) : ''))))) : null;

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
        tiles, timeRow, replansLine, splitCard, collected, delivered, errands, fuelLine, withYou, cancelledSec, notDone,
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
    const live = S.places[baseId(stop.placeId)] || place; // latest edits to number/salutation win (a second visit: its saved place)
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
    const bar = onBoardBar();
    if (bar) v.append(bar);
    const ttn = ttNotice();
    if (ttn) v.append(ttn);
    if (!P) { v.append(h('div', { class: 'empty card' }, 'No plan yet. Add jobs on the Plan tab and tap PLAN.')); return; }
    const closed = routeClosed();
    if (closed) { // the day was closed and nothing has been planned since: one card, no live route
      const when = DL.dateKey(closed.closedAtMs) === DL.dateKey(Date.now()) ? DL.fmtTime(closed.closedAtMs) : DL.fmtDate(DL.dateKey(closed.closedAtMs)) + ' ' + DL.fmtTime(closed.closedAtMs);
      v.append(h('div', { class: 'card day-closed', id: 'dayClosedCard' }, h('div', { class: 'title' }, 'Day closed ' + when),
        h('button', { class: 'primary', id: 'viewSummary', style: 'margin-top:10px', onclick: () => openSummary(closed.dayKey) }, 'View summary')));
      return;
    }
    const rbox = reorderBox();
    if (rbox) v.append(rbox);
    const note = jobsChangedNote();
    if (note) v.append(note);
    { const ab = afterBanner(); if (ab) v.append(ab); }
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
    // estimated times (TomTom was out at PLAN): which ETAs depend on an estimated leg carry "est."
    curEst = Budget.estStops(plan, lastDoneIdx(plan), S.timesFrom != null);
    const estimated = curEst.stops.size > 0 || curEst.end || !!(P.provider && P.provider.estimated);

    // which anchor the times come from (and why not the phone's location); a tap retries at once, bypassing the throttle
    v.append(h('button', { class: 'times-from', id: 'timesFrom', type: 'button', onclick: () => { if (S.loc.busy) toast('Checking your location…'); else refreshFromLocation({ trigger: 'tap', prompt: true }); } },
      timesLineFor(plan)));
    v.append(
      h('div', { class: 'card' },
        h('div', { class: 'totals', id: 'routeTotals' },
          h('div', null, h('b', { id: 'stopsLeft' }, view.left), h('span', { class: 'muted' }, 'stops left')),
          h('div', null, h('b', { id: 'minLeft' }, Solver.formatDuration(view.leftSec)), h('span', { class: 'muted' }, 'left')),
          h('div', null, h('b', { id: 'endArrive' }, fmt(view.endArrival) + estMark(curEst.end)), h('span', { class: 'muted' }, 'arrive ' + (ctx.end.name || 'end')))),
        P.provider && P.provider.estimatedOrder ? h('div', { class: 'chip est', id: 'estHeader' }, Budget.ESTIMATED_ORDER) : estimated ? h('div', { class: 'chip est', id: 'estHeader' }, 'Estimated times') : null,
        h('div', { class: 'muted', id: 'departedAt', style: 'margin-top:8px' }, (departMs > now ? 'Departs ' : 'Departed ') + fmt(departMs)),
        P.shiftMs > 60000 ? h('div', { class: 'chip detour' }, 'Running ' + Math.round(P.shiftMs / 60000) + ' min behind plan') : null,
        lunchSkippedLine()),
      manualOrderNote() || '',
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
    const fuelNow = plan.stops.find((s) => s.fuel);
    if (!(fuelNow && fuelNow.status === 'done')) { // one fuel stop per plan; once it is done there is nothing to add or change
      navRow.append(h('button', { class: 'grow', id: 'fuelBtn', onclick: () => fuelTap() }, fuelNow ? 'Change fuel stop' : 'Add fuel stop'));
    }
    // a CLOSED stop still ahead: offer the closed-windows-respected alternative (re-solved from the cached matrices)
    if (!P.alt && remaining.some((s) => s.closedWarning)) navRow.append(h('button', { class: 'grow', id: 'avoidLunch', onclick: () => { computeAvoidLunch(); render(); } }, 'Avoid lunch'));
    v.append(navRow);
    if (P.alt) v.append(altCard(P));

    if (view.left > 0 && plan.stops.some((s) => s.status === 'skipped' && !s.fuel)) v.append(h('div', { class: 'prompt', id: 'skipPrompt' }, 'A stop was skipped. PLAN leaves it skipped; tap Undo skip on it to bring it back. ', h('button', { class: 'small', onclick: () => openTab('plan') }, 'Go to Plan')));
    if (P.prompt) {
      const stop = plan.stops.find((s) => s.placeId === P.prompt.placeId);
      const place = S.places[baseId(P.prompt.placeId)];
      if (stop && place) {
        v.append(h('div', { class: 'prompt' }, h('div', { class: 'title' }, 'Send ETA to ' + dName(place.name) + '?'),
          h('div', { class: 'row', style: 'margin-top:8px' },
            h('button', { class: 'primary grow', onclick: () => { const m = stopMessage(stop, P.shiftMs); P.prompt = null; noteMsg(stop.placeId); shareMessage(m.place, m.text); render(); } }, 'Send'),
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
    stopTapped();
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
        h('span', { class: 'times', id: 'endCardTime' }, arrEv ? 'arrived ' + fmt(arrivedMs) : fmt(endArrival) + estMark(curEst.end))),
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
    if (st === 'done') { // done stops collapse to one line: tick, name, actual done time (+ SEND TO GROUP / SENT ✓ on a proof)
      const undoable = i === lastDoneIdx(curPlan());
      const send = sendButton(stop);
      return h('div', { class: 'card stop done compact' + (send ? ' has-send' : '') }, h('div', { class: 'row spread' + (send ? ' send-row' : '') },
        h('div', { class: 'title' }, '✓ ' + (i + 1) + '. ' + tag + dName(place.name)),
        h('div', { class: 'muted times' }, 'done ' + fmt(Date.parse(stop.doneAt))),
        undoable ? h('button', { class: 'small undo', 'aria-label': 'Undo done', onclick: () => undoDone(stop, i) }, 'Undo') : null,
        send));
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
    // the place's contact name: small muted text at the end of the card's second line (the first job line), " · " before it,
    // cut with an ellipsis rather than wrapping (no new line)
    const contactName = String(((S.places[baseId(stop.placeId)] || place || {}).contactName) || '').trim();
    if (contactName && lines.length) {
      const l0 = lines[0];
      lines[0] = h('div', { class: l0.className + ' has-contact' }, h('span', { class: 'act-t' }, l0.textContent), h('span', { class: 'muted contact-tail' }, ' · ' + contactName));
    }
    const pills = [];
    if (stop.detour) pills.push(h('span', { class: 'pill detour' }, 'DETOUR'));
    if (stop.closedWarning) pills.push(h('span', { class: 'pill closed' }, 'CLOSED'));
    if (stop.late) pills.push(h('span', { class: 'pill closed' }, 'LATE'));
    if (stop.first) pills.push(h('span', { class: 'pill first' }, 'FIRST')); // the First stop visit (a later second visit has none)
    // expanded section (state lives in openStops for this session only, keyed by place; not persisted)
    const wd = (() => { const d = new Date(stop.arriveAt).getDay(); return d === 0 ? 7 : d; })();
    const todays = (place.closedWindows || []).filter((w) => (Array.isArray(w.days) ? w.days : ALL_DAYS).indexOf(wd) >= 0);
    const more = h('div', { class: 'stop-more', hidden: !openStops.has(stop.placeId) },
      place.address ? h('div', null, place.address) : null,
      h('div', { class: 'times' }, fmt(stop.arriveAt) + ' → ' + fmt(stop.departAt) + estMark(curEst.stops.has(stop.placeId))),
      todays.length ? h('div', null, 'Closed today: ' + todays.map((w) => w.from + '–' + w.to).join(', ')) : null,
      stop.waitSec > 60 ? h('div', null, 'Wait ~' + Math.round(stop.waitSec / 60) + ' min here before service starts.') : null,
      stop.detour ? h('div', null, 'Detour: not urgent, but visited before the last urgent delivery.') : null,
      stop.closedWarning ? h('div', null, 'Closed: expected arrival falls inside a closed window.') : null);
    const head = h('div', { class: 'stop-head', role: 'button', tabindex: '0', 'aria-expanded': String(openStops.has(stop.placeId)) },
      h('span', { class: 'num' }, (i + 1) + '.'),
      h('span', { class: 'nm' }, dName(place.name)),
      pills,
      h('span', { class: 'times' }, fmt(stop.arriveAt) + estMark(curEst.stops.has(stop.placeId))),
      moveButtons(stop, i)); // ▲ ▼ at the right end of the title row (no extra line)
    const toggle = () => {
      const on = more.hidden; more.hidden = !on;
      head.setAttribute('aria-expanded', String(on));
      if (on) openStops.add(stop.placeId); else openStops.delete(stop.placeId);
    };
    head.onclick = toggle;
    head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
    const btns = navButtons(place, () => navTap(stop, i));
    // the ETA message goes to customers only: a stop with no delivery (a just-collect pickup) or a supplier place has no MSG
    if (hasDelivery && (S.places[baseId(stop.placeId)] || place).type !== 'supplier') btns.push(h('button', { class: 'small', onclick: () => { stopTapped(); noteMsg(stop.placeId); const m = stopMessage(stop, P.shiftMs); shareMessage(m.place, m.text); } }, 'MSG'));
    btns.push(primaryBtn(stop, i)); // REACHED, then DONE: one button, the place and size DONE always had
    btns.push(h('button', { class: 'small', onclick: () => openSkipSheet(stop, i) }, 'SKIP')); // Skip for today / Cancel job
    const rin = reachedInline(stop, i); // "Reached 14:10 · auto  Undo" at the end of the card's action lines (no extra row)
    return h('div', { class: 'card stop ' + (st || '') + (stop.detour ? ' detour' : '') + (rin ? ' reached' : '') },
      head, more,
      lines.length || rin ? h('div', { class: 'stop-acts' }, lines, rin ? h('div', { class: 'muted reached-line' }, rin) : null) : null,
      h('div', { class: 'stop-btns' }, btns));
  }

  // ---------- ▲ / ▼: the driver's own order (TravelTimes.moveStop) ----------
  // On every pending ordinary stop card (not done / skipped / fuel / end point). ▲ is off on the first pending stop, ▼ on the
  // last one before the end point. A tap swaps with the pending neighbour that way (a fuel stop keeps its place by moveStop's
  // rule), refuses a delivery before its own pickup (the notice names the item), re-times through the one timing path (learned
  // times, then only the missing legs fetched through the shared limiter; no re-solve) and turns the automatic re-order after
  // DONE / SKIP off until the next PLAN (P.manualOrder).
  function moveButtons(stop, i) {
    const cur = curPlan();
    if (!cur) return null;
    const pos = cur.stops.map((s, k) => (!s.status && !s.fuel ? k : -1)).filter((k) => k >= 0);
    const stopKey = (e) => { e.stopPropagation(); };
    const b = (dir, glyph, label, off) => h('button', { type: 'button', class: 'move-btn', 'data-move': dir < 0 ? 'up' : 'down', 'aria-label': label, disabled: off,
      onclick: (e) => { e.stopPropagation(); moveTap(stop, i, dir); }, onkeydown: stopKey }, glyph);
    return h('span', { class: 'move-btns' }, b(-1, '▲', 'Move up', i === pos[0]), b(1, '▼', 'Move down', i === pos[pos.length - 1]));
  }
  const moveRefusedText = (r) => "Can't move: " + r.item + ' is collected at ' + dName(pName(r.pickupId)) + ', so ' + dName(pName(r.deliverId)) + ' must come after it';
  const MANUAL_ORDER_TEXT = 'Manual order — tap PLAN to let the app reorder';
  const manualOrderNote = () => (S.plan && S.plan.manualOrder ? h('div', { class: 'muted manual-order', id: 'manualOrderNote', role: 'status' }, MANUAL_ORDER_TEXT) : null);
  async function moveTap(stop0, i0, dir) {
    stopTapped();
    const P = S.plan, cur = curPlan();
    const ls = liveStop(stop0, i0);
    if (!P || !cur || !ls) return;
    const jobs = {};
    ((P.ctx && P.ctx.jobs) || []).forEach((j) => { jobs[j.id] = j; });
    S.jobs.forEach((j) => { jobs[j.id] = j; });
    const r = TT.moveStop(cur.stops, ls.i, dir, jobs, baseId);
    if (!r) return;
    if (r.refused) { banner(moveRefusedText(r.refused), 'info'); return; }
    banner(null);
    P.result.plans = [Object.assign({}, cur, { stops: r.stops, order: r.stops.filter((s) => !s.fuel).map((s) => s.placeId) })]; P.idx = 0;
    P.alt = null; P.reorder = null; P.manualOrder = true;
    const toFetch = fillMoveLegs(P); // learned now; estimates for the rest until TomTom answers
    retimeNow();
    await savePlan();
    render();
    if (!toFetch.length) return;
    const now = Date.now();
    for (const f of toFetch) {
      if (S.plan !== P || !S.settings.tomtomKey || navigator.onLine === false || ttOut()) break;
      try {
        const res = await ttLeg(f.a, f.b, null); // through the shared limiter (one request start every 300 ms)
        if (res && res.seconds != null) { setLeg(curPlan().model, f.i, f.j, res.seconds, false); TT.remember(S.mem, f.a, f.b, now, res, now); }
      } catch (e) { /* that leg keeps its estimate */ }
    }
    saveMemory();
    if (S.plan !== P) return;
    retimeNow();
    await savePlan();
    if (S.tab === 'route') render();
  }
  function setLeg(m, i, j, sec, est) { // into every slice where that cell is missing / estimated
    m.matrices.forEach((x) => {
      const v = x.m[i] && x.m[i][j], bad = v == null || !isFinite(v) || v < 0 || !!(x.est && x.est[i] && x.est[i][j]);
      if (!bad || !x.m[i]) return;
      x.m[i][j] = sec;
      if (est && !x.est) x.est = x.m.map((row) => row.map(() => false));
      if (x.est && x.est[i]) x.est[i][j] = !!est;
    });
  }
  // The legs the new order needs that the plan's table lacks: a learned time (this part of the day) goes in at once; the rest
  // get the straight-line estimate now and are returned to be fetched. -> [{i, j, a, b}]
  function fillMoveLegs(P) {
    const plan = curPlan(), m = plan.model, k = m.stopIds.length;
    const miss = TT.missingOrderLegs(plan, lastDoneIdx(plan));
    const nodeAt = (x) => {
      if (x === 0) return nodeOf('start', m.start, P.ctx.start && P.ctx.start.id);
      if (x === k + 1) return nodeOf('end', m.end, P.ctx.end && P.ctx.end.id);
      const key = m.stopIds[x - 1], pl = S.places[baseId(key)] || P.ctx.places[key];
      return pl ? nodeOf(key, pl, baseId(key)) : null;
    };
    const bucket = TT.bucketOf(Date.now()), out = [];
    miss.forEach(({ i, j }) => {
      const a = nodeAt(i), b = nodeAt(j);
      if (!a || !b) return;
      const l = a.pid != null && b.pid != null ? TT.learned(S.mem, a.pid, b.pid, bucket) : null;
      if (l) { setLeg(m, i, j, l.s, false); return; }
      setLeg(m, i, j, Budget.estSec(a, b), true);
      out.push({ i, j, a, b });
    });
    return out;
  }

  // ---------- REACHED before DONE ----------
  // Reached on a proof stop (the DONE tap would complete a delivery whose item is collected: Proof.isProofStop over the same
  // OnBoard.doneSplit markDone uses): "📷 PROOF" (amber) in the DONE spot; every other stop keeps "✓ DONE".
  const isProofStopNow = (stop) => !stop.fuel && Proof.isProofStop(stop, OnBoard.doneSplit(stop, S.jobs, placeNameOf));
  const primaryBtn = (stop, i) => {
    const reached = Reached.isReached(stop), proof = reached && isProofStopNow(stop);
    return h('button', { class: 'small ok', 'data-act': proof ? 'proof' : reached ? 'done' : 'reached', onclick: () => primaryTap(stop, i) }, proof ? '📷 PROOF' : Reached.buttonLabel(stop));
  };
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
    delete stop.noAutoReach; // a REACHED (tap or auto) lifts an earlier Undo's hold (stampReached has none; assign keeps old keys)
    return true;
  }
  async function markReached(stop0, i0) { // REACHED: nothing but the stamp, the re-time and the repaint (no message, no day-log entry)
    const ls = liveStop(stop0, i0);
    if (!ls || !reachStop(ls.stop, 'tap')) return;
    await afterReachChange();
  }
  async function undoReachedTap(stop0, i0) { // back to REACHED; no auto-Reached here until he has been more than the distance away (or taps REACHED)
    const ls = liveStop(stop0, i0);
    if (!ls || ls.stop.status || !Reached.isReached(ls.stop)) return;
    Object.assign(ls.stop, Reached.undoReached(ls.stop));
    await afterReachChange();
    refreshFromLocation({ trigger: 'undo' });
  }
  // The one primary button: REACHED first, then DONE. For 500 ms after the stop became reached it ignores taps.
  function primaryTap(stop0, i0) {
    stopTapped();
    const ls = liveStop(stop0, i0);
    if (!ls) return;
    if (!Reached.isReached(ls.stop)) return markReached(stop0, i0);
    if (Reached.tapIgnored(ls.stop, Date.now())) return;
    if (isProofStopNow(ls.stop)) return openProofSheet(stop0, i0); // the proof sheet completes it (markDone with the proof)
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
      const stops = plan.stops.map((s) => { const pl = placeOfStop(s); return pl ? { id: s.placeId, lat: pl.lat, lng: pl.lng, status: s.status, reachedAt: s.reachedAt, noAutoReach: s.noAutoReach, fuel: !!s.fuel, actions: s.actions || [] } : null; }).filter(Boolean);
      if (P.ctx.end) stops.push({ id: END_ID, lat: P.ctx.end.lat, lng: P.ctx.end.lng, isEnd: true });
      const jobs = {}; // the jobs as they are NOW (a pickup's done flag is set by DONE at that pickup): Reached.canAutoReach
      ((P.ctx && P.ctx.jobs) || []).forEach((j) => { jobs[j.id] = j; });
      S.jobs.forEach((j) => { jobs[j.id] = j; });
      // within the Auto-Reached distance AND stopped (speed <= 2 m/s, or no speed and inside for 20 s): Reached.autoReachStep
      const step = Reached.autoReachStep(S.arTrack, fix, stops, { enabled: S.settings.autoReach !== false, visible: document.visibilityState === 'visible', now: Date.now(), jobs, radiusM: Reached.radiusOf(S.settings.autoReachM) });
      S.arTrack = step.track;
      // an Undo of Reached holds auto-Reached off for that stop until a fix puts the driver more than the distance away
      if (step.rearm && step.rearm.length) {
        let lifted = false;
        plan.stops.forEach((s) => { if (s.noAutoReach && !s.status && step.rearm.indexOf(s.placeId) >= 0) { delete s.noAutoReach; lifted = true; } });
        if (lifted) savePlan();
      }
      const id = step.id;
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
  // ---------- KEEP THE SCREEN ON while a day is running (wakelock.js) ----------
  // A day is running for the lock: a plan exists for TODAY and End day has not closed it (any tab counts). The browser drops the
  // lock whenever the page is hidden: it is asked again on visible, after PLAN, and kept in step on every render (End day releases).
  function lockWanted() {
    if (!S.settings || S.settings.keepScreenOn === false || !S.plan || !curPlan()) return false;
    const k = planDayKey();
    if (k !== DL.dateKey(Date.now())) return false;
    const d = S.days[k];
    return !(d && d.closed);
  }
  const wake = WakeKeep.create({ nav: () => navigator, wanted: lockWanted, visible: () => document.visibilityState === 'visible', onChange: () => paintWake() });
  const wakeText = () => (S.settings.keepScreenOn === false ? '' : WakeKeep.STATUS_TEXT[wake.state()] || '');
  function paintWake() { const el = document.getElementById('wakeState'); if (el) el.textContent = wakeText(); }
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
      takeFix({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp != null ? p.timestamp : Date.now(), speed: p.coords.speed != null && isFinite(p.coords.speed) ? p.coords.speed : null }, 'watch');
    } catch (e) { /* never break the page */ }
  }
  function onWatchError(e) {
    const code = e && e.code;
    if (code === 3) return; // TIMEOUT: the watch keeps trying by itself
    stopWatch(); W.blocked = true; // denied / unavailable: retried on the next visibility change
    const reason = code === 1 ? 'denied' : 'nofix';
    if (S.loc.reason !== reason) { S.loc.reason = reason; paintTimesLine(); } // the status line says why, as before (no toast)
  }
  // One fix (watch update, or the fresh foreground fix): store it, auto-reach, then re-time. A WATCH position never calls
  // TomTom: it only re-times locally (at most once per 30 s), counting the ETAs down from the last TomTom-based times.
  function takeFix(fix, src) {
    S.loc.lastFix = fix;
    const now = Date.now();
    if (autoReachCheck(fix)) { W.lastRetimeAt = now; return; } // auto-reach re-times at once (afterReachChange)
    if (src === 'watch') {
      if (!Reached.retimeDue(W.lastRetimeAt, now)) return;
      W.lastRetimeAt = now;
      if (S.plan && retimeNow()) { savePlan(); if (S.tab === 'route' && !document.querySelector('.backdrop')) render(); }
      return;
    }
    refreshFromLocation({ fix, trigger: 'visible' }); // the foreground fix: a live re-time if Budget allows (5-min gap, guard)
  }
  // The minute timer's live re-time: while visible with a stop pending, once every 10 minutes (Budget.PERIOD_MS), using the
  // watch's last fix when it is under a minute old (else one quick fix). Stopped by the daily guard.
  function liveTick() {
    if (!S.plan || S.loc.busy || document.visibilityState !== 'visible' || !hasPendingStop(curPlan()) || routeClosed()) return;
    const fx = S.loc.lastFix, fresh = fx && fx.ok && Date.now() - (fx.at || 0) <= 60000;
    refreshFromLocation({ trigger: 'tick', fix: fresh ? fx : undefined });
  }
  // Back in the foreground: one immediate FRESH fix (no cached position); auto-reach is evaluated when it arrives.
  async function freshFixNow() {
    const P = S.plan;
    if (!P) return;
    const fix = await quickFix(false, true);
    if (S.plan !== P) return;
    if (fix.ok) takeFix(fix, 'visible'); else refreshFromLocation({ fix, trigger: 'visible' });
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

  // opts.proof: the saved proof of delivery (the proof sheet's Save & done / No photo). A proof stop is never completed without one:
  // without it the tap opens the proof sheet instead.
  async function markDone(stop0, i0, opts) {
    const P = S.plan;
    const ls = liveStop(stop0, i0);
    if (!ls) return;
    const stop = ls.stop, i = ls.i;
    const proof = (opts && opts.proof) || null;
    const nowIso = (proof && proof.doneAt) || new Date().toISOString();
    // a delivery whose item is not collected yet is never completed: it stays open on its job (OnBoard.doneSplit); a card holding
    // nothing else completes nothing and stays as it is. Either way the notice names the item and where it is collected.
    const split = stop.fuel ? { apply: stop.actions || [], held: [], notice: null } : OnBoard.doneSplit(stop, S.jobs, placeNameOf);
    if (split.held.length && !split.apply.length) { banner(split.notice, 'info'); return; }
    if (!proof && Proof.isProofStop(stop, split)) { openProofSheet(stop0, i0); return; }
    if (split.held.length) { stop.leftOpen = split.held; stop.actions = split.apply; } // Undo of this DONE puts them back on the card
    const proofJobs = new Set(proof ? proof.jobIds || [] : []);
    if (proof) stop.proofId = proof.id; // the done card's SEND TO GROUP; Undo voids it
    for (const a of stop.actions) {
      const j = S.jobs.find((x) => x.id === a.jobId);
      if (!j) continue;
      if (a.kind === 'pickup') {
        const mine = (j.pickups || []).filter((p) => p.placeId === stop.placeId && !p.done);
        const p = mine.find((q) => (q.item || '') === (a.item || '')) || mine[0];
        if (p) { p.done = true; p.doneAt = nowIso; } // when it was collected (the "With you" bar shows it)
        if (!j.deliveryPlaceId && !j.errandPlaceId && j.pickups.every((q) => q.done)) { j.status = 'done'; j.doneAt = nowIso; }
      } else { j.status = 'done'; j.doneAt = nowIso; }
      if (a.kind === 'deliver' && proofJobs.has(j.id)) j.proofId = proof.id; // history / export find the proof from the job
      await saveJob(j);
      // a collect-only job marked DONE leaves a loose item with the driver (not a job: job counts never change)
      if (a.kind === 'pickup' && OnBoard.isCollectOnly(j) && j.status === 'done') await setLoose(OnBoard.addForJob(S.loose, j, { nameOf: placeNameOf, at: Date.parse(nowIso) }));
    }
    stop.status = 'done';
    stop.doneAt = nowIso;
    S.loc.origin = null;
    logDone(stop, nowIso, proof); // synchronous, in memory: never delays DONE (save + geolocation fix happen in the background)
    P.alt = null;
    P.result.plans = [P.result.plans[P.idx]]; P.idx = 0; // alternatives pre-date this DONE: drop them
    // live re-timing: from this stop, at the DONE time, order unchanged - shown at once, never waiting for the network
    P.result.plans[0] = timedPlan(P.result.plans[0], i, nowIso);
    P.shiftMs = 0;
    render();
    // (no whole-matrix refresh at a DONE: the live re-time below asks TomTom for the next leg only)
    // offer to send the ETA to the next stop if it is a delivery and has a WhatsApp number
    const plan = P.result.plans[0];
    const next = plan.stops.slice(i + 1).find((s) => !s.status);
    P.prompt = null;
    if (next && next.actions.some((a) => a.kind === 'deliver')) {
      const np = S.places[baseId(next.placeId)];
      if (np && np.whatsapp && np.type !== 'supplier') P.prompt = { placeId: next.placeId }; // suppliers are never messaged
    }
    if (!plan.stops.some((s) => !s.status)) toast('Run complete 🎉');
    await savePlan();
    render();
    if (split.notice) banner(split.notice, 'info'); else dayCompleteBanner();
    afterStop('done'); // after DONE: the live look-ahead (Part F) or one next-stop re-time; never blocks
  }

  // ---------- PROOF OF DELIVERY (proof.js) ----------
  // PROOF on a reached proof stop opens a full-screen sheet: Item photo / DO photo (the in-app camera, camera.js; at most 6 of each,
  // each saved to IndexedDB under a draft the moment it is taken; a DO shot goes through the corner screen, scan.js, first),
  // "Received by", Save & done (item photos stamped, DO photos re-encoded without a band, then markDone with the proof), No photo
  // (a reason chip, then markDone), Cancel (deletes the draft). A done card with an unsent proof shows SEND TO GROUP.
  const PF = { meta: new Map(), files: new Map(), sheet: null }; // meta: proofId -> record (no blobs); files: proofId -> [File] (today's unsent)
  const WA_GLYPH = 'whatsapp-glyph.svg'; // copied byte-for-byte from the brand pack (README); never drawn by the app
  const proofDayKey = () => DL.dateKey(Date.now());
  const stopItems = (split) => Proof.proofDeliveries(split).map((a) => deliverItem(a) || 'Item');
  function voidProof(id) {
    const m = PF.meta.get(id);
    if (m) m.state = 'void';
    PF.files.delete(id);
    Proof.getProof(id).then((p) => { if (p) { p.state = 'void'; return Proof.putProof(p); } }).catch(() => {});
  }
  function sendButton(stop) {
    const m = stop.proofId && PF.meta.get(stop.proofId);
    if (!m || m.state !== 'done') return null;
    const label = Proof.sendLabel((m.photoIds || []).length, !!S.settings.proofCaptionFirst, m.sendStep === 1 ? 1 : 0, m.sentAt);
    const sent = label === 'SENT ✓', rest = /^SEND REST/.test(label);
    return h('button', { class: 'small send-group' + (sent ? ' sent' : ''), type: 'button', 'data-act': 'send', 'data-proof': m.id, 'aria-label': sent ? 'Sent to group, send again' : rest ? 'Send the rest of the photos to the group' : 'Send to group', onclick: () => sendTap(m.id) },
      sent ? null : h('img', { class: 'wa-glyph', src: WA_GLYPH, alt: '', 'aria-hidden': 'true' }), label);
  }
  // the shared files, in the exact share order (item photos in capture order, then DO photos): Proof.shareFiles names them
  // "01_<name>", "02_<name>", ... and gives the first the earliest lastModified, each next one 1000 ms later
  const filesOf = (proof, phs) => Proof.shareFiles(proof, phs).map((x) => new File([x.photo.blob], x.name, { type: 'image/jpeg', lastModified: x.lastModified }));
  async function proofFiles(proof) {
    if (PF.files.has(proof.id)) return PF.files.get(proof.id);
    const phs = await Proof.photosOf(proof.id);
    const files = filesOf(proof, phs);
    if (!proof.sentAt && proof.dayKey === proofDayKey()) PF.files.set(proof.id, files);
    return files;
  }
  // SEND TO GROUP: the caption to the clipboard, then navigator.share({files, text}) once canShare says yes. Resolved: sentAt set,
  // the button reads SENT ✓ (tap = send again). Rejected (backed out): nothing changes. canShare no: a notice, nothing changes.
  // Settings "Send caption with first photo (2 steps)" and 2+ photos (Proof.sendStep): tap 1 shares the first file with the caption
  // (the clipboard copy and its notice on this tap only) and the button reads SEND REST (<n>); tap 2 shares the rest with no text,
  // then SENT ✓ and sentAt. Backing out of either keeps the button on that step (proof.sendStep, stored with the proof).
  function sendTap(id) {
    const m = PF.meta.get(id);
    if (!m) return;
    const text = Proof.caption(m);
    const cached = PF.files.get(id);
    const two = !!S.settings.proofCaptionFirst;
    const step = m.sendStep === 1 ? 1 : 0;
    const go = (files) => {
      const st = Proof.sendStep(files.length, two, step);
      if (st.copy) copyText(text).then((ok) => { if (ok) toast('Caption copied - paste it if WhatsApp shows none'); });
      const part = files.slice(st.from, st.to);
      const data = part.length ? (st.text ? { files: part, text } : { files: part }) : { text };
      if (!navigator.share || (navigator.canShare && !navigator.canShare(data)) || (part.length && !navigator.canShare)) { banner('This browser cannot share photos', 'info'); return; }
      navigator.share(data).then(async () => {
        const nx = Proof.afterShare(files.length, two, step, true);
        const p = (await Proof.getProof(id).catch(() => null)) || m;
        p.sendStep = nx.step; m.sendStep = nx.step;
        if (nx.sent) { p.sentAt = new Date().toISOString(); m.sentAt = p.sentAt; PF.files.delete(id); }
        else PF.files.set(id, files); // tap 2 shares from memory, inside the tap
        await Proof.putProof(p).catch(() => {});
        if (S.tab === 'route') render();
      }).catch(() => { /* backed out: nothing changes (the same step) */ });
    };
    if (cached || !(m.photoIds || []).length) { go(cached || []); return; } // inside the tap: share() runs before any await
    proofFiles(m).then(go).catch(() => banner('Could not read the photos on this phone', 'error'));
  }
  // the fix for a photo: the last GPS fix when it is at most 2 minutes old at capture, else null ("GPS not available")
  function proofFix(at) {
    const f = S.loc.lastFix;
    return f && f.ok && f.at != null && Math.abs(at - f.at) <= Proof.GPS_MAX_AGE_MS ? { lat: f.lat, lon: f.lng, acc: f.accuracy, at: f.at } : null;
  }
  function newDraft(stop, split) {
    const place = placeOfStop(stop) || {}, saved = S.places[baseId(stop.placeId)] || place;
    const dels = Proof.proofDeliveries(split);
    return { id: uid('pf'), state: 'draft', dayKey: proofDayKey(), stopKey: stop.placeId, doneAt: null, placeId: baseId(stop.placeId), placeName: dName(saved.name || place.name || ''),
      address: saved.address || place.address || '', jobIds: dels.map((a) => a.jobId), items: stopItems(split), receiver: '', noPhotoReason: '', gps: null, photoIds: [], sentAt: null, driveAt: null };
  }
  async function findDraft(stopKey) {
    const all = await Proof.listProofs();
    return all.filter((p) => p.state === 'draft' && p.stopKey === stopKey && p.dayKey === proofDayKey()).sort((a, b) => (b.photoIds || []).length - (a.photoIds || []).length)[0] || null;
  }
  async function openProofSheet(stop0, i0, draft0) {
    stopTapped();
    const ls = liveStop(stop0, i0);
    if (!ls || PF.sheet) return;
    const stop = ls.stop, split = OnBoard.doneSplit(stop, S.jobs, placeNameOf);
    if (!Proof.isProofStop(stop, split)) return;
    let draft = draft0 || null;
    if (!draft) { try { draft = await findDraft(stop.placeId); } catch (e) { draft = null; } }
    if (PF.sheet) return;
    const proof = draft || newDraft(stop, split);
    proof.items = stopItems(split); proof.jobIds = Proof.proofDeliveries(split).map((a) => a.jobId);
    let photos = [];
    if (draft) { try { photos = (await Proof.photosOf(draft.id)).sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0)); } catch (e) { photos = []; } }
    const urls = [];
    let busy = false;
    const sh = openSheet(proof.placeName || dName((placeOfStop(stop) || {}).name || ''), () => {
      Camera.close(); Scan.closeCornerScreen(); // closing the sheet stops every camera track
      urls.forEach((u) => URL.revokeObjectURL(u)); PF.sheet = null;
    });
    PF.sheet = sh;
    sh.sheet.id = 'proofSheet'; sh.sheet.classList.add('proof-sheet'); sh.back.classList.add('proof-back'); // full screen: Cancel / Save / No photo close it
    const close = () => sh.close();
    const MAXK = Proof.MAX_PER_KIND;
    const nOf = (k) => photos.filter((p) => Proof.kindOf(p) === k).length;
    // the phone's own camera app (the in-app camera's fallback when it cannot open): one shot per pick
    const fileIn = h('input', { type: 'file', id: 'proofFile', accept: 'image/*', capture: 'environment', hidden: true });
    // "From gallery" in the DO camera view: already-scanned pages (no capture attribute; several at once, up to the DO limit).
    // They skip the corner screen and the clean-up; only orientation and the 2000 px cap apply (Proof.composeDo at Save & done).
    const galleryIn = h('input', { type: 'file', id: 'proofGallery', accept: 'image/*', multiple: true, hidden: true });
    let fileKind = 'item';
    const pickFile = (k) => { fileKind = k; fileIn.value = ''; fileIn.click(); };
    // two capture buttons side by side: each opens the in-app camera (camera.js) for that kind
    const itemBtn = h('button', { class: 'primary', id: 'proofItemBtn', type: 'button', 'data-kind': 'item', onclick: () => openCamera('item') }, 'Item photo');
    const doBtn = h('button', { class: 'primary', id: 'proofDoBtn', type: 'button', 'data-kind': 'do', onclick: () => openCamera('do') }, 'DO photo');
    const thumbs = h('div', { class: 'proof-thumbs', id: 'proofThumbs' });
    const rcv = h('input', { id: 'proofReceiver', maxlength: String(Proof.RECEIVER_MAX), autocomplete: 'off', value: proof.receiver || '', placeholder: 'Name (optional)' });
    const saveBtn = h('button', { class: 'ok', id: 'proofSave', type: 'button' }, 'Save & done');
    const status = h('div', { class: 'muted', id: 'proofStatus', role: 'status' });
    const reasons = h('div', { class: 'proof-reasons', id: 'proofReasons', hidden: true },
      h('div', { class: 'muted' }, 'Why is there no photo?'),
      Proof.REASONS.map((r) => h('button', { class: 'chip-btn-r proof-reason', type: 'button', 'data-reason': r, onclick: () => finish(r) }, r)));
    const noPhoto = h('button', { class: 'link-undo proof-nophoto', id: 'proofNoPhoto', type: 'button', onclick: () => { reasons.hidden = !reasons.hidden; } }, 'No photo');
    const cancelBtn = h('button', { id: 'proofCancel', type: 'button', onclick: async () => { if (busy) return; close(); try { if (draft || photos.length) await Proof.deleteProof(proof.id); } catch (e) { /* ignore */ } } }, 'Cancel');
    function paint() {
      urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
      const thumb = (ph) => {
        const u = URL.createObjectURL(ph.blob); urls.push(u);
        return h('div', { class: 'proof-thumb', 'data-kind': Proof.kindOf(ph) }, h('img', { src: u, alt: (Proof.kindOf(ph) === 'do' ? 'DO photo ' : 'Item photo ') + fmt(ph.takenAt) }),
          h('button', { class: 'proof-del', type: 'button', 'aria-label': 'Remove photo', onclick: () => removePhoto(ph.id) }, '×'));
      };
      const group = (k, title) => {
        const list = photos.filter((p) => Proof.kindOf(p) === k);
        return list.length ? h('div', { class: 'proof-group', 'data-kind': k }, h('div', { class: 'proof-group-h' }, title), h('div', { class: 'proof-grid' }, list.map(thumb))) : null;
      };
      thumbs.replaceChildren(...[group('item', 'Item'), group('do', 'DO')].filter(Boolean));
      [[itemBtn, 'item', 'Item photo'], [doBtn, 'do', 'DO photo']].forEach(([b, k, t]) => {
        b.disabled = busy || nOf(k) >= MAXK;
        b.textContent = nOf(k) >= MAXK ? t + ' (' + MAXK + ' max)' : t;
      });
      saveBtn.disabled = busy || !photos.length;
    }
    // a photo of kind k into the draft (IndexedDB) the moment it is taken; at = the capture time; src = {srcW, srcH}: the pixel
    // size of the still the camera (or the picked file) gave
    async function addPhoto(blob, k, at, src) {
      if (!blob || nOf(k) >= MAXK || !PF.sheet) return;
      const ph = { id: uid('ph'), proofId: proof.id, kind: k, blob, bytes: blob.size, takenAt: at, gps: proofFix(at), srcW: (src && src.srcW) || null, srcH: (src && src.srcH) || null };
      if (ph.gps) proof.gps = ph.gps;
      photos.push(ph);
      paint();
      try { await Proof.putPhoto(ph); await saveDraft(); status.textContent = ''; } catch (e) { status.textContent = 'Could not save the photo on this phone'; }
    }
    // a DO shot: the corner screen first (Use = straightened, Keep as shot, Retake = discarded) -> true when a photo was kept
    async function doShot(blob, at, parent) {
      const r = await Scan.cornerScreen(blob, { parent, maxLong: Proof.DO_LONG });
      if (r.action === 'retake' || !r.blob) return false;
      await addPhoto(r.blob, 'do', at, { srcW: r.srcW, srcH: r.srcH });
      return true;
    }
    function openCamera(k) {
      if (busy || nOf(k) >= MAXK) return;
      Camera.open(k, {
        label: k === 'do' ? 'DO photo' : 'Item photo', max: MAXK, count: nOf,
        onShot: async (blob, kk, src) => { const at = Date.now(); if (kk === 'do') await doShot(blob, at, Camera.view()); else await addPhoto(blob, 'item', at, src); },
        onFallback: (kk) => pickFile(kk), // inside the tap: the file input opens the phone's camera app
        onGallery: k === 'do' ? () => { galleryIn.value = ''; galleryIn.click(); } : null, // inside the tap
        onClose: () => { if (PF.sheet === sh) paint(); },
      });
    }
    galleryIn.addEventListener('change', async () => {
      const fs = [...(galleryIn.files || [])];
      galleryIn.value = '';
      const at = Date.now();
      let added = 0;
      for (let i = 0; i < fs.length && nOf('do') < MAXK && PF.sheet === sh; i++) {
        const size = await Scan.sizeOf(fs[i]);
        await addPhoto(fs[i], 'do', at + i, size ? { srcW: size.w, srcH: size.h } : null); // picked order = capture order
        added++;
        Camera.refresh();
      }
      if (added < fs.length) status.textContent = 'DO photos: ' + MAXK + ' max - ' + (fs.length - added) + ' not added';
    });
    async function saveDraft() {
      proof.photoIds = photos.map((p) => p.id);
      proof.receiver = rcv.value.trim().slice(0, Proof.RECEIVER_MAX);
      await Proof.putProof(proof);
      draft = proof;
    }
    async function removePhoto(id) {
      if (busy) return;
      photos = photos.filter((p) => p.id !== id);
      paint();
      try { await Proof.deletePhoto(id); await saveDraft(); } catch (e) { /* ignore */ }
    }
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      const k = fileKind;
      fileKind = 'item';
      if (!f || nOf(k) >= MAXK) return;
      const at = Date.now();
      if (k !== 'do') { const size = await Scan.sizeOf(f); await addPhoto(f, 'item', at, size ? { srcW: size.w, srcH: size.h } : null); return; }
      // a DO photo from the phone's camera app still goes through the corner screen; Retake opens the phone camera again
      const kept = await doShot(f, at, null);
      if (!kept && PF.sheet === sh) pickFile('do');
    });
    rcv.addEventListener('change', () => { if (draft) saveDraft().catch(() => {}); });
    saveBtn.onclick = () => finish(null);
    // Save & done (reason null) or No photo (a reason): the stamped photos replace the raw ones, state "done", then the stop is
    // completed through markDone, the one path the DONE tap uses.
    async function finish(reason) {
      if (busy) return;
      if (reason == null && !photos.length) return;
      busy = true; paint();
      status.textContent = reason == null ? 'Stamping photos…' : 'Saving…';
      try {
        proof.receiver = rcv.value.trim().slice(0, Proof.RECEIVER_MAX);
        proof.doneAt = new Date().toISOString();
        const ls2 = liveStop(stop0, i0), split2 = ls2 && OnBoard.doneSplit(ls2.stop, S.jobs, placeNameOf);
        if (split2) { proof.items = stopItems(split2); proof.jobIds = Proof.proofDeliveries(split2).map((a) => a.jobId); }
        let stamped = [];
        if (reason == null) {
          for (const ph of photos) {
            const k = Proof.kindOf(ph);
            let blob;
            // item: the band, logo and stamp lines (1600 px); DO: no band, no text (2000 px)
            try { blob = k === 'do' ? await Proof.composeDo(ph.blob) : await Proof.compose(ph.blob, proof, { takenAt: ph.takenAt, gps: ph.gps || null }); } catch (e) { blob = ph.blob; } // undecodable: kept as taken
            stamped.push({ id: ph.id, proofId: proof.id, kind: k, blob, bytes: blob.size, takenAt: ph.takenAt, gps: ph.gps || null, srcW: ph.srcW || null, srcH: ph.srcH || null });
          }
          proof.noPhotoReason = '';
        } else {
          for (const ph of photos) await Proof.deletePhoto(ph.id).catch(() => {});
          proof.noPhotoReason = reason;
        }
        proof.photoIds = stamped.map((p) => p.id);
        proof.counts = Proof.countKinds(stamped); // {item, do}: the CSV "proof" text
        proof.state = 'done'; proof.sentAt = null; proof.driveAt = null;
        await Proof.saveStamped(proof, stamped);
        Proof.persistOnce(); // asked once, on the first saved proof; never awaited
        PF.meta.set(proof.id, Object.assign({}, proof));
        PF.files.set(proof.id, filesOf(proof, stamped));
      } catch (e) {
        busy = false; paint();
        status.textContent = 'Could not save the proof on this phone - try again';
        return;
      }
      close();
      await markDone(stop0, i0, { proof });
    }
    sh.body.replaceChildren(
      h('div', { class: 'proof-items', id: 'proofItems' }, proof.items.map((t) => h('div', { class: 'act deliver' }, t))),
      h('div', { class: 'proof-take' }, itemBtn, doBtn), fileIn, galleryIn, thumbs,
      h('label', { class: 'field', for: 'proofReceiver' }, 'Received by'), rcv,
      status, reasons,
      h('div', { class: 'proof-foot' }, noPhoto),
      h('div', { class: 'sticky-actions' }, cancelBtn, saveBtn));
    paint();
  }
  // After load: proofs of today's plan into memory (the SEND buttons), today's unsent photos as Files, a draft for a stop still
  // pending reopens its sheet; retention once per load. Never blocks the launch.
  async function proofsOnLoad() {
    try {
      const all = await Proof.listProofs(), plan = curPlan();
      all.forEach((p) => { if (p.state !== 'draft') PF.meta.set(p.id, p); });
      const today = proofDayKey();
      for (const p of all) if (p.state === 'done' && !p.sentAt && p.dayKey === today && (p.photoIds || []).length) await proofFiles(p).catch(() => {});
      if (plan && plan.stops.some((s) => s.proofId) && S.tab === 'route' && !document.querySelector('.backdrop')) render();
      const draft = plan && all.filter((p) => p.state === 'draft' && p.dayKey === today && (p.photoIds || []).length).find((p) => plan.stops.some((s) => s.placeId === p.stopKey && !s.status));
      if (draft) {
        const i = plan.stops.findIndex((s) => s.placeId === draft.stopKey && !s.status);
        if (S.tab !== 'route') { S.tab = 'route'; render(); }
        await openProofSheet(plan.stops[i], i, draft);
      }
    } catch (e) { /* no IndexedDB: proof capture still opens; nothing to restore */ }
    try { await Proof.runRetention(Date.now()); } catch (e) { /* ignore */ }
  }
  function proofSettingsCard(s) {
    const line = h('div', { class: 'muted', id: 'proofLine' }, 'Checking…');
    Promise.all([Proof.usage().catch(() => ({ count: 0, bytes: 0 })), Proof.persisted()]).then(([u, prot]) => {
      line.textContent = u.count + (u.count === 1 ? ' delivery' : ' deliveries') + ' · ' + (u.bytes / 1048576).toFixed(1) + ' MB on this phone · kept 2 years · storage: ' + (prot ? 'protected' : 'not protected');
    });
    return h('div', { class: 'card', id: 'proofCard' }, h('h2', { style: 'margin-top:0' }, 'Proof of delivery'), line,
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', id: 'proofCaptionFirst', checked: !!s.proofCaptionFirst, style: 'width:auto;min-height:0', onchange: (e) => { s.proofCaptionFirst = e.target.checked; saveSettings(); } }),
        ' Send caption with first photo (2 steps)'));
  }

  // ---------- SKIP: "Skip for today" or "Cancel job" ----------
  // SKIP on a Route card asks first: Skip for today (exactly what SKIP did: the stop is skipped, its jobs roll to tomorrow) or Cancel
  // job (the office no longer needs it: OnBoard.cancelJobs). One job on the card = that one; several = a list to tick.
  function cardJobLabel(stop, r) {
    const j = S.jobs.find((x) => x.id === r.jobId) || ((S.plan && S.plan.ctx.jobs) || []).find((x) => x.id === r.jobId);
    const a = (stop.actions || []).find((x) => x.jobId === r.jobId) || {};
    if (a.kind === 'pickup') return 'Collect ' + (a.item || 'items') + (j && j.deliveryPlaceId ? ' → ' + dName(pName(j.deliveryPlaceId)) : '');
    if (a.kind === 'deliver') return 'Deliver ' + (deliverItem(a) || 'item');
    return 'Errand: ' + (a.item || 'Errand');
  }
  function openSkipSheet(stop0, i0) {
    stopTapped();
    const ls = liveStop(stop0, i0);
    if (!ls) return;
    const stop = ls.stop, list = OnBoard.jobsOnCard(stop);
    const sh = openSheet('SKIP · ' + dName((placeOfStop(stop) || {}).name || ''));
    sh.sheet.id = 'skipSheet';
    const ticked = new Set();
    function draw(picking) {
      if (!picking) {
        sh.body.replaceChildren(
          h('button', { class: 'pick-row', id: 'skipToday', onclick: () => { sh.close(); skipStop(stop0, i0); } },
            h('span', { class: 'title' }, 'Skip for today'), h('span', { class: 'muted' }, 'Stays pending and rolls to tomorrow')),
          h('button', { class: 'pick-row', id: 'cancelJob', disabled: !list.length, onclick: () => { if (list.length === 1) { sh.close(); cancelOnRoute([list[0].jobId]); } else draw(true); } },
            h('span', { class: 'title' }, 'Cancel job'), h('span', { class: 'muted' }, 'No longer needed: off the route, not carried to tomorrow')),
          h('button', { onclick: sh.close }, 'Back'));
        return;
      }
      const go = h('button', { class: 'primary', id: 'cancelTicked', disabled: !ticked.size, onclick: () => { sh.close(); cancelOnRoute(Array.from(ticked)); } }, 'Cancel ticked');
      sh.body.replaceChildren(h('div', { class: 'muted' }, 'Tick the jobs to cancel. The others stay on the card.'),
        h('div', { id: 'cancelList' }, list.map((r) => h('label', { class: 'check-row cancel-row' },
          h('input', { type: 'checkbox', 'data-job': r.jobId, style: 'width:auto;min-height:0', onchange: (e) => { if (e.target.checked) ticked.add(r.jobId); else ticked.delete(r.jobId); go.disabled = !ticked.size; } }),
          ' ' + cardJobLabel(stop, r)))),
        h('div', { class: 'sticky-actions' }, h('button', { onclick: () => draw(false) }, 'Back'), go));
    }
    draw(false);
  }
  async function cancelOnRoute(ids) {
    const P = S.plan, cur = curPlan();
    if (!P || !cur || !ids.length) return;
    const now = Date.now(), nowIso = iso(now);
    const r = OnBoard.cancelJobs({ jobs: S.jobs, plan: cur, loose: S.loose }, ids, { nameOf: placeNameOf, at: now });
    if (!r.cancelled.length) return;
    S.jobs = r.jobs;
    for (const c of r.cancelled) await saveJob(S.jobs.find((x) => x.id === c.jobId));
    await setLoose(r.loose); // an item already collected: With you
    try { const d = dayFor(now, true); r.cancelled.forEach((c) => DL.recordCancel(d, { nowIso, jobId: c.jobId, item: c.item, place: c.place })); bgSaveDay(d); } catch (e) { /* never break the cancel */ }
    P.result.plans = [r.plan]; P.idx = 0; P.alt = null; S.loc.origin = null;
    retimeNow(); // the same path SKIP uses: re-time, then the after-stop re-check
    await savePlan();
    render();
    toastUndo('Cancelled: ' + r.cancelled.map((c) => (c.item || 'job') + (c.place ? ' (' + dName(c.place) + ')' : '')).join(', '), () => undoCancelTap(r));
    afterStop('skip');
  }
  async function undoCancelTap(r) {
    const P = S.plan, cur = curPlan();
    if (!P || !cur) return;
    const u = OnBoard.undoCancel({ jobs: S.jobs, plan: cur, loose: S.loose }, r.prev);
    S.jobs = u.jobs;
    for (const id of Object.keys(r.prev.jobs)) await saveJob(S.jobs.find((x) => x.id === id));
    await setLoose(u.loose);
    try { const d = dayFor(Date.now(), false); if (d) { Object.keys(r.prev.jobs).forEach((id) => DL.recordUndoCancel(d, { nowIso: iso(Date.now()), jobId: id })); bgSaveDay(d); } } catch (e) { /* ignore */ }
    P.result.plans = [u.plan]; P.idx = 0; P.alt = null; P.reorder = null; S.loc.origin = null;
    retimeNow();
    await savePlan();
    render();
    refreshFromLocation({ trigger: 'undo' });
  }

  // A stop becomes skipped ONLY by this explicit tap (nothing else - DONE order, timing, replan - ever sets it).
  async function skipStop(stop0, i0) { // actions stay pending; skipped stops leave the re-time chain and the header counts
    stopTapped();
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
    toast(ls.stop.fuel ? 'Fuel stop skipped. Undo skip to bring it back.' : 'Skipped — actions stay pending. Undo skip to bring it back.');
    await savePlan();
    render();
    afterStop('skip');
  }
  async function undoSkip(stop0, i0) { // puts the stop back in the chain and re-times
    stopTapped();
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
    refreshFromLocation({ trigger: 'undo' });
  }

  // ---------- AFTER EACH STOP: LIVE LOOK-AHEAD (TravelTimes.lookAhead) ----------
  // DONE / SKIP with at least 2 stops pending (end point not counted) and the setting not Off: live times for NOW from where
  // you are (a first-leg probe over the stops that may come next, or every needed pair when 5 or fewer are pending), a re-solve
  // of the pending stops with every rule, and a switch only when the best order is different AND at least 10 minutes earlier
  // at the end point. It only RE-ORDERS pending stops (never adds, removes, skips or un-skips one). TomTom out / the allowance
  // guard / Matrix service / setting Off: the single next-stop re-time instead.
  const todayMsg = (pid) => { const t = S.plan && S.plan.ctx.msgAt && S.plan.ctx.msgAt[pid]; return t != null && DL.dateKey(t) === DL.dateKey(Date.now()); };
  function noteMsg(pid) { try { const c = S.plan.ctx; c.msgAt = Object.assign({}, c.msgAt || {}, { [pid]: Date.now() }); savePlan(); } catch (e) { /* never block MSG */ } }
  function stopTapped() { // the "Order updated" notice stays until the next tap on a stop button
    const P = S.plan;
    if (P && P.reorder && P.reorder.kind === 'notice') P.reorder = null;
  }
  const pendingStops = (plan) => plan.stops.filter((s) => !s.status && !s.fuel);
  async function afterStop(trigger) {
    const P = S.plan, plan = curPlan();
    if (!P || !plan) return;
    if (P.reorder && P.reorder.kind === 'card') P.reorder = null; // an unanswered suggestion belongs to the previous stop
    P.noSwitch = false; // an Undo holds switches only until the next DONE / SKIP
    const pend = pendingStops(plan);
    // manual: the driver moved a stop himself (▲ / ▼): no automatic re-order until the next PLAN
    const mode = Budget.afterStopMode({ setting: S.settings.afterStop || 'auto', pending: pend.length, guard: ttGuard(), down: ttOut(), service: ttService(), manual: !!P.manualOrder });
    if (mode !== 'lookahead' || !S.settings.tomtomKey || navigator.onLine === false || pend.some((s) => s.reachedAt != null)) return refreshFromLocation({ trigger });
    S.tt.lastLiveAt = Date.now();
    try { await lookAheadNow(P); } catch (e) { /* never break DONE: the plan keeps its times */ }
  }
  async function lookAheadNow(P) {
    const plan0 = curPlan(), m = plan0.model, now = Date.now(), nowIso = iso(now);
    const placeOf = (id) => S.places[id] || P.ctx.places[id];
    // where you are: the fix (as the saved place when within 150 m), else the last DONE stop, else the plan's start
    const fix = await quickFix(false);
    if (S.plan !== P) return;
    if (fix.ok && autoReachCheck(Object.assign({ at: Date.now() }, fix))) return; // on site at the next stop already: no look-ahead
    const di = lastDoneIdx(plan0, true), ds = di >= 0 ? placeOf(plan0.stops[di].placeId) : null;
    const here = fix.ok && fix.accuracy <= Solver.LOC.MAX_ACCURACY_M ? { lat: fix.lat, lng: fix.lng } : ds ? { lat: ds.lat, lng: ds.lng } : { lat: m.start.lat, lng: m.start.lng };
    const plan = curPlan(), pend = pendingStops(plan);
    const pendIds = new Set(pend.map((s) => s.placeId));
    const pendPlaces = new Set(pend.map((s) => baseId(s.placeId))); // a second visit '<place>#2' is that saved place
    // the jobs still to do at the pending stops (skipped stops stay skipped: OnBoard.jobsForPlan)
    const placesOfJob = (j) => (j.errandPlaceId ? [j.errandPlaceId] : (j.pickups || []).filter((p) => !p.done).map((p) => p.placeId).concat(j.deliveryPlaceId ? [j.deliveryPlaceId] : []));
    const jobs = planJobs(OnBoard.jobsForPlan(JSON.parse(JSON.stringify(S.jobs.filter((j) => !j.status || j.status === 'pending'))), plan), plan)
      .filter((j) => { const ps = placesOfJob(j); return ps.length && ps.every((p) => pendPlaces.has(p)); });
    const places = Object.assign({}, P.ctx.places, S.places);
    const base = { start: here, end: { lat: m.end.lat, lng: m.end.lng }, jobs, places, departAtISO: nowIso, noDetour: P.noDetour, respectClosedWindows: !!m.respectClosed };
    const prec = Solver.precedence(base);
    if (prec.stopIds.length !== pend.length || !prec.stopIds.every((id) => pendIds.has(id))) return refreshFromLocation({ trigger: 'done' }); // never add / drop a stop
    const origin = nodeOf(TT.ORIGIN, here, null);
    const endPid = P.ctx.end && P.ctx.end.id && S.places[P.ctx.end.id] ? P.ctx.end.id : null;
    const end = nodeOf(TT.END, m.end, endPid);
    const nodes = new Map([[TT.ORIGIN, origin], [TT.END, end]]);
    const pendNodes = pend.map((s) => { const pl = placeOf(s.placeId) || placeOf(baseId(s.placeId)); const n = nodeOf(s.placeId, pl, baseId(s.placeId)); nodes.set(s.placeId, n); return n; });
    const bucket = TT.bucketOf(now);
    // the plan's own table (indices: 0 start, 1..k stops, k+1 end) for any leg neither fetched nor learned
    const k = m.stopIds.length, sl = m.matrices[0];
    const midx = (key) => (key === TT.ORIGIN ? (di >= 0 && m.stopIds.indexOf(plan0.stops[di].placeId) >= 0 ? m.stopIds.indexOf(plan0.stops[di].placeId) + 1 : 0) : key === TT.END ? k + 1 : m.stopIds.indexOf(key) + 1);
    const fallback = (a, b) => {
      const i = midx(a), j = midx(b);
      if (i > 0 || a === TT.ORIGIN) { const v = sl.m[i] && sl.m[i][j]; if (j > 0 && v != null && isFinite(v)) return v; }
      return Budget.estSec(nodes.get(a), nodes.get(b));
    };
    const learnedSec = (a, b) => { const x = nodes.get(a), y = nodes.get(b); if (!x || !y || x.pid == null || y.pid == null) return null; const l = TT.learned(S.mem, x.pid, y.pid, bucket); return l ? l.s : null; };
    const post = (p) => LunchBreak.applyBreak(Solver.retime(p, -1, nowIso), curLunch(), S.settings, Date.now());
    const ad = TT.solverAdapter(Solver, base, post);
    const fullMax = Number.isFinite(Number(S.settings.fullRefreshMax)) ? Number(S.settings.fullRefreshMax) : TT.FULL_REFRESH_MAX;
    const res = await TT.lookAhead({
      origin, pending: pendNodes, end, links: linksOf(jobs, places), before: prec.before, current: pend.map((s) => s.placeId), fullRefreshMax: fullMax,
      learned: learnedSec, fallback,
      fetchLive: async (a, b) => { const r = await ttLeg(a, b, null); if (r) TT.remember(S.mem, a, b, now, r, now); return r; },
      solve: (leg) => ad.solve((x, y) => leg(x === TT.ORIGIN ? TT.ORIGIN : x, y)),
      arrival: (order, leg) => ad.arrival(order, leg),
    });
    saveMemory();
    if (S.plan !== P || curPlan() !== plan) return; // the plan moved on while we waited
    if (res.aborted) { retimeNow(); await savePlan(); if (S.tab === 'route') render(); return; } // TomTom out: estimates (one notice)
    // the times returned for now refresh the ETAs: stop -> stop / end legs into the plan's table, the first leg as the live origin
    res.live.forEach((sec, key) => {
      const [a, b] = key.split('>');
      if (a === TT.ORIGIN) return;
      const i = midx(a), j = midx(b);
      if (i > 0 && j > 0) m.matrices.forEach((x) => { x.m[i][j] = sec; if (x.est) x.est[i][j] = false; });
    });
    const firstOf = (order) => order[0];
    const setOrigin = (order) => {
      const nx = firstOf(order), sec = res.live.get(TT.ORIGIN + '>' + nx);
      if (sec != null) { const t = Date.now(); S.loc.origin = { placeId: nx, lat: here.lat, lng: here.lng, arriveMs: t + sec * 1000, usedAt: t }; S.timesFrom = t; S.loc.reason = null; }
    };
    const cur = pend.map((s) => s.placeId);
    const setting = S.settings.afterStop || 'auto';
    const d = TT.decide({ res, setting, current: cur, messagedNext: todayMsg(cur[0]), held: P.noSwitch });
    if (d.action === 'none') { setOrigin(cur); retimeNow(); await savePlan(); if (S.tab === 'route') render(); return; }
    const text = TT.reorderText(cur, res.best, res.saveSec, (id) => dName(pName(id)));
    if (d.action === 'switch' && applyOrder(res.best, 'auto', text)) {
      setOrigin(res.best);
      retimeNow();
    } else {
      P.reorder = { kind: 'card', order: res.best, text, extra: d.messaged ? dName((placeOf(cur[0]) || {}).name || '') + ' was already messaged' : null };
      setOrigin(cur);
      retimeNow();
    }
    await savePlan();
    if (S.tab === 'route') render();
  }
  // Put the pending stops in `order` (done / skipped stops keep their places); a pending fuel stop is put back by its own rule.
  function applyOrder(order, via, text) {
    const P = S.plan, cur = curPlan();
    const prev = { stops: JSON.parse(JSON.stringify(cur.stops)), order: cur.order.slice(), origin: S.loc.origin ? Object.assign({}, S.loc.origin) : null };
    const base = stripFuel(cur);
    const stops = TT.reorderStops(base.stops, order);
    if (!stops) return false; // never adds, removes, skips or un-skips a stop
    let next = Object.assign({}, base, { stops, order: stops.map((s) => s.placeId) });
    const fuelPending = cur.stops.find((s) => s.fuel && !s.status), fz = cur.model.fuelT, place = P.ctx.places[FUEL_ID];
    if (fuelPending && fz && place) next = reinsertFuel(cur, next, fz, place);
    P.result.plans = [next]; P.idx = 0; P.alt = null;
    P.reorder = { kind: 'notice', text, prev };
    logReplanVia(via);
    return true;
  }
  async function reorderUndo() {
    const P = S.plan, R = P && P.reorder;
    if (!R || !R.prev) return;
    const cur = curPlan();
    P.result.plans = [Object.assign({}, cur, { stops: R.prev.stops, order: R.prev.order })]; P.idx = 0;
    S.loc.origin = R.prev.origin;
    P.reorder = null; P.noSwitch = true; // no further switch until the next DONE / SKIP
    retimeNow();
    await savePlan();
    render();
  }
  async function reorderAccept() {
    const P = S.plan, R = P && P.reorder;
    if (!R || R.kind !== 'card') return;
    applyOrder(R.order, 'suggested', R.text);
    S.loc.origin = null;
    retimeNow();
    await savePlan();
    render();
  }
  function reorderBox() { // the notice at the top of the Route tab, or the "Ask me" card
    const R = S.plan && S.plan.reorder;
    if (!R) return null;
    if (R.kind === 'notice') {
      return h('div', { class: 'prompt reorder-notice', id: 'reorderNotice', role: 'status' }, h('span', null, R.text + ' · '),
        h('button', { class: 'link-undo', type: 'button', id: 'reorderUndo', onclick: () => reorderUndo() }, 'Undo'));
    }
    return h('div', { class: 'prompt', id: 'reorderCard' }, h('div', { class: 'title' }, R.text.replace(/^Order updated: /, 'Faster order: ')),
      R.extra ? h('div', { class: 'muted', id: 'reorderExtra' }, R.extra) : null,
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'primary grow', id: 'reorderSwitch', onclick: () => reorderAccept() }, 'Switch'),
        h('button', { class: 'grow', id: 'reorderKeep', onclick: () => { S.plan.reorder = null; render(); } }, 'Keep mine')));
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
  // the station's fetched times (Fuel.realTimeShortlist: minutes by "a.key>b.key") to / from the route points, keyed by
  // coordinates (what Solver.retime reads; any other leg is estimated there)
  function makeFuelT(st, times, pts, plan) {
    const P = S.plan, sk = llKey(st), now = Date.now();
    const ll = {}, pid2key = {}, to = {}, from = {};
    pts.forEach((p) => { ll[p.key || llKey(p)] = { lat: p.lat, lng: p.lng }; });
    plan.model.stopIds.forEach((id) => { const pl = S.places[id] || P.ctx.places[id]; if (pl) pid2key[id] = llKey(pl); });
    (times || new Map()).forEach((min, k) => {
      const [a, b] = k.split('>');
      if (b === sk && a !== sk) to[a] = Math.round(min * 60);
      if (a === sk && b !== sk) from[b] = Math.round(min * 60);
    });
    return { lat: st.lat, lng: st.lng, pid2key, ll, slices: [{ at: now, to, from }] };
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
  // Replan from here: keep the fuel stop, silently re-placed from its stored times (estimated where none): no request, no Places call
  async function keepFuelAfterReplan(prevPlan, prevPlaces) {
    const P = S.plan, place = prevPlaces && prevPlaces[FUEL_ID], fz = prevPlan.model && prevPlan.model.fuelT;
    if (!place || !fz) return;
    P.ctx.places = Object.assign({}, P.ctx.places, { [FUEL_ID]: place });
    const pending = prevPlan.stops.some((s) => s.fuel && !s.status);
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
            res.filter((r) => Fuel.nameHasBrand(r.name, brand) && Fuel.isStationName(r.name, brand)).forEach((r) => found.push({ placeId: r.id || ('ll:' + llKey(r)), name: r.name, address: r.address, lat: r.lat, lng: r.lng, brand }));
          }, (d, n) => { status.textContent = 'Searching ' + d + ' of ' + n + '…'; }, () => cancelled);
          if (cancelled) return;
          if (run.errors.length >= targets.length) { rememberedOnly = true; failNote = 'Google search failed (' + (run.errors[0].message || 'error') + ')'; }
          else fuelRun = { key: rkey, at: Date.now(), searched: targets.length };
          searched = targets.length;
          S.fuelStations = Fuel.cleanStations(Fuel.mergeStations(S.fuelStations, found), brand); // duplicates (within 40 m, or 150 m with the same name): one stays
          await saveStations();
        }
      }
      // --- 4c: every (station, position) ranked by the estimator, then real times for the best 8 only (2 requests each) ---
      status.textContent = 'Getting travel times…';
      const known = Fuel.stationsOfBrand(S.fuelStations, brand);
      if (!known.length) { fail('No ' + brand + ' found near this route.'); return; }
      const stationPts = known.map((st) => Object.assign({}, st, { fuel: true, key: llKey(st) }));
      const cands = Fuel.allCandidates(pts, stationPts, legs);
      const estMin = (a, b) => (a.key === b.key ? 0 : Budget.estSec(a, b) / 60);
      // in, out AND the direct leg it replaces, all from TomTom now (16 requests at most, as before); never the plan's table or an
      // estimate for the direct leg (a live-GPS origin is not a plan point: the 35 km/h estimate made the figure "+0")
      const pick = await Fuel.realTimeShortlist(cands, estMin, async (a, b) => { const r = await ttLeg(a, b, null); return r && r.seconds != null ? r.seconds / 60 : null; }, 8, 16);
      if (cancelled) return;
      const fzs = {};
      const fzOf = (st) => fzs[st.placeId] || (fzs[st.placeId] = makeFuelT(st, pick.times, pts, base));
      const sorted = pick.sorted;
      if (!sorted.length) { fail('Could not work out travel times to the ' + brand + ' stations.'); return; }
      // --- 4d: preview ---
      let cur = 0;
      const draw = () => {
        const c = sorted[cur];
        // replaceChildren() turns a null into the text "null" (the old "nullnull"): only real nodes go in
        sh.body.replaceChildren(...[
          h('div', { class: 'title', id: 'fuelName' }, c.station.name),
          c.station.address ? h('div', { class: 'muted', id: 'fuelAddr' }, c.station.address) : null,
          h('div', { class: 'fuel-detour', id: 'fuelDetour' }, Fuel.detourText(c) + ' · between ' + (c.a.name || 'here') + ' and ' + (c.b.name || 'the end')),
          h('div', { class: 'muted fuel-small', id: 'fuelSearched' }, 'Searched ' + searched + ' points · ' + S.fuelStations.length + ' stations remembered' + (reuse ? ' (recent search reused)' : '')),
          rememberedOnly ? h('div', { class: 'muted fuel-small', id: 'fuelNote' }, (failNote ? failNote + ' - ' : '') + 'Using remembered stations only') : null,
          limited && !reuse ? h('div', { class: 'muted fuel-small', id: 'fuelLimited' }, 'Search limited today (Places daily guard) - result may not be the best') : null,
          h('div', { class: 'sticky-actions' },
            h('button', { class: 'primary', id: 'fuelAdd', onclick: async () => { const pick = sorted[cur]; sh.close(); await commitFuel(pick, fzOf(pick.station)); } }, 'Add'),
            h('button', { id: 'fuelNext', disabled: sorted.length < 2, onclick: () => { cur = (cur + 1) % sorted.length; draw(); } }, 'Next best'),
            h('button', { id: 'fuelCancel', onclick: sh.close }, 'Cancel')),
        ].filter(Boolean));
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
    refreshFromLocation({ trigger: 'edit' });
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
    refreshFromLocation({ trigger: 'edit' });
  }

  function fuelCard(stop, i, place) { // fuel tag, station, ETA, navigation, DONE / SKIP / REMOVE (no WhatsApp message)
    const btns = navButtons(place, () => navTap(stop, i));
    btns.push(primaryBtn(stop, i));
    btns.push(h('button', { class: 'small', onclick: () => skipStop(stop, i) }, 'SKIP'));
    btns.push(h('button', { class: 'small danger', 'aria-label': 'Remove fuel stop', onclick: () => removeFuel() }, 'REMOVE'));
    const rin = reachedInline(stop, i); // shares the card's address line (no extra row)
    return h('div', { class: 'card stop fuel' + (rin ? ' reached' : '') },
      h('div', { class: 'stop-head' }, h('span', { class: 'num' }, (i + 1) + '.'), h('span', { class: 'nm' }, dName(place.name)), h('span', { class: 'pill fuel' }, 'FUEL'), h('span', { class: 'times' }, fmt(stop.arriveAt) + estMark(curEst.stops.has(stop.placeId)))),
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
      const items = Geo.pinnedFirst(Object.values(S.places).filter((p) => !q || (p.name + ' ' + p.address).toLowerCase().includes(q)));
      const none = Object.keys(S.places).length ? 'No places match.' : 'No places yet.';
      list.replaceChildren(...(items.length ? items.map((p) => h('div', { class: 'card', onclick: () => openPlaceEditor(p) },
        h('div', { class: 'title place-name' }, p.name),
        h('div', { class: 'place-tag' }, h('span', { class: 'chip' }, Messages.typeLabel(p.type))),
        h('div', { class: 'muted' }, p.address || (p.lat.toFixed(4) + ', ' + p.lng.toFixed(4))),
        Geo.waCardText(p.contactName, p.whatsapp ? Messages.compactNumber(p.whatsapp) : '') ? h('div', { class: 'muted place-wa' }, Geo.waCardText(p.contactName, p.whatsapp ? Messages.compactNumber(p.whatsapp) : '')) : null,
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
    const contact = h('input', { id: 'placeContact', value: p.contactName || '', maxlength: String(Geo.CONTACT_MAX), autocomplete: 'off', placeholder: 'Optional' });
    const wa = h('input', { type: 'tel', inputmode: 'tel', value: Messages.compactNumber(p.whatsapp), placeholder: '+60123456789' });
    const pin = h('input', { type: 'checkbox', id: 'placePin', checked: !!p.pinned, style: 'width:auto;min-height:0' });
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
      h('label', { class: 'check-row' }, pin, ' Pin to top of search'),
      lunchBox,
      h('label', { class: 'field' }, 'Contact name'), contact,
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
          Object.assign(p, { name: name.value.trim(), address: addr.value.trim(), type: type.value, dwellMin: Number(dwell.value) || 0, whatsapp: Messages.compactNumber(wa.value), salutation: sal.value, lang: lang.value, pinned: pin.checked });
          const cn = Geo.cleanContact(contact.value);
          if (cn) p.contactName = cn; else delete p.contactName; // places without it stay exactly as before
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
        field('TomTom key (all travel times: Routing API)', bind(h('input', { type: 'password', autocomplete: 'off', value: s.tomtomKey }), 'tomtomKey')),
        h('div', { class: 'muted' }, 'Keys stay on this device (never in the code, never exported).')),
      usageCard(s),
      travelCard(s, field),
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
          " Mark Reached automatically when I'm within " + Reached.radiusOf(s.autoReachM) + ' m and stopped (app open)'),
        field('Auto-Reached distance (m)', h('input', { type: 'number', id: 'autoReachM', inputmode: 'numeric', min: String(Reached.RADIUS_MIN), max: String(Reached.RADIUS_MAX), step: '1', value: String(Reached.radiusOf(s.autoReachM)),
          onchange: (e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= Reached.RADIUS_MIN && n <= Reached.RADIUS_MAX) { s.autoReachM = n; saveSettings(); } else toast('Auto-Reached distance: a whole number from ' + Reached.RADIUS_MIN + ' to ' + Reached.RADIUS_MAX); render(); } })),
        h('label', { class: 'check-row' },
          h('input', { type: 'checkbox', id: 'keepScreenOn', checked: s.keepScreenOn !== false, style: 'width:auto;min-height:0', onchange: (e) => { s.keepScreenOn = e.target.checked; saveSettings(); wake.sync({ retry: true }).then(paintWake); } }),
          ' Keep screen on while a day is running'),
        h('div', { class: 'muted', id: 'wakeState' }, wakeText())),
      lunchSettingsCard(s, field),
      fuelSettingsCard(s, field),
      proofSettingsCard(s),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Data'),
        h('div', { class: 'row' }, h('button', { class: 'grow', onclick: exportJson }, 'Export JSON'), h('button', { class: 'grow', onclick: () => fileIn.click() }, 'Import JSON'), fileIn)),
      h('div', { class: 'muted', id: 'lastPlan', style: 'text-align:center;font-size:12px' }, lastPlanText()),
      h('div', { class: 'muted', style: 'text-align:center' }, 'L-Tech Waypoint v' + APP_VERSION + ' · build ' + BUILD_STAMP),
      h('div', { class: 'muted', id: 'swBuild', style: 'text-align:center;font-size:12px' }, 'Service worker: checking…'));
    describeServiceWorker().then((t) => { const el = document.getElementById('swBuild'); if (el) el.textContent = t; });
  }

  // Settings -> Usage: TomTom Routing (and Matrix, only when used) and Google Places, today and this month, each with a thin bar.
  function usageCard(s) {
    const L = Budget.usageLines(s.usage, Date.now(), ttAllowance());
    const bar = (id, pct) => h('div', { class: 'usage-bar', id }, h('div', { class: 'usage-fill' + (pct >= 90 ? ' high' : ''), style: 'width:' + pct.toFixed(1) + '%' }));
    const allow = h('input', { type: 'number', id: 'ttAllowance', inputmode: 'numeric', min: '1', value: String(ttAllowance()) });
    allow.addEventListener('change', () => { s.ttAllowance = Budget.allowanceOf(allow.value); allow.value = String(s.ttAllowance); saveSettings(); render(); });
    return h('div', { class: 'card', id: 'usageCard' }, h('h2', { style: 'margin-top:0' }, 'Usage'),
      h('div', { class: 'usage-line', id: 'usageRouting' }, L.routing), bar('usageRoutingBar', L.routingPct),
      h('div', { class: 'usage-line', id: 'usagePlaces' }, L.places), bar('usagePlacesBar', L.placesPct),
      L.matrix ? h('div', { class: 'usage-line', id: 'usageMatrix' }, L.matrix) : null,
      h('label', { class: 'field' }, 'TomTom Routing allowance per month'), allow,
      h('div', { class: 'muted' }, 'Counted on this device only. TomTom\'s free allowance is per month and per API.'));
  }
  // Settings -> Travel times: the TomTom service, the after-stop look-ahead, the learned travel times (+ Forget, in-page confirm)
  let forgetTimesAsk = false;
  function travelCard(s, field) {
    const sel = (id, key, opts, def) => {
      const el = h('select', { id }, opts.map(([val, lab]) => h('option', { value: val, selected: (s[key] || def) === val }, lab)));
      el.addEventListener('change', () => { s[key] = el.value; saveSettings(); });
      return el;
    };
    const n = TT.pairCount(S.mem);
    const forget = forgetTimesAsk
      ? h('div', { class: 'row', id: 'forgetTimesConfirm', style: 'margin-top:8px' }, h('span', { class: 'grow' }, 'Forget ' + n + ' learned pairs?'),
        h('button', { class: 'small', id: 'forgetTimesNo', onclick: () => { forgetTimesAsk = false; render(); } }, 'Cancel'),
        h('button', { class: 'small danger', id: 'forgetTimesYes', onclick: async () => { S.mem = TT.emptyMemory(); await saveMemory(); forgetTimesAsk = false; toast('Learned travel times forgotten'); render(); } }, 'Forget'))
      : h('button', { class: 'small', id: 'forgetTimes', disabled: !n, onclick: () => { forgetTimesAsk = true; render(); } }, 'Forget');
    return h('div', { class: 'card', id: 'travelCard' }, h('h2', { style: 'margin-top:0' }, 'Travel times'),
      field('TomTom service', sel('ttServiceSel', 'ttService', [['routing', 'Routing (default)'], ['matrix', 'Matrix']], 'routing')),
      field('After each stop, look for a faster order', sel('afterStopSel', 'afterStop', [['auto', 'Switch automatically'], ['ask', 'Ask me'], ['off', 'Off']], 'auto')),
      h('div', { class: 'row', style: 'margin-top:10px;align-items:center' }, h('span', { class: 'grow', id: 'learnedCount' }, 'Learned travel times: ' + n + ' pair' + (n === 1 ? '' : 's')), forgetTimesAsk ? null : forget),
      forgetTimesAsk ? forget : null,
      h('div', { class: 'muted', id: 'learnedLine' }, TT.learnedLine(S.mem, Date.now())));
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

  async function exportJson() {
    const settings = Object.assign({}, S.settings); delete settings.googleKey; delete settings.tomtomKey;
    let proofs = [];
    try { proofs = (await Proof.listProofs()).filter((p) => p.state !== 'draft'); } catch (e) { proofs = []; } // the records only: photos stay on the phone
    const data = Object.assign({ app: 'waypoint', version: APP_VERSION, exportedAt: new Date().toISOString(), dwellMigrated: true, pinMigrated: true, learnedCleared: true, places: Object.values(S.places), jobs: S.jobs, settings, fuelStations: S.fuelStations, travelTimes: S.mem },
      OnBoard.exportLoose(S.loose), // looseItems: the items still with you
      DL.exportPayload(S.days, S.jobs, S.places), // + dayLog (records) and dayHistory (per-day totals); keys never included
      { proofs });
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
      let firstSeen = false; // First stop: true only (older exports have no field = off), one entry at most
      for (const j of data.jobs) {
        if (j && j.firstStop === true && !firstSeen && j.status !== 'done') firstSeen = true; else if (j) delete j.firstStop;
        if (j) { const a = JobEdit.afterOf(j); if (a.length) j.afterPlaces = a; else delete j.afterPlaces; } // After: older exports have none = none
        S.jobs.push(j); await saveJob(j);
      }
      if (dl.present) {
        await WPStore.clear('daylogs'); S.days = {};
        for (const d of dl.records) { S.days[d.date] = d; await WPStore.set('daylogs', d.date, d); }
      }
      if (data.settings) {
        const keep = { googleKey: S.settings.googleKey, tomtomKey: S.settings.tomtomKey };
        if (!data.settings.usage) keep.usage = S.settings.usage; // older exports have no counters: the device's are kept
        S.settings = Object.assign(defaultSettings(), data.settings, keep);
        delete S.settings.tomtomUsage;
        S.settings.templates = Messages.migrateTemplates(Object.assign({}, Messages.DEFAULT_TEMPLATES, S.settings.templates || {})).templates;
        await saveSettings();
      }
      if (data.travelTimes && typeof data.travelTimes === 'object') { // older exports have none: the learned times are kept
        S.mem = TT.normaliseMemory(data.travelTimes);
        if (!data.learnedCleared) S.mem = TT.clearSamples(S.mem); // an export from before the one-time clear may hold live figures
        await saveMemory();
      }
      if (Array.isArray(data.fuelStations)) { // older exports have none: the current memory is kept
        S.fuelStations = data.fuelStations.filter((x) => x && x.placeId != null && x.lat != null && x.lng != null);
        fuelRun = null;
        await saveStations();
      }
      const lo = OnBoard.importLoose(data); // older exports have no looseItems: the current ones are kept
      if (lo.present) {
        await WPStore.clear('loose'); S.loose = [];
        for (const it of lo.items) { S.loose.push(it); await WPStore.set('loose', it.id, it); }
      }
      S.plan = null;
      const mig = data.dwellMigrated === true ? null : await runDwellMigration(true); // data that predates the flag gets the same migration
      if (data.pinMigrated !== true) await runPinMigration(true); // ... and so does data that predates pinned places
      toast(mig && mig.changed ? 'Imported. ' + dwellToastText(mig) : 'Imported.');
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
    wake.sync().then(paintWake); // the screen lock too (End day / no day running releases it)
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    openTab(b.dataset.tab);
  });

  // Back in the foreground: re-time what is left from the last done stop (or the start) at the current time.
  // Hidden: the GPS watch stops. Visible: the watch starts again and one fresh fix is requested (auto-reach on it).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { stopWatch(); return; }
    W.blocked = false; // a watch stopped by an error is retried now
    wake.sync({ retry: true }).then(paintWake); // the browser dropped the screen lock when the page was hidden: ask again (day running only)
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

  // Once a minute: re-render the Route tab (NO network call) so no time shown has slipped into the past; the 10-minute
  // live re-time (liveTick: Budget decides, one 1 x 1 request at most).
  function minuteTick() {
    if (S.plan) lunchTick(); // a lunch break whose length elapsed ends by itself
    if (S.tab === 'route' && S.plan && document.visibilityState === 'visible' && !document.querySelector('.backdrop')) render();
    liveTick();
  }
  setInterval(minuteTick, 60000);

  load().then(() => {
    if (S.plan) lunchTick();
    if (S.plan && retimeNow()) savePlan(); // restored plan: re-time from the last done stop (or start) at the current time
    if (S.tab === 'plan') openPlanTab(); // a running day restored on the Plan tab: the chips read "My location" / "Now"
    render();
    if (S.tab === 'route' && S.plan) refreshFromLocation({ trigger: 'visible' }); // launch = the page becoming visible
    watchLocationPermission();
    setupServiceWorker();
    proofsOnLoad(); // SEND buttons, a draft proof's sheet, retention (once per load); never blocks
  }).catch((e) => banner('Startup failed: ' + e.message, 'error'));

  window.WaypointDebug = { S, doPlan, render, minuteTick, wake };
})();
