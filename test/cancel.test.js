'use strict';
// Part F: cancel a job mid-day (Route card: SKIP -> "Cancel job"), on the T1 data of test/after.test.js plus J9 "collect at A, deliver
// to E". The clock is pinned (25 Nov 2026, 08:00 Malaysia time, moved by hand). Run: TZ=Asia/Kuala_Lumpur node test/cancel.test.js
const Solver = require('../solver.js');
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
let now = T0;
Date.now = () => now; // pinned
const DEP = new Date(T0).toISOString();
const isoAt = (min) => new Date(T0 + min * 60000).toISOString();

const MIN = {
  'O-S': 30, 'O-A': 22, 'O-C': 25, 'O-E': 50, 'A-C': 11, 'A-S': 45, 'A-E': 62, 'C-S': 46, 'C-E': 61, 'S-E': 73,
  'H-A': 40, 'H-C': 42, 'H-S': 60, 'H-E': 50, 'H-O': 32,
};
const mins = (a, b) => (a === b ? 0 : MIN[a + '-' + b] != null ? MIN[a + '-' + b] : MIN[b + '-' + a]);
const NAMES = { O: 'Office', H: 'Home', S: 'HeveaPac', A: 'Asian Automotive', C: 'Carrier', E: 'Eastern Press' };
const places = {};
Object.keys(NAMES).forEach((id, i) => { places[id] = { id, name: NAMES[id], lat: 3 + i / 10, lng: 101 + i / 10, type: id === 'O' ? 'office' : id === 'H' ? 'home' : 'factory', dwellMin: 10, closedWindows: [] }; });
const nameOf = (id) => (places[id] || {}).name || id;
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, inHandItem: 'item ' + id, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: id }, o);
const jobsT1 = () => ['S', 'A', 'C', 'E'].map((p) => job('j' + p, { deliveryPlaceId: p }))
  .concat([job('J9', { pickups: [{ placeId: 'A', item: 'gearbox', done: false }], deliveryPlaceId: 'E', inHandItem: '' })]);

function planOf(jobs) {
  const inp = { start: places.O, end: places.H, jobs, places, departAtISO: DEP, noDetour: false };
  const keys = ['O'].concat(Solver.buildStops(jobs, places).stopIds, ['H']);
  inp.matrices = [{ departAt: DEP, m: keys.map((a) => keys.map((b) => mins(a, b) * 60)) }];
  const r = Solver.solve(inp);
  return r.plans[0];
}
// the day as the app keeps it: the PLAN logged, then whatever happened
function dayOf(jobs, plan) {
  const days = {};
  const d = DL.recordFor(days, '2026-11-25', 'Calvin');
  DL.recordPlan(d, { nowIso: DEP, departAtIso: DEP, start: places.O, jobs, places, stopOrder: plan.order });
  return { days, d };
}
const stopOf = (plan, pid) => plan.stops.find((s) => s.placeId === pid && !s.status);
const cardJobs = (plan, pid) => { const s = stopOf(plan, pid); return s ? OnBoard.jobsOnCard(s).map((r) => r.jobId) : null; };
// cancel through the pure path the app uses, and log it like the app does
function cancel(st, ids, day) {
  const r = OnBoard.cancelJobs(st, ids, { nameOf, at: now });
  r.cancelled.forEach((c) => DL.recordCancel(day, { nowIso: new Date(now).toISOString(), jobId: c.jobId, item: c.item, place: c.place }));
  return r;
}
const endDay = (w, jobs) => { now = T0 + 9 * 3600000; return DL.endDay(w.days, { key: '2026-11-25', jobs, places, nowIso: new Date(now).toISOString() }); };

console.log('the plan');
{
  const p = planOf(jobsT1());
  eq(p.order, ['S', 'A', 'C', 'E'], 'T1 + J9: S, A, C, E');
  eq(cardJobs(p, 'A'), ['jA', 'J9'], 'the A card: its own job and J9 (collect)');
  eq(cardJobs(p, 'E'), ['jE', 'J9'], 'the E card: its own job and J9 (deliver)');
}

