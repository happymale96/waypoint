#!/usr/bin/env node
/* Mocked browser smoke for the TomTom budget (no screenshots, no network, no real keys).
 *   node tools/smoke-tomtom.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol, and mocks
 * TomTom (every call it receives is logged with its origins x destinations; it can answer 403 "not enough credits"),
 * geolocation incl. watchPosition, and the clock inside the page. Walks: PLAN with 4 stops, then 60 GPS-watch updates over a
 * mocked 10 minutes (the minute timer run once per mocked minute): 0 TomTom calls from the updates, at most one periodic
 * re-time, each 1 x 1. Then TomTom answers 403: PLAN still gives a route, ONE friendly notice, no raw "HTTP 403", "Estimated
 * times" in the Route header, ETAs marked "est.". TomTom recovers: the next PLAN clears the notice and the marks. Settings
 * shows the counter with exactly the requests / cells the mock received. Exit 1 on failure.
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

// ---------- the world: four deliveries / errands at four places, home as the end ----------
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-24T01:0' + id.slice(1) + ':00.000Z' }, o);
const SEED = {
  'waypoint:settings:main': { googleKey: 'test-google', tomtomKey: 'test-tomtom', seeded: true, defaultLang: 'ms', nav: 'waze', driverName: 'Calvin', lunchBreakOn: false },
  'waypoint:places:home': { id: 'home', name: 'Home (Bloomsvale)', address: 'Bloomsvale', lat: 3.0757673, lng: 101.6609445, type: 'home', dwellMin: 0, closedWindows: [] },
  'waypoint:places:pA': { id: 'pA', name: 'Alpha Bank', address: 'A St', lat: 3.10, lng: 101.66, type: 'other', dwellMin: 10, closedWindows: [] },
  'waypoint:places:pB': { id: 'pB', name: 'Beta Customer', address: 'B St', lat: 3.125, lng: 101.705, type: 'factory', dwellMin: 15, closedWindows: [] },
  'waypoint:places:pC': { id: 'pC', name: 'Gamma Works', address: 'C St', lat: 3.17, lng: 101.62, type: 'factory', dwellMin: 15, closedWindows: [] },
  'waypoint:places:pD': { id: 'pD', name: 'Delta Supply', address: 'D St', lat: 3.14, lng: 101.58, type: 'supplier', dwellMin: 10, closedWindows: [] },
  'waypoint:jobs:j1': job('j1', { inHandItem: 'Urgent part', deliveryPlaceId: 'pB', urgent: true, urgentRank: 1 }),
  'waypoint:jobs:j2': job('j2', { inHandItem: 'Spare', deliveryPlaceId: 'pC' }),
  'waypoint:jobs:j3': job('j3', { errandPlaceId: 'pA', dwellMin: 10, notes: 'Pay bill' }),
  'waypoint:jobs:j4': job('j4', { inHandItem: 'Bolts', deliveryPlaceId: 'pD' }),
};
const GPS0 = { lat: 3.0, lng: 101.65, accuracy: 15 }; // far from every stop (no auto-reach while driving west)

const INIT = `(() => {
  const RealDate = Date;
  // the mocked clock starts at 04:00 UTC today (12:00 MYT), far from the counter's 00:00 UTC rollover
  window.__off = (() => { const n = RealDate.now(), d = new RealDate(n); return RealDate.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 4, 0, 0) - n; })();
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
  window.open = () => null;
  document.addEventListener('click', (e) => { const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]'); if (a) e.preventDefault(); }, true);
  const km = (a, b) => { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dg = (b.lng - a.lng) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const realFetch = window.fetch.bind(window);
  window.__tt = []; window.__ttMode = 200; window.__other = 0;
  window.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('api.tomtom.com')) {
      const b = JSON.parse(init.body);
      window.__tt.push({ o: b.origins.length, d: b.destinations.length, at: Date.now(), mode: window.__ttMode });
      if (window.__ttMode !== 200) return new Response(JSON.stringify({ detailedError: { code: 'Forbidden', message: 'You do not have enough credits to perform this action' } }), { status: window.__ttMode, headers: { 'Content-Type': 'application/json' } });
      const data = [];
      b.origins.forEach((o, i) => b.destinations.forEach((d, j) => {
        const k = km({ lat: o.point.latitude, lng: o.point.longitude }, { lat: d.point.latitude, lng: d.point.longitude });
        data.push({ originIndex: i, destinationIndex: j, routeSummary: { travelTimeInSeconds: Math.round(k * 1.3 / 40 * 3600), lengthInMeters: Math.round(k * 1300) } });
      }));
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
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
    const waitFor = async (expr, what, ms) => { const end = Date.now() + (ms || 8000); while (Date.now() < end) { if (await ev('!!(' + expr + ')')) return true; await sleep(100); } throw new Error('timeout waiting for ' + what); };
    const click = (sel) => ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) throw new Error("no " + ' + JSON.stringify(sel) + '); e.click(); return true; })()');
    const ttCount = () => ev('window.__tt.length');
    const tab = (name) => click('#tabs button[data-tab="' + name + '"]');
    const plan = async () => {
      await tab('plan');
      await waitFor('document.querySelector("#planBtn") && !WaypointDebug.S.busy', 'the Plan tab');
      await ev('WaypointDebug.S.planDone = false');
      await click('#planBtn');
      await waitFor('!WaypointDebug.S.busy && WaypointDebug.S.tab === "route" && document.querySelectorAll(".timeline .card.stop").length === 4', 'the planned route', 10000);
      await sleep(400); // the PLAN-triggered live re-time (one 1 x 1 request) settles
      await waitFor('!WaypointDebug.S.loc.busy', 'the live re-time after PLAN');
    };
    const bodyText = () => ev('document.body.innerText');
    const counted = async (what) => { const c = await ev('(() => { const t = window.__tt, u = WaypointDebug.S.settings.tomtomUsage || {}; return { mock: t.length, cells: t.reduce((a, x) => a + x.o * x.d, 0), r: u.requests || 0, c: u.cells || 0 }; })()');
      check(c.mock === c.r && c.cells === c.c, what + ': the device counter matches what the mock received', c); };

    console.log('1. PLAN with 4 stops');
    await send('Page.navigate', { url: appUrl });
    await waitFor('document.querySelector("#planBtn")', 'the Plan tab');
    await plan();
    const afterPlan = await ev('window.__tt.map((c) => c.o + "x" + c.d)');
    check(afterPlan.filter((c) => c === '6x6').length === 3, 'PLAN: 3 matrix requests of 6 x 6 (start + 4 stops + end)', afterPlan);
    check(afterPlan.filter((c) => c === '1x1').length <= 1 && afterPlan.length <= 4, 'PLAN: plus at most one 1 x 1 live re-time', afterPlan);
    await waitFor('Object.keys(window.__watches).length === 1', 'the GPS watch to start');
    await counted('after PLAN');

    console.log('2. 60 watch updates over a mocked 10 minutes (page visible), the minute timer once per mocked minute');
    let fromUpdates = 0, fromTicks = 0;
    const tickCalls = [];
    const pos = Object.assign({}, GPS0);
    for (let u = 1; u <= 60; u++) {
      await ev('window.__off += 10000');
      pos.lng -= 0.004; // ~445 m per update: always "moved"
      const n0 = await ttCount();
      await ev('(() => { window.__gps = ' + JSON.stringify(pos) + '; return window.__watchFire(' + JSON.stringify(pos) + '); })()');
      await sleep(30);
      fromUpdates += (await ttCount()) - n0;
      if (u % 6 === 0) { // one mocked minute
        const n1 = await ttCount();
        await ev('WaypointDebug.minuteTick()');
        await sleep(150);
        await waitFor('!WaypointDebug.S.loc.busy', 'the tick to settle');
        const got = await ev('window.__tt.slice(' + n1 + ').map((c) => c.o + "x" + c.d)');
        fromTicks += got.length; tickCalls.push(...got);
      }
    }
    check(fromUpdates === 0, 'TomTom received 0 calls from the 60 watch updates', fromUpdates);
    check(fromTicks <= 1 && tickCalls.every((c) => c === '1x1'), 'at most 1 periodic re-time in 10 minutes, each 1 x 1', tickCalls);
    check(fromTicks === 1, 'the 10-minute periodic re-time ran once', tickCalls);
    await counted('after the watch updates');
    check(/^Times from your location, /.test(await ev('document.getElementById("timesFrom").textContent')), 'the status line still reads "Times from your location" (counting down from the last TomTom time)', await ev('document.getElementById("timesFrom").textContent'));

    console.log('3. TomTom answers 403 (not enough credits): PLAN still gives a route, estimated');
    await ev('(() => { window.__ttMode = 403; window.__gps = { lat: 3.01, lng: 101.40, accuracy: 15 }; return true; })()'); // a new start: its pairs are not cached
    await plan();
    const t403 = await bodyText();
    const notices = await ev('[...document.querySelectorAll("#ttNotice")].map((e) => e.textContent)');
    check(notices.length === 1 && notices[0] === 'TomTom limit reached or unavailable - using estimated times until it resets (08:00)', 'ONE friendly notice', notices);
    check(!/HTTP\s*\d|403|credits/i.test(t403) && !/HTTP/.test(await ev('document.getElementById("banner").textContent')), 'no raw "HTTP 403" text anywhere on the page', t403.match(/.{0,40}(HTTP|403|credits).{0,40}/i));
    check(await ev('document.querySelectorAll(".timeline .card.stop").length') === 4, 'a 4-stop route is produced');
    check(await ev('(document.getElementById("estHeader") || {}).textContent') === 'Estimated times', 'the Route header shows "Estimated times"');
    const marks = await ev('[...document.querySelectorAll(".timeline .card.stop .stop-head .times")].map((e) => e.textContent)');
    check(marks.length === 4 && marks.every((t) => / est\.$/.test(t)), 'every stop ETA is marked "est."', marks);
    check(/ est\.$/.test(await ev('document.getElementById("endArrive").textContent')), 'the end arrival is marked "est."');
    check(await ev('WaypointDebug.S.plan.provider.estimated === true'), 'the plan is flagged estimated');
    await counted('after the 403 PLAN');
    const ord = await ev('WaypointDebug.S.plan.result.plans[0].stops.map((s) => s.placeId)');
    check(ord.indexOf('pB') < ord.indexOf('pC') && ord.indexOf('pB') < ord.indexOf('pD'), 'ordering rules unchanged: the urgent delivery before every non-urgent delivery', ord);
    await tab('plan');
    check(await ev('document.querySelectorAll("#ttNotice").length') === 1, 'the Plan tab shows the same single notice');
    await tab('route');

    console.log('4. TomTom recovers: the next PLAN clears the notice and the est. marks');
    await ev('window.__ttMode = 200');
    await plan();
    check(await ev('document.querySelectorAll("#ttNotice").length') === 0, 'the notice is gone');
    check(await ev('!document.getElementById("estHeader")'), 'no "Estimated times" in the header');
    const marks2 = await ev('[...document.querySelectorAll(".timeline .card.stop .times")].map((e) => e.textContent)');
    check(marks2.every((t) => !/est\./.test(t)) && !/est\./.test(await ev('document.getElementById("endArrive").textContent')), 'no ETA is marked "est."', marks2);
    check(await ev('WaypointDebug.S.plan.provider.estimated === false'), 'the plan is no longer flagged estimated');

    console.log('5. Settings shows the counter with what the mock received');
    const got = await ev('(() => { const t = window.__tt; return { r: t.length, c: t.reduce((a, x) => a + x.o * x.d, 0) }; })()');
    await tab('settings');
    await waitFor('document.getElementById("ttUsage")', 'the Settings counter');
    const line = await ev('document.getElementById("ttUsage").textContent');
    const fmtN = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    check(line === 'TomTom today: ' + fmtN(got.r) + ' requests / ' + fmtN(got.c) + ' cells (free limit 2,500 per day, resets 08:00 Malaysia time)', 'Settings: "TomTom today: ' + got.r + ' requests / ' + got.c + ' cells ..."', line);
    check(await ev('document.getElementById("ttUsage").closest(".card").textContent.includes("Google Places calls today")'), 'next to the Places counter');
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
