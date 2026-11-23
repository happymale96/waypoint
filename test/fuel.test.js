'use strict';
// "Add fuel stop": the pure module fuel.js, the fuel-aware re-time in solver.js, and the day log rules for a fuel stop
// (not a job: job counts ignore it, it never carries forward). Run as its own node script: node test/fuel.test.js
const Fuel = require('../fuel.js');
const Solver = require('../solver.js');
const DL = require('../daylog.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const near = (a, b, tol, name) => ok(a != null && Math.abs(a - b) <= tol, name, { got: a, want: b });

// km north / east of a base point near Kuala Lumpur
const KM_LAT = 1 / 111.19;
const KM_LNG = 1 / (111.19 * Math.cos(3 * Math.PI / 180));
const P = (north, east) => ({ lat: 3 + (north || 0) * KM_LAT, lng: 101 + (east || 0) * KM_LNG });
const minGap = (pts) => { let m = Infinity; for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) m = Math.min(m, Fuel.haversineKm(pts[i], pts[j])); return m; };

console.log('corridorDetourKm');
{
  near(Fuel.corridorDetourKm(P(0), P(5), P(10)), 0, 0.001, 'a station on the line adds nothing');
  near(Fuel.corridorDetourKm(P(0), P(5, 3), P(10)), 2 * Math.sqrt(25 + 9) - 10, 0.01, 'a station 3 km off the middle: 2 x sqrt(5^2+3^2) - 10');
  near(Fuel.corridorDetourKm(P(0), P(15), P(10)), 10, 0.01, 'a station past B: out and back');
  ok(Fuel.corridorDetourKm(P(0), P(0), P(10)) < 0.001, 'a station at A adds nothing');
}

console.log('evenIndices / thinEvenly');
{
  eq(Fuel.evenIndices(10, 3), [0, 5, 9], '3 of 10: first, middle, last');
  eq(Fuel.evenIndices(5, 1), [2], '1 of 5: the middle');
  eq(Fuel.evenIndices(3, 5), [0, 1, 2], 'asking for more than there is: all of them');
  eq(Fuel.evenIndices(4, 0), [], '0 asked: none');
}

console.log('samplePoints');
{
  const line = Fuel.samplePoints([P(0), P(10)], 4, 50);
  eq(line.length, 4, '10 km leg at 4 km spacing: origin, 4 km, 8 km, end');
  ok(minGap(line) >= 2 - 1e-6, 'no two points closer than spacing / 2', minGap(line));
  near(Fuel.haversineKm(line[0], P(0)), 0, 1e-6, 'starts at the origin');
  near(Fuel.haversineKm(line[line.length - 1], P(10)), 0, 1e-6, 'ends at the end point');
  eq(Fuel.samplePoints([P(0), P(3)], 4, 50).length, 2, 'a short leg: just its two ends');
  eq(Fuel.samplePoints([P(0), P(0), P(12)], 4, 50).length, Fuel.samplePoints([P(0), P(12)], 4, 50).length, 'two stops at the same place count once (deduped)');
  // a stop that sits where an interpolated point would be: the stop wins, no neighbour within spacing / 2
  const withStop = Fuel.samplePoints([P(0), P(4.5), P(9)], 4, 50);
  ok(withStop.some((p) => Fuel.haversineKm(p, P(4.5)) < 1e-6), 'a stop is always kept');
  ok(minGap(withStop) >= 2 - 1e-6, 'dedupe holds around stops too', minGap(withStop));
  ok(Fuel.samplePoints([P(0), P(1), P(2)], 4, 50).length < 3, 'stops 1 km apart are thinned to the spacing / 2 rule');
  const big = Fuel.samplePoints([P(0), P(200), P(400)], 4, 50);
  eq(big.length, 50, 'a 400 km route is capped at 50');
  near(Fuel.haversineKm(big[0], P(0)), 0, 1e-6, 'capped: still starts at the origin');
  near(Fuel.haversineKm(big[big.length - 1], P(400)), 0, 1e-6, 'capped: the end of the route is NOT cut off');
  const gaps = big.slice(1).map((p, i) => Fuel.haversineKm(big[i], p));
  ok(Math.max.apply(null, gaps) - Math.min.apply(null, gaps) < 12, 'capped: thinned evenly along the route', gaps.map((g) => Math.round(g)));
  eq(Fuel.samplePoints([P(0), P(400)], 4, 10).length, 10, 'a smaller cap is honoured');
  eq(Fuel.samplePoints([P(0), P(10)]).length, 4, 'defaults: 4 km spacing, cap 50');
  eq(Fuel.samplePoints([], 4, 50), [], 'no route: no points');
}

