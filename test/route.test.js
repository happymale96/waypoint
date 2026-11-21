'use strict';
// Route tab (Part A): header follows the re-timed plan, status line, throttle bypass, stale origin, past-ETA roll-forward,
// skipped stops, end-point arrival in the day log summary.
const Solver = require('../solver.js');
const DL = require('../daylog.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

// world: x,y plain coordinates, 1 unit = 60 s; start (0,0), stops A(1,0) B(2,0) C(3,0), end (0,0); 5 min dwell
const DEP = new Date(2030, 0, 15, 9, 0, 0);
const MIN = 60000;
const at = (h, m) => new Date(2030, 0, 15, h, m, 0).getTime();
const NOW = DEP.toISOString();
const place = (id, x, y) => ({ id, name: id, lat: x, lng: y, type: 'other', dwellMin: 5, closedWindows: [] });
const errand = (id, pid) => ({ id, pickups: [], deliveryPlaceId: null, errandPlaceId: pid, dwellMin: 5, notes: id, urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: 0 });
function world() {
  const places = { A: place('A', 1, 0), B: place('B', 2, 0), C: place('C', 3, 0) };
  const input = { start: { lat: 0, lng: 0 }, end: { lat: 0, lng: 0 }, jobs: [errand('jA', 'A'), errand('jB', 'B'), errand('jC', 'C')], places, departAtISO: DEP.toISOString(), noDetour: false };
  const pts = Solver.pointsFor(Object.assign({}, input, { matrices: [] }));
  input.matrices = [0, 2, 4].map((h) => ({ departAt: new Date(DEP.getTime() + h * 3600e3).toISOString(),
    m: pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 60)))) }));
  return Solver.solve(input).plans[0];
}
const mark = (plan, i, status, doneAtMs) => Object.assign({}, plan, { stops: plan.stops.map((s, k) => (k === i ? Object.assign({}, s, { status }, doneAtMs ? { doneAt: new Date(doneAtMs).toISOString() } : {}) : s)) });
const plan = world();

console.log('A1 header follows the re-timed plan');
{
  ok(plan.order.join('') === 'ABC' && plan.endArrival === at(9, 21), 'fixture: A, B, C, home at 09:21', [plan.order, new Date(plan.endArrival).toTimeString()]);
  const base = Solver.retime(plan, -1, NOW), live = Solver.retime(plan, -1, NOW, { durationToNextSec: 1500 });
  const vb = Solver.liveView(base, at(9, 0)), vl = Solver.liveView(live, at(9, 0));
  ok(vl.endArrival - vb.endArrival === 1500000 - 60000, 'the end arrival moves with the re-time (live fix 25 min away: +24 min)', vl.endArrival - vb.endArrival);
  ok(vl.leftSec - vb.leftSec === 1440, 'minutes left follows too', [vb.leftSec, vl.leftSec]);
  ok(vb.left === 3 && vl.left === 3, 'stops left = 3 before anything is done');
  // never from the original snapshot: a re-time after A is done at 09:40 moves the header, the first plan object does not
  const doneA = Solver.retime(mark(plan, 0, 'done', at(9, 40)), 0, new Date(at(9, 40)).toISOString());
  const vd = Solver.liveView(doneA, at(9, 40));
  ok(vd.endArrival === at(9, 55) && vd.endArrival > plan.endArrival, 'after DONE at 09:40 the end arrival is the re-timed 09:55 (B 09:41-09:46, C 09:47-09:52, +3 min home), not the first plan 09:21', new Date(vd.endArrival).toTimeString());
}

