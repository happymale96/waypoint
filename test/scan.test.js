'use strict';
// DO page straightening (scan.js, pure parts): detectPage on a synthetic 400 x 300 image, orderCorners, homography, outputSize, warp.
// Run: node test/scan.test.js
const Scan = require('../scan.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const W = 400, H = 300, DARK = 30, BRIGHT = 225;
const QUAD = [{ x: 62, y: 38 }, { x: 328, y: 58 }, { x: 352, y: 262 }, { x: 44, y: 244 }]; // tl, tr, br, bl: a skewed page

function inside(q, x, y) { // convex, clockwise on screen
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
  }
  return true;
}
function synth(q) {
  const g = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = inside(q, x + 0.5, y + 0.5) ? BRIGHT : DARK;
  return g;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

console.log('detectPage');
const img = synth(QUAD);
const found = Scan.detectPage(img, W, H);
ok(Array.isArray(found) && found.length === 4, 'four corners found', found);
const errs = found ? found.map((p, i) => dist(p, QUAD[i])) : [];
ok(found && errs.every((e) => e <= 6), 'each corner within 6 px of the drawn one (tl, tr, br, bl)', errs.map((e) => +e.toFixed(2)));
ok(Scan.detectPage(new Uint8ClampedArray(W * H).fill(10), W, H) === null, 'all dark: null');
ok(Scan.detectPage(new Uint8ClampedArray(W * H).fill(250), W, H) === null, 'all bright: null');
{
  const small = synth([{ x: 180, y: 130 }, { x: 220, y: 130 }, { x: 220, y: 170 }, { x: 180, y: 170 }]); // ~1.3% of the frame
  ok(Scan.detectPage(small, W, H) === null, 'a bright patch under 15% of the frame: null');
}
{
  // a larger image (1600 x 1200) is worked on a 400 px copy; the corners come back in its own pixels
  const BW = 1600, BH = 1200, k = 4, big = new Uint8ClampedArray(BW * BH);
  const Q4 = QUAD.map((p) => ({ x: p.x * k, y: p.y * k }));
  for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) big[y * BW + x] = inside(Q4, x + 0.5, y + 0.5) ? BRIGHT : DARK;
  const f4 = Scan.detectPage(big, BW, BH);
  ok(f4 && f4.every((p, i) => dist(p, Q4[i]) <= 6 * k), 'a 1600 x 1200 image: corners within 24 px (6 px at the 400 px working size)', f4);
}

console.log('orderCorners');
{
  const shuffled = [QUAD[2], QUAD[0], QUAD[3], QUAD[1]];
  ok(JSON.stringify(Scan.orderCorners(shuffled)) === JSON.stringify(QUAD), 'shuffled -> tl, tr, br, bl', Scan.orderCorners(shuffled));
  const sq = [{ x: 10, y: 90 }, { x: 90, y: 10 }, { x: 10, y: 10 }, { x: 90, y: 90 }];
  ok(JSON.stringify(Scan.orderCorners(sq)) === JSON.stringify([{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]), 'a square in any order');
}

console.log('homography');
const size = Scan.outputSize(QUAD, 2000);
const rect = [{ x: 0, y: 0 }, { x: size.w, y: 0 }, { x: size.w, y: size.h }, { x: 0, y: size.h }];
{
  const Hm = Scan.homography(QUAD, rect);
  ok(Hm && Hm.length === 9 && Hm[8] === 1, 'a 3 x 3 matrix (h33 = 1)');
  const e = QUAD.map((p, i) => dist(Scan.apply(Hm, p.x, p.y), rect[i]));
  ok(e.every((x) => x < 0.01), 'each source corner lands on its destination corner within 0.01', e);
  ok(Scan.homography([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], rect) === null, 'collinear points: null');
}

console.log('outputSize');
{
  const s = Scan.outputSize(QUAD, 2000);
  const want = { w: Math.round((dist(QUAD[0], QUAD[1]) + dist(QUAD[3], QUAD[2])) / 2), h: Math.round((dist(QUAD[0], QUAD[3]) + dist(QUAD[1], QUAD[2])) / 2) };
  ok(s.w === want.w && s.h === want.h, 'width / height = the average of opposite edges', { s, want });
  const big = Scan.outputSize([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }], 2000);
  ok(big.w === 2000 && big.h === 1500, 'long side capped at maxLong, aspect kept', big);
}

