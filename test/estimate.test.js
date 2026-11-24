'use strict';
// When TomTom cannot answer: the distance-banded estimator (13), the 24 Nov regression (16), est. marks, and the Routing API
// provider (calculateRoute URL, departAt, typical time, 429 retries, the one friendly error, the usage hook). fetch is mocked.
// Run as its own node script: node test/estimate.test.js
const Budget = require('../budget.js');
const Solver = require('../solver.js');
const TT = require('../traveltimes.js');
const Providers = require('../providers.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.05);

console.log('13. estimator: straight-line km x 1.3 at 25 / 40 / 75 km/h');
ok(near(Budget.estMinutesKm(3), 9.4), '3 km -> 9.4 min', Budget.estMinutesKm(3));
ok(near(Budget.estMinutesKm(20), 39.0), '20 km -> 39.0 min', Budget.estMinutesKm(20));
ok(near(Budget.estMinutesKm(80), 83.2), '80 km -> 83.2 min', Budget.estMinutesKm(80));
ok(Budget.speedFor(4.99) === 25 && Budget.speedFor(5) === 40 && Budget.speedFor(30) === 40 && Budget.speedFor(30.01) === 75, 'speed bands: under 5 km 25, 5-30 km 40, over 30 km 75');
{
  const A = { lat: 3.10, lng: 101.60 }, B = { lat: 3.20, lng: 101.70 };
  const km = Budget.distanceM(A, B) / 1000;
  ok(Budget.estSec(A, B) === Math.round(Budget.estMinutesKm(km) * 60) && Budget.estMetres(A, B) === Math.round(km * 1300), 'estSec / estMetres use the straight line between the points');
}

console.log('16. regression (24 Nov): TomTom unavailable -> the estimated order visits both Bangi stops before Tanjong Malim');
(async () => {
  const pl = (id, name, lat, lng) => ({ id, name, lat, lng, type: 'factory', dwellMin: 30, closedWindows: [] });
  const places = {
    carrier: pl('carrier', 'Carrier', 2.96, 101.75), asian: pl('asian', 'Asian Automotive', 2.965, 101.755),
    jujin: pl('jujin', 'JUJIN', 3.68, 101.52), okr: Object.assign(pl('okr', 'Old Klang Road', 3.08, 101.67), { type: 'home', dwellMin: 0 }),
  };
  const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: id }, o);
  const jobs = [job('j1', { inHandItem: 'a', deliveryPlaceId: 'carrier' }), job('j2', { inHandItem: 'b', deliveryPlaceId: 'asian' }), job('j3', { inHandItem: 'c', deliveryPlaceId: 'jujin' })];
  const start = { lat: 3.05, lng: 101.76 };
  const NOW = Date.UTC(2026, 10, 24, 1, 0); // 09:00 MYT
  let calls = 0;
  const down = async () => { calls++; const e = new Error(Budget.DOWN_MSG); e.kind = 'limit'; throw e; };
  const nodeOf = (key, p, pid) => ({ key, pid: pid || TT.snap(p, Object.values(places)), lat: p.lat, lng: p.lng });
  const r = await TT.planRoute({
    Solver, input: { start, end: places.okr, jobs, places, departAtISO: new Date(NOW).toISOString(), noDetour: false }, nowMs: NOW, mem: TT.emptyMemory(), fetchLeg: down,
    start: nodeOf('__start__', start), end: nodeOf('__end__', places.okr, 'okr'), nodeOfStop: (pid) => nodeOf(pid, places[pid], pid),
  });
  const order = r.res.plans[0].order;
  ok(r.estimated && calls <= 4, 'TomTom unavailable: the order is on estimates (fetching stops at the first refusal)', { est: r.estimated, calls });
  ok(order.indexOf('carrier') < order.indexOf('jujin') && order.indexOf('asian') < order.indexOf('jujin'), 'both Bangi stops before Tanjong Malim', order);
  const timed = Solver.retime(r.res.plans[0], -1, new Date(NOW).toISOString());
  const es = Budget.estStops(timed, -1, false);
  ok(es.stops.size === 3 && es.end, 'every ETA is marked est. (no real time held)', [...es.stops]);

  console.log('calculateRoute: URL, departAt, typical time, 429 retries, the one friendly error, the usage hook');
  const seen = { count: [], ok: 0, down: [] };
  Providers.setTomTomHook({ count: (k, n) => seen.count.push(k + ':' + n), ok: () => { seen.ok++; }, down: (st) => seen.down.push(st) });
  Providers.RETRY_MS.splice(0, Providers.RETRY_MS.length, 1, 1); // no real waiting in the test
  const urls = [];
  let script = [];
  global.fetch = async (url, init) => {
    urls.push({ url: String(url), method: init && init.method });
    const st = script.length ? script.shift() : 200;
    if (st !== 200) return { ok: false, status: st, json: async () => ({ detailedError: { code: 'X', message: 'You do not have enough credits' } }) };
    return { ok: true, status: 200, json: async () => ({ routes: [{ summary: { lengthInMeters: 12345, travelTimeInSeconds: 3000, trafficDelayInSeconds: 600, historicTrafficTravelTimeInSeconds: 1200, noTrafficTravelTimeInSeconds: 1000 } }] }) };
  };
  const A = { lat: 3.1, lng: 101.6 }, B = { lat: 3.2, lng: 101.7 };
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 10, 24, 2, 0); // 10:00 MYT
  try {
    const r1 = await Providers.routeLeg(A, B, null, 'KEY');
    const u = urls[0].url;
    ok(u.startsWith('https://api.tomtom.com/routing/1/calculateRoute/3.100000,101.600000:3.200000,101.700000/json?key=KEY&') && !urls[0].method, 'GET routing/1/calculateRoute/{lat,lon}:{lat,lon}/json', u);
    ok(/travelMode=car/.test(u) && /traffic=true/.test(u) && /routeRepresentation=summaryOnly/.test(u) && /computeTravelTimeFor=all/.test(u) && /departAt=now/.test(u), 'car, traffic, summary only, all travel times, departAt=now', u);
    ok(r1.seconds === 3000 && r1.metres === 12345 && r1.typicalSeconds === 1200, 'seconds / metres / typical (historicTrafficTravelTimeInSeconds)', r1);
    await Providers.routeLeg(A, B, Date.UTC(2026, 10, 24, 9, 10), 'KEY'); // 17:10 MYT
    ok(/departAt=2026-11-24T17%3A10%3A00%2B08%3A00/.test(urls[1].url), 'a future departure: RFC 3339 with the +08:00 offset', urls[1].url);
    ok(seen.count.join() === 'routing:1,routing:1' && seen.ok === 2, 'every response counted as a Routing request', seen.count);
    script = [429, 429];
    const r3 = await Providers.routeLeg(A, B, null, 'KEY');
    ok(r3.seconds === 3000 && urls.length === 5, '429 twice: that leg is retried and answered on the 3rd try', urls.length);
    script = [429, 429, 429];
    let err = null;
    try { await Providers.routeLeg(A, B, null, 'KEY'); } catch (e) { err = e; }
    ok(err && err.kind === 'limit' && err.message === Budget.DOWN_MSG && urls.length === 8, '429 after 2 retries: the friendly "unavailable" error (3 requests)', err && err.message);
    script = [403];
    err = null;
    try { await Providers.routeLeg(A, B, null, 'KEY'); } catch (e) { err = e; }
    ok(err && err.kind === 'limit' && !/HTTP|403|credits/.test(err.message) && seen.down.slice(-1)[0] === 403, '403: ONE friendly message, no raw HTTP text; reported down', err && err.message);
    script = [400];
    err = null;
    try { await Providers.routeLeg(A, B, null, 'KEY'); } catch (e) { err = e; }
    ok(err && err.kind !== 'limit' && /400/.test(err.message), '400 (no route): an ordinary error, not "TomTom down"', err && err.message);
    ok(!urls.some((x) => /matrix/.test(x.url)), 'no Matrix request by default');
  } finally { Date.now = realNow; }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
