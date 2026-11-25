'use strict';
// Part A: the "After" ordering rule (job.afterPlaces), on a mocked minute table. The clock is pinned (25 Nov 2026 08:00 Malaysia time).
// Start at O (Office), end at H (Home); depart 08:00; every dwell 10 min; no time windows; no lunch break: the order is decided by
// driving time only. Run: TZ=Asia/Kuala_Lumpur node test/after.test.js
const Solver = require('../solver.js');
const JobEdit = require('../jobedit.js');
const OnBoard = require('../onboard.js');
const DL = require('../daylog.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const clone = (x) => JSON.parse(JSON.stringify(x));

const T0 = Date.UTC(2026, 10, 25, 0, 0); // 25 Nov 2026 08:00 MYT
Date.now = () => T0; // pinned clock (the solver's deadline never fires on this small problem)
const DEP = new Date(T0).toISOString();

// ---------- the mocked travel-time table (minutes, symmetric) ----------
const MIN = {
  'O-S': 30, 'O-A': 22, 'O-C': 25, 'O-E': 50, 'A-C': 11, 'A-S': 45, 'A-E': 62, 'C-S': 46, 'C-E': 61, 'S-E': 73,
  'H-A': 40, 'H-C': 42, 'H-S': 60, 'H-E': 50, 'H-O': 32,
};
const mins = (a, b) => (a === b ? 0 : MIN[a + '-' + b] != null ? MIN[a + '-' + b] : MIN[b + '-' + a]);
const NAMES = { O: 'Office', H: 'Home', S: 'HeveaPac', A: 'Asian Automotive', C: 'Carrier', E: 'Eastern Press' };
const places = {};
Object.keys(NAMES).forEach((id, i) => { places[id] = { id, name: NAMES[id], lat: 3 + i / 10, lng: 101 + i / 10, type: id === 'O' ? 'office' : id === 'H' ? 'home' : 'factory', dwellMin: 10, closedWindows: [] }; });
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, inHandItem: 'item ' + id, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: id }, o);
// four deliver-only jobs, one each at S, A, C, E
const world = () => ['S', 'A', 'C', 'E'].map((p) => job('j' + p, { deliveryPlaceId: p }));
const byPlace = (jobs, p) => jobs.find((j) => j.deliveryPlaceId === p);

function input(jobs, from) {
  const start = from || 'O';
  const inp = { start: places[start], end: places.H, jobs, places, departAtISO: DEP, noDetour: false };
  const keys = [start].concat(Solver.buildStops(jobs, places).stopIds.map(Solver.baseId), ['H']);
  inp.matrices = [{ departAt: DEP, m: keys.map((a) => keys.map((b) => mins(a, b) * 60)) }];
  return inp;
}
const solve = (jobs, from) => Solver.solve(input(jobs, from));
const best = (r) => r.plans[0];
const driveMin = (p) => Math.round(p.totalSec / 60 - 10 * p.order.length); // total minus the dwells
const conflictsOf = (r) => r.afterConflicts || [];

console.log('T1. no rules');
{
  const r = solve(world());
  eq(best(r).order, ['S', 'A', 'C', 'E'], 'order S, A, C, E');
  eq(driveMin(best(r)), 197, '197 minutes of driving');
  eq(conflictsOf(r), [], 'no banner');
}

const t2 = () => { const js = world(); byPlace(js, 'S').afterPlaces = ['A', 'C']; return js; };
console.log('T2. S after A and after C');
{
  const r = solve(t2());
  eq(best(r).order, ['A', 'C', 'S', 'E'], 'order A, C, S, E');
  eq(driveMin(best(r)), 202, '202 minutes of driving');
  eq(conflictsOf(r), [], 'no banner');
}

