#!/usr/bin/env node
/* Places card layout check (no dependencies).
 *  1. The place-card markup in app.js emits the type tag in its own block-level element, after the name element.
 *  2. No CSS rule lays the name and the tag out in the same flex/grid row.
 * Exit 1 on failure. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const errs = [];

// ---- markup: the place card is the one that shows typeLabel(p.type) in a 'chip' span
const lines = app.split('\n');
const tagIdx = lines.findIndex((l) => /class:\s*'chip'/.test(l) && /Messages\.typeLabel\(p\.type\)/.test(l));
if (tagIdx < 0) errs.push('place-card tag line (chip + Messages.typeLabel(p.type)) not found in app.js');
else {
  const tagLine = lines[tagIdx];
  const nameIdx = lines.slice(Math.max(0, tagIdx - 3), tagIdx + 1).map((l, i) => [Math.max(0, tagIdx - 3) + i, l])
    .filter(([, l]) => /class:\s*'title[^']*'/.test(l) && /p\.name/.test(l)).map(([i]) => i)[0];
  if (nameIdx === undefined) errs.push('place-card name element (title + p.name) not found next to the tag');
  else if (nameIdx >= tagIdx) errs.push('tag is not emitted after the name element');
  if (nameIdx === tagIdx) errs.push('name and tag are emitted in the same element line');
  // the tag chip must sit inside its own block-level wrapper (a div), and that wrapper must not also hold the name
  const m = tagLine.match(/h\('div',\s*\{\s*class:\s*'([^']*)'\s*\},\s*h\('span',\s*\{\s*class:\s*'chip'/);
  if (!m) errs.push("tag chip is not wrapped in its own h('div', ...) block element");
  else {
    if (/\bp\.name\b/.test(tagLine)) errs.push('tag wrapper line also contains the name');
    const wrapCls = m[1].split(/\s+/);
    // the name element must be a div as well, not an inline span
    const nameLine = lines[nameIdx];
    if (!/h\('div',\s*\{\s*class:\s*'title/.test(nameLine)) errs.push('name element is not a block-level div');
    // ---- CSS: the wrapper is display:block and neither it nor its parent card forms a flex/grid row of name + tag
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((r) => ({ sel: r[1].trim(), body: r[2] }));
    for (const c of wrapCls) {
      const own = rules.filter((r) => r.sel.split(',').some((s) => s.trim() === '.' + c));
      if (!own.some((r) => /display:\s*block/.test(r.body))) errs.push('.' + c + ' has no display:block rule');
    }
    const nameCls = (lines[nameIdx].match(/class:\s*'([^']*)'/) || [, ''])[1].split(/\s+/);
    for (const r of rules) {
      if (!/display:\s*(inline-)?(flex|grid)/.test(r.body)) continue;
      const sels = r.sel.split(',').map((s) => s.trim());
      for (const s of sels) {
        const hitsTag = wrapCls.some((c) => new RegExp('\\.' + c + '(?![\\w-])').test(s)) && !/\.[\w-]+\s+\.[\w-]+/.test(s.replace(/\.place-tag/, ''));
        const hitsName = nameCls.filter((c) => c !== 'title').some((c) => new RegExp('\\.' + c + '(?![\\w-])').test(s));
        if (hitsTag || hitsName) errs.push('CSS rule "' + s + '" makes the name/tag wrapper a flex/grid container');
      }
    }
    // the card element itself must not be flex/grid (that would put name and tag in one row)
    const cardLine = lines.slice(Math.max(0, tagIdx - 4), tagIdx).find((l) => /h\('div',\s*\{\s*class:\s*'card'/.test(l));
    if (!cardLine) errs.push('place-card container (class card) not found above the name');
    else if (rules.some((r) => r.sel.split(',').some((s) => s.trim() === '.card') && /display:\s*(inline-)?(flex|grid)/.test(r.body))) errs.push('.card is a flex/grid container');
  }
}

if (errs.length) { console.error('check-places-layout FAILED:\n - ' + errs.join('\n - ')); process.exit(1); }
console.log('check-places-layout OK: tag is its own block after the name; no flex/grid row shares them');
