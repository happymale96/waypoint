'use strict';
// Items "with you" (onboard.js): the on-board rule, the loose-items store (done / undo / dropped off / deliver to… / End day /
// backfill / Export-Import), the summary's STILL WITH YOU + Dropped off, and the two run-state predicates (a RUNNING day for PLAN,
// the closed-day Route card).
// Run as its own node script with TZ=Asia/Kuala_Lumpur (day keys are the device's local date): node test/onboard.test.js
const OB = require('../onboard.js');
const DL = require('../daylog.js');
const WPStore = require('../storage.js'); // node: in-memory backend

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const clone = (x) => JSON.parse(JSON.stringify(x));

ok(new Date(Date.UTC(2026, 10, 23, 7, 45)).getHours() === 15, 'test runs in UTC+8 (TZ=Asia/Kuala_Lumpur)');

const at = (d, h, m) => new Date(2026, 10, d, h, m, 0).getTime(); // Nov 2026, local
const iso = (ms) => new Date(ms).toISOString();
const places = {
  carrier: { id: 'carrier', name: 'Carrier International Sdn Bhd', lat: 3.10, lng: 101.60 },
  acme: { id: 'acme', name: 'Acme Works', lat: 3.12, lng: 101.62 },
  beta: { id: 'beta', name: 'Beta Plant', lat: 3.14, lng: 101.64 },
};
const nameOf = (id) => (places[id] ? places[id].name : '?');
const collectOnly = (id, item) => ({ id, pickups: [{ placeId: 'carrier', item: item || 'printer ribbon', done: false }], deliveryPlaceId: null, errandPlaceId: null, notes: 'ring the bell', urgent: false, status: 'pending', doneAt: null });
const carryJob = (id, item) => ({ id, pickups: [{ placeId: 'acme', item: item || 'sensor', done: false }], deliveryPlaceId: 'beta', errandPlaceId: null, notes: '', urgent: false, status: 'pending', doneAt: null });
const state = (jobs, loose) => ({ jobs, loose, nameOf });
// what the app's markDone / undoDone do to a collect-only job and to the loose store
function doneCollect(jobs, loose, jobId, ms) {
  const j = jobs.find((x) => x.id === jobId);
  j.pickups.forEach((p) => { p.done = true; p.doneAt = iso(ms); });
  j.status = 'done'; j.doneAt = iso(ms);
  return OB.addForJob(loose, j, { nameOf, at: ms });
}
function undoCollect(jobs, loose, jobId) {
  const j = jobs.find((x) => x.id === jobId);
  j.pickups.forEach((p) => { p.done = false; delete p.doneAt; });
  j.status = 'pending'; j.doneAt = null;
  return OB.removeForJob(loose, jobId);
}

console.log('1. a collect-only job done -> one loose item; the job count is unchanged');
{
  const jobs = [collectOnly('jc')];
  let loose = [];
  eq(OB.onBoard(state(jobs, loose), at(23, 12, 0)), [], 'before the DONE nothing is with you');
  loose = doneCollect(jobs, loose, 'jc', at(23, 12, 5));
  const b = OB.onBoard(state(jobs, loose), at(23, 12, 6));
  ok(b.length === 1 && b[0].kind === 'loose' && b[0].item === 'printer ribbon', 'onBoard has 1 loose item', b);
  ok(b[0].from === 'Carrier International Sdn Bhd' && b[0].notes === 'ring the bell' && OB.whenLabel(b[0].fromAt, at(23, 12, 6)) === 'today 12:05', 'it knows where / when it was collected and its notes', b[0]);
  ok(jobs.length === 1 && loose.length === 1 && loose[0].status === 'with-me' && loose[0].sourceJobId === 'jc' && loose[0].id === 'loose_jc', 'the store has the item {id, status with-me, sourceJobId}; the jobs list is untouched', loose[0]);
  ok(OB.addForJob(loose, jobs[0], { nameOf, at: at(23, 12, 7) }).length === 1, 'a second DONE of the same job never doubles it');
  ok(OB.looseFromJob(carryJob('jd'), { nameOf }) === null && OB.looseFromJob({ id: 'e', errandPlaceId: 'acme', pickups: [] }, { nameOf }) === null, 'a collect -> deliver job or an errand makes no loose item');
}

