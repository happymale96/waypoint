/* L-Tech Waypoint — budget.js
 * TomTom budget rules (pure: no DOM, no network, no storage; the app supplies every clock and every record).
 *  - Usage counters on the device, per day (Malaysia date) and per calendar month (UTC month): TomTom Routing requests,
 *    TomTom Matrix requests, Google Places calls. TomTom's free allowance is MONTHLY and per API (Routing 20,000 by default,
 *    editable). From 90% of the Routing allowance (guardHit) the automatic live re-times (the 10-minute one, on-visible) and
 *    the after-stop look-ahead pause for the rest of that month; PLAN and tapped re-times continue.
 *  - The live re-time triggers (retimeDecision): GPS-watch positions NEVER call TomTom by themselves. A live re-time
 *    (one request: current position -> next pending stop) runs on PLAN, DONE, SKIP, Undo, Reached and a tap on the status
 *    line (always), when the page becomes visible again, and every 10 minutes while visible with a stop pending.
 *    Anything not "always" waits at least 5 minutes after the previous live re-time.
 *  - Estimated times when TomTom cannot answer: straight-line km x 1.3 at a speed by distance (under 5 km 25 km/h, 5-30 km
 *    40 km/h, over 30 km 75 km/h). estStops tells which ETAs of a plan depend on an estimated leg ("est.").
 * Exports via module.exports (node) or window.Budget.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Budget = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;
  const ROUTING_ALLOWANCE = 20000; // TomTom free plan: Routing API requests per month (editable in Settings)
  const GUARD_RATIO = 0.9;         // from 90% of the allowance the automatic re-times and the look-ahead pause
  const PLACES_DAILY_GUARD = 140;
  const MIN_GAP_MS = 5 * MIN;      // a re-time that is not "always" waits this long after the previous one
  const PERIOD_MS = 10 * MIN;      // while visible with a stop pending: one re-time every 10 minutes
  const ORIGIN_KEEP_MS = 15 * MIN; // a live origin (the last TomTom time to the next stop) counts down this long
  const ROAD_FACTOR = 1.3;
  const ALWAYS = ['plan', 'done', 'skip', 'undo', 'reached', 'tap'];
  const AUTO = ['visible', 'tick'];
  const DOWN_MSG = 'TomTom unavailable or monthly allowance used up - using estimated times';
  const GUARD_MSG = 'TomTom allowance nearly used - live times paused, PLAN still works';
  const ESTIMATED_ORDER = 'Estimated order - TomTom unavailable';
  // The ONE TomTom notice names what happened (no raw HTTP text). status = the failed answer's HTTP status (0 = unreachable).
  const NO_ROUTE_MSG = 'TomTom could not route a leg - using estimated times for it';
  function downNotice(status) {
    if (status === 403) return 'TomTom refused the key or the monthly allowance is used up - using estimated times';
    if (status === 429) return 'TomTom is busy (too many requests) - using estimated times';
    if (status === 400) return NO_ROUTE_MSG;
    return DOWN_MSG;
  }

  // ---------- usage counters ----------
  const dayKey = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10); // Malaysia date
  const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);              // UTC calendar month
  // rec = {day, d, month, m} -> {today, month}
  function countOf(rec, ms) {
    if (!rec) return { today: 0, month: 0 };
    return { today: rec.day === dayKey(ms) ? Number(rec.d) || 0 : 0, month: rec.month === monthKey(ms) ? Number(rec.m) || 0 : 0 };
  }
  function addCount(rec, ms, n) {
    const c = countOf(rec, ms), k = n == null ? 1 : n;
    return { day: dayKey(ms), d: c.today + k, month: monthKey(ms), m: c.month + k };
  }
  // usage = {routing, matrix, places} (each a rec). Returns a new object.
  function bump(usage, kind, ms, n) {
    const u = Object.assign({}, usage || {});
    u[kind] = addCount(u[kind], ms, n);
    return u;
  }
  // Google Places: ONE record (usage.places) holds today AND this month, counted through bump like TomTom.
  const countPlaces = (usage, ms) => bump(usage, 'places', ms, 1);
  const placesCount = (usage, ms) => countOf(usage && usage.places, ms);
  // One-time repair: today and this month used to come from two counters (the old settings.placesCallsToday {date, count}
  // and usage.places). If this month is lower than today for the current day, raise it (and today) - never lower a number.
  // legacy = the old {date (local yyyy-mm-dd), count} | null. Returns {usage, changed}.
  function repairPlacesMonth(usage, legacy, ms) {
    const c = placesCount(usage, ms);
    const old = legacy && legacy.date === dayKey(ms) ? Number(legacy.count) || 0 : 0;
    const today = Math.max(c.today, old);
    if (c.month >= today && c.today >= today) return { usage, changed: false };
    const u = Object.assign({}, usage || {});
    u.places = { day: dayKey(ms), d: today, month: monthKey(ms), m: Math.max(c.month, today) };
    return { usage: u, changed: true };
  }
  const allowanceOf = (a) => { const n = Math.round(Number(a)); return isFinite(n) && n > 0 ? n : ROUTING_ALLOWANCE; };
  const guardHit = (usage, ms, allowance) => countOf(usage && usage.routing, ms).month >= GUARD_RATIO * allowanceOf(allowance);
  const n0 = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // The Usage card's lines: {routing, places, matrix (null while 0), routingPct, placesPct}. Every number comes from `usage`.
  function usageLines(usage, ms, allowance) {
    const r = countOf(usage && usage.routing, ms), p = countOf(usage && usage.places, ms), mx = countOf(usage && usage.matrix, ms);
    const a = allowanceOf(allowance), pd = p.today;
    return {
      routing: 'TomTom Routing   ' + n0(r.today) + ' today · ' + n0(r.month) + ' this month of ' + n0(a),
      places: 'Google Places    ' + n0(pd) + ' today · ' + n0(p.month) + ' this month  (daily guard ' + PLACES_DAILY_GUARD + ')',
      matrix: mx.month > 0 || mx.today > 0 ? 'TomTom Matrix    ' + n0(mx.today) + ' today · ' + n0(mx.month) + ' this month' : null,
      routingPct: Math.min(100, r.month / a * 100),
      placesPct: Math.min(100, pd / PLACES_DAILY_GUARD * 100),
    };
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
    return lastAt == null || ev.at - lastAt >= MIN_GAP_MS ? yes(ev.type) : no(ev.type === 'edit' ? 'gap' : 'gap');
  }
  const isAlways = (type) => ALWAYS.indexOf(type) >= 0;
  // the live origin {usedAt} keeps counting down until the next re-time (longer than the 10-minute period)
  const originKept = (o, nowMs) => !!o && nowMs - (o.usedAt || 0) <= ORIGIN_KEEP_MS;
  // After DONE / SKIP: the look-ahead (Part F) or the single next-stop re-time.
  // o = {setting: 'auto'|'ask'|'off', pending (stops left, not counting the end point), guard, down, service, manual}
  // manual = the driver moved a stop with ▲ / ▼ since the last PLAN: his order stays (no look-ahead re-order).
  function afterStopMode(o) {
    if (!o || o.manual || o.setting === 'off' || o.guard || o.down || o.service === 'matrix') return 'single';
    return o.pending >= 2 ? 'lookahead' : 'single';
  }

  // ---------- estimated times ----------
  function distanceM(a, b) { // haversine, metres
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  const speedFor = (km) => (km < 5 ? 25 : km <= 30 ? 40 : 75);
  const estMinutesKm = (km) => km * ROAD_FACTOR / speedFor(km) * 60;
  const estMetres = (a, b) => Math.round(distanceM(a, b) * ROAD_FACTOR);
  const estSec = (a, b) => Math.round(estMinutesKm(distanceM(a, b) / 1000) * 60);
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
    ROUTING_ALLOWANCE, GUARD_RATIO, PLACES_DAILY_GUARD, MIN_GAP_MS, PERIOD_MS, ORIGIN_KEEP_MS, ROAD_FACTOR, ALWAYS, AUTO,
    DOWN_MSG, GUARD_MSG, ESTIMATED_ORDER, NO_ROUTE_MSG, downNotice,
    dayKey, monthKey, countOf, addCount, bump, countPlaces, placesCount, repairPlacesMonth, allowanceOf, guardHit, usageLines,
    retimeDecision, isAlways, originKept, afterStopMode,
    distanceM, speedFor, estMinutesKm, estSec, estMetres, hasEst, estStops,
  };
});
