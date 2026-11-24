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
  if (!/Geo\.lunchCardText\(p\.closedWindows\) \? h\('div', \{ class: 'place-closed'/.test(block)) errs.push('closed line is not conditional on the closed-window text');
  if (!/'Lunch '\s*\+\s*Geo\.lunchCardText\(p\.closedWindows\)/.test(block)) errs.push("closed line text is not 'Lunch ' + Geo.lunchCardText(p.closedWindows)");
  // the WhatsApp line: ONE conditional div whose text is Geo.waCardText(contact name, number) (no extra line for the name)
  if (!/Geo\.waCardText\(p\.contactName, p\.whatsapp \? Messages\.compactNumber\(p\.whatsapp\) : ''\) \? h\('div', \{ class: 'muted place-wa' \}, Geo\.waCardText\(p\.contactName/.test(block)) errs.push('WhatsApp line is not its own conditional div of Geo.waCardText(contactName, number)');
  if ((block.match(/place-wa/g) || []).length !== 1 || /contactName \? h\('div'/.test(block)) errs.push('the contact name adds a line to the card');
  if (/'\s*·\s*/.test(block)) errs.push('stray separator dot in the Places card render path');
  const iAddr = block.indexOf('p.address'), iWa = block.indexOf('p.whatsapp'), iCl = block.indexOf('place-closed');
  if (!(iAddr >= 0 && iAddr < iWa && iWa < iCl)) errs.push('line order is not address -> WhatsApp -> closed');
}
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((r) => ({ sel: r[1].trim(), body: r[2] }));
const own = rules.filter((r) => r.sel.split(',').some((s) => s.trim() === '.place-closed'));
if (!own.some((r) => /display:\s*block/.test(r.body))) errs.push('.place-closed has no display:block rule');
if (own.some((r) => /var\(--muted\)/.test(r.body))) errs.push('.place-closed uses the dim --muted colour');
if (!own.some((r) => /color:\s*var\(--text\)/.test(r.body))) errs.push('.place-closed is not coloured var(--text)');

// the contact-name line text (test 22): name + number on ONE line, name only, number only as before
const Geo = require(path.join(ROOT, 'geo.js'));
if (Geo.waCardText('Encik Ali', '012-345 6789') !== 'Encik Ali · 012-345 6789') errs.push('name + number is not "Encik Ali · 012-345 6789"');
if (Geo.waCardText('Encik Ali', '') !== 'Encik Ali') errs.push('name only is not "Encik Ali"');
if (Geo.waCardText('', '+60123456789') !== 'WA +60123456789') errs.push('number only is not as before ("WA <number>")');

if (errs.length) { console.error('check-places-card FAILED:\n - ' + errs.join('\n - ')); process.exit(1); }
console.log('check-places-card OK: no Dwell on the card; Lunch hours in their own block line; contact name on the WhatsApp line');
