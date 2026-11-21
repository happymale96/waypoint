'use strict';
// End day keying, merge-after-close, one-time history repair, Export/Import of the day log.
// Run with TZ=Asia/Kuala_Lumpur (the device's local zone): day keys are the device's LOCAL date.
const DL = require('../daylog.js');
const Solver = require('../solver.js');
const WPStore = require('../storage.js'); // node: in-memory backend

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const clone = (x) => JSON.parse(JSON.stringify(x));

ok(new Date(Date.UTC(2026, 10, 20, 7, 45)).getHours() === 15, 'test runs in UTC+8 (TZ=Asia/Kuala_Lumpur)');

const START = { lat: 3.00, lng: 101.00 };
const places = {};
['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'].forEach((id, i) => { places[id] = { id, name: 'Place ' + id, lat: 3.01 + i / 100, lng: 101.01 + i / 100 }; });
const deliveryJob = (id, to, extra) => Object.assign({ id, pickups: [], inHandItem: 'Box ' + id, deliveryPlaceId: to, errandPlaceId: null, notes: '', urgent: false, arriveBefore: null, status: 'pending', doneAt: null }, extra || {});

function planDay(days, departIso, jobs) {
  const key = DL.dateKey(Date.parse(departIso)); // a fresh PLAN: its run's day = local date it departed
  const day = DL.recordFor(days, key, 'Calvin');
  DL.recordPlan(day, { nowIso: departIso, start: START, departAtIso: departIso, jobs, places, stopOrder: jobs.map((j) => j.deliveryPlaceId || j.pickups[0].placeId) });
  return key;
}
const doneAt = (days, planKey, iso, stopId, actions) => DL.recordDone(DL.recordFor(days, DL.activityKey(Date.parse(iso), planKey), 'Calvin'), { nowIso: iso, stopId, actions, places });

console.log('End day closes the open day, keyed by the local date of its activity');
{
  const days = {}, jobs = [deliveryJob('a', 'P1'), deliveryJob('b', 'P2')];
  const k = planDay(days, '2026-11-20T07:45:00Z', jobs);
  eq(k, '2026-11-20', 'plan departed 2026-11-20T07:45Z (15:45 local) -> 2026-11-20');
  doneAt(days, k, '2026-11-20T08:40:39Z', 'P1', [{ jobId: 'a', kind: 'deliver' }]);
  doneAt(days, k, '2026-11-21T19:30:00Z', 'P2', [{ jobId: 'b', kind: 'deliver' }]); // 03:30 on 22 Nov, same run
  const res = DL.endDay(days, { planDayKey: k, jobs, places, nowIso: '2026-11-21T20:08:00Z' }); // 04:08 on 22 Nov
  eq(res.key, '2026-11-20', 'End day at 2026-11-21T20:08Z gives the 2026-11-20 record');
  eq(Object.keys(days), ['2026-11-20'], 'no record for 22 Nov (tap date) or 21 Nov (UTC date)');
  ok(days['2026-11-20'].closed && days['2026-11-20'].totals.jobsDone === 2, 'record closed with both DONEs (one past midnight)', days['2026-11-20'].totals);
  // with no current plan, End day still finds the open day
  const days2 = {};
  const k2 = planDay(days2, '2026-11-20T07:45:00Z', jobs);
  eq(DL.endDay(days2, { planDayKey: null, jobs, places, nowIso: '2026-11-21T20:08:00Z' }).key, k2, 'no current plan: the latest unclosed day with activity');
}

console.log('A 07:30 local departure is keyed to the local date, not the UTC date');
{
  const iso = '2026-11-19T23:30:00Z'; // 07:30 on 20 Nov local, 19 Nov in UTC
  eq(DL.dateKey(Date.parse(iso)), '2026-11-20', 'dateKey(07:30 local) = 2026-11-20');
  const days = {};
  eq(planDay(days, iso, [deliveryJob('a', 'P1')]), '2026-11-20', 'plan record dated 2026-11-20');
  ok(!days['2026-11-19'], 'no 19 Nov (UTC) record');
  eq(DL.fmtTime(Date.parse(iso)), '07:30', 'times shown in device local time');
}

console.log('End day with no open activity saves no record');
{
  const days = {};
  const r = DL.endDay(days, { planDayKey: '2026-11-22', jobs: [], places, nowIso: '2026-11-21T20:08:00Z' });
  ok(r.key === null && Object.keys(days).length === 0, 'nothing open -> key null, no record created', days);
  const d2 = {}; planDay(d2, '2026-11-20T07:45:00Z', [deliveryJob('a', 'P1')]);
  DL.endDay(d2, { planDayKey: '2026-11-20', jobs: [], places, nowIso: '2026-11-20T10:00:00Z' });
  const before = clone(d2);
  const r2 = DL.endDay(d2, { planDayKey: '2026-11-20', jobs: [], places, nowIso: '2026-11-21T20:08:00Z' });
  ok(r2.key === null && JSON.stringify(d2) === JSON.stringify(before), 'only a closed day -> nothing saved, nothing changed');
  const d3 = { '2026-11-22': DL.newDay({ date: '2026-11-22' }) };
  ok(DL.endDay(d3, { key: '2026-11-22', jobs: [], places, nowIso: '2026-11-21T20:08:00Z' }).key === null && !d3['2026-11-22'].closed, 'a record with no activity is never closed (no empty record saved)');
}