console.log('searchBudget');
{
  eq(Fuel.searchBudget(30, 50, 0), 30, 'fewer points than the cap: all of them');
  eq(Fuel.searchBudget(80, 50, 0), 50, 'max per tap limits');
  eq(Fuel.searchBudget(30, 10, 0), 10, 'a lower "max searches per tap" limits');
  eq(Fuel.searchBudget(30, 50, 100), 30, 'under the daily guard: unchanged');
  eq(Fuel.searchBudget(30, 50, 120), 20, 'the daily guard (140) leaves 20');
  eq(Fuel.searchBudget(30, 50, 139), 1, '139 calls today: exactly 1 left');
  eq(Fuel.searchBudget(30, 50, 140), 0, '140 calls today: zero budget');
  eq(Fuel.searchBudget(30, 50, 400), 0, 'far over the guard: zero, never negative');
  eq(Fuel.searchBudget(30, 50, 10, 20), 10, 'a custom guard');
  eq(Fuel.searchBudget(0, 50, 0), 0, 'nothing needed: zero');
}

console.log('mergeStations');
{
  const NOW = '2026-11-23T08:00:00.000Z', LATER = '2026-11-24T08:00:00.000Z';
  const a = { placeId: 'pa', name: 'Caltex A', address: 'Jalan A', lat: 3.1, lng: 101.1, brand: 'Caltex', savedAt: '2026-01-01T00:00:00.000Z' };
  const first = Fuel.mergeStations([], [{ placeId: 'p1', name: 'Caltex One', address: 'Addr 1', lat: 3.2, lng: 101.2, brand: 'Caltex' }], NOW);
  eq(first.length, 1, 'a new station is added');
  eq(first[0], { placeId: 'p1', name: 'Caltex One', address: 'Addr 1', lat: 3.2, lng: 101.2, brand: 'Caltex', savedAt: NOW }, 'with all fields and savedAt = now');
  const again = Fuel.mergeStations(first, [{ placeId: 'p1', name: 'Caltex One (renamed)', address: 'New addr', lat: 3.2, lng: 101.2, brand: 'Caltex' }], LATER);
  eq(again.length, 1, 're-found: still one entry (deduped by placeId)');
  ok(again[0].savedAt === NOW, 're-found: savedAt is kept', again[0].savedAt);
  ok(again[0].name === 'Caltex One (renamed)' && again[0].address === 'New addr', 're-found: name and address are updated', again[0]);
  const keep = Fuel.mergeStations([a], [{ placeId: 'p9', name: 'Caltex Nine', address: '', lat: 3.3, lng: 101.3, brand: 'Caltex' }], NOW);
  eq(keep.map((x) => x.placeId), ['pa', 'p9'], 'nothing is ever dropped: old stays, new is appended');
  eq(Fuel.mergeStations([a], [], NOW).length, 1, 'an empty search result drops nothing');
  const frozen = [Object.freeze(Object.assign({}, a))];
  Fuel.mergeStations(frozen, [{ placeId: 'pa', name: 'X', address: 'Y', lat: 1, lng: 1 }], NOW);
  ok(frozen[0].name === 'Caltex A', 'inputs are not mutated');
  const dup = Fuel.mergeStations([], [{ placeId: 'q', name: 'One', lat: 1, lng: 1 }, { placeId: 'q', name: 'Two', lat: 1, lng: 1 }], NOW);
  ok(dup.length === 1 && dup[0].name === 'Two', 'the same station twice in one search: one entry, latest name', dup);
  ok(Fuel.mergeStations([a], [{ name: 'no id', lat: 1, lng: 1 }], NOW).length === 1, 'a result without a placeId is ignored');
}

