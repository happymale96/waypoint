#!/usr/bin/env node
/* Checks the three app icons exist at the stated pixel sizes, that the manifest references them with the right
 * purpose, that the maskable icon keeps all artwork inside the central 80% safe zone, and that index.html uses them.
 *   node tools/check-icons.js      (exit 1 on any failure)
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } };

function pngSize(f) {
  const b = fs.readFileSync(path.join(ROOT, f));
  if (b.length < 24 || b.toString('latin1', 1, 4) !== 'PNG') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const EXPECT = [['icon-192.png', 192, 'any'], ['icon-512.png', 512, 'any'], ['maskable-192.png', 192, 'maskable'], ['icon-512-maskable.png', 512, 'maskable']];
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

console.log('icons');
EXPECT.forEach(([f, px, purpose]) => {
  const sz = fs.existsSync(path.join(ROOT, f)) ? pngSize(f) : null;
  ok(sz && sz.w === px && sz.h === px, f + ' exists at ' + px + 'x' + px + (sz ? ' (is ' + sz.w + 'x' + sz.h + ')' : ' (missing)'));
  const entry = (manifest.icons || []).find((i) => i.src === f);
  ok(entry && entry.sizes === px + 'x' + px && String(entry.purpose).split(' ').includes(purpose), 'manifest references ' + f + ' as ' + px + 'x' + px + ' "' + purpose + '"');
  ok(sw.includes("'" + f + "'"), 'service worker precaches ' + f);
});
ok(/rel="icon" href="favicon\.svg"/.test(html) && /rel="icon" href="favicon-48\.png"/.test(html), 'favicons use favicon.svg / favicon-48.png');
ok(/rel="apple-touch-icon" href="apple-touch-icon-180\.png"/.test(html), 'apple-touch-icon uses apple-touch-icon-180.png');
ok(/<header class="topbar"><picture>.*symbol-on-dark\.svg/.test(html), 'header uses the symbol-only SVG');

(async () => {
  // maskable safe zone: every non-background pixel inside the central 80% square (and the inscribed 80% circle)
  let sharp = null;
  try { sharp = require(path.join(__dirname, 'node_modules', 'sharp')); } catch (e) { /* sharp optional */ }
  if (!sharp) { ok(false, 'sharp is installed in tools/ (needed for the safe-zone check)'); return; }
  const { data, info } = await sharp(path.join(ROOT, 'icon-512-maskable.png')).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  const N = info.width, ch = info.channels, c = N / 2, r = N * 0.4;
  let minX = N, maxX = -1, minY = N, maxY = -1, outside = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * ch;
    if (data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    if (Math.hypot(x + 0.5 - c, y + 0.5 - c) > r) outside++;
  }
  const lo = Math.ceil(N * 0.1), hi = Math.floor(N * 0.9);
  ok(maxX >= 0 && minX >= lo && maxX <= hi && minY >= lo && maxY <= hi, 'maskable artwork box x ' + minX + '-' + maxX + ', y ' + minY + '-' + maxY + ' is inside the central 80% (' + lo + '-' + hi + ')');
  ok(outside === 0, 'maskable artwork is inside the 80% safe circle (' + outside + ' px outside)');
})().then(() => {
  console.log(failures ? failures + ' icon check(s) failed' : 'icon checks passed');
  process.exit(failures ? 1 : 0);
});
