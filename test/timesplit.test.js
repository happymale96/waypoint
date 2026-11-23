'use strict';
// Travel time from the navigation tap: Reached.daySplit's four buckets (between stops / driving / on site / lunch), the
// summary line and per-stop line, and the day-log fields behind them. Run as its own node script: node test/timesplit.test.js
const Reached = require('../reached.js');
const DL = require('../daylog.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, name) => ok(a != null && Math.abs(a - b) < 1e-6, name, { got: a, want: b });
const MIN = 60000;
const at = (h, m) => new Date(2030, 0, 15, h, m, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();
const hm = (ms) => DL.fmtTime(ms);
const sumOf = (t) => t.betweenMin + t.driveMin + t.onSiteMin + t.lunchMin;
// a done stop: nav / reached / done as "HH:MM" (null = missing)
const st = (nav, arr, done, dwell, more) => Object.assign({ navStartedAt: nav ? at(...nav) : null, reachedAt: arr ? at(...arr) : null, doneAt: iso(at(...done)), dwellMin: dwell == null ? 10 : dwell }, more || {});
const START = at(13, 0);

console.log('all taps present');
{
  const r = Reached.daySplit([st([13, 12], [13, 30], [13, 52]), st([14, 0], [14, 10], [14, 32])], START);
  const [a, b] = r.stops;
  near(a.betweenMin, 12, 'stop 1: between = nav - day start (12 min)');
  near(a.driveMin, 18, 'stop 1: driving = arrival - nav (18 min)');
  near(a.onSiteMin, 22, 'stop 1: on site = done - arrival (22 min)');
  near(b.betweenMin, 8, 'stop 2: between = nav - previous done (8 min)');
  near(b.driveMin, 10, 'stop 2: driving 10 min');
  near(b.onSiteMin, 22, 'stop 2: on site 22 min');
  ok(!a.splitEstimated && !b.splitEstimated && !r.totals.anySplitEstimated && !r.totals.anyEstimated, 'nothing estimated');
  near(r.totals.betweenMin, 20, 'total between stops 20 min');
  near(r.totals.driveMin, 28, 'total driving 28 min');
  near(r.totals.onSiteMin, 44, 'total on site 44 min');
  near(r.totals.lunchMin, 0, 'no break: lunch 0');
  near(sumOf(r.totals), r.totals.totalMin, 'buckets sum to the total time out (92 min)');
  near(r.totals.totalMin, 92, 'total time out = 13:00 -> 14:32');
  ok(a.prevDepartMs === START && b.prevDepartMs === at(13, 52) && b.navMs === at(14, 0), 'per stop: previous departure and nav time');
}

console.log('no navigation tap');
{
  const r = Reached.daySplit([st([13, 12], [13, 30], [13, 52]), st(null, [14, 10], [14, 32])], START);
  const b = r.stops[1];
  near(b.betweenMin, 0, 'no nav tap: between = 0');
  near(b.driveMin, 18, 'no nav tap: driving = arrival - previous departure (18 min)');
  ok(b.navMissing && b.splitEstimated && !b.estimated, 'flagged estimated (the split), the arrival itself is real', b);
  ok(r.totals.anySplitEstimated && !r.stops[0].splitEstimated, 'totals: part estimated; stop 1 is not');
  near(sumOf(r.totals), r.totals.totalMin, 'buckets still sum to the total');
}

console.log('nav tapped twice: the first tap counts');
{
  let s = { placeId: 'B', actions: [] };
  s = Reached.stampNav(s, at(13, 55), at(13, 52));
  s = Reached.stampNav(s, at(14, 3), at(13, 52));
  ok(s.navStartedAt === at(13, 55), 'the stored tap is the first (13:55)');
  const r = Reached.daySplit([st([13, 12], [13, 30], [13, 52]), Object.assign(st(null, [14, 10], [14, 32]), { navStartedAt: s.navStartedAt })], START);
  near(r.stops[1].betweenMin, 3, 'between = 13:55 - 13:52 (3 min)');
  near(r.stops[1].driveMin, 15, 'driving = 14:10 - 13:55 (15 min)');
}

console.log('nav tap after Reached is ignored');
{
  let s = Reached.stampReached({ placeId: 'B', actions: [] }, at(14, 10), 'tap');
  s = Reached.stampNav(s, at(14, 12), at(13, 52));
  ok(s.navStartedAt === undefined, 'the tap after Reached sets nothing');
  // and a stored time after the arrival is not used for timing either
  const r = Reached.daySplit([st([13, 12], [13, 30], [13, 52]), st([14, 15], [14, 10], [14, 32])], START);
  ok(r.stops[1].navMissing && r.stops[1].navMs === null, 'a nav time after the arrival is ignored', r.stops[1]);
  near(r.stops[1].driveMin, 18, 'driving then runs from the previous departure (18 min)');
  // a stale tap from before the previous departure is not used
  const r2 = Reached.daySplit([st([13, 12], [13, 30], [13, 52]), st([13, 40], [14, 10], [14, 32])], START);
  ok(r2.stops[1].navMissing, 'a nav time before the previous departure is ignored');
}

console.log('first stop of the day');
{
  const r = Reached.daySplit([st([13, 25], [13, 45], [14, 0])], START);
  near(r.stops[0].betweenMin, 25, 'first stop: between = nav - the day start (25 min)');
  near(r.stops[0].driveMin, 20, 'first stop: driving 20 min');
  ok(Reached.stopLine(r.stops[0], 2, hm) === 'left prev 13:00 · nav 13:25 · arr 13:45 · done 14:00', 'per stop line', Reached.stopLine(r.stops[0], 2, hm));
  const r2 = Reached.daySplit([st(null, null, [14, 0], 15)], START);
  ok(Reached.stopLine(r2.stops[0], 2, hm) === 'left prev 13:00 · arr ~13:45 · done 14:00', 'no nav, estimated arrival: nav left out, "~" on arr', Reached.stopLine(r2.stops[0], 2, hm));
  ok(r2.stops[0].estimated && r2.stops[0].splitEstimated, 'estimated arrival -> estimated split');
}

console.log('end-point leg');
{
  const r = Reached.daySplit([st([13, 12], [13, 30], [13, 52])], START, { endNavStartedAt: at(14, 0), endArrivedAt: at(14, 30) });
  near(r.totals.endBetweenMin, 8, 'end: between = end nav - last done (8 min)');
  near(r.totals.endDriveMin, 30, 'end: driving = ARRIVED - end nav (30 min)');
  near(r.totals.driveMin, 18 + 30, 'end leg counts in total driving');
  near(r.totals.betweenMin, 12 + 8, 'end leg counts in total between stops');
  near(sumOf(r.totals), 90, 'buckets sum to 13:00 -> 14:30');
  ok(Reached.stopLine(r.totals.end, 2, hm) === 'left prev 13:52 · nav 14:00 · arr 14:30', 'end line', Reached.stopLine(r.totals.end, 2, hm));
  const r2 = Reached.daySplit([st([13, 12], [13, 30], [13, 52])], START, { endArrivedAt: at(14, 30) });
  ok(r2.totals.endBetweenMin === 0 && Math.abs(r2.totals.endDriveMin - 38) < 1e-6 && r2.totals.anySplitEstimated, 'end without a nav tap: all driving (38 min), estimated');
}

console.log('lunch: the real break is taken out of the bucket it falls in');
{
  const stops = [st([13, 12], [13, 30], [13, 52]), st([14, 0], [14, 10], [14, 32])];
  // inside "between stops" of stop 2 (13:52 -> 14:00): 13:53 -> 13:58
  let r = Reached.daySplit(stops, START, { breakStartedAt: at(13, 53), breakEndedAt: at(13, 58) });
  near(r.stops[1].betweenMin, 3, 'between-stops lunch: between 8 - 5 = 3 min');
  near(r.totals.lunchMin, 5, 'lunch 5 min');
  near(sumOf(r.totals), 92, 'no double count (sum = 92 min)');
  // on site at stop 1 (13:30 -> 13:52): 13:35 -> 13:50
  r = Reached.daySplit(stops, START, { breakStartedAt: at(13, 35), breakEndedAt: at(13, 50) });
  near(r.stops[0].onSiteMin, 7, 'on-site lunch: on site 22 - 15 = 7 min');
  near(r.totals.lunchMin, 15, 'lunch 15 min');
  near(sumOf(r.totals), 92, 'no double count');
  // driving of stop 1 (13:12 -> 13:30): 13:15 -> 13:25
  r = Reached.daySplit(stops, START, { breakStartedAt: at(13, 15), breakEndedAt: at(13, 25) });
  near(r.stops[0].driveMin, 8, 'driving lunch: driving 18 - 10 = 8 min');
  near(sumOf(r.totals), 92, 'no double count');
  // spanning three buckets: 13:45 (on site 1) -> 14:05 (driving 2)
  r = Reached.daySplit(stops, START, { breakStartedAt: at(13, 45), breakEndedAt: at(14, 5) });
  near(r.stops[0].onSiteMin, 15, 'spanning: on site 1 loses 7 min');
  near(r.stops[1].betweenMin, 0, 'spanning: between 2 loses all 8 min');
  near(r.stops[1].driveMin, 5, 'spanning: driving 2 loses 5 min');
  near(r.totals.lunchMin, 20, 'spanning: lunch 20 min');
  near(sumOf(r.totals), r.totals.totalMin, 'buckets sum to the total time out');
  ok(r.totals.betweenMin >= 0 && r.totals.driveMin >= 0 && r.totals.onSiteMin >= 0, 'no bucket goes negative');
  // a lunch inside a no-nav drive
  r = Reached.daySplit([st(null, [13, 45], [14, 0])], START, { breakStartedAt: at(13, 10), breakEndedAt: at(13, 40) });
  near(r.stops[0].driveMin, 15, 'no-nav drive with lunch: 45 - 30 = 15 min');
  near(sumOf(r.totals), 60, 'sum = 60 min');
}

console.log('summary text and the day log');
{
  const places = { A: { id: 'A', name: 'Alpha', lat: 3.1, lng: 101.6 }, B: { id: 'B', name: 'Beta', lat: 3.2, lng: 101.7 } };
  const jobs = [{ id: 'j1', pickups: [], deliveryPlaceId: 'A', status: 'pending' }, { id: 'j2', pickups: [], deliveryPlaceId: 'B', status: 'pending' }];
  const day = DL.newDay({ date: '2030-1-15' });
  DL.recordPlan(day, { nowIso: iso(START), start: { lat: 3, lng: 101.5 }, departAtIso: iso(START), jobs, places, stopOrder: ['A', 'B'] });
  DL.recordDone(day, { nowIso: iso(at(13, 52)), stopId: 'A', actions: [{ jobId: 'j1', kind: 'deliver', item: 'x' }], places, reachedAt: at(13, 30), reachedSource: 'tap', dwellMin: 10, navStartedAt: at(13, 12) });
  DL.recordBreakStart(day, { nowIso: iso(at(13, 53)) });
  DL.recordBreakEnd(day, { nowIso: iso(at(13, 58)) });
  DL.recordDone(day, { nowIso: iso(at(15, 32)), stopId: 'B', actions: [{ jobId: 'j2', kind: 'deliver', item: 'y' }], places, reachedAt: null, dwellMin: 15 });
  const s = DL.summarise(day, jobs, places);
  ok(s.timeSplitV === 2 && s.visits[0].navStartedAt === at(13, 12) && s.visits[1].navStartedAt === null, 'the day log keeps navStartedAt per done stop', s.visits);
  ok(s.breakStartedAt === at(13, 53) && s.breakEndedAt === at(13, 58), 'the day log keeps breakStartedAt / breakEndedAt');
  const sp = Reached.splitOfSummary(s, at(16, 0));
  ok(sp.v === 2 && sp.breakTaken, 'a v2 day: four buckets');
  const line = Reached.splitLine(sp, DL.fmtDur);
  ok(/^Driving \S.* · On site \S.* · Between stops \S.* · Lunch 5 min \(part estimated\)$/.test(line), 'summary line: Driving · On site · Between stops · Lunch (part estimated)', line);
  near(sumOf(sp.totals), sp.totals.totalMin, 'summary buckets sum to the time out');
  ok(Reached.splitLine({ v: 2, breakTaken: false, totals: { driveMin: 130, onSiteMin: 107, betweenMin: 38, lunchMin: 0, anySplitEstimated: false } }, DL.fmtDur) === 'Driving 2 h 10 min · On site 1 h 47 min · Between stops 38 min', 'the spec example line');
  // a day closed before this change: no version mark -> the old card, unchanged
  const old = JSON.parse(JSON.stringify(day));
  delete old.timeSplitV; delete old.breakStartedAt; delete old.breakEndedAt;
  old.events.forEach((e) => { delete e.navStartedAt; });
  const so = DL.summarise(old, jobs, places), spo = Reached.splitOfSummary(so);
  ok(spo.v === 1 && Reached.splitLine(spo, DL.fmtDur) === 'Driving ' + DL.fmtDur(spo.totals.driveMin) + ' · On site ' + DL.fmtDur(spo.totals.onSiteMin) + ' (part estimated)', 'old day: "Driving · On site" as before', Reached.splitLine(spo, DL.fmtDur));
  ok(Reached.stopLine(spo.stops[0], 1, hm) === 'arr 13:30 · left 13:52', 'old day: per stop "arr · left" as before', Reached.stopLine(spo.stops[0], 1, hm));
  // a break still running counts up to now
  const day2 = JSON.parse(JSON.stringify(day)); day2.breakEndedAt = null;
  const sp2 = Reached.splitOfSummary(DL.summarise(day2, jobs, places), at(14, 3));
  near(sp2.totals.lunchMin, 10, 'a break still running counts to now (13:53 -> 14:03)');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