console.log('A1 invariant: end >= every remaining stop ETA and >= now');
{
  const p = Solver.retime(plan, -1, NOW);
  let bad = [];
  [at(8, 50), at(9, 0), at(9, 3), at(9, 9), at(9, 14), at(9, 22), at(11, 0)].forEach((now) => {
    const v = Solver.liveView(p, now);
    const rem = v.stops.filter((s) => !s.status);
    if (!(v.endArrival >= now)) bad.push(['end<now', now]);
    rem.forEach((s) => { if (!(v.endArrival >= s.arriveAt) || !(v.endArrival >= s.departAt) || !(s.arriveAt >= now)) bad.push(['stop', s.placeId, now]); });
  });
  ok(bad.length === 0, 'holds for now before / during / hours after the plan', bad);
  const sk = mark(mark(mark(plan, 0, 'done', at(9, 5)), 1, 'skipped'), 2, 'done', at(9, 15));
  const v = Solver.liveView(Solver.retime(sk, 2, new Date(at(9, 15)).toISOString()), at(11, 0));
  ok(v.left === 0 && v.endArrival === at(11, 0) && v.leftSec === 0, 'nothing left, hours later: the end arrival is never in the past (= now)', v);
}

console.log('A1 stops left excludes done and skipped');
{
  const p = mark(mark(plan, 0, 'done', at(9, 5)), 1, 'skipped');
  ok(Solver.liveView(p, at(9, 10)).left === 1, 'A done + B skipped -> 1 stop left');
  ok(Solver.liveView(mark(plan, 1, 'skipped'), at(9, 0)).left === 2, 'one skipped -> 2 left');
}

console.log('A2 status line: the three anchors');
{
  ok(Solver.timesLine({ liveAt: at(16, 52), lastDoneAt: at(16, 40), reason: null }) === 'Times from your location, 16:52', 'live fix used');
  ok(Solver.timesLine({ liveAt: at(16, 52), lastDoneAt: at(16, 40), reason: 'routing' }) === 'Times from your location, 16:52', 'live fix used: no reason appended even if a later attempt failed');
  ok(Solver.timesLine({ liveAt: null, lastDoneAt: at(16, 40), reason: null }) === 'Times from last DONE, 16:40', 'no live fix, something done -> last DONE');
  ok(Solver.timesLine({ liveAt: null, lastDoneAt: null, reason: null }) === 'Times from plan start', 'nothing done, no fix -> plan start');
}
console.log('A2 status line: the four reasons');
{
  const L = (reason) => Solver.timesLine({ liveAt: null, lastDoneAt: at(16, 40), reason });
  ok(L('denied') === 'Times from last DONE, 16:40 - location not allowed', 'reason: location not allowed');
  ok(L('nofix') === 'Times from last DONE, 16:40 - no GPS fix', 'reason: no GPS fix');
  ok(L('routing') === 'Times from last DONE, 16:40 - routing failed', 'reason: routing failed');
  ok(L('offline') === 'Times from last DONE, 16:40 - offline', 'reason: offline');
  ok(Solver.timesLine({ liveAt: null, lastDoneAt: null, reason: 'offline' }) === 'Times from plan start - offline', 'reason also applies to "plan start"');
}

console.log('A2/A3 tap-to-retry and stale origin');
{
  const n = 1000000, lat = 3.1, dLat = (m) => m / 111195, next = { lat, lng: 101.6 };
  ok(Solver.refreshDue(n, n - 1000) === false && Solver.refreshDue(n, n - 1000, true) === true, 'force (tap on the status line) bypasses the 2-minute throttle');
  const last = { lat: lat + dLat(5000), lng: 101.6 }, fix = { lat: lat + dLat(5100), lng: 101.6, accuracy: 20 };
  ok(Solver.judgeFix(fix, last, next) === 'unmoved' && Solver.judgeFix(fix, last, next, { force: true }) === 'route', 'force also bypasses the 300 m movement rule');
  ok(Solver.judgeFix({ lat: lat + dLat(5100), lng: 101.6, accuracy: 300 }, last, next, { force: true }) === 'ignore', 'force never accepts a poor fix (accuracy > 200 m)');
  const o = { usedAt: n };
  ok(Solver.originFresh(o, n + 5 * MIN) === true && Solver.originFresh(o, n + 5 * MIN + 1) === false && Solver.originFresh(null, n) === false, 'a live origin older than 5 minutes is dropped');
}

