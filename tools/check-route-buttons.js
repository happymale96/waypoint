#!/usr/bin/env node
/* Route card button contrast guard (no dependencies).
 * The one primary button on a Route card reads REACHED (solid blue-grey: the "Open in Google Maps" token --brand with --brand-text)
 * and then "✓ DONE" (solid green: --ok with --ok-text). For both colour schemes this reads the tokens from styles.css, checks the two
 * CSS rules still use them, computes the WCAG contrast of the label against the button and exits 1 if either is under 4.5:1.
 *   node tools/check-route-buttons.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIN = 4.5;
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

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

const errs = [];
// the two rules and the tokens they must use
const RULES = [
  { name: 'REACHED', sel: /button\.ok\[data-act="reached"\]\s*\{([^}]*)\}/, bg: '--brand', fg: '--brand-text' },
  { name: '✓ DONE', sel: /button\.ok\[data-act="done"\]\s*\{([^}]*)\}/, bg: '--ok', fg: '--ok-text' },
];
RULES.forEach((r) => {
  const m = r.sel.exec(css);
  if (!m) { errs.push(r.name + ': rule not found in styles.css'); return; }
  if (!new RegExp('background:\\s*var\\(' + r.bg + '\\)').test(m[1])) errs.push(r.name + ': background is not var(' + r.bg + ')');
  if (!new RegExp('(^|[;\\s])color:\\s*var\\(' + r.fg + '\\)').test(m[1])) errs.push(r.name + ': color is not var(' + r.fg + ')');
});
// "Open in Google Maps" is a.btn.primary: the REACHED colour must stay its token
if (!/a\.btn\.primary\s*\{[^}]*background:\s*var\(--brand\);[^}]*color:\s*var\(--brand-text\)/.test(css)) errs.push('a.btn.primary (Open in Google Maps) no longer uses --brand / --brand-text: update this check');

const darkBlock = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(css);
const lightRoot = /^:root\s*\{([^}]*)\}/m.exec(css);
const tok = (block, name) => { const m = block && new RegExp(name.replace(/-/g, '\\-') + ':\\s*(#[0-9a-fA-F]{3,6})').exec(block); return m ? m[1] : null; };
const schemes = [['light', lightRoot && lightRoot[1], null], ['dark', darkBlock && darkBlock[1], lightRoot && lightRoot[1]]];

const rows = [];
schemes.forEach(([scheme, block, fallback]) => {
  RULES.forEach((r) => {
    const bg = tok(block, r.bg) || tok(fallback, r.bg), fg = tok(block, r.fg) || tok(fallback, r.fg);
    if (!bg || !fg) { errs.push(scheme + ' ' + r.name + ': token ' + (!bg ? r.bg : r.fg) + ' not found'); return; }
    const ratio = contrast(hex(bg), hex(fg));
    if (ratio < MIN) errs.push(scheme + ' ' + r.name + ': ' + fg + ' on ' + bg + ' = ' + ratio.toFixed(2) + ':1 (under ' + MIN + ':1)');
    rows.push([scheme, r.name, bg, fg, ratio.toFixed(2) + ':1']);
  });
});
rows.forEach((r) => console.log(r.join('  ')));
if (errs.length) { console.error('check-route-buttons FAILED:\n - ' + errs.join('\n - ')); process.exit(1); }
console.log('check-route-buttons OK: REACHED (--brand) and ✓ DONE (--ok) labels at least ' + MIN + ':1 in both schemes');
