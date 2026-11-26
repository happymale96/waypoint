'use strict';
// Part 5 (26 Nov 2026): Undo of Reached. The state (REACHED again, the reached time cleared; manual and auto), the day's timeline
// (an undone Reached never happened: the DONE that follows carries no reached time, km and every other time unchanged) and the
// no-immediate-refire rule (Reached.autoReachStep: no auto-Reached for that stop until a fix more than the Auto-Reached
// distance away, or a REACHED tap). The clock is pinned (26 Nov 2026, Malaysia time).
// Run: TZ=Asia/Kuala_Lumpur node test/reachundo.test.js
const Reached = require('../reached.js');
const DL = require('../daylog.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, name) => ok(a != null && Math.abs(a - b) < 0.01, name, { got: a, want: b });
const at = (h, m, s) => new Date(2026, 10, 26, h, m, s || 0).getTime();
const iso = (ms) => new Date(ms).toISOString();
const NOW = at(14, 0);
Date.now = () => NOW; // pinned clock
const hm = (ms) => DL.fmtTime(ms);

console.log('U1. the state after Undo (manual and auto Reached)');
{
  const s0 = { placeId: 'A', actions: [] };
  const man = Reached.stampReached(s0, at(13, 50), 'tap');
  ok(Reached.buttonLabel(man) === '✓ DONE' && Reached.reachedText(man, hm) === 'Reached 13:50', 'manual: "Reached 13:50", button ✓ DONE');
  const u1 = Reached.undoReached(man);
  ok(Reached.buttonLabel(u1) === 'REACHED' && u1.reachedAt === null && u1.reachedSource === null && !Reached.isReached(u1), 'manual Undo: REACHED again, the reached time cleared', u1);
  const aut = Reached.stampReached(s0, at(13, 52), 'auto');
  ok(Reached.reachedText(aut, hm) === 'Reached 13:52 · auto', 'auto: "Reached 13:52 · auto"');
  const u2 = Reached.undoReached(aut);
  ok(Reached.buttonLabel(u2) === 'REACHED' && u2.reachedAt === null && u2.reachedSource === null && u2.noAutoReach === true, 'auto Undo: REACHED again, the time cleared, auto-Reached held', u2);
  ok(Reached.onSiteStop([u2]) === null, 'not on site any more (the re-time drives to it again)');
  const again = Reached.stampReached(u2, at(13, 58), 'tap');
  ok(again.reachedAt === at(13, 58) && !('noAutoReach' in again), 'a REACHED tap after the Undo stamps the new time and lifts the hold', again);
  ok(s0.reachedAt === undefined && man.reachedAt === at(13, 50), 'inputs are never changed');
}

console.log('U2. the day timeline treats an undone Reached as never having happened');
{
  const places = { A: { id: 'A', name: 'Alpha', lat: 3.1, lng: 101.6 }, B: { id: 'B', name: 'Beta', lat: 3.2, lng: 101.7 } };
  const jobs = [{ id: 'j1', pickups: [], deliveryPlaceId: 'A', status: 'pending' }, { id: 'j2', pickups: [], deliveryPlaceId: 'B', status: 'pending' }];
  const START = at(13, 0);
  const run = (undo) => {
    const day = DL.newDay({ date: '2026-11-26' });
    DL.recordPlan(day, { nowIso: iso(START), start: { lat: 3, lng: 101.5 }, departAtIso: iso(START), jobs, places, stopOrder: ['A', 'B'] });
    DL.recordNav(day, { nowIso: iso(at(13, 5)), at: at(13, 5), stopId: 'A' });
    // the stop: an auto-Reached at 13:20 (a wrong one: he was passing by) ...
    let stop = Reached.stampReached({ placeId: 'A', actions: [{ jobId: 'j1', kind: 'deliver', item: 'x' }] }, at(13, 20), 'auto');
    if (undo) stop = Reached.undoReached(stop); // ... undone at 13:21
    // DONE at 13:45 (the app's logDone passes the stop's reached fields as they are now)
    DL.recordDone(day, { nowIso: iso(at(13, 45)), stopId: 'A', actions: stop.actions, places, reachedAt: stop.reachedAt != null ? stop.reachedAt : null, reachedSource: stop.reachedSource || null, dwellMin: 10, navStartedAt: null });
    DL.recordNav(day, { nowIso: iso(at(13, 50)), at: at(13, 50), stopId: 'B' });
    DL.recordDone(day, { nowIso: iso(at(14, 30)), stopId: 'B', actions: [{ jobId: 'j2', kind: 'deliver', item: 'y' }], places, reachedAt: at(14, 15), reachedSource: 'tap', dwellMin: 10 });
    const s = DL.summarise(day, jobs, places);
    return { s, sp: Reached.splitOfSummary(s, at(14, 30)) };
  };
  const kept = run(false), und = run(true);
  ok(kept.s.visits[0].reachedAt === at(13, 20), 'without Undo: the day keeps the 13:20 Reached');
  ok(und.s.visits[0].reachedAt === null && und.s.visits[0].reachedSource === null, 'with Undo: the DONE carries no reached time (nothing else records a Reached)');
  const a0 = kept.sp.stops[0], a1 = und.sp.stops[0];
  ok(a0.arrivalMs === at(13, 20) && !a0.estimated, 'without Undo: arrival 13:20');
  ok(a1.arrivalMs === at(13, 35) && a1.estimated, 'with Undo: arrival = DONE − planned dwell (~13:35), estimated', [hm(a1.arrivalMs), a1.estimated]);
  near(a1.driveMin, 30, 'with Undo: driving 13:05 -> 13:35 = 30 min');
  near(a1.onSiteMin, 10, 'with Undo: on site 10 min (not 25)');
  ok(Reached.stopLine(a1, 2, hm).indexOf('arr ~13:35') >= 0 && Reached.stopLine(a1, 2, hm).indexOf('13:20') < 0, 'the per-stop line shows ~13:35 and never 13:20', Reached.stopLine(a1, 2, hm));
  near(und.sp.totals.totalMin, kept.sp.totals.totalMin, 'the day\'s total time is unchanged');
  ok(und.sp.stops[1].arrivalMs === kept.sp.stops[1].arrivalMs && und.sp.stops[1].departMs === kept.sp.stops[1].departMs && und.sp.stops[1].navMs === kept.sp.stops[1].navMs, 'the next stop\'s times are unchanged');
  ok(und.s.visits.map((v) => v.doneAt).join() === kept.s.visits.map((v) => v.doneAt).join() && JSON.stringify(und.s.km) === JSON.stringify(kept.s.km), 'done times and km are unchanged', [und.s.km, kept.s.km]);
}

console.log('U3. no auto-Reached again until he has been more than the distance away (or taps REACHED)');
{
  // stop A at (3.1, 101.6); 80 m default; a fix reports speed 0 (stopped)
  const A = { lat: 3.1, lng: 101.6 };
  const fixAt = (dLat, t) => ({ lat: A.lat + dLat, lng: A.lng, accuracy: 10, at: t, speed: 0 });
  const opts = { enabled: true, visible: true, now: NOW, radiusM: 80 };
  const stopsOf = (s) => [{ id: 'A', lat: A.lat, lng: A.lng, status: s.status, reachedAt: s.reachedAt, noAutoReach: s.noAutoReach, actions: s.actions }];
  let stop = { placeId: 'A' };
  let r = Reached.autoReachStep(null, fixAt(0.0003, NOW - 30000), stopsOf(stop), opts); // ~33 m, stopped
  ok(r.id === 'A', 'before: inside 33 m and stopped -> auto-Reached');
  stop = Reached.undoReached(Reached.stampReached(stop, NOW - 30000, 'auto')); // the driver taps Undo
  const apply = (res) => { if (res.rearm.indexOf('A') >= 0) delete stop.noAutoReach; };
  r = Reached.autoReachStep(null, fixAt(0.0003, NOW - 20000), stopsOf(stop), opts); apply(r);
  ok(r.id === null && stop.noAutoReach === true, 'right after Undo: the same spot, stopped -> nothing');
  r = Reached.autoReachStep(null, fixAt(0.0006, NOW - 15000), stopsOf(stop), opts); apply(r); // ~67 m: still inside 80
  ok(r.id === null && stop.noAutoReach === true, 'moving about inside 80 m (67 m) -> still held');
  r = Reached.autoReachStep(null, Object.assign(fixAt(0.0009, NOW - 12000), { accuracy: 150 }), stopsOf(stop), opts); apply(r);
  ok(r.id === null && stop.noAutoReach === true, 'a poor fix (150 m accuracy) 100 m away does not lift it');
  r = Reached.autoReachStep(null, fixAt(0.0009, NOW - 10000), stopsOf(stop), opts); // ~100 m: outside
  ok(r.id === null && r.rearm.join() === 'A', 'a good fix 100 m away (more than 80) -> rearm A, and no Reached on that fix');
  apply(r);
  ok(!('noAutoReach' in stop), 'the hold is lifted');
  r = Reached.autoReachStep(null, fixAt(0.0003, NOW - 5000), stopsOf(stop), opts); apply(r);
  ok(r.id === 'A', 'back inside and stopped -> auto-Reached again');
  // a distance from Settings (150 m): 100 m away is still inside, nothing lifts
  const s2 = Reached.undoReached({ placeId: 'A', reachedAt: NOW, reachedSource: 'tap' });
  r = Reached.autoReachStep(null, fixAt(0.0009, NOW - 5000), stopsOf(s2), Object.assign({}, opts, { radiusM: 150 }));
  ok(r.id === null && r.rearm.length === 0, 'with a 150 m distance, 100 m away is not far enough');
  // a done stop is never re-armed (nothing pending)
  r = Reached.autoReachStep(null, fixAt(0.002, NOW - 5000), [{ id: 'A', lat: A.lat, lng: A.lng, status: 'done', noAutoReach: true }], opts);
  ok(r.rearm.length === 0, 'a done stop: nothing to re-arm');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
