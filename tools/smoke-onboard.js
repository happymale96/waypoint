#!/usr/bin/env node
/* Mocked browser smoke for "items with you", PLAN on a running day and the closed-day Route card (no screenshots, no network, no real keys).
 *   node tools/smoke-onboard.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol, and mocks TomTom,
 * geolocation (a position the script can move; permission "denied" except for the one moment a drop-off looks for its place), page
 * visibility and the clock inside the page. RUN 1: a plan with one collect-only job (printer ribbon at Carrier International) and two
 * deliveries; the collect-only stop Reached + Done -> "With you: 1 item" on the Plan and the Route tab; "Deliver to…" opens the add-job
 * form in in-hand mode, pre-filled, and Cancel changes nothing; no "Replan from here", "Add fuel stop" sits next to "Open in Google
 * Maps"; opening the Plan tab on the running day resets the chips to "My location" / "Now"; a job added and PLAN -> the done stop kept, the
 * pending stops re-solved from the mocked live position, replan count +1; "Dropped off" (bar gone, toast with Undo, the place named, Undo
 * brings it back); End day -> "Dropped off: …" in the summary and the Route tab shows only "Day closed HH:MM" + "View summary"; PLAN again
 * -> the normal Route tab. RUN 2 (fresh storage): End day with the item still with you -> STILL WITH YOU lists it, the closed Route card
 * keeps the bar, and the item survives a reload. The server and the browser are always shut down. Exit 1 on failure.
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
  'waypoint:places:carrier': place('carrier', 'Carrier International Sdn Bhd', 1), 'waypoint:places:sup': place('sup', 'Supplier One', 2, 'supplier'),
  'waypoint:places:d1': place('d1', 'Delta Works', 3), 'waypoint:places:d2': place('d2', 'Echo Works', 4),
  'waypoint:jobs:jc': job('jc', { pickups: [{ placeId: 'carrier', item: 'printer ribbon', done: false }], notes: 'ring the bell', createdAt: '2026-11-23T01:01:00.000Z' }),
  'waypoint:jobs:jd1': job('jd1', { pickups: [{ placeId: 'sup', item: 'sensor', done: false }], deliveryPlaceId: 'd1', createdAt: '2026-11-23T01:02:00.000Z' }),
  'waypoint:jobs:jd2': job('jd2', { pickups: [{ placeId: 'sup', item: 'valve', done: false }], deliveryPlaceId: 'd2', createdAt: '2026-11-23T01:03:00.000Z' }),
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
  const realFetch = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('api.tomtom.com')) {
      if (url.includes('/calculateRoute/')) { // the Routing API: one leg per request, coordinates in the path
        const q = [0].concat(url.split('/calculateRoute/')[1].split('/')[0].split(/[,:]/).map(Number));
        const k = km({ lat: +q[1], lng: +q[2] }, { lat: +q[3], lng: +q[4] });
        return json({ routes: [{ summary: { travelTimeInSeconds: Math.round(k * 1.3 / 40 * 3600), lengthInMeters: Math.round(k * 1300) } }] });
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
    const fresh = async () => {
      await send('Page.navigate', { url: 'about:blank' }); // leave the app first (nothing can save behind our back), then wipe its storage
      await sleep(300);
      await send('Storage.clearDataForOrigin', { origin: new URL(appUrl).origin, storageTypes: 'local_storage,session_storage' });
      await send('Page.navigate', { url: appUrl });
      await waitFor('document.querySelector("#planBtn")', 'the Plan tab');
    };
    const planNow = async (n) => {
      await click('#planBtn');
      await waitFor('window.WaypointDebug && WaypointDebug.S.plan && WaypointDebug.S.tab === "route" && !WaypointDebug.S.busy && document.querySelectorAll(".timeline .card.stop").length === ' + n, 'a planned route of ' + n + ' stops');
    };
    const barText = () => text('#onBoardToggle');
    const openBar = async () => { if (await ev('!document.querySelector("#onBoardList")')) await click('#onBoardToggle'); await waitFor('document.querySelector("#onBoardList")', 'the expanded list'); };

    console.log('RUN 1');
    console.log('1. plan, collect-only stop Reached + Done');
    await fresh();
    check(await ev('!document.querySelector("#onBoardBar")'), 'nothing with you yet: no bar on the Plan tab');
    await planNow(4);
    check(await ev('!document.querySelector("#onBoardBar")'), '... and none on the Route tab');
    const jobsBefore = await S('jobs.length');
    await reachDone('carrier', 'Carrier');
    check(await ev('WaypointDebug.S.jobs.find((j) => j.id === "jc").status') === 'done', 'the collect-only job is done');
    check(await S('loose.length') === 1 && await S('jobs.length') === jobsBefore, 'one loose item; the job count is unchanged', [await S('loose.length'), await S('jobs.length'), jobsBefore]);
    check(await barText() === 'With you: 1 item' || /^With you: 1 item/.test(await barText() || ''), 'Route tab: "With you: 1 item"', await barText());
    await tab('plan');
    check(/^With you: 1 item/.test(await barText() || ''), 'Plan tab: "With you: 1 item"', await barText());
    check(await ev('(() => { const b = document.querySelector("#onBoardBar").getBoundingClientRect(); return b.height < 60 && !document.querySelector("#onBoardList"); })()'), 'collapsed it is one slim line');

    console.log('2. expand, "Deliver to…", cancel');
    await openBar();
    const row = await ev('(() => { const r = document.querySelector("#onBoardList .ob-row"); return { n: document.querySelectorAll("#onBoardList .ob-row").length, t: r.textContent, b: [...r.querySelectorAll("button")].map((x) => x.textContent) }; })()');
    check(row.n === 1 && /printer ribbon/.test(row.t) && /from Carrier International · today 1\d:\d\d/.test(row.t), 'the row: item, "from <place> · <day/time>"', row.t);
    check(JSON.stringify(row.b) === JSON.stringify(['Dropped off', 'Deliver to…']), 'two buttons: Dropped off, Deliver to…', row.b);
    await click('#onBoardList [data-act="deliver"]');
    await waitFor('document.querySelector(".sheet #jobDest")', 'the add-job form');
    await waitFor('document.activeElement && document.activeElement.id === "jobDest"', 'the focus on the destination');
    const form = await ev('(() => { const ins = [...document.querySelectorAll(".sheet input")]; const q = (p) => (ins.find((i) => i.placeholder === p) || {}).value; return { title: document.querySelector(".sheet h3").textContent, item: q("e.g. Test gasket"), notes: q("Optional"), pick: document.querySelector(".sheet").textContent.indexOf("none = item already in hand") > 0, dest: document.querySelector("#jobDest").textContent }; })()');
    check(form.item === 'printer ribbon' && form.notes === 'ring the bell' && form.pick && form.dest === 'Pick delivery place', 'in-hand mode, item and notes pre-filled, the destination still to pick', form);
    await clickText('.sheet .sticky-actions button', 'Cancel');
    await waitFor('!document.querySelector(".backdrop")', 'the form to close');
    check(await S('loose.length') === 1 && await S('loose[0].status') === 'with-me' && await S('jobs.length') === jobsBefore, 'cancel: still one loose item, still with me, no new job');
    check(/^With you: 1 item/.test(await barText() || ''), 'the bar is unchanged');

    console.log('3. no "Replan from here"; "Add fuel stop" is in the Google Maps row');
    await tab('route');
    check(await ev('![...document.querySelectorAll("button, a")].some((x) => /Replan from here/i.test(x.textContent))'), 'no "Replan from here" anywhere on the Route tab');
    const rowTxt = await ev('[...document.querySelector("#fuelBtn").parentElement.children].map((x) => x.textContent)');
    check(rowTxt[0] === 'Open in Google Maps' && rowTxt[1] === 'Add fuel stop' && rowTxt.length === 2, 'the row reads: Open in Google Maps | Add fuel stop', rowTxt);

    console.log('4. the Plan tab on a running day: chips reset; add a job, PLAN re-solves from the live position');
    await ev('(() => { WaypointDebug.S.startSel = "d1"; WaypointDebug.S.departTime = "23:50"; return true; })()'); // chips left changed by hand earlier
    await tab('plan');
    const chips = await ev('({ start: document.querySelector("#headerChips .chip-btn.start").textContent, depart: document.querySelector("#headerChips .chip-btn.depart").textContent })');
    check(chips.start.indexOf('My location') >= 0 && chips.depart === 'Now', 'chips read "My location" and "Now"', chips);
    const NEW = at(2.4);
    await ev('(() => { window.__pos = ' + JSON.stringify(NEW) + '; return true; })()');
    await ev('(() => { const j = ' + JSON.stringify(job('jd3', { pickups: [{ placeId: 'sup', item: 'cable', done: false }], deliveryPlaceId: 'd1', createdAt: '2026-11-23T01:09:00.000Z' })) + '; WaypointDebug.S.jobs.push(j); return WPStore.set("jobs", j.id, j).then(() => { WaypointDebug.render(); return true; }); })()');
    const before = await ev('(() => { const S = WaypointDebug.S, d = Object.values(S.days)[0], c = S.plan.result.plans[0].stops.find((s) => s.placeId === "carrier"); return { replans: DayLog.summarise(d, S.jobs, S.places).plan.replans, doneAt: c.doneAt, start: S.plan.ctx.start }; })()');
    await advanceMs(60000);
    await click('#planBtn');
    await waitFor('!WaypointDebug.S.busy && WaypointDebug.S.tab === "route" && WaypointDebug.S.plan.ctx.start.lat === ' + NEW.lat, 'PLAN to finish from the live position');
    const after = await ev('(() => { const S = WaypointDebug.S, p = S.plan.result.plans[0], d = Object.values(S.days)[0]; return { first: p.stops[0].placeId + ":" + p.stops[0].status, doneAt: p.stops[0].doneAt, pending: p.stops.filter((s) => !s.status).map((s) => s.placeId), start: S.plan.ctx.start, replans: DayLog.summarise(d, S.jobs, S.places).plan.replans, tab: S.tab }; })()');
    check(after.first === 'carrier:done' && after.doneAt === before.doneAt, 'the done stop is kept on top', after);
    check(after.pending.length === 3 && after.pending.includes('sup') && after.pending.includes('d1') && after.pending.includes('d2'), 'the pending stops (incl. the new job) were re-solved', after.pending);
    check(after.start.lat === NEW.lat && after.start.lng === NEW.lng && before.start.lat !== NEW.lat, 'from the mocked live position', { before: before.start, after: after.start });
    check(after.replans === before.replans + 1, 'replan count +1', { before: before.replans, after: after.replans });
    check(await S('loose.length') === 1 && /^With you: 1 item/.test(await barText() || ''), 'the item is still with you after the re-solve');

    console.log('5. "Dropped off"');
    await openBar();
    await ev('(() => { window.__perm = "granted"; window.__pos = { lat: ' + HOME.lat + ', lng: ' + HOME.lng + ' }; return true; })()'); // standing at Home: the drop-off may name it
    await click('#onBoardList [data-act="drop"]');
    await waitFor('!document.querySelector("#onBoardBar")', 'the bar to go');
    const toast = await ev('(() => { const t = document.getElementById("toast"); return { hidden: t.hidden, text: t.textContent, undo: !!t.querySelector(".toast-undo") }; })()');
    check(!toast.hidden && /^Dropped off: printer ribbon/.test(toast.text) && toast.undo, 'toast "Dropped off: printer ribbon · Undo"', toast);
    await waitFor('WaypointDebug.S.loose[0].droppedPlace', 'the place to be named');
    check(await S('loose[0].status') === 'dropped' && await S('loose[0].droppedPlace') === 'Home (Bloomsvale)', 'dropped, and a fix within 150 m of a saved place named it', await S('loose[0]'));
    check(await ev('Object.values(WaypointDebug.S.days)[0].events.some((e) => e.type === "dropoff" && e.looseId === "loose_jc")'), 'logged as a day event');
    await click('#toast .toast-undo');
    await waitFor('document.querySelector("#onBoardBar")', 'the bar to come back');
    check(await S('loose[0].status') === 'with-me' && /^With you: 1 item/.test(await barText() || ''), 'Undo: back on board');
    await openBar();
    await click('#onBoardList [data-act="drop"]');
    await waitFor('!document.querySelector("#onBoardBar")', 'the bar to go again');
    await waitFor('WaypointDebug.S.loose[0].droppedPlace', 'the place to be named again');
    await ev('(() => { window.__perm = "denied"; return true; })()');

    console.log('6. End day: "Dropped off" in the summary; the Route tab shows the closed-day card');
    await advanceMs(30 * 60000);
    await tab('route');
    await click('#routeEndDay');
    await waitFor('document.querySelector("#sumWithYou")', 'the summary');
    const wy = await text('#sumWithYou');
    check(/Dropped off: printer ribbon \d\d:\d\d \(Home \(Bloomsvale\)\)/.test(wy || ''), 'the summary lists "Dropped off: printer ribbon HH:MM (Home (Bloomsvale))"', wy);
    check(/Nothing in the van/.test(wy || ''), 'and nothing is with you at close');
    await click('#closeDay');
    await waitFor('Object.values(WaypointDebug.S.days).some((d) => d.closed)', 'the day to close');
    await clickText('.sum-actions button', 'Back');
    await waitFor('!document.querySelector(".backdrop")', 'the summary to close');
    await waitFor('document.querySelector("#dayClosedCard")', 'the Day closed card');
    const card = await ev('({ t: document.querySelector("#dayClosedCard").textContent, kids: document.getElementById("view").children.length, has: (s) => 0 })');
    check(/^Day closed \d\d:\d\d.*View summary$/.test(card.t), 'one card: "Day closed HH:MM" with "View summary"', card.t);
    const gone = await ev('({ endDay: !!document.querySelector("#routeEndDay"), fuel: !!document.querySelector("#fuelBtn"), times: !!document.querySelector("#timesFrom"), totals: !!document.querySelector("#routeTotals"), stops: document.querySelectorAll(".card.stop").length, btns: [...document.querySelectorAll("#view button")].map((b) => b.textContent) })');
    check(!gone.endDay && !gone.fuel && !gone.times && !gone.totals && gone.stops === 0 && card.kids === 1,'nothing else: no End day, fuel button, "Times from", ETA header or stop buttons', gone);
    check(JSON.stringify(gone.btns) === JSON.stringify(['View summary']), 'the only button is "View summary"', gone.btns);
    await click('#viewSummary');
    await waitFor('document.querySelector("#sumWithYou")', 'the summary again');
    check(/Dropped off: printer ribbon/.test(await text('#sumWithYou') || ''), 'View summary reopens the closed day');
    await clickText('.sum-actions button', 'Back');
    await waitFor('!document.querySelector(".backdrop")', 'the summary to close');

    console.log('7. planned again after closing: the Route tab is normal');
    await tab('plan');
    await planNow(3);
    check(await ev('!document.querySelector("#dayClosedCard") && !!document.querySelector("#routeEndDay") && !!document.querySelector("#timesFrom")'), 'a new plan: the normal Route tab (stops, Times from…, End day)');

    console.log('RUN 2 (fresh storage): End day with the item still with you');
    await fresh();
    await planNow(4);
    await reachDone('carrier', 'Carrier');
    check(/^With you: 1 item/.test(await barText() || ''), 'the item is with you');
    await click('#routeEndDay');
    await waitFor('document.querySelector("#sumWithYou")', 'the summary');
    const wy2 = await text('#sumWithYou');
    check(/printer ribbon/.test(wy2 || '') && /from Carrier International/.test(wy2 || '') && !/Nothing in the van/.test(wy2 || ''), 'STILL WITH YOU lists the printer ribbon and where it came from', wy2);
    await click('#closeDay');
    await waitFor('Object.values(WaypointDebug.S.days).some((d) => d.closed)', 'the day to close');
    await clickText('.sum-actions button', 'Back');
    await waitFor('document.querySelector("#dayClosedCard")', 'the Day closed card');
    check(/^With you: 1 item/.test(await barText() || ''), 'End day does not clear it: the bar is still there on the closed-day Route tab');
    await send('Page.reload');
    await waitFor('window.WaypointDebug && document.querySelector("#dayClosedCard")', 'the reloaded Route tab');
    check(await S('loose.length') === 1 && await S('loose[0].status') === 'with-me' && /^With you: 1 item/.test(await barText() || ''), 'after a reload the item is still stored and still with you');
    await clickText('#view button', 'View summary');
    await waitFor('document.querySelector("#sumWithYou")', 'the closed day summary');
    check(/printer ribbon/.test(await text('#sumWithYou') || ''), 'the closed day is re-rendered with the same rule');

    console.log('RUN 3 (fresh storage): PLAN on a running day keeps a skipped stop skipped');
    await fresh();
    await planNow(4);
    await ev('(() => { const c = [...document.querySelectorAll(".timeline .card.stop")].find((x) => x.querySelector(".nm") && x.querySelector(".nm").textContent.indexOf("Carrier") === 0); [...c.querySelectorAll(".stop-btns button")].find((b) => b.textContent === "SKIP").click(); return true; })()');
    await waitFor(planStop('carrier') + '.status === "skipped"', 'Carrier to be skipped');
    const skippedCards = () => ev('[...document.querySelectorAll(".timeline .card.stop.skipped")].map((c) => ({ t: c.textContent, undo: !!c.querySelector("button[aria-label=\\"Undo skip\\"]") }))');
    const jobsRun3 = await S('jobs.length');
    check(await ev('(() => { const b = document.querySelector("#skipPrompt button"); return !!b && b.textContent === "Go to Plan"; })()'), 'the skip prompt keeps its "Go to Plan" button');
    await tab('plan');
    await ev('(() => { const j = ' + JSON.stringify(job('jd3', { pickups: [{ placeId: 'sup', item: 'cable', done: false }], deliveryPlaceId: 'd1', createdAt: '2026-11-23T01:09:00.000Z' })) + '; WaypointDebug.S.jobs.push(j); return WPStore.set("jobs", j.id, j).then(() => { WaypointDebug.render(); return true; }); })()');
    await advanceMs(60000);
    await planNow(4); // Carrier (skipped, once) + the three live stops; before the fix the skipped job came back as a fifth stop
    const sk = await skippedCards();
    check(sk.length === 1 && /Carrier/.test(sk[0].t) && sk[0].undo, 'after PLAN: Carrier is still skipped, once, with "Undo skip"', sk);
    check(!/\d\d:\d\d/.test(sk[0].t), 'the skipped stop shows no ETA', sk[0].t);
    const afterPlan = await ev('(() => { const S = WaypointDebug.S, p = S.plan.result.plans[0]; return { names: p.stops.map((s) => s.placeId + ":" + (s.status || "")), carrier: p.stops.filter((s) => s.placeId === "carrier").length, first: p.stops[0].placeId + ":" + p.stops[0].status, jc: S.jobs.find((j) => j.id === "jc").status, jobs: S.jobs.length }; })()');
    check(afterPlan.carrier === 1 && afterPlan.first === 'carrier:skipped' && afterPlan.names.length === 4, 'the skipped stop is in its place, not added again', afterPlan.names);
    check(afterPlan.jc === 'pending' && afterPlan.jobs === jobsRun3 + 1, 'its job is still pending (not done) and no job was added or lost', afterPlan);
    await tab('route');
    await click('.timeline .card.stop.skipped button[aria-label="Undo skip"]');
    await waitFor('!document.querySelector(".timeline .card.stop.skipped")', 'Undo skip');
    await tab('plan');
    await planNow(4);
    const pendC = await ev('(() => { const p = WaypointDebug.S.plan.result.plans[0], s = p.stops.find((x) => x.placeId === "carrier"); const c = [...document.querySelectorAll(".timeline .card.stop")].find((x) => x.textContent.indexOf("Carrier") >= 0); return { n: p.stops.filter((x) => x.placeId === "carrier").length, status: s && s.status, arriveAt: s && s.arriveAt, txt: c ? c.textContent : "", skipped: document.querySelectorAll(".timeline .card.stop.skipped").length }; })()');
    check(pendC.n === 1 && !pendC.status && pendC.skipped === 0 && pendC.arriveAt > 0 && /\d\d:\d\d/.test(pendC.txt), 'after Undo skip and PLAN: Carrier is pending, with an ETA', pendC);

    console.log('RUN 4 (fresh storage): the one-time dwell migration and the customer message time');
    await fresh();
    await ev(`(() => { // the owner's old data: 3 customer factories (20, 20, 40), 2 suppliers (5, 15), 1 office (10), 1 home (0), padding 15, the flag absent
      Object.keys(localStorage).filter((k) => /^waypoint:(places|jobs):/.test(k) || k === 'waypoint:plan:current' || k === 'waypoint:meta:migrations').forEach((k) => localStorage.removeItem(k));
      const pl = (id, type, d) => ({ id, name: id, address: id, type, dwellMin: d, lat: 3.1, lng: 101.6, closedWindows: [] });
      [pl('f1', 'factory', 20), pl('f2', 'factory', 20), pl('f3', 'factory', 40), pl('s1', 'supplier', 5), pl('s2', 'supplier', 15), pl('office', 'office', 10), pl('home', 'home', 0)]
        .forEach((p) => localStorage.setItem('waypoint:places:' + p.id, JSON.stringify(p)));
      const s = JSON.parse(localStorage.getItem('waypoint:settings:main'));
      s.etaPaddingMin = 15; s.dwellDefaults = { factory: 20, supplier: 5, other: 10, office: 10, home: 0 };
      localStorage.setItem('waypoint:settings:main', JSON.stringify(s));
      return true; })()`);
    await send('Page.reload');
    await waitFor('window.WaypointDebug && document.querySelector("#planBtn")', 'the reloaded app');
    await waitFor('(() => { const t = document.getElementById("toast"); return t && !t.hidden && /^Updated:/.test(t.textContent); })()', 'the migration toast');
    check(await text('#toast') === 'Updated: 2 supplier places to 10 min, 3 customer places to 30 min, ETA padding to 10 min', 'the toast names 2 supplier places, 3 customer places and the padding', await text('#toast'));
    const stored = () => ev(`(() => { const g = (k) => JSON.parse(localStorage.getItem(k)); const d = (id) => g('waypoint:places:' + id).dwellMin; const s = g('waypoint:settings:main');
      return { d: ['f1', 'f2', 'f3', 's1', 's2', 'office', 'home'].map(d), pad: s.etaPaddingMin, defs: s.dwellDefaults, flag: (g('waypoint:meta:migrations') || {}).dwell2026_11_23 }; })()`);
    const st1 = await stored();
    check(JSON.stringify(st1.d) === JSON.stringify([30, 30, 30, 10, 10, 10, 0]), 'stored dwells: customers 30, suppliers 10, office 10, home 0', st1.d);
    check(st1.pad === 10 && st1.defs.supplier === 10 && st1.defs.factory === 30 && st1.defs.other === 10 && st1.defs.office === 10 && st1.defs.home === 0, 'stored padding 10; defaults supplier 10, customer factory 30, the rest unchanged', st1);
    check(st1.flag === true, 'the migration flag is stored');
    await ev('(() => { const p = JSON.parse(localStorage.getItem("waypoint:places:f1")); p.dwellMin = 45; localStorage.setItem("waypoint:places:f1", JSON.stringify(p)); return true; })()'); // the owner later sets one to 45
    await send('Page.reload');
    await waitFor('window.WaypointDebug && document.querySelector("#planBtn")', 'the second load');
    await sleep(800);
    check(await ev('document.getElementById("toast").hidden || !/^Updated:/.test(document.getElementById("toast").textContent)'), 'a second load shows no migration toast');
    const st2 = await stored();
    check(JSON.stringify(st2.d) === JSON.stringify([45, 30, 30, 10, 10, 10, 0]) && st2.pad === 10 && st2.flag === true, 'and changes nothing: a place set to 45 stays 45', st2);

    console.log('   the customer message: ETA + padding (10), rounded up to a 5-minute mark only if needed');
    await fresh(); // the seed world, migrated on load (padding 10)
    await planNow(4);
    await ev('(() => { const P = WaypointDebug.S.plan, p = P.result.plans[0], s = p.stops.find((x) => x.placeId === "d1"), d = new Date(); d.setHours(17, 0, 0, 0); s.arriveAt = d.getTime(); WaypointDebug.render(); window.__copied = null; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); return true; })()');
    const eta = await ev('(() => { const c = [...document.querySelectorAll(".timeline .card.stop")].find((x) => x.querySelector(".nm") && x.querySelector(".nm").textContent.indexOf("Delta") === 0); return c ? c.querySelector(".times").textContent : null; })()');
    check(eta === '17:00', 'the stop shows ETA 17:00', eta);
    await ev('(() => { const c = [...document.querySelectorAll(".timeline .card.stop")].find((x) => x.querySelector(".nm") && x.querySelector(".nm").textContent.indexOf("Delta") === 0); [...c.querySelectorAll("button")].find((b) => b.textContent === "MSG").click(); return true; })()');
    await waitFor('window.__copied', 'the copied message');
    const copied = await ev('window.__copied');
    check(/^Salam .*sebelum pukul 5\.10pm hantar ke kilang .*Tq👍$/.test(copied), 'the copied message (Part G wording) says 5.10pm (17:10) for an ETA of 17:00', copied);

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
