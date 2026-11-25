'use strict';
// First stop (Part A), "just collect" jobs (Part B) and the missed-window wording (Part C), on a mocked travel-time table.
// The clock is pinned (25 Nov 2026 09:00 Malaysia time). Run: TZ=Asia/Kuala_Lumpur node test/firststop.test.js
const Solver = require('../solver.js');
const JobEdit = require('../jobedit.js');
const OnBoard = require('../onboard.js');
const DL = require('../daylog.js');
const TT = require('../traveltimes.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const clone = (x) => JSON.parse(JSON.stringify(x));

const T0 = Date.UTC(2026, 10, 25, 1, 0); // 25 Nov 2026 09:00 MYT
const realNow = Date.now;
Date.now = () => T0; // pinned clock (the solver's 1.8 s deadline never fires on this small problem)
const DEP = new Date(T0).toISOString();

// ---------- the mocked travel-time table (minutes, symmetric) ----------
const MIN = {
  'H-O': 32, 'H-K': 46, 'H-A': 40, 'H-C': 42, 'H-E': 50, 'O-K': 68, 'O-A': 22, 'O-C': 25, 'O-E': 50, 'A-C': 11,
  'A-E': 60, 'A-K': 65, 'C-E': 61, 'C-K': 66, 'E-K': 11,
};
const mins = (a, b) => (a === b ? 0 : MIN[a + '-' + b] != null ? MIN[a + '-' + b] : MIN[b + '-' + a]);
const NAMES = { H: 'Home', O: 'Office', K: 'Pacific Klang Oil Seals', A: 'Asian Automotive', C: 'Carrier', E: 'Eastern Press' };
const places = {};
Object.keys(NAMES).forEach((id, i) => { places[id] = { id, name: NAMES[id], lat: 3 + i / 10, lng: 101 + i / 10, type: id === 'O' ? 'office' : 'other', dwellMin: 0, closedWindows: [] }; });
const nameOf = (id) => (places[Solver.baseId(id)] || {}).name || id;
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: id }, o);
const errand = (id, pid, o) => job(id, Object.assign({ errandPlaceId: pid, dwellMin: 0, notes: 'Errand ' + pid }, o));

// the matrix for an input: point 0 = start (Home), 1..k = the stop keys (a second visit = its place), k+1 = end (Home)
function input(jobs, o) {
  o = o || {};
  const inp = Object.assign({ start: places[o.from || 'H'], end: places.H, jobs, places, departAtISO: o.at || DEP, noDetour: false }, o.extra || {});
  const keys = [o.from || 'H'].concat(Solver.buildStops(jobs, places).stopIds.map(Solver.baseId), ['H']);
  inp.matrices = [{ departAt: inp.departAtISO, m: keys.map((a) => keys.map((b) => mins(a, b) * 60)) }];
  return inp;
}
const best = (inp) => { const r = Solver.solve(inp); if (r.error) throw new Error(r.error); return r.plans[0]; };
const driveMin = (plan, from) => { // driving only (every dwell is 0 here): the legs of the order, end included
  const seq = [from || 'H'].concat(plan.order.map(Solver.baseId), ['H']);
  let s = 0; for (let i = 1; i < seq.length; i++) s += mins(seq[i - 1], seq[i]); return s;
};

// ---------- the 25 Nov 2026 jobs ----------
const S1jobs = () => [
  errand('E1', 'O', { firstStop: true }),
  job('J1', { pickups: [{ placeId: 'K', item: 'Oil seals', done: false }] }),                       // just collect at Klang
  job('J2', { pickups: [{ placeId: 'O', item: 'Brackets', done: false }], deliveryPlaceId: 'A' }),   // collect O, deliver A
  job('J3', { inHandItem: 'Sensor', deliveryPlaceId: 'C' }),                                         // deliver-only C
  job('J4', { inHandItem: 'Gasket', deliveryPlaceId: 'E' }),                                         // deliver-only E
];

