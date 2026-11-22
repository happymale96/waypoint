#!/usr/bin/env node
/* Header symbol contrast guard (no dependencies).
 * For each colour scheme: reads the header background (--brand, which .topbar uses) from styles.css, finds which symbol
 * SVG index.html's <picture> shows in that scheme, reads that SVG's lobe fills, computes the WCAG contrast of each lobe
 * against the header, prints a table and exits 1 if any lobe is under 1.7:1.
 *   node tools/check-header-contrast.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIN = 1.7;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const css = read('styles.css'), html = read('index.html');

function hex(c) {
  c = c.trim().toLowerCase();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c), m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(c);
  if (m3) return m3.slice(1).map((h) => parseInt(h + h, 16));
  if (m6) return m6.slice(1).map((h) => parseInt(h, 16));
  throw new Error('cannot parse colour ' + c);
}
function lum(rgb) {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// header background: .topbar uses var(--brand); light = :root, dark = :root inside the prefers-color-scheme: dark block
if (!/\.topbar\s*\{[^}]*background:\s*var\(--brand\)/.test(css)) { console.error('.topbar background is no longer var(--brand): update this check'); process.exit(2); }
const darkBlock = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(css);
const lightBrand = /^:root\s*\{[^}]*--brand:\s*(#[0-9a-fA-F]{3,6})/m.exec(css);
const darkBrand = darkBlock && /--brand:\s*(#[0-9a-fA-F]{3,6})/.exec(darkBlock[1]);
if (!lightBrand || !darkBrand) { console.error('cannot find --brand for both schemes'); process.exit(2); }

// symbol per scheme from the header <picture>
const pic = /<header class="topbar"><picture>([\s\S]*?)<\/picture>/.exec(html);
if (!pic) { console.error('header <picture> not found'); process.exit(2); }
const darkSrc = /<source[^>]*prefers-color-scheme:\s*dark[^>]*srcset="([^"]+)"/.exec(pic[1]);
const defSrc = /<img[^>]*\bsrc="([^"]+)"/.exec(pic[1]);
if (!darkSrc || !defSrc) { console.error('header picture needs a dark <source> and a default <img>'); process.exit(2); }

function fills(svgFile) {
  const svg = read(svgFile);
  const defs = {};
  for (const m of svg.matchAll(/\.(cls-\d+)\s*\{[^}]*?fill:\s*(#[0-9a-fA-F]{3,6})/g)) defs[m[1]] = m[2];
  const used = new Set();
  for (const m of svg.matchAll(/<path[^>]*class="(cls-\d+)"/g)) used.add(m[1]);
  for (const m of svg.matchAll(/<path[^>]*\bfill="(#[0-9a-fA-F]{3,6})"/g)) defs['inline ' + m[1]] = m[1], used.add('inline ' + m[1]);
  return [...used].sort().map((c) => ({ cls: c, fill: defs[c] })).filter((x) => x.fill);
}

let fail = 0;
const rows = [];
[['light', lightBrand[1], defSrc[1]], ['dark', darkBrand[1], darkSrc[1]]].forEach(([scheme, bg, file]) => {
  fills(file).forEach(({ cls, fill }) => {
    const ratio = contrast(hex(bg), hex(fill));
    const pass = ratio >= MIN;
    if (!pass) fail++;
    rows.push([scheme, bg, file, cls, fill, ratio.toFixed(2) + ':1', pass ? 'ok' : 'FAIL']);
  });
});
const head = ['scheme', 'header bg', 'file shown', 'lobe', 'fill', 'contrast', ''];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ');
console.log(line(head)); rows.forEach((r) => console.log(line(r)));
console.log(fail ? fail + ' lobe(s) under ' + MIN + ':1' : 'header contrast ok (min ' + MIN + ':1)');
process.exit(fail ? 1 : 0);
