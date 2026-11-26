#!/usr/bin/env node
/* Verifies the app icons against the pre-rendered icon pack.
 *   node tools/verify-icons.js [folder containing the unzipped pack and its SHA256SUMS.txt]
 * Without the pack folder the SHA-256-against-pack check is skipped (the derived-file and structural checks still run).
 * Exits non-zero unless:
 *   - every icon file referenced by manifest.json and index.html exists
 *   - each PNG's IHDR width/height match its declared size (manifest "sizes", <link sizes>, or the size in the name)
 *   - each copied PNG/SVG's SHA-256 equals the matching line in the pack's SHA256SUMS.txt
 *   - the manifest has "any" and "maskable" entries at 192 and 512
 *   - every SHELL entry in sw.js and tools/stamp-sw.js (except './') exists on disk
 *   - the four -v2 manifest icons have their fixed SHA-256 values
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const packDir = process.argv[2];
let failures = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

if (packDir && !fs.existsSync(path.join(packDir, 'SHA256SUMS.txt'))) {
  console.error('no SHA256SUMS.txt in ' + packDir);
  process.exit(2);
}

function pngSize(f) {
  const b = fs.readFileSync(f);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v) || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// referenced icon files: [file, declared px or null]
const refs = new Map();
const add = (f, px) => { if (!refs.has(f) || (px && !refs.get(f))) refs.set(f, px || refs.get(f) || null); };
(manifest.icons || []).forEach((i) => add(i.src, parseInt(String(i.sizes).split('x')[0], 10)));
for (const m of html.matchAll(/<link\b[^>]*\brel="(?:icon|apple-touch-icon)"[^>]*>/g)) {
  const href = /href="([^"]+)"/.exec(m[0]);
  const sz = /sizes="(\d+)x\d+"/.exec(m[0]);
  if (href) add(href[1], sz ? parseInt(sz[1], 10) : null);
}
for (const m of html.matchAll(/<(?:img|source)\b[^>]*\b(?:src|srcset)="([^"]+\.(?:png|svg))"/g)) add(m[1], null);

console.log('referenced files exist');
refs.forEach((px, f) => ok(fs.existsSync(path.join(ROOT, f)), f + ' exists'));

console.log('PNG sizes (IHDR)');
refs.forEach((px, f) => {
  if (!/\.png$/i.test(f) || !fs.existsSync(path.join(ROOT, f))) return;
  const named = /-(\d+)(?:\.png)$/.exec(f);
  const want = px || (named ? parseInt(named[1], 10) : null);
  const sz = pngSize(path.join(ROOT, f));
  ok(sz && want && sz.w === want && sz.h === want, f + ' is ' + (sz ? sz.w + 'x' + sz.h : 'not a PNG') + ', declared ' + want + 'x' + want);
});

console.log('SHA-256 against pack SHA256SUMS.txt' + (packDir ? '' : ' (skipped: no pack folder given)'));
const sums = new Map();
if (packDir) fs.readFileSync(path.join(packDir, 'SHA256SUMS.txt'), 'utf8').split(/\r?\n/).forEach((l) => {
  const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(l.trim());
  if (m) sums.set(m[2].trim(), m[1].toLowerCase());
});
// repo file -> pack file (same role; the manifest icons carry a -v2 name in the repo so installed copies refetch them)
const MAP = {
  'icon-v2-192.png': 'icon-192.png', 'icon-v2-512.png': 'icon-512.png',
  'maskable-v2-192.png': 'maskable-192.png', 'maskable-v2-512.png': 'maskable-512.png',
  'apple-touch-icon-180.png': 'apple-touch-icon-180.png', 'favicon-48.png': 'favicon-48.png', 'favicon-32.png': 'favicon-32.png',
  'favicon.svg': 'favicon.svg', 'icon-maskable.svg': 'icon-maskable.svg', 'icon-rounded.svg': 'icon-rounded.svg',
  'symbol-on-light.svg': 'symbol-on-light.svg', 'symbol-on-dark.svg': 'symbol-on-dark.svg',
};
if (packDir) Object.entries(MAP).forEach(([repoFile, packFile]) => {
  const want = sums.get(packFile);
  const p = path.join(ROOT, repoFile);
  ok(!!want && fs.existsSync(p) && sha(p) === want, repoFile + ' matches pack ' + packFile);
});

console.log('service worker SHELL files exist');
for (const f of ['sw.js', path.join('tools', 'stamp-sw.js')]) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const m = /const SHELL = \[([\s\S]*?)\];/.exec(src);
  ok(!!m, f + ' has a SHELL list');
  if (m) for (const e of m[1].matchAll(/'([^']+)'/g)) {
    if (e[1] === './') continue;
    ok(fs.existsSync(path.join(ROOT, e[1])), f + ' SHELL: ' + e[1] + ' exists');
  }
}

console.log('renamed manifest icons keep their exact bytes (SHA-256)');
const RENAMED = {
  'icon-v2-192.png': 'f7f0f5925498a0076fbcb6ff2d52e574c25f50fe4c63af92cb7511e20d38f943',
  'icon-v2-512.png': '2ba074218424cc7a8834d375d6adfc1ed9ee977bb1302500e558c137b2184ed4',
  'maskable-v2-192.png': 'b3fdfd6d8bd1bd40bd8a938ea82913fb1808a01c598fe8e7385363fa45172fb2',
  'maskable-v2-512.png': 'c33cd9d44200f960bbce2e20487705f76318bae17176dcbf260a8cb7f2190c7b',
};
Object.entries(RENAMED).forEach(([f, want]) => {
  const p = path.join(ROOT, f);
  ok(fs.existsSync(p) && sha(p) === want, f + ' SHA-256 is ' + want.slice(0, 12) + '…');
});

console.log('derived header symbol');
{
  // symbol-header-onlight.svg = official symbol-on-light.svg with ONLY the light lobe fill (#aec0ce) changed to #ffffff
  const a = path.join(ROOT, 'symbol-on-light.svg'), b = path.join(ROOT, 'symbol-header-onlight.svg');
  ok(fs.existsSync(b), 'symbol-header-onlight.svg exists');
  if (fs.existsSync(a) && fs.existsSync(b)) {
    const want = fs.readFileSync(a, 'utf8').replace('fill: #aec0ce;', 'fill: #ffffff;');
    ok(fs.readFileSync(b, 'utf8') === want, 'symbol-header-onlight.svg differs from symbol-on-light.svg only by the light lobe fill (#ffffff)');
  }
}

console.log('manifest purposes');
['any', 'maskable'].forEach((purpose) => [192, 512].forEach((px) => {
  const e = (manifest.icons || []).find((i) => i.sizes === px + 'x' + px && String(i.purpose).split(' ').includes(purpose));
  ok(!!e, 'manifest has "' + purpose + '" ' + px + 'x' + px + (e ? ' (' + e.src + ')' : ''));
}));
ok(manifest.background_color === '#ffffff', 'manifest background_color is #ffffff');

console.log(failures ? failures + ' icon verification(s) failed' : 'icon verification passed');
process.exit(failures ? 1 : 0);
