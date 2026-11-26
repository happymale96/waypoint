'use strict';
// Proof of delivery (proof.js, pure parts): isProofStop over OnBoard.doneSplit, caption, stampLines, expired, fileName, and the
// day log / CSV columns "receiver" and "proof". The clock is pinned (26 Nov 2026 14:32 Malaysia time).
// Run: TZ=Asia/Kuala_Lumpur node test/proof.test.js
const Proof = require('../proof.js');
const OnBoard = require('../onboard.js');
const DL = require('../daylog.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

const T0 = Date.UTC(2026, 10, 26, 6, 32); // 26 Nov 2026 14:32 MYT
Date.now = () => T0; // pinned
const DAY = 86400000;
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, errandPlaceId: null, inHandItem: '', notes: '', urgent: false, status: 'pending' }, o);
const nameOf = (id) => ({ S: 'Supplier One', C: 'Beta Customer', X: 'Xtra Parts' })[id] || id;

console.log('isProofStop');
{
  // one pickup (for another job) and one delivery whose item is collected
  const jobs = [job('J1', { pickups: [{ placeId: 'S', item: 'Gasket', done: true }], deliveryPlaceId: 'C' }),
    job('J2', { pickups: [{ placeId: 'C', item: 'Pump', done: false }], deliveryPlaceId: 'S' })];
  const stop = { placeId: 'C', actions: [{ jobId: 'J2', kind: 'pickup', item: 'Pump' }, { jobId: 'J1', kind: 'deliver', item: 'Gasket' }] };
  const split = OnBoard.doneSplit(stop, jobs, nameOf);
  ok(Proof.isProofStop(stop, split), 'a stop with one pickup and one collected delivery is a proof stop');
  eq(Proof.proofDeliveries(split).map((a) => a.jobId), ['J1'], 'the proof covers the delivery only (not the pickup)');
}
{
  const jobs = [job('J1', { pickups: [{ placeId: 'X', item: 'Seal', done: false }], deliveryPlaceId: 'C' })];
  const stop = { placeId: 'C', actions: [{ jobId: 'J1', kind: 'deliver', item: 'Seal' }] };
  ok(!Proof.isProofStop(stop, OnBoard.doneSplit(stop, jobs, nameOf)), 'a stop whose only delivery is uncollected is not');
}
{
  // a collected delivery and one doneSplit leaves open: proof stop, the open one is not in the proof
  const jobs = [job('J1', { pickups: [{ placeId: 'S', item: 'Gasket', done: true }], deliveryPlaceId: 'C' }),
    job('J3', { pickups: [{ placeId: 'X', item: 'Seal', done: false }], deliveryPlaceId: 'C' })];
  const stop = { placeId: 'C', actions: [{ jobId: 'J1', kind: 'deliver', item: 'Gasket' }, { jobId: 'J3', kind: 'deliver', item: 'Seal' }] };
  const split = OnBoard.doneSplit(stop, jobs, nameOf);
  ok(Proof.isProofStop(stop, split), 'collected + uncollected delivery: a proof stop');
  eq(Proof.proofDeliveries(split).map((a) => a.jobId), ['J1'], 'the delivery doneSplit leaves open is not in the proof');
}
{
  const jobs = [job('J4', { pickups: [{ placeId: 'S', item: 'Box', done: false }] }), job('E1', { errandPlaceId: 'S', notes: 'Pay bill' })];
  const pick = { placeId: 'S', actions: [{ jobId: 'J4', kind: 'pickup', item: 'Box' }] };
  ok(!Proof.isProofStop(pick, OnBoard.doneSplit(pick, jobs, nameOf)), 'a pickup / just-collect stop is not');
  const er = { placeId: 'S', actions: [{ jobId: 'E1', kind: 'errand', item: 'Pay bill' }] };
  ok(!Proof.isProofStop(er, OnBoard.doneSplit(er, jobs, nameOf)), 'an errand stop is not');
  const fuel = { placeId: 'F', fuel: true, actions: [] };
  ok(!Proof.isProofStop(fuel, { apply: [{ kind: 'deliver', jobId: 'x' }], held: [] }), 'a fuel stop is never one');
  ok(!Proof.isProofStop({ placeId: 'H', end: true, actions: [] }, { apply: [], held: [] }) && !Proof.isProofStop(null, null), 'the end point / nothing is not');
  const inHand = [job('H1', { inHandItem: 'Spare fuse', deliveryPlaceId: 'C' })];
  const ih = { placeId: 'C', actions: [{ jobId: 'H1', kind: 'deliver', item: '' }] };
  ok(Proof.isProofStop(ih, OnBoard.doneSplit(ih, inHand, nameOf)), 'an in-hand delivery (the item is with the driver) is a proof stop');
}

