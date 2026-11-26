'use strict';
// 26 Nov 2026 (Nilai, build 4058925d): the fuel sheet said "+0 min" for a 12-minute detour, a cafe inside a station was saved
// as the station, and the sheet printed "nullnull". Run as its own node script: node test/fueldetour.test.js
// A: added minutes = t(A,S) + t(S,B) - t(A,B), all three fetched from the same source now; no figure = "time not available".
// B: only fuel stations are kept (name rule), one of two remembered entries within 150 m, the one-time guarded clean-up.
// C: the added-minutes text never says null / undefined.
const Fuel = require('../fuel.js');

const PINNED = Date.UTC(2026, 10, 26, 3, 14, 0); // 26 Nov 2026 11:14 MYT: the clock never comes from the machine
Date.now = () => PINNED;

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const key = (p) => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
const k = (p) => Object.assign({}, p, { key: key(p) });
const near = (a, b) => Fuel.haversineKm(a, b) < 0.03; // within 30 m = the same point for the mocked provider

// the observed points: live GPS in Nilai, the Office, Home, Caltex Pajam (and a second listing a few metres away)
const O = { lat: 2.8230, lng: 101.8055, id: 'live', name: 'your location' };
const F = { id: 'office', name: 'Office (L-Tech)', lat: 3.09941, lng: 101.73900 };
const H = { lat: 3.0757673, lng: 101.6609445, id: 'end', name: 'Home (Bloomsvale)' };
const S = k({ placeId: 'caltexPajam', name: 'Caltex Pajam', lat: 2.8100, lng: 101.8290, fuel: true });
const S2 = k({ placeId: 'caltexPajam2', name: 'Caltex Pajam', lat: 2.81003, lng: 101.82903, fuel: true }); // ~5 m from S

// a mocked provider: minutes by (from, to), matched within 30 m; records every request; null = no answer for that leg
function provider(table) {
  const calls = [];
  const fetchMin = async (a, b) => {
    calls.push(a.key + '>' + b.key);
    const row = table.find((t) => near(t.a, a) && near(t.b, b));
    return row ? row.min : null;
  };
  return { calls, fetchMin };
}
const OBSERVED = [
  { a: O, b: S, min: 11 }, { a: S, b: F, min: 43 }, { a: O, b: F, min: 42 }, { a: F, b: H, min: 23 },
  { a: F, b: S, min: 40 }, { a: S, b: H, min: 45 }, // the other position (Office -> station -> Home): 40 + 45 - 23 = 62
];
const estMin = (a, b) => (a.key === b.key ? 0 : Fuel.haversineKm(a, b) * 1.4 / 35 * 60); // the app's last-resort estimate
const routeNoFuel = { origin: O, stops: [{ id: 'office', name: F.name, lat: F.lat, lng: F.lng }], end: H };

