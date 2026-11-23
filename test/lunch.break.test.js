'use strict';
// The DRIVER's lunch break (lunchbreak.js): applyBreak on the re-timed timeline, the break state (start / end / auto end /
// skip) and the Route-tab bar. Not the customer's lunch window (that is test/lunch.test.js).
// Run as its own node script: node test/lunch.break.test.js
const LB = require('../lunchbreak.js');
const Solver = require('../solver.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const MIN = 60000;
const at = (h, m) => new Date(2030, 0, 15, h, m, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();
const hm = (ms) => Solver.formatETA(ms);
const ON = { lunchBreakOn: true, lunchBreakFrom: '12:15', lunchBreakMin: 60 };
const OFF = Object.assign({}, ON, { lunchBreakOn: false });
const fresh = LB.fresh('2030-1-15');

// three stops A, B, C; every leg 30 min, every dwell 20 min. Points: 0 start, 1 A, 2 B, 3 C, 4 end.
function planAt(departMs, opts) {
  opts = opts || {};
  const leg = 1800, m = [];
  for (let i = 0; i < 5; i++) { m.push([]); for (let j = 0; j < 5; j++) m[i].push(i === j ? 0 : leg); }
  const ids = ['A', 'B', 'C'];
  const model = { t0ms: departMs, start: { lat: 0, lng: 0 }, end: { lat: 1, lng: 1 }, stopIds: ids, matrices: [{ departAt: iso(departMs), m }],
    dwellSec: { A: 1200, B: 1200, C: 1200 }, afterMs: { A: null, B: null, C: opts.cAfter || null }, closed: { A: [], B: [], C: [] },
    beforeMs: { A: [], B: [], C: opts.cBefore ? [{ jobId: 'jc', ms: opts.cBefore }] : [] }, names: { A: 'Alpha', B: 'Beta', C: 'Gamma' }, respectClosed: false };
  return { order: ids, stops: ids.map((id) => ({ placeId: id, arriveAt: 0, departAt: 0, waitSec: 0, actions: [] })), totalSec: 0, endArrival: 0, violations: [], model };
}
const timeline = (departMs, opts, fromIdx, nowMs) => Solver.retime(planAt(departMs, opts), fromIdx == null ? -1 : fromIdx, iso(nowMs || departMs));
const arr = (p, id) => p.stops.find((s) => s.placeId === id).arriveAt;

console.log('assumed break: at the first departure at or after 12:15');
{
  const t = timeline(at(11, 0));
  ok(hm(arr(t, 'A')) === '11:30' && hm(arr(t, 'B')) === '12:20' && hm(arr(t, 'C')) === '13:10' && hm(t.endArrival) === '14:00', 'without the break: A 11:30, B 12:20, C 13:10, end 14:00');
  const b = LB.applyBreak(t, fresh, ON, at(11, 0));
  ok(hm(arr(b, 'A')) === '11:30' && hm(arr(b, 'B')) === '12:20', 'A and B (departures before 12:15) unchanged');
  ok(hm(arr(b, 'C')) === '14:10' && hm(b.endArrival) === '15:00', 'B departs 12:40 (first departure >= 12:15): C and the end are one hour later', [hm(arr(b, 'C')), hm(b.endArrival)]);
  ok(b.lunch && b.lunch.kind === 'assumed' && hm(b.lunch.startMs) === '12:40' && hm(b.lunch.endMs) === '13:40' && b.lunch.beforePlaceId === 'C', 'plan.lunch says where it sits (12:40-13:40, before C)', b.lunch);
  ok(b.totalSec === t.totalSec + 3600, 'the total grows by the break length');
  ok(arr(t, 'C') === at(13, 10), 'the input timeline is untouched');
  const b45 = LB.applyBreak(t, fresh, Object.assign({}, ON, { lunchBreakMin: 45 }), at(11, 0));
  ok(hm(arr(b45, 'C')) === '13:55', 'length 45 min: C 13:55');
  const bFrom = LB.applyBreak(t, fresh, Object.assign({}, ON, { lunchBreakFrom: '11:45' }), at(11, 0));
  ok(hm(arr(bFrom, 'B')) === '13:20', 'Available from 11:45: A departs 11:50 -> B one hour later (13:20)');
  ok(LB.applyBreak(t, fresh, ON, at(11, 0)).stops.filter((s) => s.arriveAt !== t.stops.find((x) => x.placeId === s.placeId).arriveAt).length === 1, 'added once (only C moves)');
}

console.log('the day finishes before 12:15: nothing added');
{
  const t = timeline(at(8, 0));
  ok(hm(t.endArrival) === '11:00', 'an 08:00 start finishes at 11:00');
  const b = LB.applyBreak(t, fresh, ON, at(8, 0));
  ok(b === t && !b.lunch, 'no departure at or after 12:15: same timeline, no break');
}

console.log('the route starts after 12:15: break at the start');
{
  const t = timeline(at(12, 30));
  const b = LB.applyBreak(t, fresh, ON, at(12, 30));
  ok(hm(arr(b, 'A')) === '14:00' && hm(arr(b, 'C')) === '15:40' && hm(b.endArrival) === '16:30', 'starting 12:30: every stop one hour later (A 14:00)', [hm(arr(b, 'A')), hm(b.endArrival)]);
  ok(b.lunch.beforePlaceId === 'A' && hm(b.lunch.startMs) === '12:30', 'the break sits before A');
}

console.log('an arriveAfter wait absorbs the break');
{
  const t = timeline(at(11, 0), { cAfter: at(13, 50) });
  ok(hm(arr(t, 'C')) === '13:50' && t.stops[2].waitSec === 40 * 60, 'without the break C waits 40 min for 13:50');
  const b = LB.applyBreak(t, fresh, ON, at(11, 0));
  ok(hm(arr(b, 'C')) === '14:10' && b.stops[2].waitSec === 0, 'with it C arrives 14:10 (no wait); the shift is 20 min, not 60', [hm(arr(b, 'C')), b.stops[2].waitSec]);
  ok(hm(b.endArrival) === '15:00', 'end 15:00');
}

console.log('LATE is recomputed with the break');
{
  const t = timeline(at(11, 0), { cBefore: at(14, 0) });
  ok(!t.stops[2].late && t.violations.length === 0, 'without the break C (13:10) is on time for 14:00');
  const b = LB.applyBreak(t, fresh, ON, at(11, 0));
  ok(b.stops[2].late === true && b.violations.length === 1 && /Gamma/.test(b.violations[0]) && b.lateSec === 600, 'with it C (14:10) is LATE by 10 min', [b.stops[2].late, b.violations, b.lateSec]);
}

console.log('the real break replaces the assumed one');
{
  // B done 12:40; Start at 12:30 was tapped while on site? no: started 12:30, now 12:45, re-timed from B
  const st = LB.start(fresh, at(12, 30));
  ok(LB.phase(st, ON, at(12, 45)) === 'active' && hm(LB.untilMs(st, ON)) === '13:30', 'started 12:30: active until 13:30');
  const t = timeline(at(11, 0));
  t.stops[0].status = 'done'; t.stops[1].status = 'done';
  const t2 = Solver.retime(t, 1, iso(at(12, 45)));
  ok(hm(arr(t2, 'C')) === '13:15', 'without the break, from B at 12:45: C 13:15');
  const b = LB.applyBreak(t2, st, ON, at(12, 45));
  ok(hm(arr(b, 'C')) === '14:00' && hm(b.endArrival) === '14:50', 'remaining 45 min: C = now + 45 + 30 min = 14:00', [hm(arr(b, 'C')), hm(b.endArrival)]);
  ok(b.lunch.kind === 'active' && hm(b.lunch.endMs) === '13:30', 'plan.lunch: the real break, until 13:30');
  ok(LB.applyBreak(t2, fresh, ON, at(12, 45)) !== b && hm(arr(LB.applyBreak(t2, fresh, ON, at(12, 45)), 'C')) === '14:15', 'not started, same moment: the assumed break would add the full hour (C 14:15)');
  // early end
  const e = LB.end(st, ON, at(13, 0));
  ok(e.endedAt === at(13, 0) && LB.phase(e, ON, at(13, 0)) === 'taken', 'End break at 13:00: taken, endedAt 13:00');
  const t3 = Solver.retime(t, 1, iso(at(13, 0)));
  ok(LB.applyBreak(t3, e, ON, at(13, 0)) === t3 && hm(arr(t3, 'C')) === '13:30', 'after the early end the route is timed from now (C 13:30), no break added again');
  ok(LB.start(e, at(14, 0)) === e, 'one break a day: Start does nothing after it was taken');
  // auto end
  ok(LB.phase(st, ON, at(13, 30)) === 'taken', 'the length elapsed: taken');
  const ae = LB.autoEnd(st, ON, at(13, 31));
  ok(ae.endedAt === at(13, 30), 'auto end: endedAt = start + length (13:30), not the moment it was noticed', hm(ae.endedAt));
  ok(LB.autoEnd(st, ON, at(13, 0)) === st, 'before the length elapsed nothing ends');
  ok(LB.end(st, ON, at(14, 0)).endedAt === at(13, 30), 'End break after the length: capped at 13:30');
  // on site during the break: you leave after it
  const t4 = timeline(at(11, 0));
  t4.stops[0].status = 'done';
  t4.stops[1].reachedAt = at(12, 20);
  const t5 = Solver.retime(t4, 0, iso(at(12, 45)));
  const b5 = LB.applyBreak(t5, st, ON, at(12, 45));
  ok(hm(b5.stops[1].departAt) === '13:30' && hm(arr(b5, 'C')) === '14:00', 'on site at B during the break: leave B 13:30, C 14:00', [hm(b5.stops[1].departAt), hm(arr(b5, 'C'))]);
}

console.log('skipped, setting off');
{
  const t = timeline(at(11, 0));
  const sk = LB.skip(fresh);
  ok(LB.phase(sk, ON, at(12, 20)) === 'skipped' && LB.applyBreak(t, sk, ON, at(12, 20)) === t, 'Skip today: no break in the timeline');
  ok(LB.phase(LB.unskip(sk), ON, at(12, 20)) === 'assumed', 'Undo: the assumed break is back');
  ok(LB.phase(fresh, OFF, at(12, 20)) === 'off' && LB.applyBreak(t, fresh, OFF, at(11, 0)) === t, 'setting off: no break');
  ok(LB.phase(LB.start(fresh, at(12, 20)), OFF, at(12, 30)) === 'active', 'a break already started keeps running if the setting is switched off');
}

console.log('the bar, the state per day, the settings');
{
  ok(LB.bar(fresh, ON, at(12, 14), true) === null, '12:14: no bar yet');
  const b = LB.bar(fresh, ON, at(12, 16), true);
  ok(b && b.kind === 'start' && b.label === 'Start lunch break (1 h)', '12:16: "Start lunch break (1 h)"', b);
  ok(LB.bar(fresh, ON, at(12, 16), false) === null, 'no pending stop: no bar');
  ok(LB.bar(fresh, OFF, at(12, 16), true) === null, 'setting off: no bar');
  const act = LB.bar(LB.start(fresh, at(12, 20)), ON, at(12, 30), true);
  ok(act.kind === 'active' && hm(act.untilMs) === '13:20', 'during the break: "Lunch until 13:20"');
  ok(LB.bar(LB.end(LB.start(fresh, at(12, 20)), ON, at(12, 50)), ON, at(12, 51), true) === null, 'after End break: no bar');
  ok(LB.bar(LB.skip(fresh), ON, at(12, 30), true).kind === 'skipped', 'after Skip today: the "skipped" line');
  ok(LB.lenLabel(60) === '1 h' && LB.lenLabel(45) === '45 min' && LB.lenLabel(90) === '1 h 30 min', 'length labels');
  const stored = { date: '2030-1-14', startedAt: at(12, 0), endedAt: at(13, 0), skipped: false };
  ok(LB.forDay(stored, '2030-1-15').startedAt === null && LB.forDay(stored, '2030-1-14').startedAt === at(12, 0), "yesterday's break never carries over; today's survives a reload");
  const d = LB.settingsOf({});
  ok(d.on === true && d.from === '12:15' && d.lenMin === 60, 'defaults: on, 12:15, 60 min');
  ok(LB.settingsOf({ lunchBreakFrom: 'x', lunchBreakMin: -5 }).from === '12:15' && LB.settingsOf({ lunchBreakMin: -5 }).lenMin === 60, 'bad values fall back to the defaults');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
