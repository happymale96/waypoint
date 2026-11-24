#!/usr/bin/env node
/* Mocked browser smoke for the driver's lunch break (no screenshots, no network, no real keys).
 *   node tools/smoke-lunch.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol, and mocks
 * TomTom, geolocation (location permission "denied": no live origin, no watch, so the times are the plan's own), page
 * visibility and the clock (persisted across a reload) inside the page. Seeds a 4-stop plan at 11:00, then:
 *   run 1: the assumed break (+1 h after the first departure at or after 12:15, compared with the setting off), the bar at
 *          12:16, Start ("Lunch until …", later ETAs = now + remaining, survives a reload), End break after 40 min (bar
 *          gone, re-timed from now), a stop done after it, End day summary "Lunch 40 min";
 *   run 2: Skip today (the hour is gone, "Lunch skipped · Undo"), Undo.
 * The server and the browser are always shut down. Exit 1 on failure. Needs Node 22+ and Chrome or Edge (CHROME=<path>).
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

// ---------- the world: four deliveries on a line north of Home (~15 km apart: ~29 min legs), factory dwell 20 min ----------
const HOME = { lat: 3.0757673, lng: 101.6609445 };
const place = (id, name, k) => ({ id, name, address: name + ' St', lat: HOME.lat + 0.135 * k, lng: HOME.lng, type: 'factory', dwellMin: 20, closedWindows: [] });
const job = (id, pid, n) => ({ id, pickups: [], inHandItem: 'Part ' + n, deliveryPlaceId: pid, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-23T01:0' + n + ':00.000Z' });
const SEED = {
  'waypoint:settings:main': { googleKey: 'test-google', tomtomKey: 'test-tomtom', seeded: true, defaultLang: 'ms', nav: 'waze', driverName: 'Calvin' },
  'waypoint:places:home': { id: 'home', name: 'Home (Bloomsvale)', address: 'Bloomsvale', lat: HOME.lat, lng: HOME.lng, type: 'home', dwellMin: 0, closedWindows: [] },
  'waypoint:places:p1': place('p1', 'One Works', 1), 'waypoint:places:p2': place('p2', 'Two Works', 2),
  'waypoint:places:p3': place('p3', 'Three Works', 3), 'waypoint:places:p4': place('p4', 'Four Works', 4),
  'waypoint:jobs:j1': job('j1', 'p1', 1), 'waypoint:jobs:j2': job('j2', 'p2', 2), 'waypoint:jobs:j3': job('j3', 'p3', 3), 'waypoint:jobs:j4': job('j4', 'p4', 4),
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
  window.__hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return window.__hidden ? 'hidden' : 'visible'; } });
  window.__watchCalls = 0;
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(ok) { setTimeout(() => ok({ coords: { latitude: ${HOME.lat}, longitude: ${HOME.lng}, accuracy: 20 }, timestamp: Date.now() }), 0); },
    watchPosition() { window.__watchCalls++; return 1; }, clearWatch() {},
  } });
  try { navigator.permissions.query = async () => ({ state: 'denied', addEventListener() {} }); } catch (e) { /* ignore */ }
  window.open = () => null;
  document.addEventListener('click', (e) => { const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]'); if (a) e.preventDefault(); }, true);
  const km = (a, b) => { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dg = (b.lng - a.lng) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const realFetch = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('api.tomtom.com')) {
      if (url.includes('/calculateRoute/')) { // the Routing API: one leg per request, coordinates in the path
        const q = [0].concat(url.split('/calculateRoute/')[1].split('/')[0].split(/[,:]/).map(Number));
        const k = km({ lat: +q[1], lng: +q[2] }, { lat: +q[3], lng: +q[4] });
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
    const waitFor = async (expr, what, ms) => { const end = Date.now() + (ms || 8000); while (Date.now() < end) { if (await ev('!!(' + expr + ')')) return true; await sleep(100); } const bn = await ev('(document.getElementById("banner") || {}).textContent || ""').catch(() => ''); throw new Error('timeout waiting for ' + what + (bn ? ' [banner: ' + bn + ']' : '') + (page.logs.length ? ' [page: ' + page.logs.join(' | ') + ']' : '')); };
    const click = (sel) => ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) throw new Error("no " + ' + JSON.stringify(sel) + '); e.click(); return true; })()');
    const text = (sel) => ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); return e ? e.textContent : null; })()');
    const advanceMin = (min) => ev('window.__advance(' + (min * 60000) + ')');
    const visible = () => ev('(() => { document.dispatchEvent(new Event("visibilitychange")); return true; })()');
    const MIN = 60000;
    const hhmm = (ms) => ev('Solver.formatETA(' + ms + ')');
    // the pending stops of the current plan: [{id, arr, dep}]
    const etas = () => ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => !s.status).map((s) => ({ id: s.placeId, arr: s.arriveAt, dep: s.departAt }))');
    // the same plan timed WITHOUT any break, from the app's own moment (the plan's departure, or now)
    const rawEtas = () => ev(`(() => { const S = WaypointDebug.S, p = S.plan.result.plans[0], done = p.stops.map((s, i) => s.status === 'done' ? i : -1).filter((i) => i >= 0);
      const from = done.length ? done[done.length - 1] : -1, at = from < 0 ? Math.max(Date.now(), Date.parse(S.plan.ctx.departAtISO)) : Date.now();
      return Solver.retime(p, from, new Date(at).toISOString()).stops.filter((s) => !s.status).map((s) => ({ id: s.placeId, arr: s.arriveAt, dep: s.departAt })); })()`);
    const planOnRoute = async () => {
      await send('Page.navigate', { url: appUrl });
      await waitFor('document.querySelector("#planBtn")', 'the Plan tab');
      await click('#planBtn');
      await waitFor('window.WaypointDebug && WaypointDebug.S.plan && WaypointDebug.S.tab === "route" && document.querySelectorAll(".timeline .card.stop").length === 4', 'the planned 4-stop route');
    };
    const setLunchOn = async (on) => {
      await click('#tabs button[data-tab="settings"]');
      await waitFor('document.querySelector("#lunchOn")', 'the Lunch break card');
      if (await ev('document.querySelector("#lunchOn").checked') !== on) await click('#lunchOn');
      await click('#tabs button[data-tab="route"]');
      await waitFor('document.querySelector(".timeline .card.stop")', 'the Route tab');
    };

    console.log('RUN 1');
    console.log('1. plan at 11:00, the assumed break');
    await planOnRoute();
    check(await hhmm(await ev('Date.now()')) === '11:00', 'the clock reads 11:00', await hhmm(await ev('Date.now()')));
    check(await ev('WaypointDebug.S.settings.lunchBreakOn === true && WaypointDebug.S.settings.lunchBreakFrom === "12:15" && WaypointDebug.S.settings.lunchBreakMin === 60'), 'defaults: on, from 12:15, 60 min');
    const on = await etas();
    check(on.length === 4, '4 pending stops', on.length);
    check(await ev('!document.querySelector("#lunchBar")'), '11:00: no lunch bar yet');
    check(/^Lunch break ~\d\d:\d\d–\d\d:\d\d$/.test(await text('#lunchMarker') || ''), 'the timeline shows where the assumed break sits', await text('#lunchMarker'));
    await setLunchOn(false);
    const off = await etas();
    const fromMs = await ev('(() => { const d = new Date(); d.setHours(12, 15, 0, 0); return d.getTime(); })()');
    const t0 = await ev('WaypointDebug.S.plan.result.plans[0].departFromMs');
    const rows = off.map((s, i) => ({ id: s.id, prevDep: i ? off[i - 1].dep : t0, diffMin: Math.round((on[i].arr - s.arr) / MIN) }));
    const firstAfter = rows.findIndex((r) => r.prevDep >= fromMs);
    check(firstAfter > 0 && firstAfter < 4, 'the seed puts the first departure at or after 12:15 mid-route (before stop ' + (firstAfter + 1) + ')', rows);
    check(rows.every((r, i) => (i >= firstAfter ? r.diffMin === 60 : r.diffMin === 0)), 'stops after the first departure >= 12:15 are exactly 1 h later than with the setting off; earlier ones unchanged', rows);
    check(await ev('!document.querySelector("#lunchMarker")'), 'setting off: no break in the timeline');
    await setLunchOn(true);
    check(Math.abs((await etas())[3].arr - on[3].arr) < 5000, 'setting back on: the hour is back');

    console.log('2. 12:16: the bar');
    await advanceMin(76);
    await visible();
    await waitFor('document.querySelector("#lunchBar")', 'the lunch bar');
    check(await hhmm(await ev('Date.now()')) === '12:16', 'the clock reads 12:16');
    check(await text('#lunchStart') === 'Start lunch break (1 h)' && await text('#lunchSkip') === 'Skip today', 'bar: "Start lunch break (1 h)" and "Skip today"', [await text('#lunchStart'), await text('#lunchSkip')]);
    const geom = await ev('(() => { const b = document.querySelector("#lunchBar").getBoundingClientRect(), c = document.querySelector(".timeline .card.stop").getBoundingClientRect(); return { bb: b.bottom, ct: c.top, h: b.height, modal: !!document.querySelector(".backdrop") }; })()');
    check(geom.bb <= geom.ct && geom.h < 60 && !geom.modal, 'a slim bar above the stop list, not over a card, not a modal', geom);

    console.log('3. Start: the real break');
    await click('#lunchStart');
    await waitFor('document.querySelector("#lunchBar.active")', 'the active bar');
    const now1 = await ev('Date.now()'), until = now1 + 60 * MIN;
    const untilTxt = await hhmm(until);
    check(new RegExp('^Lunch until ' + untilTxt + ' · End break$').test(await text('#lunchBar')), 'bar: "Lunch until ' + untilTxt + ' · End break"', await text('#lunchBar'));
    check(await text('#timesFrom') === 'Lunch break until ' + untilTxt, 'status line: "Lunch break until ' + untilTxt + '"', await text('#timesFrom'));
    let cur = await etas(), raw = await rawEtas();
    check(cur.every((s, i) => Math.abs(s.arr - (raw[i].arr + (until - now1))) < 3000), 'later ETAs = now + remaining break (60 min) + the drive', cur.map((s, i) => Math.round((s.arr - raw[i].arr) / MIN)));
    check(await ev('!!Object.values(WaypointDebug.S.days)[0].breakStartedAt'), 'the day log has breakStartedAt');
    await advanceMin(10);
    await visible();
    await sleep(200);
    const now2 = await ev('Date.now()');
    cur = await etas(); raw = await rawEtas();
    check(cur.every((s, i) => Math.abs(s.arr - (raw[i].arr + (until - now2))) < 3000) && Math.round((until - now2) / MIN) === 50, '10 min in: ETAs = now + 50 min remaining + the drive', cur.map((s, i) => Math.round((s.arr - raw[i].arr) / MIN)));
    await send('Page.reload');
    await waitFor('window.WaypointDebug && WaypointDebug.S.plan && document.querySelector(".timeline .card.stop")', 'the reloaded Route tab');
    await waitFor('document.querySelector("#lunchBar.active")', 'the active bar after the reload');
    check(new RegExp('^Lunch until ' + untilTxt).test(await text('#lunchBar')), 'the break survives a reload', await text('#lunchBar'));

    console.log('4. End break after 40 min');
    await advanceMin(30);
    await click('#lunchEnd');
    await waitFor('!document.querySelector("#lunchBar")', 'the bar to go');
    cur = await etas(); raw = await rawEtas();
    check(cur.every((s, i) => Math.abs(s.arr - raw[i].arr) < 3000), 'ETAs re-timed from now (no break left)', cur.map((s, i) => Math.round((s.arr - raw[i].arr) / MIN)));
    check(!/Lunch/.test(await text('#timesFrom')) && await ev('!document.querySelector("#lunchSkipped")'), 'status line back to normal; no skipped line');
    const d1 = await ev('(() => { const d = Object.values(WaypointDebug.S.days)[0]; return { s: Date.parse(d.breakStartedAt), e: Date.parse(d.breakEndedAt) }; })()');
    check(Math.round((d1.e - d1.s) / MIN) === 40, 'the day log has the real break: 40 min', d1);
    await advanceMin(60);
    await visible();
    check(await ev('!document.querySelector("#lunchBar")'), 'one break a day: no bar later');

    console.log('5. a stop done after the break, End day');
    await advanceMin(-30); // back to 13:26 (stop 1 reached after the break)
    const first = '[...document.querySelectorAll(".timeline .card.stop")].find((c) => !c.classList.contains("done")).querySelector(".stop-btns button.ok")';
    await ev(first + '.click()');
    await waitFor('WaypointDebug.S.plan.result.plans[0].stops[0].reachedAt', 'stop 1 reached');
    await advanceMin(20);
    await ev(first + '.click()');
    await waitFor('WaypointDebug.S.plan.result.plans[0].stops[0].status === "done"', 'stop 1 done');
    await click('#routeEndDay');
    await waitFor('document.querySelector("#sumSplitLine")', 'the summary split line');
    const sl = await text('#sumSplitLine');
    check(/^Driving .+ · On site .+ · Between stops .+ · Lunch 40 min( \(part estimated\))?$/.test(sl), 'End day summary: "… · Lunch 40 min"', sl);

    console.log('RUN 2 (separate): Skip today');
    await send('Page.navigate', { url: 'about:blank' }); // leave the app first (nothing can save behind our back), then wipe its storage
    await sleep(300);
    await send('Storage.clearDataForOrigin', { origin: new URL(appUrl).origin, storageTypes: 'local_storage,session_storage' });
    await planOnRoute();
    check(await hhmm(await ev('Date.now()')) === '11:00', 'a fresh day at 11:00');
    await advanceMin(76);
    await visible();
    await waitFor('document.querySelector("#lunchSkip")', 'the lunch bar');
    const before = await etas();
    await click('#lunchSkip');
    await waitFor('!document.querySelector("#lunchBar")', 'the bar to go');
    const after = await etas();
    check(after.every((s, i) => Math.abs((before[i].arr - s.arr) - 60 * MIN) < 5000), 'Skip today: every ETA loses the hour', after.map((s, i) => Math.round((before[i].arr - s.arr) / MIN)));
    check((await text('#lunchSkipped') || '').replace(/\s+/g, ' ').trim() === 'Lunch skipped · Undo', 'the Route header shows "Lunch skipped · Undo"', await text('#lunchSkipped'));
    check(await ev('!!document.querySelector("#routeTotals").closest(".card").querySelector("#lunchSkipped")'), 'it sits in the Route header card');
    check(await ev('(() => { const d = Object.values(WaypointDebug.S.days)[0]; return !d.breakStartedAt; })()'), 'a skipped (never started) break is not logged');
    await click('#lunchUndoSkip');
    await waitFor('document.querySelector("#lunchStart")', 'the bar to come back');
    check((await etas()).every((s, i) => Math.abs(s.arr - before[i].arr) < 5000), 'Undo: the assumed hour is back');
    check(await ev('window.__watchCalls') === 0, 'location permission denied: no GPS watch was started');

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
