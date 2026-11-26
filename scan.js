/* L-Tech Waypoint — scan.js: delivery-order (DO) page straightening, like a document scanner. No library, no network.
 * Pure (node + browser, plain pixel arrays): toGray, detectPage (the bright region, then robust straight lines along its four
 * sides: fitCorners / fitLine), orderCorners, homography, outputSize, warp, enhancePage (even lighting + levels, colour kept).
 * Browser only: cornerScreen(blob, opts) -> Promise<{action: 'use' | 'keep' | 'retake', blob, srcW, srcH, cleaned}> — the FULL still
 * (drawn at devicePixelRatio) with four draggable corner handles (placed at detectPage's corners, or inset 8% when it finds
 * none), a magnifier while dragging, the "Clean up page" toggle, the still's pixel size in small text, and Use (the warp samples
 * the full still; long side min(2000, the corners' span), never upscaled) / Keep as shot / Retake. sizeOf(blob).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Scan = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const DETECT_LONG = 640;
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

  // ---------- robust side lines (the page outline split into four sides, a trimmed straight-line fit per side) ----------
  // the OUTER outline: every region pixel with a 4-neighbour outside (the area reachable from the image border without crossing the
  // region; holes such as text lines do not count) or on the image edge, as pixel centres
  function boundaryPoints(lab, id, W, H) {
    const outside = new Uint8Array(W * H);
    const stack = new Int32Array(W * H);
    let top = 0;
    const push = (p) => { if (!outside[p] && lab[p] !== id) { outside[p] = 1; stack[top++] = p; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (top) {
      const p = stack[--top], x = p % W, y = (p - x) / W;
      if (x > 0) push(p - 1);
      if (x < W - 1) push(p + 1);
      if (y > 0) push(p - W);
      if (y < H - 1) push(p + W);
    }
    const out = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (lab[p] !== id) continue;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || outside[p - 1] || outside[p + 1] || outside[p - W] || outside[p + W]) out.push({ x: x + 0.5, y: y + 0.5 });
      }
    }
    return out;
  }
  // total least squares line through pts -> {nx, ny, c} (nx * x + ny * y = c, |n| = 1) or null
  function tlsLine(pts) {
    const n = pts.length;
    if (n < 2) return null;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    if (sxx + syy < 1e-9) return null;
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // the direction of the points
    const nx = -Math.sin(th), ny = Math.cos(th);
    return { nx, ny, c: nx * mx + ny * my };
  }
  // fitLine(pts, rounds, drop): least squares repeated `rounds` times, each time without the worst `drop` share of the points left
  // (a finger, a curled corner, a shadow along the side) -> {nx, ny, c} or null
  function fitLine(pts, rounds, drop) {
    let cur = pts.slice();
    let L = tlsLine(cur);
    for (let r = 0; r < (rounds == null ? 4 : rounds) && L; r++) {
      const keep = Math.max(2, Math.ceil(cur.length * (1 - (drop == null ? 0.2 : drop))));
      if (keep >= cur.length || keep < 5) break;
      const l = L;
      cur = cur.map((p) => ({ p, e: Math.abs(l.nx * p.x + l.ny * p.y - l.c) })).sort((a, b) => a.e - b.e).slice(0, keep).map((x) => x.p);
      L = tlsLine(cur);
    }
    return L;
  }
  function intersect(a, b) {
    const det = a.nx * b.ny - a.ny * b.nx;
    if (Math.abs(det) < 1e-9) return null;
    return { x: (a.c * b.ny - a.ny * b.c) / det, y: (a.nx * b.c - a.c * b.nx) / det };
  }
  function segDist(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy || 1e-9;
    const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2;
    const u = Math.max(0, Math.min(1, t));
    return { d: Math.hypot(p.x - (a.x + u * vx), p.y - (a.y + u * vy)), t };
  }
  // fitCorners(outline, rough [tl, tr, br, bl], W, H) -> the four corners as intersections of robust side lines, clamped to the
  // image, or null (too few points on a side, parallel lines, not a convex quadrilateral, a corner far from the rough one).
  // Each outline point goes to the nearest rough side; points within 15% of a side's ends are left out (rounded / curled corners).
  function fitCorners(outline, rough, W, H) {
    if (!outline || !rough || rough.length !== 4) return null;
    const sides = [[], [], [], []]; // top (tl-tr), right (tr-br), bottom (br-bl), left (bl-tl)
    for (const p of outline) {
      let best = -1, bd = Infinity, bt = 0;
      for (let s = 0; s < 4; s++) {
        const r = segDist(p, rough[s], rough[(s + 1) % 4]);
        if (r.d < bd) { bd = r.d; best = s; bt = r.t; }
      }
      if (best >= 0 && bt >= 0.15 && bt <= 0.85) sides[best].push(p);
    }
    if (sides.some((s) => s.length < 8)) return null;
    const cx = (rough[0].x + rough[1].x + rough[2].x + rough[3].x) / 4, cy = (rough[0].y + rough[1].y + rough[2].y + rough[3].y) / 4;
    const lines = sides.map((pts) => {
      const L = fitLine(pts, 4, 0.2);
      if (!L) return null;
      // the outline is pixel centres, half a pixel inside the edge: move the line half a pixel away from the page centre
      const s = L.nx * cx + L.ny * cy - L.c > 0 ? 1 : -1;
      return { nx: L.nx, ny: L.ny, c: L.c - 0.5 * s };
    });
    if (lines.some((l) => !l)) return null;
    // tl = left x top, tr = top x right, br = right x bottom, bl = bottom x left
    const q = [intersect(lines[3], lines[0]), intersect(lines[0], lines[1]), intersect(lines[1], lines[2]), intersect(lines[2], lines[3])];
    if (q.some((p) => !p || !isFinite(p.x) || !isFinite(p.y))) return null;
    const diag = Math.hypot(W, H);
    if (q.some((p, i) => Math.hypot(p.x - rough[i].x, p.y - rough[i].y) > 0.08 * diag)) return null;
    const c = q.map((p) => ({ x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) }));
    return isConvexQuad(c) ? c : null;
  }

  // detectPage(gray, w, h, opts) -> [tl, tr, br, bl] ({x, y} in the input's pixels) or null. opts.fit === false: the extreme-point
  // corners only (no side lines).
  function detectPage(gray, w, h, opts) {
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
    const rough = [{ x: tl.x, y: tl.y }, { x: tr.x + 1, y: tr.y }, { x: br.x + 1, y: br.y + 1 }, { x: bl.x, y: bl.y + 1 }];
    const back = (p) => ({ x: Math.max(0, Math.min(w, p.x * sm.sx)), y: Math.max(0, Math.min(h, p.y * sm.sy)) });
    const q = rough.map(back);
    if (!isConvexQuad(q)) return null;
    if (opts && opts.fit === false) return q;
    // tighter: robust straight lines along the four sides, intersected (the extreme points when that fails)
    const fit = fitCorners(boundaryPoints(reg.lab, reg.id, W, H), rough, W, H);
    if (!fit) return q;
    const f = fit.map(back);
    return isConvexQuad(f) ? f : q;
  }

  // ---------- page clean-up (the warped DO only) ----------
  // enhancePage(rgba, w, h) -> new RGBA pixels: even lighting (the paper's brightness per region, from a coarse 90th-percentile map
  // of the luminance - blocks of 1/48 of the long side - dark blocks filled from their neighbours, two 5 x 5 box blurs, divided out), levels (paper near 245, the darkest 1% of ink near 30),
  // colour kept (every channel scaled by the same factor, so hue and saturation stay), then a mild unsharp mask on the luminance.
  // Never thresholded to black and white.
  const PAPER = 245, INK = 30;
  function enhancePage(px, w, h) {
    const n = w * h;
    const out = new Uint8ClampedArray(n * 4);
    if (!(n > 0) || px.length < n * 4) return out;
    const L = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
    const B = Math.max(4, Math.round(Math.max(w, h) / 48));
    const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    const blk = new Float32Array(bw * bh);
    const hist = new Uint32Array(256);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        hist.fill(0);
        let cnt = 0;
        const y1 = Math.min(h, (by + 1) * B), x1 = Math.min(w, (bx + 1) * B);
        for (let y = by * B; y < y1; y++) for (let x = bx * B; x < x1; x++) { hist[L[y * w + x] | 0]++; cnt++; }
        let acc = 0, t = 255;
        const want = cnt * 0.9;
        for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) { t = v + 0.5; break; } }
        blk[by * bw + bx] = t;
      }
    }
    const at = (a, x, y) => a[Math.min(bh - 1, Math.max(0, y)) * bw + Math.min(bw - 1, Math.max(0, x))];
    // a block far darker than its brightest neighbour (dense ink, a solid stamp or bar) takes the paper from around it; three passes
    // bridge a dark area up to about 6 blocks wide. A block in an even lighting slope is left alone (no bias along a ramp).
    let m = blk;
    for (let pass = 0; pass < 3; pass++) {
      const o = Float32Array.from(m);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v = Math.max(v, at(m, x + dx, y + dy));
        if (m[y * bw + x] < 0.8 * v) o[y * bw + x] = v;
      }
      m = o;
    }
    for (let pass = 0; pass < 2; pass++) {
      const o = new Float32Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        let s = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += at(m, x + dx, y + dy);
        o[y * bw + x] = s / 25;
      }
      m = o;
    }
    // the ratio to the local paper, per pixel (block centres bilinear)
    const R = new Float32Array(n);
    const rh = new Uint32Array(301);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
        const top = m[y0 * bw + x0] + (m[y0 * bw + x1] - m[y0 * bw + x0]) * tx;
        const bot = m[y1 * bw + x0] + (m[y1 * bw + x1] - m[y1 * bw + x0]) * tx;
        const bg = Math.max(8, top + (bot - top) * ty);
        const r = L[y * w + x] / bg;
        R[y * w + x] = r;
        rh[Math.min(300, Math.max(0, Math.round(r * 200)))]++;
      }
    }
    // the black point: the darkest 1% (at most half the paper's brightness, so a page with little ink is not stretched)
    let acc = 0, p1 = 0.5;
    for (let v = 0; v <= 300; v++) { acc += rh[v]; if (acc >= n * 0.01) { p1 = v / 200; break; } }
    const rb = Math.max(0.02, Math.min(0.5, p1));
    const Lo = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = INK + ((R[i] - rb) / (1 - rb)) * (PAPER - INK);
      Lo[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    // mild unsharp mask (3 x 3 box, amount 0.5) on the luminance; the same change goes onto each channel
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) s += Lo[yy * w + Math.min(w - 1, Math.max(0, x + dx))];
        }
        const i = y * w + x, j = i * 4;
        const d = 0.5 * (Lo[i] - s / 9);
        const k = L[i] > 0.5 ? Lo[i] / L[i] : 0;
        out[j] = px[j] * k + d; out[j + 1] = px[j + 1] * k + d; out[j + 2] = px[j + 2] * k + d; out[j + 3] = 255;
      }
    }
    return out;
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

  // warp(srcPixels, sw, sh, H, dw, dh, ss) -> destination pixels (same channel count: 1 gray or 4 RGBA). H maps source -> destination;
  // every destination pixel is mapped back through H's inverse and sampled bilinearly (edges clamped): at its centre, or (ss > 1,
  // when the page is shrunk) as the average of ss x ss samples spread over the pixel, so a shrunk page stays smooth.
  function warp(src, sw, sh, H, dw, dh, ss) {
    const ch = Math.round(src.length / (sw * sh)) || 1;
    const out = new Uint8ClampedArray(dw * dh * ch);
    const Hi = invert3(H);
    if (!Hi) return out;
    const S = Math.max(1, Math.min(4, Math.round(ss || 1))), S2 = S * S;
    const acc = new Float32Array(ch);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        acc.fill(0);
        for (let sy = 0; sy < S; sy++) {
          const yc = y + (sy + 0.5) / S;
          for (let sx = 0; sx < S; sx++) {
            const xc = x + (sx + 0.5) / S;
            const wq = Hi[6] * xc + Hi[7] * yc + Hi[8];
            let u = (Hi[0] * xc + Hi[1] * yc + Hi[2]) / wq - 0.5, v = (Hi[3] * xc + Hi[4] * yc + Hi[5]) / wq - 0.5;
            if (u < 0) u = 0; else if (u > sw - 1) u = sw - 1;
            if (v < 0) v = 0; else if (v > sh - 1) v = sh - 1;
            const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
            const fx = u - x0, fy = v - y0;
            const i00 = (y0 * sw + x0) * ch, i10 = (y0 * sw + x1) * ch, i01 = (y1 * sw + x0) * ch, i11 = (y1 * sw + x1) * ch;
            for (let k = 0; k < ch; k++) {
              const top = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * fx;
              const bot = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * fx;
              acc[k] += top + (bot - top) * fy;
            }
          }
        }
        const o = (y * dw + x) * ch;
        for (let k = 0; k < ch; k++) out[o + k] = acc[k] / S2;
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
  // the warped page as a JPEG: long side min(maxLong, what the corners span in the still) - never upscaled. The warp samples the
  // FULL still (only cropped to the corners' bounding box, at full resolution); opts.clean: enhancePage on the result.
  async function straighten(bmp, corners, maxLong, opts) {
    const size = outputSize(corners, maxLong || MAX_LONG);
    const span = outputSize(corners, 1e9);
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const x1 = Math.min(bmp.width, Math.ceil(Math.max(...xs)) + 2), y1 = Math.min(bmp.height, Math.ceil(Math.max(...ys)) + 2);
    const sw = Math.max(1, x1 - x0), sh = Math.max(1, y1 - y0);
    const sc = root.document.createElement('canvas'); sc.width = sw; sc.height = sh;
    const sg = sc.getContext('2d'); sg.drawImage(bmp, x0, y0, sw, sh, 0, 0, sw, sh);
    const src = sg.getImageData(0, 0, sw, sh).data;
    sc.width = sc.height = 1; // let the crop go
    const from = corners.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
    const H = homography(from, [{ x: 0, y: 0 }, { x: size.w, y: 0 }, { x: size.w, y: size.h }, { x: 0, y: size.h }]);
    const ss = Math.max(1, Math.min(3, Math.ceil(Math.max(span.w, span.h) / Math.max(size.w, size.h) - 0.25)));
    const dc = root.document.createElement('canvas'); dc.width = size.w; dc.height = size.h;
    const dg = dc.getContext('2d');
    const img = dg.createImageData(size.w, size.h);
    if (H) {
      let px = warp(src, sw, sh, H, size.w, size.h, ss);
      if (opts && opts.clean) px = enhancePage(px, size.w, size.h);
      img.data.set(px);
    }
    dg.putImageData(img, 0, 0);
    return toBlob(dc, 0.92);
  }
  // sizeOf(blob) -> {w, h} of the decoded image (EXIF orientation honoured), or null
  async function sizeOf(blob) {
    try { const b = await bitmapOf(blob); const r = { w: b.width, h: b.height }; try { b.close && b.close(); } catch (e) { /* ignore */ } return r; } catch (e) { return null; }
  }
  // corners for a still: detectPage on a <= DETECT_LONG px copy (corners scaled back to the full still's pixels), else inset 8%
  function cornersFor(bmp) {
    const k = Math.min(1, DETECT_LONG / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const c = root.document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h);
    const found = detectPage(toGray(g.getImageData(0, 0, w, h).data, w, h), w, h);
    const s = bmp.width / w, t = bmp.height / h;
    return found ? { found: true, corners: found.map((p) => ({ x: p.x * s, y: p.y * t })) } : { found: false, corners: insetCorners(bmp.width, bmp.height) };
  }

  const CLEAN_KEY = 'waypoint:meta:scanClean'; // the corner screen's "Clean up page" (on unless turned off; remembered)
  const cleanPref = () => { try { return root.localStorage.getItem(CLEAN_KEY) !== '0'; } catch (e) { return true; } };
  const setCleanPref = (on) => { try { root.localStorage.setItem(CLEAN_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ } };
  let current = null; // the open corner screen: {close(action)}
  // cornerScreen(blob, {parent}) -> Promise<{action, blob, srcW, srcH, cleaned}>: 'use' = the straightened page (cleaned up when the
  // toggle is on), 'keep' = the shot as taken (never cleaned), 'retake' = discarded. close() (the camera closing) resolves 'retake'.
  // srcW x srcH: the still's own pixel size (shown in small text at the bottom).
  function cornerScreen(blob, opts) {
    const o = opts || {};
    return new Promise(async (resolve) => {
      let bmp;
      try { bmp = await bitmapOf(blob); } catch (e) { resolve({ action: 'keep', blob, srcW: null, srcH: null, cleaned: false }); return; } // undecodable: kept as shot
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
      const srcW = bmp.width, srcH = bmp.height;
      const finish = async (action) => {
        if (done) return;
        done = true;
        let out = blob, cleaned = false;
        if (action === 'use') {
          useBtn.disabled = keepBtn.disabled = retakeBtn.disabled = cleanBox.disabled = true;
          useBtn.textContent = 'Straightening…';
          cleaned = !!cleanBox.checked;
          // let the label paint before the (synchronous) warp
          await new Promise((r) => setTimeout(r, 30));
          try { out = await straighten(bmp, orderCorners(pts), o.maxLong || MAX_LONG, { clean: cleaned }); } catch (e) { out = blob; action = 'keep'; cleaned = false; }
        }
        try { bmp.close && bmp.close(); } catch (e) { /* ignore */ }
        root.removeEventListener('resize', layout);
        screen.remove();
        if (current === api) current = null;
        resolve({ action, blob: action === 'retake' ? null : out, srcW, srcH, cleaned });
      };
      const cleanBox = el('input', { type: 'checkbox', id: 'scanClean', checked: cleanPref() });
      cleanBox.addEventListener('change', () => setCleanPref(cleanBox.checked));
      const cleanRow = el('label', { class: 'scan-opt', for: 'scanClean' }, cleanBox, ' Clean up page');
      const srcLine = el('div', { class: 'scan-src', id: 'scanSrc' }, srcW + ' x ' + srcH);
      const useBtn = el('button', { class: 'ok', id: 'scanUse', type: 'button', onclick: () => finish('use') }, 'Use');
      const keepBtn = el('button', { id: 'scanKeep', type: 'button', onclick: () => finish('keep') }, 'Keep as shot');
      const retakeBtn = el('button', { id: 'scanRetake', type: 'button', onclick: () => finish('retake') }, 'Retake');
      const hint = el('div', { class: 'scan-hint', id: 'scanHint' }, det.found ? 'Drag the corners onto the page' : 'Page not found - drag the corners onto the page');
      const screen = el('div', { class: 'scan-screen', id: 'scanScreen', role: 'dialog', 'aria-label': 'Crop the delivery order' }, hint, stage, el('div', { class: 'scan-opts' }, cleanRow), el('div', { class: 'scan-actions' }, retakeBtn, keepBtn, useBtn), srcLine);
      (o.parent || root.document.body).append(screen);
      const api = { close: () => finish('retake') };
      current = api;
      // layout: the FULL still fitted into the stage; d = CSS px per image px. The canvas's backing store is the CSS size x
      // devicePixelRatio (rounded up), so the still is drawn at the screen's own pixels, not stretched.
      let d = 1, ox = 0, oy = 0, dpr = 1;
      function layout() {
        const r = stage.getBoundingClientRect();
        dpr = Math.max(1, Number(root.devicePixelRatio) || 1);
        d = Math.min(r.width / bmp.width, r.height / bmp.height) || 1;
        const dw = Math.max(1, Math.round(bmp.width * d)), dh = Math.max(1, Math.round(bmp.height * d));
        ox = Math.round((r.width - dw) / 2); oy = Math.round((r.height - dh) / 2);
        img.width = Math.ceil(dw * dpr); img.height = Math.ceil(dh * dpr);
        img.style.left = ox + 'px'; img.style.top = oy + 'px'; img.style.width = dw + 'px'; img.style.height = dh + 'px';
        const g = img.getContext('2d');
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(bmp, 0, 0, img.width, img.height);
        mag.width = mag.height = Math.ceil(120 * dpr);
        svg.setAttribute('width', String(r.width)); svg.setAttribute('height', String(r.height));
        paint();
      }
      function paint() {
        handles.forEach((hd, i) => { hd.style.left = (ox + pts[i].x * d) + 'px'; hd.style.top = (oy + pts[i].y * d) + 'px'; });
        poly.setAttribute('points', pts.map((p) => (ox + p.x * d) + ',' + (oy + p.y * d)).join(' '));
      }
      function magnify(i, clientX, clientY) {
        const r = stage.getBoundingClientRect(), S = 120, Z = 2.5, P = mag.width || S;
        const g = mag.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, P, P);
        // straight from the full still: S / Z CSS px around the corner = S / (Z d) still px
        const span = S / (Z * d);
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(bmp, pts[i].x - span / 2, pts[i].y - span / 2, span, span, 0, 0, P, P);
        const u = P / S;
        g.strokeStyle = '#f5a623'; g.lineWidth = 2 * u;
        g.beginPath(); g.moveTo(P / 2 - 10 * u, P / 2); g.lineTo(P / 2 + 10 * u, P / 2); g.moveTo(P / 2, P / 2 - 10 * u); g.lineTo(P / 2, P / 2 + 10 * u); g.stroke();
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

  return { DETECT_LONG, MAX_LONG, CLEAN_KEY, toGray, detectPage, fitCorners, fitLine, orderCorners, homography, apply, outputSize, warp, enhancePage, insetCorners, isConvexQuad, cornerScreen, closeCornerScreen, cornerScreenOpen, straighten, sizeOf };
});