console.log('A4 no time in the past');
{
  const p = Solver.retime(plan, -1, NOW);
  const v = Solver.liveView(p, at(9, 30));
  ok(v.stops[0].arriveAt === at(9, 30), 'the next stop\'s past ETA is set to now');
  const d = at(9, 30) - p.stops[0].arriveAt;
  ok(v.stops.every((s, i) => s.arriveAt === p.stops[i].arriveAt + d && s.departAt === p.stops[i].departAt + d), 'every later stop shifts by the same amount');
  ok(v.endArrival === p.endArrival + d && v.shiftMs === d, 'and so does the end arrival');
  const before = Solver.liveView(p, at(8, 59));
  ok(before.shiftMs === 0 && before.stops[0].arriveAt === p.stops[0].arriveAt, 'ETAs still in the future are left alone');
  ok(p.stops[0].arriveAt === at(9, 1), 'the stored plan itself is not mutated');
}

console.log('A5 skipped stops');
{
  const p = Solver.retime(mark(mark(plan, 0, 'done', at(9, 10)), 1, 'skipped'), 0, new Date(at(9, 10)).toISOString());
  ok(p.stops[2].arriveAt === at(9, 10) + 2 * MIN, 'skipped B is excluded from the chain: C = A + the A->C leg (2 min), not via B', new Date(p.stops[2].arriveAt).toTimeString());
  ok(p.endArrival === at(9, 12) + 5 * MIN + 3 * MIN, 'the end arrival follows the chain without B');
  ok(Solver.liveView(p, at(9, 10)).left === 1, 'and the header counts 1 stop left');
  const back = Solver.retime(mark(plan, 0, 'done', at(9, 10)), 0, new Date(at(9, 10)).toISOString());
  ok(back.stops[1].arriveAt === at(9, 11) && back.stops[2].arriveAt === at(9, 17), 'undo skip (status removed) puts B back in the chain and re-times: B 09:11, C 09:17', back.stops.map((s) => new Date(s.arriveAt).toTimeString().slice(0, 5)));
  ok(Solver.liveView(back, at(9, 10)).left === 2, 'undo skip: header count is back to 2');
}
console.log('A5 out-of-order DONE');
{
  const c = mark(plan, 2, 'done', at(9, 5));
  const p = Solver.retime(c, 2, new Date(at(9, 5)).toISOString());
  ok(p.stops.filter((s) => s.status === 'skipped').length === 0 && p.stops[0].status === undefined && p.stops[1].status === undefined, 'C done first: A and B are NOT marked skipped', p.stops.map((s) => s.status));
  ok(p.stops[0].arriveAt === at(9, 5) + 2 * MIN && p.stops[1].arriveAt > p.stops[0].arriveAt, 'they stay in the chain, re-timed from C');
}

console.log('A3/A6 end point re-timed when nothing is left');
{
  const all = mark(mark(mark(plan, 0, 'done', at(9, 5)), 1, 'skipped'), 2, 'done', at(9, 15));
  const base = Solver.retime(all, 2, new Date(at(9, 20)).toISOString());
  ok(base.endArrival === at(9, 20) + 3 * MIN, 'no live fix: end = now + the leg from the last done stop');
  const live = Solver.retime(all, 2, new Date(at(9, 20)).toISOString(), { durationToNextSec: 900 });
  ok(live.endArrival === at(9, 20) + 15 * MIN, 'live fix: the routing call targets the end point, so its arrival follows the phone');
}