console.log('S1 the 25 Nov day');
const s1jobs = S1jobs();
const p1 = best(input(s1jobs));
eq(p1.order, ['O', 'A', 'C', 'E', 'K'], 'S1 visit order O, A, C, E, K (then Home)');
ok(p1.stops.length === 5, 'S1 five stops');
ok(p1.order.filter((k) => Solver.baseId(k) === 'O').length === 1, 'S1 exactly one Office visit');
ok(p1.stops[0].first === true && p1.stops.slice(1).every((s) => !s.first), 'S1 the FIRST mark is on stop 1 only');
// The brief asks for 182 min. The order it names drives 32+22+11+61+11+46 = 183 min on its own table, and no order of these
// five stops with the Office first drives less (checked below), so 182 cannot be met: the test asserts 183 (reported, not hidden).
ok(driveMin(p1) === 183, 'S1 driving = 183 min (the brief says 182; its own table gives 183)', driveMin(p1));
ok(Math.round((p1.endArrival - T0) / 60000) === 183, 'S1 end arrival 183 min after the start (every dwell 0)');
(function () {
  const rest = ['A', 'C', 'E', 'K'];
  let mn = Infinity;
  const perm = (pre, left) => { if (!left.length) { mn = Math.min(mn, driveMin({ order: ['O'].concat(pre) })); return; } left.forEach((x, i) => perm(pre.concat([x]), left.filter((_, k) => k !== i))); };
  perm([], rest);
  ok(mn === 183, 'S1 the shortest order with the Office first is 183 min (182 is not reachable)', mn);
})();
ok(p1.stops.find((s) => s.placeId === 'K').actions.every((a) => a.kind === 'pickup'), 'S1 Klang holds only the collection (no delivery stop for J1)');
(function () {
  const links = Solver.linksOf(Solver.buildStops(s1jobs, places));
  const pre = Solver.precedence(input(s1jobs)).before;
  ok(!links.some((l) => l.includes('K')) && Object.keys(pre).every((k) => !pre[k].includes('K')) && JSON.stringify(pre.K) === '["O"]',
    'S1 a just-collect job has no ordering rule against any other place (only the First stop before it)', { links, pre });
})();
// the same day without First stop: the minimum-time order starts at Klang (the 25 Nov problem) and drives 182 min, which is
// where the brief's 182 comes from; with the Office pinned first the best is 183
const p1n = best(input(S1jobs().map((j) => Object.assign(j, { firstStop: false }))));
ok(p1n.order[0] === 'K' && driveMin(p1n) === 182, 'S1 without First stop the solver starts at Klang (182 min): what First stop prevents', { order: p1n.order, min: driveMin(p1n) });

// After K is DONE (what markDone does: the pickup done, the collect-only job done, its loose item added)
(function () {
  const jobs = clone(s1jobs); let loose = [];
  const plan = clone(p1);
  const days = {};
  const key = DL.dateKey(T0);
  const day = DL.recordFor(days, key, 'Calvin');
  DL.recordPlan(day, { nowIso: DEP, start: places.H, departAtIso: DEP, jobs, places, stopOrder: plan.order });
  let t = T0;
  plan.stops.forEach((st) => {
    t += 30 * 60000;
    const iso = new Date(t).toISOString();
    st.actions.forEach((a) => {
      const j = jobs.find((x) => x.id === a.jobId);
      if (a.kind === 'pickup') {
        const p = j.pickups.find((q) => q.placeId === Solver.baseId(st.placeId) && !q.done); if (p) { p.done = true; p.doneAt = iso; }
        if (!j.deliveryPlaceId && !j.errandPlaceId && j.pickups.every((q) => q.done)) { j.status = 'done'; j.doneAt = iso; }
      } else { j.status = 'done'; j.doneAt = iso; }
      if (a.kind === 'pickup' && OnBoard.isCollectOnly(j) && j.status === 'done') loose = OnBoard.addForJob(loose, j, { nameOf, at: t });
    });
    st.status = 'done'; st.doneAt = iso;
    DL.recordDone(day, { nowIso: iso, stopId: st.placeId, actions: st.actions, places });
  });
  const j1 = jobs.find((x) => x.id === 'J1');
  ok(j1.status === 'done', 'S1 J1 is finished for the day after DONE at Klang');
  const bar = OnBoard.onBoard({ jobs, loose, nameOf }, t);
  ok(bar.some((r) => r.kind === 'loose' && r.item === 'Oil seals' && /Klang/.test(r.from)), "S1 J1's item is in With you (from Pacific Klang)", bar);
  const res = DL.endDay(days, { key, jobs, places, nowIso: new Date(t + 60000).toISOString() });
  ok(res.key === key, 'S1 End day closes the day');
  ok(!(day.carried || []).some((c) => c.jobId === 'J1'), "S1 J1 is not in tomorrow's carry-forward", day.carried);
  ok(OnBoard.onBoard({ jobs, loose, nameOf }, t + 120000).some((r) => r.kind === 'loose' && r.item === 'Oil seals'), 'S1 the item is still in the bar after End day');
  const sum = DL.summarise(day, jobs, places);
  ok((sum.collected || []).some((c) => c.jobId === 'J1' && /Klang/.test(c.place)), 'S1 the summary lists it as collected from Pacific Klang', sum.collected);
})();