console.log('caption');
const base = { id: 'pf1', state: 'done', placeName: 'Beta Customer', address: 'Lot 5, Jalan Kebun', doneAt: new Date(T0).toISOString(), items: ['Gasket'], receiver: '', noPhotoReason: '', photoIds: ['a'], gps: null };
eq(Proof.caption(base), 'DELIVERED - Beta Customer\nGasket\n26 Nov 2026, 2:32 pm', 'caption without receiver');
eq(Proof.caption(Object.assign({}, base, { receiver: 'Encik Ali' })), 'DELIVERED - Beta Customer\nGasket\nReceived by: Encik Ali\n26 Nov 2026, 2:32 pm', 'caption with receiver');
eq(Proof.caption(Object.assign({}, base, { items: ['Gasket', 'Pump motor'] })), 'DELIVERED - Beta Customer\nGasket, Pump motor\n26 Nov 2026, 2:32 pm', 'caption with two items');
eq(Proof.caption(Object.assign({}, base, { photoIds: [], noPhotoReason: 'Left at guard house', doneAt: new Date(Date.UTC(2026, 10, 26, 1, 5)).toISOString() })),
  'DELIVERED - Beta Customer\nGasket\nNo photo: Left at guard house\n26 Nov 2026, 9:05 am', 'caption for a no-photo proof (morning time)');
ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(Proof.caption(Object.assign({}, base, { receiver: 'Ali' }))), 'caption: no emoji');
eq(Proof.caption(Object.assign({}, base, { doneAt: new Date(Date.UTC(2026, 10, 26, 4, 0)).toISOString() })).split('\n').pop(), '26 Nov 2026, 12:00 pm', 'noon reads 12:00 pm');
eq(Proof.caption(Object.assign({}, base, { doneAt: new Date(Date.UTC(2026, 10, 25, 16, 10)).toISOString() })).split('\n').pop(), '26 Nov 2026, 12:10 am', 'Malaysia date, not UTC: 12:10 am on 26 Nov');

console.log('stampLines');
{
  const gps = { lat: 3.123454, lon: 101.543206, acc: 12.4, at: T0 - 60000 };
  const p = Object.assign({}, base, { receiver: 'Encik Ali', gps });
  eq(Proof.stampLines(p, { takenAt: T0, gps }), ['Beta Customer', 'Lot 5, Jalan Kebun', '26 Nov 2026 14:32', 'GPS 3.12345, 101.54321 ±12 m', 'Received by: Encik Ali', 'Gasket'], 'all lines, in order');
  eq(Proof.stampLines(Object.assign({}, base, { address: '' }), { takenAt: T0, gps: null }), ['Beta Customer', '26 Nov 2026 14:32', 'GPS not available', 'Gasket'], 'no address, no fix, no receiver');
  eq(Proof.stampLines(p, { takenAt: T0, gps: Object.assign({}, gps, { at: T0 - 121000 }) })[3], 'GPS not available', 'a fix older than 2 minutes at capture: GPS not available');
  eq(Proof.stampLines(p, { takenAt: T0, gps: Object.assign({}, gps, { at: T0 - 120000 }) })[3], 'GPS 3.12345, 101.54321 ±12 m', 'a fix exactly 2 minutes old still counts');
  const long = Proof.stampLines(Object.assign({}, base, { items: ['Whole sample set with mech seal', 'Compressor assembly', 'Gasket kit'] }), { takenAt: T0, gps: null }).pop();
  ok(long.length === 60 && long.endsWith('…') && long.startsWith('Whole sample set with mech seal, Compressor'), 'items joined by ", " and cut to 60 characters', long);
}

console.log('expired');
{
  const at = (d) => ({ id: 'd' + d, doneAt: new Date(T0 - d * DAY).toISOString() });
  eq(Proof.expired([at(729), at(730), at(731), { id: 'draft', doneAt: null }], T0), ['d731'], '729 and 730 days kept, 731 expired, a draft never');
}