console.log('sameRouteKey');
{
  const r = [P(0), P(5, 2), P(12)];
  ok(Fuel.sameRouteKey(r) === Fuel.sameRouteKey(r.map((p) => Object.assign({}, p))), 'stable for the same route');
  ok(Fuel.sameRouteKey(r) === Fuel.sameRouteKey([P(0, 0.01), P(5, 2.01), P(12, 0.02)]), 'GPS jitter of ~10 m keeps the key');
  ok(Fuel.sameRouteKey(r) !== Fuel.sameRouteKey([P(0), P(5, 2), P(14)]), 'a moved end point changes it');
  ok(Fuel.sameRouteKey(r) !== Fuel.sameRouteKey([P(0), P(12)]), 'a dropped stop changes it');
  ok(Fuel.sameRouteKey(r) !== Fuel.sameRouteKey([P(0), P(12), P(5, 2)]), 'a different order changes it');
}

console.log('brand matching');
{
  ok(Fuel.nameHasBrand('CALTEX Petrol Station', 'Caltex') && Fuel.nameHasBrand('Stesen Caltex Shah Alam', ' caltex '), 'the brand is found in a name, case-insensitive');
  ok(!Fuel.nameHasBrand('Petron Shah Alam', 'Caltex') && !Fuel.nameHasBrand('Caltex', ''), 'other brands / an empty brand do not match');
  const mem = [{ placeId: 'a', name: 'Caltex A' }, { placeId: 'b', name: 'Petron B', brand: 'Petron' }, { placeId: 'c', name: 'Station C', brand: 'caltex' }];
  eq(Fuel.stationsOfBrand(mem, 'Caltex').map((s) => s.placeId), ['a', 'c'], 'the memory is filtered to the current brand');
}

console.log('shortlist');
{
  // route O(0,0) -> A(10,0) -> B(20,0) -> E(30,0)
  const pts = [P(0), P(10), P(20), P(30)];
  const legs = [{ index: 0, from: 0, to: 1 }, { index: 1, from: 1, to: 2 }, { index: 2, from: 2, to: 3 }];
  const st = (id, n, e) => Object.assign({ placeId: id, name: id }, P(n, e));
  const stations = [st('far', 15, 8), st('onroute', 25, 0), st('near', 5, 1), st('dup', 5, 1), st('mid', 15, 3)];
  stations.push(Object.assign({}, stations[0])); // the same station found twice
  const out = Fuel.shortlist(pts, stations, legs, 5);
  eq(out.map((r) => r.station.placeId), ['onroute', 'near', 'dup', 'mid', 'far'], 'ordered by smallest straight-line detour');
  eq(new Set(out.map((r) => r.station.placeId)).size, out.length, 'stations are distinct');
  ok(out.every((r) => r.legs.length === 2), 'each has its best 2 legs');
  ok(out.every((r) => r.legs[0].detourKm <= r.legs[1].detourKm), 'legs sorted best first');
  eq(out[0].legs[0].index, 2, 'a station on the last leg: that leg is best');
  eq(Fuel.shortlist(pts, stations, legs, 2).length, 2, 'n limits the list');
  eq(Fuel.shortlist(pts, stations, [legs[2]], 5).every((r) => r.legs.length === 1 && r.legs[0].index === 2), true, 'only the allowed legs are considered');
  eq(Fuel.shortlist(pts, [], legs, 5), [], 'no stations: empty');
}

