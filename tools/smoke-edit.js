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
