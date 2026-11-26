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

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
