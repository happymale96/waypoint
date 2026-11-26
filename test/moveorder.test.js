'use strict';
// Part 6 (26 Nov 2026): ▲ / ▼ on Route stops. TravelTimes.moveStop (the swap, the fuel stop's place, the collect-before-deliver
// refusal), TravelTimes.missingOrderLegs (only the legs the new order lacks), the re-time through Solver.retime with the order
// kept, and Budget.afterStopMode({manual}) (after a manual move a DONE never re-orders). The clock is pinned (26 Nov 2026 09:00 MYT).
// Run: TZ=Asia/Kuala_Lumpur node test/moveorder.test.js
const Solver = require('../solver.js');
const TT = require('../traveltimes.js');
const Budget = require('../budget.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const clone = (x) => JSON.parse(JSON.stringify(x));

const T0 = Date.UTC(2026, 10, 26, 1, 0); // 26 Nov 2026 09:00 MYT
Date.now = () => T0; // pinned clock
const DEP = new Date(T0).toISOString();

// minute table (symmetric); O = Office (start), H = Home (end)
const MIN = { 'O-A': 20, 'O-B': 30, 'O-C': 40, 'O-D': 25, 'A-B': 10, 'A-C': 25, 'A-D': 15, 'B-C': 12, 'B-D': 18, 'C-D': 22, 'H-A': 35, 'H-B': 30, 'H-C': 20, 'H-D': 28, 'H-O': 32 };
const mins = (a, b) => (a === b ? 0 : MIN[a + '-' + b] != null ? MIN[a + '-' + b] : MIN[b + '-' + a]);
const NAMES = { O: 'Office', H: 'Home', A: 'Asian Automotive', B: 'Bukit Raja', C: 'Carrier', D: 'Delta Press' };
const places = {};
Object.keys(NAMES).forEach((id, i) => { places[id] = { id, name: NAMES[id], lat: 3 + i / 10, lng: 101 + i / 10, type: id === 'O' ? 'office' : id === 'H' ? 'home' : 'factory', dwellMin: 10, closedWindows: [] }; });
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, inHandItem: '', notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: id }, o);
// a collect at C delivered to D ("Compressor"), and in-hand deliveries at A and B
const JOBS = [
  job('jA', { inHandItem: 'Brackets', deliveryPlaceId: 'A' }),
  job('jB', { inHandItem: 'Sensor', deliveryPlaceId: 'B' }),
  job('jCD', { pickups: [{ placeId: 'C', item: 'Compressor', done: false }], deliveryPlaceId: 'D' }),
];
const jobsById = {}; JOBS.forEach((j) => { jobsById[j.id] = j; });
function solved() {
  const keys = ['O'].concat(Solver.buildStops(JOBS, places).stopIds, ['H']);
  const inp = { start: places.O, end: places.H, jobs: JOBS, places, departAtISO: DEP, noDetour: false, matrices: [{ departAt: DEP, m: keys.map((a) => keys.map((b) => mins(a, b) * 60)) }] };
  return { plan: Solver.solve(inp).plans[0], keys };
}
const ids = (stops) => stops.map((s) => s.placeId);
const minOf = (ms) => Math.round((ms - T0) / 60000);

