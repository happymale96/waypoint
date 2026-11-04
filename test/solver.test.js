'use strict';
const Solver = require('../solver.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}

// ---- synthetic world: coordinates are plain (x,y); 1 unit = 60 s; 3 time slices ----
const DEP = new Date(2030, 0, 15, 9, 0, 0);
const SLICE_MULT = [1, 1.2, 1.5];

function mkPlace(id, x, y, extra) {
  return Object.assign({ id, name: id, lat: x, lng: y, type: 'other', dwellMin: 0, closedWindows: [] }, extra || {});
}
function mkJob(id, o) {
  return Object.assign({ id, pickups: [], deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0,
    arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: 0 }, o);
}
function matricesFor(points, mults, perEdgeRand) {
  return mults.map((mu, s) => ({
    departAt: new Date(DEP.getTime() + s * 2 * 3600e3).toISOString(),
    m: points.map((a, i) => points.map((b, j) => {
      if (i === j) return 0;
      const base = Math.hypot(a.lat - b.lat, a.lng - b.lng) * 60;
      return Math.round(base * (perEdgeRand ? mu * (0.7 + perEdgeRand() * 0.8) : mu));
    })),
  }));
}
function build(startXY, endXY, placeList, jobs, extra) {
  const places = {};
  placeList.forEach((p) => { places[p.id] = p; });
  const start = { lat: startXY[0], lng: startXY[1] };
  const end = Object.assign({ id: 'END' }, { lat: endXY[0], lng: endXY[1] });
  const input = Object.assign({ start, end, jobs, places, departAtISO: DEP.toISOString(), noDetour: false }, extra || {});
  input.matrices = matricesFor(Solver.pointsFor(Object.assign({}, input, { matrices: [] })), SLICE_MULT, (extra && extra.rand) || null);
  return input;
}
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1. pickups precede delivery
console.log('pickup before delivery');
{
  const input = build([0, 0], [20, 0],
    [mkPlace('A', 15, 0), mkPlace('B', 5, 0)],
    [mkJob('j1', { pickups: [{ placeId: 'A', item: 'bolts' }], deliveryPlaceId: 'B' })]);
  const r = Solver.solve(input);
  ok(!r.error && r.plans.length >= 1, 'solves');
  ok(r.plans.every((p) => p.order.indexOf('A') < p.order.indexOf('B')), 'A before B in every plan', JSON.stringify(r.plans.map((p) => p.order)));
  ok(r.plans[0].order.join() === 'A,B', 'best plan is A,B');
}

// 2. urgent before non-urgent deliveries, urgentRank respected
console.log('urgent ordering + rank');
{
  const input = build([0, 0], [0, 0],
    [mkPlace('D1', 10, 0), mkPlace('D2', 20, 0), mkPlace('D3', 1, 0)],
    [mkJob('u1', { deliveryPlaceId: 'D1', urgent: true, urgentRank: 2 }),
      mkJob('u2', { deliveryPlaceId: 'D2', urgent: true, urgentRank: 1 }),
      mkJob('n1', { deliveryPlaceId: 'D3' })]);
  const r = Solver.solve(input);
  ok(r.plans.length >= 1, 'has plans');
  ok(r.plans.every((p) => p.order.join() === 'D2,D1,D3'), 'all plans are D2,D1,D3', JSON.stringify(r.plans.map((p) => p.order)));
}

// 3. detour allowed (flagged) vs noDetour
console.log('detour vs noDetour');
{
  const places = [mkPlace('U', 10, 0), mkPlace('P', 5, 0), mkPlace('Q', 20, 0)];
  const jobs = [
    mkJob('urg', { deliveryPlaceId: 'U', urgent: true, urgentRank: 1 }),
    mkJob('non', { pickups: [{ placeId: 'P', item: 'box' }], deliveryPlaceId: 'Q' }),
  ];
  const r = Solver.solve(build([0, 0], [20, 0], places, jobs));
  ok(r.plans[0].order.join() === 'P,U,Q', 'non-urgent pickup placed before urgent delivery when cheaper', r.plans[0].order.join());
  ok(r.plans[0].stops[0].detour === true && r.plans[0].stops[1].detour === false, 'P flagged detour, U not');
  const r2 = Solver.solve(build([0, 0], [20, 0], places, jobs, { noDetour: true }));
  ok(r2.plans.length >= 1 && r2.plans[0].order.join() === 'U,P,Q', 'noDetour puts urgent first', r2.plans[0].order.join());
  ok(r2.plans.every((p) => p.stops.every((s) => !s.detour)), 'noDetour: no stop flagged detour');
  ok(r2.plans[0].totalSec > r.plans[0].totalSec, 'noDetour costs more time');
}

// 4. arriveBefore violation
console.log('arriveBefore');
{
  const places = [mkPlace('X', 10, 0)]; // 10 min away
  const bad = Solver.solve(build([0, 0], [0, 0], places, [mkJob('j', { deliveryPlaceId: 'X', arriveBefore: '09:05' })]));
  ok(bad.plans.length >= 1 && bad.plans[0].violations.length > 0, 'impossible window reported as violation', JSON.stringify(bad.plans[0] && bad.plans[0].violations));
  const good = Solver.solve(build([0, 0], [0, 0], places, [mkJob('j', { deliveryPlaceId: 'X', arriveBefore: '09:30' })]));
  ok(good.plans[0].violations.length === 0, 'feasible window has no violation');
  const wait = Solver.solve(build([0, 0], [0, 0], places, [mkJob('j', { deliveryPlaceId: 'X', arriveAfter: '09:40' })]));
  ok(wait.plans[0].violations.length === 0 && wait.plans[0].stops[0].waitSec > 0, 'arriveAfter makes the van wait');
}

// 5. errand with dwell
console.log('errand');
{
  const places = [mkPlace('E', 5, 0), mkPlace('D', 10, 0)];
  const jobs = [mkJob('err', { errandPlaceId: 'E', dwellMin: 30, notes: 'bank' }), mkJob('d', { deliveryPlaceId: 'D' })];
  const r = Solver.solve(build([0, 0], [0, 0], places, jobs));
  const p = r.plans[0];
  const es = p.stops.find((s) => s.placeId === 'E');
  ok(!!es, 'errand stop included');
  ok(es && es.departAt - es.arriveAt === 30 * 60 * 1000, 'errand dwell is 30 min');
  ok(es && es.actions[0].kind === 'errand', 'errand action kind');
}

// 6. same place in two jobs visited once
console.log('merged stops');
{
  const places = [mkPlace('X', 10, 0), mkPlace('Y', 3, 0)];
  const jobs = [mkJob('a', { deliveryPlaceId: 'X' }), mkJob('b', { deliveryPlaceId: 'X' }), mkJob('c', { deliveryPlaceId: 'Y' })];
  const r = Solver.solve(build([0, 0], [0, 0], places, jobs));
  ok(r.plans.every((p) => p.order.filter((x) => x === 'X').length === 1), 'X visited once per plan');
  const x = r.plans[0].stops.find((s) => s.placeId === 'X');
  ok(x.actions.length === 2, 'both jobs handled at the single X stop');
}

// 7. optimal & sorted; brute force on a random time-dependent instance
console.log('optimality vs brute force');
{
  function perms(a) { if (a.length <= 1) return [a]; const out = []; a.forEach((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).forEach((p) => out.push([x].concat(p)))); return out; }
  for (let seed = 1; seed <= 6; seed++) {
    const rnd = mulberry(seed * 7919);
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    const places = ids.map((id) => mkPlace(id, Math.round(rnd() * 30), Math.round(rnd() * 30), { dwellMin: Math.round(rnd() * 10) }));
    const jobs = [
      mkJob('j1', { pickups: [{ placeId: 'A', item: 'a' }], deliveryPlaceId: 'B' }),
      mkJob('j2', { pickups: [{ placeId: 'C', item: 'c' }], deliveryPlaceId: 'D' }),
      mkJob('j3', { pickups: [{ placeId: 'E', item: 'e' }], deliveryPlaceId: 'F' }),
    ];
    const input = build([0, 0], [rnd() * 30, rnd() * 30], places, jobs, { rand: rnd });
    const r = Solver.solve(input);
    const feasible = perms(ids).filter((o) => o.indexOf('A') < o.indexOf('B') && o.indexOf('C') < o.indexOf('D') && o.indexOf('E') < o.indexOf('F'))
      .map((o) => Solver.evaluate(input, o).totalSec).sort((a, b) => a - b);
    ok(r.plans[0].totalSec === feasible[0], 'seed ' + seed + ': best == brute-force best', r.plans[0].totalSec + ' vs ' + feasible[0]);
    ok(r.plans.every((p, i) => i === 0 || p.totalSec >= r.plans[i - 1].totalSec), 'seed ' + seed + ': plans sorted by totalSec');
    ok(r.plans.every((p) => p.totalSec >= r.plans[0].totalSec), 'seed ' + seed + ': chosen <= every other plan');
    ok(r.plans.map((p) => p.totalSec).join() === feasible.slice(0, r.plans.length).join(), 'seed ' + seed + ': top-5 totals match brute force',
      r.plans.map((p) => p.totalSec).join() + ' vs ' + feasible.slice(0, 5).join());
  }
}

// 8. 12 places under 3 s
console.log('12 places performance');
{
  for (let seed = 1; seed <= 3; seed++) {
    const rnd = mulberry(seed * 104729);
    const places = [], jobs = [];
    for (let i = 0; i < 12; i++) {
      places.push(mkPlace('S' + i, rnd() * 40, rnd() * 40, { dwellMin: 5 }));
      jobs.push(mkJob('j' + i, { deliveryPlaceId: 'S' + i }));
    }
    const input = build([20, 20], [20, 20], places, jobs, { rand: rnd });
    const t = Date.now();
    const r = Solver.solve(input);
    const ms = Date.now() - t;
    ok(!r.error && r.plans.length === 5 && ms < 3000, 'unconstrained 12 deliveries seed ' + seed + ' in ' + ms + ' ms (nodes ' + r.stats.nodes + ', truncated ' + r.stats.truncated + ')');
  }
  const rnd = mulberry(42);
  const places = [], jobs = [];
  for (let i = 0; i < 12; i++) places.push(mkPlace('M' + i, rnd() * 40, rnd() * 40, { dwellMin: 5 }));
  for (let i = 0; i < 4; i++) jobs.push(mkJob('p' + i, { pickups: [{ placeId: 'M' + i, item: 'x' }], deliveryPlaceId: 'M' + (i + 4), urgent: i < 2, urgentRank: i }));
  for (let i = 8; i < 12; i++) jobs.push(mkJob('d' + i, { deliveryPlaceId: 'M' + i }));
  const t = Date.now();
  const r = Solver.solve(build([20, 20], [20, 20], places, jobs, { rand: rnd }));
  const ms = Date.now() - t;
  ok(!r.error && r.plans.length >= 1 && ms < 3000, 'mixed constrained 12 places in ' + ms + ' ms');
}

// 9. refuse > 12
console.log('limit');
{
  const places = [], jobs = [];
  for (let i = 0; i < 13; i++) { places.push(mkPlace('Z' + i, i, i)); jobs.push(mkJob('z' + i, { deliveryPlaceId: 'Z' + i })); }
  const r = Solver.solve(build([0, 0], [0, 0], places.slice(0, 12), jobs.slice(0, 12)));
  ok(!r.error, '12 accepted');
  const input = build([0, 0], [0, 0], places.slice(0, 12), jobs.slice(0, 12));
  input.places = Object.fromEntries(places.map((p) => [p.id, p])); input.jobs = jobs;
  const r13 = Solver.solve(input);
  ok(r13.error && /max 12/.test(r13.error) && r13.plans.length === 0, '13 refused with clear message', r13.error);
}

// 10. least-bad fallback names violations
console.log('fallback');
{
  const places = [mkPlace('X', 10, 0), mkPlace('Y', 20, 0)];
  const jobs = [mkJob('a', { deliveryPlaceId: 'X', arriveBefore: '09:01' }), mkJob('b', { deliveryPlaceId: 'Y', arriveBefore: '09:02' })];
  const r = Solver.solve(build([0, 0], [0, 0], places, jobs));
  ok(r.plans.length === 2 && r.plans.every((p) => p.violations.length > 0), 'returns least-bad plans with violations', JSON.stringify(r.plans.map((p) => p.violations.length)));
  ok(r.plans[0].lateSec <= r.plans[1].lateSec, 'least late first');
}

// 11. parked / done jobs ignored
console.log('status filter');
{
  const places = [mkPlace('X', 10, 0), mkPlace('Y', 20, 0)];
  const jobs = [mkJob('a', { deliveryPlaceId: 'X' }), mkJob('b', { deliveryPlaceId: 'Y', status: 'parked' }), mkJob('c', { deliveryPlaceId: 'Y', status: 'done' })];
  const r = Solver.solve(build([0, 0], [0, 0], places, jobs));
  ok(r.plans[0].order.join() === 'X', 'only pending jobs planned');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
