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
  ok(Providers.RETRY_MS.length === 1, 'a 429 is retried at most once (one retry delay)', Providers.RETRY_MS);
  Providers.RETRY_MS.splice(0, Providers.RETRY_MS.length, 1); // no real waiting in the test (still one retry)
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
    script = [429];
    const r3 = await Providers.routeLeg(A, B, null, 'KEY');
    ok(r3.seconds === 3000 && urls.length === 4, '429 once: that leg is retried ONCE and answered on the 2nd try', urls.length);
    script = [429, 429, 429];
    let err = null;
    try { await Providers.routeLeg(A, B, null, 'KEY'); } catch (e) { err = e; }
    ok(err && err.kind === 'limit' && err.message === Budget.DOWN_MSG && urls.length === 6 && seen.down.slice(-1)[0] === 429, '429 twice: never a 2nd retry, the friendly "unavailable" error (2 requests), reported down 429', { n: urls.length, m: err && err.message });
    script = [];
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

  console.log('B1. computeTravelTimeFor=all; the learned sample is historicTrafficTravelTimeInSeconds, nothing when it is absent');
  {
    const Pa = { lat: 3.1, lng: 101.6 }, Pb = { lat: 3.2, lng: 101.7 };
    const u = new URL(Providers.routeUrl(Pa, Pb, null, 'KEY', Date.UTC(2026, 10, 24, 2, 0)));
    ok(u.searchParams.get('computeTravelTimeFor') === 'all' && u.searchParams.get('traffic') === 'true', 'the request asks for all travel times (parsed back with new URL)', u.search);
    let body = { routes: [{ summary: { lengthInMeters: 9000, travelTimeInSeconds: 2400, historicTrafficTravelTimeInSeconds: 1500 } }] };
    global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
    const NOWB = Date.UTC(2026, 10, 24, 2, 5);
    const a = { key: 'A', pid: 'A', lat: Pa.lat, lng: Pa.lng }, b = { key: 'B', pid: 'B', lat: Pb.lat, lng: Pb.lng };
    const mem = TT.emptyMemory();
    const r = await Providers.routeLeg(Pa, Pb, null, 'KEY');
    TT.remember(mem, a, b, NOWB, r, NOWB);
    ok(mem.pairs['A>B@day'] && mem.pairs['A>B@day'][0].s === 1500 && r.seconds === 2400, 'stored 1500 (historic), not 2400 (live)', mem.pairs);
    ok(TT.learnedLine(mem, NOWB) === 'Learned: 1 pair · last typical time from TomTom: today 10:05', 'Settings line after a typical time', TT.learnedLine(mem, NOWB));
    body = { routes: [{ summary: { lengthInMeters: 9000, travelTimeInSeconds: 2600 } }] }; // no historic field
    const r2 = await Providers.routeLeg(Pb, Pa, null, 'KEY');
    TT.remember(mem, b, a, NOWB + 60000, r2, NOWB + 60000);
    ok(r2.typicalSeconds === null && !mem.pairs['B>A@day'] && mem.pairs['A>B@day'].length === 1, 'no historic field: nothing stored for that pair (the live 2600 is not stored)', mem.pairs);
    ok(mem.last && mem.last.typical === false, 'the absence is recorded', mem.last);
    ok(TT.learnedLine(mem, NOWB + 60000) === 'Learned: 1 pair · last typical time from TomTom: today 10:05 · last reply had no typical time', 'Settings line names the missing typical time', TT.learnedLine(mem, NOWB + 60000));
    ok(TT.learnedLine(mem, NOWB + 86400e3).indexOf('last typical time from TomTom: 24 Nov') > 0 && TT.learnedLine(TT.emptyMemory(), NOWB) === 'Learned: 0 pairs · last typical time from TomTom: none yet', 'another day -> a date; nothing yet -> "none yet"');
    const back = TT.normaliseMemory(JSON.parse(JSON.stringify(mem)));
    ok(back.lastTypicalAt === NOWB && back.last.typical === false, 'the record survives a save / Import (normaliseMemory)', back);
  }

  console.log('B2. departAt parsed back with new URL equals the intended value exactly');
  {
    const now = Date.UTC(2026, 10, 24, 2, 0); // 10:00 MYT
    const dep = (ms) => new URL(Providers.routeUrl({ lat: 3, lng: 101 }, { lat: 3.1, lng: 101.1 }, ms, 'KEY', now)).searchParams.get('departAt');
    ok(dep(Date.UTC(2026, 10, 24, 9, 10)) === '2026-11-24T17:10:00+08:00', '17:10 MYT -> 2026-11-24T17:10:00+08:00 (the + survives: sent as %2B)', dep(Date.UTC(2026, 10, 24, 9, 10)));
    ok(dep(Date.UTC(2026, 10, 24, 15, 30)) === '2026-11-24T23:30:00+08:00', '23:30 MYT (15:30 UTC) -> 2026-11-24T23:30 (the Malaysia wall clock, whatever the device zone)', dep(Date.UTC(2026, 10, 24, 15, 30)));
    ok(dep(Date.UTC(2026, 10, 24, 16, 30)) === '2026-11-25T00:30:00+08:00', '00:30 MYT the next day (16:30 UTC) -> 2026-11-25T00:30', dep(Date.UTC(2026, 10, 24, 16, 30)));
    ok(dep(null) === 'now' && dep(now - 3600e3) === 'now' && dep(now) === 'now' && dep(now + 30000) === 'now', 'not in the future (or under a minute ahead): "now", never a past time');
    ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\+08:00$/.test(dep(now + 2 * 3600e3)) && !/ /.test(dep(now + 2 * 3600e3)), 'RFC 3339, no space', dep(now + 2 * 3600e3));
  }

  console.log('B3. 400 / 403 / 429 from TomTom during PLAN: the plan completes, nothing stored, at most one retry, one plain notice');
  {
    const pl = (id, lat, lng) => ({ id, name: id, lat, lng, type: 'factory', dwellMin: 30, closedWindows: [] });
    const places = { p1: pl('p1', 3.00, 101.60), p2: pl('p2', 3.05, 101.65), p3: pl('p3', 3.10, 101.70), end: Object.assign(pl('end', 3.15, 101.75), { type: 'home', dwellMin: 0 }) };
    const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: id }, o);
    const jobs = [job('j1', { inHandItem: 'a', deliveryPlaceId: 'p1' }), job('j2', { inHandItem: 'b', deliveryPlaceId: 'p2' }), job('j3', { inHandItem: 'c', deliveryPlaceId: 'p3' })];
    const start = { lat: 2.95, lng: 101.55 };
    const NOW = Date.UTC(2026, 10, 24, 1, 0);
    const nodeOf = (key, p, pid) => ({ key, pid: pid || null, lat: p.lat, lng: p.lng });
    Providers.RETRY_MS.splice(0, Providers.RETRY_MS.length, 1);
    for (const st of [400, 403, 429]) {
      let n = 0; const hk = { down: [], bad: 0, count: 0 };
      Providers.setTomTomHook({ count: () => { hk.count++; }, ok: () => {}, down: (s) => hk.down.push(s), bad: () => { hk.bad++; } });
      global.fetch = async () => { n++; return { ok: false, status: st, json: async () => ({ detailedError: { code: 'X', message: 'refused' } }) }; };
      const mem = TT.emptyMemory();
      const realNow2 = Date.now; Date.now = () => NOW;
      let r = null, thrown = null;
      try {
        r = await TT.planRoute({
          Solver, input: { start, end: places.end, jobs, places, departAtISO: new Date(NOW).toISOString(), noDetour: false }, nowMs: NOW, mem,
          fetchLeg: (a, b, at) => Providers.routeLeg(a, b, at, 'KEY'),
          start: nodeOf('__start__', start), end: nodeOf('__end__', places.end, 'end'), nodeOfStop: (pid) => nodeOf(pid, places[pid], pid),
        });
      } catch (e) { thrown = e; } finally { Date.now = realNow2; }
      const pairs = 3 + 6 + 3; // start -> 3 stops, 3 x 2 between stops, 3 stops -> end (live table, 3 stops)
      ok(!thrown && r && !r.res.error && r.res.plans[0].order.length === 3 && r.estimated, st + ': PLAN completes on the estimated fallback (3 stops ordered)', thrown && thrown.message);
      ok(Object.keys(mem.pairs).length === 0, st + ': no failed answer stored as a learned sample', mem.pairs);
      if (st === 400) ok(n === pairs && hk.bad === pairs && !hk.down.length, '400: one request per pair, no retry, not "down"', { n, bad: hk.bad });
      if (st === 403) ok(n <= 4 && hk.down.every((s) => s === 403), '403: no retry; fetching stops at the refusal (<= 4 in flight)', n);
      if (st === 429) ok(n <= 8 && hk.down.every((s) => s === 429), '429: at most ONE retry per leg; fetching stops (<= 4 legs x 2)', n);
    }
    const msgs = [400, 403, 429].map(Budget.downNotice);
    ok(msgs[0] === Budget.NO_ROUTE_MSG && /refused the key or the monthly allowance/.test(msgs[1]) && /busy \(too many requests\)/.test(msgs[2]) && msgs.every((m) => !/HTTP|\d{3}/.test(m)), 'the one notice names what happened, plainly (no raw HTTP text)', msgs);
    ok(Budget.downNotice(0) === Budget.DOWN_MSG && Budget.downNotice(503) === Budget.DOWN_MSG, 'unreachable / 5xx: the general notice');
  }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