console.log('warp');
{
  const Hm = Scan.homography(found, rect);
  const out = Scan.warp(img, W, H, Hm, size.w, size.h);
  let bright = 0;
  for (let i = 0; i < out.length; i++) if (out[i] > (DARK + BRIGHT) / 2) bright++;
  const frac = bright / out.length;
  ok(out.length === size.w * size.h, 'one gray value per destination pixel', out.length);
  ok(frac >= 0.97, 'the straightened page is bright in at least 97% of its pixels (' + (frac * 100).toFixed(2) + '%)', frac);
  // RGBA works the same (4 channels)
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = img[i]; rgba[i * 4 + 1] = img[i]; rgba[i * 4 + 2] = img[i]; rgba[i * 4 + 3] = 255; }
  const o4 = Scan.warp(rgba, W, H, Hm, size.w, size.h);
  ok(o4.length === size.w * size.h * 4 && o4[3] === 255 && Math.abs(o4[(Math.floor(size.h / 2) * size.w + Math.floor(size.w / 2)) * 4] - BRIGHT) <= 1, 'RGBA in, RGBA out');
  const g = Scan.toGray(rgba, W, H);
  ok(g.length === W * H && g[0] === DARK, 'toGray: RGBA -> one value per pixel');
}

console.log('detectPage: robust side lines (a finger notch, a rounded corner)');
{
  const Q = [{ x: 58, y: 36 }, { x: 336, y: 52 }, { x: 350, y: 266 }, { x: 40, y: 250 }];
  const R = 40; // the rounded corner's radius (bottom-right)
  const unit = (a, b) => { const l = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
  const C = Q[2], e1 = unit(C, Q[1]), e2 = unit(C, Q[3]);
  const half = Math.acos(e1.x * e2.x + e1.y * e2.y) / 2, t = R / Math.tan(half);
  const bis = unit({ x: 0, y: 0 }, { x: e1.x + e2.x, y: e1.y + e2.y }), oc = { x: C.x + bis.x * R / Math.sin(half), y: C.y + bis.y * R / Math.sin(half) };
  const det = e1.x * e2.y - e1.y * e2.x;
  const rounded = (x, y) => { // inside the corner's tangent rhombus and outside the arc
    const dx = x - C.x, dy = y - C.y, s = (dx * e2.y - dy * e2.x) / det, u = (e1.x * dy - e1.y * dx) / det;
    return s >= 0 && u >= 0 && s <= t && u <= t && Math.hypot(x - oc.x, y - oc.y) > R;
  };
  // the finger: a 24 px wide capsule from outside the page 30 px into it, across the bottom side at 35%
  const fa = { x: Q[3].x + (Q[2].x - Q[3].x) * 0.35, y: Q[3].y + (Q[2].y - Q[3].y) * 0.35 + 30 }, fb = { x: fa.x + 4, y: fa.y - 60 };
  const finger = (x, y) => { const vx = fb.x - fa.x, vy = fb.y - fa.y, k = Math.max(0, Math.min(1, ((x - fa.x) * vx + (y - fa.y) * vy) / (vx * vx + vy * vy))); return Math.hypot(x - fa.x - k * vx, y - fa.y - k * vy) < 12; };
  const g = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = x + 0.5, py = y + 0.5;
    g[y * W + x] = inside(Q, px, py) && !rounded(px, py) && !finger(px, py) ? BRIGHT : DARK;
  }
  const fit = Scan.detectPage(g, W, H), old = Scan.detectPage(g, W, H, { fit: false });
  const eFit = fit ? fit.map((p, i) => dist(p, Q[i])) : [], eOld = old ? old.map((p, i) => dist(p, Q[i])) : [];
  ok(fit && eFit.every((e) => e <= 4), 'fitted corners within 4 px of the true corners', eFit.map((e) => +e.toFixed(2)));
  ok(old && Math.max(...eOld) > 10, 'the extreme-point corners are off by more than 10 px (the rounded corner)', eOld.map((e) => +e.toFixed(2)));
  // a bright thumb sticking out of the left side: the side line ignores it
  const g2 = Uint8ClampedArray.from(g);
  const ta = { x: Q[0].x + (Q[3].x - Q[0].x) * 0.6 - 30, y: Q[0].y + (Q[3].y - Q[0].y) * 0.6 }, tb = { x: ta.x + 40, y: ta.y + 6 };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const vx = tb.x - ta.x, vy = tb.y - ta.y, k = Math.max(0, Math.min(1, ((x + 0.5 - ta.x) * vx + (y + 0.5 - ta.y) * vy) / (vx * vx + vy * vy)));
    if (Math.hypot(x + 0.5 - ta.x - k * vx, y + 0.5 - ta.y - k * vy) < 11) g2[y * W + x] = 200;
  }
  const fit2 = Scan.detectPage(g2, W, H);
  const e2s = fit2 ? fit2.map((p, i) => dist(p, Q[i])) : [];
  ok(fit2 && e2s.every((e) => e <= 4), 'with a bright thumb over the left side too: still within 4 px', e2s.map((e) => +e.toFixed(2)));
  ok(Scan.detectPage(img, W, H).every((p, i) => dist(p, QUAD[i]) <= 3), 'the plain skewed page: within 3 px with the side lines', Scan.detectPage(img, W, H));
  // dark text lines inside the page (holes in the bright region) are not part of the outline
  const g3 = Uint8ClampedArray.from(img);
  for (let k = 0; k < 6; k++) for (let y = 80 + k * 25; y < 86 + k * 25; y++) for (let x = 110; x < 300; x++) g3[y * W + x] = DARK;
  const f3 = Scan.detectPage(g3, W, H);
  ok(f3 && f3.every((p, i) => dist(p, QUAD[i]) <= 3), 'dark text lines inside the page: corners still within 3 px', f3 && f3.map((p, i) => +dist(p, QUAD[i]).toFixed(2)));
  // the fit falls back to the extreme points when a side has too few points
  ok(Scan.fitCorners([], QUAD, W, H) === null, 'fitCorners: no outline -> null (detectPage keeps the extreme points)');
  const line = Scan.fitLine([...Array(40)].map((_, i) => ({ x: i, y: 10 + (i % 7 === 0 ? 25 : 0) })), 4, 0.2);
  ok(line && Math.abs(Math.abs(line.ny) - 1) < 1e-6 && Math.abs(line.c / line.ny - 10) < 1e-6, 'fitLine: the outliers dropped, y = 10 exactly', line);
}

