'use strict';
// Live-location ETAs: Solver.retime origin override + the pure refresh rules (throttle, 300 m, 150 m, accuracy).
const Solver = require('../solver.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

// world: x,y plain coordinates, 1 unit = 60 s; start (0,0), stops A(1,0) B(2,0) C(3,0), end (0,0); 5 min dwell
const DEP = new Date(2030, 0, 15, 9, 0, 0);
const NOW = new Date(2030, 0, 15, 9, 0, 0).toISOString();
const place = (id, x, y, extra) => Object.assign({ id, name: id, lat: x, lng: y, type: 'other', dwellMin: 5, closedWindows: [] }, extra || {});
const errand = (id, pid, extra) => Object.assign({ id, pickups: [], deliveryPlaceId: null, errandPlaceId: pid, dwellMin: 5, notes: id, urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: 0 }, extra || {});
function world(placeExtra, jobExtra) {
  const places = { A: place('A', 1, 0, placeExtra && placeExtra.A), B: place('B', 2, 0), C: place('C', 3, 0) };
  const jobs = [errand('jA', 'A', jobExtra && jobExtra.jA), errand('jB', 'B'), errand('jC', 'C')];
  const input = { start: { lat: 0, lng: 0 }, end: { lat: 0, lng: 0 }, jobs, places, departAtISO: DEP.toISOString(), noDetour: false };
  const pts = Solver.pointsFor(Object.assign({}, input, { matrices: [] }));
  input.matrices = [0, 2, 4].map((h) => ({ departAt: new Date(DEP.getTime() + h * 3600e3).toISOString(),
    m: pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 60)))) }));
  const res = Solver.solve(input);
  return { plan: res.plans[0], res };
}

console.log('retime: origin override');
{
  const { plan } = world();
  ok(plan.order.join('') === 'ABC', 'fixture plans A, B, C', plan.order);
  const base = Solver.retime(plan, -1, NOW);
  const now = Date.parse(NOW);
  ok(base.stops[0].arriveAt === now + 60000, 'no override: first ETA = matrix leg from the plan start (now + 60 s)');
  const o = Solver.retime(plan, -1, NOW, { durationToNextSec: 1500 });
  ok(o.stops[0].arriveAt === now + 1500000, 'override: first ETA = now + durationToNextSec');
  const delta = o.stops[0].arriveAt - base.stops[0].arriveAt;
  ok(o.stops.every((s, i) => s.arriveAt - base.stops[i].arriveAt === delta && s.departAt - base.stops[i].departAt === delta), 'override shifts EVERY later ETA by the same amount (existing legs + dwell kept)');
  ok(o.endArrival - base.endArrival === delta && o.totalSec - base.totalSec === Math.round(delta / 1000), 'end arrival and total follow');
  ok(o.order.join('') === base.order.join('') && o.stops.map((s) => s.placeId).join('') === 'ABC', 'stop order is unchanged');
  const same = (x) => JSON.stringify(x) === JSON.stringify(base);
  ok(same(Solver.retime(plan, -1, NOW, undefined)) && same(Solver.retime(plan, -1, NOW, {})) && same(Solver.retime(plan, -1, NOW, { durationToNextSec: null })), 'no override (undefined / {} / null) leaves results identical');
  const arrived = Solver.retime(plan, -1, NOW, { durationToNextSec: 0 });
  ok(arrived.stops[0].arriveAt === now && arrived.stops[0].departAt === now + 5 * 60000, 'arrived (0 s): arrival = now, departure = now + dwell');
  ok(arrived.stops[1].arriveAt === now + 5 * 60000 + 60000, 'arrived: the next stop is one leg after the dwell');
  const sk = Object.assign({}, plan, { stops: plan.stops.map((s, i) => (i === 0 ? Object.assign({}, s, { status: 'skipped' }) : s)) });
  const so = Solver.retime(sk, 0, NOW, { durationToNextSec: 900 });
  ok(so.stops[0].status === 'skipped' && so.stops[1].arriveAt === now + 900000, 'override applies to the first NOT-DONE stop (a skipped stop is passed over)');
  ok(Solver.retime(plan, -1, NOW, { durationToNextSec: -50 }).stops[0].arriveAt === now, 'negative duration is clamped to 0');
}