console.log('M1. swap and re-time');
{
  const { plan } = solved();
  // force a known order: A, B, C, D (C before D: the collect-before-deliver rule holds)
  const order = ['A', 'B', 'C', 'D'];
  const p0 = Solver.retime(Object.assign({}, plan, { stops: order.map((id) => plan.stops.find((s) => s.placeId === id)), order }), -1, DEP);
  eq(ids(p0.stops), order, 'the starting order A, B, C, D');
  eq(p0.stops.map((s) => minOf(s.arriveAt)), [20, 40, 62, 94], 'its arrivals: 20, 40 (10 + 10 dwell), 62, 94 min');
  const r = TT.moveStop(p0.stops, 1, -1, jobsById); // ▲ on B
  ok(r && !r.refused, '▲ on B is allowed');
  eq(ids(r.stops), ['B', 'A', 'C', 'D'], '▲ on B swaps it with A');
  ok(r.a === 'B' && r.b === 'A', 'the moved stop and its neighbour are named');
  eq(ids(p0.stops), order, 'the input stops are not changed');
  const p1 = Solver.retime(Object.assign({}, p0, { stops: r.stops, order: ids(r.stops) }), -1, DEP);
  eq(ids(p1.stops), ['B', 'A', 'C', 'D'], 're-time keeps the new order (no re-solve)');
  eq(p1.stops.map((s) => minOf(s.arriveAt)), [30, 50, 85, 117], 're-timed: O-B 30, +10 dwell +10 B-A = 50, +10 +25 = 85, +10 +22 = 117');
  eq(minOf(p1.endArrival), 155, 'the end arrival follows (117 + 10 + D-H 28)');
  const r2 = TT.moveStop(p0.stops, 3, 1, jobsById);
  ok(r2 === null, '▼ on the last stop before the end point does nothing');
  ok(TT.moveStop(p0.stops, 0, -1, jobsById) === null, '▲ on the first pending stop does nothing');
  // done / skipped stops keep their place; the neighbour is the next PENDING stop
  const st = clone(p0.stops); st[0].status = 'done'; st[0].doneAt = DEP; st[2].status = 'skipped';
  ok(TT.moveStop(st, 1, -1, jobsById) === null, 'with A done, ▲ on B (now the first pending stop) does nothing');
  const r3 = TT.moveStop(st, 1, 1, jobsById);
  eq(ids(r3.stops), ['A', 'D', 'C', 'B'], '▼ on B jumps the skipped C and swaps with D; done A and skipped C stay where they are');
  ok(r3.stops[0].status === 'done' && r3.stops[2].status === 'skipped', 'states unchanged');
  ok(TT.moveStop(st, 0, 1, jobsById) === null && TT.moveStop(st, 2, 1, jobsById) === null, 'a done or skipped stop cannot be moved');
}

console.log('M2. a delivery never goes before the stop where its item is collected (6c)');
{
  const { plan } = solved();
  const order = ['A', 'C', 'D', 'B'];
  const st = order.map((id) => plan.stops.find((s) => s.placeId === id));
  const r = TT.moveStop(st, 2, -1, jobsById); // ▲ on D (delivery of the Compressor collected at C)
  ok(r && r.refused, '▲ on D over C is refused');
  ok(r.refused.item === 'Compressor' && r.refused.pickupId === 'C' && r.refused.deliverId === 'D', 'the refusal names the item and both stops', r.refused);
  const r2 = TT.moveStop(st, 1, 1, jobsById); // ▼ on C = the same swap
  ok(r2 && r2.refused && r2.refused.item === 'Compressor', '▼ on C past D is refused too');
  const done = clone(jobsById); done.jCD.pickups[0].done = true;
  const st2 = clone(st); st2[1].actions = []; // (a pickup done elsewhere earlier: no pending pickup action at C)
  ok(!TT.moveStop(st2, 2, -1, done).refused, 'an item already collected: the delivery may move freely');
  // First stop / urgent never block a manual move
  const fst = clone(st); fst[0].first = true; fst[0].actions.forEach((a) => { a.urgent = true; });
  const r3 = TT.moveStop(fst, 1, -1, jobsById);
  ok(r3 && !r3.refused && r3.stops[0].placeId === 'C' && r3.stops[1].first === true, 'a FIRST (and urgent) stop can be passed: his manual order wins');
}

