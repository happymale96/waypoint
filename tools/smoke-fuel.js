#!/usr/bin/env node
/* Mocked browser smoke for "Add fuel stop" (no screenshots, no network, no real keys).
 *   node tools/smoke-fuel.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol, and mocks
 * Google Places, TomTom, geolocation, navigator.onLine and the clock inside the page. Seeds a 3-stop plan with one urgent
 * delivery, then asserts the fuel-stop flow end to end. The server and the browser are always shut down. Exit 1 on failure.
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

// ---------- the world seeded into the page ----------
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
const GPS = { lat: 3.07, lng: 101.65 };

// runs in the page before anything else: mocks + seed
const INIT = `(() => {
  const RealDate = Date;
  window.__off = 0; window.__online = true;
  window.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + window.__off); else super(...a); }
    static now() { return RealDate.now() + window.__off; }
  };
  Object.defineProperty(Navigator.prototype, 'onLine', { get() { return window.__online !== false; }, configurable: true });
  try { delete Navigator.prototype.serviceWorker; } catch (e) { /* ignore */ }
  const GPS = ${JSON.stringify(GPS)};
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(ok) { setTimeout(() => ok({ coords: { latitude: GPS.lat, longitude: GPS.lng, accuracy: 20 }, timestamp: Date.now() }), 0); },
  } });
  try { navigator.permissions.query = async () => ({ state: 'granted', addEventListener() {} }); } catch (e) { /* ignore */ }
  const km = (a, b) => { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dg = (b.lng - a.lng) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  window.__calls = { places: 0, tomtom: 0 };
  const realFetch = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('places.googleapis.com')) {
      window.__calls.places++;
      const b = JSON.parse(init.body), c = b.locationBias.circle.center, rad = b.locationBias.circle.radius / 1000;
      const out = [];
      for (let gi = Math.floor((c.latitude - 0.05) / 0.02); gi <= Math.ceil((c.latitude + 0.05) / 0.02); gi++) {
        for (let gj = Math.floor((c.longitude - 0.05) / 0.02); gj <= Math.ceil((c.longitude + 0.05) / 0.02); gj++) {
          const loc = { latitude: gi * 0.02 + 0.007, longitude: gj * 0.02 + 0.004 };
          if (km({ lat: loc.latitude, lng: loc.longitude }, { lat: c.latitude, lng: c.longitude }) <= rad) out.push({ id: 'ChIJ' + gi + '_' + gj, displayName: { text: 'Caltex Station ' + gi + '_' + gj }, formattedAddress: 'Jalan ' + gi + ', Selangor', location: loc });
        }
      }
      out.push({ id: 'petron' + Math.round(c.latitude * 1000), displayName: { text: 'Petron Decoy' }, formattedAddress: 'Elsewhere', location: { latitude: c.latitude, longitude: c.longitude } });
      return json({ places: out });
    }
    if (url.includes('api.tomtom.com')) {
      window.__calls.tomtom++;
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
    const calls = () => ev('window.__calls.places');
    const advance = (min) => ev('window.__off += ' + (min * 60000));
    const tap = async () => { await click('#fuelBtn'); await waitFor('document.querySelector("#fuelAdd")', 'the fuel preview'); };
    const cancelSheet = async () => { await click('#fuelCancel'); await waitFor('!document.querySelector(".backdrop")', 'the sheet to close'); };
    const searchedN = async () => Number(/Searched (\d+) points/.exec(await text('#fuelSearched'))[1]);

    console.log('load + plan');
    await send('Page.navigate', { url: appUrl });
    await waitFor('document.querySelector("#planBtn")', 'the Plan tab');
    await click('#planBtn');
    await waitFor('window.WaypointDebug && WaypointDebug.S.plan && WaypointDebug.S.tab === "route" && document.querySelector("#fuelBtn")', 'the planned route');
    const stopIds = await ev('WaypointDebug.S.plan.result.plans[0].stops.map((s) => s.placeId)');
    check(stopIds.length === 3 && stopIds.includes('pB'), 'a 3-stop plan with the urgent delivery (Beta) is on the Route tab', stopIds);
    const before = await ev('(() => { const p = WaypointDebug.S.plan.result.plans[0]; return { end: p.endArrival, jobs: WaypointDebug.S.jobs.map((j) => j.status + ":" + j.id).join() }; })()');
    check((await text('#fuelBtn')) === 'Add fuel stop', 'the button reads "Add fuel stop"');
    check(await ev('document.querySelector("#fuelBtn").parentElement.querySelector("a").textContent') === 'Open in Google Maps', 'it sits in the row with "Open in Google Maps" (there is no "Replan from here" any more)');
    const expected = await ev(`(() => { const S = WaypointDebug.S, plan = S.plan.result.plans[0];
      const pts = [plan.model.start].concat(plan.stops.map((s) => S.places[s.placeId])).concat([S.plan.ctx.end]).map((p) => ({ lat: p.lat, lng: p.lng }));
      return Fuel.samplePoints(pts, 4, 50).length; })()`);
    check(expected >= 3 && expected <= 50, 'the route needs ' + expected + ' sample points (1..50)', expected);

    console.log('1. tap "Add fuel stop"');
    const c0 = await calls();
    await tap();
    const c1 = await calls();
    const searched = await searchedN();
    check(c1 - c0 === expected && searched === expected && c1 - c0 <= 50, 'Places calls (' + (c1 - c0) + ') = the number of sample points (' + expected + '), at most 50', { calls: c1 - c0, searched });
    check(await ev('Budget.placesCount(WaypointDebug.S.settings.usage, Date.now()).today') === c1 && await ev('Budget.placesCount(WaypointDebug.S.settings.usage, Date.now()).month') === c1, 'every call went through the one counter (today and this month)');
    const name1 = await text('#fuelName'), detour1 = await text('#fuelDetour');
    check(/Caltex/.test(name1) && !/Petron/.test(name1), 'the preview offers a Caltex station (the decoy brand is filtered out)', name1);
    check(/^\+\d+ min · between .+ and .+$/.test(detour1), 'the preview shows "+N min · between A and B"', detour1);
    const rem1 = await ev('WaypointDebug.S.fuelStations.length');
    check(/Searched \d+ points · \d+ stations remembered/.test(await text('#fuelSearched')) && rem1 > 0, 'the small line shows points searched and stations remembered (' + rem1 + ')');
    check(!(await ev('!!document.querySelector("#fuelLimited")')) && !(await ev('!!document.querySelector("#fuelNote")')), 'no limited / remembered-only note on a normal search');
    check(await ev('document.querySelectorAll("#fuelAdd,#fuelNext,#fuelCancel").length') === 3, 'Add, Next best and Cancel are there');
    check(await ev('WaypointDebug.S.plan.result.plans[0].stops.some((s) => s.fuel)') === false, 'nothing is added before the tap on Add');
    await click('#fuelNext');
    check((await text('#fuelName')) !== null && (await calls()) === c1, '"Next best" cycles without a new search');
    await click('#fuelNext');
    for (let i = 0; i < 20 && !((await text('#fuelName')) === name1 && (await text('#fuelDetour')) === detour1); i++) await click('#fuelNext'); // cycle back to the best
    check((await text('#fuelName')) === name1 && (await text('#fuelDetour')) === detour1, 'cycling comes back to the best one');
    await click('#fuelAdd');
    await waitFor('document.querySelector(".card.stop.fuel")', 'the fuel stop card');
    const after = await ev(`(() => { const S = WaypointDebug.S, p = S.plan.result.plans[0];
      return { ids: p.stops.map((s) => s.placeId), end: p.endArrival, jobs: S.jobs.map((j) => j.status + ":" + j.id).join(),
        fuel: p.stops.find((s) => s.fuel), dwell: p.model.dwellSec.__fuel__, mem: JSON.parse(localStorage.getItem("waypoint:meta:fuelStations")).list.length, saved: JSON.parse(localStorage.getItem("waypoint:plan:current")).plan.stops.some((s) => s.fuel),
        wa: document.querySelectorAll(".card.stop.fuel button").length }; })()`);
    const fi = after.ids.indexOf('__fuel__');
    check(fi > after.ids.indexOf('pB'), 'the fuel stop is after the urgent stop (index ' + fi + ' vs ' + after.ids.indexOf('pB') + ')', after.ids);
    check(after.ids.filter((x) => x !== '__fuel__').join() === stopIds.join(), 'every other stop keeps its order');
    check(after.end > before.end && after.fuel.arriveAt > 0 && after.fuel.departAt - after.fuel.arriveAt === 7 * 60000 && after.dwell === 420, 'the route is re-timed: later end, fuel dwell 7 min', { end: after.end - before.end });
    check(after.jobs === before.jobs, 'job count unchanged (all 3 jobs still pending)');
    check(after.saved && after.mem === rem1, 'the plan is persisted with the fuel stop; stations are in the station memory (' + after.mem + ')');
    const card = await ev('document.querySelector(".card.stop.fuel").innerText');
    check(/FUEL/.test(card) && /WAZE/.test(card) && /REACHED/.test(card) && !/DONE/.test(card) && /SKIP/.test(card) && /REMOVE/.test(card) && !/MSG/.test(card), 'the fuel card: FUEL tag, name, WAZE, REACHED (then DONE), SKIP, REMOVE and no message button', card.replace(/\n/g, ' | '));
    check((await text('#fuelBtn')) === 'Change fuel stop', 'the button now reads "Change fuel stop"');

    console.log('2. tap "Change fuel stop" at once');
    const c2 = await calls();
    await tap();
    check((await calls()) === c2, '0 new Places calls (the 10-minute reuse)', (await calls()) - c2);
    check(/recent search reused/.test(await text('#fuelSearched')), 'the preview says the recent search was reused');
    await cancelSheet();
    check(await ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => s.fuel).length') === 1, 'Cancel changes nothing');

    console.log('3. 11 minutes later: a fresh search every time');
    await advance(11);
    const c3 = await calls();
    await tap();
    check((await calls()) - c3 === expected, 'Places is searched again for every sample point (' + ((await calls()) - c3) + ' of ' + expected + ')');
    await cancelSheet();

    console.log('4. counter at 139: the daily guard');
    await ev('(() => { WaypointDebug.S.settings.usage = Object.assign({}, WaypointDebug.S.settings.usage, { places: Budget.addCount(null, Date.now(), 139) }); })()');
    await advance(11);
    const c4 = await calls();
    await tap();
    check((await calls()) - c4 === 1, 'exactly 1 Places call', (await calls()) - c4);
    check(/Search limited today \(Places daily guard\) - result may not be the best/.test(await text('#fuelLimited') || ''), 'the "Search limited today" line is shown', await text('#fuelLimited'));
    await cancelSheet();

    console.log('5. offline: remembered stations only');
    await ev('(() => { WaypointDebug.S.settings.usage = Object.assign({}, WaypointDebug.S.settings.usage, { places: Budget.addCount(null, Date.now(), 0) }); window.__online = false; })()'); // counter 0, so only "offline" can explain 0 calls
    await advance(11);
    const c5 = await calls();
    await tap();
    check((await calls()) === c5, '0 Places calls while offline', (await calls()) - c5);
    check(/Using remembered stations only/.test(await text('#fuelNote') || ''), '"Using remembered stations only" is shown');
    check(/Caltex/.test(await text('#fuelName')) && /^\+\d+ min/.test(await text('#fuelDetour')), 'a station is still offered from the memory', await text('#fuelName'));
    await click('#fuelAdd');
    await waitFor('document.querySelector(".card.stop.fuel")', 'the replaced fuel stop');
    check(await ev('WaypointDebug.S.plan.result.plans[0].stops.filter((s) => s.fuel).length') === 1, 'replacing leaves exactly one fuel stop');
    await ev('window.__online = true');

    console.log('6. DONE on the fuel stop: logged as a stop, not a job');
    await click('.card.stop.fuel button.ok'); // REACHED first ...
    await waitFor('/^DONE$/.test(document.querySelector(".card.stop.fuel button.ok").textContent)', 'the fuel button to read DONE');
    await advance(1 / 60); // ... past the 500 ms double-tap guard ...
    await click('.card.stop.fuel button.ok'); // ... then DONE
    await waitFor('document.querySelector(".card.stop.done .title") && /Fuel/.test(document.querySelector(".card.stop.done .title").textContent)', 'the fuel stop to show as done');
    const log = await ev(`(() => { const S = WaypointDebug.S, d = Object.values(S.days)[0], s = DayLog.summarise(d, S.jobs, S.places);
      return { jobs: s.jobsDone + "/" + s.jobsTotal, fuel: s.fuel && s.fuel.place, stops: s.stopsVisited, ev: d.events.filter((e) => e.kind === "fuel").length, prompt: !!document.querySelector(".prompt") }; })()`);
    check(log.jobs === '0/3' && log.stops === 0 && log.ev === 1 && /Caltex/.test(log.fuel), 'the day log has a fuel stop with its done time; job counts stay 0 of 3', log);
    check(!log.prompt, 'no WhatsApp prompt after the fuel DONE');
    check((await text('#fuelBtn')) === null, 'a done fuel stop leaves nothing to add or change');
    const sumLine = await ev(`(() => { WaypointDebug.S.tab = "route"; return DayLog.toWhatsApp(DayLog.summarise(Object.values(WaypointDebug.S.days)[0], WaypointDebug.S.jobs, WaypointDebug.S.places)).split("\\n").find((l) => l.startsWith("Fuel:")); })()`);
    check(/^Fuel: Caltex .+ \d\d:\d\d$/.test(sumLine || ''), 'the day summary has one "Fuel: <station> <time>" line', sumLine);

    console.log('7. Settings: Fuel card');
    await click('#tabs button[data-tab="settings"]');
    await waitFor('document.querySelector("#fuelCard")', 'the Fuel card');
    check((await ev('document.querySelector("#fuelBrand").value')) === 'Caltex' && (await ev('document.querySelector("#fuelDwell").value')) === '7' && (await ev('document.querySelector("#fuelMax").value')) === '50', 'defaults: Caltex / 7 / 50');
    check(new RegExp('^' + (await ev('WaypointDebug.S.fuelStations.length')) + ' stations remembered$').test(await text('#fuelCount')), '"N stations remembered"', await text('#fuelCount'));
    await click('#forgetBtn');
    check(!!(await ev('document.querySelector("#forgetConfirm")')) && (await ev('WaypointDebug.S.fuelStations.length')) > 0, '"Forget stations" asks in the page first (nothing forgotten yet)');
    await click('#forgetYes');
    check((await ev('WaypointDebug.S.fuelStations.length')) === 0 && /^0 stations remembered/.test(await text('#fuelCount')), 'confirmed: the memory is empty');
    const exportJson = await ev('(() => { const x = { stations: WaypointDebug.S.fuelStations, brand: WaypointDebug.S.settings.fuelBrand, dwell: WaypointDebug.S.settings.fuelDwellMin, max: WaypointDebug.S.settings.fuelMaxSearches }; return x; })()');
    check(exportJson.brand === 'Caltex' && exportJson.dwell === 7 && exportJson.max === 50, 'the fuel settings are part of the stored settings (exported with them)', exportJson);

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
