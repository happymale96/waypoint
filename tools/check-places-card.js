#!/usr/bin/env node
/* Places card content check (no dependencies).
 *  1. The Places list card render path (app.js, from the card div to the empty-state) has no "Dwell" text.
 *  2. Closed hours are emitted in their own block-level div, prefixed "Lunch ", conditional on closedWindows.
 *  3. CSS: that div is display:block and does not use the dim --muted colour.
 * Exit 1 on failure. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const errs = [];

const start = app.indexOf("h('div', { class: 'card', onclick: () => openPlaceEditor(p) }");
const end = app.indexOf("h('div', { class: 'empty card' }, none)", start);
if (start < 0 || end < 0) errs.push('Places card render path not found in app.js');
else {
  const block = app.slice(start, end);
  if (/dwell/i.test(block)) errs.push('Places card render path mentions Dwell');
  const m = block.match(/h\('div',\s*\{\s*class:\s*'([^']*\bplace-closed\b[^']*)'\s*\},\s*'Lunch '\s*\+/);
  if (!m) errs.push("closed hours are not emitted as h('div', {class:'place-closed'}, 'Lunch ' + ...)");
  if (!/\(p\.closedWindows \|\| \[\]\)\.length \? h\('div', \{ class: 'place-closed'/.test(block)) errs.push('closed line is not conditional on closedWindows');
  if (!/p\.whatsapp \? h\('div'/.test(block)) errs.push('WhatsApp line is not its own conditional div');
  if (/'\s*·\s*/.test(block)) errs.push('stray separator dot in the Places card render path');
  const iAddr = block.indexOf('p.address'), iWa = block.indexOf('p.whatsapp'), iCl = block.indexOf('place-closed');
  if (!(iAddr >= 0 && iAddr < iWa && iWa < iCl)) errs.push('line order is not address -> WhatsApp -> closed');
}
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((r) => ({ sel: r[1].trim(), body: r[2] }));
const own = rules.filter((r) => r.sel.split(',').some((s) => s.trim() === '.place-closed'));
if (!own.some((r) => /display:\s*block/.test(r.body))) errs.push('.place-closed has no display:block rule');
if (own.some((r) => /var\(--muted\)/.test(r.body))) errs.push('.place-closed uses the dim --muted colour');
if (!own.some((r) => /color:\s*var\(--text\)/.test(r.body))) errs.push('.place-closed is not coloured var(--text)');

if (errs.length) { console.error('check-places-card FAILED:\n - ' + errs.join('\n - ')); process.exit(1); }
console.log('check-places-card OK: no Dwell on the card; Lunch hours in their own block line');
