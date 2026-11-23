/* L-Tech Waypoint — fuel.js
 * "Add fuel stop": pure helpers (no DOM, no network, no storage). The app owns every call; this file owns the maths:
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
    (route.stops || []).forEach((s) => { if (s.status !== 'done' && s.status !== 'skipped') pts.push(Object.assign({ role: 'stop' }, s)); });
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

  // Remembered stations of the current brand.
  const stationsOfBrand = (list, brand) => (list || []).filter((s) => nameHasBrand(s.name, brand) || (s.brand && String(s.brand).trim().toLowerCase() === String(brand || '').trim().toLowerCase()));

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
    haversineKm, corridorDetourKm, evenIndices, thinEvenly, samplePoints, remainingPoints, allowedLegs, shortlist, pickInsertion,
    searchBudget, mergeStations, sameRouteKey, nameHasBrand, stationsOfBrand, mapLimit,
  };
});
