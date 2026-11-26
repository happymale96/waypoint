#!/usr/bin/env node
/* Full verify: every unit test file (test/*.test.js), the check tools and every mocked browser smoke (tools/smoke-*.js),
 * one after another, with TZ=Asia/Kuala_Lumpur. One exit code: 0 only when every script exits 0.
 *   node tools/verify-all.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort().map((f) => 'test/' + f);
const checks = ['check-icons.js', 'check-route-buttons.js', 'check-header-contrast.js', 'check-places-card.js', 'check-places-layout.js'].map((f) => 'tools/' + f);
const smokes = fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => /^smoke-.*\.js$/.test(f)).sort().map((f) => 'tools/' + f);
const all = tests.concat(checks, smokes);

const env = Object.assign({}, process.env, { TZ: 'Asia/Kuala_Lumpur' });
const failed = [];
all.forEach((f) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [f], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.trim().split('\n').slice(-1)[0] || '';
  const okRun = r.status === 0;
  console.log((okRun ? 'PASS ' : 'FAIL ') + f + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)  ' + tail.trim());
  if (!okRun) {
    failed.push(f);
    out.split('\n').filter((l) => /FAIL|ERROR|Error/.test(l)).slice(0, 20).forEach((l) => console.log('     ' + l));
  }
});
console.log('\n' + (all.length - failed.length) + ' of ' + all.length + ' scripts passed' + (failed.length ? '; failed: ' + failed.join(', ') : ''));
process.exit(failed.length ? 1 : 0);