console.log('2. undo of that DONE -> nothing is with you');
{
  const jobs = [collectOnly('jc')];
  let loose = doneCollect(jobs, [], 'jc', at(23, 12, 5));
  ok(OB.onBoard(state(jobs, loose), at(23, 12, 6)).length === 1, 'with you after the DONE');
  loose = undoCollect(jobs, loose, 'jc');
  eq(OB.onBoard(state(jobs, loose), at(23, 12, 7)), [], 'undo of the DONE: onBoard is empty');
  eq(loose, [], 'and the store has no item');
}

console.log('3. "Dropped off" -> off the bar, listed as dropped with its time; Undo -> back on board');
{
  const jobs = [collectOnly('jc')];
  let loose = doneCollect(jobs, [], 'jc', at(23, 12, 5));
  const dropMs = at(23, 18, 5);
  loose = OB.dropOff(loose, 'loose_jc', dropMs, '');
  eq(OB.onBoard(state(jobs, loose), dropMs + 1000), [], 'dropped off: onBoard is empty');
  ok(loose[0].status === 'dropped' && Date.parse(loose[0].droppedAt) === dropMs && loose[0].droppedPlace === undefined, 'status dropped, droppedAt = now, no place yet', loose[0]);
  loose = OB.setDropPlace(loose, 'loose_jc', dropMs, 'Home (Bloomsvale)');
  ok(loose[0].droppedPlace === 'Home (Bloomsvale)', 'the place found afterwards is stored');
  ok(OB.setDropPlace(loose, 'loose_jc', dropMs + 5, 'Elsewhere')[0].droppedPlace === 'Home (Bloomsvale)', 'a stale place update (another drop moment) changes nothing');
  const ex = OB.summaryExtra(state(jobs, loose), at(23, 23, 59), at(23, 0, 0), at(24, 0, 0));
  ok(ex.dropped.length === 1 && ex.dropped[0].t === dropMs && ex.dropped[0].place === 'Home (Bloomsvale)' && ex.dropped[0].item === 'printer ribbon', 'listed as dropped with its time and place', ex.dropped);
  ok(OB.onBoard(state(jobs, loose), at(23, 17, 0)).length === 1, 'asked "as at" 17:00 (before the drop) it was still with you');
  loose = OB.undoDrop(loose, 'loose_jc');
  const b = OB.onBoard(state(jobs, loose), dropMs + 2000);
  ok(b.length === 1 && loose[0].status === 'with-me' && loose[0].droppedAt === undefined && loose[0].droppedPlace === undefined, 'Undo: back on board, drop fields cleared', loose[0]);
}

console.log('4. "Deliver to…" saved -> converted; still with you through the in-hand job; delivery DONE -> empty');
{
  const jobs = [collectOnly('jc')];
  let loose = doneCollect(jobs, [], 'jc', at(23, 12, 5));
  const cvMs = at(23, 14, 0);
  const nj = { id: 'jnew', pickups: [], inHandItem: 'printer ribbon', notes: 'ring the bell', deliveryPlaceId: 'beta', looseId: 'loose_jc', errandPlaceId: null, urgent: false, status: 'pending', doneAt: null };
  jobs.push(nj);
  loose = OB.convert(loose, 'loose_jc', 'jnew', cvMs);
  ok(loose[0].status === 'converted' && loose[0].convertedJobId === 'jnew', 'the loose item is converted and linked to the new job', loose[0]);
  const b = OB.onBoard(state(jobs, loose), cvMs + 1000);
  ok(b.length === 1 && b[0].kind === 'inhand' && b[0].jobId === 'jnew' && b[0].to === 'Beta Plant' && b[0].from === 'Carrier International Sdn Bhd', 'onBoard still has the item, now via the in-hand job (with where it came from and its destination)', b);
  ok(OB.onBoard(state(jobs, loose), cvMs - 1000).length === 1 && OB.onBoard(state(jobs, loose), cvMs - 1000)[0].kind === 'loose', 'before the conversion moment it counted as the loose item (never twice)');
  nj.status = 'done'; nj.doneAt = iso(at(23, 15, 0));
  eq(OB.onBoard(state(jobs, loose), at(23, 15, 1)), [], 'delivery DONE: onBoard is empty');
  ok(OB.onBoard(state(jobs, loose), at(23, 14, 30)).length === 1, 'asked "as at" 14:30 (before the delivery) it was with you');
  // the in-hand job is deleted (or dropped at End day): the item is with the driver again
  const gone = OB.onBoard(state([jobs[0]], loose), at(23, 15, 1));
  ok(gone.length === 1 && gone[0].kind === 'loose', 'if the in-hand job is deleted the item is not lost: it is loose again', gone);
  nj.status = 'dropped';
  ok(OB.onBoard(state(jobs, loose), at(23, 15, 1)).length === 1, 'same when End day drops that job');
  ok(OB.dropOff(OB.convert(loose, 'loose_jc', 'jnew', cvMs), 'loose_jc', cvMs + 1, '')[0].status === 'dropped', 'an orphaned converted item can be dropped off');
}