console.log('T3. S after A, and A after S (a cycle)');
{
  const js = world(); byPlace(js, 'S').afterPlaces = ['A']; byPlace(js, 'A').afterPlaces = ['S'];
  const r = solve(js), c = conflictsOf(r);
  ok(c.length === 1, 'one banner', c);
  ok(c.length === 1 && /^Can't put .+ after .+: .+\. Remove one of the rules\.$/.test(c[0]) && c[0].includes('HeveaPac') && c[0].includes('Asian Automotive'), 'the A6 banner names both places', c);
  eq(best(r).order, ['S', 'A', 'C', 'E'], 'the plan is the T1 order (the impossible rules are left out)');
}

console.log('T4. First stop on S, and S after A');
{
  const js = world(); byPlace(js, 'S').firstStop = true; byPlace(js, 'S').afterPlaces = ['A'];
  const r = solve(js), c = conflictsOf(r);
  ok(c.length === 1 && c[0] === "Can't put HeveaPac after Asian Automotive: HeveaPac is the First stop. Remove one of the rules.", 'the A6 banner (First stop wins)', c);
  eq(best(r).order, ['S', 'A', 'C', 'E'], 'order S, A, C, E');
}

console.log('T5. T2, then DONE at A; re-check');
{
  const js = t2(); byPlace(js, 'A').status = 'done'; // the visit to A is done: S after A is satisfied
  const r = solve(js, 'A'); // the re-check starts where the DONE was
  eq(best(r).order, ['C', 'S', 'E'], 'remaining order C, S, E');
  eq(conflictsOf(r), [], 'no banner');
}

console.log('T6. T2, then SKIP A; re-check');
{
  const js = t2();
  const plan = { stops: ['A', 'C', 'S', 'E'].map((p) => ({ placeId: p, actions: [{ jobId: 'j' + p, kind: 'deliver' }] })) };
  plan.stops[0].status = 'skipped';
  const left = OnBoard.jobsForPlan(clone(js), plan); // what PLAN / the re-check solves: A's job stays with the skipped stop
  const r = solve(left);
  const o = best(r).order;
  ok(o.indexOf('A') < 0, 'A is not re-solved (skipped)', o);
  ok(o.indexOf('C') >= 0 && o.indexOf('C') < o.indexOf('S'), 'C still before S', o);
  eq(conflictsOf(r), [], 'no banner');
}

console.log('T7. T2 with the S job urgent');
{
  const js = t2(); byPlace(js, 'S').urgent = true; byPlace(js, 'S').urgentRank = 1;
  const r = solve(js);
  eq(best(r).order, ['A', 'C', 'S', 'E'], 'order A, C, S, E (After beats urgent)');
  eq(conflictsOf(r), [], 'no banner');
  ok(best(r).stops.every((s) => !s.detour), 'A and C are not marked DETOUR (the After rule put them first)', best(r).stops.map((s) => [s.placeId, s.detour]));
}

console.log('T8. T2, then End day');
{
  const js = t2();
  const days = {};
  const day = DL.recordFor(days, '2026-11-25', 'Calvin');
  DL.recordPlan(day, { nowIso: DEP, departAtIso: DEP, start: places.O, jobs: js, places, stopOrder: ['A', 'C', 'S', 'E'] });
  const res = DL.endDay(days, { key: '2026-11-25', jobs: js, places, nowIso: new Date(T0 + 9 * 3600000).toISOString() });
  ok(res.key === '2026-11-25', 'the day closed');
  ok(js.every((j) => j.afterPlaces === undefined), 'no entry has an After rule', js.map((j) => j.afterPlaces));
  ok(res.changed.some((j) => j.id === 'jS'), 'the S job is saved (changed)');
}

console.log('More: cycle through collect-before-deliver; satisfied; form; export');
{
  // J9 collects at A for E; an entry at A wanting to come after E is impossible (collect-before-deliver wins)
  const js = world().concat([job('j9', { pickups: [{ placeId: 'A', item: 'gear', done: false }], deliveryPlaceId: 'E', inHandItem: '' })]);
  byPlace(js, 'A').afterPlaces = ['E'];
  const r = solve(js), c = conflictsOf(r);
  ok(c.length === 1 && c[0].startsWith("Can't put Asian Automotive after Eastern Press: ") && /collected at Asian Automotive/.test(c[0]), 'collect-before-deliver wins, the banner says why', c);
  const o = best(r).order;
  ok(o.indexOf('A') < o.indexOf('E'), 'A still before E', o);
}
{
  const js = t2(); byPlace(js, 'C').status = 'cancelled'; // a cancelled visit counts as satisfied
  const r = solve(js);
  eq(best(r).order.indexOf('C'), -1, 'the cancelled C is not planned');
  ok(best(r).order.indexOf('A') < best(r).order.indexOf('S'), 'A still before S');
  eq(conflictsOf(r), [], 'no banner');
}
{
  // the form: choices = places with an open job today, without this entry's own place
  const js = world();
  const form = JobEdit.formOf(byPlace(js, 'S'));
  eq(JobEdit.afterChoices(js, form, 'jS'), ['A', 'C', 'E'], 'After choices for S: A, C, E (not S)');
  form.afterPlaces = ['A', 'C', 'S'];
  const u = JobEdit.updateJob(js, 'jS', form, {});
  eq(u.job.afterPlaces, ['A', 'C'], 'saved: A and C (its own place never)');
  eq(JobEdit.afterLine(u.job, (id) => NAMES[id]), 'after Asian Automotive, Carrier', 'the Plan card line');
  const f2 = JobEdit.formOf(u.job); f2.afterPlaces = [];
  ok(JobEdit.updateJob(u.jobs, 'jS', f2, {}).job.afterPlaces === undefined, 'cleared: no field kept');
  eq(JobEdit.afterOf({ id: 'old' }), [], 'old data without the field = none');
  eq(JobEdit.afterOf({ afterPlaces: 'A' }), [], 'a malformed field = none');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
