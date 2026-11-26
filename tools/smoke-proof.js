#!/usr/bin/env node
/* Mocked browser smoke for proof of delivery (proof.js; no screenshots, no network, no real keys).
 *   node tools/smoke-proof.js
 * Serves the app from this repo on a free local port, drives a headless Chrome / Edge over the DevTools protocol at a 360 px wide
 * viewport, with TomTom, geolocation, the clipboard, navigator.canShare / navigator.share and the clock mocked inside the page.
 * The clock is PINNED: 26 Nov 2026 14:00 Malaysia time, moved only by the smoke (kept across reloads in sessionStorage).
 * World: S (supplier, collect a Gasket for C), C (customer, deliver it), D (customer, an in-hand Fuse), O (office errand).
 * The browser runs with --use-fake-device-for-media-stream / --use-fake-ui-for-media-stream: the in-app camera (camera.js) gets the
 * fake device (no facing mode, so exact "environment" fails and the chain goes on to a stream); getUserMedia is wrapped to record
 * every ask and stream.
 * Walk: PROOF only on the delivery stops (S and O keep ✓ DONE); Item photo / DO photo side by side; 2 item shots through the camera
 * view are saved at once under a draft; Done stops every track; a reload reopens the sheet with them; a DO shot opens the corner
 * screen (four handles, one dragged with the magnifier, Use), a second DO shot Keep as shot, a third Retake; Save & done completes
 * the stop: item photos <= 1600 px with the #00243c band, DO photos <= 2000 px without it; SEND TO GROUP passes item files before
 * DO files; the card is no taller than while pending; Undo voids the proof (photos kept); a new PROOF makes a new one;
 * SEND TO GROUP passes the right files + caption, the caption is copied, the button reads SENT ✓; a rejected share and canShare
 * "no" change nothing; on D: Cancel deletes the draft, No photo saves a reason and shares the text only; the CSV columns; retention
 * deletes a 731-day-old proof (and its photo) on the next load and keeps a 729-day-old one; the Settings line. A second world
 * (fresh storage, getUserMedia rejecting NotAllowedError): the camera view says so, "Use phone camera" falls back to the file input,
 * an item photo, a generated 4000 x 3000 JPEG of a skewed, unevenly lit page as a DO photo (devicePixelRatio 3 in this world: the
 * corner screen's canvas backing store >= CSS size x DPR, "4000 x 3000" at the bottom, Use -> long side 1800..2000, evenly light),
 * "From gallery" adding two DO photos without the corner screen; then the Settings toggle "Send caption with first photo (2 steps)":
 * tap 1 shares one file + the caption ("SEND REST (2)"), backing out keeps it, tap 2 the other two with no text, then SENT ✓.
 * Share names carry "01_", "02_", ... and lastModified 1000 ms apart in share order. Exit 1 on failure.
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
  if (location.protocol !== 'http:') return; // about:blank between the two worlds
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
    window.__shares.push({ text: d.text, files: d.files ? d.files.map((f) => ({ name: f.name, type: f.type, size: f.size, isFile: f instanceof File, lm: f.lastModified })) : null });
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
  // the camera: every getUserMedia ask recorded (constraints, outcome) and every stream kept; "?deny=1" refuses permission
  window.__gum = []; window.__streams = []; window.__fileClicks = [];
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const realGum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const rec = { c: JSON.parse(JSON.stringify(c)), ok: false, err: null }; window.__gum.push(rec);
      if (/deny=1/.test(location.search)) { rec.err = 'NotAllowedError'; throw new DOMException('Permission denied', 'NotAllowedError'); }
      try { const s = await realGum(c); rec.ok = true; window.__streams.push(s); return s; } catch (e) { rec.err = e.name; throw e; }
    };
  }
  const realInputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === 'file') window.__fileClicks.push(this.id); return realInputClick.call(this); };
  window.__liveTracks = () => window.__streams.reduce((n, s) => n + s.getTracks().filter((t) => t.readyState === 'live').length, 0);
  // the average colour of the bottom 4 rows of a photo blob, and its size
  window.__bottom = async (blob) => {
    const b = await createImageBitmap(blob); const c = document.createElement('canvas'); c.width = b.width; c.height = b.height;
    const g = c.getContext('2d'); g.drawImage(b, 0, 0); const d = g.getImageData(0, b.height - 5, b.width, 4).data; const s = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
    const n = d.length / 4; return { w: b.width, h: b.height, avg: s.map((v) => Math.round(v / n)), bytes: blob.size, type: blob.type };
  };
  // a generated JPEG (w x h, yellow) fed to the proof sheet's file input, as the phone's camera app would
  window.__feedPhoto = async (w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = 'rgb(255, 220, 0)'; g.fillRect(0, 0, w, h); g.fillStyle = 'rgb(200, 60, 40)'; g.fillRect(w / 4, h / 4, w / 2, h / 4);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const inp = document.getElementById('proofFile');
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'IMG_0001.jpg', { type: 'image/jpeg' }));
    inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    return blob.size;
  };
  // a generated w x h JPEG of a skewed page (lit unevenly: 150 on the left -> 215 on the right, a few dark text bars) on a dark
  // table, fed to the file input as the phone's camera app would
  window.__pagePhoto = async (w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = 'rgb(38, 40, 46)'; g.fillRect(0, 0, w, h);
    const q = [[0.275, 0.083], [0.7375, 0.127], [0.7625, 0.933], [0.2375, 0.9]].map(([x, y]) => [x * w, y * h]);
    const gr = g.createLinearGradient(q[0][0], 0, q[1][0], 0); gr.addColorStop(0, 'rgb(150, 150, 148)'); gr.addColorStop(1, 'rgb(215, 215, 212)');
    g.fillStyle = gr; g.beginPath(); q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
    g.fillStyle = 'rgb(45, 45, 50)';
    for (let k = 0; k < 6; k++) g.fillRect(0.34 * w, (0.2 + k * 0.05) * h, 0.3 * w, 0.012 * h);
    window.__pageQuad = q;
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  };
  window.__feedPage = async (w, h) => {
    const blob = await window.__pagePhoto(w, h);
    const inp = document.getElementById('proofFile');
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'IMG_0002.jpg', { type: 'image/jpeg' }));
    inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    return blob.size;
  };
  // n generated JPEGs (already-scanned pages, 1200 x 1700) picked at once in the gallery input
  window.__pickGallery = async (n) => {
    const dt = new DataTransfer();
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas'); c.width = 1200; c.height = 1700;
      const g = c.getContext('2d'); g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, 1200, 1700); g.fillStyle = '#222'; g.fillRect(100, 100 + i * 50, 800, 30);
      dt.items.add(new File([await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))], 'SCAN_' + (i + 1) + '.jpg', { type: 'image/jpeg' }));
    }
    const inp = document.getElementById('proofGallery');
    inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    return n;
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
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
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
    const sheet = await ev('(() => { const s = document.getElementById("proofSheet"), r = s.getBoundingClientRect(), f = document.getElementById("proofFile"); return { title: s.querySelector("h3").textContent, items: [...s.querySelectorAll("#proofItems .act")].map((x) => x.textContent), full: r.width >= document.documentElement.clientWidth && r.height >= innerHeight, rw: r.width, rh: r.height, vh: innerHeight, accept: f.accept, capture: f.getAttribute("capture"), type: f.type, save: document.getElementById("proofSave").disabled, rcvMax: document.getElementById("proofReceiver").maxLength, noPhoto: !!document.getElementById("proofNoPhoto"), cancel: !!document.getElementById("proofCancel"), take: !!document.getElementById("proofTake") }; })()');
    check(sheet.title === 'Beta Customer' && sheet.items.join() === 'Gasket' && sheet.full, 'full-screen sheet: the place name and the item delivered', sheet);
    check(sheet.type === 'file' && sheet.accept === 'image/*' && sheet.capture === 'environment' && sheet.save === true && sheet.rcvMax === 40 && sheet.noPhoto && sheet.cancel && !sheet.take, 'fallback camera input kept, no single Take photo, Save & done off with no photo, Received by max 40, No photo, Cancel', sheet);
    const btns = await ev('(() => { const a = document.getElementById("proofItemBtn").getBoundingClientRect(), b = document.getElementById("proofDoBtn").getBoundingClientRect(), s = document.getElementById("proofSheet"); return { a: document.getElementById("proofItemBtn").textContent, b: document.getElementById("proofDoBtn").textContent, sameRow: Math.abs(a.top - b.top) < 1, aw: Math.round(a.width), bw: Math.round(b.width), right: Math.round(b.right), vw: document.documentElement.clientWidth, h: Math.round(a.height), overflow: s.scrollWidth > s.clientWidth }; })()');
    check(btns.a === 'Item photo' && btns.b === 'DO photo' && btns.sameRow && btns.right <= btns.vw && Math.abs(btns.aw - btns.bw) <= 1 && btns.h >= 44 && !btns.overflow, 'Item photo and DO photo side by side at 360 px (no overflow)', btns);

    console.log('2a. the in-app camera: 2 item shots');
    await click('#proofItemBtn');
    await waitFor('document.getElementById("camView") && !document.getElementById("camShutter").disabled', 'the camera view with a live stream', 15000);
    const cam = await ev('(() => { const v = document.getElementById("camVideo"), r = document.getElementById("camView").getBoundingClientRect(); return { count: document.getElementById("camCount").textContent, full: r.width >= document.documentElement.clientWidth && r.height >= innerHeight, vw: v.videoWidth, vh: v.videoHeight, done: !!document.getElementById("camDone"), sw: document.getElementById("camSwitch").hidden, gum: window.__gum }; })()');
    check(cam.full && cam.count === '0 of 6' && cam.done && cam.vw > 0, 'full-screen live preview, counter "0 of 6", Done', cam);
    check(cam.gum.length >= 2 && cam.gum[0].c.video.facingMode && cam.gum[0].c.video.facingMode.exact === 'environment' && cam.gum[0].c.video.width.ideal === 4000 && !cam.gum[0].ok && cam.gum[cam.gum.length - 1].ok,
      'the chain: exact "environment" first (refused by the fake device), then a later step gives the stream', cam.gum.map((g) => ({ v: g.c.video, ok: g.ok, err: g.err })));
    check(cam.gum.every((g) => !/"user"/.test(JSON.stringify(g.c))) && cam.gum.every((g) => g.c.audio === false), 'the front camera is never asked for; no audio', cam.gum.map((g) => g.c));
    check(cam.sw === true, 'Switch lens hidden: the fake device is not more than one back camera');
    await ev('window.__watchFire({ lat: 3.125 + 20 / 111190, lng: 101.705, accuracy: 12 })'); // a fresh fix at capture
    await click('#camShutter');
    await waitFor('document.getElementById("camCount").textContent === "1 of 6"', 'shot 1', 15000);
    check(await ev('document.getElementById("camFlash").classList.contains("on")'), 'a flash shows the shot was taken');
    await advance(2000);
    await click('#camShutter');
    await waitFor('document.getElementById("camCount").textContent === "2 of 6"', 'shot 2', 15000);
    await waitFor('Proof.listProofs().then((a) => a.some((p) => p.state === "draft" && p.photoIds.length === 2))', 'the draft in IndexedDB');
    const d1 = (await proofs()).find((p) => p.state === 'draft');
    const d1ph = await ev('Proof.photosOf(' + JSON.stringify(d1 && d1.id) + ').then((a) => a.map((p) => ({ kind: p.kind, takenAt: p.takenAt, gps: !!p.gps, bytes: p.bytes, srcW: p.srcW, srcH: p.srcH })))');
    check(d1 && d1.stopKey === 'pC' && d1.gps && Math.abs(d1.gps.lat - 3.12518) < 0.0001 && d1.gps.acc === 12, 'draft saved the moment each shot was taken, with the GPS fix', d1);
    check(d1ph.length === 2 && d1ph.every((p) => p.kind === 'item' && p.gps && p.bytes > 0) && d1ph[1].takenAt - d1ph[0].takenAt === 2000, 'two item photos, each with its capture time and fix', d1ph);
    const still1 = await ev('Camera.lastStill()');
    // diagnostic only (the old call): takePhoto() with no size, and the video frame, on the same track
    const old1 = await ev('(async () => { const v = document.getElementById("camVideo"), t = v.srcObject && v.srcObject.getVideoTracks()[0]; let p = null; try { const b = await new ImageCapture(t).takePhoto(); const bm = await createImageBitmap(b); p = bm.width + " x " + bm.height; } catch (e) { p = "failed: " + e.name; } return { noSize: p, frame: v.videoWidth + " x " + v.videoHeight }; })()').catch((e) => ({ err: e.message }));
    console.log('  info fake device: takePhoto() with no size -> ' + old1.noSize + '; video frame ' + old1.frame + '; with the largest size offered -> ' + (still1 && still1.w + ' x ' + still1.h));
    check(d1ph.every((p) => p.srcW > 0 && p.srcH > 0 && p.srcW === still1.w && p.srcH === still1.h), 'each item photo records srcW x srcH, the still the camera gave (fake device: ' + (still1 && still1.w + ' x ' + still1.h + ' from ' + still1.from) + ')', { d1ph, still1 });
    check(await ev('!!document.getElementById("camView")'), 'the camera view stays open for the next item shot');
    await click('#camDone');
    await waitFor('!document.getElementById("camView")', 'the camera view closed');
    await waitFor('window.__liveTracks() === 0', 'every track stopped');
    check(await ev('window.__streams.length >= 1 && window.__streams.every((s) => s.getTracks().every((t) => t.readyState === "ended"))'), 'Done: every track of every stream stopped');
    const th = await ev('(() => [...document.querySelectorAll("#proofThumbs .proof-group")].map((g) => ({ k: g.dataset.kind, h: g.querySelector(".proof-group-h").textContent, n: g.querySelectorAll(".proof-thumb").length })))()');
    check(th.length === 1 && th[0].k === 'item' && th[0].h === 'Item' && th[0].n === 2, 'thumbnails under the "Item" heading', th);
    check(await ev('Object.keys(localStorage).every((k) => (localStorage.getItem(k) || "").indexOf("data:image") < 0)') && (await ev('(localStorage.getItem(Camera.LENS_KEY) || "").length')) < 300, 'no photo data in localStorage (only the lens id)');
    check(await ev('!document.getElementById("proofSave").disabled'), 'Save & done is enabled with a photo');
    await send('Page.navigate', { url: appUrl });
    await waitFor('document.getElementById("proofSheet") && document.querySelectorAll("#proofThumbs .proof-thumb").length === 2', 'the sheet reopened with the draft photos after the reload');
    check(true, 'reload with a draft for a pending stop: the sheet reopens with its photos');

    console.log('2b. DO shots: the corner screen (drag, Use), Keep as shot, Retake');
    await click('#proofDoBtn');
    await waitFor('document.getElementById("camView") && !document.getElementById("camShutter").disabled', 'the camera view (DO)', 15000);
    check(await ev('document.getElementById("camCount").textContent') === '0 of 6', 'DO counter "0 of 6" (counted per kind)');
    await click('#camShutter');
    await waitFor('document.getElementById("scanScreen") && document.querySelectorAll("#scanScreen .scan-handle").length === 4 && document.getElementById("scanImg").width > 0', 'the corner screen', 15000);
    const hs = await ev('(() => { const im = document.getElementById("scanImg").getBoundingClientRect(); return { img: { l: im.left, t: im.top, r: im.right, b: im.bottom }, hs: [...document.querySelectorAll("#scanScreen .scan-handle")].map((x) => { const r = x.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height }; }), lines: !!document.querySelector("#scanScreen .scan-lines polygon[points]"), btns: [...document.querySelectorAll("#scanScreen .scan-actions button")].map((b) => b.textContent) }; })()');
    const inImg = (p, im) => p.cx >= im.l - 0.5 && p.cx <= im.r + 0.5 && p.cy >= im.t - 0.5 && p.cy <= im.b + 0.5;
    check(hs.hs.length === 4 && hs.hs.every((x) => x.w >= 44 && x.h >= 44 && inImg(x, hs.img)) && hs.lines, 'four round handles (>= 44 px targets) on the image, joined by lines', hs);
    check(hs.btns.join('|') === 'Retake|Keep as shot|Use', 'buttons Retake, Keep as shot, Use', hs.btns);
    const cs1 = await ev('(() => { const c = document.getElementById("scanClean"), s = document.getElementById("scanSrc"), r = s.getBoundingClientRect(), a = document.querySelector("#scanScreen .scan-actions").getBoundingClientRect(); return { clean: !!c && c.checked, label: c && c.closest("label").textContent.trim(), src: s.textContent, still: Camera.lastStill(), below: r.top >= a.bottom - 0.5, bottom: Math.round(r.bottom), vh: innerHeight, fs: getComputedStyle(s).fontSize }; })()');
    check(cs1.clean && cs1.label === 'Clean up page', 'the corner screen: "Clean up page", on by default', cs1);
    check(cs1.src === cs1.still.w + ' x ' + cs1.still.h && cs1.below && cs1.bottom <= cs1.vh && cs1.fs === '11px', 'the still\'s pixel size in small text at the bottom ("' + cs1.src + '")', cs1);
    const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    const h0 = hs.hs[0];
    await mouse('mousePressed', h0.cx, h0.cy);
    for (let k = 1; k <= 5; k++) await mouse('mouseMoved', h0.cx + 4 * k, h0.cy + 3 * k);
    const mag = await ev('(() => { const m = document.getElementById("scanMag"), r = m.getBoundingClientRect(); return { shown: !m.hidden && r.width > 0, l: r.left, t: r.top, r: r.right, b: r.bottom }; })()');
    const fx = h0.cx + 20, fy = h0.cy + 15;
    check(mag.shown && !(fx >= mag.l && fx <= mag.r && fy >= mag.t && fy <= mag.b), 'while dragging: a magnifier, away from the finger', { mag, finger: [fx, fy] });
    await mouse('mouseReleased', fx, fy);
    const moved = await ev('(() => { const r = document.querySelector("#scanScreen .scan-handle").getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, mag: document.getElementById("scanMag").hidden }; })()');
    check(Math.abs(moved.cx - fx) < 1.5 && Math.abs(moved.cy - fy) < 1.5 && moved.mag, 'the handle followed the drag; the magnifier hides on release', { moved, fx, fy });
    const h2 = hs.hs[2];
    await mouse('mousePressed', h2.cx, h2.cy);
    await mouse('mouseMoved', h2.cx + 400, h2.cy + 900);
    await mouse('mouseReleased', h2.cx + 400, h2.cy + 900);
    const h2b = await ev('(() => { const r = document.querySelectorAll("#scanScreen .scan-handle")[2].getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()');
    check(inImg(h2b, hs.img), 'a handle cannot leave the image', { h2b, img: hs.img });
    await click('#scanUse');
    await waitFor('!document.getElementById("scanScreen") && document.getElementById("camCount").textContent === "1 of 6"', 'Use: back to the camera, DO 1 of 6', 20000);
    const doRec = await ev('Proof.listProofs().then((a) => a.find((p) => p.state === "draft")).then((p) => Proof.photosOf(p.id)).then((a) => a.filter((x) => x.kind === "do")).then(async (a) => ({ n: a.length, size: a.length ? await window.__bottom(a[0].blob) : null }))');
    check(doRec.n === 1 && doRec.size && Math.max(doRec.size.w, doRec.size.h) <= 2000, 'Use: the straightened page saved as the DO photo (long side <= 2000 px), the original not kept', doRec);
    await advance(3000);
    await click('#camShutter');
    await waitFor('document.getElementById("scanScreen")', 'the corner screen (2)', 15000);
    await click('#scanKeep');
    await waitFor('!document.getElementById("scanScreen") && document.getElementById("camCount").textContent === "2 of 6"', 'Keep as shot: DO 2 of 6', 15000);
    await click('#camShutter');
    await waitFor('document.getElementById("scanScreen")', 'the corner screen (3)', 15000);
    await click('#scanRetake');
    await waitFor('!document.getElementById("scanScreen") && !!document.getElementById("camView")', 'Retake: back to the camera', 15000);
    await sleep(300);
    check(await ev('document.getElementById("camCount").textContent') === '2 of 6', 'Retake: the shot discarded (still 2 of 6)');
    await click('#camDone');
    await waitFor('!document.getElementById("camView") && window.__liveTracks() === 0', 'the camera closed, every track stopped');
    const th2 = await ev('(() => [...document.querySelectorAll("#proofThumbs .proof-group")].map((g) => ({ k: g.dataset.kind, h: g.querySelector(".proof-group-h").textContent, n: g.querySelectorAll(".proof-thumb").length })))()');
    check(th2.map((g) => g.h + ':' + g.n).join() === 'Item:2,DO:2', 'thumbnails grouped: Item (2), DO (2)', th2);
    check(await ev('document.querySelector("#proofThumbs .proof-group[data-kind=do] .proof-del") && document.querySelector("#proofThumbs .proof-group[data-kind=do] .proof-del").getBoundingClientRect().width >= 32'), 'each thumbnail removable');

    console.log('3. Save & done: stamped, the stop completed by markDone');
    await ev('(() => { const r = document.getElementById("proofReceiver"); r.value = "Encik Ali"; r.dispatchEvent(new Event("change")); return true; })()');
    await advance(30000);
    await click('#proofSave');
    await waitFor(planStop('pC') + '.status === "done" && !document.getElementById("proofSheet")', 'DONE at C through the sheet', 20000);
    const p1 = (await proofs()).find((p) => p.state === 'done');
    check(p1 && p1.receiver === 'Encik Ali' && p1.photoIds.length === 4 && p1.sentAt == null && p1.driveAt === null && p1.items.join() === 'Gasket', 'proof done: receiver, 4 photos, sentAt / driveAt null', p1);
    const imgs = await ev(`(async () => { const p = (await Proof.listProofs()).find((x) => x.state === 'done'); const out = [];
      for (const id of p.photoIds) { const ph = await Proof.getPhoto(id); const b = await createImageBitmap(ph.blob);
        const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; const g = c.getContext('2d'); g.drawImage(b, 0, 0);
        const band = g.getImageData(0, Math.round(b.height * 0.75), b.width, Math.round(b.height * 0.25) - 1).data; let white = 0;
        for (let i = 0; i < band.length; i += 4) if (band[i] > 220 && band[i + 1] > 220 && band[i + 2] > 220) white++;
        const bt = await window.__bottom(ph.blob);
        out.push({ kind: ph.kind, w: b.width, h: b.height, type: ph.blob.type, bytes: ph.blob.size, rec: ph.bytes, bottom: bt.avg, white }); }
      return { counts: p.counts, out }; })()`);
    // the band is #00243c at 85% over the photo: each channel within 0.15 x 255 (+ JPEG slack) above (0, 31, 51)
    const isBand = (c) => c[0] <= 46 && c[1] >= 23 && c[1] <= 77 && c[2] >= 43 && c[2] <= 97 && c[2] > c[0] + 20;
    const items = imgs.out.filter((x) => x.kind === 'item'), dos = imgs.out.filter((x) => x.kind === 'do');
    check(items.length === 2 && dos.length === 2 && JSON.stringify(imgs.counts) === '{"item":2,"do":2}', 'saved: 2 item and 2 DO photos, counts on the proof', imgs.counts);
    check(items.every((x) => Math.max(x.w, x.h) <= 1600 && x.type === 'image/jpeg' && x.bytes <= 400 * 1024 && x.rec === x.bytes), 'item photos: long side <= 1600 px, JPEG <= 400 KB, bytes recorded', items);
    check(items.every((x) => isBand(x.bottom)) && items.every((x) => x.white > 500), 'item photos: the bottom strip is the #00243c band, with white logo / text', items.map((x) => ({ bottom: x.bottom, white: x.white })));
    check(dos.every((x) => Math.max(x.w, x.h) <= 2000 && x.type === 'image/jpeg' && x.rec === x.bytes), 'DO photos: long side <= 2000 px, JPEG', dos);
    check(dos.every((x) => !isBand(x.bottom)), 'DO photos: the bottom strip is not the band (no band, no logo, no text)', dos.map((x) => x.bottom));
    const job1 = await ev('(() => { const j = WaypointDebug.S.jobs.find((x) => x.id === "j1"); const d = WaypointDebug.S.days[Object.keys(WaypointDebug.S.days).sort().pop()]; const e = d.events.filter((x) => x.type === "done" && x.kind === "deliver" && x.jobId === "j1").pop(); return { status: j.status, proofId: j.proofId, ev: e && e.proofId, sum: e && e.proof }; })()');
    check(job1.status === 'done' && job1.proofId === p1.id && job1.ev === p1.id && job1.sum.photos === 4 && job1.sum.itemPhotos === 2 && job1.sum.doPhotos === 2 && job1.sum.receiver === 'Encik Ali', 'the proof id is on the job record and the done event (2 item, 2 DO)', job1);
    const hDone = await cardH('Beta Customer');
    check(hDone <= hPending && hDone <= hReached, 'the done card is no taller than while pending (' + hDone + ' <= ' + hPending + ' / ' + hReached + ' px)', { hDone, hPending, hReached });
    const sendBtn = '(' + cardOf('Beta Customer') + ').querySelector("button.send-group")';
    const sb = await ev('(() => { const b = ' + sendBtn + '; if (!b) return null; const cs = getComputedStyle(b), i = b.querySelector("img"); return { text: b.textContent, bg: cs.backgroundColor, fg: cs.color, img: i && i.getAttribute("src"), imgH: i && Math.round(i.getBoundingClientRect().height), loaded: i && i.complete && i.naturalWidth > 0 }; })()');
    check(sb && sb.text === 'SEND TO GROUP' && sb.bg === 'rgb(37, 211, 102)' && sb.fg === 'rgb(13, 20, 27)', 'SEND TO GROUP: green with dark text', sb);
    check(sb && sb.img === 'whatsapp-glyph.svg' && sb.imgH === 18 && sb.loaded, 'the pack glyph, 18 px high, left of the label', sb);
    await click('.card.stop.done button.send-group');
    await waitFor('window.__shares.length === 1', 'the share of the mixed proof');
    const sh0 = await ev('window.__shares[0]');
    check(sh0.files && sh0.files.map((f) => f.name).join() === ['01_', '02_', '03_', '04_'].map((n, i) => n + '2026-11-26_beta-customer_' + ['item_1', 'item_2', 'DO_1', 'DO_2'][i] + '.jpg').join() && sh0.files.every((f) => f.isFile && f.type === 'image/jpeg'),
      'share(): item files first (01_ item_1, 02_ item_2), then DO files (03_ DO_1, 04_ DO_2)', sh0.files);
    check(sh0.files.every((f, i) => i === 0 || f.lm - sh0.files[i - 1].lm === 1000), 'lastModified: the first file the earliest, each next 1000 ms later', sh0.files.map((f) => f.lm));
    check(/^DELIVERED - Beta Customer\nGasket\nReceived by: Encik Ali\n26 Nov 2026, \d+:\d\d (am|pm)$/.test(sh0.text), 'the caption text is unchanged', sh0.text);
    await waitFor('(' + sendBtn + ' || {}).textContent === "SENT ✓"', 'SENT ✓ after the mixed share');
    await ev('window.__shares = []; true');

    console.log('4. Undo voids the proof (photos kept); a later PROOF makes a new one');
    await click('.card.stop.done button.undo');
    await waitFor('!' + planStop('pC') + '.status', 'C pending again');
    await waitFor('Proof.getProof(' + JSON.stringify(p1.id) + ').then((p) => p && p.state === "void")', 'the proof voided');
    check(await ev('Proof.photosOf(' + JSON.stringify(p1.id) + ').then((a) => a.length)') === 4, 'its photos are kept (all 4)');
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
    check(sh1.files && sh1.files.length === 1 && sh1.files[0].isFile && sh1.files[0].type === 'image/jpeg' && sh1.files[0].name === '01_2026-11-26_beta-customer_item_1.jpg', 'share files: the stamped JPEG named "01_" + fileName() (the shown name, Sdn Bhd dropped)', sh1.files);
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
    check(csv.some((l) => /,delivery,Gasket,.*,Encik Ali,"1 item, 0 DO photos"$/.test(l)) && csv.some((l) => /,in-hand,Fuse,.*,,no photo: Left at guard house$/.test(l)) && csv.some((l) => /,errand,.*,,$/.test(l)), 'CSV rows: "1 item, 0 DO photos" + receiver, "no photo: <reason>", empty for the errand', csv);
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

    console.log('9. a second world: camera permission refused -> "Use phone camera" (the file input)');
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Storage.clearDataForOrigin', { origin: new URL(appUrl).origin, storageTypes: 'all' });
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 3, mobile: false }); // as a phone screen
    await send('Page.navigate', { url: appUrl + '?deny=1' });
    await waitFor('document.querySelector("#planBtn") && window.Proof', 'the Plan tab (fresh storage)');
    check(await ev('Proof.listProofs().then((a) => a.length)') === 0, 'fresh storage: no proofs');
    await click('#planBtn');
    await waitFor('window.WaypointDebug && WaypointDebug.S.plan && WaypointDebug.S.tab === "route" && document.querySelectorAll(".timeline .card.stop").length >= 4', 'the planned route (2nd world)');
    await reach('Delta Works');
    await tapPrimary('Delta Works');
    await waitFor('document.getElementById("proofSheet")', 'the sheet at D (2nd world)');
    await click('#proofItemBtn');
    await waitFor('document.getElementById("camView") && !document.getElementById("camMsg").hidden', 'the refused-camera message');
    const deny = await ev('(() => ({ text: document.querySelector("#camMsg p").textContent, btn: (document.getElementById("camFallback") || {}).textContent, gum: window.__gum.length, err: window.__gum.map((g) => g.err), shutter: document.getElementById("camShutter").disabled }))()');
    check(/permission/i.test(deny.text) && deny.text.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length === 1 && deny.btn === 'Use phone camera' && deny.shutter, 'one plain sentence and "Use phone camera"; no shutter', deny);
    check(deny.gum === 1 && deny.err[0] === 'NotAllowedError', 'NotAllowedError stops the chain at once (1 ask)', deny);
    await click('#camFallback');
    await waitFor('!document.getElementById("camView")', 'the camera view closed (fallback)');
    check(await ev('window.__fileClicks[window.__fileClicks.length - 1]') === 'proofFile', '"Use phone camera" opens the file input (capture=environment)');
    await ev('window.__feedPhoto(1600, 1200)');
    await waitFor('document.querySelectorAll("#proofThumbs .proof-group[data-kind=item] .proof-thumb").length === 1', 'the item photo from the phone camera');
    await click('#proofDoBtn');
    await waitFor('document.getElementById("camFallback")', 'the refused-camera message (DO)');
    await click('#camFallback');
    await waitFor('!document.getElementById("camView")', 'the camera view closed (DO fallback)');
    // a 4000 x 3000 camera-app JPEG of a skewed, unevenly lit page on a dark table (devicePixelRatio 3 in this world, as the S23)
    await ev('window.__feedPage(4000, 3000)');
    await waitFor('document.getElementById("scanScreen") && document.querySelectorAll("#scanScreen .scan-handle").length === 4 && document.getElementById("scanImg").width > 0', 'a phone-camera DO photo goes through the corner screen', 20000);
    const cs2 = await ev('(() => { const c = document.getElementById("scanImg"), r = c.getBoundingClientRect(); return { dpr: devicePixelRatio, bw: c.width, bh: c.height, cw: r.width, ch: r.height, src: document.getElementById("scanSrc").textContent, clean: document.getElementById("scanClean").checked }; })()');
    check(cs2.dpr === 3 && cs2.bw >= Math.ceil(cs2.cw * cs2.dpr) - 0.5 && cs2.bh >= Math.ceil(cs2.ch * cs2.dpr) - 0.5, 'corner screen: the canvas backing store is at least its CSS size x devicePixelRatio (' + cs2.bw + ' x ' + cs2.bh + ' for ' + cs2.cw + ' x ' + cs2.ch + ' CSS px at ' + cs2.dpr + 'x)', cs2);
    check(cs2.src === '4000 x 3000' && cs2.clean, 'corner screen text "4000 x 3000"; Clean up page on', cs2);
    const hq = await ev('(() => { const im = document.getElementById("scanImg").getBoundingClientRect(), k = im.width / 4000; return { hs: [...document.querySelectorAll("#scanScreen .scan-handle")].map((x) => { const r = x.getBoundingClientRect(); return [(r.left + r.width / 2 - im.left) / k, (r.top + r.height / 2 - im.top) / k]; }), q: window.__pageQuad }; })()');
    const hErr = hq.hs.map((p, i) => Math.hypot(p[0] - hq.q[i][0], p[1] - hq.q[i][1]));
    check(hErr.every((e) => e <= 40), 'the detected corners sit on the page corners (within 40 px of 4000: ' + hErr.map((e) => Math.round(e)).join(', ') + ')', hErr);
    await click('#scanUse');
    await waitFor('!document.getElementById("scanScreen") && document.querySelectorAll("#proofThumbs .proof-group[data-kind=do] .proof-thumb").length === 1', 'the DO photo from the phone camera', 30000);
    const do9 = await ev(`(async () => { const p = (await Proof.listProofs()).find((x) => x.state === 'draft'); const ph = (await Proof.photosOf(p.id)).find((x) => x.kind === 'do');
      const b = await createImageBitmap(ph.blob); const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; const g = c.getContext('2d'); g.drawImage(b, 0, 0);
      const lumAt = (fx, fy) => { const d = g.getImageData(Math.round(b.width * fx) - 20, Math.round(b.height * fy) - 20, 40, 40).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return s / (d.length / 4); };
      return { w: b.width, h: b.height, srcW: ph.srcW, srcH: ph.srcH, left: Math.round(lumAt(0.12, 0.75)), right: Math.round(lumAt(0.88, 0.75)), mid: Math.round(lumAt(0.5, 0.8)) }; })()`);
    check(Math.max(do9.w, do9.h) >= 1800 && Math.max(do9.w, do9.h) <= 2000, 'Use: the saved DO long side between 1800 and 2000 px (' + do9.w + ' x ' + do9.h + ')', do9);
    check(do9.srcW === 4000 && do9.srcH === 3000, 'the DO photo record carries srcW x srcH = 4000 x 3000', do9);
    check(do9.left > 225 && do9.right > 225 && Math.abs(do9.left - do9.right) <= 15, 'cleaned up: the page is evenly light (left ' + do9.left + ', right ' + do9.right + '; shot at 150 -> 215)', do9);
    // From gallery: the DO camera view's text button opens a multi-select picker (no capture); the picks skip the corner screen
    await click('#proofDoBtn');
    await waitFor('document.getElementById("camView") && document.getElementById("camGallery")', 'the DO camera view with From gallery');
    const gal = await ev('(() => { const b = document.getElementById("camGallery"), i = document.getElementById("proofGallery"), r = b.getBoundingClientRect(); return { text: b.textContent, inView: r.right <= innerWidth && r.left >= 0 && r.height >= 44, multiple: i.multiple, accept: i.accept, capture: i.hasAttribute("capture") }; })()');
    check(gal.text === 'From gallery' && gal.inView && gal.multiple && gal.accept === 'image/*' && !gal.capture, '"From gallery": a text button in the DO camera view; <input type=file accept=image/* multiple>, no capture attribute', gal);
    await advance(5000);
    await click('#camGallery');
    check(await ev('window.__fileClicks[window.__fileClicks.length - 1]') === 'proofGallery', 'From gallery opens the gallery input');
    await ev('window.__scanSeen = false; window.__scanObs = new MutationObserver(() => { if (document.getElementById("scanScreen")) window.__scanSeen = true; }); window.__scanObs.observe(document.body, { childList: true, subtree: true }); true');
    await ev('window.__pickGallery(2)');
    await waitFor('document.querySelectorAll("#proofThumbs .proof-group[data-kind=do] .proof-thumb").length === 3', 'two DO photos from the gallery');
    check(!(await ev('window.__scanSeen')) && await ev('document.getElementById("camCount").textContent') === '3 of 6', 'From gallery: two DO photos added without the corner screen; the counter reads 3 of 6');
    await ev('window.__scanObs.disconnect(); true');
    const galRec = await ev('Proof.listProofs().then((a) => a.find((p) => p.state === "draft")).then((p) => Proof.photosOf(p.id)).then((a) => a.filter((x) => x.kind === "do").sort((x, y) => x.takenAt - y.takenAt).slice(1).map((x) => ({ srcW: x.srcW, srcH: x.srcH, type: x.blob.type })))');
    check(galRec.length === 2 && galRec.every((x) => x.srcW === 1200 && x.srcH === 1700), 'gallery photos record their own size (1200 x 1700)', galRec);
    await click('#camDone');
    await waitFor('!document.getElementById("camView")', 'the camera view closed (gallery)');
    await ev('document.querySelector("#proofThumbs .proof-group[data-kind=do] .proof-thumb:last-child .proof-del").click()');
    await waitFor('document.querySelectorAll("#proofThumbs .proof-group[data-kind=do] .proof-thumb").length === 2', 'one gallery photo removed (1 item + 2 DO left)');
    await click('#proofSave');
    await waitFor('WaypointDebug.S.plan.result.plans[0].stops.find((s) => s.placeId === "pD").status === "done"', 'DONE at D through the file-input fallback', 30000);
    const p9 = await ev('Proof.listProofs().then((a) => a.find((p) => p.state === "done")).then(async (p) => ({ counts: p.counts, n: p.photoIds.length, kinds: (await Proof.photosOf(p.id)).map((x) => x.kind).sort().join(), src: (await Proof.photosOf(p.id)).map((x) => x.srcW + "x" + x.srcH), dims: await Promise.all((await Proof.photosOf(p.id)).map(async (x) => { const b = await window.__bottom(x.blob); return x.kind + ":" + b.w + "x" + b.h; })) }))');
    check(p9.n === 3 && p9.kinds === 'do,do,item' && JSON.stringify(p9.counts) === '{"item":1,"do":2}', 'completed: 1 item (file input) + 1 DO (corner screen) + 1 DO (gallery)', p9);
    check(p9.src.indexOf('4000x3000') >= 0 && p9.src.indexOf('1600x1200') >= 0 && p9.src.indexOf('1200x1700') >= 0, 'srcW x srcH kept on the saved photos', p9.src);

    console.log('10. SEND TO GROUP in two steps (Settings: Send caption with first photo)');
    await click('#tabs button[data-tab="settings"]');
    await waitFor('document.getElementById("proofCaptionFirst")', 'the Settings toggle');
    const tg = await ev('(() => { const c = document.getElementById("proofCaptionFirst"); return { on: c.checked, label: c.closest("label").textContent.trim(), inCard: !!c.closest("#proofCard") }; })()');
    check(!tg.on && tg.label === 'Send caption with first photo (2 steps)' && tg.inCard, 'under "Proof of delivery": "Send caption with first photo (2 steps)", off by default', tg);
    await click('#proofCaptionFirst');
    check(await ev('WaypointDebug.S.settings.proofCaptionFirst === true'), 'the toggle turned on and saved');
    await click('#tabs button[data-tab="route"]');
    const sendD = '(' + cardOf('Delta Works') + ').querySelector("button.send-group")';
    await waitFor(sendD, 'SEND TO GROUP on D');
    const hSend = await cardH('Delta Works');
    await ev('window.__shares = []; window.__copied = []; true');
    await click('.card.stop.done button.send-group');
    await waitFor('window.__shares.length === 1', 'tap 1');
    await waitFor('(' + sendD + ' || {}).textContent === "SEND REST (2)"', 'the button to read SEND REST (2)');
    const t1 = await ev('window.__shares[0]');
    check(t1.files && t1.files.length === 1 && t1.files[0].name === '01_2026-11-26_delta-works_item_1.jpg' && /^DELIVERED - Delta Works\nFuse\n26 Nov 2026, \d+:\d\d (am|pm)$/.test(t1.text), 'tap 1: exactly one file (01_ item_1) and the caption', t1);
    check(await ev('window.__copied.length') === 1 && !(await proofs()).find((p) => p.stopKey === 'pD' && p.state === 'done').sentAt, 'tap 1: the caption copied; sentAt not set yet');
    check(await cardH('Delta Works') <= hSend, 'SEND REST (2) does not make the card taller', { h: await cardH('Delta Works'), hSend });
    await ev('window.__shareReject = true');
    await click('.card.stop.done button.send-group');
    await waitFor('window.__shares.length === 2', 'tap 2 (backed out)');
    await sleep(300);
    check(await ev('(' + sendD + ').textContent') === 'SEND REST (2)' && !(await proofs()).find((p) => p.stopKey === 'pD' && p.state === 'done').sentAt, 'backing out of tap 2 keeps the button on SEND REST (2)');
    await ev('window.__shareReject = false');
    await click('.card.stop.done button.send-group');
    await waitFor('window.__shares.length === 3', 'tap 2');
    const t2 = await ev('window.__shares[2]');
    check(t2.files && t2.files.map((f) => f.name).join() === '02_2026-11-26_delta-works_DO_1.jpg,03_2026-11-26_delta-works_DO_2.jpg' && t2.text == null, 'tap 2: the other two files (02_ DO_1, 03_ DO_2) and no text', t2);
    check(t1.files[0].lm < t2.files[0].lm && t2.files[1].lm - t2.files[0].lm === 1000, 'lastModified increasing across the two shares', [t1.files[0].lm, t2.files[0].lm, t2.files[1].lm]);
    await waitFor('(' + sendD + ' || {}).textContent === "SENT ✓"', 'SENT ✓ after tap 2');
    check(!!(await proofs()).find((p) => p.stopKey === 'pD' && p.state === 'done').sentAt && await ev('window.__copied.length') === 1, 'SENT ✓, sentAt set only after tap 2; the caption copied on tap 1 only');
    check(!page.logs.some((l) => /EXCEPTION/.test(l)), 'no page exceptions (2nd world)', page.logs);
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