console.log('Activity after a close merges into the same date\'s record');
{
  const days = {}, jobs = [deliveryJob('a', 'P1'), deliveryJob('b', 'P2')];
  const k = planDay(days, '2026-11-20T07:45:00Z', jobs);
  doneAt(days, k, '2026-11-20T08:00:00Z', 'P1', [{ jobId: 'a', kind: 'deliver' }]);
  DL.endDay(days, { planDayKey: k, jobs, places, nowIso: '2026-11-20T09:00:00Z' });
  const rec = days[k];
  eq(rec.totals.jobsDone, 1, 'closed with 1 done');
  doneAt(days, k, '2026-11-20T09:30:00Z', 'P2', [{ jobId: 'b', kind: 'deliver' }]); // after the close, same date
  const noPlan = DL.recordFor(days, DL.activityKey(Date.parse('2026-11-20T10:00:00Z'), null), 'Calvin');
  ok(noPlan === rec, 'activity on 20 Nov without a plan resolves to the same record');
  DL.refreshTotals(rec, jobs, places);
  eq(Object.keys(days), ['2026-11-20'], 'still one record for the date');
  ok(rec.closed && rec.totals.jobsDone === 2 && rec.totals.jobsTotal === 2, 'merged: totals recomputed to 2 of 2, record stays closed', rec.totals);
}

