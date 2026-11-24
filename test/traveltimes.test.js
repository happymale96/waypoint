'use strict';
// TomTom Routing API travel times (traveltimes.js): needed pairs, PLAN request counts, buckets, the median pair memory,
// typical-time samples, "my location" as a saved place, the route check (C3) and the ordering basis (D2).
// Every clock is pinned. Run as its own node script: node test/traveltimes.test.js
const TT = require('../traveltimes.js');
const Solver = require('../solver.js');
const Budget = require('../budget.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const MYT = (h, m) => Date.UTC(2026, 10, 24, h - 8, m || 0); // 24 Nov 2026, Malaysia time
const NOW = MYT(10, 0);

// ---------- a small world ----------
const P = {
  O: { lat: 3.100, lng: 101.600 }, A: { lat: 3.130, lng: 101.650 }, B: { lat: 3.160, lng: 101.700 }, C: { lat: 3.050, lng: 101.700 },
  D: { lat: 3.200, lng: 101.580 }, Fp: { lat: 3.020, lng: 101.560 }, F: { lat: 3.080, lng: 101.760 }, G: { lat: 3.180, lng: 101.760 },
  E: { lat: 3.076, lng: 101.661 },
};
const places = {};
Object.keys(P).forEach((id) => { places[id] = { id, name: id, lat: P[id].lat, lng: P[id].lng, type: 'other', dwellMin: 10, closedWindows: [] }; });
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: id }, o);
const errands = (ids) => ids.map((pid, i) => job('j' + i, { errandPlaceId: pid, dwellMin: 10 }));
const node = (key, pid) => ({ key, pid, lat: places[pid || key].lat, lng: places[pid || key].lng });

// the mock TomTom: travel time by straight line at 40 km/h x 1.3 (+1 min), every call logged with its departure
function mockTomTom(opts) {
  opts = opts || {};
  const log = [];
  const fetchLeg = async (a, b, at) => {
    log.push({ a: a.key, b: b.key, at });
    if (opts.fail && opts.fail(a, b)) { const e = new Error('TomTom: HTTP 400 — NO_ROUTE_FOUND'); throw e; }
    const km = Budget.distanceM(a, b) / 1000;
    const s = Math.round(km * 1.3 / 40 * 3600) + 60;
    return opts.answer ? opts.answer(a, b, at, s) : { seconds: s, metres: Math.round(km * 1300), typicalSeconds: s }; // computeTravelTimeFor=all: the historic time comes back
  };
  return { log, fetchLeg };
}
function plan(stopIds, mem, tt, at) {
  const input = { start: places.O, end: places.E, jobs: errands(stopIds), places, departAtISO: new Date(at || NOW).toISOString(), noDetour: false };
  return TT.planRoute({ Solver, input, nowMs: at || NOW, mem, fetchLeg: tt.fetchLeg, start: node('__start__', 'O'), end: node('__end__', 'E'), nodeOfStop: (pid) => node(pid, pid) });
}

