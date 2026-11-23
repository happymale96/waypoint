#!/usr/bin/env node
/* Mocked browser smoke for "Reached before Done" (no screenshots, no network, no real keys).
 *   node tools/smoke-reached.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol, and mocks
 * TomTom, geolocation (position, accuracy and time), page visibility, window.open / the clipboard and the clock inside the
 * page. Seeds a 3-stop plan, then walks: one REACHED button, auto-reach at 80 m, Undo (no re-stamp), the 500 ms double-tap
 * guard, REACHED -> DONE with a re-time, the double-tap on leaving (estimated split), the setting off, and the End day
 * summary. The server and the browser are always shut down. Exit 1 on failure.
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
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(ok) { setTimeout(() => ok({ coords: { latitude: window.__gps.lat, longitude: window.__gps.lng, accuracy: window.__gps.accuracy }, timestamp: Date.now() }), 0); },
  } });
  try { navigator.permissions.query = async () => ({ state: 'granted', addEventListener() {} }); } catch (e) { /* ignore */ }
  window.__opened = 0; window.__copied = 0;
  window.open = () => { window.__opened++; return null; };
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { window.__copied++; } } }); } catch (e) { /* ignore */ }
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

    console.log('2. auto-reach: GPS 80 m from stop 1, page visible');
    await gpsNear(ids[0], 80);
    await visible();
    await waitFor(planStop(ids[0]) + '.reachedAt', 'the auto-stamp on stop 1');
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

    console.log('5. stop 2: REACHED, 2 s, DONE (double-tap on leaving)');
    await advanceMin(25); // the drive to stop 2
    check((await primaries(1)).join() === 'REACHED', 'stop 2 (first pending) reads REACHED', await primaries(1));
    const stopCardIdx = await ev('[...document.querySelectorAll(".timeline .card.stop")].findIndex((c) => !c.classList.contains("done") && !c.classList.contains("skipped"))');
    await clickPrimary(stopCardIdx);
    await waitFor(planStop(ids[1]) + '.reachedAt', 'stop 2 to be reached');
    await advanceMs(2000);
    await clickPrimary(stopCardIdx);
    await waitFor(planStop(ids[1]) + '.status === "done"', 'stop 2 to be done');
    const split = await ev(`(() => { const S = WaypointDebug.S, d = Object.values(S.days)[0], sum = DayLog.summarise(d, S.jobs, S.places), sp = Reached.splitOfSummary(sum);
      const v = sum.visits.find((x) => x.stopId === ${JSON.stringify(ids[1])}), r = sp.stops.find((x) => x.stopId === ${JSON.stringify(ids[1])});
      return { est: r.estimated, onSite: r.onSiteMin, dwell: v.dwellMin, gapMs: v.doneAt - v.reachedAt, any: sp.totals.anyEstimated }; })()`);
    check(split.gapMs >= 1500 && split.gapMs < 10000, 'stop 2: Reached and Done were about 2 s apart', split);
    check(split.est === true && split.any === true, 'stop 2: its split is flagged estimated', split);
    check(split.dwell > 0 && Math.abs(split.onSite - split.dwell) < 0.01, 'stop 2: on-site time is the planned dwell (' + split.dwell + ' min), not ~0', split);

    console.log('6. setting off, GPS near stop 3');
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
    await advanceMin(10);
    const idx3 = await ev('[...document.querySelectorAll(".timeline .card.stop")].findIndex((c) => !c.classList.contains("done"))');
    await clickPrimary(idx3);
    await waitFor(planStop(ids[2]) + '.status === "done"', 'stop 3 to be done');

    console.log('7. End day summary');
    await click('#routeEndDay');
    await waitFor('document.querySelector("#sumSplitLine")', 'the Driving / On site line');
    const sumLine = await text('#sumSplitLine');
    check(/^Driving (\d+ h \d\d min|\d+ min) · On site (\d+ h \d\d min|\d+ min) \(part estimated\)$/.test(sumLine), 'summary: "Driving … · On site … (part estimated)"', sumLine);
    const rows = await ev('[...document.querySelectorAll("#sumSplit .sum-line")].map((r) => r.textContent)');
    check(rows.length === 3 && rows.every((r) => /arr ~?\d\d:\d\d · left \d\d:\d\d/.test(r)), 'per stop "arr hh:mm · left hh:mm" (3 rows)', rows);
    check(rows.filter((r) => /arr ~/.test(r)).length === 1, 'exactly the double-tapped stop shows its arrival as "~hh:mm"', rows);
    check(await ev('!!document.querySelector(".sheet.summary .tiles")') && /3 of 3/.test(await text('.sheet.summary .tile.jobs')), 'the existing tiles are still there (jobs 3 of 3)', await text('.sheet.summary .tile.jobs'));
    await click('.sheet.summary .sum-actions .row:last-child button:last-child');

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