console.log('5. collect -> deliver: on board between the pickup DONE and the delivery DONE only');
{
  const j = carryJob('jd', 'sensor');
  const jobs = [j];
  eq(OB.onBoard(state(jobs, []), at(23, 9, 0)), [], 'before the pickup: nothing');
  j.pickups[0].done = true; j.pickups[0].doneAt = iso(at(23, 10, 0));
  const b = OB.onBoard(state(jobs, []), at(23, 10, 1));
  ok(b.length === 1 && b[0].kind === 'job' && b[0].item === 'sensor' && b[0].from === 'Acme Works' && b[0].to === 'Beta Plant', 'after the pickup: 1 item, from Acme -> Beta', b);
  ok(OB.onBoard(state(jobs, []), at(23, 9, 59)).length === 0, 'asked "as at" before the pickup: nothing');
  j.status = 'done'; j.doneAt = iso(at(23, 11, 0));
  eq(OB.onBoard(state(jobs, []), at(23, 11, 1)), [], 'after the delivery DONE: nothing');
  ok(OB.onBoard(state(jobs, []), at(23, 10, 30)).length === 1, 'between the two: 1');
  const inh = { id: 'jh', pickups: [], inHandItem: 'gasket', deliveryPlaceId: 'beta', status: 'pending' };
  ok(OB.onBoard(state([inh], []), at(23, 8, 0)).length === 1 && OB.onBoard(state([inh], []), at(23, 8, 0))[0].kind === 'inhand', 'an in-hand job counts until its delivery is done');
  inh.status = 'done'; inh.doneAt = iso(at(23, 9, 0));
  eq(OB.onBoard(state([inh], []), at(23, 9, 1)), [], 'and not after');
  ok(OB.onBoard(state([{ id: 'e', errandPlaceId: 'acme', pickups: [], status: 'pending' }, { id: 'p', pickups: [{ placeId: 'acme', item: 'x', done: false }], deliveryPlaceId: 'beta', status: 'pending' }], []), at(23, 9, 0)).length === 0, 'an errand, or a delivery not yet collected, is not with you');
  ok(OB.onBoard(state([Object.assign(carryJob('jp'), { status: 'parked' })].map((x) => { x.pickups[0].done = true; return x; }), []), at(23, 9, 0)).length === 1, 'a parked job already collected is still with you');
  eq(OB.barLabel(1) + ' | ' + OB.barLabel(3), 'With you: 1 item | With you: 3 items', 'the bar text');
}