console.log('allowedLegs');
{
  const stop = (id, n, extra) => Object.assign({ id, lat: P(n).lat, lng: P(n).lng }, extra);
  const mk = (stops) => ({ origin: Object.assign({ id: 'O' }, P(0)), stops, end: Object.assign({ id: 'E' }, P(40)) });
  const ids = (route) => Fuel.allowedLegs(route).map((l) => l.index);
  eq(ids(mk([stop('A', 10), stop('B', 20), stop('C', 30)])), [0, 1, 2, 3], 'nothing urgent: every leg (origin, A, B, C, end -> 4 legs)');
  eq(Fuel.remainingPoints(mk([stop('A', 10, { status: 'done' }), stop('B', 20, { status: 'skipped' }), stop('C', 30)])).map((p) => p.id), ['O', 'C', 'E'], 'done and skipped stops are not remaining points');
  eq(ids(mk([stop('A', 10, { status: 'done' }), stop('B', 20, { status: 'skipped' }), stop('C', 30)])), [0, 1], 'done / skipped stops: only legs between the REMAINING points');
  eq(ids(mk([stop('A', 10), stop('B', 20, { urgent: true }), stop('C', 30)])), [2, 3], 'urgent pending at B: fuel never goes before it (legs O>A, A>B are out)');
  eq(ids(mk([stop('A', 10, { urgent: true }), stop('B', 20), stop('C', 30, { urgent: true })])), [3], 'two urgent: only the leg after the last one');
  eq(ids(mk([stop('A', 10, { urgent: true }), stop('B', 20, { urgent: true })])), [2], 'every stop urgent: only the final leg');
  eq(ids(mk([stop('A', 10, { urgent: true, status: 'done' }), stop('B', 20)])), [0, 1], 'an urgent stop already done no longer blocks');
  const endUrgent = mk([stop('A', 10)]); endUrgent.end.urgent = true;
  eq(ids(endUrgent), [1], 'nothing allowed by the rule: falls back to the final leg');
  eq(ids(mk([])), [0], 'no stops left: the single origin > end leg');
  const legs = Fuel.allowedLegs(mk([stop('A', 10), stop('B', 20)]));
  ok(legs.every((l) => l.to === l.from + 1), 'legs join consecutive remaining points', legs);
}

console.log('pickInsertion');
{
  const A = { name: 'A', key: 'a' }, B = { name: 'B', key: 'b' }, C = { name: 'C', key: 'c' };
  const S1 = { placeId: 's1', name: 'S1', key: 's1' }, S2 = { placeId: 's2', name: 'S2', key: 's2' };
  const T = { 'a>b': 10, 'b>c': 12, 'a>c': 20, 'a>s1': 6, 's1>b': 8, 'b>s1': 9, 's1>c': 7, 'a>s2': 4, 's2>b': 5, 'b>s2': 5, 's2>c': 9 };
  const tt = (p, q) => (T[p.key + '>' + q.key] == null ? null : T[p.key + '>' + q.key]);
  const cands = [
    { station: S1, a: A, b: B, legIndex: 0 }, // 6 + 8 - 10 = 4
    { station: S1, a: B, b: C, legIndex: 1 }, // 9 + 7 - 12 = 4  (tie)
    { station: S2, a: A, b: B, legIndex: 0 }, // 4 + 5 - 10 = -1
    { station: S2, a: B, b: C, legIndex: 1 }, // 5 + 9 - 12 = 2
    { station: S2, a: A, b: C, legIndex: 2 }, // no t(s2>c)? present 9; t(a>s2)=4 -> 4 + 9 - 20 = -7
  ];
  const out = Fuel.pickInsertion(cands, tt);
  eq(out.map((c) => c.station.placeId + '@' + c.legIndex), ['s2@2', 's2@0', 's2@1', 's1@0', 's1@1'], 'sorted by detour minutes, the tie goes to the earlier leg');
  eq(out.map((c) => c.detourMin), [-7, -1, 2, 4, 4], 'detourMin = t(A,S) + t(S,B) - t(A,B)');
  const tie = Fuel.pickInsertion([cands[1], cands[0]], tt);
  eq(tie.map((c) => c.legIndex), [0, 1], 'a tie is broken by leg order whatever the input order');
  const missing = Fuel.pickInsertion([{ station: { key: 'zz' }, a: A, b: B, legIndex: 0 }, cands[0]], tt);
  eq(missing.length, 1, 'a candidate with an unknown travel time is dropped');
  eq(Fuel.pickInsertion([], tt), [], 'no candidates: empty');
  ok(cands[0].detourMin === undefined, 'the candidates themselves are not mutated');
}

