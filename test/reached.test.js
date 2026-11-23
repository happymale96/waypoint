'use strict';
// "Reached before Done": the pure module reached.js (state, auto-reach, driving vs on-site split, carry-forward), the on-site
// re-time in solver.js and the day-log fields. Run as its own node script: node test/reached.test.js
const Reached = require('../reached.js');
const Solver = require('../solver.js');
const DL = require('../daylog.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, tol, name) => ok(a != null && Math.abs(a - b) <= tol, name, { got: a, want: b });

const MIN = 60000;
const T = new Date(2030, 0, 15, 9, 0, 0).getTime(); // 09:00 local
const at = (h, m, s) => new Date(2030, 0, 15, h, m, s || 0).getTime();
const hm = (ms) => DL.fmtTime(ms);

console.log('state: button, guard, undo, carry-forward');
{
  const s0 = { placeId: 'A', arriveAt: 1, departAt: 2, actions: [] };
  ok(Reached.buttonLabel(s0) === 'REACHED', 'pending, not reached: the button reads REACHED');
  const s1 = Reached.stampReached(s0, at(14, 10), 'tap');
  ok(s1.reachedAt === at(14, 10) && s1.reachedSource === 'tap' && s0.reachedAt === undefined, 'REACHED stamps reachedAt + source "tap" (input untouched)');
  ok(Reached.buttonLabel(s1) === 'DONE', 'reached, not done: the button reads DONE');
  ok(Reached.tapIgnored(s1, at(14, 10) + 100) && Reached.tapIgnored(s1, at(14, 10) + 499), 'taps within 500 ms of Reached are ignored');
  ok(!Reached.tapIgnored(s1, at(14, 10) + 500) && !Reached.tapIgnored(s1, at(14, 10) + 5000), 'from 500 ms on, a tap is DONE');
  ok(!Reached.tapIgnored(s0, T), 'a stop that is not reached has no guard');
  ok(Reached.reachedText(s1, hm) === 'Reached 14:10', 'text: "Reached 14:10"', Reached.reachedText(s1, hm));
  ok(Reached.reachedText(Reached.stampReached(s0, at(14, 10), 'auto'), hm) === 'Reached 14:10 · auto', 'auto adds "· auto"');
  const u = Reached.undoReached(s1);
  ok(u.reachedAt === null && u.reachedSource === null && u.noAutoReach === true && Reached.buttonLabel(u) === 'REACHED', 'undo Reached clears both, flags no-auto-reach, button back to REACHED', u);
  const done = Object.assign({}, s1, { status: 'done', doneAt: new Date(at(14, 32)).toISOString() });
  const back = Reached.undoDone(done);
  ok(back.reachedAt === at(14, 10) && back.reachedSource === 'tap' && back.status === undefined && back.doneAt === undefined && Reached.buttonLabel(back) === 'DONE', 'undo of Done keeps reachedAt (and source); the stop is pending again', back);
  const c = Reached.carryForward(Object.assign({}, done, { status: undefined, noAutoReach: true }));
  ok(c.reachedAt === null && c.reachedSource === null && !('noAutoReach' in c), 'carry-forward to another day clears reachedAt, reachedSource and the no-auto-reach flag', c);
  ok(Reached.onSiteStop([{ placeId: 'X', status: 'done', reachedAt: 1 }, s0, s1]).placeId === 'A', 'on site = the first stop reached and not done');
  ok(Reached.onSiteStop([{ placeId: 'X', status: 'skipped', reachedAt: 1 }, s0]) === null, 'a skipped stop is not "on site"');
}

console.log('autoReachTarget');
{
  // 1 deg lat = 111.19 km: 0.0007 deg = ~78 m, 0.002 deg = ~222 m
  const NOW = at(14, 10);
  const stop = (id, dLat, extra) => Object.assign({ id, lat: 3 + dLat, lng: 101 }, extra || {});
  const fix = (o) => Object.assign({ lat: 3, lng: 101, accuracy: 20, at: NOW - 5000 }, o || {});
  const opts = (o) => Object.assign({ enabled: true, visible: true, now: NOW }, o || {});
  const S1 = [stop('A', 0.0007), stop('B', 0.05)];
  ok(Reached.autoReachTarget(fix(), S1, opts()) === 'A', 'happy path: one pending stop 78 m away -> its id');
  ok(Reached.autoReachTarget(fix(), S1, opts({ enabled: false })) === null, 'setting off -> null');
  ok(Reached.autoReachTarget(fix(), S1, opts({ visible: false })) === null, 'page hidden -> null');
  ok(Reached.autoReachTarget(fix({ at: NOW - 6 * MIN }), S1, opts()) === null, 'stale fix (6 min old) -> null');
  ok(Reached.autoReachTarget(fix({ at: NOW - 4 * MIN }), S1, opts()) === 'A', 'a fix 4 min old is still fresh by the app\'s 5-minute rule');
  ok(Reached.autoReachTarget(fix({ at: null }), S1, opts()) === null, 'a fix without a timestamp -> null');
  ok(Reached.autoReachTarget(fix({ accuracy: 101 }), S1, opts()) === null, 'accuracy 101 m -> null');
  ok(Reached.autoReachTarget(fix({ accuracy: 100 }), S1, opts()) === 'A', 'accuracy exactly 100 m is accepted');
  ok(Reached.autoReachTarget(fix({ accuracy: undefined }), S1, opts()) === null, 'no accuracy -> null');
  ok(Reached.autoReachTarget(fix(), [stop('A', 0.002), stop('B', 0.05)], opts()) === null, 'zero stops in range (222 m) -> null');
  ok(Reached.autoReachTarget(fix(), [stop('A', 0.0007), stop('B', -0.0008)], opts()) === null, 'two stops in range -> null');
  ok(Reached.autoReachTarget(fix(), [stop('A', 0.0007, { reachedAt: NOW - MIN }), stop('B', 0.05)], opts()) === null, 'already reached -> null');
  ok(Reached.autoReachTarget(fix(), [stop('A', 0.0007, { reachedAt: NOW - MIN }), stop('B', -0.0008)], opts()) === 'B', 'a reached stop does not count as a second pending one');
  ok(Reached.autoReachTarget(fix(), [stop('A', 0.0007, { noAutoReach: true }), stop('B', 0.05)], opts()) === null, 'flagged no-auto-reach -> null');
  ok(Reached.autoReachTarget(fix(), [stop('A', 0.0007, { status: 'done' }), stop('B', 0.0007, { status: 'skipped' })], opts()) === null, 'done / skipped stops are never targets');
  ok(Reached.autoReachTarget(fix(), [stop('__end__', 0.0007, { isEnd: true }), stop('A', 0.05)], opts()) === null, 'the end point alone in range -> null');
  ok(Reached.autoReachTarget(fix(), [stop('__end__', 0.0007, { isEnd: true }), stop('A', -0.0007)], opts()) === null, 'end point and a stop both in range: ambiguous -> null');
  ok(Reached.autoReachTarget(null, S1, opts()) === null && Reached.autoReachTarget(fix(), [], opts()) === null, 'no fix / no stops -> null');
  ok(Reached.autoReachTarget(fix({ lat: 3.0013 }), [stop('A', 0.0007)], opts()) === 'A', 'a stop about 67 m from the fix (not on the same spot) reaches');
}

console.log('daySplit');
{
  const stopOf = (reachedMin, doneMin, dwell, extra) => Object.assign({ reachedAt: reachedMin == null ? null : T + reachedMin * MIN, doneAt: new Date(T + doneMin * MIN).toISOString(), dwellMin: dwell }, extra || {});
  // all reached: depart 09:00; A reached 09:20 done 09:40; B reached 10:10 done 10:30
  let r = Reached.daySplit([stopOf(20, 40, 15), stopOf(70, 90, 15)], T);
  near(r.stops[0].driveMin, 20, 1e-6, 'all reached: stop 1 drive = reached - day start (20 min)');
  near(r.stops[0].onSiteMin, 20, 1e-6, 'all reached: stop 1 on site = done - reached (20 min)');
  near(r.stops[1].driveMin, 30, 1e-6, 'all reached: stop 2 drive = reached - previous done (30 min)');
  near(r.totals.driveMin, 50, 1e-6, 'all reached: total driving 50 min');
  near(r.totals.onSiteMin, 40, 1e-6, 'all reached: total on site 40 min');
  ok(r.totals.anyEstimated === false && !r.stops[0].estimated && !r.stops[1].estimated, 'all reached: nothing estimated');
  // none reached: arrival = done - planned dwell
  r = Reached.daySplit([stopOf(null, 40, 15), stopOf(null, 90, 10)], T);
  near(r.stops[0].onSiteMin, 15, 1e-6, 'none reached: on site = planned dwell (15 min)');
  near(r.stops[0].driveMin, 25, 1e-6, 'none reached: drive = the rest (25 min)');
  near(r.stops[1].onSiteMin, 10, 1e-6, 'none reached: stop 2 on site = 10 min');
  ok(r.stops.every((x) => x.estimated) && r.totals.anyEstimated, 'none reached: every stop estimated, anyEstimated true');
  // mixed
  r = Reached.daySplit([stopOf(20, 40, 15), stopOf(null, 90, 10)], T);
  ok(!r.stops[0].estimated && r.stops[1].estimated && r.totals.anyEstimated, 'mixed: only the stop without Reached is estimated');
  near(r.totals.onSiteMin, 20 + 10, 1e-6, 'mixed: on-site total 30 min');
  near(r.totals.driveMin, 20 + 40, 1e-6, 'mixed: driving total 60 min (20 + 40)');
  // a skipped stop contributes nothing and does not move the "previous departure"
  r = Reached.daySplit([stopOf(20, 40, 15), stopOf(55, 56, 10, { skipped: true }), stopOf(70, 90, 15)], T);
  ok(r.stops[1].skipped && r.stops[1].driveMin === 0 && r.stops[1].onSiteMin === 0, 'a skipped stop: no drive, no on-site time');
  near(r.stops[2].driveMin, 30, 1e-6, 'after a skipped stop the drive runs from the last DONE stop (30 min)');
  near(r.totals.onSiteMin, 40, 1e-6, 'skipped stop adds no on-site time to the total');
  // first stop of the day: previous departure = the day's start
  r = Reached.daySplit([stopOf(35, 60, 20)], T);
  near(r.stops[0].driveMin, 35, 1e-6, 'first stop of the day: drive from the day start (35 min)');
  // estimate clamped to the previous departure
  r = Reached.daySplit([stopOf(20, 40, 15), stopOf(null, 45, 30)], T);
  ok(r.stops[1].estimated && r.stops[1].arrivalMs === T + 40 * MIN, 'estimate never earlier than the previous departure (arrival = 09:40, not 09:15)', r.stops[1]);
  near(r.stops[1].driveMin, 0, 1e-6, 'clamped estimate: drive 0');
  near(r.stops[1].onSiteMin, 5, 1e-6, 'clamped estimate: on site = done - previous departure (5 min)');
  // the under-60-seconds double-tap: Reached then Done 2 s later -> estimated, on-site is the planned dwell, NOT zero
  r = Reached.daySplit([stopOf(20, 40, 15), { reachedAt: T + 70 * MIN, doneAt: new Date(T + 70 * MIN + 2000).toISOString(), dwellMin: 15 }], T);
  ok(r.stops[1].estimated === true && r.totals.anyEstimated, 'double-tap (2 s): estimated');
  near(r.stops[1].onSiteMin, 15, 1e-6, 'double-tap: on-site time = planned dwell (15 min), not ~0');
  ok(r.stops[1].onSiteMin > 1, 'double-tap: on-site time is not zero');
  r = Reached.daySplit([{ reachedAt: T + 20 * MIN, doneAt: T + 20 * MIN + 59000, dwellMin: 10 }], T);
  ok(r.stops[0].estimated, '59 s between Reached and Done is still a double-tap');
  r = Reached.daySplit([{ reachedAt: T + 20 * MIN, doneAt: T + 20 * MIN + 60000, dwellMin: 10 }], T);
  ok(!r.stops[0].estimated && Math.abs(r.stops[0].onSiteMin - 1) < 1e-6, 'exactly 60 s is taken at face value (1 min on site)');
  // the final drive to the end point counts when ARRIVED was marked
  r = Reached.daySplit([stopOf(20, 40, 15)], T, { endArrivedAt: T + 70 * MIN });
  near(r.totals.driveMin, 20 + 30, 1e-6, 'final drive (done -> ARRIVED at the end point) counts as driving');
  r = Reached.daySplit([stopOf(20, 40, 15)], T, {});
  near(r.totals.driveMin, 20, 1e-6, 'no ARRIVED: no final drive');
}

console.log('re-time: a stop that is on site');
{
  // world: start (0,0), A(1,0) B(2,0) C(3,0), end (0,0); 1 unit = 60 s; 5 min dwell; departs 09:00
  const DEP = new Date(2030, 0, 15, 9, 0, 0);
  const place = (id, x, y) => ({ id, name: id, lat: x, lng: y, type: 'other', dwellMin: 5, closedWindows: [] });
  const errand = (id, pid) => ({ id, pickups: [], deliveryPlaceId: null, errandPlaceId: pid, dwellMin: 5, notes: id, urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: 0 });
  const places = { A: place('A', 1, 0), B: place('B', 2, 0), C: place('C', 3, 0) };
  const input = { start: { lat: 0, lng: 0 }, end: { lat: 0, lng: 0 }, jobs: [errand('jA', 'A'), errand('jB', 'B'), errand('jC', 'C')], places, departAtISO: DEP.toISOString(), noDetour: false };
  const pts = Solver.pointsFor(Object.assign({}, input, { matrices: [] }));
  input.matrices = [0, 2, 4].map((h) => ({ departAt: new Date(DEP.getTime() + h * 3600e3).toISOString(),
    m: pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 60)))) }));
  const plan = Solver.solve(input).plans[0];
  const iso = (ms) => new Date(ms).toISOString();
  const reach = (p, i, ms) => Object.assign({}, p, { stops: p.stops.map((s, k) => (k === i ? Object.assign({}, s, { reachedAt: ms, reachedSource: 'tap' }) : s)) });
  const normal = Solver.retime(plan, -1, iso(at(9, 0)));
  ok(normal.stops.map((s) => s.placeId).join() === 'A,B,C', 'order A, B, C');
  // reached A at 09:01 (planned arrival), now 09:03 (before the 5-min dwell is over: 09:06)
  const p1 = reach(plan, 0, at(9, 1));
  const early = Solver.retime(p1, -1, iso(at(9, 3)));
  ok(early.stops[0].arriveAt === at(9, 1), 'on site: arrival = the Reached time (09:01)', hm(early.stops[0].arriveAt));
  ok(early.stops[0].departAt === at(9, 6), 'before the dwell has elapsed: departure = reached + dwell (09:06)', hm(early.stops[0].departAt));
  ok(early.stops[1].arriveAt === at(9, 7), 'the next stop is timed from that departure (09:06 + 1 min = 09:07)', hm(early.stops[1].arriveAt));
  ok(early.stops[2].arriveAt === at(9, 13), 'and the one after it (B dwell 5 + 1 min leg = 09:13)', hm(early.stops[2].arriveAt));
  // now 09:20, well past reached + dwell
  const late = Solver.retime(p1, -1, iso(at(9, 20)));
  ok(late.stops[0].arriveAt === at(9, 1), 'after the dwell: arrival still the Reached time', hm(late.stops[0].arriveAt));
  ok(late.stops[0].departAt === at(9, 20), 'after the dwell has elapsed: departure = now (09:20)', hm(late.stops[0].departAt));
  ok(late.stops[1].arriveAt === at(9, 21), 'the next stop is timed from "now" (09:21)', hm(late.stops[1].arriveAt));
  ok(late.endArrival > early.endArrival, 'the end arrival moves later with it');
  // a live origin (fix -> next stop) is not used for the on-site stop and is not applied to the stops after it
  const withOrigin = Solver.retime(p1, -1, iso(at(9, 3)), { durationToNextSec: 3600 });
  ok(withOrigin.stops[0].departAt === at(9, 6) && withOrigin.stops[1].arriveAt === at(9, 7), 'a live origin does not move an on-site stop or the stops after it');
  // not reached: timed exactly as before
  const un = Solver.retime(plan, -1, iso(at(9, 3)));
  ok(un.stops[0].arriveAt === at(9, 4) && un.stops[0].departAt === at(9, 9), 'a stop that is not reached is timed exactly as today (leg from now)', [hm(un.stops[0].arriveAt), hm(un.stops[0].departAt)]);
  // the Route tab's live view: an on-site stop keeps its arrival and rolls only the departure forward
  const lv = Solver.liveView(Solver.retime(p1, -1, iso(at(9, 3))), at(9, 10));
  ok(lv.stops[0].arriveAt === at(9, 1) && lv.stops[0].departAt === at(9, 10) && lv.stops[1].arriveAt === at(9, 11), 'liveView: on site past its dwell -> arrival kept, departure = now, later stops follow', [hm(lv.stops[0].arriveAt), hm(lv.stops[0].departAt), hm(lv.stops[1].arriveAt)]);
  // LATE follows the real arrival
  const lateWin = Object.assign({}, p1, { model: Object.assign({}, p1.model, { beforeMs: { A: [{ jobId: 'jA', ms: at(9, 0) + 30000 }] } }) });
  ok(Solver.retime(lateWin, -1, iso(at(9, 3))).stops[0].late === true, 'LATE recomputes from the Reached time');
  // done / skipped: reachedAt does not matter
  const dn = Solver.retime(Object.assign({}, p1, { stops: p1.stops.map((s, k) => (k === 0 ? Object.assign({}, s, { status: 'done', doneAt: iso(at(9, 4)) }) : s)) }), 0, iso(at(9, 4)));
  ok(dn.stops[0].status === 'done' && dn.stops[1].arriveAt === at(9, 5), 'a done stop is left alone; the next stop is timed from the DONE', hm(dn.stops[1].arriveAt));
  const un2 = Reached.undoDone(Object.assign({}, p1.stops[0], { status: 'done', doneAt: iso(at(9, 4)) }));
  ok(Solver.retime(Object.assign({}, p1, { stops: [un2].concat(p1.stops.slice(1)) }), -1, iso(at(9, 5))).stops[0].arriveAt === at(9, 1), 'after undo of Done the stop is on site again with its original Reached time');
}