console.log('K1. cancel the deliver-only job at C');
{
  now = T0 + 30 * 60000;
  const jobs = jobsT1(), plan = planOf(jobs), w = dayOf(jobs, plan);
  const r = cancel({ jobs, plan, loose: [] }, ['jC'], w.d);
  ok(!r.plan.stops.some((s) => s.placeId === 'C'), 'C is gone from the route');
  eq(r.plan.order, ['S', 'A', 'E'], 'the rest keep their order');
  ok(r.jobs.find((j) => j.id === 'jC').status === 'cancelled', 'the job is cancelled');
  const res = endDay(w, r.jobs);
  ok(!(w.d.carried || []).some((c) => c.jobId === 'jC'), 'C is not in tomorrow\'s carry-forward', w.d.carried);
  ok(r.jobs.find((j) => j.id === 'jC').status === 'cancelled', 'End day leaves it cancelled (never pending again)');
  ok((w.d.carried || []).some((c) => c.jobId === 'jS'), 'the other not-done jobs still carry', w.d.carried.map((c) => c.jobId));
  const s = DL.summarise(w.d, r.jobs, places);
  eq(s.cancelled.map((c) => [c.item, c.place]), [['item jC', 'Carrier']], 'the summary lists it under Cancelled (item and place)');
  ok(!s.notDone.some((x) => x.jobId === 'jC') && !s.rows.some((x) => x.jobId === 'jC'), 'and not under Not done');
  ok(/\*Cancelled\*\n- item jC - Carrier/.test(DL.toWhatsApp(s)), 'the WhatsApp summary has the Cancelled line');
  ok(res.key === '2026-11-25', 'the day closed');
}

console.log('K2. cancel J9 from the A card before its pickup');
{
  const jobs = jobsT1(), plan = planOf(jobs), w = dayOf(jobs, plan);
  const r = cancel({ jobs, plan, loose: [] }, ['J9'], w.d);
  eq(cardJobs(r.plan, 'A'), ['jA'], 'J9 leaves the A card; A stays with its own job');
  eq(cardJobs(r.plan, 'E'), ['jE'], 'J9 leaves the E card; E stays with its own job');
  eq(r.loose, [], 'nothing was collected: nothing goes to With you');
}

console.log('K3. DONE at A (J9 collected), then cancel J9 from the E card');
{
  const jobs = jobsT1(), plan = planOf(jobs), w = dayOf(jobs, plan);
  now = T0 + 70 * 60000;
  const j9 = jobs.find((j) => j.id === 'J9'); j9.pickups[0].done = true; j9.pickups[0].doneAt = isoAt(70); // DONE at A
  jobs.find((j) => j.id === 'jA').status = 'done';
  stopOf(plan, 'A').status = 'done';
  now = T0 + 90 * 60000;
  const r = cancel({ jobs, plan, loose: [] }, ['J9'], w.d);
  eq(cardJobs(r.plan, 'E'), ['jE'], 'E stays with its own job');
  const wy = OnBoard.onBoard({ jobs: r.jobs, loose: r.loose, nameOf }, now);
  ok(wy.some((x) => x.kind === 'loose' && x.item === 'gearbox' && x.from === 'Asian Automotive'), 'J9\'s item is in With you (a loose item from Asian Automotive)', wy);
  ok(!wy.some((x) => x.jobId === 'J9'), 'and no longer as a delivery to E');
  const u = OnBoard.undoCancel({ jobs: r.jobs, plan: r.plan, loose: r.loose }, r.prev);
  eq(u.loose, [], 'Undo takes the loose item back');
}

console.log('K4. K1, then Undo');
{
  const jobs = jobsT1(), plan = planOf(jobs), w = dayOf(jobs, plan);
  const r = cancel({ jobs, plan, loose: [] }, ['jC'], w.d);
  const u = OnBoard.undoCancel({ jobs: r.jobs, plan: r.plan, loose: r.loose }, r.prev);
  DL.recordUndoCancel(w.d, { nowIso: new Date(now).toISOString(), jobId: 'jC' });
  ok(!!stopOf(u.plan, 'C'), 'C is back on the route');
  eq(u.plan.order, ['S', 'A', 'C', 'E'], 'in its place');
  ok(u.jobs.find((j) => j.id === 'jC').status === 'pending', 'the job is pending again');
  eq(DL.summarise(w.d, u.jobs, places).cancelled, [], 'nothing under Cancelled');
}

console.log('K5. "Skip for today" on C (unchanged)');
{
  const jobs = jobsT1(), plan = planOf(jobs), w = dayOf(jobs, plan);
  stopOf(plan, 'C').status = 'skipped'; // SKIP: actions stay pending
  endDay(w, jobs);
  ok((w.d.carried || []).some((c) => c.jobId === 'jC' && c.mode === 'keep'), 'C is in tomorrow\'s carry-forward', w.d.carried);
  ok(jobs.find((j) => j.id === 'jC').status === 'pending', 'still pending');
}

console.log('K6. K1, then PLAN');
{
  const jobs = jobsT1(), plan = planOf(jobs), w = dayOf(jobs, plan);
  const r = cancel({ jobs, plan, loose: [] }, ['jC'], w.d);
  const p2 = planOf(OnBoard.jobsForPlan(clone(r.jobs), r.plan));
  ok(p2.order.indexOf('C') < 0, 'C does not come back', p2.order);
  eq(p2.order, ['S', 'A', 'E'], 'PLAN orders what is left');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