console.log('S2 two visits to the Office');
const S2jobs = () => [
  errand('E1', 'O', { firstStop: true }),
  job('J2', { pickups: [{ placeId: 'O', item: 'Brackets', done: false }], deliveryPlaceId: 'A' }),
  job('J6', { pickups: [{ placeId: 'C', item: 'Compressor', done: false }], deliveryPlaceId: 'O' }),
];
const p2 = best(input(S2jobs()));
const s2a = p2.stops[0];
ok(s2a.placeId === 'O' && s2a.first === true, 'S2 stop 1 is the Office with the FIRST mark');
eq(s2a.actions.map((a) => a.jobId + ':' + a.kind).sort(), ['E1:errand', 'J2:pickup'], 'S2 stop 1 holds the errand and J2\'s pickup only');
const i2 = p2.stops.findIndex((s, i) => i > 0 && Solver.baseId(s.placeId) === 'O');
ok(i2 > 0 && p2.stops[i2].placeId === 'O' + Solver.VISIT2 && !p2.stops[i2].first, 'S2 a second Office card exists later (its own key, no FIRST)', p2.order);
eq(p2.stops[i2].actions.map((a) => a.jobId + ':' + a.kind), ['J6:deliver'], 'S2 the second Office card holds only J6\'s delivery');
ok(p2.order.indexOf('C') < i2, 'S2 Carrier comes before the second Office card');
ok(p2.order.indexOf('A') > 0, 'S2 Asian Automotive comes after stop 1');
ok(p2.stops[i2].visitOf === 'O', 'S2 the second card is a visit of the saved Office place');
(function () { // DONE on stop 1 acts on that card only
  const jobs = clone(S2jobs());
  s2a.actions.forEach((a) => { const j = jobs.find((x) => x.id === a.jobId); if (a.kind === 'pickup') j.pickups.forEach((p) => { if (p.placeId === 'O') p.done = true; }); else j.status = 'done'; });
  ok(jobs.find((x) => x.id === 'J6').status === 'pending', 'S2 DONE on stop 1 leaves J6 open');
  // the re-check after that DONE (the solver on what is left, from the Office): the delivery keeps its second-visit key
  const left = jobs.filter((j) => j.status === 'pending').map((j) => (j.id === 'J6' ? Object.assign({}, j, { visit2: 'O' }) : j));
  const r = best(input(left, { from: 'O' }));
  ok(r.order.indexOf('C') < r.order.indexOf('O#2') && r.order.length === 3, 'S2 the re-check keeps C before the second Office visit', r.order);
})();
// legs: the same-place pair is 0 s and never a request (the normal routing path: TravelTimes.planRoute)
(async function () {
  const inp = input(S2jobs());
  delete inp.matrices;
  const log = [];
  const pt = (key, pid) => ({ key, pid, lat: places[pid].lat, lng: places[pid].lng });
  const r = await TT.planRoute({
    Solver, input: inp, nowMs: T0, mem: TT.emptyMemory(), start: pt('__start__', 'H'), end: pt('__end__', 'H'),
    nodeOfStop: (k) => pt(k, Solver.baseId(k)),
    fetchLeg: async (a, b) => { log.push(a.key + '>' + b.key); return { seconds: mins(a.pid, b.pid) * 60, metres: 1000, typicalSeconds: mins(a.pid, b.pid) * 60 }; },
  });
  ok(!r.res.error, 'S2 planRoute plans the two-visit day');
  ok(!log.some((x) => x === 'O>O#2' || x === 'O#2>O'), 'S2 zero requests for the Office -> second Office pair', log);
  ok(log.includes('O>C'), 'S2 the first Office -> Carrier leg is a real request (only the reversed pickup pair is skipped)', log);
  const p = r.res.plans[0];
  ok(p.order[0] === 'O' && p.order.indexOf('C') < p.order.indexOf('O#2'), 'S2 planRoute keeps the Office first and C before the second visit', p.order);
})().then(rest).catch((e) => { failures++; console.log('  FAIL S2 planRoute threw ' + e.message); rest(); });

