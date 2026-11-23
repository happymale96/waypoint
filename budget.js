/* L-Tech Waypoint — budget.js
 * TomTom budget rules (pure: no DOM, no network, no storage; the app supplies every clock and every record).
 *  - The daily counter: requests and matrix cells per UTC day (TomTom's free plan: 2,500 non-tile requests a day,
 *    reset at 00:00 UTC = 08:00 Malaysia time). usage / addUsage / guardHit / usageLine.
 *  - The live re-time triggers (retimeDecision): GPS-watch positions NEVER call TomTom by themselves. A live re-time
 *    (one 1 x 1 request: current position -> next pending stop) runs on PLAN, DONE, SKIP, Undo, Reached and a tap on the
 *    status line (always), when the page becomes visible again, and every 10 minutes while visible with a stop pending.
 *    Anything not "always" waits at least 5 minutes after the previous live re-time. From GUARD (2,000 requests or cells,
 *    whichever is larger) the automatic ones (visible, tick) stop for the rest of that UTC day.
 *  - The estimated-times fallback (fillMatrices / estSec): when TomTom is out (401 / 403 / 429 / 5xx / unreachable) PLAN
 *    still gets matrices: cached TomTom times where held, else straight-line distance x 1.4 at 40 km/h, every estimated
 *    cell flagged (slice.est[i][j]). estStops tells which ETAs of a plan depend on an estimated leg ("est.").
 * Exports via module.exports (node) or window.Budget.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Budget = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;
  const FREE_LIMIT = 2500;         // TomTom free plan: non-tile requests per day
  const GUARD = 2000;              // from here automatic re-times stop for the rest of the UTC day
  const MIN_GAP_MS = 5 * MIN;      // a re-time that is not "always" waits this long after the previous one
  const PERIOD_MS = 10 * MIN;      // while visible with a stop pending: one re-time every 10 minutes
  const ORIGIN_KEEP_MS = 15 * MIN; // a live origin (the last TomTom time to the next stop) counts down this long
  const ROAD_FACTOR = 1.4, EST_KMH = 40;
  const ALWAYS = ['plan', 'done', 'skip', 'undo', 'reached', 'tap'];
  const AUTO = ['visible', 'tick'];
  const DOWN_MSG = 'TomTom limit reached or unavailable - using estimated times until it resets (08:00)';
  const GUARD_MSG = 'TomTom daily limit nearly used - live times paused, PLAN still works';

  // ---------- the daily counter (UTC day) ----------
  const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  function usage(rec, ms) {
    const day = utcDay(ms);
    if (!rec || rec.day !== day) return { day, requests: 0, cells: 0 };
    return { day, requests: Number(rec.requests) || 0, cells: Number(rec.cells) || 0 };
  }
  function addUsage(rec, ms, requests, cells) {
    const u = usage(rec, ms);
    return { day: u.day, requests: u.requests + (requests || 0), cells: u.cells + (cells || 0) };
  }
  const used = (rec, ms) => { const u = usage(rec, ms); return Math.max(u.requests, u.cells); };
  const guardHit = (rec, ms) => used(rec, ms) >= GUARD;
  const n0 = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  function usageLine(rec, ms) {
    const u = usage(rec, ms);
    return 'TomTom today: ' + n0(u.requests) + ' requests / ' + n0(u.cells) + ' cells (free limit 2,500 per day, resets 08:00 Malaysia time)';
  }

  // ---------- live re-time triggers ----------
  // st = {lastAt: ms of the previous live re-time | null}; ev = {type, at, visible, pending, guard}.
  // type: 'watch' (a GPS-watch position), 'plan' | 'done' | 'skip' | 'undo' | 'reached' | 'tap' (always),
  //       'visible' (the page became visible / launch), 'tick' (the minute timer), 'edit' (fuel added / removed).
  // Returns {call, why, state}: state is the next st (lastAt moves only when call is true).
  function retimeDecision(st, ev) {
    const lastAt = st && st.lastAt != null ? st.lastAt : null;
    const no = (why) => ({ call: false, why, state: { lastAt } });
    const yes = (why) => ({ call: true, why, state: { lastAt: ev.at } });
    if (!ev || ev.type === 'watch') return no('watch');
    if (ALWAYS.indexOf(ev.type) >= 0) return yes(ev.type);
    if (AUTO.indexOf(ev.type) >= 0 && ev.guard) return no('guard');
    if (ev.type === 'tick') {
      if (!ev.visible || !ev.pending) return no('idle');
      return lastAt == null || ev.at - lastAt >= PERIOD_MS ? yes('tick') : no('period');
    }
    if (ev.type === 'visible' && ev.visible === false) return no('hidden');
    return lastAt == null || ev.at - lastAt >= MIN_GAP_MS ? yes(ev.type) : no('gap');
  }
  const isAlways = (type) => ALWAYS.indexOf(type) >= 0;
  // the live origin {usedAt} keeps counting down until the next re-time (longer than the 10-minute period)
  const originKept = (o, nowMs) => !!o && nowMs - (o.usedAt || 0) <= ORIGIN_KEEP_MS;

  // ---------- estimated times ----------
  function distanceM(a, b) { // haversine, metres
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  const estMetres = (a, b) => Math.round(distanceM(a, b) * ROAD_FACTOR);
  const estSec = (a, b) => Math.round(distanceM(a, b) / 1000 * ROAD_FACTOR / EST_KMH * 3600);
  // points -> matrices in the provider's shape ({departAt, m, d, est}) for the given slice offsets (hours).
  // lookup(a, b) -> {s, m} (a cached TomTom pair) | null. Returns {matrices, estimated: number of estimated cells}.
  function fillMatrices(points, departAtISO, offsetsH, lookup) {
    const t0 = Date.parse(departAtISO);
    let estimated = 0;
    const n = points.length;
    const cell = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
      if (i === j) return { s: 0, m: 0, est: false };
      const c = lookup ? lookup(points[i], points[j]) : null;
      if (c && c.s != null && isFinite(c.s)) return { s: c.s, m: c.m != null ? c.m : estMetres(points[i], points[j]), est: false };
      estimated++;
      return { s: estSec(points[i], points[j]), m: estMetres(points[i], points[j]), est: true };
    }));
    const matrices = (offsetsH || [0]).map((h) => ({
      departAt: new Date(t0 + h * 3600e3).toISOString(),
      m: cell.map((r) => r.map((c) => c.s)),
      d: cell.map((r) => r.map((c) => c.m)),
      est: cell.map((r) => r.map((c) => c.est)),
    }));
    return { matrices, estimated: estimated * matrices.length };
  }
  const hasEst = (matrices) => !!(matrices && matrices.some((s) => s.est && s.est.some((r) => r.some(Boolean))));
  // Which pending stops of a (re-timed) plan depend on an estimated leg, walking the chain like Solver.retime:
  // from stop `fromStopIndex` (-1 = the start). liveFirst = the first leg comes from a live TomTom time (not estimated).
  // Returns {stops: Set of placeIds, end: boolean}.
  function estStops(plan, fromStopIndex, liveFirst) {
    const out = { stops: new Set(), end: false };
    const m = plan && plan.model;
    if (!m || !m.matrices || !m.matrices.length || !m.matrices[0].est) return out;
    const est = m.matrices[0].est, k = m.stopIds.length;
    const pidx = (pid) => { const i = m.stopIds.indexOf(pid); return i < 0 ? null : i + 1; };
    let pos = 0;
    if (fromStopIndex >= 0 && plan.stops[fromStopIndex]) { const p = pidx(plan.stops[fromStopIndex].placeId); pos = p == null ? null : p; }
    let tainted = false, first = true;
    plan.stops.forEach((s) => {
      if (s.status === 'done' || s.status === 'skipped') return;
      const pi = s.fuel ? null : pidx(s.placeId);
      if (s.reachedAt == null) {
        const legEst = first && liveFirst ? false : (pos != null && pi != null ? !!(est[pos] && est[pos][pi]) : false);
        tainted = tainted || legEst;
      }
      first = false;
      if (tainted) out.stops.add(s.placeId);
      pos = pi;
    });
    out.end = tainted || (first && liveFirst ? false : (pos != null ? !!(est[pos] && est[pos][k + 1]) : false));
    return out;
  }

  return {
    FREE_LIMIT, GUARD, MIN_GAP_MS, PERIOD_MS, ORIGIN_KEEP_MS, ROAD_FACTOR, EST_KMH, ALWAYS, AUTO, DOWN_MSG, GUARD_MSG,
    utcDay, usage, addUsage, used, guardHit, usageLine, retimeDecision, isAlways, originKept,
    distanceM, estSec, estMetres, fillMatrices, hasEst, estStops,
  };
});
