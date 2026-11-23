'use strict';
// TomTom out -> estimated times: haversine x 1.4 at 40 km/h for missing pairs, cached pairs kept, the plan flagged, the
// solver's ordering rules unchanged; the providers' friendly error, counter hook and fallback (fetch mocked).
// Run as its own node script: node test/estimate.test.js
const Budget = require('../budget.js');
const Solver = require('../solver.js');
const Providers = require('../providers.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

const A = { lat: 3.10, lng: 101.60 }, B = { lat: 3.20, lng: 101.70 };

console.log('estimate: haversine x 1.4 at 40 km/h');
{
  const R = 6371000, rad = Math.PI / 180;
  const x = Math.sin((B.lat - A.lat) * rad / 2) ** 2 + Math.cos(A.lat * rad) * Math.cos(B.lat * rad) * Math.sin((B.lng - A.lng) * rad / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(x)) / 1000;
  const want = Math.round(km * 1.4 / 40 * 3600);
  ok(Budget.estSec(A, B) === want, 'estSec = straight line x 1.4 / 40 km/h (' + want + ' s for ' + km.toFixed(2) + ' km)', Budget.estSec(A, B));
  ok(Budget.estMetres(A, B) === Math.round(km * 1000 * 1.4), 'estMetres = straight line x 1.4');
}

console.log('fillMatrices: cached pair -> cached value, missing pair -> estimate, flagged');
{
  const C = { lat: 3.15, lng: 101.65 };
  const pts = [A, B, C];
  const lookup = (a, b) => (a === A && b === B ? { s: 777, m: 9999 } : null);
  const f = Budget.fillMatrices(pts, '2026-11-24T01:00:00.000Z', [0, 2, 4], lookup);
  const s0 = f.matrices[0];
  ok(f.matrices.length === 3 && f.matrices[1].departAt === '2026-11-24T03:00:00.000Z', 'three slices, +0 / +2 / +4 h');
  ok(s0.m[0][1] === 777 && s0.d[0][1] === 9999 && s0.est[0][1] === false, 'cached pair A->B: the cached TomTom value, not estimated', { m: s0.m[0][1], est: s0.est[0][1] });
  ok(s0.m[1][0] === Budget.estSec(B, A) && s0.est[1][0] === true, 'missing pair B->A: the estimate, flagged est');
  ok(s0.m[0][0] === 0 && s0.est[0][0] === false, 'diagonal 0, not estimated');
  ok(f.estimated === 5 * 3 && Budget.hasEst(f.matrices), '5 estimated cells per slice; the matrices are flagged', f.estimated);
}

console.log('a 4-stop plan from estimates: urgent first, pickup before delivery, flagged estimated');
{
  const place = (id, lat, lng) => ({ id, name: id, lat, lng, type: 'other', dwellMin: 10, closedWindows: [] });
  const places = { U: place('U', 3.30, 101.80), P: place('P', 3.08, 101.62), D: place('D', 3.09, 101.64), E: place('E', 3.07, 101.63) };
  const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: 0 }, o);
  const jobs = [
    job('j1', { pickups: [{ placeId: 'P', item: 'box' }], deliveryPlaceId: 'D' }), // P before D
    job('j2', { inHandItem: 'urgent part', deliveryPlaceId: 'U', urgent: true, urgentRank: 1 }), // far away, but urgent
    job('j3', { errandPlaceId: 'E', dwellMin: 5 }),
  ];
  const start = { lat: 3.075, lng: 101.62 }, end = { id: 'END', lat: 3.076, lng: 101.621 };
  const departAtISO = '2026-11-24T01:00:00.000Z';
  const input = { start, end, jobs, places, departAtISO, noDetour: false };
  const points = Solver.pointsFor(Object.assign({}, input, { matrices: [] }));
  // one cached real pair (start -> P), everything else estimated
  const lookup = (a, b) => (a === points[0] && b.lat === 3.08 && b.lng === 101.62 ? { s: 300, m: 1500 } : null);
  const f = Budget.fillMatrices(points, departAtISO, [0, 2, 4], lookup);
  const r = Solver.solve(Object.assign({}, input, { matrices: f.matrices }));
  ok(!r.error && r.plans.length >= 1, 'solves with estimated matrices', r.error);
  const ord = r.plans[0].order;
  ok(ord.length === 4, '4 stops', ord);
  const firstDelivery = ord.find((id) => id === 'U' || id === 'D');
  ok(r.plans.every((p) => p.order.indexOf('U') < p.order.indexOf('D')), 'urgent delivery U before the non-urgent delivery D in every plan', r.plans.map((p) => p.order));
  ok(firstDelivery === 'U', 'the first delivery is the urgent one', ord);
  ok(r.plans.every((p) => p.order.indexOf('P') < p.order.indexOf('D')), 'pickup P before its delivery D in every plan');
  const plan = Solver.retime(r.plans[0], -1, departAtISO);
  const es = Budget.estStops(plan, -1, false);
  ok(es.stops.size === 4 && es.end, 'every ETA that depends on an estimated leg is flagged est. (all 4 + the end)', [...es.stops]);
  const live = Budget.estStops(plan, -1, true);
  ok(live.stops.has(ord[1]), 'a live first leg does not clear the later estimated legs', [...live.stops]);
  const real = Solver.solve(Object.assign({}, input, { matrices: f.matrices.map((s) => ({ departAt: s.departAt, m: s.m })) }));
  ok(Budget.estStops(Solver.retime(real.plans[0], -1, departAtISO), -1, false).stops.size === 0, 'real (unflagged) matrices: no est. marks');
  const rx = Solver.reindexMatrices(f.matrices, [0, 1, 2]);
  ok(rx[0].est && rx[0].est[1][2] === f.matrices[0].est[1][2], 'a re-solve from the cache (reindexMatrices) keeps the est flags');
}