console.log('Repair: 2 of 3 on 20 Nov + empty 22 Nov + six done jobs -> one 20 Nov record with 6 done');
(async () => {
  const jobs = [
    deliveryJob('j1', 'P1', { status: 'done', doneAt: '2026-11-20T04:14:08Z' }),
    deliveryJob('j2', 'P1', { status: 'done', doneAt: '2026-11-20T04:14:08Z', pickups: [{ placeId: 'P7', item: 'Valve', done: true }], inHandItem: '' }),
    deliveryJob('j3', 'P2', { status: 'done', doneAt: '2026-11-20T05:52:26Z' }),
    deliveryJob('j4', 'P3', { status: 'done', doneAt: '2026-11-20T05:52:26Z' }),
    deliveryJob('j5', 'P5', { status: 'done', doneAt: '2026-11-20T07:42:51Z' }),
    deliveryJob('j6', null, { status: 'done', doneAt: '2026-11-20T08:40:39Z', pickups: [{ placeId: 'P6', item: 'Sensor', done: true }], inHandItem: '' }), // pickup-only
    deliveryJob('j7', 'P4'), // still pending
  ];
  // what the phone holds: the day log only saw the afternoon (built before 4 of the 6 DONEs were logged)
  const d20 = DL.newDay({ date: '2026-11-20' });
  DL.recordPlan(d20, { nowIso: '2026-11-20T07:40:00Z', start: START, departAtIso: '2026-11-20T07:40:00Z', jobs: [jobs[4], Object.assign(clone(jobs[5]), { pickups: [{ placeId: 'P6', item: 'Sensor', done: false }] }), jobs[6]], places, stopOrder: ['P5', 'P6', 'P4'] });
  DL.recordDone(d20, { nowIso: '2026-11-20T07:42:51Z', stopId: 'P5', actions: [{ jobId: 'j5', kind: 'deliver' }], places });
  DL.recordDone(d20, { nowIso: '2026-11-20T08:40:39Z', stopId: 'P6', actions: [{ jobId: 'j6', kind: 'pickup', item: 'Sensor' }], places });
  d20.legs[DL.legKey(START, places.P5)] = { m: 12000, s: 1500 }; d20.legs[DL.legKey(places.P5, places.P6)] = { m: 12300, s: 1900 };
  DL.closeDay(d20, clone(jobs), places, '2026-11-20T09:00:00Z');
  const s0 = DL.summarise(d20, jobs, places);
  ok(s0.jobsDone === 2 && s0.jobsTotal === 3, 'starting point reads 2 of 3', [s0.jobsDone, s0.jobsTotal]);
  const d22 = DL.newDay({ date: '2026-11-22' });
  DL.recordArrivedEnd(d22, { nowIso: '2026-11-21T20:07:00Z', endPoint: { lat: 3.07, lng: 101.66, name: 'Home' } });
  DL.closeDay(d22, [], places, '2026-11-21T20:08:00Z');
  ok(DL.isEmptyRecord(d22, jobs, places), '22 Nov record is empty (0 jobs, 0 stops, no km, no start)');
  const eventsBefore = d20.events.length;

  await WPStore.clear('daylogs'); await WPStore.clear('backup'); await WPStore.remove('meta', 'daylogRepair');
  await WPStore.set('daylogs', d20.date, d20); await WPStore.set('daylogs', d22.date, d22);
  const res = await DL.runRepairOnce(WPStore, jobs, places, '2026-11-22T01:00:00Z');
  const after = await WPStore.list('daylogs');
  eq(after.map((d) => d.date), ['2026-11-20'], 'one record left: 2026-11-20 (22 Nov removed)');
  const s1 = DL.summarise(after[0], jobs, places);
  eq(s1.jobsDone, 6, '20 Nov now has 6 jobs done');
  eq(s1.rows.filter((r) => r.complete).map((r) => r.jobId).sort(), ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'], 'the six done jobs');
  ok(after[0].events.length > eventsBefore && after[0].totals.jobsDone === 6, 'record grew (events only added), stored totals recomputed', after[0].totals);
  eq(s1.km.status, 'unavailable', 'km cannot be computed at load time -> "km unavailable - tap to retry" state');
  eq(DL.fmtTime(s1.startedAt), '12:14', 'Started is no later than the first DONE');
  const doneTimes = DL.doneGroups(after[0]).map((g) => g.t);
  eq(doneTimes, doneTimes.slice().sort(), 'backfilled DONEs sit in time order');
  const bk = await WPStore.get('backup', 'daylogs-repair-' + DL.REPAIR_VERSION);
  ok(bk && bk.days.length === 2 && bk.days.some((d) => d.date === '2026-11-22'), 'backup key holds the original history (both records)');
  eq(res.removed, ['2026-11-22'], 'report: removed 22 Nov');
  eq((res.backfilled['2026-11-20'] || []).sort(), ['j1', 'j2', 'j3', 'j4'], 'report: backfilled the four unlogged DONEs');

  const snapStore = async () => JSON.stringify({ d: await WPStore.list('daylogs'), b: await WPStore.get('backup', 'daylogs-repair-' + DL.REPAIR_VERSION) });
  const s2 = await snapStore();
  const res2 = await DL.runRepairOnce(WPStore, jobs, places, '2026-11-23T01:00:00Z');
  ok(res2 === null && (await snapStore()) === s2, 'second run: flag set, nothing changes');
  await WPStore.remove('meta', 'daylogRepair'); // even without the flag the repair itself is idempotent
  const res3 = await DL.runRepairOnce(WPStore, jobs, places, '2026-11-23T02:00:00Z');
  ok(res3 && !res3.removed.length && !res3.changed.length && (await snapStore()) === s2, 'repair re-run without the flag changes nothing more');
  // a non-empty record is never deleted or shrunk
  const keep = { '2026-11-20': clone(after[0]) };
  const n0 = keep['2026-11-20'].events.length;
  DL.repairHistory(keep, [], places);
  ok(keep['2026-11-20'] && keep['2026-11-20'].events.length === n0, 'non-empty record kept intact');

  console.log('Export then import round-trips the day log and history; an old export still imports');
  {
    const days = { '2026-11-20': after[0] };
    const data = Object.assign({ app: 'waypoint', version: '1.0.0', places: Object.values(places), jobs, settings: { driverName: 'Calvin' } }, DL.exportPayload(days, jobs, places));
    ok(Array.isArray(data.dayLog) && Array.isArray(data.dayHistory), 'export has dayLog and dayHistory');
    eq(data.dayHistory[0], { date: '2026-11-20', closed: true, jobsDone: 6, jobsTotal: 7, stopsVisited: s1.stopsVisited, km: null, hoursOutMin: s1.hoursOutMin }, 'history row');
    const json = JSON.stringify(data);
    ok(!/googleKey|tomtomKey/.test(json), 'no API keys in the export');
    const back = DL.importPayload(JSON.parse(json));
    ok(back.present && back.records.length === 1, 'import finds the day log');
    eq(back.records[0], after[0], 'record round-trips exactly');
    const rDays = {}; back.records.forEach((d) => { rDays[d.date] = d; });
    eq(DL.exportPayload(rDays, jobs, places).dayHistory, data.dayHistory, 'history recomputed from the imported records is identical');
    let threw = null, old = null;
    try { old = DL.importPayload({ app: 'waypoint', version: '1.0.0', exportedAt: '2026-11-19T00:00:00Z', places: [], jobs: [], settings: {} }); } catch (e) { threw = e; }
    ok(!threw && old && old.present === false && old.records.length === 0, 'old export (no day log) imports without error and leaves day logs alone');
    const junk = DL.importPayload({ dayLog: [null, { date: 'x' }, { date: '2026-11-21', events: [] }] });
    eq(junk.records.map((d) => d.date), ['2026-11-21'], 'malformed day records are skipped');
  }

  console.log('Status line: never a fallback anchor without a reason');
  {
    const at = Date.parse('2026-11-20T08:40:00Z');
    eq(Solver.timesLine({ liveAt: null, lastDoneAt: at, reason: 'denied' }), 'Times from last DONE, 16:40 - location off or not allowed', 'denied');
    eq(Solver.timesLine({ liveAt: null, lastDoneAt: at, reason: 'denied', busy: true }), 'Times from last DONE, 16:40 - getting location…', 'location back, fix pending');
    eq(Solver.timesLine({ liveAt: null, lastDoneAt: null, reason: null }), 'Times from plan start - getting location…', 'no reason yet -> getting location…');
  }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('  FAIL crashed: ' + (e && e.stack)); process.exit(1); });
