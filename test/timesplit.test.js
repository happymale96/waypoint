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
  ok(s.timeSplitV === DL.TIME_SPLIT_V && s.timeSplitV === 3 && s.visits[0].navStartedAt === at(13, 12) && s.visits[1].navStartedAt === null, 'the day log keeps navStartedAt per done stop', s.visits);
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

// =====================================================================================================================
// Reached.dayTimeline: ONE timeline for the whole day (departure -> BETWEEN -> first nav tap for ANY stop -> DRIVING -> arrival at
// ANY stop -> ON SITE -> DONE). Each test checks the per-stop credit AND that the four buckets sum to the time out.
// =====================================================================================================================
const E = (type, stopId, h, m, more) => Object.assign({ type, stopId, at: at(h, m) }, more || {});
const nav = (s, h, m) => E('nav', s, h, m), rch = (s, h, m) => E('reached', s, h, m), dn = (s, h, m) => E('done', s, h, m), skp = (s, h, m) => E('skip', s, h, m);
const by = (r, id) => r.perStop.filter((x) => x.stopId === id)[0];
const sums = (r, name) => near(sumOf(r.totals), r.totals.totalMin, name + ': driving + on site + between + lunch = time out (' + r.totals.totalMin + ' min)');
const tl = (events, start, end, opts, dwells) => Reached.dayTimeline(events, dwells || {}, start, end, opts);
const segSum = (r) => r.segments.reduce((a, s) => a + s.min + s.lunchMin, 0);

console.log('timeline 1. plain day: Done A, nav B, Reached B, Done B');
{
  const r = tl([nav('A', 13, 12), rch('A', 13, 30), dn('A', 13, 52), nav('B', 14, 0), rch('B', 14, 10), dn('B', 14, 32)], START);
  const a = by(r, 'A'), b = by(r, 'B');
  near(a.betweenMin, 12, 'A: between 12'); near(a.driveMin, 18, 'A: driving 18'); near(a.onSiteMin, 22, 'A: on site 22');
  near(b.betweenMin, 8, 'B: between 8'); near(b.driveMin, 10, 'B: driving 10'); near(b.onSiteMin, 22, 'B: on site 22');
  ok(!r.totals.anyEstimated && !a.splitEstimated && !b.splitEstimated, 'nothing estimated');
  ok(Reached.stopLine(b, 2, hm) === 'left prev 13:52 · nav 14:00 · arr 14:10 · done 14:32', 'per-stop line', Reached.stopLine(b, 2, hm));
  near(r.totals.totalMin, 92, 'time out 92 min'); sums(r, 'plain'); near(segSum(r), 92, 'segments are contiguous (they add up to 92)');
}

