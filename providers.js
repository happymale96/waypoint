/* L-Tech Waypoint — providers.js
 * Google Places (New) Text Search — place search ONLY.
 * TomTom Matrix Routing v2 (synchronous) — ALL travel times.
 * Matches https://docs.tomtom.com/matrix-routing-v2-api/documentation/synchronous-matrix :
 *   POST https://api.tomtom.com/routing/matrix/2?key=KEY
 *   body {origins:[{point:{latitude,longitude}}], destinations:[...], options:{departAt, traffic, travelMode}}
 *   200 -> {data:[{originIndex, destinationIndex, routeSummary:{travelTimeInSeconds, trafficDelayInSeconds,...}, detailedError?}], statistics}
 *   departAt must be "now" or a future dateTime; traffic "live" cannot be combined with "any".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./budget.js'));
  else root.Providers = factory(root, root.Budget);
})(typeof self !== 'undefined' ? self : this, function (root, Budget) {
  'use strict';

  class ProviderError extends Error {
    constructor(provider, message, kind, status) { super(kind === 'limit' ? message : provider + ': ' + message); this.provider = provider; this.kind = kind || null; this.status = status || null; }
  }

  // ---------- TomTom usage hook (the app counts every request / cell per UTC day and tracks the "down" state) ----------
  // hook = {count(requests, cells), ok(), down(status)}. Every response that came back is counted (whatever its status).
  let hook = null;
  function setTomTomHook(h) { hook = h || null; }
  const hookCall = (name, ...a) => { try { if (hook && hook[name]) hook[name](...a); } catch (e) { /* never break a lookup */ } };
  // 401 / 403 (out of credits, bad key) / 429 (rate) / 5xx / unreachable: one friendly error, no raw HTTP text
  const isDown = (status) => status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
  const downError = (status) => new ProviderError('TomTom', Budget.DOWN_MSG, 'limit', status);
  async function tomtomFetch(body, cells, key) {
    let res;
    try {
      res = await fetch('https://api.tomtom.com/routing/matrix/2?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) {
      hookCall('down', 0);
      throw downError(0);
    }
    hookCall('count', 1, cells);
    const out = await res.json().catch(() => ({}));
    if (!res.ok && isDown(res.status)) { hookCall('down', res.status); throw downError(res.status); }
    if (res.ok) hookCall('ok');
    return { res, body: out };
  }

  // ---------- per-pair cache of real TomTom times (the estimated-times fallback reads it) ----------
  const pairs = new Map(); // "lat,lng>lat,lng" -> {s, m}
  const pairKey = (a, b) => roundPt(a) + '>' + roundPt(b);
  function rememberPair(a, b, s, m) { if (s != null && isFinite(s)) pairs.set(pairKey(a, b), { s, m: m != null ? m : null }); }
  function lookupPair(a, b) { return pairs.get(pairKey(a, b)) || null; }
  // seed from a stored plan's matrices (real cells only): times survive a reload
  function seedPairs(points, slice) {
    if (!slice || !slice.m) return;
    points.forEach((a, i) => points.forEach((b, j) => {
      if (i === j || (slice.est && slice.est[i] && slice.est[i][j])) return;
      const v = slice.m[i] && slice.m[i][j];
      if (v != null && v < 1e8) rememberPair(a, b, v, slice.d && slice.d[i] ? slice.d[i][j] : null);
    }));
  }

  // ---------- Google Places (New) ----------
  // opts.bias = {lat, lng, radius (m)}: bias the search to that circle (default: Klang Valley, 50 km).
  async function searchGoogle(query, key, onCall, opts) {
    if (!key) throw new ProviderError('Google Places', 'API key missing — add it in Settings.');
    if (!query || !query.trim()) return [];
    const bias = Object.assign({ lat: 3.1, lng: 101.6, radius: 50000 }, (opts && opts.bias) || {});
    let res;
    try {
      res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
        },
        body: JSON.stringify({
          textQuery: query,
          regionCode: 'MY',
          locationBias: { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: bias.radius } },
        }),
      });
    } catch (e) {
      throw new ProviderError('Google Places', 'network error (' + e.message + ').');
    } finally {
      if (onCall) onCall(); // count every attempt that reached the network layer
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body.error && body.error.message) || ('HTTP ' + res.status);
      throw new ProviderError('Google Places', msg);
    }
    return (body.places || []).map((p) => ({
      id: p.id || null,
      name: (p.displayName && p.displayName.text) || '',
      address: p.formattedAddress || '',
      lat: p.location && p.location.latitude,
      lng: p.location && p.location.longitude,
    })).filter((p) => p.lat != null && p.lng != null);
  }

  // ---------- TomTom Matrix Routing v2 ----------
  const cache = new Map();   // session-only matrix cache
  const SLICE_OFFSETS_H = [0, 2, 4];

  function pt(p) { return { point: { latitude: p.lat, longitude: p.lng } }; }

  async function tomtomMatrix(points, key, departAtMs) {
    if (!key) throw new ProviderError('TomTom', 'API key missing — add it in Settings.');
    const n = points.length;
    const now = Date.now();
    const options = { traffic: 'live', travelMode: 'car', departAt: (departAtMs <= now + 60000) ? 'now' : new Date(departAtMs).toISOString() };
    const { res, body } = await tomtomFetch({ origins: points.map(pt), destinations: points.map(pt), options }, n * n, key);
    if (!res.ok) {
      const detail = body.detailedError ? (body.detailedError.message || body.detailedError.code) : (body.error || body.message || '');
      const hint = res.status === 401 || res.status === 403 ? ' (check the key and that Matrix Routing is enabled)' : res.status === 429 ? ' (rate limit — try again shortly)' : '';
      throw new ProviderError('TomTom', 'HTTP ' + res.status + (detail ? ' — ' + detail : '') + hint);
    }
    const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null)));
    const d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null))); // metres, from the same response
    (body.data || []).forEach((c) => {
      if (c.originIndex === c.destinationIndex) return;
      const rs = c.routeSummary;
      if (!rs || c.detailedError) return;
      const v = rs.travelTimeInSeconds != null ? rs.travelTimeInSeconds : rs.noTrafficTravelTimeInSeconds;
      if (v != null) m[c.originIndex][c.destinationIndex] = v;
      if (rs.lengthInMeters != null) d[c.originIndex][c.destinationIndex] = rs.lengthInMeters;
    });
    const failed = m.some((row, i) => row.some((v, j) => v == null && i !== j));
    return { m, d, failed };
  }

  const roundPt = (p) => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
  function cacheKey(points, departAtISO) {
    return points.map(roundPt).join('|') + '@' + departAtISO.slice(0, 16);
  }

  // Three slices: departAt, +2 h, +4 h. Cached in memory so re-solving makes zero API calls.
  // Returns {matrices:[{departAt, m}], fromCache, calls}
  async function getMatrices(points, departAtISO, key, opts) {
    opts = opts || {};
    const ck = cacheKey(points, departAtISO);
    if (!opts.force && cache.has(ck)) return { matrices: cache.get(ck), fromCache: true, calls: 0 };
    const t0 = Date.parse(departAtISO);
    const slices = SLICE_OFFSETS_H.map((h) => t0 + h * 3600e3);
    const results = await Promise.all(slices.map((ms) => tomtomMatrix(points, key, ms)));
    const matrices = results.map((r, i) => ({ departAt: new Date(slices[i]).toISOString(), m: r.m, d: r.d }));
    seedPairs(points, results[0]); // the first slice (depart now / the plan's departure) feeds the per-pair cache
    cache.set(ck, matrices);
    return { matrices, fromCache: false, calls: slices.length, partial: results.some((r) => r.failed) };
  }
  // PLAN never blocked: TomTom out (limit / unavailable) -> cached pairs + straight-line estimates, every estimated cell
  // flagged (slice.est). Other errors (key missing, a 400) are thrown as before.
  async function getMatricesOrEstimate(points, departAtISO, key, opts) {
    try {
      return await getMatrices(points, departAtISO, key, opts);
    } catch (e) {
      if (!e || e.kind !== 'limit') throw e;
      const f = Budget.fillMatrices(points, departAtISO, SLICE_OFFSETS_H, lookupPair);
      return { matrices: f.matrices, fromCache: false, calls: 0, partial: false, estimated: true, estCells: f.estimated, error: e };
    }
  }
  function clearCache() { cache.clear(); pairs.clear(); }

  // ONE Matrix Routing v2 request for a whole driven sequence (End Day): origins = points[0..n-2], destinations =
  // points[1..n-1]; the leg i is cell (i,i). Same provider/product as planning; no new API. Returns [{m metres, s seconds}].
  async function routeLegs(points, key) {
    if (!key) throw new ProviderError('TomTom', 'API key missing — add it in Settings.');
    if (!points || points.length < 2) return [];
    const origins = points.slice(0, -1), dests = points.slice(1);
    const { res, body } = await tomtomFetch({ origins: origins.map(pt), destinations: dests.map(pt), options: { traffic: 'live', travelMode: 'car', departAt: 'now' } }, origins.length * dests.length, key);
    if (!res.ok) throw new ProviderError('TomTom', 'HTTP ' + res.status + (body.detailedError ? ' — ' + (body.detailedError.message || body.detailedError.code) : ''));
    const legs = origins.map(() => ({ m: null, s: null }));
    (body.data || []).forEach((c) => {
      if (c.originIndex !== c.destinationIndex || c.detailedError || !c.routeSummary || !legs[c.originIndex]) return;
      const rs = c.routeSummary;
      legs[c.originIndex] = { m: rs.lengthInMeters != null ? rs.lengthInMeters : null, s: rs.travelTimeInSeconds != null ? rs.travelTimeInSeconds : null };
    });
    if (legs.some((l) => l.m == null)) throw new ProviderError('TomTom', 'route response was missing some legs.');
    legs.forEach((l, i) => rememberPair(origins[i], dests[i], l.s, l.m));
    return legs;
  }

  return { ProviderError, searchGoogle, tomtomMatrix, getMatrices, getMatricesOrEstimate, routeLegs, clearCache, setTomTomHook, lookupPair, seedPairs };
});