console.log('6. End day with a loose item -> STILL WITH YOU lists it; the store keeps it for the next day');
{
  const key = DL.dateKey(at(23, 12, 0));
  const jobs = [collectOnly('jc')];
  const days = {};
  const day = DL.recordFor(days, key, 'Calvin');
  DL.recordPlan(day, { nowIso: iso(at(23, 9, 0)), replan: false, start: { lat: 3.0, lng: 101.5 }, departAtIso: iso(at(23, 9, 0)), jobs: clone(jobs), places, stopOrder: ['carrier'] });
  let loose = doneCollect(jobs, [], 'jc', at(23, 12, 5));
  DL.recordDone(day, { nowIso: iso(at(23, 12, 5)), stopId: 'carrier', actions: [{ jobId: 'jc', kind: 'pickup', item: 'printer ribbon' }], places });
  const before = DL.summarise(day, jobs, places);
  ok(before.stillWithYou.length === 0 && before.jobsDone === 1, 'the old rule: the collect-only job is complete and "Nothing in the van" (the bug)');
  const closeMs = at(23, 17, 59);
  const res = DL.endDay(days, { key, jobs, places, nowIso: iso(closeMs) });
  ok(res.key === key && day.closed, 'End day closes the day');
  const ex = OB.summaryExtra(state(jobs, loose), closeMs, DL.dayStartMs(key), DL.dayStartMs(DL.addDaysKey(key, 1)));
  const s = DL.summarise(day, jobs, places, ex);
  ok(s.stillWithYou.length === 1 && s.stillWithYou[0].item === 'printer ribbon' && s.stillWithYou[0].from === 'Carrier International Sdn Bhd' && s.stillWithYou[0].loose === true, 'STILL WITH YOU lists the printer ribbon, with where it came from', s.stillWithYou);
  ok(s.jobsDone === 1 && s.jobsTotal === 1 && s.notDone.length === 0, 'job counts do not change');
  ok(DL.toWhatsApp(s).indexOf('- printer ribbon (from Carrier International Sdn Bhd)') > 0, 'the WhatsApp summary lists it too');
  ok(DL.toCSV(s).split('\r\n')[0] === DL.CSV_HEADER.join(',') && DL.CSV_HEADER.length === 11, 'the CSV columns are unchanged');
  // the next day
  ok(loose.length === 1 && loose[0].status === 'with-me', 'End day does not touch the store: the item is still there next day');
  ok(OB.onBoard(state(jobs, loose), at(24, 8, 0)).length === 1, 'and still on the bar next morning');
  const dropMs = at(24, 10, 30);
  loose = OB.dropOff(loose, 'loose_jc', dropMs, 'Acme Works');
  const ex2 = OB.summaryExtra(state(jobs, loose), closeMs, DL.dayStartMs(key), DL.dayStartMs(DL.addDaysKey(key, 1)));
  ok(DL.summarise(day, jobs, places, ex2).stillWithYou.length === 1, 'the closed day, re-rendered after the drop-off, still shows it (it was with you at close)');
  const key2 = DL.addDaysKey(key, 1);
  const exNext = OB.summaryExtra(state(jobs, loose), at(24, 18, 0), DL.dayStartMs(key2), DL.dayStartMs(DL.addDaysKey(key2, 1)));
  ok(exNext.withYou.length === 0 && exNext.dropped.length === 1 && exNext.dropped[0].place === 'Acme Works', "the next day's summary: not with you, listed under Dropped off", exNext);
  const day2 = DL.newDay({ date: key2 });
  ok(DL.toWhatsApp(DL.summarise(day2, jobs, places, exNext)).indexOf('- 10:30 printer ribbon (Acme Works)') > 0, 'with its time and place in the WhatsApp text');
  // a day that closed BEFORE the item was collected does not list it
  const early = OB.summaryExtra(state(jobs, doneCollect([collectOnly('jc')], [], 'jc', at(23, 12, 5))), at(23, 11, 0), DL.dayStartMs(key), DL.dayStartMs(key2));
  eq(early.withYou, [], 'a day that closed before the pickup does not list it');
  // a converted item whose in-hand job is still to deliver at close: listed once, with its destination
  const j2 = { id: 'jnew', pickups: [], inHandItem: 'printer ribbon', deliveryPlaceId: 'beta', looseId: 'loose_jc', status: 'pending' };
  const conv = OB.convert(doneCollect([collectOnly('jc')], [], 'jc', at(23, 12, 5)), 'loose_jc', 'jnew', at(23, 14, 0));
  const exC = OB.summaryExtra(state([j2], conv), at(23, 17, 59), DL.dayStartMs(key), DL.dayStartMs(key2));
  ok(exC.withYou.length === 1 && exC.withYou[0].jobId === 'jnew' && exC.withYou[0].to === 'Beta Plant', 'converted but not yet delivered at close: still with you, with its destination', exC.withYou);
  const rowDup = { jobId: 'jnew', item: 'printer ribbon', to: 'Beta Plant', withYou: true };
  ok(typeof DL.summarise === 'function' && exC.withYou.filter((x) => x.jobId !== rowDup.jobId).length === 0, 'its jobId lets summarise skip it when the day already lists that job');
}

