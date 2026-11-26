#!/usr/bin/env node
/* Mocked browser smoke for proof of delivery (proof.js; no screenshots, no network, no real keys).
 *   node tools/smoke-proof.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol at a 360 px wide
 * viewport, with TomTom, geolocation, the clipboard, navigator.canShare / navigator.share and the clock mocked inside the page.
 * The clock is PINNED: 26 Nov 2026 14:00 Malaysia time, moved only by the smoke (kept across reloads in sessionStorage).
 * World: S (supplier, collect a Gasket for C), C (customer, deliver it), D (customer, an in-hand Fuse), O (office errand).
 * Walk: PROOF only on the delivery stops (S and O keep ✓ DONE); a generated 3000 x 2000 JPEG fed to the file input is saved at
 * once under a draft; a reload reopens the sheet with it; Save & done completes the stop and writes a stamped photo no larger than
 * 1600 px with the band; the card is no taller than while pending; Undo voids the proof (photos kept); a new PROOF makes a new one;
 * SEND TO GROUP passes the right files + caption, the caption is copied, the button reads SENT ✓; a rejected share and canShare
 * "no" change nothing; on D: Cancel deletes the draft, No photo saves a reason and shares the text only; the CSV columns; retention
 * deletes a 731-day-old proof (and its photo) on the next load and keeps a 729-day-old one; the Settings line. Exit 1 on failure.
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

const PIN = Date.UTC(2026, 10, 26, 6, 0, 0); // 26 Nov 2026 14:00 MYT
const SEED = {
  'waypoint:settings:main': { googleKey: '', tomtomKey: 'test-tomtom', seeded: true, defaultLang: 'ms', nav: 'waze', driverName: 'Calvin', autoReach: false, keepScreenOn: false, lunchBreakOn: false },
  'waypoint:places:home': { id: 'home', name: 'Home (Bloomsvale)', address: 'Bloomsvale', lat: 3.0757673, lng: 101.6609445, type: 'home', dwellMin: 0, closedWindows: [] },
  'waypoint:places:pS': { id: 'pS', name: 'Supplier One', address: 'S St', lat: 3.10, lng: 101.66, type: 'supplier', dwellMin: 10, closedWindows: [] },
  'waypoint:places:pC': { id: 'pC', name: 'Beta Customer Sdn Bhd', address: 'Lot 5, Jalan Kebun, Klang', lat: 3.125, lng: 101.705, type: 'factory', dwellMin: 15, closedWindows: [], contactName: 'Encik Ali' },
  'waypoint:places:pD': { id: 'pD', name: 'Delta Works', address: 'D St', lat: 3.17, lng: 101.62, type: 'factory', dwellMin: 15, closedWindows: [] },
  'waypoint:places:pO': { id: 'pO', name: 'Office (L-Tech)', address: 'L-Tech Automation', lat: 3.09941, lng: 101.739, type: 'office', dwellMin: 10, closedWindows: [] },
  'waypoint:jobs:j1': { id: 'j1', pickups: [{ placeId: 'pS', item: 'Gasket', done: false }], inHandItem: '', deliveryPlaceId: 'pC', notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-26T01:00:00.000Z' },
  'waypoint:jobs:j2': { id: 'j2', pickups: [], inHandItem: 'Fuse', deliveryPlaceId: 'pD', notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-26T01:01:00.000Z' },
  'waypoint:jobs:j3': { id: 'j3', pickups: [], deliveryPlaceId: null, errandPlaceId: 'pO', dwellMin: 10, notes: 'Hand in claim', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-26T01:02:00.000Z' },
};

// runs in the page before anything else: the pinned clock, mocks, the seed
const INIT = `(() => {
  const RealDate = Date, PIN = ${PIN};
  const st = sessionStorage.getItem('__off');
  window.__off = st != null ? Number(st) : 0;
  window.__advance = (ms) => { window.__off += ms; sessionStorage.setItem('__off', String(window.__off)); return true; };
  window.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(PIN + window.__off); else super(...a); }
    static now() { return PIN + window.__off; }
  };
  try { delete Navigator.prototype.serviceWorker; } catch (e) { /* ignore */ }
  window.__gps = { lat: 3.07, lng: 101.65, accuracy: 20 };
  window.__watches = {}; window.__watchSeq = 0;
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(ok) { setTimeout(() => ok({ coords: { latitude: window.__gps.lat, longitude: window.__gps.lng, accuracy: window.__gps.accuracy, speed: 3 }, timestamp: Date.now() }), 0); },
    watchPosition(ok, err, opts) { const id = ++window.__watchSeq; window.__watches[id] = { ok }; return id; },
    clearWatch(id) { delete window.__watches[id]; },
  } });
  window.__watchFire = (p) => { Object.values(window.__watches).forEach((w) => w.ok({ coords: { latitude: p.lat, longitude: p.lng, accuracy: p.accuracy, speed: 3 }, timestamp: Date.now() })); return Object.keys(window.__watches).length; };
  document.addEventListener('click', (e) => { const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]'); if (a) e.preventDefault(); }, true);
  try { navigator.permissions.query = async () => ({ state: 'granted', addEventListener() {} }); } catch (e) { /* ignore */ }
  window.open = () => null;
  window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
  // Web Share: canShare answers window.__canShare; share records its arguments, resolves (or rejects when window.__shareReject)
  window.__canShare = true; window.__shareReject = false; window.__shares = []; window.__canShareCalls = [];
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => { window.__canShareCalls.push({ files: d && d.files ? d.files.length : 0 }); return window.__canShare; } });
  Object.defineProperty(navigator, 'share', { configurable: true, value: (d) => {
    window.__shares.push({ text: d.text, files: d.files ? d.files.map((f) => ({ name: f.name, type: f.type, size: f.size, isFile: f instanceof File })) : null });
    return window.__shareReject ? Promise.reject(new DOMException('Share canceled', 'AbortError')) : Promise.resolve();
  } });
  const km = (a, b) => { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dg = (b.lng - a.lng) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const realFetch = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('api.tomtom.com') && url.includes('/calculateRoute/')) {
      const q = url.split('/calculateRoute/')[1].split('/')[0].split(/[,:]/).map(Number);
      const k = km({ lat: q[0], lng: q[1] }, { lat: q[2], lng: q[3] }), s = Math.round(k * 1.3 / 40 * 3600);
      return json({ routes: [{ summary: { travelTimeInSeconds: s, historicTrafficTravelTimeInSeconds: s, lengthInMeters: Math.round(k * 1300) } }] });
    }
    if (url.includes('api.tomtom.com') || url.includes('googleapis.com')) return new Response('{}', { status: 500 });
    return realFetch(url, init);
  };
  // a generated JPEG (w x h, yellow) fed to the proof sheet's file input, as the camera would
  window.__feedPhoto = async (w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = 'rgb(255, 220, 0)'; g.fillRect(0, 0, w, h); g.fillStyle = 'rgb(200, 60, 40)'; g.fillRect(w / 4, h / 4, w / 2, h / 4);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const inp = document.getElementById('proofFile');
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'IMG_0001.jpg', { type: 'image/jpeg' }));
    inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    return blob.size;
  };
  try {
    if (!localStorage.getItem('__seeded')) {
      const seed = ${JSON.stringify(SEED)};
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
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=360,860',
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
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Kuala_Lumpur' }).catch(() => {});
    await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
    const waitFor = async (expr, what, ms) => { const end = Date.now() + (ms || 10000); while (Date.now() < end) { if (await ev('(async () => !!(await (' + expr + ')))()').catch(() => false)) return true; await sleep(100); } const bn = await ev('(document.getElementById("banner") || {}).textContent || ""').catch(() => ''); throw new Error('timeout waiting for ' + what + (bn ? ' [banner: ' + bn + ']' : '') + (page.logs.length ? ' [page: ' + page.logs.join(' | ') + ']' : '')); };
    const click = (sel) => ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) throw new Error("no " + ' + JSON.stringify(sel) + '); e.click(); return true; })()');
    const advance = (ms) => ev('window.__advance(' + ms + ')');
    const cardOf = (nm) => '[...document.querySelectorAll(".timeline .card.stop")].find((c) => { const n = c.querySelector(".nm") || c.querySelector(".title"); return n && n.textContent.indexOf(' + JSON.stringify(nm) + ') >= 0; })';
    const primary = (nm) => ev('(() => { const b = (' + cardOf(nm) + ').querySelector(".stop-btns button.ok"); return b ? b.textContent : null; })()');
    const tapPrimary = (nm) => ev('(() => { const b = (' + cardOf(nm) + ').querySelector(".stop-btns button.ok"); b.click(); return b.textContent; })()');
    const cardH = (nm) => ev('Math.round((' + cardOf(nm) + ').getBoundingClientRect().height)');
    const planStop = (id) => 'WaypointDebug.S.plan.result.plans[0].stops.find((s) => s.placeId === ' + JSON.stringify(id) + ')';
    const proofs = () => ev('Proof.listProofs().then((a) => a.map((p) => ({ id: p.id, state: p.state, stopKey: p.stopKey, photoIds: p.photoIds, receiver: p.receiver, noPhotoReason: p.noPhotoReason, sentAt: p.sentAt, gps: p.gps, doneAt: p.doneAt, items: p.items, driveAt: p.driveAt })))');
    const reach = async (nm) => { check(await tapPrimary(nm) === 'REACHED', nm + ': REACHED first'); await advance(60000); };

    console.log('load + plan (360 px wide, clock pinned to 26 Nov 2026 14:00 MYT)');
    await send('Page.navigate', { url: appUrl });
    await waitFor('document.querySelector("#planBtn")', 'the Plan tab');
    check(await ev('new Date().toISOString()') === '2026-11-26T06:00:00.000Z' && await ev('window.innerWidth') === 360, 'clock pinned, viewport 360 px');
    await click('#planBtn');
    await waitFor('window.WaypointDebug && WaypointDebug.S.plan && WaypointDebug.S.tab === "route" && document.querySelectorAll(".timeline .card.stop").length >= 4', 'the planned route');
    const order = await ev('WaypointDebug.S.plan.result.plans[0].stops.map((s) => s.placeId)');
    check(order.indexOf('pS') < order.indexOf('pC'), 'the pickup comes before its delivery', order);

    console.log('1. PROOF only on the delivery stops');
    await reach('Supplier One');
    check(await primary('Supplier One') === '✓ DONE', 'the pickup stop reads ✓ DONE (not a proof stop)');
    await tapPrimary('Supplier One');
    await waitFor(planStop('pS') + '.status === "done"', 'DONE at S');
    check(!(await ev('!!document.getElementById("proofSheet")')), 'no proof sheet for a pickup');
    await reach('Office');
    check(await primary('Office') === '✓ DONE', 'the errand stop reads ✓ DONE');
    await tapPrimary('Office');
    await waitFor(planStop('pO') + '.status === "done"', 'DONE at the Office');
    const hPending = await cardH('Beta Customer');
    await reach('Beta Customer');
    check(await primary('Beta Customer') === '📷 PROOF', 'the delivery stop reads 📷 PROOF in the DONE spot', await primary('Beta Customer'));
    const look = await ev('(() => { const b = (' + cardOf('Beta Customer') + ').querySelector(".stop-btns button.ok"), cs = getComputedStyle(b); return { bg: cs.backgroundColor, fg: cs.color, act: b.dataset.act, n: (' + cardOf('Beta Customer') + ').querySelectorAll(".stop-btns > *").length, h: b.getBoundingClientRect().height }; })()');
    check(look.bg === 'rgb(245, 166, 35)' && look.fg === 'rgb(26, 26, 26)' && look.act === 'proof', 'PROOF is amber with dark text', look);
    const hReached = await cardH('Beta Customer');
    check(await ev('[...(' + cardOf('Delta Works') + ').querySelectorAll(".stop-btns button.ok")].map((b) => b.textContent).join()') === 'REACHED', 'the other delivery is still REACHED until reached');

    console.log('2. the sheet, a photo saved at once under a draft, a reload reopens it');
    await ev('window.__watchFire({ lat: 3.125 + 20 / 111190, lng: 101.705, accuracy: 12 })'); // a fresh fix at capture
    check(await tapPrimary('Beta Customer') === '📷 PROOF', 'tap PROOF');
    await waitFor('document.getElementById("proofSheet")', 'the proof sheet');
    const sheet = await ev('(() => { const s = document.getElementById("proofSheet"), r = s.getBoundingClientRect(), f = document.getElementById("proofFile"); return { title: s.querySelector("h3").textContent, items: [...s.querySelectorAll("#proofItems .act")].map((x) => x.textContent), full: r.width >= document.documentElement.clientWidth && r.height >= innerHeight, rw: r.width, rh: r.height, vh: innerHeight, accept: f.accept, capture: f.getAttribute("capture"), type: f.type, save: document.getElementById("proofSave").disabled, rcvMax: document.getElementById("proofReceiver").maxLength, noPhoto: !!document.getElementById("proofNoPhoto"), cancel: !!document.getElementById("proofCancel") }; })()');
    check(sheet.title === 'Beta Customer' && sheet.items.join() === 'Gasket' && sheet.full, 'full-screen sheet: the place name and the item delivered', sheet);
    check(sheet.type === 'file' && sheet.accept === 'image/*' && sheet.capture === 'environment' && sheet.save === true && sheet.rcvMax === 40 && sheet.noPhoto && sheet.cancel, 'camera input, Save & done off with no photo, Received by max 40, No photo, Cancel', sheet);
    await ev('window.__feedPhoto(3000, 2000)');
    await waitFor('document.querySelectorAll("#proofThumbs .proof-thumb").length === 1', 'one thumbnail');
    await waitFor('Proof.listProofs().then((a) => a.some((p) => p.state === "draft" && p.photoIds.length === 1))', 'the draft in IndexedDB');
    const d1 = (await proofs()).find((p) => p.state === 'draft');
    check(d1 && d1.stopKey === 'pC' && d1.gps && Math.abs(d1.gps.lat - 3.12518) < 0.0001 && d1.gps.acc === 12, 'draft saved the moment the photo came back, with the GPS fix', d1);
    check(await ev('Object.keys(localStorage).every((k) => (localStorage.getItem(k) || "").indexOf("data:image") < 0)'), 'no photo data in localStorage');
    check(await ev('!document.getElementById("proofSave").disabled'), 'Save & done is enabled with one photo');
    await send('Page.navigate', { url: appUrl });
    await waitFor('document.getElementById("proofSheet") && document.querySelectorAll("#proofThumbs .proof-thumb").length === 1', 'the sheet reopened with the draft photo after the reload');
    check(true, 'reload with a draft for a pending stop: the sheet reopens with its photo');

    console.log('3. Save & done: stamped, the stop completed by markDone');
    await ev('(() => { const r = document.getElementById("proofReceiver"); r.value = "Encik Ali"; r.dispatchEvent(new Event("change")); return true; })()');
    await advance(30000);
    await click('#proofSave');
    await waitFor(planStop('pC') + '.status === "done" && !document.getElementById("proofSheet")', 'DONE at C through the sheet', 20000);
    const p1 = (await proofs()).find((p) => p.state === 'done');
    check(p1 && p1.receiver === 'Encik Ali' && p1.photoIds.length === 1 && p1.sentAt == null && p1.driveAt === null && p1.items.join() === 'Gasket', 'proof done: receiver, 1 photo, sentAt / driveAt null', p1);
    const img = await ev(`(async () => { const p = (await Proof.listProofs()).find((x) => x.state === 'done'); const ph = await Proof.getPhoto(p.photoIds[0]); const b = await createImageBitmap(ph.blob);
      const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; const g = c.getContext('2d'); g.drawImage(b, 0, 0);
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)); const band = g.getImageData(0, Math.round(b.height * 0.75), b.width, Math.round(b.height * 0.25) - 1).data; let white = 0;
      for (let i = 0; i < band.length; i += 4) if (band[i] > 220 && band[i + 1] > 220 && band[i + 2] > 220) white++;
      return { w: b.width, h: b.height, type: ph.blob.type, bytes: ph.blob.size, rec: ph.bytes, top: px(5, 5), bottom: px(3, b.height - 3), white }; })()`);
    check(img.w <= 1600 && img.h <= 1600 && img.w === 1600 && img.h === 1067, 'stamped photo scaled to a 1600 px long side', img);
    check(img.type === 'image/jpeg' && img.bytes <= 400 * 1024 && img.rec === img.bytes, 'JPEG, at most 400 KB, bytes recorded', img);
    check(img.top[0] > 200 && img.bottom[0] < 70 && img.bottom[1] < 90 && img.bottom[2] < 100 && img.bottom[2] > 20, 'the dark-blue band along the bottom (photo stays yellow at the top)', img);
    check(img.white > 500, 'white logo / text in the band', img.white);
    const job1 = await ev('(() => { const j = WaypointDebug.S.jobs.find((x) => x.id === "j1"); const d = WaypointDebug.S.days[Object.keys(WaypointDebug.S.days).sort().pop()]; const e = d.events.filter((x) => x.type === "done" && x.kind === "deliver" && x.jobId === "j1").pop(); return { status: j.status, proofId: j.proofId, ev: e && e.proofId, sum: e && e.proof }; })()');
    check(job1.status === 'done' && job1.proofId === p1.id && job1.ev === p1.id && job1.sum.photos === 1 && job1.sum.receiver === 'Encik Ali', 'the proof id is on the job record and the done event', job1);
    const hDone = await cardH('Beta Customer');
    check(hDone <= hPending && hDone <= hReached, 'the done card is no taller than while pending (' + hDone + ' <= ' + hPending + ' / ' + hReached + ' px)', { hDone, hPending, hReached });
    const sendBtn = '(' + cardOf('Beta Customer') + ').querySelector("button.send-group")';
    const sb = await ev('(() => { const b = ' + sendBtn + '; if (!b) return null; const cs = getComputedStyle(b), i = b.querySelector("img"); return { text: b.textContent, bg: cs.backgroundColor, fg: cs.color, img: i && i.getAttribute("src"), imgH: i && Math.round(i.getBoundingClientRect().height), loaded: i && i.complete && i.naturalWidth > 0 }; })()');
    check(sb && sb.text === 'SEND TO GROUP' && sb.bg === 'rgb(37, 211, 102)' && sb.fg === 'rgb(13, 20, 27)', 'SEND TO GROUP: green with dark text', sb);
    check(sb && sb.img === 'whatsapp-glyph.svg' && sb.imgH === 18 && sb.loaded, 'the pack glyph, 18 px high, left of the label', sb);

    console.log('4. Undo voids the proof (photos kept); a later PROOF makes a new one');
    await click('.card.stop.done button.undo');
    await waitFor('!' + planStop('pC') + '.status', 'C pending again');
    await waitFor('Proof.getProof(' + JSON.stringify(p1.id) + ').then((p) => p && p.state === "void")', 'the proof voided');
    check(await ev('Proof.photosOf(' + JSON.stringify(p1.id) + ').then((a) => a.length)') === 1, 'its photo is kept');
    check(await ev('!WaypointDebug.S.jobs.find((x) => x.id === "j1").proofId') && await primary('Beta Customer') === '📷 PROOF' && !(await ev('!!document.querySelector("button.send-group")')), 'job unlinked, PROOF again, no SEND button');
    await advance(60000);
    await tapPrimary('Beta Customer');
    await waitFor('document.getElementById("proofSheet")', 'a fresh sheet');
    check(await ev('document.querySelectorAll("#proofThumbs .proof-thumb").length') === 0, 'the new sheet has no photos (the void proof is not a draft)');
    await ev('window.__watchFire({ lat: 3.125, lng: 101.705, accuracy: 9 })');
    await ev('window.__feedPhoto(1200, 900)');
    await waitFor('document.querySelectorAll("#proofThumbs .proof-thumb").length === 1', 'photo 1');
    await advance(5000);
    await ev('window.__feedPhoto(2000, 2000)');
    await waitFor('document.querySelectorAll("#proofThumbs .proof-thumb").length === 2', 'photo 2');
    await ev('document.querySelector("#proofThumbs .proof-thumb:last-child .proof-del").click()');
    await waitFor('document.querySelectorAll("#proofThumbs .proof-thumb").length === 1', 'photo 2 removed');
    await ev('(() => { const r = document.getElementById("proofReceiver"); r.value = "Encik Ali"; r.dispatchEvent(new Event("change")); return true; })()');
    await click('#proofSave');
    await waitFor(planStop('pC') + '.status === "done"', 'DONE at C again', 20000);
    const p2 = (await proofs()).find((p) => p.state === 'done');
    check(p2 && p2.id !== p1.id && p2.photoIds.length === 1, 'a new proof, one photo (the removed one gone)', p2);
    const dims2 = await ev('Proof.getPhoto(' + JSON.stringify(p2 && p2.photoIds[0]) + ').then((ph) => createImageBitmap(ph.blob)).then((b) => [b.width, b.height])');
    check(dims2[0] === 1200 && dims2[1] === 900, 'a photo already under 1600 px is not scaled up', dims2);

    console.log('5. SEND TO GROUP');
    const cap = 'DELIVERED - Beta Customer\nGasket\nReceived by: Encik Ali\n26 Nov 2026, ' + await ev('(() => { const d = new Date(Date.parse(' + JSON.stringify(p2.doneAt) + ') + 8 * 3600000); const h = d.getUTCHours(); return (h % 12 || 12) + ":" + String(d.getUTCMinutes()).padStart(2, "0") + " " + (h < 12 ? "am" : "pm"); })()');
    await click('.card.stop.done button.send-group');
    await waitFor('window.__shares.length === 1', 'navigator.share called');
    const sh1 = await ev('window.__shares[0]');
    check(sh1.text === cap, 'share text = caption(proof)', sh1.text);
    check(sh1.files && sh1.files.length === 1 && sh1.files[0].isFile && sh1.files[0].type === 'image/jpeg' && sh1.files[0].name === '2026-11-26_beta-customer_1.jpg', 'share files: the stamped JPEG named by fileName() (the shown name, Sdn Bhd dropped)', sh1.files);
    check(await ev('window.__canShareCalls.length') >= 1 && await ev('window.__copied[window.__copied.length - 1]') === cap, 'canShare asked; the caption was copied to the clipboard');
    await waitFor('(' + sendBtn + ' || {}).textContent === "SENT ✓"', 'the button to read SENT ✓');
    check(/^Caption copied - paste it if WhatsApp shows none$/.test(await ev('document.getElementById("toast").textContent')), 'notice: Caption copied - paste it if WhatsApp shows none');
    const sent1 = (await proofs()).find((p) => p.id === p2.id).sentAt;
    check(!!sent1, 'sentAt stored', sent1);
    await advance(60000);
    await ev('window.__shareReject = true');
    await click('.card.stop.done button.send-group');
    await waitFor('window.__shares.length === 2', 'the second share (backed out)');
    await sleep(300);
    check((await proofs()).find((p) => p.id === p2.id).sentAt === sent1 && await ev('(' + sendBtn + ').textContent') === 'SENT ✓', 'SENT ✓ can be tapped again; a rejected share changes nothing');
    await ev('window.__shareReject = false; window.__canShare = false');
    await click('.card.stop.done button.send-group');
    await waitFor('/This browser cannot share photos/.test(document.getElementById("banner").textContent)', 'the cannot-share notice');
    check(await ev('window.__shares.length') === 2 && (await proofs()).find((p) => p.id === p2.id).sentAt === sent1, 'canShare "no": no share, nothing changes');
    await ev('window.__canShare = true; document.querySelector("#banner button") && document.querySelector("#banner button").click()');

    console.log('6. Delta Works: Cancel deletes the draft; No photo');
    await reach('Delta Works');
    check(await primary('Delta Works') === '📷 PROOF', 'the in-hand delivery reads 📷 PROOF');
    await tapPrimary('Delta Works');
    await waitFor('document.getElementById("proofSheet")', 'the sheet at D');
    await ev('window.__feedPhoto(800, 600)');
    await waitFor('Proof.listProofs().then((a) => a.some((p) => p.state === "draft" && p.stopKey === "pD" && p.photoIds.length === 1))', 'the D draft');
    await click('#proofCancel');
    await waitFor('!document.getElementById("proofSheet")', 'the sheet closed');
    await waitFor('Proof.listProofs().then((a) => !a.some((p) => p.state === "draft"))', 'the draft deleted');
    check(!(await ev(planStop('pD') + '.status')), 'Cancel: draft gone, the stop still pending');
    await advance(60000);
    await tapPrimary('Delta Works');
    await waitFor('document.getElementById("proofSheet")', 'the sheet at D again');
    await click('#proofNoPhoto');
    const chips = await ev('[...document.querySelectorAll("#proofSheet .proof-reason")].map((b) => b.textContent)');
    check(chips.join('|') === 'Photos not allowed|Left at guard house|Camera problem|Other', 'four reason chips', chips);
    await ev('[...document.querySelectorAll("#proofSheet .proof-reason")].find((b) => b.textContent === "Left at guard house").click()');
    await waitFor(planStop('pD') + '.status === "done"', 'DONE at D (no photo)');
    const p3 = (await proofs()).find((p) => p.stopKey === 'pD' && p.state === 'done');
    check(p3 && p3.photoIds.length === 0 && p3.noPhotoReason === 'Left at guard house', 'a no-photo proof with its reason', p3);
    await click('#view ' + '.card.stop.done.has-send:not(:has(.sent)) button.send-group');
    await waitFor('window.__shares.length === 3', 'the text-only share');
    const sh3 = await ev('window.__shares[2]');
    check(!sh3.files && /^DELIVERED - Delta Works\nFuse\nNo photo: Left at guard house\n26 Nov 2026, \d+:\d\d (am|pm)$/.test(sh3.text), 'a no-photo proof shares the text only', sh3);

    console.log('7. CSV columns, Settings line, Export');
    const csv = await ev('(() => { const S = WaypointDebug.S, d = S.days[Object.keys(S.days).sort().pop()]; return DayLog.toCSV(DayLog.summarise(d, S.jobs, S.places)).trim().split("\\r\\n"); })()');
    check(csv[0].endsWith(',late,receiver,proof'), 'CSV header ends with receiver, proof', csv[0]);
    check(csv.some((l) => /,delivery,Gasket,.*,Encik Ali,1 photo$/.test(l)) && csv.some((l) => /,in-hand,Fuse,.*,,no photo: Left at guard house$/.test(l)) && csv.some((l) => /,errand,.*,,$/.test(l)), 'CSV rows: "1 photo" + receiver, "no photo: <reason>", empty for the errand', csv);
    await click('#tabs button[data-tab="settings"]');
    await waitFor('/deliveries/.test((document.getElementById("proofLine") || {}).textContent || "")', 'the Settings line');
    const line = await ev('document.getElementById("proofLine").textContent');
    check(/^2 deliveries · \d+\.\d MB on this phone · kept 2 years · storage: (protected|not protected)$/.test(line), 'Settings: "<N> deliveries · <X> MB on this phone · kept 2 years · storage: …"', line);
    check(await ev('document.querySelector("#proofCard h2").textContent') === 'Proof of delivery', 'under a "Proof of delivery" heading');

    console.log('8. retention: a 731-day-old proof goes on the next load, a 729-day-old one stays');
    await ev(`(async () => { const now = Date.now(), d = 86400000;
      for (const [id, days] of [['old731', 731], ['old729', 729]]) {
        await Proof.putProof({ id, state: 'done', dayKey: 'x', doneAt: new Date(now - days * d).toISOString(), placeId: 'pC', placeName: 'Old', address: '', jobIds: [], items: ['x'], receiver: '', noPhotoReason: '', gps: null, photoIds: [id + '_ph'], sentAt: null, driveAt: null });
        await Proof.putPhoto({ id: id + '_ph', proofId: id, blob: new Blob(['x'], { type: 'image/jpeg' }), bytes: 1, takenAt: now - days * d });
      } return true; })()`);
    await send('Page.navigate', { url: appUrl });
    await waitFor('window.Proof && document.querySelector("#tabs")', 'reload');
    await waitFor('Proof.listProofs().then((a) => !a.some((p) => p.id === "old731"))', 'retention to delete the old proof');
    const left = await ev('Promise.all([Proof.getProof("old729"), Proof.photosOf("old731"), Proof.photosOf("old729"), Proof.listProofs()]).then(([a, b, c, all]) => ({ kept: !!a, goneP: b.length, keptP: c.length, n: all.length }))');
    check(left.kept && left.goneP === 0 && left.keptP === 1 && left.n === 4, '731 days: proof and photo deleted; 729 days kept; nothing else deleted (both C proofs, D, old729)', left);
    const exp = await ev(`(async () => { let blob = null; const realCreate = URL.createObjectURL; URL.createObjectURL = (b) => { blob = b; return 'blob:x'; };
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Export JSON'); if (!btn) { WaypointDebug.S.tab = 'settings'; WaypointDebug.render(); }
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Export JSON').click(); for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 20));
      URL.createObjectURL = realCreate; const j = JSON.parse(await blob.text()); return { n: (j.proofs || []).length, photo: JSON.stringify(j.proofs).indexOf('blob') >= 0 || JSON.stringify(j.proofs).indexOf('data:image') >= 0, keys: Object.keys(j.proofs[0] || {}).sort().join() }; })()`);
    check(exp.n === 4 && !exp.photo, 'Export JSON carries the proof records (no photos)', exp);
    check(!page.logs.some((l) => /EXCEPTION/.test(l)), 'no page exceptions', page.logs);
  } catch (e) {
    fails++;
    console.log('  FAIL ' + e.message);
  } finally {
    await cleanup();
  }
  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  process.exit(fails ? 1 : 0);
}
main();
