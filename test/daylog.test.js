'use strict';
const DL = require('../daylog.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const near = (a, b, name) => ok(a != null && Math.abs(a - b) < 1e-6, name, { got: a, want: b });

// ---- world: all times are Asia/Kuala_Lumpur (UTC+8) on 20 Nov 2026 unless a day offset is given ----
const DATE = '2026-11-20';
const T = (h, m, dayOffset) => new Date(Date.UTC(2026, 10, 20 + (dayOffset || 0), h - 8, m || 0)).toISOString();
const START = { lat: 3.00, lng: 101.00 };
const places = {
  A: { id: 'A', name: 'Acme Supplies Sdn Bhd', lat: 3.01, lng: 101.01 },
  B: { id: 'B', name: 'Beta Customer', lat: 3.02, lng: 101.02 },
  C: { id: 'C', name: 'Cee Factory', lat: 3.03, lng: 101.03 },
  D: { id: 'D', name: 'Delta Works', lat: 3.04, lng: 101.04 },
  E: { id: 'E', name: 'Echo Bank', lat: 3.05, lng: 101.05 },
};
const mkJobs = () => [
  { id: 'j1', pickups: [{ placeId: 'A', item: 'Sensor, 2 pcs', done: false }], deliveryPlaceId: 'B', notes: 'ring first', urgent: true, urgentRank: 1, arriveBefore: '11:00', status: 'pending' },
  { id: 'j2', pickups: [{ placeId: 'A', item: 'Valve', done: false }, { placeId: 'C', item: 'Pump', done: false }], deliveryPlaceId: 'D', notes: '', urgent: false, urgentRank: 0, arriveBefore: null, status: 'pending' },
  { id: 'j3', pickups: [], deliveryPlaceId: null, errandPlaceId: 'E', dwellMin: 10, notes: 'Pay bill', urgent: false, urgentRank: 0, arriveBefore: null, status: 'pending' },
  { id: 'j4', pickups: [], inHandItem: 'Gasket', deliveryPlaceId: 'B', notes: '', urgent: false, urgentRank: 0, arriveBefore: null, status: 'pending' },
];
const PLAN_ORDER = ['A', 'B', 'C', 'D', 'E'];
function mkDay(jobs, o) {
  o = o || {};
  const day = DL.newDay({ date: o.date || DATE, driverId: o.driver || 'Calvin' });
  DL.recordPlan(day, { nowIso: o.planAt || T(9, 0), start: START, departAtIso: o.departAt || o.planAt || T(9, 0), jobs: o.planJobs || jobs, places, stopOrder: o.order || PLAN_ORDER, plannedKm: 30, plannedDriveMin: 60 });
  return day;
}
const act = (jobId, kind, item) => ({ jobId, kind, item: item || '' });
function done(day, stopId, actions, h, m, dayOffset) { return DL.recordDone(day, { nowIso: T(h, m, dayOffset), stopId, actions, places }); }
function doEverything(day) { // tap order A, C, B, D, E
  done(day, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs'), act('j2', 'pickup', 'Valve')], 9, 20);
  done(day, 'C', [act('j2', 'pickup', 'Pump')], 9, 50);
  done(day, 'B', [act('j1', 'deliver', 'Sensor, 2 pcs'), act('j4', 'deliver', '')], 10, 30);
  done(day, 'D', [act('j2', 'deliver', 'Valve, Pump')], 11, 15);
  done(day, 'E', [act('j3', 'errand', 'Pay bill')], 11, 45);
}
function legsFor(day, seq, perLegM, perLegS) { // seed per-leg metres/seconds "held from routing"
  const pts = [START].concat(seq.map((id) => places[id]));
  for (let i = 0; i + 1 < pts.length; i++) day.legs[DL.legKey(pts[i], pts[i + 1])] = { m: perLegM, s: perLegS };
}

console.log('summarise: counts and sections');
{
  const jobs = mkJobs(), day = mkDay(jobs);
  doEverything(day);
  legsFor(day, ['A', 'C', 'B', 'D', 'E'], 5000, 600);
  const s = DL.summarise(day, jobs, places);
  ok(s.jobsDone === 4 && s.jobsTotal === 4, 'all done: 4 of 4', [s.jobsDone, s.jobsTotal]);
  ok(s.notDone.length === 0 && s.stillWithYou.length === 0, 'all done: nothing left in Not done / Still with you');
  ok(s.stopsVisited === 5, 'all done: 5 stops visited', s.stopsVisited);
  ok(s.collected.length === 3 && s.delivered.length === 3 && s.errands.length === 1, 'collected 3 / delivered 3 / errand 1', [s.collected.length, s.delivered.length, s.errands.length]);
  ok(s.collected[0].place === 'Acme Supplies' && s.collected[0].item === 'Sensor, 2 pcs', 'collected row: item + supplier (company suffix trimmed)', s.collected[0]);
  eq(s.rows.map((r) => r.type), ['delivery', 'delivery', 'errand', 'in-hand'], 'job types: delivery, multi-pickup delivery, errand, in-hand');
  near(s.km.value, 25, 'km = sum of held legs (5 legs x 5 km)');
  ok(s.km.status === 'ok' && !s.route.needs, 'km status ok, no routing request needed');
  near(s.driveMin, 50, 'drive time = sum of leg durations (5 x 10 min), estimated');
  near(s.hoursOutMin, 165, 'hours out = last DONE (11:45) - first plan depart (09:00)');
  near(s.atStopsMin, 115, 'at stops/other = hours out - drive time');
}

console.log('summarise: none done / collected-not-delivered / errand-only / in-hand');
{
  const jobs = mkJobs(), day = mkDay(jobs);
  const s = DL.summarise(day, jobs, places);
  ok(s.jobsDone === 0 && s.jobsTotal === 4 && s.notDone.length === 4, 'none done: 0 of 4, all four listed as not done');
  ok(s.km.status === 'none' && s.hoursOutMin === null && s.stopsVisited === 0, 'none done: no km, no hours-out, no stops');
  ok(s.stillWithYou.length === 1 && s.stillWithYou[0].jobId === 'j4', 'none done: only the in-hand job is "still with you"');
}
{
  const jobs = mkJobs(), day = mkDay(jobs);
  done(day, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs'), act('j2', 'pickup', 'Valve')], 9, 20);
  const s = DL.summarise(day, jobs, places);
  ok(s.stillWithYou.some((r) => r.jobId === 'j1') && s.stillWithYou.some((r) => r.jobId === 'j2'), 'collected-not-delivered: j1 (all) and j2 (partly) are still with you');
  ok(s.notDone.some((r) => r.jobId === 'j1' && r.withYou), 'collected-not-delivered: j1 also listed in Not done (flagged WITH YOU)');
  ok(s.jobsDone === 0, 'collected-not-delivered is not a done job');
}
{
  const jobs = [mkJobs()[2]], day = mkDay(jobs, { order: ['E'] });
  done(day, 'E', [act('j3', 'errand', 'Pay bill')], 10, 5);
  const s = DL.summarise(day, jobs, places);
  ok(s.jobsDone === 1 && s.jobsTotal === 1 && s.errands.length === 1 && s.collected.length === 0 && s.delivered.length === 0, 'errand-only day: 1 of 1, only Errands section filled');
  ok(s.errands[0].item === 'Pay bill' && s.errands[0].place === 'Echo Bank', 'errand row: item + place');
}
{
  const jobs = [mkJobs()[3]], day = mkDay(jobs, { order: ['B'] });
  let s = DL.summarise(day, jobs, places);
  ok(s.rows[0].type === 'in-hand' && s.rows[0].item === 'Gasket' && s.stillWithYou.length === 1, 'deliver-only (in-hand) job: type in-hand, item kept, still with you');
  done(day, 'B', [act('j4', 'deliver', '')], 10, 0);
  s = DL.summarise(day, jobs, places);
  ok(s.jobsDone === 1 && s.delivered[0].item === 'Gasket' && s.stillWithYou.length === 0, 'deliver-only job delivered: item name comes from the job');
}

console.log('undo / replans / order');
{
  const jobs = mkJobs(), day = mkDay(jobs);
  done(day, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20);
  done(day, 'B', [act('j1', 'deliver', 'Sensor, 2 pcs')], 10, 30);
  ok(DL.summarise(day, jobs, places).jobsDone === 1, 'before undo: j1 done');
  DL.recordUndo(day, { nowIso: T(10, 40), stopId: 'B' });
  const s = DL.summarise(day, jobs, places);
  ok(s.jobsDone === 0 && s.delivered.length === 0 && s.stopsVisited === 1, 'undo after done: delivery cancelled, summary recomputed', [s.jobsDone, s.delivered.length, s.stopsVisited]);
  ok(s.stillWithYou.some((r) => r.jobId === 'j1'), 'undo after done: j1 is back to "still with you"');
  near(s.finishedAt, Date.parse(T(9, 20)), 'undo after done: finish time falls back to the previous DONE');
  done(day, 'B', [act('j1', 'deliver', 'Sensor, 2 pcs')], 10, 50);
  ok(DL.summarise(day, jobs, places).jobsDone === 1, 'redo after undo counts the new DONE once');
}
{
  const jobs = mkJobs(), day = mkDay(jobs);
  doEverything(day);
  DL.recordPlan(day, { nowIso: T(10, 0), replan: true, start: START, departAtIso: T(10, 0), jobs, places, stopOrder: PLAN_ORDER });
  DL.recordPlan(day, { nowIso: T(10, 30), replan: true, start: START, departAtIso: T(10, 30), jobs, places, stopOrder: PLAN_ORDER });
  DL.recordPlan(day, { nowIso: T(11, 0), replan: false, start: START, departAtIso: T(11, 0), jobs, places, stopOrder: PLAN_ORDER });
  const s = DL.summarise(day, jobs, places);
  ok(s.plan.replans === 3, 'replan count: 2 replan events + 1 extra PLAN after the first = 3', s.plan.replans);
  eq(day.planSnapshot.stopOrder, PLAN_ORDER, 'planSnapshot keeps the FIRST plan (later plans do not overwrite it)');
  ok(day.events.filter((e) => e.type === 'plan').length === 2 && day.events.filter((e) => e.type === 'replan').length === 2, 'event types recorded as plan / replan');
}
{
  const jobs = mkJobs(), day = mkDay(jobs);
  doEverything(day); // tapped A, C, B, D, E vs planned A, B, C, D, E
  ok(DL.summarise(day, jobs, places).plan.outOfOrder === 1, 'out-of-order count: one stop out of the first plan\'s order', DL.summarise(day, jobs, places).plan);
  const d2 = mkDay(jobs);
  done(d2, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20); done(d2, 'B', [act('j1', 'deliver', 'x')], 10, 0); done(d2, 'C', [act('j2', 'pickup', 'Pump')], 10, 30);
  ok(DL.summarise(d2, jobs, places).plan.outOfOrder === 0, 'out-of-order count: in planned order = 0');
  const d3 = mkDay(jobs, { order: ['A', 'B'] });
  done(d3, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20); done(d3, 'D', [act('j2', 'deliver', 'x')], 10, 0);
  ok(DL.summarise(d3, jobs, places).plan.outOfOrder === 1, 'out-of-order count: a stop that was not in the first plan counts');
}

console.log('late / urgent / edits / midnight');
{
  const jobs = mkJobs(), day = mkDay(jobs); // j1 arrive-before 11:00
  done(day, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20);
  done(day, 'B', [act('j1', 'deliver', 'Sensor, 2 pcs')], 11, 10);
  let s = DL.summarise(day, jobs, places);
  ok(s.delivered[0].late === true, 'late: DONE 11:10 after arrive-before 11:00 is LATE');
  const d2 = mkDay(jobs);
  done(d2, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20); done(d2, 'B', [act('j1', 'deliver', 'Sensor, 2 pcs')], 10, 59);
  ok(DL.summarise(d2, jobs, places).delivered[0].late === false, 'late: DONE 10:59 inside the window is not late');
  const d3 = mkDay(jobs);
  done(d3, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20); done(d3, 'B', [act('j1', 'deliver', 'Sensor, 2 pcs')], 11, 0);
  ok(DL.summarise(d3, jobs, places).delivered[0].late === false, 'late: DONE exactly at 11:00 is not late');
  ok(s.delivered[0].urgent === true && s.rows.find((r) => r.jobId === 'j1').urgent, 'urgent flag carried onto the delivered row');
  const live = mkJobs(); live[0].urgent = false;
  ok(DL.summarise(day, live, places).delivered[0].urgent === false, 'urgent flag follows the live job (cleared later = not urgent)');
}
{
  const jobs = mkJobs(), day = mkDay(jobs);
  doEverything(day);
  day.edits.startedAt = T(8, 30);
  day.edits.finishedAt = T(12, 0);
  const s = DL.summarise(day, jobs, places);
  near(s.hoursOutMin, 210, 'edited start 08:30 + finish 12:00 -> 3 h 30 min out');
  ok(s.startedSource === 'edited', 'started source reports "edited"');
  day.edits = {};
  near(DL.summarise(day, jobs, places).hoursOutMin, 165, 'reset edits -> back to measured');
}
{
  const jobs = mkJobs(), day = mkDay(jobs, { planAt: T(22, 0), departAt: T(22, 0) });
  jobs[0].arriveBefore = '23:45';
  done(day, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 23, 30);
  done(day, 'B', [act('j1', 'deliver', 'Sensor, 2 pcs')], 0, 10, 1); // 00:10 on 21 Nov
  done(day, 'D', [act('j4', 'deliver', '')], 0, 40, 1);
  const s = DL.summarise(day, jobs, places);
  ok(day.date === '2026-11-20' && s.date === '2026-11-20', 'day crossing midnight stays on its start date');
  near(s.hoursOutMin, 160, 'day crossing midnight: 22:00 -> 00:40 = 2 h 40 min');
  ok(s.delivered.find((d) => d.jobId === 'j1').late === true, 'day crossing midnight: DONE 00:10 is after the 23:45 window -> LATE');
  ok(DL.dateKey(Date.parse(T(0, 10, 1))) === '2026-11-21' && DL.dateKey(Date.parse('2026-11-20T15:59:00Z')) === '2026-11-20' && DL.dateKey(Date.parse('2026-11-20T16:00:00Z')) === '2026-11-21', 'dateKey uses Asia/Kuala_Lumpur (UTC+8) day boundaries');
}

console.log('km / drive time');
{
  const jobs = mkJobs(), day = mkDay(jobs);
  doEverything(day); // no legs held, nothing routed
  let s = DL.summarise(day, jobs, places);
  ok(s.km.status === 'unavailable' && s.km.value === null && s.route.needs, 'km unavailable: no held legs and no routed result -> unavailable (never straight-line)');
  ok(s.driveMin === null && s.atStopsMin === null && s.hoursOutMin != null, 'km unavailable: drive/at-stops unknown, hours out still measured');
  ok(s.route.points.length === 6 && s.route.points[0].lat === START.lat, 'route request covers start + 5 stops in DONE order (6 points)');
  day.routed = { key: s.route.key, legs: [1, 2, 3, 4, 5].map((k) => ({ m: k * 1000, s: k * 60 })), at: T(18, 0) };
  s = DL.summarise(day, jobs, places);
  near(s.km.value, 15, 'one routed response fills every leg (1+2+3+4+5 km)');
  near(s.driveMin, 15, 'routed durations sum to drive time (est.)');
  day.routed.key = 'stale';
  ok(DL.summarise(day, jobs, places).km.status === 'unavailable', 'a routed result for a different sequence is ignored (e.g. after an undo)');
}
{
  const jobs = mkJobs(), day = mkDay(jobs);
  done(day, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20);
  done(day, 'B', [act('j1', 'deliver', 'Sensor, 2 pcs')], 9, 40);
  legsFor(day, ['A', 'B'], 4000, 300);
  day.legs[DL.legKey(START, places.A)] = { m: 4000, s: 7200 }; // 2 h of driving but only 40 min out
  const s = DL.summarise(day, jobs, places);
  ok(s.atStopsMin === 0 && s.driveMin > s.hoursOutMin, 'at stops/other is floored at 0 when estimated drive exceeds hours out', [s.atStopsMin, s.driveMin, s.hoursOutMin]);
}
{
  const matrices = [{ departAt: T(9, 0), m: [[0, 600, 900], [600, 0, 300], [900, 300, 0]], d: [[0, 5000, 8000], [5000, 0, 2500], [8000, 2500, 0]] }, { departAt: T(11, 0), m: [[0, 700, 1000], [700, 0, 400], [1000, 400, 0]], d: [[0, 5100, 8100], [5100, 0, 2600], [8100, 2600, 0]] }];
  const pts = [START, places.A, places.B];
  const leg = DL.legFromMatrices(matrices, pts, places.A, places.B, Date.parse(T(9, 10)));
  ok(leg && leg.m === 2500 && leg.s === 300, 'legFromMatrices: exact pair, nearest slice');
  ok(DL.legFromMatrices(matrices, pts, places.A, places.C, 0) === null, 'legFromMatrices: pair not in the matrices -> null (no guessing)');
  const pk = DL.plannedFromMatrices(matrices, pts, [START, places.A, places.B], Date.parse(T(9, 0)));
  near(pk.plannedKm, 7.5, 'plannedFromMatrices: km'); near(pk.plannedDriveMin, 15, 'plannedFromMatrices: drive minutes');
  const noD = DL.plannedFromMatrices([{ departAt: T(9, 0), m: matrices[0].m }], pts, [START, places.A], 0);
  ok(noD.plannedKm === null && noD.plannedDriveMin === 10, 'plannedFromMatrices: no distances held -> km null');
  const day = mkDay(mkJobs());
  DL.captureLeg(day, START, places.A, matrices, pts, Date.parse(T(9, 0)));
  ok(day.legs[DL.legKey(START, places.A)].m === 5000, 'captureLeg stores the held leg on the day record');
}

console.log('missing geolocation');
{
  const jobs = mkJobs(), day = mkDay(jobs);
  const evs = done(day, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20);
  ok(evs.every((e) => e.lat === null && e.lng === null && e.accuracy === null), 'DONE events carry null lat/lng/accuracy when no fix was granted');
  ok(DL.summarise(day, jobs, places).stopsVisited === 1, 'summary works without any geolocation fix');
  evs.forEach((e) => { e.lat = 3.01; e.lng = 101.01; e.accuracy = 12; }); // fix arrives later
  ok(DL.summarise(day, jobs, places).stopsVisited === 1 && day.events.find((e) => e.type === 'done').accuracy === 12, 'a fix patched in later is stored on the event');
}

console.log('carry forward / close / reopen');
{
  const jobs = mkJobs(), day = mkDay(jobs);
  done(day, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20); // collected, not delivered; j2 half collected
  day.decisions.j1 = { reason: 'Customer postponed', carry: true };
  day.decisions.j3 = { reason: 'Ran out of time', carry: false };
  const before = jobs.length;
  const changed = DL.closeDay(day, jobs, places, T(18, 0));
  const j1 = jobs.find((j) => j.id === 'j1');
  ok(day.closed && day.endedAt === T(18, 0) && day.events[day.events.length - 1].type === 'endday', 'close day: closed, endedAt set, endday event written');
  ok(j1.pickups.length === 0 && j1.inHandItem === 'Sensor, 2 pcs' && j1.deliveryPlaceId === 'B' && j1.status === 'pending', 'collected-not-delivered carries as an in-hand deliver-only job');
  ok(j1.urgent === true && j1.notes === 'ring first' && j1.carryReason === 'Customer postponed' && j1.carriedFrom === DATE, 'carried job keeps item, notes, urgent flag and the reason');
  const j3 = jobs.find((j) => j.id === 'j3');
  ok(j3.status === 'dropped' && day.carried.some((c) => c.jobId === 'j3' && c.mode === 'dropped'), 'carry toggle off: job is not carried and is recorded as dropped in the day record');
  const j2 = jobs.find((j) => j.id === 'j2');
  ok(j2.status === 'pending' && j2.pickups.length === 2, 'partly collected job stays as it was (still pending, both pickups kept)');
  ok(jobs.length === before && changed.length === 4, 'carry-forward edits jobs in place: no copies', [jobs.length, changed.length]);
  // second close
  const snapshot = JSON.stringify(jobs);
  const again = DL.closeDay(day, jobs, places, T(19, 0));
  ok(again.length === 0 && JSON.stringify(jobs) === snapshot && day.events.filter((e) => e.type === 'endday').length === 1, 'no duplicate after two closes: second close changes nothing');
  // next day: the carried job exists exactly once
  ok(jobs.filter((j) => j.carriedFrom === DATE && j.id === 'j1').length === 1 && jobs.filter((j) => (j.status || 'pending') === 'pending' && j.deliveryPlaceId === 'B' && j.inHandItem === 'Sensor, 2 pcs').length === 1, 'next day: the carried job is present exactly once');
  // undo after close
  const re = DL.reopenDay(day, jobs, T(18, 30));
  ok(!day.closed && day.endedAt === null && day.carried.length === 0 && re.length === 4, 'undo after close: day reopened');
  ok(j1.pickups.length === 1 && j1.pickups[0].item === 'Sensor, 2 pcs' && !j1.inHandItem && j1.carriedFrom === undefined && j3.status === 'pending', 'undo after close: in-hand conversion and drop are reversed exactly');
  const s = DL.summarise(day, jobs, places);
  ok(s.stillWithYou.some((r) => r.jobId === 'j1') && s.notDone.length === 4, 'undo after close: summary recomputes (j1 still with you, 4 not done)');
  const closedAgain = DL.closeDay(day, jobs, places, T(20, 0));
  ok(day.closed && closedAgain.length > 0, 'a reopened day can be closed again');
}
{
  const jobs = mkJobs(), day = mkDay(jobs);
  done(day, 'B', [act('j4', 'deliver', '')], 9, 30);
  const j2 = jobs.find((j) => j.id === 'j2');
  DL.closeDay(day, jobs, places, T(18, 0));
  const j4 = jobs.find((j) => j.id === 'j4');
  ok(j4.status !== 'dropped' && j2.carriedFrom === DATE && j2.pickups.length === 2, 'untouched job with carry ON stays pending with carriedFrom set');
  const dayN = mkDay([j2].concat(jobs.filter((j) => j.carriedFrom)), { date: '2026-11-21', planJobs: [j2] });
  ok(dayN.jobsSnap.j2 && Object.keys(dayN.jobsSnap).length === 1, 'next day\'s record only snapshots the jobs planned that day');
}

console.log('retention / history');
{
  const today = '2026-11-20';
  const keys = [DL.addDaysKey(today, 0), DL.addDaysKey(today, -119), DL.addDaysKey(today, -120), DL.addDaysKey(today, -121), '2025-01-01'];
  eq(DL.pruneDates(keys, today).sort(), [DL.addDaysKey(today, -120), DL.addDaysKey(today, -121), '2025-01-01'].sort(), '120-day prune: today..119 days old kept, 120+ pruned');
  ok(DL.KEEP_DAYS === 120, 'retention constant is 120 days');
  eq(DL.historyKeys(['2026-11-20', '2026-10-22', '2026-10-21', '2026-11-19'], today, 30), ['2026-11-20', '2026-11-19', '2026-10-22'], 'history list: last 30 days, newest first');
}
{
  const rows = [
    { date: '2026-11-29', jobsDone: 9, jobsTotal: 9, km: 100, hoursOutMin: 600 },  // Sunday before the week
    { date: '2026-11-30', jobsDone: 3, jobsTotal: 4, km: 40, hoursOutMin: 300 },   // Mon (Nov)
    { date: '2026-12-02', jobsDone: 2, jobsTotal: 2, km: 20.5, hoursOutMin: 120 }, // Wed (Dec)
    { date: '2026-12-06', jobsDone: 1, jobsTotal: 1, km: null, hoursOutMin: 60 },  // Sun, km unavailable
    { date: '2026-12-07', jobsDone: 5, jobsTotal: 5, km: 50, hoursOutMin: 500 },   // next Monday
  ];
  const w = DL.weekTotals(rows, '2026-12-02');
  ok(w.from === '2026-11-30' && w.to === '2026-12-06', 'week totals: Mon-Sun range across a month boundary', w);
  ok(w.days === 3 && w.jobsDone === 6 && w.jobsTotal === 7 && Math.abs(w.km - 60.5) < 1e-9 && w.hoursOutMin === 480 && w.kmMissing === 1, 'week totals: sums only that week, flags the day without km', w);
  ok(DL.weekRange('2026-11-29').from === '2026-11-23' && DL.weekRange('2026-11-29').to === '2026-11-29', 'week range: a Sunday belongs to the week that started the Monday before');
}

console.log('export');
{
  const jobs = mkJobs();
  jobs[3].inHandItem = 'Gasket, "big" 10mm';
  const day = mkDay(jobs);
  done(day, 'A', [act('j1', 'pickup', 'Sensor, 2 pcs')], 9, 20);
  done(day, 'B', [act('j1', 'deliver', 'Sensor, 2 pcs')], 10, 30);
  day.decisions.j2 = { reason: 'Item not ready', carry: false };
  const s = DL.summarise(day, jobs, places);
  const csv = DL.toCSV(s);
  const lines = csv.trim().split('\r\n');
  ok(lines.length === 1 + s.rows.length && s.rows.length === 4, 'CSV: header + one row per job (4 jobs)', lines.length);
  ok(lines[0] === 'date,driver,type,item,from,to,done time,status,reason,urgent,late', 'CSV header columns');
  ok(lines[1].startsWith('20 Nov 2026,Calvin,delivery,"Sensor, 2 pcs",Acme Supplies,Beta Customer,10:30,done,,yes,'), 'CSV: comma in item name is quoted; dd Mmm yyyy; 24-hour time', lines[1]);
  ok(csv.includes('"Gasket, ""big"" 10mm"'), 'CSV: embedded quotes doubled, field quoted');
  ok(lines[2].includes('not done - dropped') && lines[2].includes('Item not ready'), 'CSV: dropped job shows status and reason', lines[2]);
  ok(DL.csvCell('a\nb') === '"a\nb"' && DL.csvCell('plain') === 'plain' && DL.csvCell(null) === '', 'csvCell escaping rules');
  const wa = DL.toWhatsApp(s);
  ok(wa.indexOf('*Totals*') < wa.indexOf('*Collected*') && wa.indexOf('*Collected*') < wa.indexOf('*Delivered*') && /^\*Waypoint day summary - 20 Nov 2026\*/.test(wa), 'WhatsApp text: bold headings, totals first');
  ok(wa.includes('- 10:30 Sensor, 2 pcs - Beta Customer [URGENT]') && wa.includes('Est. km (road route between stops, not odometer): unavailable'), 'WhatsApp text: one line per job, urgent flag, km label');
}
{
  ok(DL.fmtDate('2026-01-05') === '05 Jan 2026' && DL.fmtDur(95) === '1 h 35 min' && DL.fmtDur(null) === '—' && DL.fmtTime(Date.parse('2026-11-20T16:05:00Z')) === '00:05', 'formats: dd Mmm yyyy, h/min, 24-hour KL time');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
