'use strict';
// 25 Nov 2026: a delivery is never completed before its item is collected (Part A), the collected time (Part B), a job deleted
// on the Plan tab while the day runs (Part C) and the one-time repair of the 25 Nov record (Part D).
// The clock is pinned (25 Nov 2026, 08:00 Malaysia time, moved by hand). Run: TZ=Asia/Kuala_Lumpur node test/collected.test.js
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
const isoAt = (min) => new Date(T0 + min * 60000).toISOString();
const DEP = isoAt(0);

const NAMES = { O: 'Office (L-Tech)', H: 'Home', P: 'Pacific Klang Oil Seals Sdn Bhd', A: 'Asian Automotive' };
const places = {};
Object.keys(NAMES).forEach((id, i) => { places[id] = { id, name: NAMES[id], lat: 3 + i / 10, lng: 101 + i / 10, type: id === 'O' ? 'office' : id === 'H' ? 'home' : 'supplier', dwellMin: 10, closedWindows: [] }; });
const nameOf = (id) => ((places[id] || {}).name || id).replace(/\s+Sdn\.?\s*Bhd\.?$/i, ''); // the app's dName rule
const MIN = { 'O-P': 35, 'O-A': 20, 'P-A': 30, 'H-O': 30, 'H-P': 50, 'H-A': 40 };
const mins = (a, b) => (a === b ? 0 : MIN[a + '-' + b] != null ? MIN[a + '-' + b] : MIN[b + '-' + a]);
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, errandPlaceId: null, inHandItem: '', notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: id }, o);

// the Office card of the brief: errand E, in-hand H, delivery D (collected at P, not yet)
const jobsOf = () => [
  job('E', { errandPlaceId: 'O', notes: 'Sign forms' }),
  job('H', { deliveryPlaceId: 'O', inHandItem: 'Spare fuse' }),
  job('D', { pickups: [{ placeId: 'P', item: 'Whole sample set with mech seal', done: false }], deliveryPlaceId: 'O' }),
];
function planOf(jobs, start) {
  const inp = { start: places[start], end: places.H, jobs, places, departAtISO: new Date(now).toISOString(), noDetour: false };
  const keys = [start].concat(Solver.buildStops(jobs, places).stopIds, ['H']);
  inp.matrices = [{ departAt: inp.departAtISO, m: keys.map((a) => keys.map((b) => mins(a, b) * 60)) }];
  return Solver.solve(inp).plans[0];
}
// DONE exactly as app.js markDone does it: OnBoard.doneSplit, then the applied actions only, then the day log
function doneAt(state, stop) {
  const nowIso = new Date(now).toISOString();
  const split = OnBoard.doneSplit(stop, state.jobs, nameOf);
  if (split.held.length && !split.apply.length) return { split, completed: false };
  split.apply.forEach((a) => {
    const j = state.jobs.find((x) => x.id === a.jobId);
    if (!j) return;
    if (a.kind === 'pickup') {
      const p = (j.pickups || []).find((q) => q.placeId === stop.placeId && !q.done);
      if (p) { p.done = true; p.doneAt = nowIso; }
      if (!j.deliveryPlaceId && !j.errandPlaceId && j.pickups.every((q) => q.done)) { j.status = 'done'; j.doneAt = nowIso; }
    } else { j.status = 'done'; j.doneAt = nowIso; }
  });
  if (split.held.length) { stop.leftOpen = split.held; stop.actions = split.apply; }
  stop.status = 'done'; stop.doneAt = nowIso;
  DL.recordDone(state.day, { nowIso, stopId: stop.placeId, actions: stop.actions, places });
  return { split, completed: true };
}
function world() {
  const jobs = jobsOf();
  const plan = planOf(jobs, 'A');
  const days = {};
  const day = DL.recordFor(days, '2026-11-25', 'Calvin');
  DL.recordPlan(day, { nowIso: DEP, departAtIso: DEP, start: places.A, jobs, places, stopOrder: plan.order });
  return { jobs, plan, days, day };
}
const stopOf = (plan, pid) => plan.stops.find((s) => s.placeId === pid && !s.status);
const rowOf = (s, id) => s.rows.find((r) => r.jobId === id);