console.log('mapLimit');
(async () => {
  let running = 0, peak = 0, progress = [];
  const items = Array.from({ length: 23 }, (_, i) => i);
  const r = await Fuel.mapLimit(items, 5, async (i) => { running++; peak = Math.max(peak, running); await new Promise((res) => setTimeout(res, 2)); running--; if (i === 7) throw new Error('boom'); return i * 2; },
    (d, n) => progress.push(d + '/' + n));
  ok(peak <= 5 && peak >= 2, 'at most 5 at a time', peak);
  ok(r.results[3] === 6 && r.errors.length === 1 && r.errors[0].message === 'boom', 'results kept, an error is collected and does not stop the rest', r.errors.length);
  ok(progress.length === 23 && progress[22] === '23/23', 'progress is reported after each', progress.length);
  let started = 0, stop = false;
  const c = await Fuel.mapLimit(items, 2, async () => { started++; if (started >= 4) stop = true; await new Promise((res) => setTimeout(res, 2)); }, null, () => stop);
  ok(started < 23 && c.errors.length === 0, 'cancelled: no new ones are started', started);
  eq((await Fuel.mapLimit([], 5, async () => 1)).results, [], 'nothing to do');

  retimeTests();
  dayLogTests();
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();

// ---------- Solver.retime with a fuel stop ----------
function retimeTests() {
  console.log('retime with a fuel stop');
  // plain coordinates, 1 unit = 60 s; start / end (0,0); errands A(1,0) B(2,0) C(3,0), 5 min each
  const DEP = new Date(2030, 0, 15, 9, 0, 0), MIN = 60000;
  const at = (h, m, s) => new Date(2030, 0, 15, h, m, s || 0).getTime();
  const place = (id, x, y) => ({ id, name: id, lat: x, lng: y, type: 'other', dwellMin: 5, closedWindows: [] });
  const errand = (id, pid) => ({ id, pickups: [], deliveryPlaceId: null, errandPlaceId: pid, dwellMin: 5, notes: id, urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: 0 });
  const places = { A: place('A', 1, 0), B: place('B', 2, 0), C: place('C', 3, 0) };
  const input = { start: { lat: 0, lng: 0 }, end: { lat: 0, lng: 0 }, jobs: [errand('jA', 'A'), errand('jB', 'B'), errand('jC', 'C')], places, departAtISO: DEP.toISOString(), noDetour: false };
  const pts = Solver.pointsFor(Object.assign({}, input, { matrices: [] }));
  input.matrices = [0, 2, 4].map((h) => ({ departAt: new Date(DEP.getTime() + h * 3600e3).toISOString(), m: pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 60)))) }));
  const base = Solver.solve(input).plans[0];
  eq(base.order, ['A', 'B', 'C'], 'base plan visits A, B, C');
  const k = (p) => Number(p.lat).toFixed(5) + ',' + Number(p.lng).toFixed(5);
  const fz = {
    lat: 1.5, lng: 0.5, pid2key: { A: k(places.A), B: k(places.B), C: k(places.C) }, ll: { [k({ lat: 0, lng: 0 })]: { lat: 0, lng: 0 }, [k(places.A)]: places.A, [k(places.B)]: places.B, [k(places.C)]: places.C },
    slices: [{ at: DEP.getTime(), to: { [k(places.A)]: 120, [k({ lat: 0, lng: 0 })]: 100, [k(places.B)]: 90, [k(places.C)]: 400 }, from: { [k(places.B)]: 180, [k(places.C)]: 360, [k(places.A)]: 70 } }],
  };
  const fuelStop = { placeId: '__fuel__', fuel: true, arriveAt: 0, departAt: 0, waitSec: 0, actions: [], detour: false, closedWarning: false };
  const withFuel = (stops, withTable) => Object.assign({}, base, { stops, model: Object.assign({}, base.model, withTable === false ? {} : { fuelT: fz }, { dwellSec: Object.assign({}, base.model.dwellSec, { __fuel__: 420 }) }) });
  const plan = withFuel([base.stops[0], fuelStop, base.stops[1], base.stops[2]]);
  const r = Solver.retime(plan, -1, DEP.toISOString());
  const t = (s) => r.stops.find((x) => x.placeId === s);
  eq(t('A').arriveAt, at(9, 1), 'A: 1 min from the start');
  eq(t('__fuel__').arriveAt, at(9, 8), 'fuel: A departs 9:06, +120 s from the table = 9:08');
  eq(t('__fuel__').departAt, at(9, 15), 'fuel dwell 7 min');
  eq(t('B').arriveAt, at(9, 18), 'B: fuel departs 9:15, +180 s from the table = 9:18');
  eq(t('C').arriveAt, at(9, 24), 'C follows B by the plain matrix leg');
  eq(r.endArrival, at(9, 32), 'the end arrival includes the fuel detour');
  const noFuel = Solver.retime(base, -1, DEP.toISOString());
  ok(r.endArrival - noFuel.endArrival === (120 + 420 + 180 - 60) * 1000 + 0, 'detour = t(A,F) + dwell + t(F,B) - t(A,B)', (r.endArrival - noFuel.endArrival) / 1000);
  eq(Solver.retime(withFuel([base.stops[0], fuelStop, base.stops[1], base.stops[2]], false), -1, DEP.toISOString()).stops[1].arriveAt, 0, 'without a table the fuel stop is left untouched');
  // skipped A: the fuel stop is reached straight from the start
  const sk = Solver.retime(withFuel([Object.assign({}, base.stops[0], { status: 'skipped' }), fuelStop, base.stops[1], base.stops[2]]), -1, DEP.toISOString());
  eq(sk.stops[1].arriveAt, at(9, 1, 40), 'A skipped: fuel is reached from the start (100 s)');
  // fuel done at 9:20: B is timed from the fuel station
  const done = Solver.retime(withFuel([Object.assign({}, base.stops[0], { status: 'done', doneAt: new Date(at(9, 6)).toISOString() }), Object.assign({}, fuelStop, { status: 'done', doneAt: new Date(at(9, 20)).toISOString() }), base.stops[1], base.stops[2]]), 1, new Date(at(9, 20)).toISOString());
  eq(done.stops[2].arriveAt, at(9, 23), 'fuel done: the next stop is timed from the fuel station (180 s)');
  // a LATE window follows the fuel detour
  const late = withFuel([base.stops[0], fuelStop, base.stops[1], base.stops[2]]);
  late.model = Object.assign({}, late.model, { beforeMs: Object.assign({}, late.model.beforeMs, { B: [{ jobId: 'jB', ms: at(9, 17) }] }) });
  const lr = Solver.retime(late, -1, DEP.toISOString());
  ok(lr.stops.find((s) => s.placeId === 'B').late === true && lr.violations.length === 1, 'B (must be before 9:17) is LATE because of the fuel stop', lr.violations);
  ok(Solver.retime(base, -1, DEP.toISOString()).stops.find((s) => s.placeId === 'B').late !== true, 'and not late without it');
}