// ---------- day log: ARRIVED at the end point ----------
const T = (h, m) => new Date(Date.UTC(2026, 10, 20, h - 8, m || 0)).toISOString();
const START = { lat: 3.0, lng: 101.0 }, END = { lat: 3.06, lng: 101.06 };
const places = { A: { id: 'A', name: 'Acme', lat: 3.01, lng: 101.01 }, B: { id: 'B', name: 'Beta', lat: 3.02, lng: 101.02 }, C: { id: 'C', name: 'Cee', lat: 3.03, lng: 101.03 } };
const jobs = [{ id: 'j1', pickups: [], deliveryPlaceId: null, errandPlaceId: 'A', dwellMin: 5, notes: 'one', status: 'pending' }, { id: 'j2', pickups: [], deliveryPlaceId: null, errandPlaceId: 'B', dwellMin: 5, notes: 'two', status: 'pending' }, { id: 'j3', pickups: [], deliveryPlaceId: null, errandPlaceId: 'C', dwellMin: 5, notes: 'three', status: 'pending' }];
function mkDay() {
  const day = DL.newDay({ date: '2026-11-20' });
  DL.recordPlan(day, { nowIso: T(9, 0), start: START, departAtIso: T(9, 0), jobs, places, stopOrder: ['A', 'B', 'C'], plannedKm: 20, plannedDriveMin: 40 });
  DL.recordDone(day, { nowIso: T(9, 20), stopId: 'A', actions: [{ jobId: 'j1', kind: 'errand', item: 'one' }], places });
  DL.recordDone(day, { nowIso: T(9, 50), stopId: 'B', actions: [{ jobId: 'j2', kind: 'errand', item: 'two' }], places }); // C stays undone / skipped
  const leg = (a, b, m, s) => { day.legs[DL.legKey(a, b)] = { m, s }; };
  leg(START, places.A, 4000, 600); leg(places.A, places.B, 6000, 900); // start -> A -> B = 10 km, 25 min
  return day;
}
console.log('A6 ARRIVED at the end point (day log)');
{
  const day = mkDay();
  let s = DL.summarise(day, jobs, places);
  ok(s.finishedAt === Date.parse(T(9, 50)) && s.arrivedEndAt == null, 'without arrived_end: Finished = last DONE (unchanged)');
  ok(Math.abs(s.km.value - 10) < 1e-9 && Math.abs(s.driveMin - 25) < 1e-9, 'without arrived_end: km and drive time have no final leg', [s.km, s.driveMin]);
  DL.recordArrivedEnd(day, { nowIso: T(10, 20), endPoint: { lat: END.lat, lng: END.lng, name: 'Home' } });
  day.legs[DL.legKey(places.B, END)] = { m: 7000, s: 1200 };
  s = DL.summarise(day, jobs, places);
  ok(s.finishedAt === Date.parse(T(10, 20)) && s.arrivedEndAt === Date.parse(T(10, 20)), 'arrived_end sets Finished to that time', new Date(s.finishedAt).toISOString());
  ok(Math.abs(s.km.value - 17) < 1e-9 && Math.abs(s.driveMin - 45) < 1e-9, 'final leg (last done stop -> end point) added to km (17) and drive time (45 min)', [s.km, s.driveMin]);
  ok(Math.abs(s.hoursOutMin - 80) < 1e-9 && s.stopsVisited === 2, 'hours out runs to the arrival; stops visited unchanged (2)', [s.hoursOutMin, s.stopsVisited]);
  ok(day.closed === false && !day.events.some((e) => e.type === 'endday') && s.closed === false, 'ARRIVED does not close the day');
  day.edits.finishedAt = T(11, 0);
  ok(DL.summarise(day, jobs, places).finishedAt === Date.parse(T(11, 0)), 'an edited Finished beats arrived_end');
  delete day.edits.finishedAt;
  DL.recordUndoArrivedEnd(day, { nowIso: T(10, 21) });
  s = DL.summarise(day, jobs, places);
  ok(s.finishedAt === Date.parse(T(9, 50)) && s.arrivedEndAt == null, 'undo of ARRIVED restores Finished = last DONE');
  ok(Math.abs(s.km.value - 10) < 1e-9 && Math.abs(s.driveMin - 25) < 1e-9, 'undo of ARRIVED removes the final leg from km and drive time', [s.km, s.driveMin]);
  ok(DL.arrivedEnd(day) === null, 'no active arrived_end after the undo');
  DL.recordArrivedEnd(day, { nowIso: T(10, 30), endPoint: { lat: END.lat, lng: END.lng } });
  ok(DL.arrivedEnd(day) && DL.summarise(day, jobs, places).finishedAt === Date.parse(T(10, 30)), 'ARRIVED can be tapped again after an undo');
  const noLeg = mkDay();
  DL.recordArrivedEnd(noLeg, { nowIso: T(10, 20), endPoint: { lat: END.lat, lng: END.lng } });
  const s2 = DL.summarise(noLeg, jobs, places);
  ok(s2.km.status === 'unavailable' && s2.route.needs && s2.route.points.length === 4, 'final leg not held: the summary asks for ONE routing request over start -> A -> B -> end', s2.route);
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
