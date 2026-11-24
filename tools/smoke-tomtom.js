#!/usr/bin/env node
/* Mocked browser smoke for TomTom on the Routing API (no screenshots, no network, no real keys).
 *   node tools/smoke-tomtom.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol, and mocks
 * TomTom (calculateRoute and Matrix are counted per endpoint, every departAt recorded; one leg can be made very slow; any
 * request touching a chosen point can answer 403), geolocation incl. watchPosition, the clipboard and the clock (pinned to
 * 24 Nov 2026 10:00 Malaysia time). Walks:
 *   1. PLAN 6 stops A..F from O (my location) to E: exactly 49 Routing calls (42 table + 7 check), 0 Matrix, the progress
 *      text "Getting travel times n of N…", no "est." on any ETA.     2. PLAN again: 7 calls (the learned table + the check).
 *   3. 60 GPS-watch updates over a mocked 10 minutes: at most 1 Routing call (the 10-minute re-time).
 *   4. DONE on the first stop (5 pending -> full refresh): exactly 5 + 20 + 5 = 30 calls; a later leg made very slow -> the
 *      order changes by itself, the "Order updated … · Undo" notice, Replans +1; Undo -> the previous order back.
 *   5. Setting "Ask me", DONE on the next stop: the Switch / Keep mine card, nothing changes until Switch.
 *   6. MSG on a customer stop: the copied text is the owner's wording (Salam …, sebelum pukul …, Tq👍).
 *   7. 403 for a new pair: the ONE notice with the new text (no "08:00"), a route, "Estimated order" in the header, no look-ahead.
 *   8. Settings "Usage": TomTom Routing and Google Places, today and this month, equal to the mock's counts.
 * Exit 1 on failure. Needs Node 22+ (global WebSocket / fetch) and Chrome or Edge (set CHROME=<path> to choose one).
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

// ---------- the world: O (office, where the run starts), six customer deliveries A..F (east / north), E = home ----------
const pl = (id, name, lat, lng, type, dwell) => ({ id, name, address: name + ' St', lat, lng, type, dwellMin: dwell, closedWindows: [], salutation: 'Encik', lang: 'default' });
const PLACES = [
  pl('pO', 'Office O', 3.0994, 101.7390, 'office', 10), pl('home', 'Home E', 3.0758, 101.6609, 'home', 0),
  pl('pA', 'Alpha Works', 3.120, 101.760, 'factory', 10), pl('pB', 'Beta Works', 3.140, 101.780, 'factory', 10),
  pl('pC', 'Gamma Works', 3.160, 101.750, 'factory', 10), pl('pD', 'Delta Works', 3.180, 101.790, 'factory', 10),
  pl('pF', 'Foxtrot Works', 3.110, 101.800, 'factory', 10), pl('pH', 'Hotel Works', 3.150, 101.820, 'factory', 10),
  pl('pG', 'Golf Works', 3.200, 101.740, 'factory', 10),
];
const job = (id, pid, item) => ({ id, pickups: [], inHandItem: item, deliveryPlaceId: pid, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-24T01:0' + id.slice(1) + ':00.000Z' });
const SEED = { 'waypoint:settings:main': { googleKey: 'test-google', tomtomKey: 'test-tomtom', seeded: true, defaultLang: 'ms', nav: 'waze', driverName: 'Calvin', lunchBreakOn: false } };
PLACES.forEach((p) => { SEED['waypoint:places:' + p.id] = p; });
['pA', 'pB', 'pC', 'pD', 'pF', 'pH', 'pG'].forEach((pid, i) => { SEED['waypoint:jobs:j' + (i + 1)] = job('j' + (i + 1), pid, 'Part ' + (i + 1)); });
const O = PLACES[0];
const GPS0 = { lat: O.lat, lng: O.lng, accuracy: 15 }; // "My location" = the office

const INIT = `(() => {
  const RealDate = Date;
  // the clock is pinned: 24 Nov 2026 02:00 UTC = 10:00 Malaysia time
  window.__off = RealDate.UTC(2026, 10, 24, 2, 0, 0) - RealDate.now();
  window.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + window.__off); else super(...a); }
    static now() { return RealDate.now() + window.__off; }
  };
  try { delete Navigator.prototype.serviceWorker; } catch (e) { /* ignore */ }
  Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return 'visible'; } });
  window.__gps = ${JSON.stringify(GPS0)};
  window.__watches = {}; window.__watchSeq = 0;
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(ok) { setTimeout(() => ok({ coords: { latitude: window.__gps.lat, longitude: window.__gps.lng, accuracy: window.__gps.accuracy }, timestamp: Date.now() }), 0); },
    watchPosition(ok, err, opts) { const id = ++window.__watchSeq; window.__watches[id] = { ok, err }; return id; },
    clearWatch(id) { delete window.__watches[id]; },
  } });
  window.__watchFire = (p) => { const ws = Object.values(window.__watches); ws.forEach((w) => w.ok({ coords: { latitude: p.lat, longitude: p.lng, accuracy: p.accuracy }, timestamp: Date.now() })); return ws.length; };
  try { navigator.permissions.query = async () => ({ state: 'granted', addEventListener() {} }); } catch (e) { /* ignore */ }
  window.__copiedText = '';
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copiedText = t; } } }); } catch (e) { /* ignore */ }
  window.open = () => null;
  document.addEventListener('click', (e) => { const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]'); if (a) e.preventDefault(); }, true);
  // every banner text the page shows (the PLAN progress line is short-lived)
  window.__banners = [];
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => { const b = document.getElementById('banner'); if (b && !b.hidden && b.textContent) window.__banners.push(b.textContent); })
      .observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const km = (a, b) => { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dg = (b.lng - a.lng) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const realFetch = window.fetch.bind(window);
  const same = (p, q) => Math.abs(p.lat - q.lat) < 1e-4 && Math.abs(p.lng - q.lng) < 1e-4;
  // __rt: every Routing call {a, b, departAt}; __mx: Matrix calls; __slow: [from, to] made 3 h slower; __deny: a point -> 403
  window.__rt = []; window.__mx = 0; window.__places = 0; window.__other = 0; window.__slow = null; window.__deny = null;
  window.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('api.tomtom.com/routing/1/calculateRoute/')) {
      const q = url.split('/calculateRoute/')[1].split('/')[0].split(/[,:]/).map(Number);
      const a = { lat: q[0], lng: q[1] }, b = { lat: q[2], lng: q[3] };
      const dep = decodeURIComponent((url.split('departAt=')[1] || '').split('&')[0]);
      window.__rt.push({ a, b, departAt: dep, at: Date.now() });
      if (window.__deny && (same(a, window.__deny) || same(b, window.__deny))) return new Response(JSON.stringify({ detailedError: { code: 'Forbidden', message: 'You do not have enough credits to perform this action' } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      const k = km(a, b);
      let s = Math.round(k * 1.3 / 40 * 3600);
      if (window.__slow && same(a, window.__slow[0]) && same(b, window.__slow[1])) s += 3 * 3600;
      return new Response(JSON.stringify({ formatVersion: '0.0.12', routes: [{ summary: { lengthInMeters: Math.round(k * 1300), travelTimeInSeconds: s, trafficDelayInSeconds: 0, departureTime: '', arrivalTime: '' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('api.tomtom.com')) { window.__mx++; return new Response('{}', { status: 500 }); }
    if (url.includes('places.googleapis.com')) { window.__places++; return new Response(JSON.stringify({ places: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    if (!url.startsWith(location.origin)) { window.__other++; return new Response('{}', { status: 404 }); }
    return realFetch(url, init);
  };
  try {
    if (!localStorage.getItem('__seeded')) {
      const d = new Date(), today = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      const seed = ${JSON.stringify(SEED)};
      seed['waypoint:settings:main'].placesCallsToday = { date: today, count: 0 };
      Object.keys(seed).forEach((k) => localStorage.setItem(k, JSON.stringify(seed[k])));
      localStorage.setItem('__seeded', '1');
    }
  } catch (e) { /* ignore */ }
})();`;

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
    const rt = () => ev('window.__rt.length');
    const tab = (name) => click('#tabs button[data-tab="' + name + '"]');
    const settle = async () => { await sleep(300); await waitFor('!WaypointDebug.S.busy && !WaypointDebug.S.loc.busy', 'the app to settle', 10000); await sleep(200); };
    const plan = async (nStops) => {
      await tab('plan');
      await waitFor('document.querySelector("#planBtn") && !WaypointDebug.S.busy', 'the Plan tab');
      await click('#planBtn');
      await waitFor('!WaypointDebug.S.busy && WaypointDebug.S.tab === "route" && document.querySelectorAll(".timeline .card.stop").length === ' + nStops, 'the planned route', 15000);
      await settle();
    };
    const pending = () => ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => !s.status).map((s) => s.placeId)');
    const idxOf = (id) => ev('WaypointDebug.S.plan.result.plans[0].stops.findIndex((s) => s.placeId === ' + JSON.stringify(id) + ')');
    const card = (n) => 'document.querySelectorAll(".timeline .card.stop")[' + n + ']';
    const clickPrimary = async (id) => { const n = await idxOf(id); return ev('(() => { const x = ' + card(n) + '.querySelector(".stop-btns button.ok"); x.click(); return x.textContent; })()'); };
    const gpsAt = (pid) => ev('(() => { const p = WaypointDebug.S.places[' + JSON.stringify(pid) + ']; window.__gps = { lat: p.lat, lng: p.lng, accuracy: 15 }; return true; })()');
    const reachDone = async (id) => { // REACHED, then DONE 2 s later (past the double-tap guard)
      await clickPrimary(id);
      await waitFor('WaypointDebug.S.plan.result.plans[0].stops.find((s) => s.placeId === ' + JSON.stringify(id) + ').reachedAt != null', 'Reached at ' + id);
      await ev('window.__off += 2000');
      await clickPrimary(id);
      await waitFor('WaypointDebug.S.plan.result.plans[0].stops.find((s) => s.placeId === ' + JSON.stringify(id) + ').status === "done"', 'DONE at ' + id);
    };
    const replans = () => ev('(() => { const S = WaypointDebug.S, d = Object.values(S.days)[0]; return d ? DayLog.summarise(d, S.jobs, S.places).plan.replans : 0; })()');
    const etaTexts = () => ev('[...document.querySelectorAll(".timeline .card.stop .stop-head .times")].map((e) => e.textContent).concat([document.getElementById("endArrive").textContent])');

    console.log('1. PLAN 6 stops A..F from O to E at a mocked 10:00');
    await send('Page.navigate', { url: appUrl });
    await waitFor('document.querySelector("#planBtn")', 'the Plan tab');
    // stop G (job j7) waits, parked, for step 7: six stops now
    await waitFor('window.WaypointDebug && WaypointDebug.S.jobs.length === 7', 'the seven seeded jobs');
    await ev('(() => { const j = WaypointDebug.S.jobs.find((x) => x.id === "j7"); j.status = "parked"; return true; })()');
    check(await ev('new Date().toISOString()').then((t) => t.startsWith('2026-11-24T02:0')), 'the clock is pinned to 24 Nov 2026 10:00 MYT');
    await plan(6);
    const c1 = await ev('window.__rt.map((c) => c.departAt)');
    check(c1.length === 49 && await ev('window.__mx') === 0, 'exactly 49 Routing calls (42 table + 7 check) and 0 Matrix calls', { routing: c1.length, matrix: await ev('window.__mx') });
    check(c1.slice(0, 43).every((d) => d === 'now') && c1.slice(43).every((d) => /^2026-11-24T1[0-3]:[0-5][0-9]:00\+08:00$/.test(d)), 'the table departs now (10:00 is inside its Day bucket); the first check leg departs now, the later ones at their planned departures (+08:00)', [c1[0], c1[42], c1[43], c1[48]]);
    const banners = await ev('window.__banners');
    check(banners.some((b) => /^Getting travel times \d+ of \d+…/.test(b)), 'the progress text "Getting travel times n of N…" appears', banners.filter((b) => /Getting/.test(b)).slice(-2));
    check(banners.some((b) => /Getting travel times 42 of 42…/.test(b)), '... counting up to 42 of 42 for the table');
    const etas = await etaTexts();
    check(etas.length === 7 && etas.every((t) => !/est\./.test(t)), 'no ETA is marked "est."', etas);
    check(!(await ev('document.getElementById("estHeader")')), 'no "Estimated" chip in the header');

    console.log('2. PLAN again');
    let n0 = await rt();
    await plan(6);
    check((await rt()) - n0 === 7, 'PLAN again: 7 Routing calls (the learned table + one check per leg)', (await rt()) - n0);

    console.log('3. 60 watch updates over a mocked 10 minutes');
    await waitFor('Object.keys(window.__watches).length === 1', 'the GPS watch');
    n0 = await rt();
    const pos = Object.assign({}, GPS0);
    for (let u = 1; u <= 60; u++) {
      await ev('window.__off += 10000');
      pos.lng -= 0.004; // west, away from every stop
      await ev('(() => { window.__gps = ' + JSON.stringify(pos) + '; return window.__watchFire(' + JSON.stringify(pos) + '); })()');
      await sleep(20);
      if (u % 6 === 0) { await ev('WaypointDebug.minuteTick()'); await sleep(120); await waitFor('!WaypointDebug.S.loc.busy', 'the tick'); }
    }
    check((await rt()) - n0 <= 1, 'at most 1 Routing call in those 10 minutes', (await rt()) - n0);

    console.log('4. DONE on the first stop: 5 pending -> full refresh; a later leg made very slow');
    const ord0 = await pending();
    const first = ord0[0], nextTwo = [ord0[1], ord0[2]];
    await ev('(() => { const P = WaypointDebug.S.places; window.__slow = [P[' + JSON.stringify(nextTwo[0]) + '], P[' + JSON.stringify(nextTwo[1]) + ']]; return true; })()');
    await gpsAt(first);
    const rp0 = await replans();
    n0 = await rt();
    await reachDone(first);
    await settle();
    const nDone = (await rt()) - n0;
    check(nDone === 30, 'exactly 5 + 20 + 5 = 30 Routing calls', nDone);
    const ord1 = await pending();
    check(ord1.join() !== ord0.slice(1).join(), 'the order changed by itself', { before: ord0.slice(1), after: ord1 });
    check(ord1.indexOf(nextTwo[1]) !== ord1.indexOf(nextTwo[0]) + 1, 'the very slow leg is no longer driven', ord1);
    const notice = await ev('(document.getElementById("reorderNotice") || {}).textContent || ""');
    check(/^Order updated: (next is .+ \(was .+\)|after .+ then .+) - saves about \d+ min · Undo$/.test(notice), 'the "Order updated … · Undo" notice at the top of the Route tab', notice);
    check((await replans()) === rp0 + 1, '"Replans" +1', { before: rp0, after: await replans() });
    await click('#reorderUndo');
    await sleep(200);
    check((await pending()).join() === ord0.slice(1).join(), 'Undo: the previous order is back', await pending());
    check(!(await ev('document.getElementById("reorderNotice")')), 'the notice is gone');

    console.log('5. Setting "Ask me", DONE on the next stop');
    await tab('settings');
    await waitFor('document.getElementById("afterStopSel")', 'the setting');
    await ev('(() => { const s = document.getElementById("afterStopSel"); s.value = "ask"; s.dispatchEvent(new Event("change")); return true; })()');
    check(await ev('WaypointDebug.S.settings.afterStop') === 'ask', 'the setting is "Ask me"');
    await tab('route');
    const ordA = await pending(); // the slow leg is now the first one: from here (ordA[0]) to ordA[1]
    await gpsAt(ordA[0]);
    n0 = await rt();
    const rp1 = await replans();
    await reachDone(ordA[0]);
    await settle();
    check((await rt()) - n0 === 20, '4 pending: 4 + 12 + 4 = 20 Routing calls', (await rt()) - n0);
    check(await ev('!!document.getElementById("reorderCard") && !!document.getElementById("reorderSwitch") && !!document.getElementById("reorderKeep")'), 'the card with Switch / Keep mine appears');
    check((await pending()).join() === ordA.slice(1).join(), 'nothing changes before Switch', await pending());
    await click('#reorderSwitch');
    await sleep(200);
    check((await pending()).join() !== ordA.slice(1).join() && (await replans()) === rp1 + 1, 'Switch: the faster order is applied, "Replans" +1', await pending());

    console.log('6. MSG on a customer stop');
    const msgStop = (await pending())[0];
    await ev('(() => { const c = document.querySelectorAll(".timeline .card.stop")[WaypointDebug.S.plan.result.plans[0].stops.findIndex((s) => s.placeId === ' + JSON.stringify(msgStop) + ')]; const b = [...c.querySelectorAll("button")].find((x) => x.textContent === "MSG"); b.click(); return true; })()');
    await waitFor('window.__copiedText', 'the copied message');
    const copied = await ev('window.__copiedText');
    check(/^Salam (pagi|tengah hari|petang|malam) encik, barang encik nanti saya sebelum pukul \d{1,2}\.\d\d(am|pm) hantar ke kilang encik ye\. Tq👍$/.test(copied) && copied.startsWith('Salam ') && copied.includes('sebelum pukul') && copied.endsWith('Tq👍'), 'the copied text is the owner\'s wording (Salam …, sebelum pukul …, Tq👍)', copied);

    console.log('7. TomTom answers 403 for a new pair');
    await ev('(() => { const j = WaypointDebug.S.jobs.find((x) => x.id === "j7"); j.status = "pending"; WaypointDebug.render(); window.__deny = WaypointDebug.S.places.pG; return true; })()');
    const left = (await pending()).length;
    await plan(await ev('WaypointDebug.S.plan.result.plans[0].stops.length') + 1); // the done stops stay on top, + the new stop G
    const notices = await ev('[...document.querySelectorAll("#ttNotice")].map((e) => e.textContent)');
    check(notices.length === 1 && notices[0] === 'TomTom unavailable or monthly allowance used up - using estimated times', 'ONE notice with the new text', notices);
    check(!/08:00|resets/.test(await ev('document.body.innerText')), 'no "08:00" / reset wording anywhere on the page');
    check(await ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => !s.status).length') === left + 1, 'a route is still produced (with the new stop)');
    check(await ev('(document.getElementById("estHeader") || {}).textContent') === 'Estimated order - TomTom unavailable', 'the header shows "Estimated order - TomTom unavailable"');
    const nxt = (await pending()).find((id) => id !== 'pG');
    await gpsAt(nxt);
    n0 = await rt();
    await reachDone(nxt);
    await settle();
    check((await rt()) - n0 <= 1, 'DONE while TomTom is out: no look-ahead (at most the single next-stop re-time)', (await rt()) - n0);

    console.log('8. Settings "Usage"');
    await tab('settings');
    await waitFor('document.getElementById("usageCard")', 'the Usage card');
    const total = await rt(), places = await ev('window.__places');
    const fmtN = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const uR = await ev('document.getElementById("usageRouting").textContent'), uP = await ev('document.getElementById("usagePlaces").textContent');
    check(uR === 'TomTom Routing   ' + fmtN(total) + ' today · ' + fmtN(total) + ' this month of 20,000', 'TomTom Routing: today and this month = the mock\'s ' + total + ' calls', uR);
    check(uP === 'Google Places    ' + places + ' today · ' + places + ' this month  (daily guard 140)', 'Google Places: today and this month = the mock\'s ' + places + ' calls', uP);
    check(await ev('!document.getElementById("usageMatrix")') && await ev('window.__mx') === 0, 'Matrix: 0 calls, not shown');
    check(await ev('document.querySelectorAll("#usageCard .usage-bar").length') === 2, 'a thin bar for each');
    check(/^Learned travel times: \d+ pairs?$/.test(await ev('document.getElementById("learnedCount").textContent')), 'Settings: "Learned travel times: N pairs"', await ev('document.getElementById("learnedCount").textContent'));
    check(await ev('window.__other') === 0, 'no other network calls left the page');
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
