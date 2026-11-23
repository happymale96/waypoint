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
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Providers = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  class ProviderError extends Error {
    constructor(provider, message) { super(provider + ': ' + message); this.provider = provider; }
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
    let res;
    try {
      res = await fetch('https://api.tomtom.com/routing/matrix/2?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origins: points.map(pt), destinations: points.map(pt), options }),
      });
    } catch (e) {
      throw new ProviderError('TomTom', 'network error (' + e.message + ').');
    }
    const body = await res.json().catch(() => ({}));
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
    cache.set(ck, matrices);
    return { matrices, fromCache: false, calls: slices.length, partial: results.some((r) => r.failed) };
  }
  function clearCache() { cache.clear(); }

  // ONE Matrix Routing v2 request for a whole driven sequence (End Day): origins = points[0..n-2], destinations =
  // points[1..n-1]; the leg i is cell (i,i). Same provider/product as planning; no new API. Returns [{m metres, s seconds}].
  async function routeLegs(points, key) {
    if (!key) throw new ProviderError('TomTom', 'API key missing — add it in Settings.');
    if (!points || points.length < 2) return [];
    const origins = points.slice(0, -1), dests = points.slice(1);
    let res;
    try {
      res = await fetch('https://api.tomtom.com/routing/matrix/2?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origins: origins.map(pt), destinations: dests.map(pt), options: { traffic: 'live', travelMode: 'car', departAt: 'now' } }),
      });
    } catch (e) {
      throw new ProviderError('TomTom', 'network error (' + e.message + ').');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderError('TomTom', 'HTTP ' + res.status + (body.detailedError ? ' — ' + (body.detailedError.message || body.detailedError.code) : ''));
    const legs = origins.map(() => ({ m: null, s: null }));
    (body.data || []).forEach((c) => {
      if (c.originIndex !== c.destinationIndex || c.detailedError || !c.routeSummary || !legs[c.originIndex]) return;
      const rs = c.routeSummary;
      legs[c.originIndex] = { m: rs.lengthInMeters != null ? rs.lengthInMeters : null, s: rs.travelTimeInSeconds != null ? rs.travelTimeInSeconds : null };
    });
    if (legs.some((l) => l.m == null)) throw new ProviderError('TomTom', 'route response was missing some legs.');
    return legs;
  }

  return { ProviderError, searchGoogle, tomtomMatrix, getMatrices, routeLegs, clearCache };
});
