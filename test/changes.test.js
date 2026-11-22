'use strict';
// Place-type label, WhatsApp number shapes, and the day-km chain start rule.
const M = require('../messages.js');
const G = require('../geo.js');
const DL = require('../daylog.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const near = (a, b, name) => ok(a != null && Math.abs(a - b) < 1e-6, name, { got: a, want: b });

// ---- 1. "factory" is shown as "customer factory", stored as "factory" ----
console.log('place type label');
eq(M.typeLabel('factory'), 'customer factory', 'factory renders as "customer factory"');
eq(['supplier', 'office', 'home', 'other'].map(M.typeLabel), ['supplier', 'office', 'home', 'other'], 'other types render unchanged');
eq(M.typeLabel(undefined), '', 'missing type renders empty');
const ctx = { uid: () => 'p1', dwellDefaults: { factory: 20 }, DEFAULT_DWELL: { factory: 20, supplier: 5, other: 10, office: 10, home: 0 } };
const place = G.manualPlace({ name: 'Acme', type: 'factory', lat: 3.1, lng: 101.7 }, ctx);
eq(place.type, 'factory', 'a place saved as customer factory still stores type "factory"');
eq(place.dwellMin, 20, 'and still takes the "factory" dwell default');
eq(M.typeLabel(place.type), 'customer factory', 'and displays as customer factory');
// the app's option lists: stored value is the key, shown text is the label (checked against the source so a regression is caught)
const appSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
ok(/const TYPES = \['factory',/.test(appSrc), 'app.js keeps the stored type key "factory"');
ok(!/TYPES\.map\(\(t\) => h\('option', \{[^}]*\}, t\)\)/.test(appSrc), 'no type <option> shows the raw key');
ok(/Messages\.typeLabel\(p\.type\)/.test(appSrc) && /Messages\.typeLabel\(t\)/.test(appSrc), 'chip, options and Settings dwell labels use typeLabel');

// ---- 2. WhatsApp numbers ----
console.log('whatsapp numbers');
const A = '+60194347041', B = '+60 11-2618 6640';
eq(M.waLink(A, 'Hi'), 'https://wa.me/60194347041?text=Hi', 'compact +60 number -> wa.me link');
eq(M.waLink(B, 'Hi'), 'https://wa.me/601126186640?text=Hi', 'spaced/dashed +60 number -> wa.me link');
ok(/^https:\/\/wa\.me\/60\d{9,10}\?text=/.test(M.waLink(A, 'x')) && /^https:\/\/wa\.me\/60\d{9,10}\?text=/.test(M.waLink(B, 'x')), 'both links are wa.me/60 + digits');
eq(M.waLink('+60 11-2618 6640', 'Hi'), M.waLink('+601126186640', 'Hi'), 'spaced and compact shapes give the same link');
eq(M.waLink('(+60) 19-434 7041', 'Hi'), M.waLink(A, 'Hi'), 'brackets are stripped');
eq(M.waLink('011-2618 6640', 'Hi'), M.waLink(B, 'Hi'), 'local 0-prefixed shape gives the same link');
eq(M.waLink('+60 011-2618 6640', 'Hi'), M.waLink(B, 'Hi'), '+60 followed by a trunk 0 is repaired');
eq(M.compactNumber(B), '+601126186640', 'compact form of the spaced number');
eq(M.compactNumber(A), A, 'compact form of a compact number is unchanged');
eq(M.compactNumber(' 012-345 6789 '), '+60123456789', 'local shape -> +60...');
eq(M.compactNumber(''), '', 'empty stays empty');
eq(M.compactNumber(null), '', 'null stays empty');
// normalised on read, never rewritten in storage
const stored = { whatsapp: B };
const shown = M.compactNumber(stored.whatsapp);
eq(stored.whatsapp, B, 'reading does not mutate the stored value');
eq(shown, '+601126186640', 'the value shown/used is normalised');

// ---- 3. day km chain start ----
console.log('day km chain');
const T = (h, m) => new Date(Date.UTC(2026, 10, 20, h, m)).toISOString(); // UTC clock, day 20 Nov
const CARRIER = { lat: 2.94610, lng: 101.75816 };
const places = {
  A: { id: 'A', name: 'Stop A', lat: 3.10000, lng: 101.60000 },
  B: { id: 'B', name: 'Stop B', lat: 3.15000, lng: 101.65000 },
};
const job = { id: 'j1', pickups: [{ placeId: 'A', item: 'Part', done: false }], deliveryPlaceId: 'B', notes: '', urgent: false, urgentRank: 0, arriveBefore: null, status: 'pending' };
const ptKey = (p) => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
const A_B = ptKey(places.A) + '>' + ptKey(places.B);
const C_A = ptKey(CARRIER) + '>' + ptKey(places.A);

function mk(planAtIso, firstDoneIso, secondDoneIso) {
  const day = DL.newDay({ date: '2026-11-20', driverId: 'Calvin' });
  DL.recordPlan(day, { nowIso: planAtIso, start: CARRIER, departAtIso: planAtIso, jobs: [job], places, stopOrder: ['A', 'B'], plannedKm: 80, plannedDriveMin: 90 });
  DL.recordDone(day, { nowIso: firstDoneIso, stopId: 'A', actions: [{ jobId: 'j1', kind: 'pickup', item: 'Part' }], places });
  DL.recordDone(day, { nowIso: secondDoneIso, stopId: 'B', actions: [{ jobId: 'j1', kind: 'deliver', item: 'Part' }], places });
  day.legs[A_B] = { m: 10000, s: 900 };
  day.legs[C_A] = { m: 61000, s: 3000 }; // the leg that was invented in the 20 Nov log
  return day;
}

// 20 Nov shape: the only plan departed 07:43Z, the first DONE was 04:14Z
const late = mk(T(7, 43), T(4, 14), T(6, 0));
let s = DL.summarise(late, [job], places);
eq(s.route.points.map(ptKey), [ptKey(places.A), ptKey(places.B)], 'plan departed AFTER the first DONE: chain starts at the first visited stop');
ok(s.route.startDropped === true, 'and the summary says the plan start was dropped');
eq(s.km.status, 'ok', 'km is computable from the driven legs');
near(s.km.value, 10, 'km is A->B only; the 61 km plan-start leg is not added');

// normal day: the plan departs first
const normal = mk(T(1, 0), T(2, 20), T(4, 0));
s = DL.summarise(normal, [job], places);
eq(s.route.points.map(ptKey), [ptKey(CARRIER), ptKey(places.A), ptKey(places.B)], 'plan first: chain still starts at the plan start (unchanged)');
ok(s.route.startDropped === false, 'normal day does not flag a dropped start');
near(s.km.value, 71, 'normal day km = plan start->A + A->B (unchanged)');

// plan departs at exactly the first DONE time is not "before": start from the first stop
const tie = mk(T(4, 14), T(4, 14), T(6, 0));
eq(DL.summarise(tie, [job], places).route.points.length, 2, 'departing at the same instant as the first DONE is not before it');

// no DONE at all: the start point is kept (nothing visited yet, km "none")
const noDone = DL.newDay({ date: '2026-11-20', driverId: 'Calvin' });
DL.recordPlan(noDone, { nowIso: T(1, 0), start: CARRIER, departAtIso: T(1, 0), jobs: [job], places, stopOrder: ['A', 'B'] });
s = DL.summarise(noDone, [job], places);
eq(s.km.status, 'none', 'plan with no stops visited: km none, not unavailable');

// stored route: dropped for the changed chain only
console.log('stored route repair');
const oldKey = [CARRIER, places.A, places.B].map(ptKey).join('|');
const oldRoute = () => ({ key: oldKey, legs: [{ m: 61000, s: 3000 }, { m: 10000, s: 900 }], at: T(9, 0) });
const lateR = mk(T(7, 43), T(4, 14), T(6, 0)); lateR.legs = {}; lateR.routed = oldRoute();
const normalR = mk(T(1, 0), T(2, 20), T(4, 0)); normalR.legs = {}; normalR.date = '2026-11-19'; normalR.routed = oldRoute();
const days = { '2026-11-20': lateR, '2026-11-19': normalR };
const res = DL.repairHistory(days, [job], places);
eq(res.routeDropped, ['2026-11-20'], 'only the day whose chain changed has its route dropped');
ok(lateR.routed === null, 'the stale stored route is gone');
ok(normalR.routed && normalR.routed.key === oldKey, 'a normal day keeps its stored route');
s = DL.summarise(lateR, [job], places);
eq(s.km.status, 'unavailable', 'dropped route: km is unavailable until recomputed');
ok(s.route.needs === true, 'and the retry state is on');
const again = DL.repairHistory(days, [job], places);
eq(again.routeDropped, [], 'repair is idempotent');

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
