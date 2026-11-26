/* L-Tech Waypoint — fuel.js
 * "Add fuel stop": pure helpers (no DOM, no network; storage only through a store handed in, for the one-time station
 * clean-up). The app owns every call; this file owns the maths:
 * where to look for stations along the remaining route, which legs may take a fuel stop, how many Places searches
 * are allowed, the permanent station memory merge, and the choice of the lowest-detour insertion.
 *
 * Points are {lat, lng, ...}. Distances are straight-line (haversine) km. Travel times handed to pickInsertion are minutes.
 * A "route" is {origin:{lat,lng,id?}, stops:[{id, lat, lng, status?, urgent?}], end:{lat,lng,id?,urgent?}}:
 * stops in visit order, status 'done' / 'skipped' = no longer ahead, urgent = an urgent delivery is still pending there.
 * Exports via module.exports (node) or window.Fuel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fuel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const R_KM = 6371;
  const rad = Math.PI / 180;
  const DAILY_GUARD = 140;
  const REUSE_MS = 10 * 60000;
  const FUEL_ID = '__fuel__';

  function haversineKm(a, b) {
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  // Extra distance of going A -> S -> B instead of A -> B (straight line, km).
  function corridorDetourKm(A, S, B) {
    return haversineKm(A, S) + haversineKm(S, B) - haversineKm(A, B);
  }

  // n indices spread evenly over 0..len-1 (always the first and the last when n >= 2). n === 1: the middle one.
  function evenIndices(len, n) {
    if (n >= len) return Array.from({ length: len }, (_, i) => i);
    if (n <= 0) return [];
    if (n === 1) return [Math.floor((len - 1) / 2)];
    const out = [];
    for (let i = 0; i < n; i++) out.push(Math.round(i * (len - 1) / (n - 1)));
    return out.filter((v, i) => i === 0 || v !== out[i - 1]);
  }
  const thinEvenly = (arr, n) => evenIndices(arr.length, n).map((i) => arr[i]);

  // Points along the remaining route: every route point (origin, stops, end) plus points every spacingKm along the straight
  // line of each leg. No two kept points are closer than spacingKm / 2 (route points win over interpolated ones). Over the cap,
  // the list is thinned evenly along the route (not cut off at the end).
  function samplePoints(routePoints, spacingKm, max) {
    spacingKm = spacingKm || 4;
    max = max == null ? 50 : max;
    const pts = (routePoints || []).filter((p) => p && isFinite(p.lat) && isFinite(p.lng));
    const raw = []; // {lat, lng, own: route point?}
    pts.forEach((p, i) => {
      raw.push({ lat: p.lat, lng: p.lng, own: true });
      const q = pts[i + 1];
      if (!q) return;
      const L = haversineKm(p, q);
      for (let k = 1; k * spacingKm < L - 1e-9; k++) {
        const f = (k * spacingKm) / L;
        raw.push({ lat: p.lat + (q.lat - p.lat) * f, lng: p.lng + (q.lng - p.lng) * f, own: false });
      }
    });
    const keep = new Array(raw.length).fill(false);
    const kept = [];
    const far = (p) => kept.every((k) => haversineKm(k, p) >= spacingKm / 2 - 1e-9);
    [true, false].forEach((own) => raw.forEach((p, i) => {
      if (p.own === own && far(p)) { keep[i] = true; kept.push(p); }
    }));
    const out = raw.filter((p, i) => keep[i]).map((p) => ({ lat: p.lat, lng: p.lng }));
    return out.length > max ? thinEvenly(out, max) : out;
  }

  // The points still ahead: the origin, each stop not done / skipped, the end point.
  function remainingPoints(route) {
    const pts = [Object.assign({ role: 'origin' }, route.origin)];
    // a fuel stop already in the route is never part of the route a fuel stop is planned around (Change compares without it)
    (route.stops || []).forEach((s) => { if (s.status !== 'done' && s.status !== 'skipped' && !s.fuel) pts.push(Object.assign({ role: 'stop' }, s)); });
    pts.push(Object.assign({ role: 'end' }, route.end));
    return pts;
  }

  // Legs (between consecutive remaining points) a fuel stop may be inserted into. Leg i = point i -> point i+1.
  // Never before an urgent delivery: a leg is out if an urgent delivery is still pending at or after its destination.
  // If that leaves nothing: only the legs after the last urgent stop; if there are none, the final leg.
  function allowedLegs(route) {
    const pts = remainingPoints(route);
    const all = [];
    for (let i = 0; i + 1 < pts.length; i++) all.push({ index: i, from: i, to: i + 1 });
    if (!all.length) return [];
    let lastUrgent = -1;
    pts.forEach((p, i) => { if (p.urgent) lastUrgent = i; });
    let legs = all.filter((l) => lastUrgent < l.to);
    if (!legs.length) legs = all.filter((l) => l.from >= lastUrgent);
    if (!legs.length) legs = [all[all.length - 1]];
    return legs;
  }

  // Best n DISTINCT stations (by placeId) by smallest straight-line detour over the allowed legs, each with its best 2 legs.
  // -> [{station, legs:[{index, from, to, detourKm}], bestKm}] sorted by bestKm.
  function shortlist(routePoints, stations, legs, n, perStation) {
    n = n == null ? 5 : n;
    perStation = perStation == null ? 2 : perStation;
    const seen = new Set();
    const rows = [];
    (stations || []).forEach((st) => {
      if (!st || seen.has(st.placeId)) return;
      seen.add(st.placeId);
      const scored = (legs || []).map((l) => ({ index: l.index, from: l.from, to: l.to, detourKm: corridorDetourKm(routePoints[l.from], st, routePoints[l.to]) }))
        .sort((a, b) => (a.detourKm - b.detourKm) || (a.index - b.index));
      if (!scored.length) return;
      const best = scored.slice(0, perStation);
      rows.push({ station: st, legs: best, bestKm: best[0].detourKm });
    });
    rows.sort((a, b) => a.bestKm - b.bestKm);
    return rows.slice(0, n);
  }

  // candidates: [{station, a, b, legIndex}] ; travelTime(p, q) -> minutes (or null when unknown; such a candidate is dropped).
  // detourMin = t(A,S) + t(S,B) - t(A,B). Sorted by detourMin; ties: earlier leg first (then the given order).
  function pickInsertion(candidates, travelTime) {
    const out = [];
    (candidates || []).forEach((c, order) => {
      const ta = travelTime(c.a, c.station), tb = travelTime(c.station, c.b), tab = travelTime(c.a, c.b);
      if (ta == null || tb == null || tab == null || !isFinite(ta + tb + tab)) return;
      out.push(Object.assign({}, c, { detourMin: ta + tb - tab, order }));
    });
    out.sort((x, y) => {
      const d = x.detourMin - y.detourMin;
      if (Math.abs(d) > 1e-9) return d;
      return (x.legIndex - y.legIndex) || (x.order - y.order);
    });
    return out;
  }

  // Every (station, allowed leg) pair as a pickInsertion candidate: [{station, a, b, legIndex}].
  function allCandidates(routePoints, stations, legs) {
    const out = [], seen = new Set();
    (stations || []).forEach((st) => {
      if (!st || seen.has(st.placeId)) return;
      seen.add(st.placeId);
      (legs || []).forEach((l) => out.push({ station: st, a: routePoints[l.from], b: routePoints[l.to], legIndex: l.index }));
    });
    return out;
  }
  // Rank every candidate with the estimator (estMin(p, q) -> minutes), then walk that ranking and take up to n candidates
  // (default 8) whose THREE legs fit in maxRequests distinct requests (default 2n = 16, the design's cap since 24 Nov): the leg
  // into the station A -> S, the leg out S -> B, and the direct leg A -> B it replaces. All three come from the same source
  // (fetchMin(p, q) -> Promise<minutes>, the live service, now), each distinct leg once. Added minutes = t(A,S) + t(S,B) - t(A,B).
  // A candidate missing any of the three has detourMin null ("time not available") and ranks after every real figure.
  // Points carry .key. Returns {sorted, requests, times: Map "a>b" -> minutes, estimated (TomTom out part-way)}.
  async function realTimeShortlist(candidates, estMin, fetchMin, n, maxRequests) {
    n = n == null ? 8 : n;
    maxRequests = maxRequests == null ? 2 * n : maxRequests;
    const lk = (p, q) => p.key + '>' + q.key;
    const ranked = pickInsertion(candidates, estMin);
    const picked = [], seen = new Set(), need = [];
    for (const c of ranked) {
      if (picked.length >= n) break;
      const fresh = [[c.a, c.station], [c.station, c.b], [c.a, c.b]].filter(([p, q], i, arr) => p.key !== q.key && !seen.has(lk(p, q)) && arr.findIndex(([x, y]) => lk(x, y) === lk(p, q)) === i);
      if (need.length + fresh.length > maxRequests) continue; // would go over the cap: a cheaper candidate further down may still fit
      fresh.forEach(([p, q]) => { seen.add(lk(p, q)); need.push([p, q, lk(p, q)]); });
      picked.push(c);
    }
    const times = new Map();
    let down = false, requests = 0;
    await mapLimit(need, 4, async ([p, q, k]) => {
      if (down) return;
      requests++;
      try { const v = await fetchMin(p, q); if (v != null && isFinite(v)) times.set(k, v); } catch (e) { if (e && e.kind === 'limit') down = true; }
    });
    const tt = (p, q) => (p.key === q.key ? 0 : times.has(lk(p, q)) ? times.get(lk(p, q)) : null);
    const rows = picked.map((c, order) => {
      const ta = tt(c.a, c.station), tb = tt(c.station, c.b), tab = tt(c.a, c.b);
      const real = ta != null && tb != null && tab != null && isFinite(ta + tb + tab);
      return { station: c.station, a: c.a, b: c.b, legIndex: c.legIndex, detourMin: real ? ta + tb - tab : null, order };
    });
    rows.sort((x, y) => {
      if ((x.detourMin == null) !== (y.detourMin == null)) return x.detourMin == null ? 1 : -1; // real figures first
      if (x.detourMin != null) { const d = x.detourMin - y.detourMin; if (Math.abs(d) > 1e-9) return d; return (x.legIndex - y.legIndex) || (x.order - y.order); }
      return x.order - y.order; // no figure: the estimate ranking
    });
    return { sorted: rows, requests, times, estimated: down };
  }
  // The added-minutes text on the sheet: "+N min", or "time not available" when any of the three legs is missing (never "+0").
  const detourText = (c) => (c && c.detourMin != null && isFinite(c.detourMin) ? '+' + Math.max(0, Math.round(c.detourMin)) + ' min' : 'time not available');

  // How many Places searches this tap may make.
  function searchBudget(needed, maxPerTap, callsToday, dailyGuard) {
    dailyGuard = dailyGuard == null ? DAILY_GUARD : dailyGuard;
    return Math.max(0, Math.min(needed, maxPerTap, Math.max(0, dailyGuard - callsToday)));
  }

  // The permanent station memory: union by placeId. A re-found station updates name / address (and brand), keeps savedAt and
  // everything else; nothing is ever dropped. Inputs are not mutated.
  function mergeStations(remembered, found, nowIso) {
    nowIso = nowIso || new Date().toISOString();
    const out = (remembered || []).map((s) => Object.assign({}, s));
    const byId = new Map(out.map((s, i) => [s.placeId, i]));
    (found || []).forEach((f) => {
      if (!f || f.placeId == null) return;
      if (byId.has(f.placeId)) {
        const cur = out[byId.get(f.placeId)];
        if (f.name != null) cur.name = f.name;
        if (f.address != null) cur.address = f.address;
        if (f.brand != null) cur.brand = f.brand;
      } else {
        byId.set(f.placeId, out.length);
        out.push({ placeId: f.placeId, name: f.name || '', address: f.address || '', lat: f.lat, lng: f.lng, brand: f.brand || '', savedAt: f.savedAt || nowIso });
      }
    });
    return out;
  }

  // A stable key for the remaining route (coordinates rounded to ~110 m, in order).
  function sameRouteKey(routePoints) {
    return (routePoints || []).map((p) => Number(p.lat).toFixed(3) + ',' + Number(p.lng).toFixed(3)).join('|');
  }

  // Does a result name carry the brand (case-insensitive)?
  const nameHasBrand = (name, brand) => !!brand && String(name || '').toLowerCase().includes(String(brand).trim().toLowerCase());

  // Is this search result the fuel station itself (not a shop inside it)? The Places request carries no place type (adding
  // one to the field mask was not checked against the billing SKU), so the name decides: kept when it starts with the brand,
  // or when the only words before the brand are station words ("Stesen Minyak Caltex ..."); dropped when another business
  // name comes before the brand ("ZUS Coffee - Caltex Pajam", "FamilyMart @ Caltex ..."). A name without the brand is kept
  // only when it says Stesen / Station / Petrol / Minyak.
  const STATION_WORDS = new Set(['stesen', 'station', 'petrol', 'minyak']);
  function isStationName(name, brand) {
    const low = String(name || '').trim().toLowerCase(), b = String(brand || '').trim().toLowerCase();
    if (!low) return false;
    const i = b ? low.indexOf(b) : -1;
    if (i === 0) return true;
    if (i > 0) return low.slice(0, i).split(/[^a-z0-9]+/).filter(Boolean).every((w) => STATION_WORDS.has(w));
    return low.split(/[^a-z0-9]+/).some((w) => STATION_WORDS.has(w));
  }
  const DUP_M = 150;
  // The station memory cleaned: entries that are not stations (isStationName with their own brand, else `brand`) go; of two
  // entries within 150 m one stays: the one whose name starts with the brand, else the one remembered first. Inputs untouched.
  function cleanStations(list, brand) {
    const startsBrand = (s) => { const b = String(s.brand || brand || '').trim().toLowerCase(); return !!b && String(s.name || '').trim().toLowerCase().startsWith(b); };
    const out = [];
    (list || []).forEach((s) => {
      if (!s || !isStationName(s.name, s.brand || brand)) return;
      const j = out.findIndex((k) => isFinite(k.lat) && isFinite(s.lat) && haversineKm(k, s) * 1000 <= DUP_M);
      if (j < 0) { out.push(Object.assign({}, s)); return; }
      if (!startsBrand(out[j]) && startsBrand(s)) out[j] = Object.assign({}, s);
    });
    return out;
  }
  const CLEAN_FLAG = 'fuelStationsClean2026_11_26';
  // Once per device (flag meta/migrations.<CLEAN_FLAG>): cleanStations over the stored memory (meta/fuelStations) only. The store
  // is handed in (get / set, as WPStore); nothing else in it is read or written. -> null (already done) | {before, after, list}.
  async function cleanStationsOnce(store, brand) {
    const rec = (await store.get('meta', 'migrations')) || { done: [] };
    if (rec[CLEAN_FLAG]) return null;
    const fm = await store.get('meta', 'fuelStations');
    const list = fm && Array.isArray(fm.list) ? fm.list : [];
    const out = cleanStations(list, brand);
    if (JSON.stringify(out) !== JSON.stringify(list)) await store.set('meta', 'fuelStations', Object.assign({}, fm, { list: out }));
    rec[CLEAN_FLAG] = true;
    await store.set('meta', 'migrations', rec);
    return { before: list.length, after: out.length, list: out };
  }

  // Remembered stations of the current brand (never a shop inside a station).
  const stationsOfBrand = (list, brand) => (list || []).filter((s) => (nameHasBrand(s.name, brand) || (s.brand && String(s.brand).trim().toLowerCase() === String(brand || '').trim().toLowerCase())) && isStationName(s.name, s.brand || brand));

  // Run fn over items, at most `limit` at a time. fn(item, index) never throws into the pool (errors are collected).
  // onProgress(doneCount, total) after each. Returns {results, errors}. cancelled() true = stop starting new ones.
  async function mapLimit(items, limit, fn, onProgress, cancelled) {
    const results = new Array(items.length), errors = [];
    let next = 0, done = 0;
    async function worker() {
      while (next < items.length) {
        if (cancelled && cancelled()) return;
        const i = next++;
        try { results[i] = await fn(items[i], i); } catch (e) { errors.push(e); }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return { results, errors };
  }

  return {
    DAILY_GUARD, REUSE_MS, FUEL_ID,
    haversineKm, corridorDetourKm, evenIndices, thinEvenly, samplePoints, remainingPoints, allowedLegs, shortlist, pickInsertion, allCandidates, realTimeShortlist, detourText,
    searchBudget, mergeStations, sameRouteKey, nameHasBrand, isStationName, cleanStations, CLEAN_FLAG, cleanStationsOnce, stationsOfBrand, mapLimit,
  };
});
