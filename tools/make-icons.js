#!/usr/bin/env node
/* Generates icon-192.png, icon-512.png and icon-512-maskable.png from the real L-Tech artwork in logo.png
 * (the only logo source in the repo, 614 x 133 px).
 *
 * Layout: the logo symbol centred and large, the "L-TECH" wordmark beneath it, smaller, on white.
 * The registration-number line under the wordmark is cropped away. Nothing is redrawn or re-typeset:
 * the symbol and the wordmark are cropped out of logo.png and only scaled.
 *
 *   cd tools && npm install && cd ..
 *   node tools/make-icons.js [logo.png]
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.join(__dirname, 'node_modules', 'sharp'));

const ROOT = path.resolve(__dirname, '..');
// Regions of logo.png (found by column/row ink analysis; the gaps between them are fully transparent).
const SYMBOL = { left: 0, top: 0, width: 189, height: 106 };       // the two interlocking shapes
const WORDMARK = { left: 222, top: 0, width: 392, height: 106 };   // "L-TECH" (registration line sits below row 111)
const BG = { r: 255, g: 255, b: 255, alpha: 1 };

// layout: symbol width, wordmark width, gap, all as a fraction of the icon size
const NORMAL = { symbol: 0.72, word: 0.50, gap: 0.075 };
const MASKABLE = { symbol: 0.58, word: 0.40, gap: 0.06 }; // everything inside the central safe circle (r = 40%)

async function trimmed(buf, region) {
  const crop = await sharp(buf).extract(region).png().toBuffer();
  return sharp(crop).trim({ threshold: 1 }).png().toBuffer(); // trims transparent margin only
}

async function build(buf, size, lay, out) {
  const sym = await trimmed(buf, SYMBOL);
  const word = await trimmed(buf, WORDMARK);
  const symR = await sharp(sym).resize({ width: Math.round(size * lay.symbol), kernel: 'lanczos3' }).png().toBuffer();
  const wordR = await sharp(word).resize({ width: Math.round(size * lay.word), kernel: 'lanczos3' }).png().toBuffer();
  const sm = await sharp(symR).metadata();
  const wm = await sharp(wordR).metadata();
  const gap = Math.round(size * lay.gap);
  const total = sm.height + gap + wm.height;
  const top = Math.round((size - total) / 2);
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([
      { input: symR, left: Math.round((size - sm.width) / 2), top },
      { input: wordR, left: Math.round((size - wm.width) / 2), top: top + sm.height + gap },
    ]).png().toFile(out);
  return { sym: [sm.width, sm.height], word: [wm.width, wm.height], top, total };
}

(async () => {
  const src = path.resolve(process.argv[2] || path.join(ROOT, 'logo.png'));
  const buf = fs.readFileSync(src);
  // 512 masters are built directly from the source; the 192 is a downscale of the 512 (Lanczos).
  const n512 = await build(buf, 512, NORMAL, path.join(ROOT, 'icon-512.png'));
  const m512 = await build(buf, 512, MASKABLE, path.join(ROOT, 'icon-512-maskable.png'));
  await sharp(path.join(ROOT, 'icon-512.png')).resize(192, 192, { kernel: 'lanczos3' }).png().toFile(path.join(ROOT, 'icon-192.png'));
  console.log('icon-512', n512);
  console.log('icon-512-maskable', m512);
  console.log('icon-192 written. Source:', path.basename(src));
})();