console.log('Part A: the Office card completed before D was collected');
{
  const w = world();
  ok(w.plan.order.indexOf('P') < w.plan.order.indexOf('O'), 'the plan itself has P before Office (collect before deliver)', w.plan.order);
  const office = stopOf(w.plan, 'O');
  eq(office.actions.map((a) => a.jobId + ':' + a.kind).sort(), ['D:deliver', 'E:errand', 'H:deliver'], 'the Office card holds E, H and D');
  now = T0 + 181 * 60000; // 11:01, driven to the Office first
  const r = doneAt(w, office);
  const J = (id) => w.jobs.find((j) => j.id === id);
  ok(r.completed && J('E').status === 'done' && J('E').doneAt, 'A1: errand E done');
  ok(J('H').status === 'done' && J('H').doneAt, 'A1/A4: in-hand H done');
  ok(J('D').status === 'pending' && !J('D').doneAt && !J('D').pickups[0].done, 'A1: D stays open, no done time, its pickup untouched', J('D'));
  eq(office.leftOpen.map((a) => a.jobId), ['D'], 'the card keeps D aside (Undo of the DONE puts it back)');
  ok(r.split.notice === 'Whole sample set with mech seal (Pacific Klang Oil Seals) — not collected yet, left open. Tap PLAN to schedule it.', 'A2: the notice names the item and the place', r.split.notice);
  const s = DL.summarise(w.day, w.jobs, places);
  ok(rowOf(s, 'D') && !rowOf(s, 'D').complete && rowOf(s, 'D').doneMs == null, 'day log: D is not done, no done time', rowOf(s, 'D'));
  ok(rowOf(s, 'E').complete && rowOf(s, 'H').complete, 'day log: E and H done');
  ok(!s.delivered.some((d) => d.jobId === 'D'), 'D is not listed as delivered');

  // PLAN on the running day: D's pickup at P comes before a later Office stop
  now = T0 + 190 * 60000;
  const pending = OnBoard.jobsForPlan(w.jobs.filter((j) => j.status === 'pending'), w.plan);
  eq(pending.map((j) => j.id), ['D'], 'PLAN re-solves D only (E, H are done)');
  const p2 = planOf(pending, 'O');
  ok(p2.order.indexOf('P') >= 0 && p2.order.indexOf('O') > p2.order.indexOf('P'), 'PLAN: P, then a later Office stop', p2.order);
  // collect at P, then complete the Office again: D done
  now = T0 + 230 * 60000;
  const rp = doneAt(w, stopOf(p2, 'P'));
  ok(rp.completed && !rp.split.notice && w.jobs.find((j) => j.id === 'D').pickups[0].done, 'collected at P');
  now = T0 + 270 * 60000;
  const ro = doneAt(w, stopOf(p2, 'O'));
  ok(ro.completed && !ro.split.held.length && J('D').status === 'done' && J('D').doneAt === isoAt(270), 'the later Office DONE delivers D', J('D'));
  const s2 = DL.summarise(w.day, w.jobs, places);
  ok(rowOf(s2, 'D').complete && rowOf(s2, 'D').doneMs === T0 + 270 * 60000 && rowOf(s2, 'D').collectedMs === T0 + 230 * 60000, 'day log: D done 12:30, collected 11:50', rowOf(s2, 'D'));
  ok(s2.jobsDone === 3 && s2.jobsTotal === 3, 'all three jobs done');
}

console.log('A3: a card whose only jobs are uncollected deliveries');
{
  const jobs = [job('D', { pickups: [{ placeId: 'P', item: 'Seal kit', done: false }], deliveryPlaceId: 'O' }), job('D2', { pickups: [{ placeId: 'A', item: 'Gasket', done: false }], deliveryPlaceId: 'O' })];
  const stop = { placeId: 'O', actions: [{ jobId: 'D', kind: 'deliver', item: 'Seal kit' }, { jobId: 'D2', kind: 'deliver', item: 'Gasket' }] };
  const before = clone(stop);
  const sp = OnBoard.doneSplit(stop, jobs, nameOf);
  ok(!sp.apply.length && sp.held.length === 2, 'DONE completes nothing');
  ok(sp.notice === 'Seal kit (Pacific Klang Oil Seals) — not collected yet, left open. Gasket (Asian Automotive) — not collected yet, left open. Tap PLAN to schedule it.', 'the same notice, one line per item', sp.notice);
  eq(stop, before, 'the stop stays as it is');
  // the auto-Reached rule for such a stop is unchanged (reached.js: not a candidate)
  const Reached = require('../reached.js');
  const J = {}; jobs.forEach((j) => { J[j.id] = j; });
  ok(!Reached.canAutoReach({ id: 'O', actions: stop.actions }, J), 'such a stop is still never auto-Reached');
}

