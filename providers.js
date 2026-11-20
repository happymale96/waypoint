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
  async function searchGoogle(query, key, onCall) {
    if (!key) throw new ProviderError('Google Places', 'API key missing — add it in Settings.');
    if (!query || !query.trim()) return [];
    let res;
    try {
      res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
        },
        body: JSON.stringify({
          textQuery: query,
          regionCode: 'MY',
          locationBias: { circle: { center: { latitude: 3.1, longitude: 101.6 }, radius: 50000 } },
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
    (body.data || []).forEach((c) => {
      if (c.originIndex === c.destinationIndex) return;
      const rs = c.routeSummary;
      if (!rs || c.detailedError) return;
      const v = rs.travelTimeInSeconds != null ? rs.travelTimeInSeconds : rs.noTrafficTravelTimeInSeconds;
      if (v != null) m[c.originIndex][c.destinationIndex] = v;
    });
    const failed = m.some((row, i) => row.some((v, j) => v == null && i !== j));
    return { m, failed };
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
    const matrices = results.map((r, i) => ({ departAt: new Date(slices[i]).toISOString(), m: r.m }));
    cache.set(ck, matrices);
    return { matrices, fromCache: false, calls: slices.length, partial: results.some((r) => r.failed) };
  }
  function clearCache() { cache.clear(); }

  return { ProviderError, searchGoogle, tomtomMatrix, getMatrices, clearCache };
});