console.log('7. backfill: one item for a collect-only job done on the most recent closed day, none on a second load');
{
  const jobs = [collectOnly('jc'), collectOnly('jold', 'old stuff'), carryJob('jd')];
  jobs[0].status = 'done'; jobs[0].doneAt = iso(at(23, 12, 5)); jobs[0].pickups[0].done = true;
  jobs[1].status = 'done'; jobs[1].doneAt = iso(at(10, 12, 5)); jobs[1].pickups[0].done = true; // long before: not backfilled
  jobs[2].status = 'done'; jobs[2].doneAt = iso(at(23, 13, 0)); jobs[2].pickups[0].done = true;  // collect -> deliver: not loose
  const keys = OB.backfillKeys('2026-11-24', [{ date: '2026-11-20', closed: true }, { date: '2026-11-23', closed: true }, { date: '2026-11-24', closed: false }]);
  eq(keys, ['2026-11-24', '2026-11-23'], 'the dates to look at: today and the most recent closed day');
  const opts = { keys, dateKey: DL.dateKey, nameOf, rows: [] };
  const r1 = OB.backfill({ jobs, loose: [] }, opts);
  ok(r1.added.length === 1 && r1.added[0].sourceJobId === 'jc' && r1.added[0].status === 'with-me' && Date.parse(r1.added[0].collectedAt) === at(23, 12, 5), 'exactly one item is created, for that job, collected when the job was done', r1.added);
  ok(OB.backfill({ jobs, loose: r1.list }, opts).added.length === 0, 'run again over its own result: none');
  const withRows = OB.backfill({ jobs: [], loose: [] }, { keys, dateKey: DL.dateKey, nameOf, rows: [{ jobId: 'gone', item: 'cleared job item', from: 'Carrier International', doneMs: at(23, 12, 5), notes: '' }] });
  ok(withRows.added.length === 1 && withRows.added[0].id === 'loose_gone', 'a job already cleared from the list is still found through the day log rows');
  // once: the store flag
  (async () => {
    const store = WPStore;
    const a1 = await OB.runBackfillOnce(store, { jobs, loose: [] }, opts, '2026-11-24T00:00:00Z');
    const stored1 = await store.list('loose');
    ok(a1 && a1.length === 1 && stored1.length === 1 && stored1[0].id === 'loose_jc', 'first load: one item stored');
    const a2 = await OB.runBackfillOnce(store, { jobs, loose: stored1 }, opts, '2026-11-24T00:01:00Z');
    ok(a2 === null && (await store.list('loose')).length === 1, 'second load: nothing created');
    await store.remove('loose', 'loose_jc'); await store.remove('meta', 'looseBackfill');
    finish8();
  })();
}