console.log('A4: in-hand, errands, just-collect, already collected');
{
  const jobs = [
    job('IH', { deliveryPlaceId: 'O', inHandItem: 'Fuse' }),
    job('ER', { errandPlaceId: 'O', notes: 'Bank' }),
    job('JC', { pickups: [{ placeId: 'O', item: 'Cable', done: false }] }),
    job('DC', { pickups: [{ placeId: 'P', item: 'Pump', done: true }], deliveryPlaceId: 'O' }),
    job('SAME', { pickups: [{ placeId: 'O', item: 'Box', done: false }], deliveryPlaceId: 'O' }),
  ];
  const acts = [{ jobId: 'IH', kind: 'deliver' }, { jobId: 'ER', kind: 'errand' }, { jobId: 'JC', kind: 'pickup', item: 'Cable' }, { jobId: 'DC', kind: 'deliver' },
    { jobId: 'SAME', kind: 'pickup', item: 'Box' }, { jobId: 'SAME', kind: 'deliver' }];
  const sp = OnBoard.doneSplit({ placeId: 'O', actions: acts }, jobs, nameOf);
  ok(sp.apply.length === acts.length && !sp.held.length && sp.notice === null, 'every action completes, no notice', sp);
  const sp2 = OnBoard.doneSplit({ placeId: 'O#2', actions: [{ jobId: 'DC', kind: 'deliver' }] }, jobs, nameOf);
  ok(sp2.apply.length === 1, 'a second visit (O#2) with a collected item completes');
}

console.log('Part B: the collected time');
{
  const w = world();
  now = T0 + 40 * 60000;
  doneAt(w, stopOf(w.plan, 'P')); // 08:40 collect D
  const ev = w.day.events.find((e) => e.type === 'done' && e.kind === 'pickup' && e.jobId === 'D');
  ok(ev && ev.collectedAt === isoAt(40), 'B1: the pickup stores its collected time on the day record', ev);
  now = T0 + 80 * 60000;
  doneAt(w, stopOf(w.plan, 'O')); // 09:20 deliver D, H, E
  // a just-collect job, and an old record's pickup without collectedAt
  w.jobs.push(job('JC', { pickups: [{ placeId: 'A', item: 'Cable', done: false }] }), job('OLD', { pickups: [{ placeId: 'A', item: 'Old part', done: false }] }));
  DL.recordPlan(w.day, { nowIso: isoAt(81), departAtIso: isoAt(81), start: places.O, jobs: w.jobs.slice(-2), places, stopOrder: ['A'] });
  now = T0 + 100 * 60000;
  DL.recordDone(w.day, { nowIso: isoAt(100), stopId: 'A', actions: [{ jobId: 'JC', kind: 'pickup', item: 'Cable' }], places });
  w.day.events.push({ t: isoAt(101), type: 'done', jobId: 'OLD', stopId: 'A', kind: 'pickup', item: 'Old part' }); // before this build
  const s = DL.summarise(w.day, w.jobs, places);
  ok(rowOf(s, 'D').collectedMs === T0 + 40 * 60000, 'delivery: collected 08:40');
  ok(rowOf(s, 'JC').collectedMs === T0 + 100 * 60000, 'just-collect: collected 09:40');
  ok(rowOf(s, 'H').collectedMs == null && rowOf(s, 'E').collectedMs == null && rowOf(s, 'OLD').collectedMs == null, 'blank: in hand, errand, an old record');
  const lines = DL.toCSV(s).trim().split('\r\n');
  ok(lines[0] === 'date,driver,type,item,from,to,collected time,done time,status,reason,urgent,late', 'B2: header with "collected time" before "done time"', lines[0]);
  const line = (id) => lines[1 + s.rows.findIndex((r) => r.jobId === id)];
  ok(line('D') === '25 Nov 2026,Calvin,delivery,Whole sample set with mech seal,Pacific Klang Oil Seals,Office (L-Tech),08:40,09:20,done,,no,no', 'B2: the delivery row', line('D'));
  ok(line('H') === '25 Nov 2026,Calvin,in-hand,Spare fuse,in hand,Office (L-Tech),,09:20,done,,no,no', 'B2: in hand = blank', line('H'));
  ok(line('E').split(',')[6] === '' && line('OLD').split(',')[6] === '' && line('JC').split(',')[6] === '09:40', 'B2: errand / old record blank, just-collect 09:40', [line('E'), line('OLD'), line('JC')]);
  const dd = s.delivered.find((d) => d.jobId === 'D'), dh = s.delivered.find((d) => d.jobId === 'H');
  ok(dd.from === 'Pacific Klang Oil Seals' && dd.collectedAt === T0 + 40 * 60000 && dh.collectedAt == null, 'B3: the delivered line knows its source and collected time (in hand: none)', [dd, dh]);
}

