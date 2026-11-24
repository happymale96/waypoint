'use strict';
// 23. Auto-reach only where something can be done (Reached.canAutoReach inside Reached.autoReachTarget).
// Run as its own node script: node test/autoreach.test.js
const Reached = require('../reached.js');

let failures = 0, passes = 0;
function eq(actual, expected, name) {
  if (actual === expected) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + ' -> got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); }
}
const NOW = Date.UTC(2026, 10, 24, 3, 0);
const M = 1 / 111320; // ~1 m of latitude
const LL = { A: [3.10, 101.60], B: [3.12, 101.62], C: [3.14, 101.64], D: [3.16, 101.66], E: [3.20, 101.70], F: [3.18, 101.68] };
const fixAt = (lat, lng) => ({ lat, lng, accuracy: 10, at: NOW - 1000 });
const near = (id, m) => fixAt(LL[id][0] + m * M, LL[id][1]);
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, status: 'pending' }, o);
function world(o) {
  o = o || {};
  const J1 = job('J1', { pickups: [{ placeId: 'A', item: 'x', done: false }], deliveryPlaceId: 'B' });
  const J2 = job('J2', { pickups: [{ placeId: 'C', item: 'y', done: !!o.cDone }], deliveryPlaceId: 'D' });
  const jobs = { J1, J2 };
  const st = (id, actions, extra) => Object.assign({ id, lat: LL[id][0], lng: LL[id][1], actions }, extra || {});
  const dActions = [{ jobId: 'J2', kind: 'deliver' }];
  if (o.dPickup) { jobs.J3 = job('J3', { pickups: [{ placeId: 'D', item: 'z', done: false }], deliveryPlaceId: 'F' }); dActions.push({ jobId: 'J3', kind: 'pickup' }); }
  if (o.withYou) { jobs.J4 = job('J4', { inHandItem: 'loose part', deliveryPlaceId: 'D' }); dActions.push({ jobId: 'J4', kind: 'deliver' }); }
  const stops = [
    st('A', [{ jobId: 'J1', kind: 'pickup' }]), st('B', [{ jobId: 'J1', kind: 'deliver' }]),
    st('C', o.cDone ? [{ jobId: 'J2', kind: 'pickup' }] : [{ jobId: 'J2', kind: 'pickup' }], o.cDone ? { status: 'done' } : o.cSkipped ? { status: 'skipped' } : o.cReached ? { reachedAt: NOW - 60000 } : {}),
    st('D', dActions),
  ];
  if (o.dPickup) stops.push(st('F', [{ jobId: 'J3', kind: 'deliver' }]));
  stops.push({ id: '__end__', lat: LL.E[0], lng: LL.E[1], isEnd: true });
  return { stops, jobs };
}
const target = (fix, w) => Reached.autoReachTarget(fix, w.stops, { enabled: true, visible: true, now: NOW, jobs: w.jobs });

console.log('23. auto-reach candidates');
eq(target(near('D', 100), world()), null, 'a. 100 m from D, C not done -> no target');
eq(target(near('D', 100), world({ cReached: true })), null, 'b. C Reached but not Done -> no target');
eq(target(near('D', 100), world({ cDone: true })), 'D', 'c. C Done -> target D');
{
  const w = world();
  w.stops.find((s) => s.id === 'A').lat = LL.D[0] + 0.0005; w.stops.find((s) => s.id === 'A').lng = LL.D[1]; // A and D 55 m apart
  eq(target(fixAt(LL.D[0] + 0.00025, LL.D[1]), w), 'A', 'd. within 150 m of both A and D, C not done -> target A');
}
eq(target(near('D', 100), world({ cSkipped: true })), null, 'e. C skipped -> no target');
eq(target(near('D', 100), world({ dPickup: true })), 'D', 'f. D is also the pickup of a pending third job -> target D');
eq(target(near('D', 100), world({ withYou: true })), 'D', 'g. a "with you" item to deliver at D -> target D');
{
  const w = world();
  const fuelStop = { id: '__fuel__', lat: 3.30, lng: 101.80, fuel: true, actions: [] };
  w.stops.splice(2, 0, fuelStop);
  eq(target(fixAt(3.30 + 50 * M, 101.80), w), '__fuel__', 'h. the fuel stop: auto-reached as before');
  eq(target(near('E', 50), w), null, 'h. the end point: never auto-reached, as before');
  eq(target(near('A', 60), w), 'A', 'h. a pickup not done: auto-reached as before');
  const noActions = [{ id: 'Z', lat: 3.0, lng: 101.0 }];
  eq(Reached.autoReachTarget(fixAt(3.0, 101.0), noActions, { enabled: true, visible: true, now: NOW }), 'Z', 'h. a stop listed without actions keeps the old behaviour');
}
eq(Reached.canAutoReach({ id: 'X', actions: [{ jobId: 'J9', kind: 'errand' }] }, { J9: job('J9', { errandPlaceId: 'X' }) }), true, 'an errand stop is a candidate');

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