(async () => {
  console.log('1. needed pairs: O start, A B C stops, E end, no links -> 12');
  {
    const pairs = TT.neededPairs(node('__start__', 'O'), ['A', 'B', 'C'].map((x) => node(x, x)), node('__end__', 'E'), []);
    const s = pairs.map(([a, b]) => a.key + '>' + b.key);
    ok(pairs.length === 12, '12 pairs', s);
    ok(['__start__>A', '__start__>B', '__start__>C', 'A>B', 'B>A', 'A>C', 'C>A', 'B>C', 'C>B', 'A>__end__', 'B>__end__', 'C>__end__'].every((k) => s.includes(k)), 'O->A, O->B, O->C, A<->B, A<->C, B<->C, A->E, B->E, C->E');
    ok(!s.some((k) => k.endsWith('>__start__') || k.startsWith('__end__>') || k === '__start__>__end__'), 'nothing TO the start, nothing FROM the end, no start -> end with stops');
    ok(TT.neededPairs(node('__start__', 'O'), [], node('__end__', 'E'), []).length === 1, 'no stop: only start -> end');
  }

  console.log('2. PLAN 6 stops A..F, nothing learned, at 10:00 -> 42 table + 7 check = 49; again the same hour -> 0 + 7');
  const mem = TT.emptyMemory();
  {
    const tt = mockTomTom();
    const r = await plan(['A', 'B', 'C', 'D', 'Fp', 'F'], mem, tt);
    ok(!r.res.error && r.res.plans[0].order.length === 6, 'a 6-stop route', r.res.error);
    ok(r.tableRequests === 42 && r.checkRequests === 7 && r.requests === 49 && tt.log.length === 49, 'table 42 (6 + 30 + 6), check 7, total 49', { t: r.tableRequests, c: r.checkRequests, log: tt.log.length });
    ok(!r.live && r.bucket === 'day' && r.solves === 1 && r.checks === 1, 'table mode, Day bucket, one solve, one check pass', r);
    const tt2 = mockTomTom();
    const r2 = await plan(['A', 'B', 'C', 'D', 'Fp', 'F'], mem, tt2, NOW + 20 * 60000);
    ok(r2.tableRequests === 0 && r2.checkRequests === 7 && tt2.log.length === 7, 'same plan again (10:20): 0 table + 7 check', { t: r2.tableRequests, c: r2.checkRequests });
    const legs = tt2.log.map((x) => x.at);
    ok(legs[0] === NOW + 20 * 60000 && legs.slice(1).every((t, i) => t > legs[0]), 'the check legs depart at their planned departures (first = the plan start, later ones later)', legs.map((t) => new Date(t).toISOString().slice(11, 16)));
    const ev = r2.res.plans[0];
    const ids = r2.stopIds, seq = [0].concat(ev.order.map((p) => ids.indexOf(p) + 1), [ids.length + 1]);
    const est = ev.model.matrices[0].est;
    ok(seq.slice(0, -1).every((a, n) => est[a][seq[n + 1]] === false), 'every leg of the chosen order is a real (checked) time: no "est."');
    ok(est[1][0] === true && est[ids.length + 1][1] === true, 'pairs the ordering never uses (to the start, from the end) are only estimates');
  }

  console.log('3. PLAN 3 stops (5 or fewer): live table, 12 requests, no check; again: 12 again');
  {
    const m3 = TT.emptyMemory();
    const tt = mockTomTom();
    const r = await plan(['A', 'B', 'C'], m3, tt);
    ok(r.live && r.tableRequests === 12 && r.checkRequests === 0 && tt.log.length === 12, '12 live requests, 0 check', { t: r.tableRequests, c: r.checkRequests });
    ok(tt.log.every((x) => x.at === NOW), 'every live request departs now');
    const tt2 = mockTomTom();
    const r2 = await plan(['A', 'B', 'C'], m3, tt2);
    ok(r2.tableRequests === 12 && tt2.log.length === 12, 'same plan again: 12 (live every time)', r2.tableRequests);
  }

  console.log('4. the 6-stop plan + stop G: table fetches only O->G, G->E, G<->each of the 6 (14) + 8 check');
  {
    const tt = mockTomTom();
    const r = await plan(['A', 'B', 'C', 'D', 'Fp', 'F', 'G'], mem, tt, NOW + 30 * 60000);
    const tableCalls = tt.log.slice(0, r.tableRequests).map((x) => x.a + '>' + x.b);
    ok(r.tableRequests === 14 && tableCalls.every((k) => k.includes('G')), '14 table requests, all involving G', tableCalls);
    ok(r.checkRequests === 8, '8 check requests', r.checkRequests);
  }

  console.log('5. buckets (Malaysia time)');
  ok(TT.bucketOf(MYT(6, 29)) === 'night' && TT.bucketOf(MYT(6, 30)) === 'am' && TT.bucketOf(MYT(9, 30)) === 'day' && TT.bucketOf(MYT(16, 30)) === 'pm' && TT.bucketOf(MYT(20, 0)) === 'night',
    '06:29 Night, 06:30 AM peak, 09:30 Day, 16:30 PM peak, 20:00 Night', [MYT(6, 29), MYT(6, 30), MYT(9, 30), MYT(16, 30), MYT(20, 0)].map(TT.bucketOf));
  ok(TT.bucketOf(MYT(9, 29)) === 'am' && TT.bucketOf(MYT(16, 29)) === 'day' && TT.bucketOf(MYT(19, 59)) === 'pm', 'one minute before each boundary stays in the earlier bucket');

  console.log('6. a leg checked with a 17:10 departure becomes a PM peak sample');
  {
    const m6 = TT.emptyMemory();
    const tt = mockTomTom();
    await TT.checkLegs([{ a: node('A', 'A'), b: node('B', 'B'), at: MYT(17, 10) }], tt.fetchLeg, m6, NOW);
    ok(Object.keys(m6.pairs).join() === 'A>B@pm', 'stored under A>B@pm', Object.keys(m6.pairs));
  }

  console.log('7. the median memory');
  {
    const m7 = TT.emptyMemory();
    [20, 21, 60, 22, 20].forEach((x) => TT.addSample(m7, 'A', 'B', 'day', { s: x * 60, m: x * 1000 }));
    ok(TT.learned(m7, 'A', 'B', 'day').s === 21 * 60, 'samples 20, 21, 60, 22, 20 -> 21');
    TT.addSample(m7, 'A', 'B', 'day', { s: 23 * 60, m: 23000 });
    ok(m7.pairs['A>B@day'].map((x) => x.s / 60).join() === '21,60,22,20,23' && TT.learned(m7, 'A', 'B', 'day').s === 22 * 60, 'a 6th sample (23) drops the oldest (20): 21, 60, 22, 20, 23 -> 22', m7.pairs['A>B@day'].map((x) => x.s / 60));
    ok(TT.learned(m7, 'A', 'B', 'day').m === 22000, 'the metres of the median sample');
    const m7b = TT.emptyMemory();
    TT.addSample(m7b, 'A', 'B', 'day', { s: 3600 });
    ok(TT.learned(m7b, 'A', 'B', 'day').s === 3600, 'a single sample of 60 -> 60');
    TT.addSample(m7b, 'A', 'B', 'day', { s: 1200 }); TT.addSample(m7b, 'A', 'B', 'day', { s: 1260 });
    ok(TT.learned(m7b, 'A', 'B', 'day').s === 1260, 'after 20 and 21 -> 21');
    ok(TT.pairCount(m7) === 1, 'Settings counts 1 learned pair');
  }

  console.log('8. a pair learned only in "Day", needed for "PM peak": the Day median, 0 requests');
  {
    const m8 = TT.emptyMemory();
    TT.addSample(m8, 'A', 'B', 'day', { s: 900, m: 9000 });
    const l = TT.learned(m8, 'A', 'B', 'pm');
    ok(l && l.s === 900 && l.bucket === 'day' && !l.exact, 'learned() falls back to the Day median', l);
    const tt = mockTomTom();
    const t = await TT.buildTable({ start: node('A', 'A'), stops: [node('B', 'B')], end: node('B', 'B'), links: [], mem: m8, bucket: 'pm', planMs: MYT(17, 0), nowMs: NOW, live: false, fetchLeg: tt.fetchLeg });
    ok(tt.log.length === 0 && t.m[0][1] === 900 && !t.estimated, '0 requests, the table holds 900 s', { calls: tt.log.length, v: t.m[0][1] });
  }

  console.log('9. typicalSeconds 1200, returned 3000: the sample is 1200, today uses 3000');
  {
    const m9 = TT.emptyMemory();
    const tt = mockTomTom({ answer: () => ({ seconds: 3000, metres: 20000, typicalSeconds: 1200 }) });
    const t = await TT.buildTable({ start: node('A', 'A'), stops: [node('B', 'B')], end: node('E', 'E'), links: [], mem: m9, bucket: 'day', nowMs: NOW, live: true, fetchLeg: tt.fetchLeg });
    ok(t.m[0][1] === 3000, 'the table (decision / ETA) uses 3000', t.m[0][1]);
    ok(m9.pairs['A>B@day'][0].s === 1200, 'the stored sample is 1200', m9.pairs['A>B@day']);
  }

  console.log('10. "My location" 80 m from O is O; 400 m away it is fetched and not stored');
  {
    const near = { lat: P.O.lat + 80 / 111320, lng: P.O.lng }, far = { lat: P.O.lat + 400 / 111320, lng: P.O.lng };
    const list = Object.values(places);
    ok(TT.snap(near, list) === 'O' && TT.snap(far, list) === null, 'snap: 80 m -> O, 400 m -> none');
    const m10 = TT.emptyMemory();
    TT.addSample(m10, 'O', 'A', 'day', { s: 700, m: 7000 }); TT.addSample(m10, 'A', 'E', 'day', { s: 800, m: 8000 });
    const run = async (pt) => { const tt = mockTomTom(); const t = await TT.buildTable({ start: { key: '__start__', pid: TT.snap(pt, list), lat: pt.lat, lng: pt.lng }, stops: [node('A', 'A')], end: node('__end__', 'E'), links: [], mem: m10, bucket: 'day', planMs: NOW, nowMs: NOW, live: false, fetchLeg: tt.fetchLeg }); return { tt, t }; };
    const a = await run(near);
    ok(a.tt.log.length === 0 && a.t.m[0][1] === 700, '80 m: the learned O->A, 0 requests');
    const before = JSON.stringify(m10.pairs);
    const b = await run(far);
    ok(b.tt.log.length === 1 && b.tt.log[0].a === '__start__' && JSON.stringify(m10.pairs) === before, '400 m: fetched (1 request), nothing stored');
  }

  console.log('11. job pickup P -> delivery Q: Q -> P is never fetched');
  {
    const tt = mockTomTom();
    const pk = node('A', 'A'), dl = node('B', 'B');
    const t = await TT.buildTable({ start: node('__start__', 'O'), stops: [pk, dl, node('C', 'C')], end: node('__end__', 'E'), links: [['A', 'B']], mem: TT.emptyMemory(), bucket: 'day', nowMs: NOW, live: true, fetchLeg: tt.fetchLeg });
    const calls = tt.log.map((x) => x.a + '>' + x.b);
    ok(!calls.includes('B>A') && calls.includes('A>B') && calls.length === 11, 'B->A not fetched (11 requests, not 12)', calls);
    ok(t.est[2][1] === true, 'the unused pair is only an estimate');
  }

  console.log('12. the route check (C3)');
  {
    // 0 start, 1 and 2 stops, 3 end. solve: visit the nearer stop first.
    const table0 = [[0, 600, 900, 0], [0, 0, 300, 600], [0, 300, 0, 600], [0, 0, 0, 0]];
    const solve = (t) => { const ord = t[0][1] <= t[0][2] ? [1, 2] : [2, 1]; return { order: ord, legs: [{ i: 0, j: ord[0], at: 0 }, { i: ord[0], j: ord[1], at: 0 }, { i: ord[1], j: 3, at: 0 }] }; };
    const checker = (f) => async (legs) => ({ values: legs.map((l) => ({ s: Math.round(table0[l.i][l.j] * f(l)) })), down: null });
    let n = 0;
    const counted = (s) => (t) => { n++; return s(t); };
    n = 0; let r = await TT.twoStep({ table: table0, solve: counted(solve), check: checker(() => 1.2) });
    ok(r.solves === 2 && n === 2 && r.checks === 1, 'checked total 20% above: exactly one re-solve (order unchanged: no second check)', { solves: r.solves, checks: r.checks });
    n = 0; r = await TT.twoStep({ table: table0, solve: counted(solve), check: checker(() => 1.1) });
    ok(r.solves === 1 && n === 1 && r.checks === 1, '10% above: no re-solve', { solves: r.solves });
    n = 0; r = await TT.twoStep({ table: table0, solve: counted(solve), check: checker((l) => (l.i === 0 && l.j === 1 ? 3 : 1)) });
    ok(r.solves === 2 && n === 2 && r.checks === 2 && r.result.order.join() === '2,1', 'a re-solve that changes the order: one more check pass, no third solve', { solves: r.solves, checks: r.checks, order: r.result.order });
  }

  console.log('14. ordering basis (D2): never mixed');
  {
    const mAll = TT.emptyMemory();
    const pairs = TT.neededPairs(node('__start__', 'O'), ['A', 'B'].map((x) => node(x, x)), node('__end__', 'E'), []);
    pairs.forEach(([a, b]) => TT.addSample(mAll, a.pid, b.pid, 'day', { s: 1000 + Budget.estSec(a, b), m: 5000 }));
    const tt = mockTomTom();
    const t = await TT.buildTable({ start: node('__start__', 'O'), stops: [node('A', 'A'), node('B', 'B')], end: node('__end__', 'E'), links: [], mem: mAll, bucket: 'day', planMs: NOW, nowMs: NOW, live: false, fetchLeg: tt.fetchLeg });
    ok(!t.estimated && t.ord[1][2] === t.m[1][2] && t.m[1][2] === 1000 + Budget.estSec(places.A, places.B), 'all pairs real -> the order uses the real times');
    const mOne = TT.emptyMemory();
    pairs.filter(([a, b]) => !(a.pid === 'A' && b.pid === 'B')).forEach(([a, b]) => TT.addSample(mOne, a.pid, b.pid, 'day', { s: 1000 + Budget.estSec(a, b), m: 5000 }));
    const tt2 = mockTomTom({ fail: (a, b) => a.key === 'A' && b.key === 'B' });
    const t2 = await TT.buildTable({ start: node('__start__', 'O'), stops: [node('A', 'A'), node('B', 'B')], end: node('__end__', 'E'), links: [], mem: mOne, bucket: 'day', planMs: NOW, nowMs: NOW, live: false, fetchLeg: tt2.fetchLeg });
    ok(t2.estimated && t2.missing === 1, 'one pair with no real time in any bucket (TomTom could not answer) -> estimated', t2.missing);
    ok(t2.ord[1][2] === Budget.estSec(places.A, places.B) && t2.ord[2][1] === Budget.estSec(places.B, places.A) && t2.ord[0][1] === Budget.estSec(places.O, places.A), 'the ORDER uses estimates for ALL pairs');
    ok(t2.m[2][1] === 1000 + Budget.estSec(places.B, places.A) && !t2.est[2][1] && t2.est[1][2], 'the card times keep the real time where one exists (est. only on A->B)');
    ok(Budget.ESTIMATED_ORDER === 'Estimated order - TomTom unavailable', 'the Route header flag text');
    // the plan-level flag
    const ttDown = mockTomTom({ fail: () => false, answer: () => { const e = new Error(Budget.DOWN_MSG); e.kind = 'limit'; throw e; } });
    const rd = await plan(['A', 'B', 'C', 'D', 'Fp', 'F'], TT.emptyMemory(), ttDown);
    ok(rd.estimated && !rd.res.error && rd.res.plans[0].order.length === 6 && ttDown.log.length <= 4, 'TomTom down: a route on estimates, flagged, and the remaining fetches stop at once', { est: rd.estimated, calls: ttDown.log.length });
  }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
