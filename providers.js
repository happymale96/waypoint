/* L-Tech Waypoint — providers.js
 * Google Places (New) Text Search — place search ONLY.
 * TomTom Routing API "Calculate Route" (service version 1) — ALL travel times by default, one origin -> one destination per
 * request (routeLeg). Matches https://docs.tomtom.com/routing-api/documentation/tomtom-maps/calculate-route :
 *   GET https://api.tomtom.com/routing/1/calculateRoute/{lat,lon}:{lat,lon}/json?key=KEY&travelMode=car&traffic=true
 *       &routeType=fastest&routeRepresentation=summaryOnly&computeTravelTimeFor=all&departAt=now|<RFC 3339 dateTime>
 *   200 -> {routes:[{summary:{lengthInMeters, travelTimeInSeconds, trafficDelayInSeconds, departureTime, arrivalTime,
 *          noTrafficTravelTimeInSeconds, historicTrafficTravelTimeInSeconds, liveTrafficIncidentsTravelTimeInSeconds}}]}
 *   historicTrafficTravelTimeInSeconds = the time "using time-dependent historic traffic data" (stored as the learned sample).
 *   Errors: 400 bad input / no route, 403 not authorised / account, 429 too many requests, 5xx: detailedError {code, message}.
 * TomTom Matrix Routing v2 (synchronous) — kept, used only when Settings -> "TomTom service" is Matrix:
 *   POST https://api.tomtom.com/routing/matrix/2?key=KEY  body {origins, destinations, options:{departAt, traffic, travelMode}}
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./budget.js'));
  else root.Providers = factory(root, root.Budget);
})(typeof self !== 'undefined' ? self : this, function (root, Budget) {
  'use strict';

  class ProviderError extends Error {
    constructor(provider, message, kind, status) { super(kind === 'limit' ? message : provider + ': ' + message); this.provider = provider; this.kind = kind || null; this.status = status || null; }
  }

  // ---------- TomTom usage hook (the app counts every request per day / month and tracks the "down" state) ----------
  // hook = {count(kind 'routing'|'matrix', n), ok(), down(status), bad(400)}. Every response that came back is counted (whatever its status).
  let hook = null;
  function setTomTomHook(h) { hook = h || null; }
  const hookCall = (name, ...a) => { try { if (hook && hook[name]) hook[name](...a); } catch (e) { /* never break a lookup */ } };
  // 401 / 403 (bad key, not allowed, allowance used up) / 429 (after the retries) / 5xx / unreachable: one friendly error
  const isDown = (status) => status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
  const downError = (status) => new ProviderError('TomTom', Budget.DOWN_MSG, 'limit', status);
  const RETRY_MS = [1200]; // a 429 waits (at least) this long, then retries that leg ONCE through the limiter (never more); a second 429 = TomTom out

  // ---------- the rate limiter: ONE in front of every TomTom Routing request ----------
  // TomTom's Routing API allows 5 queries per second, counted on ARRIVAL (network latency moves arrivals around). So the starts
  // are spread EVENLY: at most ONE request start every `gapMs` (300 ms), first in first out (a burst of starts, even a legal-looking
  // 4 a second, can land 8 arrivals inside one second). The clock and the timer are injectable
  // (o.now() -> ms on any steady clock, o.setTimer(fn, ms) -> id, o.clearTimer(id)), so a test runs on a fake clock.
  function createLimiter(o) {
    o = o || {};
    const now = o.now || (typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now());
    const setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = o.clearTimer || ((id) => clearTimeout(id));
    const gapMs = o.gapMs != null ? o.gapMs : 300;
    const queue = [];  // {fn, resolve, reject}, first in first out
    let lastStart = -Infinity, timer = null;
    function pump() {
      if (timer != null) { clearTimer(timer); timer = null; }
      const t = now();
      if (queue.length && t >= lastStart + gapMs) {
        const job = queue.shift();
        lastStart = t;
        let p;
        try { p = Promise.resolve(job.fn()); } catch (e) { p = Promise.reject(e); }
        p.then(job.resolve, job.reject);
      }
      if (queue.length) timer = setTimer(pump, Math.max(0, lastStart + gapMs - t));
    }
    // run(fn) -> Promise of fn's result; fn is called (the request STARTS) when the limiter lets it
    function run(fn) {
      return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
    }
    // sleep(ms) on the limiter's own timer (the 429 back-off), so a fake clock drives it too
    const sleep = (ms) => new Promise((r) => setTimer(r, ms));
    return { run, sleep, queued: () => queue.length, now };
  }
  let limiter = createLimiter();
  function setLimiter(l) { limiter = l || createLimiter(); }
  const getLimiter = () => limiter;

  // ---------- TomTom Routing API: one leg ----------
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  // RFC 3339 with the Malaysia offset (TomTom: "dateTime" with an optional offset), e.g. 2026-11-24T18:15:00+08:00
  function departParam(ms, nowMs) {
    if (ms == null || ms <= (nowMs != null ? nowMs : Date.now()) + 60000) return 'now';
    const d = new Date(ms + 8 * 3600e3);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + 'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':00+08:00';
  }
  const ll = (p) => Number(p.lat).toFixed(6) + ',' + Number(p.lng).toFixed(6);
  function routeUrl(from, to, departAtMs, key, nowMs) {
    return 'https://api.tomtom.com/routing/1/calculateRoute/' + ll(from) + ':' + ll(to) + '/json?key=' + encodeURIComponent(key) +
      '&travelMode=car&traffic=true&routeType=fastest&routeRepresentation=summaryOnly&computeTravelTimeFor=all&departAt=' + encodeURIComponent(departParam(departAtMs, nowMs));
  }
  // The request as TomTom sees it (from, to, departAt as sent): two calls with the same key get the same answer.
  const legKey = (from, to, departAtMs, nowMs) => ll(from) + ':' + ll(to) + '@' + departParam(departAtMs, nowMs);
  // -> {seconds, metres, typicalSeconds|null}. departAtMs null / not in the future = "now".
  // onCount(n): called with every HTTP attempt that came back (the same moments the usage hook counts), so a caller can
  // count its own requests (a 429 and its one retry are two).
  async function routeLeg(from, to, departAtMs, key, onCount) {
    if (!key) throw new ProviderError('TomTom', 'API key missing — add it in Settings.');
    const url = routeUrl(from, to, departAtMs, key, Date.now());
    for (let attempt = 0; ; attempt++) {
      let res;
      // every attempt (a retry too) is a request START the limiter paces; the fetch itself is called only when it lets it
      try { res = await limiter.run(() => fetch(url)); } catch (e) { hookCall('down', 0); throw downError(0); }
      hookCall('count', 'routing', 1);
      if (onCount) { try { onCount(1); } catch (e) { /* counting never breaks a lookup */ } }
      if (res.status === 429 && attempt < RETRY_MS.length) { await limiter.sleep(RETRY_MS[attempt]); continue; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok && isDown(res.status)) { hookCall('down', res.status); throw downError(res.status); }
      if (!res.ok) {
        const de = body.detailedError || (body.error && typeof body.error === 'object' ? body.error : null);
        if (res.status === 400) hookCall('bad', 400); // no route / bad input for this leg: that pair gets no real time
        throw new ProviderError('TomTom', 'HTTP ' + res.status + (de ? ' — ' + (de.message || de.code) : ''), null, res.status);
      }
      hookCall('ok');
      const sm = body.routes && body.routes[0] && body.routes[0].summary;
      if (!sm || sm.travelTimeInSeconds == null) throw new ProviderError('TomTom', 'no route in the answer.');
      const typ = sm.historicTrafficTravelTimeInSeconds;
      return { seconds: sm.travelTimeInSeconds, metres: sm.lengthInMeters != null ? sm.lengthInMeters : null, typicalSeconds: typ != null && isFinite(typ) ? typ : null };
    }
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

  // ---------- TomTom Matrix Routing v2 (Settings -> TomTom service: Matrix only) ----------
  const cache = new Map();   // session-only matrix cache
  const SLICE_OFFSETS_H = [0, 2, 4];
  function pt(p) { return { point: { latitude: p.lat, longitude: p.lng } }; }
  async function matrixFetch(body, key) {
    let res;
    try {
      res = await fetch('https://api.tomtom.com/routing/matrix/2?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) { hookCall('down', 0); throw downError(0); }
    hookCall('count', 'matrix', 1);
    const out = await res.json().catch(() => ({}));
    if (!res.ok && isDown(res.status)) { hookCall('down', res.status); throw downError(res.status); }
    if (res.ok) hookCall('ok');
    return { res, body: out };
  }
  async function tomtomMatrix(points, key, departAtMs) {
    if (!key) throw new ProviderError('TomTom', 'API key missing — add it in Settings.');
    const n = points.length;
    const now = Date.now();
    const options = { traffic: 'live', travelMode: 'car', departAt: (departAtMs <= now + 60000) ? 'now' : new Date(departAtMs).toISOString() };
    const { res, body } = await matrixFetch({ origins: points.map(pt), destinations: points.map(pt), options }, key);
    if (!res.ok) {
      const detail = body.detailedError ? (body.detailedError.message || body.detailedError.code) : (body.error || body.message || '');
      throw new ProviderError('TomTom', 'HTTP ' + res.status + (detail ? ' — ' + detail : ''));
    }
    const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null)));
    const d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null)));
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
  const cacheKey = (points, departAtISO) => points.map(roundPt).join('|') + '@' + departAtISO.slice(0, 16);
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
  // estimates for every pair (Budget.estSec), flagged; the provider's matrix shape
  function estimateMatrices(points, departAtISO) {
    const m = points.map((a) => points.map((b) => (a === b ? 0 : Budget.estSec(a, b))));
    const d = points.map((a) => points.map((b) => (a === b ? 0 : Budget.estMetres(a, b))));
    const est = points.map((a, i) => points.map((b, j) => i !== j));
    return [{ departAt: departAtISO, m, d, est }];
  }
  async function getMatricesOrEstimate(points, departAtISO, key, opts) {
    try {
      return await getMatrices(points, departAtISO, key, opts);
    } catch (e) {
      if (!e || e.kind !== 'limit') throw e;
      return { matrices: estimateMatrices(points, departAtISO), fromCache: false, calls: 0, partial: false, estimated: true, error: e };
    }
  }
  function clearCache() { cache.clear(); }
  // one leg through Matrix v2 (1 x 1), the same answer shape as routeLeg
  async function matrixLeg(from, to, departAtMs, key) {
    const r = await tomtomMatrix([from, to], key, departAtMs != null ? departAtMs : Date.now());
    if (r.m[0][1] == null) throw new ProviderError('TomTom', 'route response was missing the leg.');
    return { seconds: r.m[0][1], metres: r.d[0][1], typicalSeconds: null };
  }

  return { ProviderError, RETRY_MS, createLimiter, setLimiter, getLimiter, departParam, routeUrl, legKey, routeLeg, searchGoogle, tomtomMatrix, getMatrices, getMatricesOrEstimate, estimateMatrices, matrixLeg, clearCache, setTomTomHook };
});
