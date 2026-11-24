'use strict';
// 21. Fuel stop with the Routing API: every (station, position) ranked by the estimator, real times for the best 8 only
// (2 requests each, 16 at most), the existing rule chooses among those 8. Run as its own node script: node test/fuelroute.test.js
const Fuel = require('../fuel.js');
const Budget = require('../budget.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const key = (p) => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
const k = (p) => Object.assign({}, p, { key: key(p) });

(async () => {
  console.log('21. 12 stations x 3 positions -> at most 16 Routing requests; the choice is one of the 8 fetched');
  const route = { origin: { lat: 3.00, lng: 101.60, id: 'o' }, stops: [{ id: 'a', lat: 3.05, lng: 101.65 }, { id: 'b', lat: 3.10, lng: 101.70 }], end: { lat: 3.15, lng: 101.75, id: 'e' } };
  const pts = Fuel.remainingPoints(route).map(k);
  const legs = Fuel.allowedLegs(route);
  ok(legs.length === 3, '3 positions in the route', legs.length);
  const stations = Array.from({ length: 12 }, (_, i) => k({ placeId: 'st' + i, name: 'Caltex ' + i, lat: 3.0 + i * 0.013 + (i % 3) * 0.004, lng: 101.6 + i * 0.013 - (i % 2) * 0.006, fuel: true }));
  const cands = Fuel.allCandidates(pts, stations, legs);
  ok(cands.length === 36, '36 candidates', cands.length);
  const estMin = (a, b) => Budget.estSec(a, b) / 60;
  const calls = [];
  const fetchMin = async (a, b) => { calls.push(a.key + '>' + b.key); return estMin(a, b) * (1.2 + (calls.length % 5) / 10); };
  const res = await Fuel.realTimeShortlist(cands, estMin, fetchMin, estMin, 8);
  ok(calls.length <= 16 && res.requests === calls.length, 'at most 16 Routing requests (' + calls.length + ')', calls.length);
  ok(new Set(calls).size === calls.length, 'no leg is fetched twice');
  const top8 = Fuel.pickInsertion(cands, estMin).slice(0, 8);
  const fetchedKeys = new Set(top8.map((c) => c.station.placeId + '@' + c.legIndex));
  ok(res.sorted.length > 0 && res.sorted.length <= 8 && fetchedKeys.has(res.sorted[0].station.placeId + '@' + res.sorted[0].legIndex), 'the chosen (station, position) is among the 8 fetched', res.sorted[0] && res.sorted[0].station.placeId);
  ok(res.sorted.every((c, i) => i === 0 || c.detourMin >= res.sorted[i - 1].detourMin), 'ordered by the existing rule (smallest detour first)');
  const down = await Fuel.realTimeShortlist(cands, estMin, async () => { const e = new Error('down'); e.kind = 'limit'; throw e; }, estMin, 8);
  ok(down.estimated && down.sorted.length === 8, 'TomTom out: the estimate ranking is used (still the same 8)');

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
