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

const okN = (name, cond, extra) => ok(!!cond, name, extra); // new tests are written name-first
// ---------- helpers for the closed-window / retime tests (explicit departure date, per-slice multipliers) ----------
function inputAt(depDate, startXY, endXY, placeList, jobs, extra, mults) {
  const places = {};
  placeList.forEach((p) => { places[p.id] = p; });
  const input = Object.assign({
    start: { lat: startXY[0], lng: startXY[1] }, end: { id: 'END', lat: endXY[0], lng: endXY[1] },
    jobs, places, departAtISO: depDate.toISOString(), noDetour: false,
  }, extra || {});
  const pts = Solver.pointsFor(Object.assign({}, input, { matrices: [] }));
  input.matrices = [0, 2, 4].map((h, s) => ({
    departAt: new Date(depDate.getTime() + h * 3600e3).toISOString(),
    fetchedAt: depDate.toISOString(),
    m: pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 60 * ((mults || [1, 1, 1])[s]))))),
  }));
  return input;
}
function nextWeekday(isoDay, hour) { // 2030-01-01 onwards, local time; ISO weekday Mon=1..Sun=7
  const d = new Date(2030, 0, 1, hour == null ? 9 : hour, 0, 0);
  while ((d.getDay() || 7) !== isoDay) d.setDate(d.getDate() + 1);
  return d;
}
const FRI = nextWeekday(5), MON = nextWeekday(1);
const winFri = [{ days: [5], from: '09:00', to: '09:20' }];
const hm = (ms) => { const d = new Date(ms); return d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); };

// 12. closed windows by weekday (advisory) + respectClosedWindows
console.log('closed windows by weekday');
{
  okN('test dates are the weekdays I think', (FRI.getDay() || 7) === 5 && (MON.getDay() || 7) === 1);
  const geo1 = (dep) => inputAt(dep, [0, 0], [0, 0], [mkPlace('A', 10, 0, { closedWindows: winFri }), mkPlace('B', 0, 10)],
    [mkJob('a', { deliveryPlaceId: 'A' }), mkJob('b', { deliveryPlaceId: 'B' })]);
  const fri = geo1(FRI), mon = geo1(MON);
  const ab = Solver.evaluate(fri, ['A', 'B']);
  okN('advisory (default): Friday arrival (09:10) inside the Friday window shows CLOSED and does not wait', ab.stops[0].closedWarning === true && ab.stops[0].waitSec === 0, ab.stops[0]);
  okN('same arrival on a Monday: no CLOSED (window is Friday-only)', Solver.evaluate(mon, ['A', 'B']).stops[0].closedWarning === false);
  okN('legacy window without days applies every day', Solver.isClosedAt([{ from: '09:00', to: '09:20' }], MON.getTime() + 10 * 60000) === true);
  okN('window boundaries: start inclusive, end exclusive', Solver.isClosedAt(winFri, FRI.getTime()) === true && Solver.isClosedAt(winFri, FRI.getTime() + 20 * 60000) === false);

  const rFri = Object.assign({}, fri, { respectClosedWindows: true });
  const abWait = Solver.evaluate(rFri, ['A', 'B']);
  okN('respect: an arrival inside the Friday window waits until it ends (600 s)', abWait.stops[0].waitSec === 600 && abWait.stops[0].closedWarning === false, abWait.stops[0]);
  okN('respect: waits until exactly 09:20', hm(abWait.stops[0].arriveAt) === '9:20');
  okN('respect: wait time counts toward the total', abWait.totalSec === ab.totalSec + 600, [abWait.totalSec, ab.totalSec]);
  const rMon = Object.assign({}, mon, { respectClosedWindows: true });
  okN('respect on a Monday: same stop does not wait', Solver.evaluate(rMon, ['A', 'B']).stops.every((s) => s.waitSec === 0));
  const best = Solver.solve(rFri).plans[0];
  okN('respect: solver REORDERS (B then A) when that beats waiting', best.order.join() === 'B,A' && best.stops.every((s) => s.waitSec === 0), best.order.join());
  okN('respect: the reordered plan beats the wait-at-A order', best.totalSec < abWait.totalSec, [best.totalSec, abWait.totalSec]);
  okN('respect on Monday: no change to the optimum', Solver.solve(rMon).plans[0].totalSec === Solver.solve(mon).plans[0].totalSec);
  okN('without the option the solver ignores windows when optimising', Solver.solve(fri).plans[0].totalSec === best.totalSec);
}
{
  const geo2 = (dep, extra) => inputAt(dep, [0, 0], [0, 10], [mkPlace('A', 10, 0, { dwellMin: 5, closedWindows: winFri }), mkPlace('B', 0, 10)],
    [mkJob('a', { deliveryPlaceId: 'A' }), mkJob('b', { deliveryPlaceId: 'B' })], extra);
  const adv = Solver.solve(geo2(FRI)).plans[0];
  const res = Solver.solve(geo2(FRI, { respectClosedWindows: true })).plans[0];
  okN('advisory: best is A,B and A is flagged CLOSED', adv.order.join() === 'A,B' && adv.stops[0].closedWarning === true, adv.order.join());
  okN('respect: waiting (10 min) is cheaper than reordering, so it WAITS at A', res.order.join() === 'A,B' && res.stops[0].waitSec === 600, [res.order.join(), res.stops[0].waitSec]);
  okN('respect: dwell starts after the wait (arrive 09:20, 5 min dwell)', hm(res.stops[0].arriveAt) === '9:20' && res.stops[0].departAt - res.stops[0].arriveAt === 300000);
  okN('respect: total = advisory total + wait', res.totalSec === adv.totalSec + 600, [res.totalSec, adv.totalSec]);
}

