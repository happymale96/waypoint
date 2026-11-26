#!/usr/bin/env node
/* Build stamp. Writes a short content hash of the app shell into
 *   sw.js   -> const BUILD = '<stamp>';        (the cache name is "waypoint-<stamp>", so every release gets a fresh cache)
 *   app.js  -> const BUILD_STAMP = '<stamp>';  (shown in Settings so you can see which version you are on)
 * The hash covers every shell file (html/css/js/json/icons); the two stamp lines themselves are excluded, so the
 * result is stable: running it twice without changes gives the same stamp and no diff.
 *
 *   node tools/stamp-sw.js          stamp now (run this before every commit)
 *   node tools/stamp-sw.js --check  exit 1 if the stamp in sw.js / app.js is stale (CI or a pre-commit hook)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SHELL = ['index.html', 'styles.css', 'app.js', 'solver.js', 'reached.js', 'lunchbreak.js', 'budget.js', 'traveltimes.js', 'providers.js', 'storage.js', 'messages.js', 'daylog.js', 'geo.js', 'fuel.js', 'onboard.js', 'jobedit.js', 'wakelock.js', 'proof.js',
  'manifest.json', 'icon-192.png', 'icon-512.png', 'maskable-192.png', 'icon-512-maskable.png', 'apple-touch-icon-180.png', 'favicon-48.png', 'favicon-32.png', 'favicon.svg',
  'symbol-on-light.svg', 'symbol-on-dark.svg', 'symbol-header-onlight.svg', 'logo-horizontal-on-dark.svg', 'whatsapp-glyph.svg', 'sw.js'];
const SW_RE = /const BUILD = '[^']*';/;
const APP_RE = /const BUILD_STAMP = '[^']*';/;
const TEXT = /\.(html|css|js|json)$/;

const file = (f) => path.join(ROOT, f);

function normalised(f) {
  const raw = fs.readFileSync(file(f));
  if (!TEXT.test(f)) return raw;
  let s = raw.toString('utf8').replace(/\r\n/g, '\n');
  if (f === 'sw.js') s = s.replace(SW_RE, "const BUILD = '';");
  if (f === 'app.js') s = s.replace(APP_RE, "const BUILD_STAMP = '';");
  return Buffer.from(s, 'utf8');
}

function computeStamp() {
  const h = crypto.createHash('sha256');
  SHELL.forEach((f) => { h.update(f + '\0'); h.update(normalised(f)); h.update('\0'); });
  return h.digest('hex').slice(0, 8);
}

function current(f, re) {
  const m = fs.readFileSync(file(f), 'utf8').match(re);
  return m ? m[0].match(/'([^']*)'/)[1] : null;
}

const stamp = computeStamp();
const inSw = current('sw.js', SW_RE), inApp = current('app.js', APP_RE);

if (process.argv.includes('--check')) {
  if (inSw === stamp && inApp === stamp) { console.log('stamp ok: ' + stamp); process.exit(0); }
  console.error('stamp STALE: sw.js=' + inSw + ' app.js=' + inApp + ' expected=' + stamp + ' — run: node tools/stamp-sw.js');
  process.exit(1);
}

function write(f, re, line, had) {
  if (had == null) { console.error('No stamp line found in ' + f + ' (expected: ' + line.replace(stamp, 'xxxx') + ')'); process.exit(2); }
  if (had === stamp) return false;
  const s = fs.readFileSync(file(f), 'utf8').replace(re, line);
  fs.writeFileSync(file(f), s);
  return true;
}
const a = write('sw.js', SW_RE, "const BUILD = '" + stamp + "';", inSw);
const b = write('app.js', APP_RE, "const BUILD_STAMP = '" + stamp + "';", inApp);
console.log('build stamp ' + stamp + (a || b ? ' (written to ' + [a && 'sw.js', b && 'app.js'].filter(Boolean).join(' + ') + ')' : ' (unchanged)'));