console.log('retime: lateness and CLOSED follow the new times');
{
  const { plan } = world(null, { jA: { arriveBefore: '09:20' } });
  const base = Solver.retime(plan, -1, NOW);
  ok(base.violations.length === 0 && base.stops[0].late === false, 'on-time ETA: no violation, stop not late');
  const late = Solver.retime(plan, -1, NOW, { durationToNextSec: 25 * 60 });
  ok(late.stops[0].late === true && late.violations.length === 1 && /Arrive-before missed at A/.test(late.violations[0]) && late.lateSec === 300, 'ETA past the arrive-before window: LATE flag + violation + lateSec', late.violations);
  const back = Solver.retime(plan, -1, NOW, { durationToNextSec: 10 * 60 });
  ok(back.stops[0].late === false && back.violations.length === 0, 'a better ETA clears the lateness again');
}
{
  const { plan } = world({ A: { closedWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '09:30', to: '10:30' }] } });
  const base = Solver.retime(plan, -1, NOW);
  ok(base.stops[0].closedWarning === false, 'CLOSED: 09:01 arrival is outside the 09:30-10:30 window');
  ok(Solver.retime(plan, -1, NOW, { durationToNextSec: 35 * 60 }).stops[0].closedWarning === true, 'CLOSED badge flips on when the new ETA lands in the closed window');
  ok(Solver.retime(plan, -1, NOW, { durationToNextSec: 90 * 60 }).stops[0].closedWarning === false, 'and off again once the ETA is past the window');
}

console.log('rules: throttle, movement, arrival, accuracy');
{
  const n = 1000000;
  ok(Solver.refreshDue(n, null) === true && Solver.refreshDue(n, n - 119999) === false && Solver.refreshDue(n, n - 120000) === true, 'throttle: at most one refresh per 2 minutes');
  const lat = 3.1, dLat = (m) => m / 111195; // metres -> degrees of latitude
  const next = { lat, lng: 101.6 }, good = (m, acc) => ({ lat: lat + dLat(m), lng: 101.6, accuracy: acc == null ? 20 : acc });
  ok(Math.abs(Solver.distanceM({ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 }) - 111.2) < 0.5, 'distanceM: 0.001 deg latitude is about 111 m');
  ok(Solver.judgeFix(good(5000), null, next) === 'route', 'a fix 5 km away needs a routing request');
  ok(Solver.judgeFix(good(140), null, next) === 'arrived' && Solver.judgeFix(good(0), null, next) === 'arrived', 'within 150 m of the next stop = arrived (no routing request)');
  ok(Solver.judgeFix(good(160), null, next) === 'route', 'just outside 150 m is not arrived');
  const last = { lat: lat + dLat(5000), lng: 101.6 };
  ok(Solver.judgeFix(good(5000 + 200), last, next) === 'unmoved', 'moved under 300 m since the last refresh: skipped');
  ok(Solver.judgeFix(good(5000 + 400), last, next) === 'route', 'moved 300 m or more: refreshed');
  ok(Solver.judgeFix(good(5000, 250), null, next) === 'ignore' && Solver.judgeFix(good(5000, 200.5), null, next) === 'ignore', 'accuracy worse than 200 m: fix ignored');
  ok(Solver.judgeFix(good(5000, 200), null, next) === 'route', 'accuracy of exactly 200 m is accepted');
  ok(Solver.judgeFix(null, null, next) === 'ignore' && Solver.judgeFix({ lat, lng: 101.6 }, null, next) === 'ignore', 'no fix / no accuracy: ignored (current behaviour kept)');
  ok(Solver.judgeFix(good(100), last, next) === 'arrived', 'arrival wins over the movement rule');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