console.log('enhancePage');
{
  const PW = 400, PH = 300, px = new Uint8ClampedArray(PW * PH * 4);
  const paperAt = (x) => 140 + (80 * x) / (PW - 1); // a left-to-right lighting ramp, 140 -> 220
  const isText = (x, y) => { const r = (y - 30) % 34; return y >= 30 && y < 250 && r >= 0 && r < 6 && x >= 20 && x < 380 && (x - 20) % 30 < 20; };
  const isRed = (x, y) => x >= 300 && x < 324 && y >= 262 && y < 286;
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const j = (y * PW + x) * 4, p = paperAt(x);
    let c = [p, p, p];
    if (isText(x, y)) c = [p * 0.3, p * 0.3, p * 0.3];
    else if (isRed(x, y)) c = [p * 0.9, p * 0.25, p * 0.22];
    px[j] = c[0]; px[j + 1] = c[1]; px[j + 2] = c[2]; px[j + 3] = 255;
  }
  const out = Scan.enhancePage(px, PW, PH);
  const lum = (i) => 0.299 * out[i * 4] + 0.587 * out[i * 4 + 1] + 0.114 * out[i * 4 + 2];
  const near = (x, y, f) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (f(x + dx, y + dy)) return true; return false; };
  let pMin = 255, pMax = 0, tMax = 0, redOk = true, redN = 0, tN = 0;
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const i = y * PW + x;
    if (isText(x, y)) { tMax = Math.max(tMax, lum(i)); tN++; }
    else if (isRed(x, y)) { redN++; const r = out[i * 4], g = out[i * 4 + 1], b = out[i * 4 + 2]; if (!(r > g && r > b)) redOk = false; }
    else if (!near(x, y, isText) && !near(x, y, isRed)) { const v = lum(i); pMin = Math.min(pMin, v); pMax = Math.max(pMax, v); }
  }
  ok(out.length === px.length && out[3] === 255, 'RGBA in, RGBA out (same size)');
  ok(pMin > 230 && pMax - pMin <= 12, 'paper across the page: above 230 and within 12 levels (' + pMin.toFixed(1) + ' .. ' + pMax.toFixed(1) + ')', { pMin, pMax });
  ok(tN > 0 && tMax < 60, 'text pixels below 60 (darkest text ' + tMax.toFixed(1) + ')', tMax);
  ok(redN > 0 && redOk, 'the red patch keeps red as its largest channel');
  const grays = new Set();
  for (let i = 0; i < PW * PH; i++) grays.add(Math.round(lum(i)));
  ok(grays.size > 20, 'not thresholded: many grey levels remain (' + grays.size + ')', grays.size);
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