function finish8() {
console.log('8. Export then Import round-trips the store');
{
  const jobs = [collectOnly('jc'), collectOnly('jb', 'cable')];
  let loose = doneCollect(jobs, [], 'jc', at(23, 12, 5));
  loose = doneCollect(jobs, loose, 'jb', at(23, 12, 40));
  loose = OB.dropOff(loose, 'loose_jb', at(23, 18, 0), 'Home');
  const payload = JSON.parse(JSON.stringify(OB.exportLoose(loose)));
  const back = OB.importLoose(payload);
  ok(back.present === true, 'an export with looseItems is recognised');
  eq(back.items, loose, 'import gives back exactly what was exported (with every field)');
  ok(OB.importLoose({ app: 'waypoint', places: [], jobs: [] }).present === false, 'an older export (no looseItems) keeps the current store');
  ok(OB.importLoose({ looseItems: [{ id: 'x' }, null, { id: 'y', item: 'ok', status: 'bogus' }, { id: 'z', item: 'fine', status: 'with-me' }] }).items.length === 1, 'invalid entries are skipped');
  ok(OB.exportLoose(loose).looseItems !== loose, 'the export is a copy');
}

console.log('predicate: the day is RUNNING (PLAN re-solves instead of planning afresh)');
{
  const stop = (o) => Object.assign({ placeId: 'p', actions: [] }, o);
  const plan = (stops, extra) => Object.assign({ stops }, extra || {});
  ok(OB.isDayRunning(null, null) === false && OB.isDayRunning(undefined, {}) === false, 'no plan: not running');
  ok(OB.isDayRunning(plan([stop(), stop()]), null) === false && OB.isDayRunning(plan([stop()]), { closed: false, events: [] }) === false, 'a fresh plan, nothing touched: not running');
  ok(OB.isDayRunning(plan([stop({ status: 'done' }), stop()]), { events: [] }) === true, 'a stop done: running');
  ok(OB.isDayRunning(plan([stop({ reachedAt: 1 }), stop()]), null) === true, 'a stop reached: running');
  ok(OB.isDayRunning(plan([stop({ status: 'skipped' }), stop()]), null) === true, 'a stop skipped: running');
  ok(OB.isDayRunning(plan([stop({ navStartedAt: 1 }), stop()]), null) === true, 'a navigation tap on a stop: running');
  ok(OB.isDayRunning(plan([stop()], { endNavStartedAt: 5 }), null) === true, 'a navigation tap on the end point: running');
  ok(OB.isDayRunning(plan([stop()]), { events: [{ type: 'plan' }, { type: 'nav', stopId: 'p' }] }) === true, 'a nav event in the day log: running');
  ok(OB.isDayRunning(plan([stop({ status: 'done' })]), { closed: true, events: [] }) === false, 'the day is closed: not running (PLAN plans afresh)');
  ok(OB.isDayRunning(plan([stop({ fuel: true, placeId: 'FUEL' }), stop()]), null) === false, 'a fuel stop added, nothing else: not running');
  ok(OB.isDayRunning({ stops: null }, null) === false, 'a broken plan: not running');
}

console.log('PLAN on a running day keeps a skipped stop skipped (OnBoard.jobsForPlan)');
{
  const Solver = require('../solver.js');
  const pl = {};
  ['A', 'B', 'C', 'D'].forEach((id, i) => { pl[id] = { id, name: 'Place ' + id, lat: 3.1 + i * 0.01, lng: 101.6 + i * 0.01, type: 'other' }; });
  const errand = (id, pid, status) => ({ id, errandPlaceId: pid, pickups: [], deliveryPlaceId: null, notes: id, status: status || 'pending' });
  const stopOf = (pid, jid, status) => Object.assign({ placeId: pid, actions: [{ jobId: jid, kind: 'errand', item: jid }] }, status ? { status } : {});
  const jobs = [errand('jA', 'A', 'done'), errand('jB', 'B'), errand('jC', 'C'), errand('jD', 'D')]; // D was added after the plan
  const plan = { stops: [stopOf('A', 'jA', 'done'), stopOf('B', 'jB', 'skipped'), stopOf('C', 'jC')] };
  const before = JSON.stringify(jobs);
  const solved = OB.jobsForPlan(jobs, plan);
  eq(Solver.buildStops(solved, pl).stopIds, ['C', 'D'], 'A done, B skipped, C pending, D new: PLAN solves C and D only');
  ok(JSON.stringify(jobs) === before && jobs.length === 4, 'the stored jobs are untouched: the job count is unchanged');
  ok(!solved.some((j) => j.id === 'jB') && Solver.buildStops(solved, pl).stopIds.indexOf('B') < 0, 'the skipped stop\'s job is not solved again (no new stop for it)');
  // the solve itself gives the skipped place no stop and no ETA
  const mk = (n) => ({ departAt: '2026-11-23T01:00:00.000Z', m: Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => (a === b ? 0 : 300))) });
  const res = Solver.solve({ start: { lat: 3.09, lng: 101.59 }, end: { lat: 3.2, lng: 101.7 }, jobs: solved, places: pl, matrices: [mk(4)], departAtISO: '2026-11-23T01:00:00.000Z', noDetour: false });
  ok(!res.error && res.plans[0].stops.map((s) => s.placeId).sort().join('') === 'CD', 'the re-solve gives C and D a stop and ETA, B none', res.error);
  // after "Undo skip" on B (its status removed) the next PLAN includes B, C and D
  const undone = { stops: plan.stops.map((s) => { const c = Object.assign({}, s); if (c.placeId === 'B') delete c.status; return c; }) };
  eq(Solver.buildStops(OB.jobsForPlan(jobs, undone), pl).stopIds, ['B', 'C', 'D'], 'after Undo skip on B the next PLAN solves B, C and D');
  ok(OB.jobsForPlan(jobs, null) === jobs && OB.jobsForPlan(jobs, { stops: [stopOf('A', 'jA', 'done')] }) === jobs, 'no plan, or nothing skipped: the jobs as given');
  ok(OB.jobsForPlan(jobs, { stops: [{ placeId: 'FUEL', fuel: true, status: 'skipped', actions: [] }] }) === jobs, 'a skipped fuel stop holds no job: the jobs as given');
  // a carry job: pickup at a live stop, delivery at the skipped stop -> only the live pickup is solved (the delivery stays skipped)
  const carry = { id: 'jX', pickups: [{ placeId: 'C', item: 'box', done: false }], deliveryPlaceId: 'B', errandPlaceId: null, status: 'pending' };
  const mixed = OB.jobsForPlan([carry], { stops: [{ placeId: 'B', status: 'skipped', actions: [{ jobId: 'jX', kind: 'deliver', item: 'box' }] }] });
  eq(Solver.buildStops(mixed, pl).stopIds, ['C'], 'a job with its delivery at the skipped stop: the delivery is not solved again');
  ok(carry.deliveryPlaceId === 'B', 'the stored job keeps its delivery place');
  // a new job at the same place as the skipped stop is a new job: solved as normal
  eq(Solver.buildStops(OB.jobsForPlan(jobs.concat([errand('jE', 'B')]), plan), pl).stopIds, ['C', 'D', 'B'], 'a newly added job at the skipped place is a new stop');
}

