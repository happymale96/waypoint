#!/usr/bin/env node
/* Generates icon-192.png and icon-512.png (maskable: logo centred with ~15% padding on white).
 *   node tools/make-icons.js            -> downloads the L-Tech logo (or uses ./logo.png if present)
 *   node tools/make-icons.js logo.png   -> uses that file
 * If no logo can be obtained, a plain "W" icon is generated and a note is printed.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const LOGO_URL = 'https://cdn1.npcdn.net/images/1fb05166c9f8ef42e9358761f98b0ca6.png';
const NAVY = '#00243c';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(download(res.headers.location, dest));
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); fs.writeFileSync(dest, b); resolve(b); });
    }).on('error', reject);
  });
}

async function logoIcon(buf, size, out) {
  const inner = Math.round(size * 0.70); // 15% padding each side
  const logo = await sharp(buf).resize({ width: inner, height: inner, fit: 'inside' }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
    .composite([{ input: logo, gravity: 'centre' }]).png().toFile(out);
}
async function wIcon(size, out) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '"><rect width="100%" height="100%" fill="#fff"/>' +
    '<text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="' + Math.round(size * 0.55) + '" fill="' + NAVY + '">W</text></svg>';
  await sharp(Buffer.from(svg)).png().toFile(out);
}

(async () => {
  const arg = process.argv[2];
  const logoPath = arg ? path.resolve(process.cwd(), arg) : path.join(ROOT, 'logo.png');
  let buf = null;
  if (fs.existsSync(logoPath)) buf = fs.readFileSync(logoPath);
  else {
    try { buf = await download(LOGO_URL, logoPath); } catch (e) { console.log('Logo download failed: ' + e.message); }
  }
  let usedLogo = false;
  for (const size of [192, 512]) {
    const out = path.join(ROOT, 'icon-' + size + '.png');
    if (buf) {
      try { await logoIcon(buf, size, out); usedLogo = true; continue; } catch (e) { console.log('Logo unreadable: ' + e.message); buf = null; }
    }
    await wIcon(size, out);
  }
  console.log(usedLogo ? 'Icons written from the L-Tech logo.' : 'Plain "W" icons written (no logo available).');
  if (!usedLogo) console.log('NOTE: Calvin, please drop logo.png into the waypoint folder and run `node tools/make-icons.js logo.png`.');
})();