console.log('providers: 403 -> friendly error, counted, estimated fallback; recovery clears the down state');
(async () => {
  const seen = { count: [], ok: 0, down: [] };
  Providers.setTomTomHook({ count: (r, c) => seen.count.push([r, c]), ok: () => { seen.ok++; }, down: (st) => seen.down.push(st) });
  let status = 403;
  global.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    if (status !== 200) return { ok: false, status, json: async () => ({ detailedError: { message: 'You do not have enough credits to perform this action' } }) };
    const data = [];
    b.origins.forEach((o, i) => b.destinations.forEach((d, j) => data.push({ originIndex: i, destinationIndex: j, routeSummary: { travelTimeInSeconds: 100 + i * 10 + j, lengthInMeters: 1000 } })));
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const pts = [A, B, { lat: 3.15, lng: 101.65 }];
  let err = null;
  try { await Providers.getMatrices(pts, new Date(Date.now() + 3600e3).toISOString(), 'k', { force: true }); } catch (e) { err = e; }
  ok(err && err.kind === 'limit' && err.message === Budget.DOWN_MSG && !/HTTP|403|credits/.test(err.message), 'a 403 is ONE friendly message, no raw HTTP text', err && err.message);
  ok(seen.count.length === 3 && seen.count.every((c) => c[0] === 1 && c[1] === 9) && seen.down.length === 3, 'every request is counted (3 requests x 9 cells) and reported down', seen);
  const est = await Providers.getMatricesOrEstimate(pts, new Date(Date.now() + 3600e3).toISOString(), 'k', { force: true });
  ok(est.estimated === true && est.matrices.length === 3 && Budget.hasEst(est.matrices), 'getMatricesOrEstimate: estimated matrices instead of an error');
  status = 200;
  const legs = await Providers.routeLegs([A, B], 'k');
  ok(legs[0].s === 100 && seen.ok === 1, 'recovered: the next successful call reports ok (the app clears the banner)', { legs, ok: seen.ok });
  ok(seen.count[seen.count.length - 1][0] === 1 && seen.count[seen.count.length - 1][1] === 1, 'a live re-time is 1 request x 1 cell');
  const again = await Providers.getMatricesOrEstimate(pts.slice(0, 2), new Date(Date.now() + 3600e3).toISOString(), 'k', { force: true });
  ok(!again.estimated && again.calls === 3, 'the next PLAN gets real matrices (not estimated)');
  status = 403;
  const mixed = await Providers.getMatricesOrEstimate([A, B], new Date(Date.now() + 7200e3).toISOString(), 'k', { force: true });
  ok(mixed.estimated && mixed.matrices[0].m[0][1] === 101 && mixed.matrices[0].est[0][1] === false, 'out again: a pair TomTom answered before is reused from the cache (its latest value)', mixed.matrices[0].m);
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
