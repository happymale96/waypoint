/* L-Tech Waypoint — scan.js: delivery-order (DO) page straightening, like a document scanner. No library, no network.
 * Pure (node + browser, plain pixel arrays): toGray, detectPage, orderCorners, homography, outputSize, warp.
 * Browser only: cornerScreen(blob, opts) -> Promise<{action: 'use' | 'keep' | 'retake', blob}> — the still with four draggable
 * corner handles (placed at detectPage's corners, or inset 8% when it finds none), a magnifier while dragging, and
 * Use (warp, long side at most 2000 px) / Keep as shot / Retake.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Scan = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const DETECT_LONG = 400;
  const MIN_AREA = 0.15, MAX_AREA = 0.98;
  const MAX_LONG = 2000;
  const INSET = 0.08;

  // RGBA (4 per pixel) -> gray (1 per pixel), Rec. 601 weights
  function toGray(rgba, w, h) {
    const n = w * h, g = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    return g;
  }

  // box-average downscale of a gray image by factor k (< 1)
  function shrink(gray, w, h, k) {
    const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
    const out = new Float32Array(dw * dh);
    const fx = w / dw, fy = h / dh;
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
        let s = 0, c = 0;
        for (let yy = y0; yy < y1 && yy < h; yy++) for (let xx = x0; xx < x1 && xx < w; xx++) { s += gray[yy * w + xx]; c++; }
        out[y * dw + x] = c ? s / c : 0;
      }
    }
    return { px: out, w: dw, h: dh, sx: w / dw, sy: h / dh };
  }
  // 3 x 3 box blur (edges clamped)
  function blur3(px, w, h) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) s += px[yy * w + Math.min(w - 1, Math.max(0, x + dx))];
        }
        out[y * w + x] = s / 9;
      }
    }
    return out;
  }
  // Otsu's threshold over a 256-bin histogram
  function otsu(px) {
    const hist = new Float64Array(256);
    for (let i = 0; i < px.length; i++) hist[Math.max(0, Math.min(255, Math.round(px[i])))]++;
    const total = px.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = -1, thr = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }
  // the largest 4-connected region of mask == 1 -> {count, sumXY extremes}
  function largestRegion(mask, w, h) {
    const lab = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let bestId = 0, bestN = 0, id = 0;
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || lab[s]) continue;
      id++;
      let top = 0, n = 0;
      stack[top++] = s; lab[s] = id;
      while (top) {
        const p = stack[--top]; n++;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[top++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[top++] = p + 1; }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; stack[top++] = p - w; }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; stack[top++] = p + w; }
      }
      if (n > bestN) { bestN = n; bestId = id; }
    }
    return { lab, id: bestId, count: bestN };
  }
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  // four points, ordered, form a convex quadrilateral (every turn the same way, none degenerate)
  function isConvexQuad(q) {
    if (!q || q.length !== 4) return false;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
      if (!isFinite(c) || Math.abs(c) < 1e-6) return false;
      const s = c > 0 ? 1 : -1;
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  // detectPage(gray, w, h) -> [tl, tr, br, bl] ({x, y} in the input's pixels) or null
  function detectPage(gray, w, h) {
    if (!gray || !(w > 2) || !(h > 2)) return null;
    const k = Math.min(1, DETECT_LONG / Math.max(w, h));
    const sm = k < 1 ? shrink(gray, w, h, k) : { px: Float32Array.from(gray), w, h, sx: 1, sy: 1 };
    const W = sm.w, H = sm.h;
    const px = blur3(sm.px, W, H);
    let lo = 255, hi = 0;
    for (let i = 0; i < px.length; i++) { if (px[i] < lo) lo = px[i]; if (px[i] > hi) hi = px[i]; }
    if (hi - lo < 24) return null; // no contrast: all dark, all bright
    const t = otsu(px);
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < px.length; i++) mask[i] = px[i] > t ? 1 : 0;
    const reg = largestRegion(mask, W, H);
    const frac = reg.count / (W * H);
    if (!reg.count || frac < MIN_AREA || frac > MAX_AREA) return null;
    // the region's points extreme in x+y, x-y, -x+y, -x-y
    let tl = null, tr = null, br = null, bl = null;
    let mTL = Infinity, mTR = -Infinity, mBR = -Infinity, mBL = Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (reg.lab[y * W + x] !== reg.id) continue;
        const s = x + y, d = x - y;
        if (s < mTL) { mTL = s; tl = { x, y }; }
        if (s > mBR) { mBR = s; br = { x, y }; }
        if (d > mTR) { mTR = d; tr = { x, y }; }
        if (d < mBL) { mBL = d; bl = { x, y }; }
      }
    }
    // back to the input's pixels: a region pixel's outer edge (the corner of the pixel facing out)
    const back = (p, ox, oy) => ({ x: Math.max(0, Math.min(w, (p.x + ox) * sm.sx)), y: Math.max(0, Math.min(h, (p.y + oy) * sm.sy)) });
    const q = [back(tl, 0, 0), back(tr, 1, 0), back(br, 1, 1), back(bl, 0, 1)];
    return isConvexQuad(q) ? q : null;
  }

  // orderCorners(pts) -> [top-left, top-right, bottom-right, bottom-left]
  function orderCorners(pts) {
    const p = (pts || []).map((a) => ({ x: +a.x, y: +a.y }));
    if (p.length !== 4) return p;
    const cx = (p[0].x + p[1].x + p[2].x + p[3].x) / 4, cy = (p[0].y + p[1].y + p[2].y + p[3].y) / 4;
    p.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)); // clockwise on screen (y down)
    let s = 0;
    for (let i = 1; i < 4; i++) if (p[i].x + p[i].y < p[s].x + p[s].y) s = i;
    return p.slice(s).concat(p.slice(0, s));
  }

  // homography(src4, dst4) -> [h0..h8] (row-major 3 x 3, h8 = 1) mapping each src point onto its dst point.
  // Solved directly: the 8 x 8 linear system, Gaussian elimination with partial pivoting.
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null; // degenerate (three points in a line)
      if (piv !== c) { const t = A[c]; A[c] = A[piv]; A[piv] = t; const tb = b[c]; b[c] = b[piv]; b[piv] = tb; }
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x.concat([1]);
  }
  function apply(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
  }
  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det) return null;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }

  // outputSize(corners [tl, tr, br, bl], maxLong) -> {w, h}: the average of opposite edge lengths, long side capped at maxLong
  function outputSize(c, maxLong) {
    const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    let w = (d(c[0], c[1]) + d(c[3], c[2])) / 2, h = (d(c[0], c[3]) + d(c[1], c[2])) / 2;
    const cap = maxLong || MAX_LONG;
    const k = Math.min(1, cap / Math.max(w, h, 1e-9));
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    if (w > cap) w = cap;
    if (h > cap) h = cap;
    return { w, h };
  }

  // warp(srcPixels, sw, sh, H, dw, dh) -> destination pixels (same channel count: 1 gray or 4 RGBA). H maps source -> destination;
  // every destination pixel centre is mapped back through H's inverse and sampled bilinearly (edges clamped).
  function warp(src, sw, sh, H, dw, dh) {
    const ch = Math.round(src.length / (sw * sh)) || 1;
    const out = new Uint8ClampedArray(dw * dh * ch);
    const Hi = invert3(H);
    if (!Hi) return out;
    for (let y = 0; y < dh; y++) {
      const yc = y + 0.5;
      for (let x = 0; x < dw; x++) {
        const xc = x + 0.5;
        const wq = Hi[6] * xc + Hi[7] * yc + Hi[8];
        let u = (Hi[0] * xc + Hi[1] * yc + Hi[2]) / wq - 0.5, v = (Hi[3] * xc + Hi[4] * yc + Hi[5]) / wq - 0.5;
        if (u < 0) u = 0; else if (u > sw - 1) u = sw - 1;
        if (v < 0) v = 0; else if (v > sh - 1) v = sh - 1;
        const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const fx = u - x0, fy = v - y0;
        const i00 = (y0 * sw + x0) * ch, i10 = (y0 * sw + x1) * ch, i01 = (y1 * sw + x0) * ch, i11 = (y1 * sw + x1) * ch;
        const o = (y * dw + x) * ch;
        for (let k = 0; k < ch; k++) {
          const top = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * fx;
          const bot = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * fx;
          out[o + k] = top + (bot - top) * fy;
        }
      }
    }
    return out;
  }
  // the corners inset 8% from each edge (when detectPage finds no page)
  const insetCorners = (w, h) => [{ x: w * INSET, y: h * INSET }, { x: w * (1 - INSET), y: h * INSET }, { x: w * (1 - INSET), y: h * (1 - INSET) }, { x: w * INSET, y: h * (1 - INSET) }];

  // ---------- browser: the corner screen ----------
  function el(tag, props, ...kids) {
    const e = root.document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach((c) => { if (c != null) e.append(c.nodeType ? c : root.document.createTextNode(String(c))); });
    return e;
  }
  async function bitmapOf(blob) {
    try { return await root.createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { return await root.createImageBitmap(blob); }
  }
  function toBlob(canvas, q) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))), 'image/jpeg', q));
  }
  // the warped page as a JPEG (long side at most maxLong). The source is drawn at most 1.5 x the output's long side first.
  async function straighten(bmp, corners, maxLong) {
    const size = outputSize(corners, maxLong || MAX_LONG);
    const k = Math.min(1, (Math.max(size.w, size.h) * 1.5) / Math.max(bmp.width, bmp.height));
    const sw = Math.max(1, Math.round(bmp.width * k)), sh = Math.max(1, Math.round(bmp.height * k));
    const sc = root.document.createElement('canvas'); sc.width = sw; sc.height = sh;
    const sg = sc.getContext('2d'); sg.drawImage(bmp, 0, 0, sw, sh);
    const src = sg.getImageData(0, 0, sw, sh).data;
    const sx = sw / bmp.width, sy = sh / bmp.height;
    const from = corners.map((p) => ({ x: p.x * sx, y: p.y * sy }));
    const H = homography(from, [{ x: 0, y: 0 }, { x: size.w, y: 0 }, { x: size.w, y: size.h }, { x: 0, y: size.h }]);
    const dc = root.document.createElement('canvas'); dc.width = size.w; dc.height = size.h;
    const dg = dc.getContext('2d');
    const img = dg.createImageData(size.w, size.h);
    if (H) img.data.set(warp(src, sw, sh, H, size.w, size.h));
    dg.putImageData(img, 0, 0);
    return toBlob(dc, 0.92);
  }
  // corners for a still: detectPage on a <= 400 px copy, else inset 8%
  function cornersFor(bmp) {
    const k = Math.min(1, DETECT_LONG / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const c = root.document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, w, h);
    const found = detectPage(toGray(g.getImageData(0, 0, w, h).data, w, h), w, h);
    const s = bmp.width / w, t = bmp.height / h;
    return found ? { found: true, corners: found.map((p) => ({ x: p.x * s, y: p.y * t })) } : { found: false, corners: insetCorners(bmp.width, bmp.height) };
  }

  let current = null; // the open corner screen: {close(action)}
  // cornerScreen(blob, {parent}) -> Promise<{action, blob}>: 'use' = the straightened page, 'keep' = the shot as taken,
  // 'retake' = discarded. close() (the camera closing) resolves 'retake'.
  function cornerScreen(blob, opts) {
    const o = opts || {};
    return new Promise(async (resolve) => {
      let bmp;
      try { bmp = await bitmapOf(blob); } catch (e) { resolve({ action: 'keep', blob }); return; } // undecodable: kept as shot
      const det = cornersFor(bmp);
      let pts = det.corners.map((p) => ({ x: p.x, y: p.y }));
      const img = el('canvas', { class: 'scan-img', id: 'scanImg' });
      const svg = root.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'scan-lines');
      const poly = root.document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      svg.append(poly);
      const handles = [0, 1, 2, 3].map((i) => el('div', { class: 'scan-handle', 'data-i': String(i), role: 'slider', 'aria-label': ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'][i] + ' corner' }, el('span')));
      const mag = el('canvas', { class: 'scan-mag', id: 'scanMag', width: '120', height: '120', hidden: true });
      const stage = el('div', { class: 'scan-stage' }, img, svg, ...handles, mag);
      let done = false;
      const finish = async (action) => {
        if (done) return;
        done = true;
        let out = blob;
        if (action === 'use') {
          useBtn.disabled = keepBtn.disabled = retakeBtn.disabled = true;
          useBtn.textContent = 'Straightening…';
          try { out = await straighten(bmp, orderCorners(pts), o.maxLong || MAX_LONG); } catch (e) { out = blob; action = 'keep'; }
        }
        try { bmp.close && bmp.close(); } catch (e) { /* ignore */ }
        root.removeEventListener('resize', layout);
        screen.remove();
        if (current === api) current = null;
        resolve({ action, blob: action === 'retake' ? null : out });
      };
      const useBtn = el('button', { class: 'ok', id: 'scanUse', type: 'button', onclick: () => finish('use') }, 'Use');
      const keepBtn = el('button', { id: 'scanKeep', type: 'button', onclick: () => finish('keep') }, 'Keep as shot');
      const retakeBtn = el('button', { id: 'scanRetake', type: 'button', onclick: () => finish('retake') }, 'Retake');
      const hint = el('div', { class: 'scan-hint', id: 'scanHint' }, det.found ? 'Drag the corners onto the page' : 'Page not found - drag the corners onto the page');
      const screen = el('div', { class: 'scan-screen', id: 'scanScreen', role: 'dialog', 'aria-label': 'Crop the delivery order' }, hint, stage, el('div', { class: 'scan-actions' }, retakeBtn, keepBtn, useBtn));
      (o.parent || root.document.body).append(screen);
      const api = { close: () => finish('retake') };
      current = api;
      // layout: the still fitted into the stage; d = display px per image px
      let d = 1, ox = 0, oy = 0;
      function layout() {
        const r = stage.getBoundingClientRect();
        d = Math.min(r.width / bmp.width, r.height / bmp.height) || 1;
        const dw = Math.round(bmp.width * d), dh = Math.round(bmp.height * d);
        ox = Math.round((r.width - dw) / 2); oy = Math.round((r.height - dh) / 2);
        img.width = dw; img.height = dh;
        img.style.left = ox + 'px'; img.style.top = oy + 'px'; img.style.width = dw + 'px'; img.style.height = dh + 'px';
        img.getContext('2d').drawImage(bmp, 0, 0, dw, dh);
        svg.setAttribute('width', String(r.width)); svg.setAttribute('height', String(r.height));
        paint();
      }
      function paint() {
        handles.forEach((hd, i) => { hd.style.left = (ox + pts[i].x * d) + 'px'; hd.style.top = (oy + pts[i].y * d) + 'px'; });
        poly.setAttribute('points', pts.map((p) => (ox + p.x * d) + ',' + (oy + p.y * d)).join(' '));
      }
      function magnify(i, clientX, clientY) {
        const r = stage.getBoundingClientRect(), S = 120, Z = 2.5;
        const g = mag.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
        const cx = ox + pts[i].x * d, cy = oy + pts[i].y * d;
        g.drawImage(img, cx - ox - S / (2 * Z), cy - oy - S / (2 * Z), S / Z, S / Z, 0, 0, S, S);
        g.strokeStyle = '#f5a623'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(S / 2 - 10, S / 2); g.lineTo(S / 2 + 10, S / 2); g.moveTo(S / 2, S / 2 - 10); g.lineTo(S / 2, S / 2 + 10); g.stroke();
        // away from the finger: the other side horizontally, the top unless the finger is in the top 40%
        const fx = clientX - r.left, fy = clientY - r.top;
        mag.style.left = (fx > r.width / 2 ? 12 : r.width - S - 12) + 'px';
        mag.style.top = (fy < r.height * 0.4 ? r.height - S - 12 : 12) + 'px';
        mag.hidden = false;
      }
      handles.forEach((hd, i) => {
        let drag = null;
        hd.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          try { hd.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
          drag = { px: e.clientX, py: e.clientY, x: pts[i].x, y: pts[i].y };
          hd.classList.add('dragging');
          magnify(i, e.clientX, e.clientY);
        });
        hd.addEventListener('pointermove', (e) => {
          if (!drag) return;
          e.preventDefault();
          pts[i] = { x: Math.max(0, Math.min(bmp.width, drag.x + (e.clientX - drag.px) / d)), y: Math.max(0, Math.min(bmp.height, drag.y + (e.clientY - drag.py) / d)) };
          paint();
          magnify(i, e.clientX, e.clientY);
        });
        const end = () => { if (!drag) return; drag = null; hd.classList.remove('dragging'); mag.hidden = true; };
        hd.addEventListener('pointerup', end);
        hd.addEventListener('pointercancel', end);
      });
      root.addEventListener('resize', layout);
      layout();
    });
  }
  const closeCornerScreen = () => { if (current) current.close(); };
  const cornerScreenOpen = () => !!current;

  return { DETECT_LONG, MAX_LONG, toGray, detectPage, orderCorners, homography, apply, outputSize, warp, insetCorners, isConvexQuad, cornerScreen, closeCornerScreen, cornerScreenOpen, straighten };
});