console.log('Part C: a job deleted on the Plan tab');
{
  // C2: the day is running (Office done), A2 collect job deleted on the Plan tab
  const w = world();
  w.jobs.push(job('K', { pickups: [{ placeId: 'A', item: 'Whole sample set', done: false }] }));
  DL.recordPlan(w.day, { nowIso: isoAt(5), departAtIso: isoAt(5), start: places.A, jobs: w.jobs, places, stopOrder: w.plan.order });
  now = T0 + 30 * 60000;
  doneAt(w, stopOf(w.plan, 'P'));
  const running = OnBoard.isDayRunning(w.plan, w.day);
  const K = w.jobs.find((j) => j.id === 'K');
  const c = OnBoard.cancelOnDelete({ job: K, plan: w.plan, day: w.day, running, nameOf });
  ok(running && c && c.jobId === 'K' && c.item === 'Whole sample set' && c.place === 'Asian Automotive', 'C2: a running day + a job in today\'s plan -> logged as cancelled', c);
  DL.recordCancel(w.day, { nowIso: isoAt(31), jobId: c.jobId, item: c.item, place: c.place, via: 'plan-delete' });
  w.jobs = w.jobs.filter((j) => j.id !== 'K'); // deleted
  const s = DL.summarise(w.day, w.jobs, places);
  ok(!rowOf(s, 'K') && !s.notDone.some((r) => r.jobId === 'K'), 'C2: not in the day\'s rows, never "not done"');
  ok(s.cancelled.some((x) => x.jobId === 'K'), 'C2: listed under Cancelled');
  const csvK = DL.toCSV(s).trim().split('\r\n').find((l) => l.indexOf('Whole sample set,') >= 0);
  ok(csvK && csvK.split(',')[8] === 'cancelled' && csvK.split(',')[9] === '' && csvK.split(',')[7] === '', 'C2: CSV status "cancelled", reason blank, no done time', csvK);
  ok(csvK.indexOf('carried') < 0, 'C2: never "carried"');
  // the same status string as Route -> Cancel job
  const w2 = world();
  const r = OnBoard.cancelJobs({ jobs: w2.jobs, plan: w2.plan, loose: [] }, ['E'], { nameOf, at: now });
  DL.recordCancel(w2.day, { nowIso: isoAt(31), jobId: 'E', item: r.cancelled[0].item, place: r.cancelled[0].place });
  const csvE = DL.toCSV(DL.summarise(w2.day, r.jobs, places)).trim().split('\r\n').find((l) => l.indexOf(',errand,') >= 0);
  ok(csvE && csvE.split(',')[8] === csvK.split(',')[8] && csvE.split(',')[9] === '', 'C2: same status string as Route -> Cancel job', csvE);
  // End day: nothing rolls to tomorrow
  const res = DL.endDay(w.days, { key: '2026-11-25', jobs: w.jobs, places, nowIso: isoAt(600) });
  ok(!w.day.carried.some((x) => x.jobId === 'K') && res.changed.every((j) => j.id !== 'K'), 'C2: End day does not carry it');

  // C3: no day running -> simply deleted, nothing logged
  const w3 = world();
  const J = w3.jobs.find((j) => j.id === 'D');
  ok(!OnBoard.isDayRunning(w3.plan, w3.day), 'C3: no stop done, no nav: the day is not running');
  ok(OnBoard.cancelOnDelete({ job: J, plan: w3.plan, day: w3.day, running: false, nameOf }) === null, 'C3: not running -> null (no log)');
  ok(OnBoard.cancelOnDelete({ job: J, plan: w3.plan, day: null, running: false, nameOf }) === null, 'C3: no day record -> null');
  // and a running day: a job not in today's plan, or one already done, is not logged either
  ok(OnBoard.cancelOnDelete({ job: job('NEW', { deliveryPlaceId: 'O', inHandItem: 'x' }), plan: w.plan, day: Object.assign(DL.newDay({ date: '2026-11-25' }), { jobsSnap: {} }), running: true, nameOf }) === null, 'a job added after the PLAN (not in today\'s plan) -> null');
  ok(OnBoard.cancelOnDelete({ job: Object.assign(job('E2', { errandPlaceId: 'O' }), { status: 'done' }), plan: w.plan, day: w.day, running: true, nameOf }) === null, 'a job already done -> null');
}

