/* L-Tech Waypoint — reached.js
 * "Reached" before "Done": pure helpers (no DOM, no network, no storage). The app owns every tap and every clock;
 * this file owns the rules: the stop's reached state, the one-button label and double-tap guard, auto-reach
 * (autoReachTarget), the day's driving / on-site split (daySplit) and carry-forward.
 *
 * A stop (plan stop) carries reachedAt (ms timestamp | null), reachedSource ('tap' | 'auto' | null) and, after an Undo of
 * Reached, noAutoReach (true) for the rest of the plan. doneAt is an ISO string (as stored on the plan stop) or ms.
 * Exports via module.exports (node) or window.Reached.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./solver.js'));
  else root.Reached = factory(root.Solver);
})(typeof self !== 'undefined' ? self : this, function (Solver) {
  'use strict';

  const RADIUS_M = 150;            // auto-reach: within this distance of the stop
  const MAX_ACCURACY_M = 100;      // auto-reach: fix accuracy 100 m or better
  const TAP_GUARD_MS = 500;        // after REACHED the button ignores taps for this long
  const MIN_ON_SITE_MS = 60000;    // under this between Reached and Done = a double-tap: arrival is estimated instead
  const MIN = 60000;

  const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));
  const isReached = (stop) => !!stop && stop.reachedAt != null;
  const isPending = (stop) => !!stop && !stop.status;

  // ---------- the stop's state ----------
  // The one primary button: REACHED until the stop is reached, then DONE.
  const buttonLabel = (stop) => (isReached(stop) ? 'DONE' : 'REACHED');
  // A tap on the primary button within 500 ms of the stop becoming reached is ignored (accidental double-tap).
  const tapIgnored = (stop, nowMs) => isReached(stop) && nowMs - stop.reachedAt >= 0 && nowMs - stop.reachedAt < TAP_GUARD_MS;
  // New stop objects (the inputs are never changed).
  function stampReached(stop, nowMs, source) {
    return Object.assign({}, stop, { reachedAt: nowMs, reachedSource: source === 'auto' ? 'auto' : 'tap' });
  }
  // Undo of Reached: back to REACHED, and no auto-reach on this stop for the rest of the plan.
  function undoReached(stop) {
    return Object.assign({}, stop, { reachedAt: null, reachedSource: null, noAutoReach: true });
  }
  // Undo of Done: pending again, reachedAt / reachedSource kept (the stop goes back to the reached state).
  function undoDone(stop) {
    const out = Object.assign({}, stop);
    delete out.status; delete out.doneAt;
    return out;
  }
  // A stop carried to another day starts fresh: no reached time, no "no auto-reach" flag.
  function carryForward(stop) {
    const out = Object.assign({}, stop, { reachedAt: null, reachedSource: null });
    delete out.noAutoReach;
    return out;
  }
  // "Reached 14:10" / "Reached 14:10 · auto" (fmt = ms -> "HH:MM")
  const reachedText = (stop, fmt) => 'Reached ' + fmt(stop.reachedAt) + (stop.reachedSource === 'auto' ? ' · auto' : '');
  // The stop the driver is on site at: the first stop that is reached and not done / skipped.
  const onSiteStop = (stops) => (stops || []).find((s) => isPending(s) && isReached(s)) || null;

  // ---------- auto-reach ----------
  // fix  = {lat, lng, accuracy, at (ms the position was measured)}
  // stops = [{id, lat, lng, status?, reachedAt?, noAutoReach?, isEnd?}]  (the end point may be listed with isEnd: true)
  // opts = {enabled, visible, now}
  // Returns a stop id only when ALL hold: setting on; page visible; the fix is fresh by the app's own rule
  // (Solver.originFresh, 5 min) and accurate to 100 m or better; exactly ONE pending stop (not done, not skipped, not
  // already reached, not flagged no-auto-reach) lies within 150 m; and that stop is not the end point. Otherwise null.
  function autoReachTarget(fix, stops, opts) {
    opts = opts || {};
    if (!opts.enabled || !opts.visible) return null;
    if (!fix || fix.lat == null || fix.lng == null || fix.at == null) return null;
    if (!(fix.accuracy <= MAX_ACCURACY_M)) return null;
    if (!Solver.originFresh({ usedAt: fix.at }, opts.now)) return null;
    const inRange = (stops || []).filter((s) => isPending(s) && !isReached(s) && !s.noAutoReach && s.lat != null && s.lng != null
      && Solver.distanceM(fix, s) <= RADIUS_M);
    if (inRange.length !== 1 || inRange[0].isEnd) return null;
    return inRange[0].id;
  }

  // ---------- driving vs on site ----------
  // stops = the stops in the order they were done: [{reachedAt, doneAt, dwellMin, skipped?}]; dayStart = the day's start /
  // depart time (ms); opts.endArrivedAt = ms the end point was marked ARRIVED (adds the final drive).
  //   driveMin  = arrival - previous departure (the previous stop's done time, or dayStart for the first)
  //   onSiteMin = doneAt - arrival
  //   arrival   = reachedAt, except when reachedAt is missing or doneAt - reachedAt < 60 s: then doneAt - planned dwell,
  //               never earlier than the previous departure, and estimated = true.
  // Skipped stops contribute nothing. Returns {stops:[{driveMin, onSiteMin, estimated, arrivalMs, departMs, skipped?}],
  // totals:{driveMin, onSiteMin, anyEstimated, endDriveMin}}.
  function daySplit(stops, dayStart, opts) {
    opts = opts || {};
    let prev = toMs(dayStart);
    const out = [];
    let drive = 0, onSite = 0, anyEstimated = false;
    (stops || []).forEach((s) => {
      if (s.skipped || s.status === 'skipped') { out.push({ driveMin: 0, onSiteMin: 0, estimated: false, skipped: true, arrivalMs: null, departMs: null }); return; }
      const done = toMs(s.doneAt), reached = toMs(s.reachedAt);
      if (done == null || isNaN(done)) { out.push({ driveMin: 0, onSiteMin: 0, estimated: false, skipped: true, arrivalMs: null, departMs: null }); return; }
      const floor = prev == null ? -Infinity : prev;
      let arrival, estimated = false;
      if (reached == null || isNaN(reached) || done - reached < MIN_ON_SITE_MS) {
        arrival = Math.max(done - (Number(s.dwellMin) || 0) * MIN, floor);
        estimated = true;
      } else arrival = Math.max(reached, floor);
      arrival = Math.min(arrival, done);
      const driveMin = prev == null ? 0 : Math.max(0, (arrival - prev) / MIN);
      const onSiteMin = Math.max(0, (done - arrival) / MIN);
      drive += driveMin; onSite += onSiteMin; if (estimated) anyEstimated = true;
      out.push({ driveMin, onSiteMin, estimated, skipped: false, arrivalMs: arrival, departMs: done });
      prev = done;
    });
    const endArr = toMs(opts.endArrivedAt);
    const endDriveMin = endArr != null && !isNaN(endArr) && prev != null ? Math.max(0, (endArr - prev) / MIN) : 0;
    return { stops: out, totals: { driveMin: drive + endDriveMin, onSiteMin: onSite, anyEstimated, endDriveMin } };
  }

  // The split for a day-log summary (DayLog.summarise().visits), or null when no done stop has a reached time
  // (a day closed before this feature: no split line, nothing backfilled).
  function splitOfSummary(sum) {
    const visits = (sum && sum.visits) || [];
    if (!visits.some((v) => v.reachedAt != null)) return null;
    const sp = daySplit(visits, sum.startedAt, { endArrivedAt: sum.arrivedEndAt });
    return { stops: visits.map((v, i) => Object.assign({}, v, sp.stops[i])), totals: sp.totals };
  }

  return { RADIUS_M, MAX_ACCURACY_M, TAP_GUARD_MS, MIN_ON_SITE_MS, isReached, buttonLabel, tapIgnored, stampReached, undoReached, undoDone, carryForward,
    reachedText, onSiteStop, autoReachTarget, daySplit, splitOfSummary };
});