// 13. retime
console.log('retime');
{
  const coords = { A: [10, 0], B: [10, 10], C: [0, 10] };
  const pl = ['A', 'B', 'C'].map((id) => mkPlace(id, coords[id][0], coords[id][1], { dwellMin: 5 }));
  const jobs = ['A', 'B', 'C'].map((id) => mkJob('j' + id, { deliveryPlaceId: id }));
  const input = inputAt(DEP, [0, 0], [0, 0], pl, jobs);
  const plan = Solver.solve(input).plans[0];
  const legMs = (p, q) => Math.round(Math.hypot(p[0] - q[0], p[1] - q[1]) * 60) * 1000;
  const at = (min) => new Date(DEP.getTime() + min * 60000).toISOString();
  const orig = JSON.stringify(plan.stops);
  const [c0, c1, c2] = plan.order.map((id) => coords[id]);

  const r1 = Solver.retime(plan, -1, at(20));
  okN('retime: order unchanged', r1.order.join() === plan.order.join() && r1.stops.map((s) => s.placeId).join() === plan.stops.map((s) => s.placeId).join());
  okN('retime from start 20 min later: every ETA shifts by exactly 20 min', r1.stops.every((s, i) => s.arriveAt - plan.stops[i].arriveAt === 1200000 && s.departAt - plan.stops[i].departAt === 1200000));
  okN('retime: end arrival and total follow', r1.endArrival - plan.endArrival === 1200000 && r1.totalSec - plan.totalSec === 1200);
  okN('retime is pure (input plan not modified)', JSON.stringify(plan.stops) === orig);

  const p2 = structuredClone(plan); p2.stops[0].status = 'done'; p2.stops[0].doneAt = at(35);
  const r2 = Solver.retime(p2, 0, at(40));
  okN('done stop is untouched', r2.stops[0].arriveAt === plan.stops[0].arriveAt && r2.stops[0].departAt === plan.stops[0].departAt && r2.stops[0].status === 'done');
  okN('next stop arrives at now + leg from the done stop', r2.stops[1].arriveAt === DEP.getTime() + 40 * 60000 + legMs(c0, c1), [r2.stops[1].arriveAt, DEP.getTime() + 40 * 60000 + legMs(c0, c1)]);
  okN('dwell applied (5 min) after arrival', r2.stops[1].departAt - r2.stops[1].arriveAt === 300000);
  okN('following stop continues from the previous departure', r2.stops[2].arriveAt === r2.stops[1].departAt + legMs(c1, c2));
  okN('end arrival = last departure + leg to the end', r2.endArrival === r2.stops[2].departAt + legMs(c2, [0, 0]));
  okN('order unchanged when retiming from a done stop', r2.order.join() === plan.order.join());

  const p3 = structuredClone(plan); p3.stops[1].status = 'skipped';
  const r3 = Solver.retime(p3, -1, at(0));
  okN('skipped stop untouched and bypassed (next stop timed from the stop before it)', r3.stops[1].arriveAt === plan.stops[1].arriveAt && r3.stops[2].arriveAt === r3.stops[0].departAt + legMs(c0, c2), r3.stops.map((s) => hm(s.arriveAt)));

  const input2 = inputAt(DEP, [0, 0], [0, 0], pl, jobs, null, [1, 1.5, 2]);
  const plan2 = Solver.solve(input2).plans[0];
  const first = coords[plan2.order[0]];
  const r4 = Solver.retime(plan2, -1, at(120));
  okN('nearest-slice rule: at +2 h the +2 h matrix (x1.5) is used', r4.stops[0].arriveAt === DEP.getTime() + 120 * 60000 + Math.round(Math.hypot(first[0], first[1]) * 60 * 1.5) * 1000);
  const r5 = Solver.retime(plan2, -1, at(0));
  okN('nearest-slice rule: at +0 h the first matrix (x1) is used', r5.stops[0].arriveAt === DEP.getTime() + Math.round(Math.hypot(first[0], first[1]) * 60) * 1000);

  const jobsAf = [mkJob('jA', { deliveryPlaceId: 'A', arriveAfter: '12:00' }), mkJob('jB', { deliveryPlaceId: 'B' }), mkJob('jC', { deliveryPlaceId: 'C' })];
  const planAf = Solver.solve(inputAt(DEP, [0, 0], [0, 0], pl, jobsAf)).plans[0];
  const sA = Solver.retime(planAf, -1, at(30)).stops.find((s) => s.placeId === 'A');
  okN('arriveAfter still applies after retime (waits for 12:00)', new Date(sA.arriveAt).getHours() >= 12 && sA.waitSec > 0, hm(sA.arriveAt));

  const winAll = [{ days: [5], from: '00:00', to: '23:59' }];
  const planW = Solver.solve(inputAt(MON, [0, 0], [0, 0], pl.map((p) => Object.assign({}, p, { closedWindows: winAll })), jobs)).plans[0];
  okN('Monday plan: no CLOSED for a Friday-only window', planW.stops.every((s) => !s.closedWarning));
  okN('retime on a Friday: CLOSED recomputed from the weekday of the new arrival', Solver.retime(planW, -1, FRI.toISOString()).stops.every((s) => s.closedWarning));

  const sub = Solver.reindexMatrices(input.matrices, [0, 2, 4]);
  okN('reindexMatrices keeps the right cells (start, stop 2, end)', sub.length === 3 && sub[0].m.length === 3 && sub[0].m[0][1] === input.matrices[0].m[0][2] && sub[0].m[1][2] === input.matrices[0].m[2][4] && sub[0].m[1][1] === 0 && sub[1].departAt === input.matrices[1].departAt && sub[0].fetchedAt === input.matrices[0].fetchedAt);
  let threw = false; try { Solver.retime({ stops: [] }, -1, at(0)); } catch (e) { threw = true; }
  okN('retime refuses a plan without a model', threw);
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