console.log('fileName');
eq(Proof.fileName(base, 1, 'item'), '2026-11-26_beta-customer_item_1.jpg', 'item: date + slug + item + n');
eq(Proof.fileName(base, 2, 'do'), '2026-11-26_beta-customer_DO_2.jpg', 'DO: date + slug + DO + n');
eq(Proof.fileName(base, 1), '2026-11-26_beta-customer_item_1.jpg', 'no kind given: item');
eq(Proof.fileName(Object.assign({}, base, { placeName: 'Pacific Klang Oil Seals Sdn. Bhd. (Klang)' }), 3, 'item'), '2026-11-26_pacific-klang-oil-seals-sdn-bhd-klang_item_3.jpg', 'punctuation and spaces become single dashes');
eq(Proof.fileName(Object.assign({}, base, { placeName: '  Café & Co.  ' }), 2, 'do'), '2026-11-26_cafe-co_DO_2.jpg', 'accents dropped, trimmed');
eq(Proof.fileName(Object.assign({}, base, { placeName: '***', doneAt: new Date(Date.UTC(2026, 10, 25, 17, 0)).toISOString() }), 1, 'item'), '2026-11-26_place_item_1.jpg', 'empty slug -> "place"; Malaysia date');

console.log('two kinds: share order, old photos, counts');
{
  // taken in mixed order: DO, item, DO, item, item (ids listed in a different order than taken, to show capture time wins)
  const ph = (id, kind, s) => ({ id, kind, takenAt: T0 + s * 1000 });
  const phs = [ph('d1', 'do', 1), ph('i1', 'item', 2), ph('d2', 'do', 3), ph('i2', 'item', 4), ph('i3', 'item', 5)];
  const p = Object.assign({}, base, { photoIds: ['i3', 'd2', 'i1', 'd1', 'i2'] });
  const list = Proof.shareList(p, phs.slice().reverse());
  eq(list.map((x) => x.photo.id), ['i1', 'i2', 'i3', 'd1', 'd2'], 'share: item photos first in capture order, then DO photos in capture order');
  eq(list.map((x) => x.name), ['2026-11-26_beta-customer_item_1.jpg', '2026-11-26_beta-customer_item_2.jpg', '2026-11-26_beta-customer_item_3.jpg',
    '2026-11-26_beta-customer_DO_1.jpg', '2026-11-26_beta-customer_DO_2.jpg'], 'share names numbered per kind from 1');
  const tie = Proof.shareList(Object.assign({}, base, { photoIds: ['b', 'a'] }), [{ id: 'a', kind: 'item', takenAt: T0 }, { id: 'b', kind: 'item', takenAt: T0 }]);
  eq(tie.map((x) => x.photo.id), ['b', 'a'], 'same capture time: the order in photoIds');
  const old = [{ id: 'o1', takenAt: T0 + 2000 }, { id: 'o2', takenAt: T0 + 1000 }, { id: 'n1', kind: 'do', takenAt: T0 }];
  eq(Proof.kindOf(old[0]), 'item', 'a photo saved before this build (no kind) is an item photo');
  eq(Proof.countKinds(old), { item: 2, do: 1 }, 'countKinds: no kind counts as item');
  eq(Proof.shareList(base, old).map((x) => x.name.replace('2026-11-26_beta-customer_', '')), ['item_1.jpg', 'item_2.jpg', 'DO_1.jpg'], 'old photos share first, as item photos');
  eq(Proof.caption(Object.assign({}, base, { photoIds: ['i1', 'd1'], counts: { item: 1, do: 1 } })), Proof.caption(base), 'the caption text is unchanged by the kinds');
}

console.log('CSV proof text');
eq(Proof.csvCell(Proof.summaryOf({ id: 'a', photoIds: ['1', '2', '3', '4', '5'], counts: { item: 3, do: 2 }, noPhotoReason: '', receiver: '' })), '3 item, 2 DO photos', '"3 item, 2 DO photos"');
eq(Proof.csvCell(Proof.summaryOf({ id: 'a', photoIds: ['1'], counts: { item: 0, do: 1 } })), '0 item, 1 DO photos', 'DO only');
eq(Proof.csvCell({ photos: 2 }), '2 item, 0 DO photos', 'a summary from before this build ({photos} only): every photo is item');
eq(Proof.csvCell(Proof.summaryOf({ id: 'a', photoIds: ['1', '2'] })), '2 item, 0 DO photos', 'a proof saved before this build (no counts): item photos');
eq(Proof.csvCell({ photos: 0, noPhotoReason: 'Left at guard house' }), 'no photo: Left at guard house', 'no photo: unchanged');

