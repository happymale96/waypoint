/* L-Tech Waypoint — proof.js: proof of delivery.
 * Pure (node + browser): isProofStop, caption, stampLines, expired, fileName, slug, kindOf, shareList, shareFiles ("01_" names and
 * increasing lastModified in share order), sendStep / afterShare / sendLabel (SEND TO GROUP in one or two taps), countKinds, klDate helpers.
 * Two kinds of photo: "item" (stamped with the band) and "do" (the delivery order: no band); a photo with no kind is an item photo.
 * Browser only: the IndexedDB store "waypoint-proof" (v1; stores "proofs" and "photos"), compose (the stamped item JPEG), composeDo,
 * persistOnce (navigator.storage.persist, asked once), runRetention (proofs older than 730 days, once per app load).
 * Photo blobs never go into localStorage or into storage.js collections.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Proof = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const KL_OFFSET_MS = 8 * 3600000; // Asia/Kuala_Lumpur: UTC+8, no daylight saving
  const KEEP_DAYS = 730;
  const DAY_MS = 86400000;
  const GPS_MAX_AGE_MS = 2 * 60000;
  const MAX_PHOTOS = 6;
  const RECEIVER_MAX = 40;
  const ITEMS_MAX = 60;
  const REASONS = ['Photos not allowed', 'Left at guard house', 'Camera problem', 'Other'];
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));

  // ---------- Malaysia wall clock (whatever the device zone) ----------
  function kl(ms) {
    const d = new Date(ms + KL_OFFSET_MS);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
  }
  const klDay = (ms) => { const p = kl(ms); return p.y + '-' + pad2(p.mo + 1) + '-' + pad2(p.d); };
  const klDate = (ms) => { const p = kl(ms); return p.d + ' ' + MON[p.mo] + ' ' + p.y; }; // 26 Nov 2026
  const klHm24 = (ms) => { const p = kl(ms); return pad2(p.h) + ':' + pad2(p.mi); }; // 14:32
  const klHm12 = (ms) => { const p = kl(ms); const h = p.h % 12 || 12; return h + ':' + pad2(p.mi) + ' ' + (p.h < 12 ? 'am' : 'pm'); }; // 2:32 pm

  // ---------- pure rules ----------
  // A proof stop: the DONE tap here would complete at least one delivery whose item is collected (doneSplit's apply list: a
  // delivery left open by doneSplit is in `held`, never here). Pickups, just-collect jobs (no delivery), errands, the fuel stop and
  // the end-point card are never proof stops.
  function isProofStop(stop, split) {
    if (!stop || stop.fuel || stop.end || stop.isEnd) return false;
    const apply = (split && split.apply) || [];
    return apply.some((a) => a && a.kind === 'deliver');
  }
  // The deliveries a proof covers (the same list): [{jobId, item}]
  function proofDeliveries(split) {
    return ((split && split.apply) || []).filter((a) => a && a.kind === 'deliver');
  }

  const cleanText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const itemsText = (proof) => ((proof && proof.items) || []).map(cleanText).filter(Boolean).join(', ');

  // The WhatsApp caption: plain text, no emoji.
  function caption(proof) {
    const p = proof || {};
    const L = ['DELIVERED - ' + cleanText(p.placeName), itemsText(p)];
    const rcv = cleanText(p.receiver);
    if (rcv) L.push('Received by: ' + rcv);
    const noPhoto = cleanText(p.noPhotoReason);
    if (noPhoto && !((p.photoIds || []).length)) L.push('No photo: ' + noPhoto);
    const t = toMs(p.doneAt);
    L.push(t != null && isFinite(t) ? klDate(t) + ', ' + klHm12(t) : '');
    return L.join('\n');
  }

  // The text lines on the photo band, in order. shot = {takenAt, gps} of the one photo (default: the proof's own).
  function stampLines(proof, shot) {
    const p = proof || {}, s = shot || {};
    const at = toMs(s.takenAt != null ? s.takenAt : p.doneAt);
    const L = [cleanText(p.placeName)];
    const addr = cleanText(p.address);
    if (addr) L.push(addr);
    if (at != null && isFinite(at)) L.push(klDate(at) + ' ' + klHm24(at));
    const g = s.gps !== undefined ? s.gps : p.gps;
    const fresh = g && isFinite(g.lat) && isFinite(g.lon) && at != null && g.at != null && Math.abs(at - toMs(g.at)) <= GPS_MAX_AGE_MS;
    L.push(fresh ? 'GPS ' + Number(g.lat).toFixed(5) + ', ' + Number(g.lon).toFixed(5) + (g.acc != null && isFinite(g.acc) ? ' ±' + Math.round(g.acc) + ' m' : '') : 'GPS not available');
    const rcv = cleanText(p.receiver);
    if (rcv) L.push('Received by: ' + rcv);
    const items = itemsText(p);
    if (items) L.push(items.length > ITEMS_MAX ? items.slice(0, ITEMS_MAX - 1) + '…' : items);
    return L;
  }

  // The ids of the proofs completed more than 730 days before nowMs (drafts have no doneAt and never expire here).
  function expired(proofs, nowMs) {
    return (proofs || []).filter((p) => {
      const t = p && toMs(p.doneAt);
      return t != null && isFinite(t) && nowMs - t > KEEP_DAYS * DAY_MS;
    }).map((p) => p.id);
  }

  function slug(name) {
    const s = String(name == null ? '' : name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || 'place';
  }
  // A photo's kind: "item" (the goods, stamped with the band) or "do" (the delivery order, no band). Photos saved before the two
  // kinds existed have none: they are item photos.
  const kindOf = (ph) => (ph && ph.kind === 'do' ? 'do' : 'item');
  // "<yyyy-mm-dd>_<place name slug>_item_<n>.jpg" / "..._DO_<n>.jpg" (the date of the proof, Malaysia time; n counts per kind from 1)
  function fileName(proof, n, kind) {
    const p = proof || {};
    const t = toMs(p.doneAt);
    const day = t != null && isFinite(t) ? klDay(t) : (p.dayKey || 'undated');
    return day + '_' + slug(p.placeName) + (kind === 'do' ? '_DO_' : '_item_') + n + '.jpg';
  }
  // capture order: takenAt, then the order in proof.photoIds
  function byCapture(photos, order) {
    const ids = order || [];
    return (photos || []).map((ph, i) => ({ ph, i })).sort((a, b) => ((a.ph.takenAt || 0) - (b.ph.takenAt || 0))
      || (ids.indexOf(a.ph.id) - ids.indexOf(b.ph.id)) || (a.i - b.i)).map((x) => x.ph);
  }
  // The share list: item photos first in capture order, then DO photos in capture order -> [{photo, kind, n, name}]
  function shareList(proof, photos) {
    const all = byCapture(photos, proof && proof.photoIds);
    const out = [];
    ['item', 'do'].forEach((k) => all.filter((ph) => kindOf(ph) === k).forEach((ph, j) => out.push({ photo: ph, kind: k, n: j + 1, name: fileName(proof, j + 1, k) })));
    return out;
  }
  // The shared files, in the exact share order (shareList: item photos in capture order, then DO photos in capture order):
  // [{photo, kind, n, name, lastModified}] - name "01_<fileName>", "02_...", so the names sort in share order; lastModified the
  // earliest capture time for the first file and 1000 ms more for each next one (strictly increasing in share order).
  function shareFiles(proof, photos) {
    const list = shareList(proof, photos);
    const times = list.map((x) => toMs(x.photo && x.photo.takenAt)).filter((t) => t != null && isFinite(t));
    const done = toMs(proof && proof.doneAt);
    const base = times.length ? Math.min(...times) : (done != null && isFinite(done) ? done : Date.now());
    return list.map((x, i) => Object.assign({}, x, { name: pad2(i + 1) + '_' + x.name, lastModified: base + i * 1000 }));
  }
  // SEND TO GROUP in one or two taps. twoStep (Settings "Send caption with first photo (2 steps)") and n >= 2 files: tap 1 shares the
  // first file with the caption (and copies the caption), tap 2 the rest with no text; otherwise one tap shares everything with
  // the caption, as before. step: 0 (fresh, or after SENT) | 1 (the first file went, the rest is due).
  // sendStep(n, twoStep, step) -> {from, to, text, copy, last}: files.slice(from, to) for this tap
  function sendStep(n, twoStep, step) {
    const two = !!twoStep && n >= 2;
    if (two && step === 1) return { from: 1, to: n, text: false, copy: false, last: true };
    return { from: 0, to: two ? 1 : n, text: true, copy: true, last: !two };
  }
  // afterShare(n, twoStep, step, resolved) -> {step, sent}: the share resolved -> the next step (sent = the last one went: sentAt
  // is set); backed out -> the same step, nothing sent
  function afterShare(n, twoStep, step, resolved) {
    const s = step === 1 && !!twoStep && n >= 2 ? 1 : 0;
    if (!resolved) return { step: s, sent: false };
    return sendStep(n, twoStep, s).last ? { step: 0, sent: true } : { step: 1, sent: false };
  }
  // the button text: "SEND REST (<n - 1>)" while step 1 is due, else SENT ✓ once sent, else SEND TO GROUP
  function sendLabel(n, twoStep, step, sentAt) {
    if (step === 1 && !!twoStep && n >= 2) return 'SEND REST (' + (n - 1) + ')';
    return sentAt ? 'SENT ✓' : 'SEND TO GROUP';
  }
  // {item, do}: how many photos of each kind
  function countKinds(photos) {
    const c = { item: 0, do: 0 };
    (photos || []).forEach((ph) => { c[kindOf(ph)]++; });
    return c;
  }

  // The CSV "proof" cell for a proof summary {photos, itemPhotos, doPhotos, noPhotoReason} ('' when there is none):
  // "<a> item, <b> DO photos" or "no photo: <reason>". A summary from before the two kinds counts every photo as item.
  function csvCell(info) {
    if (!info) return '';
    if (info.photos > 0) {
      const dos = info.doPhotos > 0 ? info.doPhotos : 0;
      const items = info.itemPhotos != null ? info.itemPhotos : info.photos - dos;
      return items + ' item, ' + dos + ' DO photos';
    }
    return 'no photo: ' + cleanText(info.noPhotoReason);
  }
  // The small summary kept on the day log / job record (the proof itself lives in IndexedDB). proof.counts = {item, do}, set at save.
  function summaryOf(proof) {
    const n = (proof.photoIds || []).length;
    const c = proof.counts || { item: n, do: 0 };
    return { id: proof.id, photos: n, itemPhotos: c.item || 0, doPhotos: c.do || 0, noPhotoReason: proof.noPhotoReason || '', receiver: cleanText(proof.receiver) };
  }

  // ---------- IndexedDB (browser) ----------
  const DB_NAME = 'waypoint-proof', DB_VERSION = 1;
  let dbP = null;
  function idb() { return root.indexedDB || null; }
  function open() {
    if (dbP) return dbP;
    dbP = new Promise((resolve, reject) => {
      const f = idb();
      if (!f) { reject(new Error('IndexedDB not available')); return; }
      const rq = f.open(DB_NAME, DB_VERSION);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('proofs')) db.createObjectStore('proofs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' }).createIndex('proofId', 'proofId');
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error || new Error('IndexedDB open failed'));
    });
    dbP.catch(() => { dbP = null; });
    return dbP;
  }
  function tx(stores, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      try { out = fn(t); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && typeof out === 'object' && '__r' in out ? out.__r : out);
      t.onerror = () => reject(t.error || new Error('IndexedDB error'));
      t.onabort = () => reject(t.error || new Error('IndexedDB aborted'));
    }));
  }
  const reqVal = (rq) => { const box = { __r: undefined }; rq.onsuccess = () => { box.__r = rq.result; }; return box; };
  const putProof = (p) => tx(['proofs'], 'readwrite', (t) => { t.objectStore('proofs').put(p); }).then(() => p);
  const getProof = (id) => tx(['proofs'], 'readonly', (t) => reqVal(t.objectStore('proofs').get(id)));
  const listProofs = () => tx(['proofs'], 'readonly', (t) => reqVal(t.objectStore('proofs').getAll())).then((a) => a || []);
  const putPhoto = (ph) => tx(['photos'], 'readwrite', (t) => { t.objectStore('photos').put(ph); }).then(() => ph);
  const getPhoto = (id) => tx(['photos'], 'readonly', (t) => reqVal(t.objectStore('photos').get(id)));
  const photosOf = (proofId) => tx(['photos'], 'readonly', (t) => reqVal(t.objectStore('photos').index('proofId').getAll(proofId))).then((a) => a || []);
  const listPhotos = () => tx(['photos'], 'readonly', (t) => reqVal(t.objectStore('photos').getAll())).then((a) => a || []);
  const deletePhoto = (id) => tx(['photos'], 'readwrite', (t) => { t.objectStore('photos').delete(id); });
  // a proof and every photo of it
  function deleteProof(id) {
    return photosOf(id).then((phs) => tx(['proofs', 'photos'], 'readwrite', (t) => {
      phs.forEach((ph) => t.objectStore('photos').delete(ph.id));
      t.objectStore('proofs').delete(id);
    }));
  }
  // replace a proof's raw photos with the stamped ones and save the proof, in one transaction
  function saveStamped(proof, photos) {
    return tx(['proofs', 'photos'], 'readwrite', (t) => {
      photos.forEach((ph) => t.objectStore('photos').put(ph));
      t.objectStore('proofs').put(proof);
    }).then(() => proof);
  }
  // Settings line: {count (done deliveries), bytes}
  function usage() {
    return Promise.all([listProofs(), listPhotos()]).then(([ps, phs]) => ({
      count: ps.filter((p) => p.state === 'done').length,
      bytes: phs.reduce((s, ph) => s + (ph.bytes || (ph.blob && ph.blob.size) || 0), 0),
    }));
  }

  // Once per app load: every expired proof goes with its photos. Nothing else is ever deleted automatically. -> ids deleted
  let retentionRan = false;
  function runRetention(nowMs) {
    if (retentionRan) return Promise.resolve([]);
    retentionRan = true;
    return listProofs().then((ps) => {
      const ids = expired(ps, nowMs);
      return ids.reduce((pr, id) => pr.then(() => deleteProof(id)), Promise.resolve()).then(() => ids);
    });
  }

  // navigator.storage.persist(), asked once (on the first saved proof); the answer is kept in localStorage. Never awaited by callers.
  const PERSIST_KEY = 'waypoint:meta:proofPersist';
  function persistOnce() {
    try {
      const ls = root.localStorage;
      if (ls && ls.getItem(PERSIST_KEY) != null) return Promise.resolve(JSON.parse(ls.getItem(PERSIST_KEY)).granted);
      const st = root.navigator && root.navigator.storage;
      if (!st || !st.persist) { if (ls) ls.setItem(PERSIST_KEY, JSON.stringify({ granted: false, at: Date.now(), api: false })); return Promise.resolve(false); }
      return st.persist().then((g) => { try { ls && ls.setItem(PERSIST_KEY, JSON.stringify({ granted: !!g, at: Date.now() })); } catch (e) { /* ignore */ } return !!g; }).catch(() => false);
    } catch (e) { return Promise.resolve(false); }
  }
  function persisted() {
    try {
      const st = root.navigator && root.navigator.storage;
      return st && st.persisted ? st.persisted().then((x) => !!x).catch(() => false) : Promise.resolve(false);
    } catch (e) { return Promise.resolve(false); }
  }

  // ---------- the stamped photo (browser) ----------
  const BAND_RGBA = 'rgba(0, 36, 60, 0.85)'; // #00243c at 85%
  const LONG_SIDE = 1600, Q1 = 0.8, Q2 = 0.7, MAX_BYTES = 400 * 1024;
  let logoP = null;
  function loadLogo(url) {
    if (logoP) return logoP;
    logoP = new Promise((resolve) => {
      try {
        const img = new root.Image();
        img.onload = () => resolve(img);
        img.onerror = () => { logoP = null; resolve(null); };
        img.src = url || 'logo-horizontal-on-dark.svg';
      } catch (e) { logoP = null; resolve(null); }
    });
    return logoP;
  }
  function toBlob(canvas, q) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))), 'image/jpeg', q));
  }
  async function bitmapOf(input) {
    if (input && typeof input.width === 'number' && typeof input.close === 'function') return input; // an ImageBitmap already
    try { return await root.createImageBitmap(input, { imageOrientation: 'from-image' }); }
    catch (e) { return await root.createImageBitmap(input); }
  }
  // compose(rawBitmapOrBlob, proof, shot?) -> JPEG Blob: EXIF orientation honoured, long side at most 1600 px, the band along the bottom
  // (#00243c at 85%) with the logo at the left and stampLines(proof, shot) in white under it; quality 0.8, 0.7 when over 400 KB.
  async function compose(input, proof, shot, opts) {
    const o = opts || {};
    const bmp = await bitmapOf(input);
    const k = Math.min(1, LONG_SIDE / Math.max(bmp.width, bmp.height));
    const W = Math.max(1, Math.round(bmp.width * k)), H = Math.max(1, Math.round(bmp.height * k));
    const c = root.document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, W, H);
    const lines = stampLines(proof, shot);
    const short = Math.min(W, H);
    const fs = Math.max(14, Math.round(short * 0.034)); // ~41 px on a 1200 px side: about 11 px on a 360 px wide phone screen
    const lh = Math.round(fs * 1.28), pad = Math.round(fs * 0.6);
    const logo = await loadLogo(o.logoUrl);
    const logoW = logo ? Math.round(Math.min(W * 0.42, fs * 9)) : 0;
    const logoH = logo ? Math.round(logoW * 150.37 / 891.1) : 0;
    const bandH = Math.min(H, pad + (logo ? logoH + Math.round(pad * 0.7) : 0) + lines.length * lh + pad - Math.round(lh - fs));
    g.fillStyle = BAND_RGBA;
    g.fillRect(0, H - bandH, W, bandH);
    let y = H - bandH + pad;
    if (logo) { g.drawImage(logo, pad, y, logoW, logoH); y += logoH + Math.round(pad * 0.7); }
    g.fillStyle = '#ffffff';
    g.textBaseline = 'top';
    lines.forEach((t, i) => {
      g.font = (i === 0 ? '700 ' : '400 ') + fs + 'px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
      let s = t;
      while (s.length > 4 && g.measureText(s).width > W - 2 * pad) s = s.slice(0, -2) + '…';
      g.fillText(s, pad, y);
      y += lh;
    });
    if (bmp.close && bmp !== input) bmp.close();
    let blob = await toBlob(c, Q1);
    if (blob.size > MAX_BYTES) blob = await toBlob(c, Q2);
    return blob;
  }
  // composeDo(rawBitmapOrBlob) -> JPEG Blob of a DO photo: no band, no logo, no text; EXIF orientation honoured, long side at most
  // 2000 px, quality 0.85, 0.75 when over 600 KB.
  const DO_LONG = 2000, DO_Q1 = 0.85, DO_Q2 = 0.75, DO_MAX_BYTES = 600 * 1024;
  async function composeDo(input) {
    const bmp = await bitmapOf(input);
    const k = Math.min(1, DO_LONG / Math.max(bmp.width, bmp.height));
    const W = Math.max(1, Math.round(bmp.width * k)), H = Math.max(1, Math.round(bmp.height * k));
    const c = root.document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(bmp, 0, 0, W, H);
    if (bmp.close && bmp !== input) bmp.close();
    let blob = await toBlob(c, DO_Q1);
    if (blob.size > DO_MAX_BYTES) blob = await toBlob(c, DO_Q2);
    return blob;
  }

  return {
    REASONS, MAX_PHOTOS, MAX_PER_KIND: MAX_PHOTOS, RECEIVER_MAX, KEEP_DAYS, GPS_MAX_AGE_MS, DO_LONG,
    isProofStop, proofDeliveries, caption, stampLines, expired, fileName, slug, kindOf, byCapture, shareList, shareFiles, sendStep, afterShare, sendLabel, countKinds, csvCell, summaryOf, klDay, klDate,
    open, putProof, getProof, listProofs, putPhoto, getPhoto, photosOf, deletePhoto, deleteProof, saveStamped, usage, runRetention, persistOnce, persisted,
    compose, composeDo, loadLogo,
  };
});