// ---------- day log: the fuel stop is not a job ----------
function dayLogTests() {
  console.log('day log: the fuel stop is not a job');
  const T = (h, m) => new Date(Date.UTC(2026, 10, 20, h - 8, m || 0)).toISOString();
  const places = { A: { id: 'A', name: 'Acme', lat: 3.01, lng: 101.01 }, B: { id: 'B', name: 'Beta', lat: 3.02, lng: 101.02 }, __fuel__: { id: '__fuel__', name: 'Caltex Shah Alam', lat: 3.015, lng: 101.015 } };
  const jobs = [
    { id: 'j1', pickups: [{ placeId: 'A', item: 'Sensor', done: false }], deliveryPlaceId: 'B', urgent: false, status: 'pending', notes: '' },
    { id: 'j2', pickups: [], inHandItem: 'Gasket', deliveryPlaceId: 'B', urgent: false, status: 'pending', notes: '' },
  ];
  const mk = () => {
    const day = DL.newDay({ date: '2026-11-20', driverId: 'Calvin' });
    DL.recordPlan(day, { nowIso: T(9, 0), start: { lat: 3, lng: 101 }, departAtIso: T(9, 0), jobs, places, stopOrder: ['A', 'B'], plannedKm: 10, plannedDriveMin: 20 });
    DL.recordDone(day, { nowIso: T(9, 30), stopId: 'A', actions: [{ jobId: 'j1', kind: 'pickup', item: 'Sensor' }], places });
    return day;
  };
  const day0 = mk(), before = DL.summarise(day0, jobs, places);
  const day = mk();
  const ev = DL.recordFuel(day, { nowIso: T(9, 45), stopId: '__fuel__', name: 'Caltex Shah Alam', places });
  ok(ev.type === 'done' && ev.kind === 'fuel' && ev.jobId === null, 'recorded as a done stop with kind fuel and no job', ev);
  const after = DL.summarise(day, jobs, places);
  eq([after.jobsDone, after.jobsTotal], [before.jobsDone, before.jobsTotal], 'job counts ("N of M jobs") ignore the fuel stop');
  eq(after.rows.length, before.rows.length, 'no job row for it');
  eq(after.stopsVisited, before.stopsVisited, 'it is not a visited delivery stop');
  eq(after.plan.stopsDone, before.plan.stopsDone, 'nor a planned stop done');
  eq(after.plan.outOfOrder, before.plan.outOfOrder, 'nor an out-of-order stop');
  ok(after.fuel && after.fuel.place === 'Caltex Shah Alam' && after.fuel.t === Date.parse(T(9, 45)), 'the summary carries the fuel stop and its done time', after.fuel);
  ok(after.doneSeq.indexOf('__fuel__') >= 0, 'but it stays in the driven sequence (the km include the detour)', after.doneSeq);
  eq(after.collected.length + after.delivered.length + after.errands.length, before.collected.length + before.delivered.length + before.errands.length, 'no collected / delivered / errand line');
  ok(DL.toWhatsApp(after).split('\n').indexOf('Fuel: Caltex Shah Alam ' + DL.fmtTime(Date.parse(T(9, 45)))) >= 0, 'the WhatsApp summary has one "Fuel: <station> <time>" line');
  ok(DL.toWhatsApp(before).indexOf('Fuel:') < 0, 'no fuel line when there was none');
  ok(DL.toCSV(after) === DL.toCSV(before), 'the CSV (one row per job) is unchanged');
  DL.recordUndo(day, { nowIso: T(9, 50), stopId: '__fuel__' });
  eq(DL.summarise(day, jobs, places).fuel, null, 'undoing the fuel DONE removes the line');

  console.log('day log: the fuel stop never carries forward');
  const dayC = mk();
  DL.recordFuel(dayC, { nowIso: T(9, 45), stopId: '__fuel__', name: 'Caltex Shah Alam', places });
  const jobsC = JSON.parse(JSON.stringify(jobs));
  const changed = DL.closeDay(dayC, jobsC, places, T(18, 0));
  ok(dayC.closed, 'the day closes');
  ok(dayC.carried.every((c) => jobsC.some((j) => j.id === c.jobId)) && dayC.carried.length === 2, 'only the 2 unfinished jobs are carried, nothing for the fuel stop', dayC.carried.map((c) => c.jobId));
  ok(changed.length === 2 && changed.every((j) => j.id === 'j1' || j.id === 'j2'), 'only real jobs change', changed.map((j) => j.id));
  eq(jobsC.length, 2, 'no fuel "job" appears in the job list');
  ok(JSON.stringify(dayC.carried).indexOf('fuel') < 0, 'nothing about fuel in the carried list');
  ok(dayC.totals.jobsTotal === 2 && dayC.totals.stopsVisited === 1, 'stored totals count jobs and delivery stops only', dayC.totals);
  const next = DL.recordFor({}, '2026-11-21', 'Calvin');
  eq(next.events.length, 0, 'the next day starts with no fuel event');
}
