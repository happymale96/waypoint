#!/usr/bin/env node
/* Mocked browser smoke for "Reached before Done" (no screenshots, no network, no real keys).
 *   node tools/smoke-reached.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol, and mocks
 * TomTom, geolocation (position, accuracy and time), page visibility, window.open / the clipboard and the clock inside the
 * page. Seeds a 3-stop plan, then walks: one REACHED button, auto-reach from a GPS-watch update 80 m away (no reload), Undo
 * (no re-stamp), page hidden -> clearWatch / visible -> one fresh fix and exactly one watch, the 500 ms double-tap guard,
 * REACHED -> DONE with a re-time, the navigation tap on stop 2 (navStartedAt in the plan and the day log), the setting off,
 * the double-tap on leaving (estimated split), the watch cleared with nothing pending, and the End day summary (Driving /
 * On site / Between stops), then a second world: the DIVERT day driven through the UI (nav tap for one stop, a replan, nav tap for the
 * other, Reached + Done there, then the first stop), End day at a 360 px viewport: per-stop lines and totals follow the day timeline, no
 * "null" / "undefined", no "Plan vs actual", a "Replans: N" line, stop names at least 60% of the card. The server and the browser
 * are always shut down. Exit 1 on failure.
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

// ---------- the world seeded into the page: three errands / deliveries, no WhatsApp numbers ----------
const SEED = {
  'waypoint:settings:main': { googleKey: 'test-google', tomtomKey: 'test-tomtom', seeded: true, defaultLang: 'ms', nav: 'waze', driverName: 'Calvin' },
  'waypoint:places:home': { id: 'home', name: 'Home (Bloomsvale)', address: 'Bloomsvale', lat: 3.0757673, lng: 101.6609445, type: 'home', dwellMin: 0, closedWindows: [] },
  'waypoint:places:pA': { id: 'pA', name: 'Alpha Bank', address: 'A St', lat: 3.10, lng: 101.66, type: 'other', dwellMin: 10, closedWindows: [] },
  'waypoint:places:pB': { id: 'pB', name: 'Beta Customer', address: 'B St', lat: 3.125, lng: 101.705, type: 'factory', dwellMin: 15, closedWindows: [] },
  'waypoint:places:pC': { id: 'pC', name: 'Gamma Works', address: 'C St', lat: 3.17, lng: 101.62, type: 'factory', dwellMin: 15, closedWindows: [] },
  'waypoint:jobs:j1': { id: 'j1', pickups: [], inHandItem: 'Urgent part', deliveryPlaceId: 'pB', notes: '', urgent: true, urgentRank: 1, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-23T01:00:00.000Z' },
  'waypoint:jobs:j2': { id: 'j2', pickups: [], inHandItem: 'Spare', deliveryPlaceId: 'pC', notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-23T01:01:00.000Z' },
  'waypoint:jobs:j3': { id: 'j3', pickups: [], deliveryPlaceId: null, errandPlaceId: 'pA', dwellMin: 10, notes: 'Pay bill', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-23T01:02:00.000Z' },
};
const GPS_FAR = { lat: 3.07, lng: 101.65, accuracy: 20 };

// runs in the page before anything else: mocks + seed
const INIT = `(() => {
  const RealDate = Date;
  window.__off = 0;
  window.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + window.__off); else super(...a); }
    static now() { return RealDate.now() + window.__off; }
  };
  try { delete Navigator.prototype.serviceWorker; } catch (e) { /* ignore */ }
  window.__hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return window.__hidden ? 'hidden' : 'visible'; } });
  window.__gps = ${JSON.stringify(GPS_FAR)};
  // getCurrentPosition answers with window.__gps; watchPosition only delivers what the smoke fires (window.__watchFire)
  window.__gcp = []; window.__watches = {}; window.__watchSeq = 0; window.__watchCalls = 0; window.__clearCalls = 0;
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(ok, err, opts) { window.__gcp.push(Object.assign({ t: Date.now() }, opts || {})); setTimeout(() => ok({ coords: { latitude: window.__gps.lat, longitude: window.__gps.lng, accuracy: window.__gps.accuracy }, timestamp: Date.now() }), 0); },
    watchPosition(ok, err, opts) { const id = ++window.__watchSeq; window.__watchCalls++; window.__watches[id] = { ok, err, opts: opts || {} }; return id; },
    clearWatch(id) { window.__clearCalls++; delete window.__watches[id]; },
  } });
  window.__watchFire = (p) => { const ws = Object.values(window.__watches); ws.forEach((w) => w.ok({ coords: { latitude: p.lat, longitude: p.lng, accuracy: p.accuracy }, timestamp: Date.now() })); return ws.length; };
  // navigation links (WAZE / MAPS) never leave the page; the app's own click handler still runs
  window.__navClicks = 0;
  document.addEventListener('click', (e) => { const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]'); if (a) { e.preventDefault(); window.__navClicks++; } }, true);
  try { navigator.permissions.query = async () => ({ state: 'granted', addEventListener() {} }); } catch (e) { /* ignore */ }
  window.__opened = 0; window.__copied = 0;
  window.open = () => { window.__opened++; return null; };
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied++; window.__copiedText = t; } } }); } catch (e) { /* ignore */ }
  const km = (a, b) => { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dg = (b.lng - a.lng) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const realFetch = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('api.tomtom.com')) {
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
      const seed = ${JSON.stringify(SEED)};
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
    const waitFor = async (expr, what, ms) => { const end = Date.now() + (ms || 8000); while (Date.now() < end) { if (await ev('!!(' + expr + ')')) return true; await sleep(100); } throw new Error('timeout waiting for ' + what); };
    const click = (sel) => ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) throw new Error("no " + ' + JSON.stringify(sel) + '); e.click(); return true; })()');
    const text = (sel) => ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); return e ? e.textContent : null; })()');
    const advanceMin = (min) => ev('window.__off += ' + (min * 60000));
    const advanceMs = (ms) => ev('window.__off += ' + ms);
    // the n-th (0-based) stop card on the Route tab, its primary button, and the plan stop behind it
    const card = (n) => 'document.querySelectorAll(".timeline .card.stop")[' + n + ']';
    const primaries = (n) => ev('[...' + card(n) + '.querySelectorAll(".stop-btns button.ok")].map((b) => b.textContent)');
    const clickPrimary = (n) => ev('(() => { const b = ' + card(n) + '.querySelector(".stop-btns button.ok"); b.click(); return b.textContent; })()');
    const planStop = (id) => 'WaypointDebug.S.plan.result.plans[0].stops.find((s) => s.placeId === ' + JSON.stringify(id) + ')';
    const gpsNear = (pid, m) => ev('(() => { const p = WaypointDebug.S.places[' + JSON.stringify(pid) + ']; window.__gps = { lat: p.lat + ' + m + ' / 111190, lng: p.lng, accuracy: 20 }; return true; })()');
    const visible = () => ev('document.dispatchEvent(new Event("visibilitychange"))');

    console.log('load + plan');
    await send('Page.navigate', { url: appUrl });
    await waitFor('document.querySelector("#planBtn")', 'the Plan tab');
    await click('#planBtn');
    await waitFor('window.WaypointDebug && WaypointDebug.S.plan && WaypointDebug.S.tab === "route" && document.querySelector(".timeline .card.stop")', 'the planned route');
    const ids = await ev('WaypointDebug.S.plan.result.plans[0].stops.map((s) => s.placeId)');
    check(ids.length === 3, 'a 3-stop plan is on the Route tab', ids);
    check(await ev('document.querySelectorAll(".timeline .card.stop").length') === 3, 'three stop cards');

    console.log('1. one primary button per stop');
    for (let n = 0; n < 3; n++) {
      const p = await primaries(n);
      check(p.length === 1 && p[0] === 'REACHED', 'stop ' + (n + 1) + ': exactly one primary button, reading REACHED', p);
    }
    check(await ev('![...' + card(0) + '.querySelectorAll("button")].some((b) => b.textContent === "DONE")'), 'stop 1 has no DONE button', await ev('[...' + card(0) + '.querySelectorAll("button")].map((b) => b.textContent)'));
    check(await ev('[...' + card(0) + '.querySelectorAll(".stop-btns > *")].map((b) => b.textContent).join()') !== '', 'the buttons sit in the usual button row');
    const h0 = await ev(card(0) + '.getBoundingClientRect().height');

    console.log('2. auto-reach from the GPS watch: loaded FAR from stop 1, then (no reload) a watch update 80 m from it');
    await waitFor('Object.keys(window.__watches).length === 1', 'the GPS watch to start');
    const w0 = await ev('(() => { const w = Object.values(window.__watches)[0]; return { n: Object.keys(window.__watches).length, calls: window.__watchCalls, opts: w.opts }; })()');
    check(w0.n === 1 && w0.calls === 1, 'exactly one watchPosition running after load', w0);
    check(w0.opts.enableHighAccuracy === true && w0.opts.maximumAge === 10000 && w0.opts.timeout === 20000, 'watch options: high accuracy, maximumAge 10 s, timeout 20 s', w0.opts);
    check(await ev(planStop(ids[0]) + '.reachedAt == null'), 'loaded far from stop 1: not reached');
    const near1 = await ev('(() => { const p = WaypointDebug.S.places[' + JSON.stringify(ids[0]) + ']; return { lat: p.lat + 80 / 111190, lng: p.lng, accuracy: 20 }; })()');
    const gcpBefore = await ev('window.__gcp.length');
    const fired = await ev('window.__watchFire(' + JSON.stringify(near1) + ')'); // getCurrentPosition still answers FAR: only the watch is near
    check(fired === 1, 'the watch update reached one watch');
    await waitFor(planStop(ids[0]) + '.reachedAt', 'the auto-stamp on stop 1');
    check(await ev('window.__gcp.length') === gcpBefore, 'the stamp came from the watch update (no getCurrentPosition in between)');
    await gpsNear(ids[0], 80);
    const a1 = await ev('(() => { const s = ' + planStop(ids[0]) + '; return { src: s.reachedSource, at: s.reachedAt, line: ' + card(0) + '.querySelector(".reached-line").textContent, btns: [...' + card(0) + '.querySelectorAll(".stop-btns button.ok")].map((b) => b.textContent), toast: document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent, status: document.getElementById("timesFrom").textContent }; })()');
    check(a1.src === 'auto' && /^Reached \d\d:\d\d · auto\s*Undo$/.test(a1.line), 'stop 1 shows "Reached hh:mm · auto" with a small Undo', a1.line);
    check(a1.btns.length === 1 && a1.btns[0] === 'DONE', 'its one primary button now reads DONE', a1.btns);
    check(/^Reached .+ \d\d:\d\d \(auto\) · Undo$/.test(a1.toast), 'toast: "Reached <name> hh:mm (auto) · Undo"', a1.toast);
    check(/^On site at .+ since \d\d:\d\d$/.test(a1.status), 'status line: "On site at <name> since hh:mm"', a1.status);
    check(a1.status.includes('Alpha') || a1.status.includes('Beta') || a1.status.includes('Gamma'), 'the status line names the stop', a1.status);
    const h1 = await ev(card(0) + '.getBoundingClientRect().height');
    check(h1 - h0 < 24, 'card height grows by at most one text line (' + Math.round(h1 - h0) + ' px)', { h0, h1 });
    check(await ev('window.__opened === 0 && window.__copied === 0 && !document.querySelector(".prompt")'), 'REACHED copied / opened no WhatsApp message');
    check(await ev('document.querySelectorAll("#toast button.toast-undo").length') === 1, 'the toast carries its own Undo');

    console.log('3. Undo: back to REACHED, no re-stamp');
    await click('.timeline .card.stop .reached-line .link-undo');
    await waitFor(planStop(ids[0]) + '.reachedAt == null', 'the Reached state to clear');
    await waitFor('"REACHED" === ' + card(0) + '.querySelector(".stop-btns button.ok").textContent', 'the button to read REACHED again');
    check(await ev(planStop(ids[0]) + '.noAutoReach === true && ' + planStop(ids[0]) + '.reachedSource === null'), 'the stop is flagged "no auto-reach" and its source is cleared');
    check(!(await ev('!!' + card(0) + '.querySelector(".reached-line")')), 'the Reached line is gone');
    await sleep(500); // the forced refresh after Undo sees the same fix
    await visible();
    await click('#timesFrom'); // and a forced refresh from the status line
    await sleep(700);
    check(await ev(planStop(ids[0]) + '.reachedAt == null'), 'more GPS updates near stop 1 do NOT re-stamp it');
    check(/^REACHED$/.test(await text('.timeline .card.stop .stop-btns button.ok')), 'the button still reads REACHED');
    await ev('window.__watchFire(' + JSON.stringify(near1) + ')');
    await sleep(300);
    check(await ev(planStop(ids[0]) + '.reachedAt == null'), 'a watch update near stop 1 does NOT re-stamp it either');

    console.log('3b. page hidden -> clearWatch; visible -> one fresh fix and exactly one watch');
    const clr0 = await ev('window.__clearCalls');
    await ev('(() => { window.__hidden = true; document.dispatchEvent(new Event("visibilitychange")); return true; })()');
    await sleep(200);
    const hid = await ev('({ n: Object.keys(window.__watches).length, clr: window.__clearCalls })');
    check(hid.n === 0 && hid.clr === clr0 + 1, 'hidden: clearWatch called, no watch running', hid);
    const gcp0 = await ev('window.__gcp.length'), calls0 = await ev('window.__watchCalls');
    await ev('(() => { window.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); return true; })()');
    await waitFor('Object.keys(window.__watches).length === 1', 'the watch to restart');
    await sleep(400);
    const vis = await ev('({ n: Object.keys(window.__watches).length, calls: window.__watchCalls, fresh: window.__gcp.slice(' + gcp0 + ').filter((o) => o.maximumAge === 0).length })');
    check(vis.n === 1 && vis.calls === calls0 + 1, 'visible: exactly one watch running (one new watchPosition)', vis);
    check(vis.fresh >= 1, 'visible: a fresh fix was requested (maximumAge 0)', vis);

    console.log('4. tap REACHED, then a second tap 100 ms later (500 ms guard)');
    const guard = await ev(`(async () => { const b = () => ${card(0)}.querySelector(".stop-btns button.ok"); b().click(); await new Promise((r) => setTimeout(r, 100)); const mid = b().textContent; b().click();
      await new Promise((r) => setTimeout(r, 50)); const s = ${planStop(ids[0])}; return { mid, status: s.status || null, src: s.reachedSource, after: b().textContent }; })()`);
    check(guard.mid === 'DONE' && guard.src === 'tap', 'the first tap turned REACHED into DONE (source "tap")', guard);
    check(guard.status === null && guard.after === 'DONE', 'the second tap 100 ms later did not complete the stop', guard);
    check(/^Reached \d\d:\d\d\s*Undo$/.test(await text('.timeline .card.stop .reached-line')), 'a manual tap shows "Reached hh:mm" (no "auto")', await text('.timeline .card.stop .reached-line'));
    await ev('(() => { window.__gps = ' + JSON.stringify(GPS_FAR) + '; return true; })()');
    const eta2Before = await ev(planStop(ids[1]) + '.arriveAt');
    await advanceMin(12);
    await clickPrimary(0); // DONE
    await waitFor(planStop(ids[0]) + '.status === "done"', 'stop 1 to be done');
    const log1 = await ev(`(() => { const S = WaypointDebug.S, d = Object.values(S.days)[0], e = d.events.filter((x) => x.type === "done" && x.stopId === ${JSON.stringify(ids[0])}); const s = ${planStop(ids[0])};
      return { n: e.length, reachedAt: e[0] && e[0].reachedAt, src: e[0] && e[0].reachedSource, t: e[0] && e[0].t, stopReached: s.reachedAt, doneAt: s.doneAt }; })()`);
    check(log1.n >= 1 && typeof log1.reachedAt === 'number' && log1.reachedAt === log1.stopReached && log1.src === 'tap' && log1.t === log1.doneAt, 'the day log has reachedAt (+ source) and doneAt for stop 1', log1);
    check(log1.reachedAt != null && Date.parse(log1.t) - log1.reachedAt >= 11 * 60000, 'doneAt is about 12 minutes after reachedAt');
    const eta2After = await ev(planStop(ids[1]) + '.arriveAt');
    const dwell1 = await ev('WaypointDebug.S.plan.result.plans[0].model.dwellSec[' + JSON.stringify(ids[0]) + '] * 1000');
    check(eta2Before >= log1.reachedAt + dwell1, 'while on site, later stops were timed from reached + planned dwell', { eta2Before, reachedAt: log1.reachedAt, dwell1 });
    check(eta2After !== eta2Before && eta2After > Date.parse(log1.t), 'later ETAs moved: now timed from the DONE time (stop 2 ' + Math.round((eta2After - eta2Before) / 60000) + ' min)', { eta2Before, eta2After });
    check(await ev('window.__opened === 0 && window.__copied === 0'), 'still no WhatsApp message copied or opened (no number seeded)');

    console.log('5. stop 2: tap its navigation button, 20 min, REACHED, 15 min, DONE');
    const stopName2 = await ev('WaypointDebug.S.places[' + JSON.stringify(ids[1]) + '].name');
    await advanceMin(5); // loading up after stop 1
    const stopCardIdx = await ev('[...document.querySelectorAll(".timeline .card.stop")].findIndex((c) => !c.classList.contains("done") && !c.classList.contains("skipped"))');
    check((await primaries(stopCardIdx)).join() === 'REACHED', 'stop 2 (first pending) reads REACHED', await primaries(stopCardIdx));
    const navBtn = (n) => card(n) + '.querySelector(".stop-btns a.nav-btn")';
    check(await ev(navBtn(stopCardIdx) + '.textContent') === 'WAZE', 'stop 2 has its WAZE button (Navigation setting: Waze)');
    const navClicks0 = await ev('window.__navClicks');
    await ev(navBtn(stopCardIdx) + '.click()');
    const navAt = await ev('Date.now()');
    check(await ev('window.__navClicks') === navClicks0 + 1, 'the tap went to the navigation link');
    check(Math.abs(await ev(planStop(ids[1]) + '.navStartedAt') - navAt) < 2000, 'stop 2: navStartedAt = the tap time');
    await advanceMin(1);
    await ev(navBtn(stopCardIdx) + '.click()'); // a second tap does not move it
    check(Math.abs(await ev(planStop(ids[1]) + '.navStartedAt') - navAt) < 2000, 'a second tap keeps the first navStartedAt');
    await ev('document.querySelector("#view a.btn.primary") && document.querySelector("#view a.btn.primary").click()'); // whole-route "Open in Google Maps"
    check(Math.abs(await ev(planStop(ids[2]) + '.navStartedAt || 0') - 0) < 1, 'the whole-route Google Maps button sets no navStartedAt');
    check(await ev('JSON.parse(localStorage.getItem("waypoint:plan:current")).plan.stops.find((s) => s.placeId === ' + JSON.stringify(ids[1]) + ').navStartedAt') === await ev(planStop(ids[1]) + '.navStartedAt'), 'navStartedAt is persisted with the plan');
    await advanceMin(19); // 20 min after the tap
    await clickPrimary(stopCardIdx);
    await waitFor(planStop(ids[1]) + '.reachedAt', 'stop 2 to be reached');
    await ev(navBtn(stopCardIdx) + '.click()'); // a tap after Reached is ignored for timing
    check(Math.abs(await ev(planStop(ids[1]) + '.navStartedAt') - navAt) < 2000, 'a tap after Reached changes nothing');
    await advanceMin(15);
    await clickPrimary(stopCardIdx);
    await waitFor(planStop(ids[1]) + '.status === "done"', 'stop 2 to be done');
    const nav2 = await ev(`(() => { const S = WaypointDebug.S, d = Object.values(S.days)[0], e = d.events.filter((x) => x.type === "done" && x.stopId === ${JSON.stringify(ids[1])});
      const sp = Reached.splitOfSummary(DayLog.summarise(d, S.jobs, S.places), Date.now()), r = sp.stops.find((x) => x.stopId === ${JSON.stringify(ids[1])});
      return { nav: e[0] && e[0].navStartedAt, v: sp.v, between: r.betweenMin, drive: r.driveMin, onSite: r.onSiteMin, est: r.splitEstimated }; })()`);
    check(nav2.nav != null && Math.abs(nav2.nav - navAt) < 2000, 'the day log has navStartedAt for stop 2', nav2);
    const navEv = await ev(`(() => { const d = Object.values(WaypointDebug.S.days)[0]; return { all: d.events.filter((x) => x.type === 'nav').map((x) => x.stopId), v: d.timeSplitV }; })()`);
    check(navEv.v === 3 && navEv.all.length === 3 && navEv.all.every((x) => x === ids[1]), 'the day log records EVERY tap on stop 2 as a nav event (3 taps), and none for the whole-route button', navEv);
    check(nav2.v === 2 && Math.abs(nav2.drive - 20) < 0.1 && Math.abs(nav2.onSite - 15) < 0.1 && Math.abs(nav2.between - 5) < 0.1 && nav2.est === false,
      'stop 2 split: between 5 min, driving 20 min, on site 15 min, not estimated', nav2);

    console.log('6. setting off, GPS near stop 3');
    await advanceMin(25); // the drive to stop 3
    await click('#tabs button[data-tab="settings"]');
    await waitFor('document.querySelector("#autoReach")', 'the Reached card in Settings');
    check((await text('#reachedCard label')).trim() === "Mark Reached automatically when I'm within 150 m (app open)", 'the checkbox label', await text('#reachedCard label'));
    check(await ev('document.querySelector("#autoReach").checked === true'), 'the setting is ON by default');
    await click('#autoReach');
    check(await ev('WaypointDebug.S.settings.autoReach === false && JSON.parse(localStorage.getItem("waypoint:settings:main")).autoReach === false'), 'turned off and stored on the device');
    await click('#tabs button[data-tab="route"]');
    await waitFor('document.querySelector(".timeline .card.stop")', 'the Route tab');
    await gpsNear(ids[2], 80);
    await visible();
    await click('#timesFrom');
    await sleep(800);
    check(await ev(planStop(ids[2]) + '.reachedAt == null') && (await primaries(await ev('[...document.querySelectorAll(".timeline .card.stop")].findIndex((c) => !c.classList.contains("done"))'))).join() === 'REACHED', 'setting off: no auto-stamp on stop 3');
    await click('#tabs button[data-tab="settings"]');
    await waitFor('document.querySelector("#autoReach")', 'Settings');
    await click('#autoReach'); // control: switched back on, the same GPS position stamps it
    await click('#tabs button[data-tab="route"]');
    await waitFor('document.querySelector(".timeline .card.stop")', 'the Route tab');
    await visible();
    await waitFor(planStop(ids[2]) + '.reachedAt', 'the control auto-stamp with the setting back on');
    check(await ev(planStop(ids[2]) + '.reachedSource === "auto"'), 'control: with the setting back on, the same position does stamp stop 3');
    console.log('6b. stop 3: DONE 2 s after Reached (double-tap on leaving)');
    await advanceMs(2000);
    const idx3 = await ev('[...document.querySelectorAll(".timeline .card.stop")].findIndex((c) => !c.classList.contains("done"))');
    await clickPrimary(idx3);
    await waitFor(planStop(ids[2]) + '.status === "done"', 'stop 3 to be done');
    const split = await ev(`(() => { const S = WaypointDebug.S, d = Object.values(S.days)[0], sum = DayLog.summarise(d, S.jobs, S.places), sp = Reached.splitOfSummary(sum, Date.now());
      const v = sum.visits.find((x) => x.stopId === ${JSON.stringify(ids[2])}), r = sp.stops.find((x) => x.stopId === ${JSON.stringify(ids[2])});
      return { est: r.estimated, onSite: r.onSiteMin, dwell: v.dwellMin, gapMs: v.doneAt - v.reachedAt, any: sp.totals.anySplitEstimated }; })()`);
    check(split.gapMs >= 1500 && split.gapMs < 10000, 'stop 3: Reached and Done were about 2 s apart', split);
    check(split.est === true && split.any === true, 'stop 3: its arrival is flagged estimated', split);
    check(split.dwell > 0 && Math.abs(split.onSite - split.dwell) < 0.01, 'stop 3: on-site time is the planned dwell (' + split.dwell + ' min), not ~0', split);
    await waitFor('Object.keys(window.__watches).length === 0', 'the watch to stop (no pending stop left)');
    check(await ev('Object.keys(window.__watches).length') === 0, 'every stop done: the GPS watch is cleared');

    console.log('7. End day summary');
    await click('#routeEndDay');
    await waitFor('document.querySelector("#sumSplitLine")', 'the Driving / On site / Between stops line');
    const sumLine = await text('#sumSplitLine');
    const D = '(\\d+ h \\d\\d min|\\d+ min)';
    check(new RegExp('^Driving ' + D + ' · On site ' + D + ' · Between stops ' + D + ' \\(part estimated\\)$').test(sumLine), 'summary: "Driving … · On site … · Between stops … (part estimated)"', sumLine);
    const rows = await ev('[...document.querySelectorAll("#sumSplit .ts-stop")].map((r) => r.querySelector(".ts-name").textContent + "|" + r.querySelector(".ts-times").textContent)');
    check(rows.length === 3 && rows.every((r) => /\|left prev \d\d:\d\d( · nav \d\d:\d\d)? · arr ~?\d\d:\d\d · done \d\d:\d\d$/.test(r)), 'per stop "left prev · [nav ·] arr · done" (3 rows: name, then times)', rows);
    check(rows.filter((r) => /arr ~/.test(r)).length === 1, 'exactly the double-tapped stop shows its arrival as "~hh:mm"', rows);
    check(!/ · nav /.test(rows[0]) && / · nav /.test(rows.find((r) => r.includes(stopName2)) || ''), 'stop 1 has no nav; stop 2 (navigation tapped) shows "nav hh:mm"', rows);
    const m3 = /left prev (\d\d:\d\d) · nav (\d\d:\d\d)/.exec(rows[2]);
    check(!!m3 && m3[1] === m3[2], 'stop 3: the tap made on site at stop 2 starts the driving at DONE (nav = left prev, between 0)', rows[2]);
    const t1 = await text('.sheet.summary');
    check(!/null|undefined/.test(t1) && !/Plan vs actual/.test(t1), 'summary: no "null" / "undefined" text, no "Plan vs actual"');
    check(await ev('!!document.querySelector(".sheet.summary .tiles")') && /3 of 3/.test(await text('.sheet.summary .tile.jobs')), 'the existing tiles are still there (jobs 3 of 3)', await text('.sheet.summary .tile.jobs'));
    await click('.sheet.summary .sum-actions .row:last-child button:last-child');

    console.log('8. DIVERT through the UI (fresh world, 360 px wide)');
    await send('Page.navigate', { url: 'about:blank' }); // no live page left to write state after the wipe
    await sleep(500);
    await send('Storage.clearDataForOrigin', { origin: new URL(appUrl).origin, storageTypes: 'local_storage' });
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: appUrl });
    await waitFor('document.querySelector("#planBtn")', 'the Plan tab (second world)');
    await click('#planBtn');
    await waitFor('window.WaypointDebug && WaypointDebug.S.plan && WaypointDebug.S.tab === "route" && document.querySelector(".timeline .card.stop")', 'the planned route (second world)');
    const q = await ev('WaypointDebug.S.plan.result.plans[0].stops.map((s) => s.placeId)');
    check(q.length === 3 && Object.keys(await ev('WaypointDebug.S.days')).length === 1, 'a fresh 3-stop plan with one day record', q);
    const cardOf = (id) => ev('WaypointDebug.S.plan.result.plans[0].stops.findIndex((s) => s.placeId === ' + JSON.stringify(id) + ')');
    const navTapOf = async (id) => { const n = await cardOf(id); await ev('(() => { const a = ' + card(n) + '.querySelector(".stop-btns a.nav-btn"); a.click(); return true; })()'); };
    const reachDone = async (id, gapMin) => { // REACHED now, DONE gapMin minutes later
      const n = await cardOf(id);
      await clickPrimary(n); await waitFor(planStop(id) + '.reachedAt', 'Reached on ' + id);
      await advanceMin(gapMin);
      await clickPrimary(n); await waitFor(planStop(id) + '.status === "done"', 'Done on ' + id);
    };
    await advanceMin(20);                                  // +20  the drive to the first stop (no navigation tap: estimated)
    await reachDone(q[0], 15);                             // +20 Reached, +35 Done
    await advanceMin(5);                                   // +40
    const pendNow = await ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => !s.status).map((s) => s.placeId)');
    const X = pendNow[0], Y = pendNow[1];
    await navTapOf(X);                                     // +40  navigation for the next stop
    await advanceMin(5);
    await ev('WaypointDebug.doPlan({ replan: true })');    // +45  a replan: changes nothing in the timeline
    await waitFor('!WaypointDebug.S.busy && document.querySelector(".timeline .card.stop")', 'the replan to finish');
    await sleep(300);
    check(await ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => !s.status).length') === 2, 'after the replan two stops are still pending');
    await advanceMin(15);                                  // +60
    await navTapOf(Y);                                     // +60  the diversion: navigation for the other stop
    await advanceMin(15);                                  // +75
    await reachDone(Y, 15);                                // +75 Reached, +90 Done (the diverted stop is done first)
    await advanceMin(2);                                   // +92
    await navTapOf(X);                                     // +92  now on to the first one
    await advanceMin(18);                                  // +110
    await reachDone(X, 20);                                // +110 Reached, +130 Done
    const nameOf = (id) => ev('WaypointDebug.S.places[' + JSON.stringify(id) + '].name');
    const tlv = await ev(`(() => { const S = WaypointDebug.S, d = Object.values(S.days)[0], sum = DayLog.summarise(d, S.jobs, S.places), sp = Reached.splitOfSummary(sum, Date.now());
      return { v: sp.v, nav: d.events.filter((e) => e.type === 'nav').map((e) => e.stopId), order: sp.stops.map((x) => x.stopId), t: sp.totals,
        per: sp.stops.map((x) => ({ id: x.stopId, b: x.betweenMin, d: x.driveMin, o: x.onSiteMin, est: x.splitEstimated })), replans: sum.plan.replans }; })()`);
    const near2 = (a, b) => Math.abs(a - b) < 0.3;
    check(tlv.v === 2 && tlv.order.join() === [q[0], Y, X].join(), 'arrival order: first stop, the diverted stop, then the first one navigated to', tlv.order);
    const pY = tlv.per.find((x) => x.id === Y), pX = tlv.per.find((x) => x.id === X);
    check(near2(pY.b, 5) && near2(pY.d, 35) && near2(pY.o, 15) && !pY.est, 'diverted stop: between 5, driving 35 (X\'s old tap does not count), on site 15', pY);
    check(near2(pX.b, 2) && near2(pX.d, 18) && near2(pX.o, 20) && !pX.est, 'first stop navigated to: between 2, driving 18, on site 20', pX);
    check(near2(tlv.t.betweenMin, 7) && near2(tlv.t.driveMin, 73) && near2(tlv.t.onSiteMin, 50) && near2(tlv.t.totalMin, 130), 'totals: between 7, driving 73, on site 50, time out 130', tlv.t);
    check(near2(tlv.t.betweenMin + tlv.t.driveMin + tlv.t.onSiteMin + tlv.t.lunchMin, tlv.t.totalMin), 'the four buckets sum to the time out');
    check(tlv.nav.length === 3 && tlv.nav.filter((x) => x === X).length === 2 && tlv.nav.filter((x) => x === Y).length === 1, 'the day log has the three nav taps (X twice, Y once)', tlv.nav);
    await click('#routeEndDay');
    await waitFor('document.querySelector("#sumSplitLine")', 'the End day summary (second world)');
    const T = await text('.sheet.summary');
    check(!/null|undefined/.test(T), 'summary text has no "null" / "undefined"');
    check(!/Plan vs actual/.test(T) && !/Drive \(est/.test(T), 'no "Plan vs actual" section and no older "Drive (est.)" figure');
    check(/^Replans: [1-9]\d*$/.test(await text('#sumReplans') || ''), 'a "Replans: N" line (N > 0)', await text('#sumReplans'));
    check(await ev('document.querySelectorAll("#sumSplitTile .split-legend .lg").length') === 4 && await ev('document.querySelectorAll("#sumSplitTile .split-bar span").length') >= 3, 'the bar shows the four buckets with a legend');
    const R = await ev('[...document.querySelectorAll("#sumSplit .ts-stop")].map((r) => ({ n: r.querySelector(".ts-name").textContent, t: r.querySelector(".ts-times").textContent }))');
    check(R.length === 3, 'three per-stop blocks', R);
    const mins = (t, k) => { const m = new RegExp(k + ' (\\d\\d):(\\d\\d)').exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const dm = (a, b) => ((b - a) % 1440 + 1440) % 1440;
    const within1 = (a, b) => Math.abs(a - b) <= 1;
    const rY = R[1], rX = R[2];
    check(rY.n === await nameOf(Y) && rX.n === await nameOf(X), 'the blocks name the stops in arrival order (diverted stop second)', R.map((r) => r.n));
    check(within1(dm(mins(rY.t, 'left prev'), mins(rY.t, 'nav')), 5) && within1(dm(mins(rY.t, 'nav'), mins(rY.t, 'arr')), 35) && within1(dm(mins(rY.t, 'arr'), mins(rY.t, 'done')), 15), 'diverted stop line: left prev -> nav 5, nav -> arr 35, arr -> done 15', rY.t);
    check(within1(dm(mins(rX.t, 'left prev'), mins(rX.t, 'nav')), 2) && within1(dm(mins(rX.t, 'nav'), mins(rX.t, 'arr')), 18) && within1(dm(mins(rX.t, 'arr'), mins(rX.t, 'done')), 20), 'first stop navigated to: left prev -> nav 2, nav -> arr 18, arr -> done 20', rX.t);
    check(mins(rY.t, 'left prev') === mins(R[0].t, 'done') && mins(rX.t, 'left prev') === mins(rY.t, 'done'), 'each "left prev" is the previous stop\'s done time');
    const sl = await text('#sumSplitLine');
    const dur = (t) => { const m = /^(?:(\d+) h )?(\d+) min$/.exec(t); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null; };
    const ml = /^Driving (.+?) · On site (.+?) · Between stops (.+?)(?: · Lunch (.+?))?(?: \(part estimated\))?$/.exec(sl);
    check(!!ml && within1(dur(ml[1]), 73) && within1(dur(ml[2]), 50) && within1(dur(ml[3]), 7), 'summary line: Driving 1 h 13 min · On site 50 min · Between stops 7 min', sl);
    const widths = await ev('(() => { const c = document.querySelector("#sumSplit").getBoundingClientRect().width; return { vw: window.innerWidth, card: c, names: [...document.querySelectorAll("#sumSplit .ts-name")].map((e) => e.getBoundingClientRect().width / c) }; })()');
    check(widths.vw === 360 && widths.names.length === 3 && widths.names.every((w) => w >= 0.6), 'at 360 px every stop name is at least 60% of the card width', widths);
    await click('.sheet.summary .sum-actions .row:first-child button:first-child'); // Copy summary
    await sleep(200);
    const copied = await ev('window.__copiedText || ""');
    check(/Time split: Driving/.test(copied) && !/null|undefined|Plan vs actual|Drive \(est/.test(copied), 'Copy summary: the time split instead of the old estimate, no "Plan vs actual", no "null"', copied.slice(0, 200));

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