console.log('day log + CSV: receiver, proof');
{
  const places = { S: { id: 'S', name: 'Supplier One', lat: 3, lng: 101 }, C: { id: 'C', name: 'Beta Customer', lat: 3.1, lng: 101.1 } };
  const jobs = [job('J1', { pickups: [{ placeId: 'S', item: 'Gasket', done: true }], deliveryPlaceId: 'C', status: 'done' }),
    job('J2', { inHandItem: 'Fuse', deliveryPlaceId: 'C', status: 'done' }),
    job('E1', { errandPlaceId: 'S', notes: 'Pay bill', status: 'done' })];
  const day = DL.newDay('2026-11-26', 'Calvin');
  DL.recordPlan(day, { nowIso: new Date(T0 - 3 * 3600000).toISOString(), departAtIso: new Date(T0 - 3 * 3600000).toISOString(), start: places.S, jobs, places, stopOrder: ['S', 'C'] });
  DL.recordDone(day, { nowIso: new Date(T0 - 3600000).toISOString(), stopId: 'S', actions: [{ jobId: 'J1', kind: 'pickup', item: 'Gasket' }, { jobId: 'E1', kind: 'errand', item: 'Pay bill' }], places });
  const pr = Proof.summaryOf({ id: 'pf9', photoIds: ['a', 'b', 'c'], counts: { item: 2, do: 1 }, noPhotoReason: '', receiver: ' Encik Ali ' });
  const evs = DL.recordDone(day, { nowIso: new Date(T0).toISOString(), stopId: 'C', actions: [{ jobId: 'J1', kind: 'deliver', item: 'Gasket' }, { jobId: 'J2', kind: 'deliver', item: '' }], places, proof: pr, proofJobIds: ['J1', 'J2'] });
  ok(evs.every((e) => e.proofId === 'pf9' && e.proof.photos === 3 && e.proof.itemPhotos === 2 && e.proof.doPhotos === 1), 'the done events of the delivery carry the proof id and the counts per kind', evs);
  const lines = DL.toCSV(DL.summarise(day, jobs, places)).trim().split('\r\n');
  ok(lines[0].endsWith(',late,receiver,proof'), 'CSV: receiver and proof are the last two columns', lines[0]);
  const row = (needle) => lines.find((l) => l.indexOf(needle) >= 0);
  ok(row(',delivery,').endsWith(',Encik Ali,"2 item, 1 DO photos"'),'delivery row: receiver + "2 item, 1 DO photos" (quoted: it has a comma)', row(',delivery,'));
  ok(row(',in-hand,').endsWith(',Encik Ali,"2 item, 1 DO photos"'), 'in-hand delivery row: the same proof', row(',in-hand,'));
  ok(lines[0].split(',').length === 14 && lines.slice(1).every((l) => l.replace(/"[^"]*"/g, 'q').split(',').length === 14), 'still 14 columns in every row', lines);
  const oldDay = DL.newDay('2026-11-26', 'Calvin');
  DL.recordDone(oldDay, { nowIso: new Date(T0).toISOString(), stopId: 'C', actions: [{ jobId: 'J2', kind: 'deliver', item: '' }], places, proof: { id: 'old', photos: 2, noPhotoReason: '', receiver: '' } });
  ok(DL.toCSV(DL.summarise(oldDay, [jobs[1]], places)).trim().split('\r\n')[1].endsWith(',"2 item, 0 DO photos"'), 'a day-log proof from before this build ({photos: 2}): "2 item, 0 DO photos"');
  ok(row(',errand,').endsWith(',,'), 'errand row: both empty', row(',errand,'));
  const noPh = Proof.summaryOf({ id: 'pf10', photoIds: [], noPhotoReason: 'Photos not allowed', receiver: '' });
  const d2 = DL.newDay('2026-11-26', 'Calvin');
  DL.recordDone(d2, { nowIso: new Date(T0).toISOString(), stopId: 'C', actions: [{ jobId: 'J2', kind: 'deliver', item: '' }], places, proof: noPh });
  ok(DL.toCSV(DL.summarise(d2, [jobs[1]], places)).trim().split('\r\n')[1].endsWith(',,no photo: Photos not allowed'), 'no-photo proof: "no photo: <reason>"');
  eq(Proof.csvCell({ photos: 1, itemPhotos: 1, doPhotos: 0 }), '1 item, 0 DO photos', 'one photo: the same pattern');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