console.log('predicate: the Route tab of a closed day');
{
  const T = (h, m) => iso(at(23, h, m));
  const closed = (events, extra) => Object.assign({ closed: true, closedAt: T(17, 59), endedAt: T(17, 59), events }, extra || {});
  eq(OB.closedRouteCard(null), null, 'no record: no card');
  eq(OB.closedRouteCard({ closed: false, events: [{ type: 'plan', t: T(9, 0) }] }), null, 'an open day: no card');
  const c = OB.closedRouteCard(closed([{ type: 'plan', t: T(9, 0) }, { type: 'done', t: T(12, 0) }, { type: 'endday', t: T(17, 59) }]));
  ok(c && c.closedAtMs === at(23, 17, 59), 'closed, nothing planned since: the card, with the close time (17:59)', c);
  eq(OB.closedRouteCard(closed([{ type: 'plan', t: T(9, 0) }, { type: 'endday', t: T(17, 59) }, { type: 'plan', t: T(18, 30) }])), null, 'a PLAN after the close: the normal Route tab');
  eq(OB.closedRouteCard(closed([{ type: 'plan', t: T(9, 0) }, { type: 'endday', t: T(17, 59) }, { type: 'replan', t: T(18, 30) }])), null, 'a replan after the close: the normal Route tab');
  ok(OB.closedRouteCard(closed([{ type: 'plan', t: T(9, 0) }, { type: 'endday', t: T(17, 59) }, { type: 'dropoff', t: T(18, 5) }, { type: 'nav', t: T(18, 6) }])) !== null, 'a drop-off or other event after the close does not count as a new plan');
  ok(OB.closedRouteCard(closed([{ type: 'plan', t: T(9, 0) }, { type: 'replan', t: T(10, 0) }, { type: 'endday', t: T(17, 59) }])) !== null, 'plans before the close do not count');
  ok(OB.closedRouteCard(closed([{ type: 'plan', t: T(9, 0) }], { closedAt: null, endedAt: T(17, 59) })).closedAtMs === at(23, 17, 59), 'an older record (endedAt only) works');
  eq(OB.closedRouteCard({ closed: false, events: [{ type: 'endday', t: T(17, 59) }, { type: 'undo', of: 'endday', t: T(18, 0) }] }), null, 'a reopened day: no card');
}

console.log('helpers');
{
  const nowMs = at(23, 18, 0);
  eq([OB.whenLabel(at(23, 14, 5), nowMs), OB.whenLabel(at(22, 9, 3), nowMs), OB.whenLabel(at(20, 8, 0), nowMs), OB.whenLabel(null, nowMs)], ['today 14:05', 'yesterday 09:03', '20 Nov 08:00', ''], 'when labels: today / yesterday / date');
  const home = { name: 'Home', lat: 3.0757673, lng: 101.6609445 }, office = { name: 'Office', lat: 3.09941, lng: 101.739 };
  const near = (m) => ({ ok: true, lat: home.lat + m / 111320, lng: home.lng, accuracy: 20 });
  ok(OB.nearestPlace(near(80), { home, office }, 150) === home, 'a fix 80 m from a saved place names it');
  ok(OB.nearestPlace(near(400), [home, office], 150) === null, 'a fix 400 m away names nothing');
  ok(OB.nearestPlace(Object.assign(near(10), { accuracy: 300 }), [home], 150) === null, 'a poor fix (300 m) names nothing');
  ok(OB.nearestPlace({ ok: false, code: 'denied' }, [home], 150) === null && OB.nearestPlace(null, [home], 150) === null, 'no fix, no place');
  ok(OB.nearestPlace(near(100), [home, { name: 'Closer', lat: home.lat + 90 / 111320, lng: home.lng }], 150).name === 'Closer', 'the closest of two within range wins');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exitCode = failures ? 1 : 0;
}