console.log('M3. the fuel stop keeps its place (6b)');
{
  const S = (id) => ({ placeId: id, actions: [] });
  const F = { placeId: '__fuel__', fuel: true, actions: [] };
  const st = [S('A'), F, S('B'), S('C')];
  eq(ids(TT.moveStop(st, 2, -1, {}).stops), ['B', '__fuel__', 'A', 'C'], 'A, F, B: B ▲ -> B, F, A (still between the same two)');
  eq(ids(TT.moveStop(st, 0, 1, {}).stops), ['B', '__fuel__', 'A', 'C'], 'A ▼ -> the same');
  eq(ids(TT.moveStop(st, 3, -1, {}).stops), ['A', '__fuel__', 'C', 'B'], 'C ▲ (B and C swap): F stays right after A, the stop it followed');
  const st2 = [F, S('A'), S('B')];
  eq(ids(TT.moveStop(st2, 2, -1, {}).stops), ['__fuel__', 'B', 'A'], 'fuel first (nothing before it): it stays first');
  const st3 = [Object.assign(S('X'), { status: 'done' }), F, S('A'), S('B')];
  eq(ids(TT.moveStop(st3, 3, -1, {}).stops), ['X', '__fuel__', 'B', 'A'], 'fuel after a done stop: still right after it');
  const st4 = [S('A'), S('B'), F];
  eq(ids(TT.moveStop(st4, 1, -1, {}).stops), ['B', '__fuel__', 'A'], 'fuel last (B, then the end point): B moves up, F stays right after B, the stop it followed');
  ok(TT.moveStop([S('A'), F, S('B')], 1, 1, {}) === null, 'the fuel stop itself is never moved');
}

console.log('M4. only the missing legs are fetched (6d)');
{
  const { plan, keys } = solved();
  const order = ['A', 'B', 'C', 'D'];
  const p0 = Object.assign({}, clone(plan), { stops: order.map((id) => clone(plan.stops.find((s) => s.placeId === id))), order });
  eq(TT.missingOrderLegs(p0, -1), [], 'every leg in the table: nothing to fetch');
  const iB = keys.indexOf('B'), iA = keys.indexOf('A');
  p0.model.matrices[0].m[iB][iA] = null; // B -> A was never fetched
  const r = TT.moveStop(p0.stops, 1, -1, jobsById);
  const p1 = Object.assign({}, p0, { stops: r.stops });
  eq(TT.missingOrderLegs(p1, -1), [{ i: iB, j: iA }], 'after B ▲: only B -> A is missing');
  p0.model.matrices[0].est = p0.model.matrices[0].m.map((row) => row.map(() => false));
  p0.model.matrices[0].est[keys.indexOf('C')][keys.indexOf('D')] = true;
  eq(TT.missingOrderLegs(p1, -1).length, 2, 'an estimated cell on the route counts as missing too');
  const p2 = clone(p1); p2.stops[0].reachedAt = T0; p2.model.matrices[0].est[keys.indexOf('C')][keys.indexOf('D')] = false;
  eq(TT.missingOrderLegs(p2, -1), [{ i: iB, j: iA }], 'a reached stop needs no leg into it (the leg out of it still counts)');
  const p3 = clone(p2); delete p3.stops[0].reachedAt; p3.stops[0].status = 'done'; p3.stops[0].doneAt = DEP;
  eq(TT.missingOrderLegs(p3, 0), [{ i: iB, j: iA }], 'from the last done stop (B): B -> A');
}

console.log('M5. after a manual move a DONE leaves the order alone (6e)');
{
  ok(Budget.afterStopMode({ setting: 'auto', pending: 3 }) === 'lookahead', 'before a manual move: DONE with 3 pending looks ahead');
  ok(Budget.afterStopMode({ setting: 'auto', pending: 3, manual: true }) === 'single', 'after a manual move: only the single next-stop re-time (never a re-order)');
  ok(Budget.afterStopMode({ setting: 'ask', pending: 5, manual: true }) === 'single', 'the same with "Ask me" (no Switch card)');
  ok(Budget.afterStopMode({ setting: 'auto', pending: 3, manual: false }) === 'lookahead', 'a fresh PLAN clears it: the look-ahead is back');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