function rest() {
  console.log('S3 two visits, not the office');
  const p3 = best(input([errand('E5', 'A', { firstStop: true }), job('J5', { pickups: [{ placeId: 'K', item: 'Seal kit', done: false }], deliveryPlaceId: 'A' })]));
  eq(p3.order.map(Solver.baseId), ['A', 'K', 'A'], 'S3 order A, K, A (then Home)');
  ok(p3.order[2] === 'A#2' && p3.stops[0].first && !p3.stops[2].first, 'S3 the second A visit is its own card');

  console.log('S4 no First stop');
  const s4 = [job('J6', { pickups: [{ placeId: 'C', item: 'Compressor', done: false }], deliveryPlaceId: 'O' }), errand('E1', 'O')];
  const p4 = best(input(s4));
  ok(p4.order.filter((k) => Solver.baseId(k) === 'O').length === 1 && p4.order.indexOf('O') > p4.order.indexOf('C'), 'S4 one Office visit, after Carrier', p4.order);
  eq(p4.stops[p4.order.indexOf('O')].actions.map((a) => a.jobId).sort(), ['E1', 'J6'], 'S4 the Office visit holds both');
  eq(Solver.buildStops(s4, places).stopIds, ['C', 'O'], 'S4 stop keys are the plain place ids (as in the current build)');
  ok(p4.stops.every((s) => !s.first && !s.visitOf), 'S4 no FIRST mark, no second visit');

  console.log('S5 First stop beats urgent');
  const p5 = best(input([errand('E7', 'E', { firstStop: true }), job('J8', { inHandItem: 'Valve', deliveryPlaceId: 'C', urgent: true, urgentRank: 1 })]));
  eq(p5.order, ['E', 'C'], 'S5 E first, then the urgent C');

  console.log('S6 only one First stop');
  let jobs6 = [errand('E1', 'O'), job('J3', { inHandItem: 'Sensor', deliveryPlaceId: 'C' })];
  let r6 = JobEdit.setFirstStop(jobs6, 'E1', true);
  ok(r6.jobs[0].firstStop === true && !r6.movedFrom, 'S6 on for the Office errand (nothing moved)');
  jobs6 = r6.jobs;
  r6 = JobEdit.updateJob(jobs6, 'J3', Object.assign(JobEdit.formOf(jobs6[1]), { firstStop: true }));
  ok(r6.ok, 'S6 the edit form saves with First stop on');
  eq(r6.jobs.filter((j) => j.firstStop).map((j) => j.id), ['J3'], 'S6 only J3 has it');
  ok(r6.movedFrom && r6.movedFrom.id === 'E1', 'S6 it moved from the errand');
  eq(JobEdit.firstStopToast(r6.movedFrom, r6.job, nameOf), 'First stop moved from Office to Carrier', 'S6 the toast names both places');
  ok(r6.changedIds.includes('E1') && r6.changedIds.includes('J3'), 'S6 both entries are saved');
  const off = JobEdit.updateJob(r6.jobs, 'J3', Object.assign(JobEdit.formOf(r6.jobs[1]), { firstStop: false }));
  ok(off.ok && !off.jobs.some((j) => j.firstStop) && !off.movedFrom, 'S6 off again: no entry has it, no toast');
  ok(JobEdit.formOf(job('X', { inHandItem: 'a', deliveryPlaceId: 'C' })).firstStop === false, 'S6 the form default is off');

  console.log('S7 DONE at the Office, then the re-check');
  (function () {
    const jobs = clone(S1jobs());
    const plan = clone(p1);
    plan.stops[0].status = 'done'; plan.stops[0].doneAt = new Date(T0 + 40 * 60000).toISOString();
    jobs.find((x) => x.id === 'E1').status = 'done';
    jobs.find((x) => x.id === 'J2').pickups[0].done = true;
    let rt, err = null;
    try { rt = Solver.retime(plan, 0, plan.stops[0].doneAt); } catch (e) { err = e.message; }
    ok(!err, 'S7 the re-time after DONE runs without an error', err);
    eq(rt.stops.filter((s) => !s.status).map((s) => s.placeId), ['A', 'C', 'E', 'K'], 'S7 the remaining order is A, C, E, K');
    const left = jobs.filter((j) => j.status === 'pending');
    const r = best(input(left, { from: 'O', at: plan.stops[0].doneAt }));
    eq(r.order, ['A', 'C', 'E', 'K'], 'S7 the re-solve from the Office keeps A, C, E, K');
    // the live look-ahead's solver (TravelTimes.solverAdapter) on the same pending stops
    const base = { start: places.O, end: places.H, jobs: left, places, departAtISO: plan.stops[0].doneAt, noDetour: false };
    const ad = TT.solverAdapter(Solver, base, null);
    const key = (k) => (k === TT.ORIGIN ? 'O' : k === TT.END ? 'H' : Solver.baseId(k));
    const got = ad.solve((a, b) => mins(key(a), key(b)) * 60);
    eq(got[0] && got[0].order, ['A', 'C', 'E', 'K'], 'S7 the look-ahead solve agrees');
  })();
  (function () { // while the First stop visit is not done it stays first among the remaining stops (a running-day PLAN)
    const r = best(input(S1jobs(), { from: 'K' })); // start somewhere else entirely (at Klang)
    ok(r.order[0] === 'O', 'S7 a PLAN on a running day keeps the First stop first while it is not done', r.order);
  })();

  console.log('S8 End day clears First stop');
  (function () {
    const jobs = clone(S1jobs());
    const days = {}, key = DL.dateKey(T0), day = DL.recordFor(days, key, 'Calvin');
    DL.recordPlan(day, { nowIso: DEP, start: places.H, departAtIso: DEP, jobs, places, stopOrder: p1.order });
    DL.recordDone(day, { nowIso: new Date(T0 + 3600e3).toISOString(), stopId: 'A', actions: [{ jobId: 'J2', kind: 'deliver', item: 'Brackets' }], places });
    jobs.find((x) => x.id === 'J2').status = 'done';
    const res = DL.endDay(days, { key, jobs, places, nowIso: new Date(T0 + 7200e3).toISOString() });
    ok(res.key === key, 'S8 the day closes');
    ok(!jobs.some((j) => j.firstStop), 'S8 no entry has First stop on');
    ok(res.changed.some((j) => j.id === 'E1'), 'S8 the cleared errand is saved');
    ok((day.carried || []).some((c) => c.jobId === 'E1' && c.mode !== 'dropped') ? !jobs.find((j) => j.id === 'E1').firstStop : true, 'S8 the carried errand rolls over without it');
  })();

  console.log('Part C wording');
  (function () {
    const late = best(input([errand('E1', 'O'), job('J6', { pickups: [{ placeId: 'C', item: 'Compressor', done: false }], deliveryPlaceId: 'O', arriveBefore: '09:40' })]));
    const v = late.violations.join(' | ');
    ok(/^Office arrives \d\d:\d\d, must be before 09:40 — it has to come after Carrier \(Compressor is collected there\)$/.test(late.violations[0] || ''), 'C2 the collect-before-deliver reason', late.violations);
    ok(!/job |j_|J6/.test(v), 'C1 no job id in the text', v);
    const late2 = best(input([job('J4', { inHandItem: 'Gasket', deliveryPlaceId: 'E', arriveBefore: '09:30' })]));
    eq(late2.violations, ['Arrive-before missed at Eastern Press: arrives 09:50, must be before 09:30 (Gasket to Eastern Press)'], 'C1 item and place instead of the job id');
    const rt = Solver.retime(late, -1, DEP); // the re-time path (markLate) words it the same way
    ok(rt.violations.length === 1 && /it has to come after Carrier/.test(rt.violations[0]) && !/job /.test(rt.violations[0]), 'C2 the re-time keeps the wording', rt.violations);
  })();

  console.log('A8 / B5 data');
  (function () {
    const old = job('Q', { inHandItem: 'x', deliveryPlaceId: 'O' });
    ok(Solver.firstStopPlace(old) === null, 'A8 old data without the field = off');
    ok(Solver.firstStopPlace(Object.assign({}, old, { firstStop: true })) === 'O', 'A1 a deliver-only job pins its delivery');
    ok(Solver.firstStopPlace(job('R', { firstStop: true, pickups: [{ placeId: 'C', done: true }, { placeId: 'K', done: false }], deliveryPlaceId: 'A' })) === null, 'A5 a first pickup already collected = no further effect');
    const office = [job('J9', { pickups: [{ placeId: 'C', item: 'Coil', done: false }], deliveryPlaceId: 'O' })];
    eq(Solver.buildStops(office, places).stopIds, ['C', 'O'], 'B5 a delivery to the Office is unchanged (one stop, after its pickup)');
  })();

  Date.now = realNow;
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}