// A is the same in the next two: nav 12:10, reached 12:30, done 12:55 (day starts 12:00)
const legA = [nav('A', 12, 10), rch('A', 12, 30), dn('A', 12, 55)];
console.log('timeline 2. DIVERT: nav B, nav C, Reached C, Done C, nav B, Reached B, Done B');
{
  const r = tl(legA.concat([nav('B', 13, 0), nav('C', 13, 20), rch('C', 13, 35), dn('C', 13, 50), nav('B', 13, 52), rch('B', 14, 10), dn('B', 14, 30)]), at(12, 0));
  const a = by(r, 'A'), b = by(r, 'B'), c = by(r, 'C');
  near(a.betweenMin, 10, 'A: between 10'); near(a.driveMin, 20, 'A: driving 20'); near(a.onSiteMin, 25, 'A: on site 25');
  near(c.betweenMin, 5, 'C: between 5 (12:55 -> 13:00)'); near(c.driveMin, 35, 'C: driving 35 credited to C (13:00 -> 13:35, B\'s old tap does not count)'); near(c.onSiteMin, 15, 'C: on site 15');
  near(b.betweenMin, 2, 'B: between 2 (13:50 -> 13:52)'); near(b.driveMin, 18, 'B: driving 18 credited to B (13:52 -> 14:10)'); near(b.onSiteMin, 20, 'B: on site 20');
  ok(r.perStop.map((x) => x.stopId).join('') === 'ACB', 'arrival order A, C, B');
  ok(Reached.stopLine(c, 2, hm) === 'left prev 12:55 · nav 13:00 · arr 13:35 · done 13:50', 'C line', Reached.stopLine(c, 2, hm));
  ok(Reached.stopLine(b, 2, hm) === 'left prev 13:50 · nav 13:52 · arr 14:10 · done 14:30', 'B line', Reached.stopLine(b, 2, hm));
  ok(!r.totals.anyEstimated, 'nothing estimated');
  near(r.totals.betweenMin, 17, 'total between 17'); near(r.totals.driveMin, 73, 'total driving 73'); near(r.totals.onSiteMin, 60, 'total on site 60');
  near(r.totals.totalMin, 150, 'time out 150 min'); sums(r, 'divert');
}
console.log('timeline 3. CANCELLED DETOUR: nav B, nav C, C skipped never reached, Reached B, Done B');
{
  const r = tl(legA.concat([nav('B', 13, 0), nav('C', 13, 20), skp('C', 13, 30), rch('B', 13, 50), dn('B', 14, 10)]), at(12, 0));
  const b = by(r, 'B');
  near(b.betweenMin, 5, 'B: between 5'); near(b.driveMin, 50, 'B: driving 50 (the skipped detour changes nothing)'); near(b.onSiteMin, 20, 'B: on site 20');
  ok(!by(r, 'C') && r.perStop.length === 2, 'C (never reached) has no entry');
  ok(Reached.stopLine(b, 2, hm) === 'left prev 12:55 · nav 13:00 · arr 13:50 · done 14:10', 'B line', Reached.stopLine(b, 2, hm));
  near(r.totals.totalMin, 130, 'time out 130 min'); sums(r, 'cancelled detour');
}
console.log('timeline 4. no navigation tap at all (estimated, between = 0)');
{
  const r = tl([rch('A', 13, 30), dn('A', 13, 50), dn('B', 14, 20)], START, null, null, { B: 10 });
  const a = by(r, 'A'), b = by(r, 'B');
  near(a.betweenMin, 0, 'A: between 0'); near(a.driveMin, 30, 'A: the whole gap is driving (30)');
  ok(a.splitEstimated && a.navMissing && !a.estimated, 'A flagged estimated (no nav tap), its Reached is real', a);
  near(b.betweenMin, 0, 'B: between 0'); near(b.driveMin, 20, 'B: driving 13:50 -> estimated arrival 14:10 (20)'); near(b.onSiteMin, 10, 'B: on site = planned dwell 10');
  ok(b.estimated && b.splitEstimated && Reached.stopLine(b, 2, hm) === 'left prev 13:50 · arr ~14:10 · done 14:20', 'B: "~" arrival, no nav in its line', Reached.stopLine(b, 2, hm));
  ok(r.totals.anyEstimated && r.totals.anySplitEstimated, 'totals: part estimated');
  near(r.totals.betweenMin, 0, 'total between 0'); near(r.totals.totalMin, 80, 'time out 80 min'); sums(r, 'no nav');
  // a Reached under 60 s before Done is not usable either
  const r2 = tl([rch('A', 13, 49), E('done', 'A', 13, 49, { at: at(13, 49) + 30000 })], START, null, null, { A: 15 });
  ok(by(r2, 'A').estimated, 'Reached 30 s before Done: estimated arrival', by(r2, 'A'));
  near(by(r2, 'A').onSiteMin, 15 - 0.0, 'estimated: on site = planned dwell (15 min)'); sums(r2, 'double tap');
}
console.log('timeline 5. a navigation tap while on site, before Done, takes effect at the departure');
{
  const r = tl([nav('A', 13, 5), rch('A', 13, 30), nav('B', 13, 40), dn('A', 13, 52), rch('B', 14, 10), dn('B', 14, 30)], START);
  const b = by(r, 'B');
  near(b.betweenMin, 0, 'B: between 0 (driving starts at DONE)'); near(b.driveMin, 18, 'B: driving 13:52 -> 14:10 = 18');
  ok(b.navMs === at(13, 52) && !b.splitEstimated, 'B: nav = the departure, not estimated', b);
  ok(Reached.stopLine(b, 2, hm) === 'left prev 13:52 · nav 13:52 · arr 14:10 · done 14:30', 'B line', Reached.stopLine(b, 2, hm));
  near(by(r, 'A').onSiteMin, 22, 'A: the tap did not end A\'s time on site'); sums(r, 'nav on site');
}
console.log('timeline 6. reached then skipped: the skip is the departure');
{
  const r = tl([nav('A', 13, 5), rch('A', 13, 20), dn('A', 13, 40), nav('B', 13, 45), rch('B', 14, 0), skp('B', 14, 10), nav('C', 14, 15), rch('C', 14, 30), dn('C', 14, 45)], START);
  const b = by(r, 'B'), c = by(r, 'C');
  ok(b.skipped && b.departMs === at(14, 10), 'B: skipped, left at the skip time');
  near(b.betweenMin, 5, 'B: between 5'); near(b.driveMin, 15, 'B: driving 15'); near(b.onSiteMin, 10, 'B: on site 10 (until the skip)');
  near(c.betweenMin, 5, 'C: between 5 (14:10 -> 14:15)'); near(c.driveMin, 15, 'C: driving 15'); near(c.onSiteMin, 15, 'C: on site 15');
  ok(Reached.stopLine(b, 2, hm) === 'left prev 13:40 · nav 13:45 · arr 14:00 · skipped 14:10', 'B line', Reached.stopLine(b, 2, hm));
  near(r.totals.totalMin, 105, 'time out 105 min'); sums(r, 'reached then skipped');
}
console.log('timeline 7. two stops reached before either is done');
{
  const r = tl([rch('A', 13, 20), rch('B', 13, 30), dn('B', 13, 40), dn('A', 13, 50), nav('C', 13, 55), rch('C', 14, 10), dn('C', 14, 20)], START);
  const a = by(r, 'A'), b = by(r, 'B'), c = by(r, 'C');
  near(b.onSiteMin, 10, 'B (latest reached): on site 13:30 -> 13:40 = 10'); near(a.onSiteMin, 20, 'A: on site 13:20 -> 13:30 and 13:40 -> 13:50 = 20');
  near(b.driveMin, 0, 'B: no leg of its own'); near(b.betweenMin, 0, 'B: no between');
  near(a.driveMin, 20, 'A: driving 13:00 -> 13:20 (no nav tap: estimated)'); ok(a.splitEstimated, 'A flagged estimated');
  near(c.betweenMin, 5, 'C: between 13:50 -> 13:55 = 5 (the departure is when no reached-not-done stop remains)'); near(c.driveMin, 15, 'C: driving 15'); near(c.onSiteMin, 10, 'C: on site 10');
  near(r.totals.totalMin, 80, 'time out 80 min'); sums(r, 'two reached');
}
console.log('timeline 8. lunch overlapping driving, on site and between');
{
  const evs = [nav('A', 13, 12), rch('A', 13, 30), dn('A', 13, 52), nav('B', 14, 0), rch('B', 14, 10), dn('B', 14, 32)];
  const r = tl(evs, START, null, { breakStartedAt: at(13, 45), breakEndedAt: at(14, 5) });
  near(by(r, 'A').onSiteMin, 15, 'A: on site loses 7 min (13:45 -> 13:52)'); near(by(r, 'B').betweenMin, 0, 'B: between loses all 8 min (13:52 -> 14:00)');
  near(by(r, 'B').driveMin, 5, 'B: driving loses 5 min (14:00 -> 14:05)'); near(r.totals.lunchMin, 20, 'lunch 20 min');
  ok(r.totals.betweenMin >= 0 && r.totals.driveMin >= 0 && r.totals.onSiteMin >= 0, 'no bucket negative');
  near(r.totals.totalMin, 92, 'time out 92 min'); sums(r, 'lunch spanning three');
  const r2 = tl(evs, START, null, { breakStartedAt: at(13, 15), breakEndedAt: at(13, 25) }); // inside driving to A
  near(by(r2, 'A').driveMin, 8, 'driving lunch: 18 - 10'); near(r2.totals.lunchMin, 10, 'lunch 10'); sums(r2, 'lunch in driving');
  const r3 = tl(evs, START, null, { breakStartedAt: at(13, 53), breakEndedAt: at(13, 58) }); // inside between
  near(by(r3, 'B').betweenMin, 3, 'between lunch: 8 - 5'); sums(r3, 'lunch in between');
  const r4 = tl(evs, START, null, { breakStartedAt: at(13, 35), breakEndedAt: at(13, 50) }); // inside on site
  near(by(r4, 'A').onSiteMin, 7, 'on-site lunch: 22 - 15'); near(r4.totals.lunchMin, 15, 'lunch 15'); sums(r4, 'lunch on site');
}
console.log('timeline 9. end-point leg with ARRIVED');
{
  const evs = [nav('A', 13, 12), rch('A', 13, 30), dn('A', 13, 52)];
  const r = tl(evs.concat([E('nav', null, 14, 0), E('arrived', null, 14, 30)]), START);
  near(r.totals.endBetweenMin, 8, 'end: between 8 (13:52 -> 14:00)'); near(r.totals.endDriveMin, 30, 'end: driving 30');
  near(r.totals.driveMin, 48, 'driving 18 + 30'); near(r.totals.betweenMin, 20, 'between 12 + 8'); near(r.totals.totalMin, 90, 'time out 13:00 -> 14:30'); sums(r, 'end leg');
  ok(Reached.stopLine(r.totals.end, 2, hm) === 'left prev 13:52 · nav 14:00 · arr 14:30', 'end line', Reached.stopLine(r.totals.end, 2, hm));
  const r2 = tl(evs.concat([E('arrived', null, 14, 30)]), START);
  near(r2.totals.endDriveMin, 38, 'no end nav: all driving (38)'); near(r2.totals.endBetweenMin, 0, 'between 0'); ok(r2.totals.anySplitEstimated && r2.end.navMissing, 'estimated'); sums(r2, 'end leg, no nav');
  // a nav tap for the end point also ends BETWEEN: it starts the driving that the next arrival at ANY stop would end
  const r3 = tl([nav('A', 13, 12), rch('A', 13, 30), dn('A', 13, 52), E('nav', null, 13, 55), rch('B', 14, 5), dn('B', 14, 20)], START);
  near(by(r3, 'B').betweenMin, 3, 'a tap for the end point counts as the first tap (3 min between)'); near(by(r3, 'B').driveMin, 10, 'then 10 min driving'); sums(r3, 'end tap, then a stop');
}
console.log('timeline 10. a day recorded under the previous format (per-stop navStartedAt) is converted and rendered');
{
  const places = { A: { id: 'A', name: 'Alpha', lat: 3.1, lng: 101.6 }, B: { id: 'B', name: 'Chi-Tak Electrical (Selangor)', lat: 3.2, lng: 101.7 }, C: { id: 'C', name: 'Gamma', lat: 3.3, lng: 101.8 } };
  const jobs = ['A', 'B', 'C'].map((p, i) => ({ id: 'j' + i, pickups: [], deliveryPlaceId: p, status: 'pending' }));
  const day = DL.newDay({ date: '2030-1-15' });
  DL.recordPlan(day, { nowIso: iso(at(12, 0)), start: { lat: 3, lng: 101.5 }, departAtIso: iso(at(12, 0)), jobs, places, stopOrder: ['A', 'B', 'C'] });
  const done = (id, j, h, m, nv, rc) => DL.recordDone(day, { nowIso: iso(at(h, m)), stopId: id, actions: [{ jobId: j, kind: 'deliver', item: 'x' }], places, reachedAt: at(...rc), reachedSource: 'tap', dwellMin: 10, navStartedAt: nv ? at(...nv) : null });
  done('A', 'j0', 12, 55, [12, 10], [12, 30]); done('C', 'j2', 13, 50, [13, 20], [13, 35]); done('B', 'j1', 14, 30, [13, 0], [14, 10]);
  day.timeSplitV = 2; // the previous format: no nav events
  ok(!day.events.some((e) => e.type === 'nav'), 'the old day has no nav events');
  const sum = DL.summarise(day, jobs, places), sp = Reached.splitOfSummary(sum, at(15, 0));
  ok(sp.v === 2 && sp.stops.length === 3, 'rendered as a four-bucket day', sp.stops.length);
  near(sp.totals.totalMin, 150, 'time out 150'); near(sumOf(sp.totals), 150, 'buckets sum to 150');
  const c = sp.stops.filter((x) => x.stopId === 'C')[0], b = sp.stops.filter((x) => x.stopId === 'B')[0];
  ok(Reached.stopLine(c, 2, hm) === 'left prev 12:55 · nav 13:00 · arr 13:35 · done 13:50', 'C: the stored tap of B (13:00) is the first tap after the departure and starts the driving C ends', Reached.stopLine(c, 2, hm));
  near(c.betweenMin, 5, 'C: between 5 (12:55 -> 13:00)'); near(c.driveMin, 35, 'C: driving 35');
  ok(b.navMissing && !b.estimated && b.splitEstimated && Math.abs(b.betweenMin) < 1e-6 && Math.abs(b.driveMin - 20) < 1e-6, 'B: only its first tap (13:00) was stored, so its leg is all driving and flagged estimated', b);
  ok(b.name === 'Chi-Tak Electrical (Selangor)', 'names carried', b.name);
  ok(/^Driving .+ · On site .+ · Between stops .+ \(part estimated\)$/.test(Reached.splitLine(sp, DL.fmtDur)), 'summary line', Reached.splitLine(sp, DL.fmtDur));
}
console.log('timeline 11. the day log round trip (nav events, skip, undo skip) -> same numbers as the DIVERT scenario');
{
  const places = { A: { id: 'A', name: 'Alpha', lat: 3.1, lng: 101.6 }, B: { id: 'B', name: 'Beta', lat: 3.2, lng: 101.7 }, C: { id: 'C', name: 'Gamma', lat: 3.3, lng: 101.8 } };
  const jobs = ['A', 'B', 'C'].map((p, i) => ({ id: 'j' + i, pickups: [], deliveryPlaceId: p, status: 'pending' }));
  const day = DL.newDay({ date: '2030-1-15' });
  DL.recordPlan(day, { nowIso: iso(at(12, 0)), start: { lat: 3, lng: 101.5 }, departAtIso: iso(at(12, 0)), jobs, places, stopOrder: ['A', 'B', 'C'] });
  const navE = (s, h, m) => DL.recordNav(day, { nowIso: iso(at(h, m)), at: at(h, m), stopId: s, end: false });
  const done = (id, j, h, m, rc) => DL.recordDone(day, { nowIso: iso(at(h, m)), stopId: id, actions: [{ jobId: j, kind: 'deliver', item: 'x' }], places, reachedAt: at(...rc), reachedSource: 'tap', dwellMin: 10 });
  navE('A', 12, 10); done('A', 'j0', 12, 55, [12, 30]);
  navE('B', 13, 0); navE('B', 13, 3); navE('C', 13, 20); // every tap is an event, B twice
  DL.recordSkip(day, { nowIso: iso(at(13, 25)), stopId: 'C', name: 'Gamma', reachedAt: at(13, 24), places }); // reached then skipped...
  DL.recordUndoSkip(day, { nowIso: iso(at(13, 26)), stopId: 'C' }); // ...skip undone: no effect
  done('C', 'j2', 13, 50, [13, 35]); navE('B', 13, 52); done('B', 'j1', 14, 30, [14, 10]);
  const sum = DL.summarise(day, jobs, places);
  ok(sum.timeSplitV === 3 && sum.navs.length === 5 && sum.skips.length === 0, 'v3 day: 5 nav events, the undone skip is gone', { v: sum.timeSplitV, navs: sum.navs.length, skips: sum.skips.length });
  const sp = Reached.splitOfSummary(sum, at(15, 0));
  const c = sp.stops.filter((x) => x.stopId === 'C')[0], b = sp.stops.filter((x) => x.stopId === 'B')[0];
  near(c.betweenMin, 5, 'C between 5'); near(c.driveMin, 35, 'C driving 35'); near(b.betweenMin, 2, 'B between 2'); near(b.driveMin, 18, 'B driving 18'); near(b.onSiteMin, 20, 'B on site 20');
  near(sumOf(sp.totals), sp.totals.totalMin, 'buckets sum to the time out');
  // a skip of a stop that WAS reached (and stays skipped) is a departure
  const day2 = DL.newDay({ date: '2030-1-15' });
  DL.recordPlan(day2, { nowIso: iso(at(12, 0)), start: { lat: 3, lng: 101.5 }, departAtIso: iso(at(12, 0)), jobs, places, stopOrder: ['A', 'B', 'C'] });
  DL.recordDone(day2, { nowIso: iso(at(12, 55)), stopId: 'A', actions: [{ jobId: 'j0', kind: 'deliver', item: 'x' }], places, reachedAt: at(12, 30), reachedSource: 'tap', dwellMin: 10 });
  DL.recordSkip(day2, { nowIso: iso(at(13, 20)), stopId: 'B', name: '', reachedAt: at(13, 5), places });
  DL.recordDone(day2, { nowIso: iso(at(14, 0)), stopId: 'C', actions: [{ jobId: 'j2', kind: 'deliver', item: 'x' }], places, reachedAt: at(13, 50), reachedSource: 'tap', dwellMin: 10 });
  const sp2 = Reached.splitOfSummary(DL.summarise(day2, jobs, places), at(15, 0));
  const sb = sp2.stops.filter((x) => x.stopId === 'B')[0];
  ok(sb && sb.skipped && sb.name === 'Beta' && sb.departMs === at(13, 20), 'a reached-then-skipped stop is listed with its skip time', sb);
  near(sumOf(sp2.totals), sp2.totals.totalMin, 'buckets sum to the time out (reached-then-skipped day)');
  // an event-free guard: nothing to split -> null
  ok(Reached.splitOfSummary({ timeSplitV: 3, visits: [] }) === null, 'no visits: no split');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