console.log('Part D: the one-time repair of the 25 Nov 2026 record');
function day25() {
  // the day as it happened: E, H and D on the Office card at 11:01 (old behaviour: D marked done), C deleted on Plan, "Closed" chip
  const jobs = jobsOf().concat([job('C', { pickups: [{ placeId: 'P', item: 'Whole sample set', done: false }] })]);
  const days = {};
  const d = DL.recordFor(days, '2026-11-25', 'Calvin');
  DL.recordPlan(d, { nowIso: DEP, departAtIso: DEP, start: places.A, jobs, places, stopOrder: ['O', 'P'] });
  d.legs[DL.legKey(places.A, places.O)] = { m: 15000, s: 1200 };
  DL.recordDone(d, { nowIso: '2026-11-25T03:01:00.000Z', stopId: 'O', actions: [{ jobId: 'E', kind: 'errand', item: 'Sign forms' }, { jobId: 'H', kind: 'deliver' }, { jobId: 'D', kind: 'deliver' }], places });
  d.decisions.C = { reason: 'Closed' };
  const other = DL.recordFor(days, '2026-11-24', 'Calvin');
  DL.recordPlan(other, { nowIso: '2026-11-24T00:00:00.000Z', departAtIso: '2026-11-24T00:00:00.000Z', start: places.A, jobs: [jobs[0]], places, stopOrder: ['O'] });
  const live = jobs.filter((j) => j.id !== 'C'); // C was deleted
  live.forEach((j) => { if (j.id !== 'D') { j.status = 'done'; j.doneAt = '2026-11-25T03:01:00.000Z'; } });
  live.find((j) => j.id === 'D').status = 'done'; live.find((j) => j.id === 'D').doneAt = '2026-11-25T03:01:00.000Z';
  return { days, d, other, jobs: live };
}
{
  const w = day25();
  const before = DL.summarise(w.d, w.jobs, places), csv0 = DL.toCSV(before);
  ok(csv0.indexOf('Whole sample set with mech seal,Pacific Klang Oil Seals,Office (L-Tech),,11:01,done') >= 0 && /Whole sample set,Pacific Klang Oil Seals,,,,not done - carried,Closed/.test(csv0), 'before: D done 11:01, C "not done - carried" / "Closed" (the export of 25 Nov)', csv0);
  const otherBefore = clone(w.other);
  const r = DL.repair25Nov(w.days, w.jobs, places, '2026-11-26T00:00:00.000Z');
  ok(r.changed && r.jobIds.join() === 'D,C', 'found: both records', r);
  const s = DL.summarise(w.d, w.jobs, places), lines = DL.toCSV(s).trim().split('\r\n');
  const lD = lines.find((l) => l.indexOf('Whole sample set with mech seal') >= 0), lC = lines.find((l) => l.indexOf('Whole sample set,') >= 0);
  ok(lD === '25 Nov 2026,Calvin,delivery,Whole sample set with mech seal,Pacific Klang Oil Seals,Office (L-Tech),,,cancelled,No longer needed,no,no', 'D: cancelled, done time cleared, "No longer needed"', lD);
  ok(lC === '25 Nov 2026,Calvin,collect,Whole sample set,Pacific Klang Oil Seals,,,,cancelled,No longer needed,no,no', 'C: cancelled, "No longer needed"', lC);
  ok(rowOf(s, 'E').complete && rowOf(s, 'H').complete && s.jobsTotal === 2 && s.jobsDone === 2, 'E and H still done 11:01');
  eq([s.km, s.hoursOutMin, s.startedAt, s.finishedAt, s.stopsVisited, s.visits], [before.km, before.hoursOutMin, before.startedAt, before.finishedAt, before.stopsVisited, before.visits], 'km, times and visits untouched');
  eq(w.other, otherBefore, 'no other record touched');
  ok(!s.delivered.some((x) => x.jobId === 'D') && s.cancelled.length === 2, 'D no longer delivered; both under Cancelled');
  const again = clone(w.days);
  ok(!DL.repair25Nov(w.days, w.jobs, places, '2026-11-27T00:00:00.000Z').changed, 'a second run changes nothing');
  eq(w.days, again, 'idempotent');
  const rh = DL.repairHistory(w.days, w.jobs, places);
  ok(!(rh.backfilled['2026-11-25'] || []).length, 'the general repair never backfills the cancelled delivery as done', rh);
}
{
  // not found: either record missing -> nothing changes, no throw
  const w1 = day25(); w1.d.decisions = {}; w1.d.jobsSnap.C.pickups[0].item = 'Another item';
  const b1 = clone(w1.days);
  ok(!DL.repair25Nov(w1.days, w1.jobs, places, '2026-11-26T00:00:00.000Z').changed, 'collect not found -> not changed');
  eq(w1.days, b1, 'collect not found -> nothing changed');
  const w2 = day25(); w2.d.events = w2.d.events.filter((e) => !(e.type === 'done' && e.jobId === 'D'));
  const b2 = clone(w2.days);
  ok(!DL.repair25Nov(w2.days, w2.jobs, places).changed, 'delivery not found (never done) -> not changed');
  eq(w2.days, b2, 'delivery not found -> nothing changed');
  const w3 = day25(); w3.days['2026-11-26'] = w3.days['2026-11-25']; delete w3.days['2026-11-25'];
  const b3 = clone(w3.days);
  ok(!DL.repair25Nov(w3.days, w3.jobs, places).changed, 'another date -> not changed');
  eq(w3.days, b3, 'another date -> nothing changed');
  ok(!DL.repair25Nov({}, [], {}).changed && !DL.repair25Nov(null, null, null).changed && !DL.repair25Nov({ '2026-11-25': { date: '2026-11-25' } }, [], {}).changed, 'empty / broken input -> not changed, no throw');
}
(async () => {
  // runRepairOnce: a device already at version 2 runs only the 25 Nov step, once, after a backup
  const mem = {};
  const store = {
    async get(c, k) { return mem[c + ':' + k] ? clone(mem[c + ':' + k]) : null; },
    async set(c, k, v) { mem[c + ':' + k] = clone(v); },
    async list(c) { return Object.keys(mem).filter((k) => k.indexOf(c + ':') === 0).map((k) => clone(mem[k])); },
    async remove(c, k) { delete mem[c + ':' + k]; },
  };
  const w = day25();
  Object.keys(w.days).forEach((k) => { mem['daylogs:' + k] = clone(w.days[k]); });
  mem['daylogs:2026-11-20'] = DL.newDay({ date: '2026-11-20' }); // empty: the general repair (v2) would remove it
  mem['meta:daylogRepair'] = { version: 2 };
  const res = await DL.runRepairOnce(store, w.jobs, places, '2026-11-26T00:00:00.000Z');
  ok(res && res.nov25.changed && mem['backup:daylogs-repair-3'] && mem['meta:daylogRepair'].version === 3, 'runRepairOnce: the 25 Nov step ran once, after a backup', res);
  ok(!!mem['daylogs:2026-11-20'], 'a device at version 2 does not re-run the general repair');
  const lC = DL.toCSV(DL.summarise(mem['daylogs:2026-11-25'], w.jobs, places)).split('\r\n').find((l) => l.indexOf('Whole sample set,') >= 0);
  ok(/,cancelled,No longer needed,/.test(lC), 'stored: the collect is cancelled', lC);
  ok((await DL.runRepairOnce(store, w.jobs, places, '2026-11-27T00:00:00.000Z')) === null, 'runs once (marker 3)');

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