(async () => {
  console.log('A1. the observed case: O -> F 42, O -> S 11, S -> F 43, F -> H 23, no fuel stop in the route');
  {
    const pts = Fuel.remainingPoints(routeNoFuel).map(k), legs = Fuel.allowedLegs(routeNoFuel);
    const cands = Fuel.allCandidates(pts, [S], legs);
    // the cause, reproduced: the direct leg from a live-GPS origin is not a plan point, so it fell back to the estimate
    const oldFigure = 11 + 43 - estMin(pts[0], pts[1]);
    ok(oldFigure < 0 && Math.max(0, Math.round(oldFigure)) === 0, 'cause: with the 35 km/h estimate for O -> F (' + Math.round(estMin(pts[0], pts[1])) + ' min) the old figure is negative, shown as +0', oldFigure);
    const pv = provider(OBSERVED);
    const res = await Fuel.realTimeShortlist(cands, estMin, pv.fetchMin, 8, 16);
    ok(res.sorted[0].legIndex === 0 && res.sorted[0].detourMin === 12, 'the first offer: between your location and the Office, 11 + 43 - 42 = 12', res.sorted[0] && res.sorted[0].detourMin);
    ok(Fuel.detourText(res.sorted[0]) === '+12 min', 'the sheet text is "+12 min"', Fuel.detourText(res.sorted[0]));
    ok(res.sorted[1].legIndex === 1 && res.sorted[1].detourMin === 62, 'next best: between the Office and Home, 40 + 45 - 23 = 62', res.sorted[1] && res.sorted[1].detourMin);

    console.log('A3. all three legs from the same source, at the same time');
    const want = [key(O) + '>' + S.key, S.key + '>' + key(F), key(O) + '>' + key(F)];
    ok(want.every((x) => pv.calls.includes(x)), 'in, out and the direct leg it replaces were each fetched from the one provider', pv.calls);
    ok(res.requests === pv.calls.length && new Set(pv.calls).size === pv.calls.length && res.requests === 6, '6 distinct requests for 2 positions (no leg twice)', res.requests);
  }

  console.log('A4. a figure that is not available is never "+0 min" and ranks last');
  {
    const pts = Fuel.remainingPoints(routeNoFuel).map(k), legs = Fuel.allowedLegs(routeNoFuel);
    const T = k({ placeId: 't', name: 'Caltex Mantin', lat: 2.83, lng: 101.79, fuel: true });
    const noDirect = OBSERVED.filter((r) => !(r.a === O && r.b === F)).concat([{ a: O, b: T, min: 2 }, { a: T, b: F, min: 41 }]);
    const pv = provider(noDirect);
    const res = await Fuel.realTimeShortlist(Fuel.allCandidates(pts, [S, T], legs), estMin, pv.fetchMin, 8, 16);
    const first = res.sorted.findIndex((c) => c.detourMin == null);
    ok(first > 0 && res.sorted.slice(first).every((c) => c.detourMin == null), 'candidates without a figure come after every real one', res.sorted.map((c) => c.detourMin));
    ok(res.sorted.filter((c) => c.legIndex === 0).every((c) => c.detourMin == null && Fuel.detourText(c) === 'time not available'), 'the direct leg O -> F missing: "time not available" (not "+0 min")', res.sorted.map(Fuel.detourText));
    ok(Fuel.detourText({ detourMin: null }) === 'time not available' && Fuel.detourText({}) === 'time not available' && Fuel.detourText({ detourMin: NaN }) === 'time not available', 'null / missing / NaN: "time not available"');
    const down = await Fuel.realTimeShortlist(Fuel.allCandidates(pts, [S], legs), estMin, async () => { const e = new Error('down'); e.kind = 'limit'; throw e; }, 8, 16);
    ok(down.estimated && down.sorted.length > 0 && down.sorted.every((c) => Fuel.detourText(c) === 'time not available'), 'TomTom out: every candidate says "time not available", in the estimate order');
  }

  console.log('A5. the first offer has the smallest real added minutes; Next best walks up');
  {
    const pts = Fuel.remainingPoints(routeNoFuel).map(k), legs = Fuel.allowedLegs(routeNoFuel);
    const X = k({ placeId: 'x', name: 'Caltex Nilai 3', lat: 2.85061, lng: 101.79885, fuel: true }); // the estimator's favourite (on the line O -> F)
    const Y = k({ placeId: 'y', name: 'Caltex Bandar Baru Nilai', lat: 2.84, lng: 101.82, fuel: true }); // ~2 km off the line
    const table = OBSERVED.concat([{ a: O, b: X, min: 1 }, { a: X, b: F, min: 60 }, { a: O, b: Y, min: 4 }, { a: Y, b: F, min: 40 }]);
    const pv = provider(table);
    const res = await Fuel.realTimeShortlist(Fuel.allCandidates(pts, [X, S, Y], legs), estMin, pv.fetchMin, 8, 16);
    const est0 = Fuel.pickInsertion(Fuel.allCandidates(pts, [X, S, Y], legs), estMin)[0];
    ok(est0.station.placeId === 'x', 'the estimate alone would put X first');
    ok(res.sorted[0].station.placeId === 'y' && res.sorted[0].detourMin === 2, 'the real figures put Y first (+2: 4 + 40 - 42)', res.sorted.map((c) => c.station.placeId + ':' + c.detourMin));
    const real = res.sorted.filter((c) => c.detourMin != null);
    ok(real.every((c, i) => i === 0 || c.detourMin >= real[i - 1].detourMin), 'Next best: added minutes never go down', real.map((c) => c.detourMin));
  }

  console.log('A6. Change fuel stop: S already in the route, S2 a few metres away with the same leg times');
  {
    const withS = { origin: O, stops: [{ id: '__fuel__', fuel: true, lat: S.lat, lng: S.lng }, { id: 'office', name: F.name, lat: F.lat, lng: F.lng }], end: H };
    const pts = Fuel.remainingPoints(withS).map(k), legs = Fuel.allowedLegs(withS);
    ok(pts.length === 3 && !pts.some((p) => p.fuel), 'the fuel stop already in the route is not part of the route compared against', pts.map((p) => p.id));
    const res = await Fuel.realTimeShortlist(Fuel.allCandidates(pts, [S2], legs), estMin, provider(OBSERVED).fetchMin, 8, 16);
    ok(Fuel.detourText(res.sorted[0]) === '+12 min' && res.sorted[0].b.id === 'office', 'the Change sheet shows "+12 min" for S2 (not "+0 min")', Fuel.detourText(res.sorted[0]));
    // what the guard prevents: counted as a normal stop, S would make S2 look free
    const asStop = { origin: O, stops: [{ id: 'S', lat: S.lat, lng: S.lng }, { id: 'office', lat: F.lat, lng: F.lng }], end: H };
    const p2 = Fuel.remainingPoints(asStop).map(k);
    const bad = await Fuel.realTimeShortlist(Fuel.allCandidates(p2, [S2], Fuel.allowedLegs(asStop)), estMin, provider(OBSERVED.concat([{ a: S, b: S, min: 0 }])).fetchMin, 8, 16);
    ok(bad.sorted[0] && Math.round(bad.sorted[0].detourMin) <= 0, 'control: compared against a route that still holds S, S2 would read "+0 min"', bad.sorted[0] && bad.sorted[0].detourMin);
  }

  console.log('A7. never more than 16 TomTom requests per fuel search (8 candidates x 2 before; now in + out + direct within 16)');
  {
    const route = { origin: { lat: 3.00, lng: 101.60, id: 'o' }, stops: [{ id: 'a', lat: 3.05, lng: 101.65 }, { id: 'b', lat: 3.10, lng: 101.70 }], end: { lat: 3.15, lng: 101.75, id: 'e' } };
    const pts = Fuel.remainingPoints(route).map(k), legs = Fuel.allowedLegs(route);
    const stations = Array.from({ length: 12 }, (_, i) => k({ placeId: 'st' + i, name: 'Caltex ' + i, lat: 3.0 + i * 0.013 + (i % 3) * 0.004, lng: 101.6 + i * 0.013 - (i % 2) * 0.006, fuel: true }));
    const calls = [];
    const res = await Fuel.realTimeShortlist(Fuel.allCandidates(pts, stations, legs), estMin, async (a, b) => { calls.push(a.key + '>' + b.key); return estMin(a, b) * 1.3; }, 8, 16);
    ok(calls.length <= 16 && res.requests === calls.length && new Set(calls).size === calls.length, 'at most 16 distinct requests (' + calls.length + ')', calls.length);
    ok(res.sorted.length > 0 && res.sorted.length <= 8 && res.sorted.every((c) => c.detourMin != null), 'every candidate offered has a real figure (' + res.sorted.length + ' evaluated)', res.sorted.length);
  }

  console.log('B1. only fuel stations are kept (no place type in the request: the name decides)');
  {
    const keep = ['Caltex Pajam', 'Caltex Station 12_3', 'Stesen Minyak Caltex Nilai', 'Petrol Station Caltex Mantin', 'CALTEX Bandar Baru Nilai'];
    const drop = ['ZUS Coffee - Caltex Pajam', 'FamilyMart @ Caltex Seremban 2', 'Tealive Caltex Pajam', '7-Eleven Caltex Station Nilai', 'KFC Drive-Thru Caltex', ''];
    keep.forEach((n) => ok(Fuel.isStationName(n, 'Caltex'), 'kept: "' + n + '"'));
    drop.forEach((n) => ok(!Fuel.isStationName(n, 'Caltex'), 'dropped: "' + n + '"'));
    ok(Fuel.isStationName('Stesen Minyak Pajam', 'Caltex') && !Fuel.isStationName('Kedai Runcit Pajam', 'Caltex'), 'without the brand: kept only with Stesen / Station / Petrol / Minyak');
    const mem = [{ placeId: 'zus', name: 'ZUS Coffee - Caltex Pajam', brand: 'Caltex', lat: 2.8104, lng: 101.8293 }, { placeId: 'cp', name: 'Caltex Pajam', brand: 'Caltex', lat: 2.81, lng: 101.829 }];
    ok(Fuel.stationsOfBrand(mem, 'Caltex').map((s) => s.placeId).join() === 'cp', 'a shop already remembered is never offered');
  }

  console.log('B2. two remembered entries within 150 m: one stays');
  {
    const zus = { placeId: 'zus', name: 'ZUS Coffee - Caltex Pajam', address: 'Caltex Pajam, PT 2324 Jalan Pajam Nilai, 71700 Mantin, Negeri Sembilan', brand: 'Caltex', lat: 2.8104, lng: 101.8293 };
    const cp = { placeId: 'cp', name: 'Caltex Pajam', address: 'Caltex Pajam, PT2342, Jalan Pusat Perniagaan Sarjana 1, Pusat Perniagaan Sarjana, 71700 Mantin, Negeri Sembilan', brand: 'Caltex', lat: 2.8100, lng: 101.8290 };
    ok(Fuel.haversineKm(zus, cp) * 1000 < 150, 'the two Pajam listings are within 150 m (' + Math.round(Fuel.haversineKm(zus, cp) * 1000) + ' m)');
    ok(Fuel.cleanStations([zus, cp], 'Caltex').map((s) => s.placeId).join() === 'cp' && Fuel.cleanStations([cp, zus], 'Caltex').map((s) => s.placeId).join() === 'cp', 'the Pajam pair: "Caltex Pajam" stays, either order');
    const sm = { placeId: 'sm', name: 'Stesen Minyak Caltex Pajam', brand: 'Caltex', lat: 2.8102, lng: 101.8291 };
    ok(Fuel.cleanStations([sm, cp], 'Caltex').map((s) => s.placeId).join() === 'cp' && Fuel.cleanStations([cp, sm], 'Caltex').map((s) => s.placeId).join() === 'cp', 'both stations: the one whose name starts with "Caltex" stays');
    const far = { placeId: 'far', name: 'Caltex Mantin', brand: 'Caltex', lat: 2.8120, lng: 101.8290 }; // ~220 m
    ok(Fuel.cleanStations([cp, far], 'Caltex').length === 2, 'over 150 m apart: both stay');
    const merged = Fuel.cleanStations(Fuel.mergeStations([cp], [{ placeId: 'cp-b', name: 'Caltex Pajam', lat: 2.81005, lng: 101.82905, brand: 'Caltex' }], '2026-11-26T03:14:00.000Z'), 'Caltex');
    ok(merged.length === 1 && merged[0].placeId === 'cp', 'a new listing of a remembered station (15 m away) does not add a second entry');
  }

  console.log('B3. the one-time clean-up of the remembered stations (a fixture modelled on the phone: 69 remembered)');
  {
    const base = { lat: 2.70, lng: 101.55 };
    const list = [];
    for (let i = 0; i < 52; i++) list.push({ placeId: 'c' + i, name: 'Caltex ' + ['Pajam', 'Nilai', 'Mantin', 'Seremban', 'Kajang', 'Bangi', 'Putrajaya', 'Cheras', 'Puchong', 'Klang', 'Shah Alam', 'Subang', 'Sungai Besi'][i % 13] + ' ' + i, address: 'Jalan ' + i, brand: 'Caltex', lat: base.lat + Math.floor(i / 8) * 0.06, lng: base.lng + (i % 8) * 0.06, savedAt: '2026-11-2' + (i % 6) + 'T02:00:00.000Z' });
    list[0] = Object.assign({}, list[0], { name: 'Caltex Pajam', lat: 2.8100, lng: 101.8290 });
    const shops = ['ZUS Coffee - Caltex Pajam', 'FamilyMart @ Caltex Nilai 1', '7-Eleven Caltex Mantin 2', 'Tealive @ Caltex Seremban 3', 'KFC Caltex Kajang 4', 'ZUS Coffee - Caltex Bangi 5', 'FamilyMart @ Caltex Putrajaya 6', 'Kenny Rogers Caltex Cheras 7', 'Watsons Caltex Puchong 8'];
    shops.forEach((n, j) => list.push({ placeId: 'shop' + j, name: n, address: 'inside', brand: 'Caltex', lat: list[j].lat + 0.0004, lng: list[j].lng + 0.0003, savedAt: '2026-11-25T02:00:00.000Z' }));
    for (let j = 0; j < 8; j++) list.push({ placeId: 'dup' + j, name: list[10 + j].name, address: 'second listing', brand: 'Caltex', lat: list[10 + j].lat + 0.0006, lng: list[10 + j].lng, savedAt: '2026-11-25T02:00:00.000Z' });
    ok(list.length === 69, 'the fixture holds 69 remembered entries', list.length);
    const store = new Map();
    const db = { get: async (c, id) => (store.has(c + ':' + id) ? JSON.parse(store.get(c + ':' + id)) : null), set: async (c, id, v) => { store.set(c + ':' + id, JSON.stringify(v)); } };
    const plan = { day: '2026-11-26', plan: { stops: [{ placeId: '__fuel__', fuel: true }] }, ctx: { places: { __fuel__: { id: '__fuel__', name: 'ZUS Coffee - Caltex Pajam', lat: 2.8104, lng: 101.8293 } } } };
    await db.set('meta', 'fuelStations', { list });
    await db.set('plan', 'current', plan);
    await db.set('days', '2026-11-26', { events: [{ kind: 'fuel', name: 'ZUS Coffee - Caltex Pajam' }] });
    const otherBefore = [store.get('plan:current'), store.get('days:2026-11-26')];
    const r = await Fuel.cleanStationsOnce(db, 'Caltex');
    const after = (await db.get('meta', 'fuelStations')).list;
    ok(r && r.before === 69 && r.after === 52 && after.length === 52, 'fixture: 69 -> 52 (9 shops and 8 second listings gone)', r && [r.before, r.after]);
    ok(!after.some((s) => /^(ZUS|FamilyMart|7-Eleven|Tealive|KFC|Kenny|Watsons)/.test(s.name)) && after.some((s) => s.name === 'Caltex Pajam'), 'no shop left; Caltex Pajam stays');
    ok(store.get('plan:current') === otherBefore[0] && store.get('days:2026-11-26') === otherBefore[1], 'today\'s plan (with its fuel stop) and the day history are untouched');
    ok((await db.get('meta', 'migrations'))[Fuel.CLEAN_FLAG] === true, 'the flag is set');
    await db.set('meta', 'fuelStations', { list: list.slice(0, 60) }); // something written later (e.g. an Import)
    ok((await Fuel.cleanStationsOnce(db, 'Caltex')) === null && (await db.get('meta', 'fuelStations')).list.length === 60, 'it runs once: a second launch changes nothing');
  }

  console.log('C. the added-minutes text never says null / undefined');
  {
    const samples = [null, undefined, {}, { detourMin: null }, { detourMin: undefined }, { detourMin: 0 }, { detourMin: -3 }, { detourMin: 12.4 }];
    ok(samples.every((c) => !/null|undefined/.test(Fuel.detourText(c))), 'no "null" / "undefined" in any added-minutes text', samples.map(Fuel.detourText));
    ok(Fuel.detourText({ detourMin: 0 }) === '+0 min', 'a real 0 is still "+0 min" (only a real figure can say it)');
  }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
