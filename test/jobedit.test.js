'use strict';
// Edit a job (jobedit.js): the pure update function.
// Run as its own node script: node test/jobedit.test.js
const JE = require('../jobedit.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const clone = (x) => JSON.parse(JSON.stringify(x));

const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', doneAt: null, createdAt: '2026-11-24T01:0' + id.length + ':00.000Z' }, o);
const J1 = () => job('j1', { pickups: [{ placeId: 'ao', item: 'Float switch', done: false }], deliveryPlaceId: 'carrier' });
const J2 = () => job('j22', { pickups: [{ placeId: 'carrier', item: 'Ribbon', done: false }], deliveryPlaceId: 'home' });
const J3 = () => job('j333', { pickups: [{ placeId: 'ao', item: 'Gasket', done: false }], deliveryPlaceId: 'carrier' });
const base = () => [J2(), J1(), J3()]; // J1 is in the middle: its position must not change
const formFrom = (j, o) => Object.assign(JE.formOf(j), o || {});

console.log('1. collect AO Advance -> deliver Carrier, "Float switch": delivery changed to Office');
{
  const jobs = base();
  const res = JE.updateJob(jobs, 'j1', formFrom(jobs[1], { deliveryPlaceId: 'office' }));
  ok(res.ok, 'saved', res.error);
  ok(res.job.id === 'j1', 'same id');
  ok(res.job.deliveryPlaceId === 'office', 'delivery is now Office');
  eq(res.job.pickups, [{ placeId: 'ao', item: 'Float switch', done: false }], 'pickup and item unchanged');
  eq(res.jobs.map((j) => j.id), ['j22', 'j1', 'j333'], 'list order unchanged');
  ok(res.jobs.length === 3, 'job count unchanged');
  ok(jobs[1].deliveryPlaceId === 'carrier', 'the input list is not mutated');
  ok(res.jobs[0] === jobs[0] && res.jobs[2] === jobs[2], 'other jobs untouched');
}

console.log('2. a held job stays held');
{
  const jobs = base(); jobs[1].status = 'parked';
  const res = JE.updateJob(jobs, 'j1', formFrom(jobs[1], { deliveryPlaceId: 'office', notes: ' by 5 ' }));
  ok(res.ok && res.job.status === 'parked', 'still held (parked)', res.job && res.job.status);
  ok(res.job.notes === 'by 5', 'notes trimmed and saved');
}

console.log('3. a job with its pickup done at 11:02');
{
  const jobs = base(); jobs[1].pickups[0].done = true; jobs[1].pickups[0].doneAt = '2026-11-24T03:02:00.000Z';
  ok(JE.isEditable(jobs[1]), 'a job with one part done is editable');
  eq(JE.donePickups(jobs[1]).length, 1, 'the done pickup is reported (read-only in the form)');
  const f = formFrom(jobs[1], { deliveryPlaceId: 'office' });
  f.pickups[0].placeId = 'home'; f.pickups[0].item = 'something else'; // an attempt to change the collected pickup
  const res = JE.updateJob(jobs, 'j1', f);
  ok(res.ok, 'saved', res.error);
  ok(res.job.pickups.length === 1 && res.job.pickups[0].placeId === 'ao' && res.job.pickups[0].item === 'Float switch', 'pickup place and item NOT changed');
  ok(res.job.pickups[0].done === true && res.job.pickups[0].doneAt === '2026-11-24T03:02:00.000Z', 'its done time is kept');
  ok(res.ignored.includes('pickup'), 'the ignored change is reported');
  ok(res.job.deliveryPlaceId === 'office', 'the delivery place CAN be changed');
  const f2 = formFrom(jobs[1], { mode: 'errand', errandPlaceId: 'home' });
  ok(!JE.updateJob(jobs, 'j1', f2).ok, 'a job with a part done cannot become an errand');
  // a second pickup may still be added (pending)
  const f3 = formFrom(jobs[1]); f3.pickups.push({ placeId: 'home', item: 'extra' });
  const r3 = JE.updateJob(jobs, 'j1', f3);
  ok(r3.ok && r3.job.pickups.length === 2 && r3.job.pickups[0].done && !r3.job.pickups[1].done, 'a new pending pickup is added after the done one');
}

console.log('4. a fully done job is not editable');
{
  const jobs = base(); jobs[1].status = 'done'; jobs[1].doneAt = '2026-11-24T04:00:00.000Z'; jobs[1].pickups[0].done = true;
  ok(!JE.isEditable(jobs[1]), 'isEditable false');
  const res = JE.updateJob(jobs, 'j1', formFrom(jobs[1], { deliveryPlaceId: 'office' }));
  ok(!res.ok && res.jobs === jobs, 'rejected, list unchanged', res);
  ok(jobs[1].deliveryPlaceId === 'carrier', 'job unchanged');
}

console.log('5. a job linked to a loose item keeps the link (and its carry-forward history)');
{
  const jobs = base(); jobs[1].pickups = []; jobs[1].inHandItem = 'Float switch'; jobs[1].looseId = 'loose-9';
  jobs[1].carriedFrom = '2026-11-23'; jobs[1].carryReason = 'closed';
  const res = JE.updateJob(jobs, 'j1', formFrom(jobs[1], { deliveryPlaceId: 'office' }));
  ok(res.ok && res.job.looseId === 'loose-9', 'looseId kept', res.job);
  ok(res.job.carriedFrom === '2026-11-23' && res.job.carryReason === 'closed', 'carry-forward history kept');
  ok(res.job.inHandItem === 'Float switch' && res.job.createdAt === jobs[1].createdAt, 'in-hand item and createdAt kept');
}

console.log('6. an edit that makes pickup = delivery is a validation error; the job is unchanged');
{
  const jobs = base();
  const res = JE.updateJob(jobs, 'j1', formFrom(jobs[1], { deliveryPlaceId: 'ao' }));
  ok(!res.ok && /same place/i.test(res.error), 'validation error', res.error);
  ok(res.jobs === jobs && jobs[1].deliveryPlaceId === 'carrier', 'job and list unchanged');
  ok(JE.validate(formFrom(jobs[1], { deliveryPlaceId: 'ao' })) !== '', 'the same validate() is what Add job uses');
}

console.log('extra: validation of the required fields; urgent; errand');
{
  const jobs = base();
  ok(!JE.updateJob(jobs, 'j1', formFrom(jobs[1], { pickups: [], deliveryPlaceId: null })).ok, 'no pickup and no delivery -> error');
  const f = formFrom(jobs[1]); f.pickups.push({ placeId: null, item: 'orphan' });
  ok(/no place/.test(JE.validate(f)), 'an item without a place -> error');
  ok(JE.validate({ mode: 'errand', errandPlaceId: null }) !== '', 'errand without a place -> error');
  ok(!JE.updateJob(jobs, 'nope', formFrom(jobs[1])).ok, 'unknown id -> error');
  const a = base(); a[0].urgent = true; a[0].urgentRank = 1;
  const on = JE.updateJob(a, 'j1', formFrom(a[1], { urgent: true }));
  ok(on.job.urgent && on.job.urgentRank === 2, 'urgent on = next rank');
  const off = JE.updateJob(on.jobs, 'j22', formFrom(on.jobs[0], { urgent: false }));
  ok(!off.job.urgent && off.jobs.find((j) => j.id === 'j1').urgentRank === 1 && off.changedIds.includes('j1'), 'urgent off = the rest renumbered');
  const er = JE.updateJob(jobs, 'j1', { mode: 'errand', errandPlaceId: 'home', dwellMin: '', notes: '', after: '09:00', before: '' }, { placeDwell: () => 15 });
  ok(er.ok && er.job.errandPlaceId === 'home' && er.job.dwellMin === 15 && er.job.pickups.length === 0 && er.job.arriveAfter === '09:00', 'delivery -> errand', er.job);
}

console.log(passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
