'use strict';
// Part B: auto-Reached only within the Auto-Reached distance (default 80 m) AND when stopped (Reached.autoReachStep), on a fake clock.
// Run as its own node script: node test/stopped.test.js
const Reached = require('../reached.js');

let failures = 0, passes = 0;
function eq(actual, expected, name) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + ' -> got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); }
}
const T0 = Date.UTC(2026, 10, 25, 3, 0); // fake clock: 25 Nov 2026 11:00 MYT
let now = T0;
Date.now = () => now; // pinned
const M = 1 / 111320; // ~1 m of latitude
const A = { id: 'A', lat: 3.10, lng: 101.60, actions: [{ jobId: 'J', kind: 'errand' }] };
const jobs = { J: { id: 'J', errandPlaceId: 'A', pickups: [] } };
const stops = [A, { id: '__end__', lat: 3.30, lng: 101.90, isEnd: true }];
// a fresh fix d metres north of A, at time t (s after T0), speed in m/s or null
const fix = (d, t, speed) => ({ lat: A.lat + d * M, lng: A.lng, accuracy: 10, at: T0 + t * 1000, speed });
// feed fixes in order (the clock follows each fix); -> the id fired at each fix (null = did not fire)
function run(fixes, radiusM) {
  let track = null;
  return fixes.map((f) => {
    now = f.at;
    const r = Reached.autoReachStep(track, f, stops, { enabled: true, visible: true, now, jobs, radiusM });
    track = r.track;
    return r.id;
  });
}

console.log('auto-Reached distance: default and range');
eq(Reached.RADIUS_M, 80, 'default 80 m');
eq([Reached.radiusOf(80), Reached.radiusOf(30), Reached.radiusOf(300), Reached.radiusOf(29), Reached.radiusOf(301), Reached.radiusOf('abc'), Reached.radiusOf(undefined)], [80, 30, 300, 80, 80, 80, 80], 'whole number 30..300, else 80');

console.log('R1-R6 (setting 80 m unless said)');
eq(run([fix(100, 0, 0)], 80), [null], 'R1. one fresh fix 100 m away, speed 0: does not fire');
eq(run([fix(70, 0, 12)], 80), [null], 'R2. one fresh fix 70 m away, speed 12 m/s: does not fire');
eq(run([fix(70, 0, 1)], 80), ['A'], 'R3. one fresh fix 70 m away, speed 1 m/s: fires');
eq(run([fix(70, 0, null), fix(60, 25, null)], 80), [null, 'A'], 'R4. 70 m (no speed) at 0 s, 60 m (no speed) at 25 s: fires at the second fix, not the first');
eq(run([fix(70, 0, null), fix(120, 10, null), fix(60, 25, null)], 80), [null, null, null], 'R5. 70 m at 0 s, 120 m at 10 s, 60 m at 25 s: does not fire at 25 s');
eq(run([fix(100, 0, 0)], 150), ['A'], 'R6. setting 150: one fresh fix 100 m away, speed 0: fires');

console.log('the edges of the stopped rule');
eq(run([fix(70, 0, 2)], 80), ['A'], 'exactly 2 m/s counts as stopped');
eq(run([fix(70, 0, null), fix(60, 19, null)], 80), [null, null], 'no speed, inside for 19 s: not yet');
eq(run([fix(70, 0, null), fix(60, 20, null)], 80), [null, 'A'], 'no speed, inside for 20 s: fires');
eq(run([fix(70, 0, null), fix(65, 10, 5), fix(60, 25, null)], 80), [null, null, null], 'a fix inside at more than 2 m/s resets the 20 s');
eq(run([fix(70, 0, null), Object.assign(fix(500, 10, null), { accuracy: 300 }), fix(60, 25, null)], 80), [null, null, 'A'], 'a poor fix in between changes nothing');
{
  now = T0 + 6 * 60000; // a stale fix (6 min old) never fires, whatever its speed
  eq(Reached.autoReachStep(null, fix(10, 0, 0), stops, { enabled: true, visible: true, now, jobs, radiusM: 80 }).id, null, 'fix freshness rule kept');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
