#!/usr/bin/env node
/* Mocked browser smoke for editing a job from the Plan tab and for pinned places (no screenshots, no network, no real keys).
 *   node tools/smoke-edit.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol, and mocks TomTom,
 * geolocation, page visibility and the clock inside the page. World: Home, Office (type office), Carrier, AO Advance; ONE job
 * AO Advance -> Carrier; the pin migration flag is absent (so the first load pins the office-type place). Steps: tap the DELIVER box ->
 * "Edit job", Carrier pre-filled, "Save changes"; the delivery picker lists Office FIRST with the pin glyph (empty and typed "car",
 * Office not repeated); choose it and save -> the card reads AO Advance -> Office (L-Tech), still one job, same id; the pencil opens the
 * form again and Cancel changes nothing; after PLAN, editing the job shows "Jobs changed - tap PLAN to update the route" on the Plan and
 * Route tabs and the route is NOT changed until PLAN is tapped (then the note is gone); Urgent, hold (park) and delete still work.
 * Then the 25 Nov 2026 day (world s1, travel times from a fixed minute table; Home, Office, Pacific Klang, Asian Automotive,
 * Carrier, Eastern Press): through the form, an errand at the Office with First stop on (FIRST on its Plan card) and a just-collect
 * job at Klang with an empty "send to" (the hint); PLAN -> Office, Asian, Carrier, Eastern, Klang with FIRST on the first card only;
 * DONE at every stop -> the Klang item is in the With you bar; no "job j_" text anywhere. World s2 (the two-visit day): two
 * Office cards, FIRST on the first only, the second holds only the Carrier delivery and comes after Carrier; DONE on the first
 * leaves that delivery open; First stop turned on for another job -> the "First stop moved from Office to Carrier" toast.
 * 4b (Places search mocked): a Google result not yet saved opens the type sheet (titled with its name, one button per place type,
 * none preselected); dismissing saves nothing and leaves the field; Supplier saves it (10 min) and the job form continues; a saved
 * place is not asked again. World s4 (at 360 px): the contact name at the end of a Route card's job line, cut with an ellipsis;
 * ▲ / ▼ (first / last disabled), Eastern above its pickup Carrier refused with the item named, ▼ on Asian swaps and re-times
 * (0 requests), a leg removed from the table and the memory = exactly 1 request, DONE after the move keeps the manual order (no
 * look-ahead), the note survives a reload, PLAN re-solves and clears it.
 * The server and the browser are always shut down. Exit 1 on failure.
 * Needs Node 22+ (global WebSocket / fetch) and Chrome or Edge (set CHROME=<path> to choose one).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const BROWSERS = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);

let fails = 0, passes = 0;
function check(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); } else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

// ---------- the world: four places on a line north of Home (~15 km apart) ----------
const HOME = { lat: 3.0757673, lng: 101.6609445 };
const at = (k) => ({ lat: HOME.lat + 0.135 * k, lng: HOME.lng });
const place = (id, name, k, type) => Object.assign({ id, name, address: name + ' St', type: type || 'factory', dwellMin: 10, closedWindows: [] }, at(k));
const job = (id, o) => Object.assign({ id, pickups: [], inHandItem: '', deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-23T01:0' + id.length + ':00.000Z' }, o);
const SEED = {
  'waypoint:settings:main': { googleKey: 'test-google', tomtomKey: 'test-tomtom', seeded: true, defaultLang: 'ms', nav: 'waze', driverName: 'Calvin' },
  'waypoint:places:home': { id: 'home', name: 'Home (Bloomsvale)', address: 'Bloomsvale', lat: HOME.lat, lng: HOME.lng, type: 'home', dwellMin: 0, closedWindows: [] },
  'waypoint:places:office': place('office', 'Office (L-Tech)', 3, 'office'),
  'waypoint:places:carrier': place('carrier', 'Carrier International Sdn Bhd', 1), 'waypoint:places:ao': place('ao', 'AO Advance Automation Sdn Bhd', 2, 'supplier'),
  'waypoint:jobs:jao': job('jao', { pickups: [{ placeId: 'ao', item: 'Float switch', done: false }], deliveryPlaceId: 'carrier', notes: 'ask for Ali', createdAt: '2026-11-23T01:01:00.000Z' }),
};

// ---------- the First stop worlds (25 Nov 2026): a fixed minute table, symmetric; H = Home (start and end) ----------
const MINS = { 'H-O': 32, 'H-K': 46, 'H-A': 40, 'H-C': 42, 'H-E': 50, 'O-K': 68, 'O-A': 22, 'O-C': 25, 'O-E': 50, 'A-C': 11, 'A-E': 60, 'A-K': 65, 'C-E': 61, 'C-K': 66, 'E-K': 11 };
const LL = { H: HOME, O: { lat: 3.15, lng: 101.72 }, K: { lat: 3.0, lng: 101.45 }, A: { lat: 3.14, lng: 101.76 }, C: { lat: 3.17, lng: 101.74 }, E: { lat: 3.02, lng: 101.5 }, S: { lat: 3.25, lng: 101.62 } };
// the After world (s3, the T2 data of test/after.test.js): its own minute table; S = HeveaPac
const MINS3 = { 'O-S': 30, 'O-A': 22, 'O-C': 25, 'O-E': 50, 'A-C': 11, 'A-S': 45, 'A-E': 62, 'C-S': 46, 'C-E': 61, 'S-E': 73, 'H-A': 40, 'H-C': 42, 'H-S': 60, 'H-E': 50, 'H-O': 32 };
// the ▲ / ▼ world (s4): a chain Home -> Asian -> Carrier -> Eastern -> Klang -> Home of 10-minute legs, every other pair 50 min
const MINS4 = { 'H-A': 10, 'A-C': 10, 'C-E': 10, 'E-K': 10, 'H-K': 10, 'H-C': 50, 'H-E': 50, 'A-E': 50, 'A-K': 50, 'C-K': 50, 'H-O': 50, 'O-A': 50, 'O-C': 50, 'O-E': 50, 'O-K': 50 };
const wplace = (id, name, L, type) => Object.assign({ id, name, address: name + ' Rd', type: type || 'other', dwellMin: 0, closedWindows: [] }, LL[L]);
const WORLD = {
  'waypoint:settings:main': SEED['waypoint:settings:main'],
  'waypoint:places:home': Object.assign({}, SEED['waypoint:places:home']),
  'waypoint:places:office': wplace('office', 'Office', 'O', 'office'), 'waypoint:places:klang': wplace('klang', 'Pacific Klang Oil Seals', 'K'),
  'waypoint:places:asian': wplace('asian', 'Asian Automotive', 'A'), 'waypoint:places:carrier': wplace('carrier', 'Carrier', 'C'),
  'waypoint:places:eastern': wplace('eastern', 'Eastern Press', 'E'),
};
const SEEDS = {
  base: SEED,
  s1: Object.assign({}, WORLD, { // + through the UI: the errand at the Office (First stop on) and the just-collect job at Klang
    'waypoint:jobs:j2': job('j2', { pickups: [{ placeId: 'office', item: 'Brackets', done: false }], deliveryPlaceId: 'asian', createdAt: '2026-11-25T00:01:00.000Z' }),
    'waypoint:jobs:j3': job('j3', { inHandItem: 'Sensor', deliveryPlaceId: 'carrier', createdAt: '2026-11-25T00:02:00.000Z' }),
    'waypoint:jobs:j4': job('j4', { inHandItem: 'Gasket', deliveryPlaceId: 'eastern', createdAt: '2026-11-25T00:03:00.000Z' }),
  }),
  s2: Object.assign({}, WORLD, {
    'waypoint:jobs:e1': job('e1', { errandPlaceId: 'office', dwellMin: 0, notes: 'Sign cheques', firstStop: true, createdAt: '2026-11-25T00:01:00.000Z' }),
    'waypoint:jobs:j2': job('j2', { pickups: [{ placeId: 'office', item: 'Brackets', done: false }], deliveryPlaceId: 'asian', createdAt: '2026-11-25T00:02:00.000Z' }),
    'waypoint:jobs:j6': job('j6', { pickups: [{ placeId: 'carrier', item: 'Compressor', done: false }], deliveryPlaceId: 'office', createdAt: '2026-11-25T00:03:00.000Z' }),
  }),
  s3: { // T2: four deliver-only jobs at HeveaPac, Asian, Carrier, Eastern; every dwell 10; lunch break off; start at the Office
    'waypoint:settings:main': Object.assign({}, SEED['waypoint:settings:main'], { lunchBreakOn: false }),
    'waypoint:places:home': Object.assign({}, SEED['waypoint:places:home']),
    'waypoint:places:office': Object.assign(wplace('office', 'Office', 'O', 'office'), { dwellMin: 10 }),
    'waypoint:places:heveapac': Object.assign(wplace('heveapac', 'HeveaPac', 'S'), { dwellMin: 10 }),
    'waypoint:places:asian': Object.assign(wplace('asian', 'Asian Automotive', 'A'), { dwellMin: 10 }),
    'waypoint:places:carrier': Object.assign(wplace('carrier', 'Carrier', 'C'), { dwellMin: 10 }),
    'waypoint:places:eastern': Object.assign(wplace('eastern', 'Eastern Press', 'E'), { dwellMin: 10 }),
    'waypoint:jobs:jS': job('jS', { inHandItem: 'Rubber sheets', deliveryPlaceId: 'heveapac', createdAt: '2026-11-25T00:01:00.000Z' }),
    'waypoint:jobs:jA': job('jA', { inHandItem: 'Brackets', deliveryPlaceId: 'asian', createdAt: '2026-11-25T00:02:00.000Z' }),
    'waypoint:jobs:jC': job('jC', { inHandItem: 'Sensor', deliveryPlaceId: 'carrier', createdAt: '2026-11-25T00:03:00.000Z' }),
    'waypoint:jobs:jE': job('jE', { inHandItem: 'Gasket', deliveryPlaceId: 'eastern', createdAt: '2026-11-25T00:04:00.000Z' }),
  },
  s4: { // Part 6: Brackets to Asian, the Compressor collected at Carrier for Eastern Press, a Gasket to Klang; lunch break off
    'waypoint:settings:main': Object.assign({}, SEED['waypoint:settings:main'], { lunchBreakOn: false }),
    'waypoint:places:home': Object.assign({}, SEED['waypoint:places:home']),
    'waypoint:places:office': wplace('office', 'Office', 'O', 'office'),
    'waypoint:places:asian': Object.assign(wplace('asian', 'Asian Automotive', 'A'), { contactName: 'Encik Ali bin Abu Bakar (purchasing)' }),
    'waypoint:places:carrier': wplace('carrier', 'Carrier', 'C'),
    'waypoint:places:eastern': wplace('eastern', 'Eastern Press', 'E'),
    'waypoint:places:klang': wplace('klang', 'Pacific Klang Oil Seals', 'K'),
    'waypoint:jobs:jA': job('jA', { inHandItem: 'Brackets 4 pcs, stainless', deliveryPlaceId: 'asian', createdAt: '2026-11-26T00:01:00.000Z' }),
    'waypoint:jobs:jCE': job('jCE', { pickups: [{ placeId: 'carrier', item: 'Compressor', done: false }], deliveryPlaceId: 'eastern', createdAt: '2026-11-26T00:02:00.000Z' }),
    'waypoint:jobs:jK': job('jK', { inHandItem: 'Gasket', deliveryPlaceId: 'klang', createdAt: '2026-11-26T00:03:00.000Z' }),
  },
};

// runs in the page before anything else: mocks + seed. The clock starts at 11:00 local and its offset survives a reload.
const INIT = `(() => {
  const RealDate = Date;
  if (location.protocol !== 'http:') return; // about:blank between runs: no app, no storage
  const stored = sessionStorage.getItem('__off');
  if (stored != null) window.__off = Number(stored);
  else { const d = new RealDate(); d.setHours(11, 0, 0, 0); window.__off = d.getTime() - RealDate.now(); sessionStorage.setItem('__off', String(window.__off)); }
  window.__advance = (ms) => { window.__off += ms; sessionStorage.setItem('__off', String(window.__off)); return true; };
  window.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + window.__off); else super(...a); }
    static now() { return RealDate.now() + window.__off; }
  };
  try { delete Navigator.prototype.serviceWorker; } catch (e) { /* ignore */ }
  window.__hidden = false; window.__perm = 'denied'; window.__pos = null;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return window.__hidden ? 'hidden' : 'visible'; } });
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(ok) { const p = window.__pos || { lat: ${HOME.lat}, lng: ${HOME.lng} }; setTimeout(() => ok({ coords: { latitude: p.lat, longitude: p.lng, accuracy: 20 }, timestamp: Date.now() }), 0); },
    watchPosition() { return 1; }, clearWatch() {},
  } });
  try { navigator.permissions.query = async () => ({ state: window.__perm, addEventListener() {} }); } catch (e) { /* ignore */ }
  window.open = () => null;
  document.addEventListener('click', (e) => { const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]'); if (a) e.preventDefault(); }, true);
  const km = (a, b) => { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dg = (b.lng - a.lng) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const WORLD_ID = new URLSearchParams(location.search).get('world') || 'base';
  const LL = ${JSON.stringify(LL)}, MINS = WORLD_ID === 's3' ? ${JSON.stringify(MINS3)} : WORLD_ID === 's4' ? ${JSON.stringify(MINS4)} : ${JSON.stringify(MINS)};
  const letterOf = (p) => { let b = null, bd = Infinity; Object.keys(LL).forEach((x) => { const d = km(p, LL[x]); if (d < bd) { bd = d; b = x; } }); return bd < 0.3 ? b : null; };
  const tableSec = (a, b) => { // the First stop worlds only: travel times from the fixed minute table
    if (WORLD_ID === 'base') return null;
    const x = letterOf(a), y = letterOf(b);
    if (!x || !y) return null;
    if (x === y) return 0;
    const v = MINS[x + '-' + y] != null ? MINS[x + '-' + y] : MINS[y + '-' + x];
    return v == null ? null : v * 60;
  };
  window.__legs = [];
  const realFetch = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.__places = 0;
  window.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('places.googleapis.com')) { // one result for any text: a factory not yet saved
      window.__places++;
      return json({ places: [{ id: 'g-bukit', displayName: { text: 'Bukit Raja Plastics' }, formattedAddress: 'Jalan Bukit Raja, Klang', location: { latitude: 3.08, longitude: 101.47 } }] });
    }
    if (url.includes('api.tomtom.com')) {
      if (url.includes('/calculateRoute/')) { // the Routing API: one leg per request, coordinates in the path
        window.__legs.push(url.split('/calculateRoute/')[1].split('/')[0]);
        const q = [0].concat(url.split('/calculateRoute/')[1].split('/')[0].split(/[,:]/).map(Number));
        const k = km({ lat: +q[1], lng: +q[2] }, { lat: +q[3], lng: +q[4] });
        const tsec = tableSec({ lat: +q[1], lng: +q[2] }, { lat: +q[3], lng: +q[4] });
        if (tsec != null) return json({ routes: [{ summary: { travelTimeInSeconds: tsec, historicTrafficTravelTimeInSeconds: tsec, lengthInMeters: Math.round(k * 1300) } }] });
        return json({ routes: [{ summary: { travelTimeInSeconds: Math.round(k * 1.3 / 40 * 3600), historicTrafficTravelTimeInSeconds: Math.round(k * 1.3 / 40 * 3600), lengthInMeters: Math.round(k * 1300) } }] });
      }
      const b = JSON.parse(init.body), data = [];
      b.origins.forEach((o, i) => b.destinations.forEach((d, j) => {
        const k = km({ lat: o.point.latitude, lng: o.point.longitude }, { lat: d.point.latitude, lng: d.point.longitude });
        data.push({ originIndex: i, destinationIndex: j, routeSummary: { travelTimeInSeconds: Math.round(k * 1.3 / 40 * 3600), lengthInMeters: Math.round(k * 1300) } });
      }));
      return json({ data });
    }
    return realFetch(url, init);
  };
  try {
    if (!localStorage.getItem('__seeded')) {
      const d = new Date(), today = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      const seed = ${JSON.stringify(SEEDS)}[WORLD_ID];
      seed['waypoint:settings:main'].placesCallsToday = { date: today, count: 0 };
      Object.keys(seed).forEach((k) => localStorage.setItem(k, JSON.stringify(seed[k])));
      localStorage.setItem('__seeded', '1');
    }
  } catch (e) { /* ignore */ }
})();`;

// ---------- static server ----------
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, path.normalize(p));
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- DevTools protocol ----------
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || msg.params.exceptionDetails.text));
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push('console.error ' + msg.params.args.map((a) => a.value || a.description).join(' '));
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket error')); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return { opened, send, close: () => ws.close(), logs };
}

async function main() {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('No Chrome / Edge found (set CHROME=<path>).'); process.exit(2); }
  const srv = await serve();
  const appUrl = 'http://127.0.0.1:' + srv.address().port + '/index.html';
  const dbgPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-smoke-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=420,900',
    '--remote-debugging-port=' + dbgPort, '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let page = null;
  const cleanup = async () => {
    try { if (page) page.close(); } catch (e) { /* ignore */ }
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); else proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
    await new Promise((r) => srv.close(r));
    srv.closeAllConnections && srv.closeAllConnections();
    for (let i = 0; i < 10; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch (e) { await sleep(300); } }
  };
  try {
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      try { const list = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/list')).json(); target = list.find((t) => t.type === 'page'); } catch (e) { /* not up yet */ }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error('browser did not start');
    page = cdp(target.webSocketDebuggerUrl);
    await page.opened;
    const send = page.send;
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
    const waitFor = async (expr, what, ms) => { const end = Date.now() + (ms || 8000); while (Date.now() < end) { if (await ev('!!(' + expr + ')')) return true; await sleep(100); } const bn = await ev('(document.getElementById("banner") || {}).textContent || ""').catch(() => ''); throw new Error('timeout waiting for ' + what + (bn ? ' [banner: ' + bn + ']' : '') + (page.logs.length ? ' [page: ' + page.logs.join(' | ') + ']' : '')); };
    const click = (sel) => ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) throw new Error("no " + ' + JSON.stringify(sel) + '); e.click(); return true; })()');
    const text = (sel) => ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); return e ? e.textContent : null; })()');
    const clickText = (sel, label) => ev('(() => { const e = [...document.querySelectorAll(' + JSON.stringify(sel) + ')].find((x) => x.textContent.trim() === ' + JSON.stringify(label) + '); if (!e) throw new Error("no " + ' + JSON.stringify(label) + '); e.click(); return true; })()');
    const advanceMs = (ms) => ev('window.__advance(' + ms + ')');
    const tab = async (name) => { await click('#tabs button[data-tab="' + name + '"]'); await sleep(150); };
    const S = (expr) => ev('WaypointDebug.S.' + expr);
    const planStop = (id) => 'WaypointDebug.S.plan.result.plans[0].stops.find((s) => s.placeId === ' + JSON.stringify(id) + ')';
    const stopBtn = (nm) => '(() => { const c = [...document.querySelectorAll(".timeline .card.stop")].find((x) => { const n = x.querySelector(".nm"); return n && n.textContent.indexOf(' + JSON.stringify(nm) + ') === 0 && !x.classList.contains("done"); }); return c ? c.querySelector(".stop-btns button.ok") : null; })()';
    const reachDone = async (id, nm) => { // REACHED, then (after the 500 ms double-tap guard) DONE
      await ev(stopBtn(nm) + '.click()');
      await waitFor(planStop(id) + '.reachedAt', 'Reached on ' + id);
      await advanceMs(2000); await sleep(100);
      await ev(stopBtn(nm) + '.click()');
      await waitFor(planStop(id) + '.status === "done"', 'Done on ' + id);
    };
    const fresh = async (world) => {
      await send('Page.navigate', { url: 'about:blank' }); // leave the app first (nothing can save behind our back), then wipe its storage
      await sleep(300);
      await send('Storage.clearDataForOrigin', { origin: new URL(appUrl).origin, storageTypes: 'local_storage,session_storage' });
      await send('Page.navigate', { url: appUrl + (world ? '?world=' + world : '') });
      await waitFor('document.querySelector("#planBtn")', 'the Plan tab');
    };
    const planNow = async (n, ms) => { // ms: a bigger PLAN waits longer (TomTom requests start 300 ms apart)
      await click('#planBtn');
      await waitFor('window.WaypointDebug && WaypointDebug.S.plan && WaypointDebug.S.tab === "route" && !WaypointDebug.S.busy && document.querySelectorAll(".timeline .card.stop").length === ' + n, 'a planned route of ' + n + ' stops', ms);
    };
    const barText = () => text('#onBoardToggle');
    const openBar = async () => { if (await ev('!document.querySelector("#onBoardList")')) await click('#onBoardToggle'); await waitFor('document.querySelector("#onBoardList")', 'the expanded list'); };


    const card = () => ev('(() => { const c = document.querySelector(".card.job"); if (!c) return null; const n = (s) => [...c.querySelectorAll(s)].map((x) => x.textContent); return { collect: n(".box.collect .name"), deliver: n(".box.deliver .name"), item: n(".box.collect .sub"), count: document.querySelectorAll(".card.job").length }; })()');
    const sheetTitle = () => ev('(() => { const h = document.querySelector(".sheet h3"); return h ? h.textContent : null; })()');
    const sheetBtn = (label) => clickText('.sheet button', label);
    const pickerRows = () => ev('[...document.querySelectorAll(".picker-list .pick-row")].map((r) => ({ t: r.querySelector(".title").textContent.replace(/\\s+/g, " ").replace("📌", "").trim(), pin: !!r.querySelector(".pin-glyph") }))');
    const stopNames = () => ev('WaypointDebug.S.plan.result.plans[0].stops.map((s) => s.placeId)');
    const jobIds = () => S('jobs.map((j) => j.id)');

    console.log('1. the pin migration on first load (flag absent)');
    await fresh();
    const pins = await ev('(() => { const g = (k) => JSON.parse(localStorage.getItem("waypoint:places:" + k)); return { office: g("office").pinned, carrier: !!g("carrier").pinned, ao: !!g("ao").pinned, home: !!g("home").pinned, flag: (JSON.parse(localStorage.getItem("waypoint:meta:migrations")) || {}).pinOffice2026_11_24 }; })()');
    check(pins.office === true && !pins.carrier && !pins.ao && !pins.home && pins.flag === true, 'only the office-type place is pinned, the flag is stored', pins);
    check(await ev('!/pin/i.test(document.getElementById("toast").textContent)'), 'no toast for the pin migration (the dwell migration has its own)');

    console.log('2. tap the DELIVER box -> Edit job');
    const c0 = await card();
    check(c0 && c0.count === 1 && c0.collect[0] === 'AO Advance Automation' && c0.deliver[0] === 'Carrier International', 'one card: AO Advance Automation -> Carrier International', c0);
    check(await ev('(() => { const b = document.querySelector(".card.job .job-actions").children; return [...b].map((x) => x.getAttribute("aria-label") || x.textContent).join("|"); })()') === 'Urgent|Edit job|Park job|Delete job', 'the button row: Urgent | pencil | hold | delete');
    await click('.card.job .box.deliver');
    await waitFor('document.querySelector(".sheet #jobDest")', 'the edit form');
    check(await sheetTitle() === 'Edit job', 'the form is titled "Edit job"', await sheetTitle());
    const f1 = await ev('(() => { const ins = [...document.querySelectorAll(".sheet input")]; const q = (p) => (ins.find((i) => i.placeholder === p) || {}).value; const bs = [...document.querySelectorAll(".sheet button")].map((b) => b.textContent); return { dest: document.querySelector("#jobDest").textContent, pick: bs.find((t) => /AO Advance/.test(t)), item: q("Item (e.g. 2 pcs sensor)"), notes: q("Optional"), bs }; })()');
    check(f1.dest === 'Carrier International Sdn Bhd' && /AO Advance Automation/.test(f1.pick) && f1.item === 'Float switch' && f1.notes === 'ask for Ali', 'every field pre-filled: Carrier, AO Advance, item, notes', f1);
    check(f1.bs.includes('Save changes') && f1.bs.includes('Cancel') && !f1.bs.includes('Save job'), 'buttons: Save changes and Cancel', f1.bs);

    console.log('3. the delivery picker: Office first with the pin glyph');
    await click('#jobDest');
    await waitFor('document.querySelector(".picker-list .pick-row")', 'the picker rows');
    const r0 = await pickerRows();
    check(r0.length === 4 && r0[0].t === 'Office (L-Tech)' && r0[0].pin && r0.slice(1).every((r) => !r.pin), 'empty box: Office (L-Tech) is the first row with the pin glyph, nobody else has one', r0);
    check(JSON.stringify(r0.slice(1).map((r) => r.t)) === JSON.stringify(['AO Advance Automation Sdn Bhd', 'Carrier International Sdn Bhd', 'Home (Bloomsvale)']), 'then the others in name order', r0);
    await ev('(() => { const i = document.querySelector(".picker-body input"); i.value = "car"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    await sleep(150);
    const r1 = await pickerRows();
    check(r1.length === 2 && r1[0].t === 'Office (L-Tech)' && r1[0].pin && /^Carrier/.test(r1[1].t), 'typing "car": Office stays on top, then Carrier, Office not repeated', r1);
    await ev('(() => { const i = document.querySelector(".picker-body input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    await sleep(100);
    await ev('document.querySelector(".picker-list .pick-row").click()'); // Office
    await waitFor('document.querySelector("#jobDest") && /Office/.test(document.querySelector("#jobDest").textContent)', 'Office chosen');
    await sheetBtn('Save changes');
    await waitFor('!document.querySelector(".sheet")', 'the form closes');
    const c1 = await card();
    check(c1 && c1.count === 1 && c1.collect[0] === 'AO Advance Automation' && c1.deliver[0] === 'Office (L-Tech)', 'the card reads AO Advance Automation -> Office (L-Tech)', c1);
    check(JSON.stringify(await jobIds()) === '["jao"]' && c1.item[0] === 'Float switch', 'still exactly one job, same id, item unchanged', await jobIds());
    check(await ev('JSON.parse(localStorage.getItem("waypoint:jobs:jao")).deliveryPlaceId') === 'office', 'saved to storage');
    check(await ev('!document.querySelector("#jobsChangedNote")'), 'no plan yet: no "tap PLAN" note');

    console.log('4. the pencil, then Cancel');
    await click('.card.job .edit-btn');
    await waitFor('document.querySelector(".sheet #jobDest")', 'the form again');
    check(await sheetTitle() === 'Edit job' && /Office/.test(await text('#jobDest')), 'the pencil opens "Edit job" with Office pre-filled', await text('#jobDest'));
    await sheetBtn('Cancel');
    await waitFor('!document.querySelector(".sheet")', 'the form closes');
    const c2 = await card();
    check(JSON.stringify(c2) === JSON.stringify(c1), 'Cancel changes nothing', c2);

    console.log('4b. a place from Google search: the type sheet');
    const searchInPicker = async (q) => {
      await waitFor('document.querySelector(".picker-body input")', 'the picker');
      await ev('(() => { const i = document.querySelector(".picker-body input"); i.value = ' + JSON.stringify(q) + '; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()');
      await waitFor('[...document.querySelectorAll(".picker-list .pick-row")].some((r) => /Bukit Raja/.test(r.textContent))', 'the Google result');
      await ev('[...document.querySelectorAll(".picker-list .pick-row")].find((r) => /Bukit Raja/.test(r.textContent)).click()');
      await waitFor('document.querySelector("#placeTypeSheet")', 'the type sheet');
    };
    const placeCount = () => S('places ? Object.keys(WaypointDebug.S.places).length : 0');
    const nPlaces0 = await placeCount();
    await click('.card.job .edit-btn');
    await waitFor('document.querySelector(".sheet #jobDest")', 'the edit form');
    await click('#jobDest');
    await searchInPicker('bukit raja');
    const ts = await ev('(() => { const s = document.querySelector("#placeTypeSheet"); return { title: s.querySelector("h3").textContent, btns: [...s.querySelectorAll(".type-btn")].map((b) => b.textContent), on: s.querySelectorAll(".type-btn.on, .type-btn[aria-pressed=true]").length, picker: !!document.querySelector(".picker-body") }; })()');
    check(ts.title === 'Bukit Raja Plastics', 'the sheet is titled with the place name', ts.title);
    check(JSON.stringify(ts.btns) === JSON.stringify(['Customer factory', 'Supplier', 'Office', 'Home', 'Other']), 'one button per place type of the place form', ts.btns);
    check(ts.on === 0 && !ts.picker, 'nothing preselected; the picker is closed', ts);
    await ev('(() => { const s = document.querySelector("#placeTypeSheet"); s.parentNode.click(); return true; })()'); // tap outside = dismiss
    await waitFor('!document.querySelector("#placeTypeSheet")', 'the type sheet dismissed');
    check(await placeCount() === nPlaces0 && /Office/.test(await text('#jobDest')), 'dismissed: nothing saved, the field unchanged', [await placeCount(), await text('#jobDest')]);
    await click('#jobDest');
    await searchInPicker('bukit raja');
    await clickText('#placeTypeSheet .type-btn', 'Supplier');
    await waitFor('/Bukit Raja/.test(document.querySelector("#jobDest").textContent)', 'the new place in the field');
    const np = await S('places && Object.values(WaypointDebug.S.places).find((p) => p.name === "Bukit Raja Plastics")');
    check(np && np.type === 'supplier' && np.dwellMin === 10 && await placeCount() === nPlaces0 + 1, 'one tap: saved as Supplier with its 10 min stop time, the job form continues with it', np);
    await click('#jobDest');
    await waitFor('document.querySelector(".picker-body input")', 'the picker');
    await ev('(() => { const i = document.querySelector(".picker-body input"); i.value = "zzz"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()');
    await waitFor('[...document.querySelectorAll(".picker-list .pick-row")].some((r) => /Jalan Bukit Raja/.test(r.textContent))', 'the Google result again');
    await ev('[...document.querySelectorAll(".picker-list .pick-row")].find((r) => /Jalan Bukit Raja/.test(r.textContent)).click()');
    await sleep(200);
    check(await ev('!document.querySelector("#placeTypeSheet")') && (await S('places && Object.values(WaypointDebug.S.places).find((p) => p.name === "Bukit Raja Plastics").type')) === 'supplier', 'a place already saved is not asked again and not changed');
    await sheetBtn('Cancel');
    await waitFor('!document.querySelector(".sheet")', 'the form closes');
    check(JSON.stringify(await card()) === JSON.stringify(c1), 'Cancel on the job form: the job is unchanged');

    console.log('5. after PLAN, an edit shows the note and does not change the route');
    await planNow(2);
    const before = await stopNames();
    check(JSON.stringify(before) === JSON.stringify(['ao', 'office']), 'planned: AO Advance then Office', before);
    check(await ev('!document.querySelector("#jobsChangedNote")'), 'no note straight after PLAN');
    await tab('plan');
    await click('.card.job .box.collect');
    await waitFor('document.querySelector(".sheet #jobDest")', 'the form');
    await click('#jobDest');
    await waitFor('document.querySelector(".picker-list .pick-row")', 'the picker rows');
    await ev('[...document.querySelectorAll(".picker-list .pick-row")].find((r) => /Carrier/.test(r.textContent)).click()');
    await waitFor('/Carrier/.test(document.querySelector("#jobDest").textContent)', 'Carrier chosen');
    await sheetBtn('Save changes');
    await waitFor('!document.querySelector(".sheet")', 'the form closes');
    const note = 'Jobs changed - tap PLAN to update the route';
    check(await text('#jobsChangedNote') === note, 'Plan tab: "' + note + '"', await text('#jobsChangedNote'));
    check(JSON.stringify(await stopNames()) === JSON.stringify(before), 'the stored route is not changed by the edit', await stopNames());
    await tab('route');
    check(await text('#jobsChangedNote') === note, 'Route tab: the same note', await text('#jobsChangedNote'));
    const names = () => ev('[...document.querySelectorAll(".timeline .card.stop .nm")].map((x) => x.textContent.trim()).join("|")');
    check(/^AO Advance.*\|Office/.test(await names()), 'the Route tab still shows AO Advance, Office', await names());
    await send('Page.reload');
    await waitFor('window.WaypointDebug && document.querySelector("#jobsChangedNote")', 'the note after a reload');
    check(true, 'the note survives a reload');
    await tab('plan');
    await planNow(2);
    check(JSON.stringify(await stopNames()) === JSON.stringify(['ao', 'carrier']), 'PLAN: the route now follows the edit (AO Advance, Carrier)', await stopNames());
    check(await ev('!document.querySelector("#jobsChangedNote")'), 'PLAN clears the note');

    console.log('6. Urgent, hold and delete still work');
    await tab('plan');
    const j = (expr) => ev('(() => { const j = WaypointDebug.S.jobs[0]; return ' + expr + '; })()');
    await click('.card.job .urgent-toggle');
    await waitFor('WaypointDebug.S.jobs[0].urgent === true', 'urgent on');
    check(await j('j.urgent === true && j.urgentRank === 1'), 'Urgent marks the job urgent (rank 1)');
    await click('.card.job .urgent-toggle');
    await waitFor('WaypointDebug.S.jobs[0].urgent === false', 'urgent off');
    check(await j('j.urgent === false'), 'Urgent again clears it');
    await click('.card.job [aria-label="Park job"]');
    await waitFor('WaypointDebug.S.jobs[0].status === "parked"', 'held');
    check(await ev('!!document.querySelector("details .card.job.parked")'), 'hold moves it to Parked');
    await click('.card.job [aria-label="Unpark job"]');
    await waitFor('WaypointDebug.S.jobs[0].status === "pending"', 'back to pending');
    check(await ev('!document.querySelector("details .card.job.parked") && !!document.querySelector(".card.job")'), 'Unpark brings it back');
    await click('.card.job [aria-label="Delete job"]');
    await clickText('.card.job .job-actions button', 'Delete');
    await waitFor('WaypointDebug.S.jobs.length === 0', 'deleted');
    check(await ev('!document.querySelector(".card.job")'), 'delete removes the job');

    // ---------- First stop and "just collect" (the 25 Nov 2026 day) ----------
    const pickPlace = async (re) => {
      await waitFor('document.querySelector(".picker-list .pick-row")', 'the picker rows');
      await ev('[...document.querySelectorAll(".picker-list .pick-row")].find((r) => ' + re + '.test(r.textContent)).click()');
      await sleep(100);
    };
    const routeCards = () => ev('[...document.querySelectorAll(".timeline .card.stop")].filter((c) => !c.classList.contains("fuel")).map((c) => ({ nm: (c.querySelector(".nm") || c.querySelector(".title") || {}).textContent, first: !!c.querySelector(".pill.first"), acts: [...c.querySelectorAll(".act")].map((a) => a.className.replace("act ", "") + ":" + a.textContent), done: c.classList.contains("done") }))');
    const noJobIds = () => ev('!/job j_|\\bj_[a-z0-9]{6,}/.test(document.body.innerText)');
    const doneAt = async (key, nm, L) => { await ev('window.__pos = ' + JSON.stringify(LL[L])); await reachDone(key, nm); await sleep(200); };

    console.log('7. the 25 Nov day: First stop on an errand, a just-collect job, PLAN');
    await fresh('s1');
    check((await jobIds()).length === 3, 'three seeded jobs (collect Office -> Asian, deliver Carrier, deliver Eastern)', await jobIds());
    await clickText('button', '+ Add job');
    await waitFor('document.querySelector(".sheet")', 'the add-job form');
    await clickText('.sheet .seg button', 'Errand');
    await clickText('.sheet button', 'Pick errand place');
    await pickPlace('/Office/');
    check(await ev('!!document.querySelector("#firstStopToggle") && document.querySelector("#firstStopToggle").checked === false'), 'the errand form has a First stop toggle, off by default');
    await ev('(() => { const n = [...document.querySelectorAll(".sheet input")].find((i) => i.placeholder === "Optional"); n.value = "Sign cheques"; n.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    await click('#firstStopToggle');
    await sheetBtn('Save job');
    await waitFor('!document.querySelector(".sheet")', 'the form closes');
    const errandId = await S('jobs.find((j) => j.errandPlaceId === "office").id');
    check(await S('jobs.filter((j) => j.firstStop).length') === 1 && await S('jobs.find((j) => j.firstStop).errandPlaceId') === 'office', 'the Office errand has First stop on (the only one)');
    check(await ev('[...document.querySelectorAll(".card.job")].filter((c) => c.querySelector(".pill.first")).map((c) => c.querySelector(".box.errand") ? "errand" : "other").join()') === 'errand', 'FIRST tag on the errand\'s Plan card only');

    await clickText('button', '+ Add job');
    await waitFor('document.querySelector(".sheet #jobDest")', 'the add-job form');
    check(await ev('!!document.querySelector("#firstStopToggle")'), 'the delivery form has the First stop toggle too');
    await clickText('.sheet button', 'Pick pickup place');
    await pickPlace('/Klang/');
    await ev('(() => { const n = [...document.querySelectorAll(".sheet input")].find((i) => i.placeholder === "Item (e.g. 2 pcs sensor)"); n.value = "Oil seals"; n.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    check(await text('#justCollectHint') === 'Just collect — stays with you' && /Pick delivery place/.test(await text('#jobDest')), 'empty "send to": the hint "Just collect — stays with you"', await text('#justCollectHint'));
    await sheetBtn('Save job');
    await waitFor('!document.querySelector(".sheet")', 'the form closes');
    const j1 = await S('jobs.find((j) => (j.pickups || []).some((p) => p.placeId === "klang"))');
    check(j1 && !j1.deliveryPlaceId && j1.pickups[0].item === 'Oil seals', 'the just-collect job is saved with no delivery place', j1);
    check((await jobIds()).length === 5, 'five jobs');

    await planNow(5, 30000);
    check(JSON.stringify(await stopNames()) === JSON.stringify(['office', 'asian', 'carrier', 'eastern', 'klang']), 'PLAN: Office, Asian Automotive, Carrier, Eastern Press, Klang', await stopNames());
    const rc = await routeCards();
    check(JSON.stringify(rc.map((c) => c.first)) === JSON.stringify([true, false, false, false, false]), 'the FIRST tag on the first Route card only', rc);
    check(rc.filter((c) => /^Office/.test(c.nm)).length === 1, 'exactly one Office card', rc.map((c) => c.nm));
    const klangBtns = await ev('[...document.querySelectorAll(".timeline .card.stop")].find((c) => /Klang/.test(c.textContent)).querySelector(".stop-btns").textContent');
    check(!/MSG/.test(klangBtns), 'the just-collect stop (a supplier pickup) has no MSG button', klangBtns);
    check(await noJobIds(), 'no "job j_" text on screen after PLAN');
    check(await S('plan.ctx && WaypointDebug.S.plan.result.plans[0].violations.length') === 0, 'no missed windows');

    console.log('8. DONE at every stop -> the Klang item is with you');
    await doneAt('office', 'Office', 'O');
    check(await S('jobs.find((j) => j.id === ' + JSON.stringify(errandId) + ').status') === 'done', 'DONE at the Office completes the errand');
    const left1 = await ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => !s.status).map((s) => s.placeId)');
    check(JSON.stringify(left1) === JSON.stringify(['asian', 'carrier', 'eastern', 'klang']), 'after DONE at the Office the remaining order is Asian, Carrier, Eastern, Klang', left1);
    await doneAt('asian', 'Asian', 'A');
    await doneAt('carrier', 'Carrier', 'C');
    await doneAt('eastern', 'Eastern', 'E');
    await doneAt('klang', 'Pacific Klang', 'K');
    await waitFor('document.querySelector("#onBoardToggle")', 'the With you bar');
    check(/With you: 1 item/.test(await barText()), 'Route tab: "With you: 1 item"', await barText());
    await openBar();
    check(await ev('/Oil seals/.test(document.querySelector("#onBoardList").textContent) && /Pacific Klang/.test(document.querySelector("#onBoardList").textContent)'), 'the row: Oil seals from Pacific Klang');
    check(await S('jobs.find((j) => (j.pickups || []).some((p) => p.placeId === "klang")).status') === 'done', 'the just-collect job is finished for the day');
    check(await noJobIds(), 'no "job j_" text on screen after the day');

    console.log('9. the two-visit day: two Office cards');
    await fresh('s2');
    await planNow(4, 30000);
    const order2 = await stopNames();
    const rc2 = await routeCards();
    const offices = rc2.map((c, i) => (/^Office/.test(c.nm) ? i : -1)).filter((i) => i >= 0);
    check(offices.length === 2 && offices[0] === 0, 'two Office cards, the first one is stop 1', rc2.map((c) => c.nm));
    check(rc2[0].first && !rc2[offices[1]].first, 'FIRST on stop 1 only', rc2.map((c) => c.first));
    check(rc2[offices[1]].acts.length === 1 && /^deliver:Compressor/.test(rc2[offices[1]].acts[0]), 'the second Office card holds only the Carrier delivery', rc2[offices[1]].acts);
    check(rc2[0].acts.length === 2 && rc2[0].acts.some((a) => /^errand:/.test(a)) && rc2[0].acts.some((a) => /^collect:Brackets/.test(a)), 'stop 1 holds the errand and the Brackets collection', rc2[0].acts);
    check(order2.indexOf('carrier') < offices[1] && order2.indexOf('asian') > 0, 'Carrier comes before the second Office card; Asian after stop 1', order2);
    check(order2[offices[1]] === 'office#2', 'the second visit is its own stop', order2);
    check(!(await ev('window.__legs')).some((l) => { const [a, b] = l.split(':'); return a === b; }), 'no request for the Office -> Office pair');
    // A2: First stop on for another job -> it moves, with the toast naming both places (the route waits for PLAN)
    await tab('plan');
    await ev('[...document.querySelectorAll(".card.job")].find((c) => /Compressor/.test(c.textContent)).querySelector(".edit-btn").click()');
    await waitFor('document.querySelector(".sheet #firstStopToggle")', 'the edit form');
    check(await ev('document.querySelector("#firstStopToggle").checked === false'), 'the edit form shows First stop off for this job');
    await click('#firstStopToggle');
    await sheetBtn('Save changes');
    await waitFor('/First stop moved/.test(document.getElementById("toast").textContent)', 'the First stop toast');
    check(await text('#toast') === 'First stop moved from Office to Carrier', 'the toast: First stop moved from Office to Carrier', await text('#toast'));
    check(JSON.stringify(await S('jobs.filter((j) => j.firstStop).map((j) => j.id)')) === '["j6"]', 'only that job has First stop now');
    check(JSON.stringify(await stopNames()) === JSON.stringify(order2), 'the stored route is unchanged until PLAN');
    await tab('route');
    await doneAt('office', 'Office', 'O');
    check(await S('jobs.find((j) => j.id === "j6").status') === 'pending', 'DONE on stop 1 leaves the Carrier -> Office delivery open');
    check(await ev('WaypointDebug.S.plan.result.plans[0].stops.find((s) => s.placeId === "office#2").status') == null, 'the second Office card is still pending');
    check(await noJobIds(), 'no "job j_" text on screen');

    console.log('10. the After rule (T2 data): the S job after A and C, through the edit form');
    await fresh('s3');
    await ev('window.__pos = ' + JSON.stringify(LL.O)); // start at the Office
    await ev('[...document.querySelectorAll(".card.job")].find((c) => /HeveaPac/.test(c.textContent)).querySelector(".edit-btn").click()');
    await waitFor('document.querySelector(".sheet #afterList")', 'the After field in the edit form');
    const afterRows = () => ev('[...document.querySelectorAll("#afterList .after-opt")].map((b) => ({ t: b.querySelector(".title").textContent.replace("✓", "").trim(), on: b.getAttribute("aria-pressed") === "true" }))');
    const a0 = await afterRows();
    check(JSON.stringify(a0.map((r) => r.t)) === JSON.stringify(['Asian Automotive', 'Carrier', 'Eastern Press']) && a0.every((r) => !r.on), 'After lists the other open places (not HeveaPac), none chosen', a0);
    await ev('[...document.querySelectorAll("#afterList .after-opt")].find((b) => /Asian/.test(b.textContent)).click()');
    await sleep(100);
    await ev('[...document.querySelectorAll("#afterList .after-opt")].find((b) => /Carrier/.test(b.textContent)).click()');
    await sleep(100);
    const a1 = await afterRows();
    check(JSON.stringify(a1.map((r) => r.on)) === '[true,true,false]', 'Asian Automotive and Carrier chosen', a1);
    await sheetBtn('Save changes');
    await waitFor('!document.querySelector(".sheet")', 'the form closes');
    check(JSON.stringify(await S('jobs.find((j) => j.id === "jS").afterPlaces')) === '["asian","carrier"]', 'saved: afterPlaces = asian, carrier');
    const afterLineOf = () => ev('(() => { const c = [...document.querySelectorAll(".card.job")].find((x) => /HeveaPac/.test(x.textContent)); const l = c && c.querySelector(".after-line"); return l ? l.textContent : null; })()');
    check(await afterLineOf() === 'after Asian Automotive, Carrier', 'the Plan card line: "after Asian Automotive, Carrier"', await afterLineOf());
    await planNow(4, 30000); // 4 stops = 20 live requests, 300 ms apart
    check(JSON.stringify(await stopNames()) === JSON.stringify(['asian', 'carrier', 'heveapac', 'eastern']), 'PLAN: Asian Automotive, Carrier, HeveaPac, Eastern Press (A, C, S, E)', await stopNames());
    check(await ev('!document.querySelector("#afterBanner")'), 'no red After banner');
    await tab('plan');
    check(await afterLineOf() === 'after Asian Automotive, Carrier', 'the Plan card still shows the after line after PLAN', await afterLineOf());

    console.log('11. the contact name on Route cards (Part 4) and ▲ / ▼ (Part 6), world s4');
    await fresh('s4');
    await planNow(4, 30000);
    const order = () => ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => !s.status).map((s) => s.placeId).join()');
    check(await order() === 'asian,carrier,eastern,klang', 'PLAN: Asian, Carrier, Eastern Press, Klang (the 10-minute chain)', await order());
    // Part 4 (at 360 px, a narrow phone)
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const actLine = (pid) => ev('(() => { const i = WaypointDebug.S.plan.result.plans[0].stops.findIndex((s) => s.placeId === ' + JSON.stringify(pid) + '); const c = document.querySelectorAll(".timeline .card.stop")[i]; const a = c.querySelector(".act"); const t = a.querySelector(".contact-tail"); const lh = parseFloat(getComputedStyle(a).lineHeight); return { text: a.textContent, tail: t ? t.textContent : null, cut: t ? t.scrollWidth > t.clientWidth : null, w: [a.clientWidth, t ? t.clientWidth : 0, t ? t.scrollWidth : 0, window.innerWidth], oneLine: a.getBoundingClientRect().height < lh * 1.5, lines: c.querySelectorAll(".act").length }; })()');
    const ca = await actLine('asian');
    check(ca.tail === ' · Encik Ali bin Abu Bakar (purchasing)' && /^Brackets 4 pcs, stainless · Encik Ali/.test(ca.text), 'Asian: " · Encik Ali bin Abu Bakar…" at the end of its job line', ca);
    check(ca.oneLine && ca.cut === true && ca.lines === 1, 'still one line: the long name is cut with an ellipsis (no new line)', ca);
    const ck = await actLine('klang');
    check(ck.tail === null && !/·/.test(ck.text), 'Klang has no contact name: nothing added', ck);
    // Part 6
    const arrows = () => ev('[...document.querySelectorAll(".timeline .card.stop")].map((c) => { const u = c.querySelector(".move-btn[data-move=up]"), d = c.querySelector(".move-btn[data-move=down]"); return u && d ? (u.disabled ? "-" : "U") + (d.disabled ? "-" : "D") : "none"; }).join(" ")');
    check(await arrows() === '-D UD UD U-', '▲ off on the first stop, ▼ off on the last before the end point', await arrows());
    check(await ev('!document.querySelector("#endCard .move-btn")'), 'no arrows on the end-point card');
    const headH = await ev('Math.max(...[...document.querySelectorAll(".timeline .card.stop .stop-head")].map((x) => Math.round(x.getBoundingClientRect().height)))');
    check(headH <= 34, 'the title row stays one row with the arrows (' + headH + ' px)', headH);
    const moveBtn = (pid, dir) => ev('(() => { const i = WaypointDebug.S.plan.result.plans[0].stops.findIndex((s) => s.placeId === ' + JSON.stringify(pid) + '); document.querySelectorAll(".timeline .card.stop")[i].querySelector(".move-btn[data-move=' + dir + ']").click(); return true; })()');
    const legsNow = () => ev('window.__legs.length');
    const arrivals = () => ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => !s.status).map((s) => s.arriveAt)');
    const gaps = (a) => a.slice(1).map((t, k) => Math.round((t - a[k]) / 60000));
    await sleep(500);
    const L0 = await legsNow();
    // 6c: Eastern Press above Carrier = the Compressor delivered before it is collected
    await moveBtn('eastern', 'up');
    await sleep(300);
    const bnr = (await text('#banner')).replace(/OK$/, '');
    check(bnr === "Can't move: Compressor is collected at Carrier, so Eastern Press must come after it", 'refused: the notice names the item', bnr);
    check(await order() === 'asian,carrier,eastern,klang' && await ev('!document.querySelector("#manualOrderNote")') && await legsNow() === L0, 'refused: order unchanged, no note, no request');
    // 6a/6b/6d: ▼ on Asian -> Carrier, Asian, Eastern, Klang, re-timed
    check(JSON.stringify(gaps(await arrivals())) === '[10,10,10]', 'before: 10 min between the stops', gaps(await arrivals()));
    await moveBtn('asian', 'down');
    await waitFor('WaypointDebug.S.plan.result.plans[0].stops[0].placeId === "carrier"', 'the swap');
    await sleep(500);
    check(await order() === 'carrier,asian,eastern,klang', '▼ on Asian: Carrier, Asian, Eastern Press, Klang', await order());
    check(JSON.stringify(gaps(await arrivals())) === '[10,50,10]', 're-timed from the table: Carrier -> Asian 10, Asian -> Eastern 50, Eastern -> Klang 10', gaps(await arrivals()));
    const names4 = await ev('[...document.querySelectorAll(".timeline .card.stop .nm")].map((x) => x.textContent.trim()).join("|")');
    check(/^Carrier\|Asian Automotive\|Eastern Press\|Pacific Klang/.test(names4), 'the Route cards follow', names4);
    const reqMove1 = (await legsNow()) - L0;
    check(reqMove1 === 0, 'the move used ' + reqMove1 + ' TomTom requests (every leg already in the table)', reqMove1);
    console.log('       TomTom requests for the ▼ on Asian: ' + reqMove1);
    check(await text('#manualOrderNote') === 'Manual order — tap PLAN to let the app reorder', 'the note under the Route header', await text('#manualOrderNote'));
    check(await arrows() === '-D UD UD U-', 'the arrows follow the new first / last', await arrows());
    // a leg neither in the table nor learned: fetched (one request, through the limiter), nothing else
    await ev('(() => { const m = WaypointDebug.S.plan.result.plans[0].model, i = m.stopIds.indexOf("asian") + 1, j = m.stopIds.indexOf("klang") + 1; m.matrices.forEach((x) => { x.m[i][j] = null; }); WaypointDebug.S.mem.pairs = {}; return true; })()');
    const L1 = await legsNow();
    await moveBtn('eastern', 'down');
    await waitFor('WaypointDebug.S.plan.result.plans[0].stops.map((s) => s.placeId).join() === "carrier,asian,klang,eastern"', 'the second swap');
    await waitFor('window.__legs.length > ' + L1, 'the missing leg fetched');
    await sleep(800);
    const reqMove2 = (await legsNow()) - L1;
    check(reqMove2 === 1, '▼ on Eastern Press with Asian -> Klang unknown: exactly 1 TomTom request', reqMove2);
    console.log('       TomTom requests for the ▼ on Eastern Press (one leg removed from the table and the memory): ' + reqMove2);
    check(await ev('(() => { const m = WaypointDebug.S.plan.result.plans[0].model, i = m.stopIds.indexOf("asian") + 1, j = m.stopIds.indexOf("klang") + 1; return m.matrices[0].m[i][j] === 3000 && !(m.matrices[0].est && m.matrices[0].est[i][j]); })()'), 'the fetched leg (50 min) is in the table');
    check(JSON.stringify(gaps(await arrivals())) === '[10,50,10]', 're-timed: Carrier -> Asian 10, Asian -> Klang 50, Klang -> Eastern 10', gaps(await arrivals()));
    // 6e: DONE after a manual move leaves the order alone (the look-ahead would switch to Asian, Eastern, Klang: 40 min sooner)
    const L2 = await legsNow();
    await reachDone('carrier', 'Carrier');
    await sleep(800);
    check(await order() === 'asian,klang,eastern', 'DONE at Carrier: the manual order stays (Asian, Klang, Eastern Press)', await order());
    check(await legsNow() === L2 && await ev('!document.querySelector("#reorderNotice") && !document.querySelector("#reorderCard")'), 'no look-ahead requests, no "Order updated" notice');
    check(await text('#manualOrderNote') === 'Manual order — tap PLAN to let the app reorder', 'the note stays until PLAN');
    await send('Page.reload');
    await waitFor('window.WaypointDebug && document.querySelector("#manualOrderNote")', 'the note after a reload');
    check(true, 'the manual order survives a reload');
    // PLAN re-solves as usual and clears the note
    await tab('plan');
    await planNow(4, 30000);
    check(await order() === 'asian,eastern,klang', 'PLAN re-solves: Asian, Eastern Press, Klang', await order());
    check(await ev('!document.querySelector("#manualOrderNote")'), 'PLAN clears the note');

    check(page.logs.length === 0, 'no page errors', page.logs);
  } finally {
    await cleanup();
  }
}

main().then(() => {
  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  process.exit(fails ? 1 : 0);
}).catch((e) => {
  console.log('SMOKE ERROR: ' + (e && e.stack || e));
  console.log('\n' + passes + ' passed, ' + (fails + 1) + ' failed');
  process.exit(1);
});