console.log('day log: Reached fields and the summary split');
{
  const day = DL.newDay({ date: '2030-01-15' });
  const places = { A: { name: 'Alpha', lat: 1, lng: 1 }, B: { name: 'Beta', lat: 2, lng: 2 }, C: { name: 'Gamma', lat: 3, lng: 3 } };
  const jobs = [
    { id: 'j1', pickups: [], inHandItem: 'x', deliveryPlaceId: 'A', urgent: false, status: 'pending' },
    { id: 'j2', pickups: [], inHandItem: 'y', deliveryPlaceId: 'B', urgent: false, status: 'pending' },
    { id: 'j3', pickups: [], inHandItem: 'z', deliveryPlaceId: 'C', urgent: false, status: 'pending' },
  ];
  DL.recordPlan(day, { nowIso: new Date(T).toISOString(), start: { lat: 0, lng: 0 }, departAtIso: new Date(T).toISOString(), jobs, places, stopOrder: ['A', 'B', 'C'] });
  const iso = (ms) => new Date(ms).toISOString();
  DL.recordDone(day, { nowIso: iso(T + 40 * MIN), stopId: 'A', actions: [{ jobId: 'j1', kind: 'deliver', item: 'x' }], places, reachedAt: T + 20 * MIN, reachedSource: 'auto', dwellMin: 15 });
  DL.recordDone(day, { nowIso: iso(T + 90 * MIN), stopId: 'B', actions: [{ jobId: 'j2', kind: 'deliver', item: 'y' }], places, reachedAt: T + 90 * MIN - 2000, reachedSource: 'tap', dwellMin: 15 });
  let s = DL.summarise(day, jobs, places);
  ok(s.visits.length === 2 && s.visits[0].reachedAt === T + 20 * MIN && s.visits[0].reachedSource === 'auto' && s.visits[0].dwellMin === 15, 'the day log keeps reachedAt, reachedSource and the planned dwell raw', s.visits[0]);
  const ev = day.events.find((e) => e.type === 'done' && e.stopId === 'A');
  ok(ev.reachedAt === T + 20 * MIN && ev.reachedSource === 'auto', 'the done event carries reachedAt / reachedSource');
  let sp = Reached.splitOfSummary(s);
  ok(sp && sp.totals.anyEstimated && sp.stops[1].estimated && Math.abs(sp.stops[1].onSiteMin - 15) < 1e-6, 'summary split: the double-tap stop is estimated at its planned dwell', sp && sp.stops[1]);
  near(sp.totals.onSiteMin, 20 + 15, 1e-6, 'summary split: on site 35 min');
  near(sp.totals.driveMin, 20 + 35, 1e-6, 'summary split: driving 55 min (09:00 -> 09:20, 09:40 -> 10:15)');
  ok(DL.fmtDur(sp.totals.driveMin) === '55 min' && DL.fmtDur(160) === '2 h 40 min' && DL.fmtDur(107) === '1 h 47 min', 'durations read like "2 h 40 min"');
  ok(hm(sp.stops[0].arrivalMs) === hm(T + 20 * MIN) && hm(sp.stops[0].departMs) === hm(T + 40 * MIN), 'per stop: arr / left times');
  // an old day: no stop has reachedAt -> no split, nothing backfilled
  const old = DL.newDay({ date: '2030-01-14' });
  DL.recordPlan(old, { nowIso: new Date(T).toISOString(), start: { lat: 0, lng: 0 }, departAtIso: new Date(T).toISOString(), jobs, places, stopOrder: ['A'] });
  DL.recordDone(old, { nowIso: iso(T + 40 * MIN), stopId: 'A', actions: [{ jobId: 'j1', kind: 'deliver', item: 'x' }], places });
  const so = DL.summarise(old, jobs, places);
  ok(Reached.splitOfSummary(so) === null, 'a day closed before this feature (no reachedAt anywhere): no split line');
  ok(so.visits[0].reachedAt === null && so.jobsDone === 1, 'old events summarise exactly as before');
  // the existing totals are unchanged by the new fields
  const plain = DL.newDay({ date: '2030-01-16' });
  DL.recordPlan(plain, { nowIso: new Date(T).toISOString(), start: { lat: 0, lng: 0 }, departAtIso: new Date(T).toISOString(), jobs, places, stopOrder: ['A', 'B'] });
  DL.recordDone(plain, { nowIso: iso(T + 40 * MIN), stopId: 'A', actions: [{ jobId: 'j1', kind: 'deliver', item: 'x' }], places });
  DL.recordDone(plain, { nowIso: iso(T + 90 * MIN), stopId: 'B', actions: [{ jobId: 'j2', kind: 'deliver', item: 'y' }], places });
  const a = DL.summarise(plain, jobs, places), b = DL.summarise(day, jobs, places);
  ok(a.jobsDone === b.jobsDone && a.hoursOutMin === b.hoursOutMin && a.stopsVisited === b.stopsVisited, 'jobs, stops and time out do not depend on Reached');
  // fuel stop: reached fields ride on it too, it is a stop in the split
  DL.recordFuel(day, { nowIso: iso(T + 100 * MIN), stopId: '__fuel__', name: 'Caltex X', places, reachedAt: T + 95 * MIN, reachedSource: 'tap', dwellMin: 7 });
  s = DL.summarise(day, jobs, places);
  sp = Reached.splitOfSummary(s);
  ok(sp.stops.length === 3 && /Fuel/.test(sp.stops[2].name) && Math.abs(sp.stops[2].onSiteMin - 5) < 1e-6, 'the fuel stop is split like any stop (5 min on site)', sp.stops[2]);
  DL.recordArrivedEnd(day, { nowIso: iso(T + 130 * MIN), endPoint: { lat: 0, lng: 0, name: 'Home' } });
  s = DL.summarise(day, jobs, places);
  near(Reached.splitOfSummary(s).totals.endDriveMin, 30, 1e-6, 'ARRIVED at the end point adds the final drive (30 min)');
  // undo of DONE removes the group (and its reached data) from the summary
  DL.recordUndo(day, { nowIso: iso(T + 131 * MIN), stopId: '__fuel__' });
  ok(DL.summarise(day, jobs, places).visits.length === 2, 'undo of DONE removes that visit');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
