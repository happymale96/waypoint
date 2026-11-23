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
  // A stop carried to another day starts fresh: no reached time, no navigation tap, no "no auto-reach" flag.
  function carryForward(stop) {
    const out = Object.assign({}, stop, { reachedAt: null, reachedSource: null });
    delete out.noAutoReach; delete out.navStartedAt;
    return out;
  }
  // The per-stop state that survives a re-solve / re-insertion of the same pending stop (Replan from here, No detour,
  // Avoid lunch, the fuel stop put back): reached time + source, the no-auto-reach flag and the navigation tap.
  const KEEP = ['reachedAt', 'reachedSource', 'noAutoReach', 'navStartedAt'];
  function keptState(stop) {
    if (!stop || stop.status) return null;
    const o = {};
    let any = false;
    KEEP.forEach((k) => { if (stop[k] != null && stop[k] !== false) { o[k] = stop[k]; any = true; } });
    return any ? o : null;
  }
  // newStops with the kept state of the pending oldStops (matched by placeId) copied on; new objects, inputs untouched.
  function keepStateOf(oldStops, newStops) {
    const keep = {};
    (oldStops || []).forEach((s) => { const k = keptState(s); if (k) keep[s.placeId] = k; });
    return (newStops || []).map((s) => (!s.status && keep[s.placeId] ? Object.assign({}, s, keep[s.placeId]) : s));
  }

  // ---------- travel time from the navigation tap ----------
  // navStartedAt = the FIRST tap on the stop's own navigation button (WAZE / MAPS) after the previous departure
  // (prevDepartMs: the last done stop's done time, or the day's start). A tap on a stop that is reached, done or skipped is
  // ignored; a later tap keeps the first one; a tap stored BEFORE the previous departure is stale and is replaced.
  function stampNav(stop, nowMs, prevDepartMs) {
    if (!stop || stop.status || isReached(stop)) return stop;
    const cur = toMs(stop.navStartedAt);
    if (cur != null && !isNaN(cur) && (prevDepartMs == null || cur >= prevDepartMs)) return stop;
    return Object.assign({}, stop, { navStartedAt: nowMs });
  }

  // ---------- the GPS watch (app open only) ----------
  const WATCH_OPTS = { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 };
  const WATCH_RETIME_MS = 30000;   // route re-timing from watch updates: at most once per 30 s
  // ONE watchPosition runs while all hold: page visible, a stop is still pending (not done, not skipped), the day is open.
  const shouldWatch = (o) => !!(o && o.visible && o.hasPendingStop && !o.dayClosed);
  // the throttle: is a re-time from a watch update due? (lastMs = the last re-time it caused; null = never)
  const retimeDue = (lastMs, nowMs, intervalMs) => lastMs == null || nowMs - lastMs >= (intervalMs != null ? intervalMs : WATCH_RETIME_MS);
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

  // ---------- driving / on site / between stops / lunch ----------
  // stops = the stops in the order they were done: [{reachedAt, doneAt, dwellMin, navStartedAt?, skipped?}]; dayStart = the
  // day's start / depart time (ms). opts: endArrivedAt (ms the end point was marked ARRIVED: adds the final leg),
  // endNavStartedAt (the end point's navigation tap), breakStartedAt / breakEndedAt (the real lunch break, ms).
  //   previous departure = the previous stop's done time, or dayStart for the first
  //   nav       = navStartedAt, used only when previous departure <= nav <= arrival (and not after Reached)
  //   betweenMin = nav - previous departure        (0 without a nav tap)
  //   driveMin   = arrival - nav                   (arrival - previous departure without a nav tap: splitEstimated)
  //   onSiteMin  = doneAt - arrival
  //   arrival    = reachedAt, except when reachedAt is missing or doneAt - reachedAt < 60 s: then doneAt - planned dwell,
  //                never earlier than the previous departure (or the nav tap), and estimated = true (the "~" on arr).
  //   lunchMin   = the overlap of the real break with the day's chain; that overlap is SUBTRACTED from the bucket it falls
  //                in, so between + drive + onSite + lunch = the time from dayStart to the last done / ARRIVED.
  // Skipped stops contribute nothing. Returns {stops:[{driveMin, onSiteMin, betweenMin, lunchMin, estimated, navMissing,
  // splitEstimated, arrivalMs, departMs, prevDepartMs, navMs, skipped?}], totals:{driveMin, onSiteMin, betweenMin, lunchMin,
  // totalMin, anyEstimated, anySplitEstimated, endDriveMin, endBetweenMin, end:{prevDepartMs, navMs, arrivalMs}|null}}.
  function daySplit(stops, dayStart, opts) {
    opts = opts || {};
    let prev = toMs(dayStart);
    const start = prev;
    const bs = toMs(opts.breakStartedAt), be0 = toMs(opts.breakEndedAt);
    const hasBreak = bs != null && !isNaN(bs) && be0 != null && !isNaN(be0) && be0 > bs;
    const overlap = (a, b) => (hasBreak && a != null && b != null && b > a ? Math.max(0, Math.min(b, be0) - Math.max(a, bs)) : 0);
    const seg = (a, b) => { // [a, b] -> {min (lunch removed), lunch}
      if (a == null || b == null || !(b > a)) return { min: 0, lunch: 0 };
      const l = overlap(a, b);
      return { min: (b - a - l) / MIN, lunch: l / MIN };
    };
    const navOk = (nav, lo, hi) => nav != null && !isNaN(nav) && (lo == null || nav >= lo) && (hi == null || nav <= hi);
    const out = [];
    let drive = 0, onSite = 0, between = 0, lunch = 0, anyEstimated = false, anySplit = false;
    const skippedRow = () => ({ driveMin: 0, onSiteMin: 0, betweenMin: 0, lunchMin: 0, estimated: false, navMissing: false, splitEstimated: false, skipped: true, arrivalMs: null, departMs: null, prevDepartMs: null, navMs: null });
    (stops || []).forEach((s) => {
      if (s.skipped || s.status === 'skipped') { out.push(skippedRow()); return; }
      const done = toMs(s.doneAt), reached = toMs(s.reachedAt);
      if (done == null || isNaN(done)) { out.push(skippedRow()); return; }
      const floor = prev == null ? -Infinity : prev;
      const reachedOk = !(reached == null || isNaN(reached) || done - reached < MIN_ON_SITE_MS);
      const nav0 = toMs(s.navStartedAt);
      const nav = navOk(nav0, prev, Math.min(done, reachedOk ? reached : done)) ? nav0 : null;
      let arrival, estimated = false;
      if (!reachedOk) {
        arrival = Math.max(done - (Number(s.dwellMin) || 0) * MIN, floor, nav != null ? nav : -Infinity);
        estimated = true;
      } else arrival = Math.max(reached, floor);
      arrival = Math.min(arrival, done);
      const b = nav != null ? seg(prev, nav) : { min: 0, lunch: 0 };
      const d = prev == null ? { min: 0, lunch: 0 } : seg(nav != null ? nav : prev, arrival);
      const o = seg(arrival, done);
      const navMissing = nav == null;
      const splitEstimated = estimated || navMissing;
      const lunchMin = b.lunch + d.lunch + o.lunch;
      drive += d.min; onSite += o.min; between += b.min; lunch += lunchMin;
      if (estimated) anyEstimated = true;
      if (splitEstimated) anySplit = true;
      out.push({ driveMin: d.min, onSiteMin: o.min, betweenMin: b.min, lunchMin, estimated, navMissing, splitEstimated, skipped: false,
        arrivalMs: arrival, departMs: done, prevDepartMs: prev, navMs: nav });
      prev = done;
    });
    const endArr = toMs(opts.endArrivedAt);
    let endDriveMin = 0, endBetweenMin = 0, end = null, last = prev;
    if (endArr != null && !isNaN(endArr) && prev != null && endArr >= prev) {
      const en0 = toMs(opts.endNavStartedAt);
      const en = navOk(en0, prev, endArr) ? en0 : null;
      const b = en != null ? seg(prev, en) : { min: 0, lunch: 0 };
      const d = seg(en != null ? en : prev, endArr);
      endBetweenMin = b.min; endDriveMin = d.min; lunch += b.lunch + d.lunch;
      if (en == null) anySplit = true;
      end = { prevDepartMs: prev, navMs: en, arrivalMs: endArr, navMissing: en == null };
      last = endArr;
    }
    const totalMin = start != null && last != null ? Math.max(0, (last - start) / MIN) : 0;
    return { stops: out, totals: { driveMin: drive + endDriveMin, onSiteMin: onSite, betweenMin: between + endBetweenMin, lunchMin: lunch, totalMin,
      anyEstimated, anySplitEstimated: anySplit, endDriveMin, endBetweenMin, end } };
  }

  // ---------- the day's timeline (one state machine over the whole day, not per stop) ----------
  // events = [{type, stopId, at (ms | ISO), name?, fuel?}] in any order (sorted here, stable on ties):
  //   nav      a tap on a stop's own navigation button (stopId = the stop; null = the end point). Every tap is an event.
  //   reached  the stop was reached (tap or auto). An undone Reached is simply not an event.
  //   done     the stop was marked DONE
  //   skip     the stop was skipped; it only matters when the stop had been reached (then the skip is the departure)
  //   arrived  ARRIVED on the end point (the timeline stops there)
  // dwells = {stopId: planned dwell in minutes} (only used to estimate an arrival). dayStart / dayEnd = ms (dayEnd may be null:
  // the day then ends at its last done / skip / ARRIVED). opts = {breakStartedAt, breakEndedAt} (ms, the real lunch break).
  //
  // States: BETWEEN (after a departure, before any navigation tap) -> DRIVING (from the first navigation tap, for ANY stop or the
  // end point) -> ON SITE (from an arrival until DONE / SKIP). A departure is the day's start, a DONE, or the SKIP of a stop that
  // had been reached. DRIVING lasts until the next ARRIVAL at ANY stop (Reached, or - when a DONE has no usable Reached (missing, or
  // under 60 s before it) - done minus the planned dwell, never earlier than the segment start) and is credited to the stop
  // that ends it, together with the BETWEEN before it. No navigation tap between a departure and an arrival: all of it is DRIVING and
  // that stop is flagged estimated. A navigation tap while on site takes effect at the departure (driving from DONE, between 0).
  // Taps for other stops while DRIVING, a stop skipped without being reached, and anything about the plan (stops added, removed,
  // re-ordered, replans) change nothing. Two stops reached before either is done: on-site time goes to the latest reached; the
  // departure is when no reached-not-done stop remains. The real break is subtracted from every segment it overlaps and is its
  // own bucket, so betweenMin + driveMin + onSiteMin + lunchMin = totalMin (start to end) exactly.
  // Returns {segments:[{kind:'between'|'driving'|'onsite', from, to, stopId, min, lunchMin}], perStop:[one per arrival: {stopId,
  // name, fuel, driveMin, onSiteMin, betweenMin, lunchMin, estimated, navMissing, splitEstimated, skipped, arrivalMs, departMs,
  // prevDepartMs, navMs}], end:{prevDepartMs, navMs, arrivalMs, navMissing}|null, totals:{driveMin, onSiteMin, betweenMin, lunchMin,
  // totalMin, anyEstimated, anySplitEstimated, endDriveMin, endBetweenMin, end}}.
  const TL_TYPES = { nav: 1, reached: 1, done: 1, skip: 1, arrived: 1 };
  const KIND_FIELD = { between: 'betweenMin', driving: 'driveMin', onsite: 'onSiteMin' };
  function dayTimeline(events, dwells, dayStart, dayEnd, opts) {
    opts = opts || {}; dwells = dwells || {};
    const start = toMs(dayStart);
    const noTotals = { driveMin: 0, onSiteMin: 0, betweenMin: 0, lunchMin: 0, totalMin: 0, anyEstimated: false, anySplitEstimated: false, endDriveMin: 0, endBetweenMin: 0, end: null };
    if (start == null || isNaN(start)) return { segments: [], perStop: [], end: null, totals: noTotals };
    const bs = toMs(opts.breakStartedAt), be = toMs(opts.breakEndedAt);
    const hasBreak = bs != null && !isNaN(bs) && be != null && !isNaN(be) && be > bs;
    const overlap = (a, b) => (hasBreak ? Math.max(0, Math.min(b, be) - Math.max(a, bs)) : 0);

    const evs = (events || []).map((e, i) => ({ type: e && e.type, stopId: e && e.stopId != null ? e.stopId : null, at: toMs(e && e.at), name: e && e.name || null, fuel: !!(e && e.fuel), i }))
      .filter((e) => TL_TYPES[e.type] === 1 && e.at != null && !isNaN(e.at)).sort((a, b) => a.at - b.at || a.i - b.i);
    // pair every DONE with its Reached: a missing one, or one under 60 s before the DONE, is not used (the arrival is estimated)
    const open = {};
    evs.forEach((e) => {
      if (e.type === 'reached') { if (open[e.stopId]) open[e.stopId].drop = true; open[e.stopId] = e; }
      else if (e.type === 'done') {
        const r = open[e.stopId];
        if (!(r && e.at - r.at >= MIN_ON_SITE_MS)) { if (r) r.drop = true; }
        delete open[e.stopId];
      } else if (e.type === 'skip') delete open[e.stopId];
    });

    const segs = [], entries = [], stack = [];
    let state = 'between', t = start, now = start, depart = start, navMs = null, navOnSite = false, legSegs = [], last = start, finished = false;
    const endEntry = { driveMin: 0, betweenMin: 0, lunchMin: 0 };
    let end = null;
    const addSeg = (kind, from, to, entry, stopId) => {
      if (!(to > from)) return null;
      const s = { kind, from, to, stopId: stopId != null ? stopId : null, entry: entry || null };
      segs.push(s);
      return s;
    };
    const closeOnSite = (at) => { const top = stack[stack.length - 1]; if (top) addSeg('onsite', t, at, top, top.stopId); t = at; };
    function arrive(e, at, estimated) {
      const entry = { stopId: e.stopId, name: e.name, fuel: e.fuel, driveMin: 0, onSiteMin: 0, betweenMin: 0, lunchMin: 0, estimated: !!estimated, navMissing: false,
        splitEstimated: false, skipped: false, arrivalMs: at, departMs: null, prevDepartMs: null, navMs: null };
      if (state === 'onsite') closeOnSite(at); // a second stop reached before the first is done: no leg, the latest reached gets the time
      else {
        entry.prevDepartMs = depart;
        entry.navMissing = state === 'between';
        entry.navMs = state === 'driving' ? navMs : null;
        addSeg('driving', t, at, entry, e.stopId);
        legSegs.forEach((s) => { s.entry = entry; s.stopId = e.stopId; });
        legSegs = [];
      }
      entry.splitEstimated = entry.estimated || entry.navMissing;
      entries.push(entry); stack.push(entry);
      state = 'onsite'; t = at;
      return entry;
    }
    function leave(e, at, skipped) {
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].stopId === e.stopId) { idx = i; break; }
      if (idx < 0) {
        if (skipped) return; // skipped without having been reached: no effect
        const dwell = Number(dwells[e.stopId]) || 0;
        arrive(e, Math.min(at, Math.max(at - dwell * MIN, t)), true);
        idx = stack.length - 1;
      }
      const entry = stack[idx];
      if (idx === stack.length - 1) closeOnSite(at);
      stack.splice(idx, 1);
      entry.departMs = at; entry.skipped = !!skipped;
      if (e.name) entry.name = e.name;
      if (e.fuel) entry.fuel = true;
      if (!stack.length) { // the departure
        state = 'between'; t = at; depart = at; navMs = null; legSegs = [];
        if (navOnSite) { state = 'driving'; navMs = at; navOnSite = false; }
      }
    }
    for (const e of evs) {
      if (e.drop) continue;
      if (finished) break;
      const at = Math.max(e.at, now);
      now = at;
      if (e.type !== 'nav') last = at;
      if (e.type === 'nav') {
        if (state === 'between') { const s = addSeg('between', t, at, null); if (s) legSegs.push(s); state = 'driving'; t = at; navMs = at; }
        else if (state === 'onsite') navOnSite = true;
      } else if (e.type === 'reached') {
        if (!stack.some((x) => x.stopId === e.stopId)) arrive(e, at, false);
      } else if (e.type === 'done') leave(e, at, false);
      else if (e.type === 'skip') leave(e, at, true);
      else if (e.type === 'arrived') {
        if (state === 'onsite') { closeOnSite(at); stack.length = 0; end = { prevDepartMs: null, navMs: null, arrivalMs: at, navMissing: false }; }
        else {
          end = { prevDepartMs: depart, navMs: state === 'driving' ? navMs : null, arrivalMs: at, navMissing: state === 'between' };
          addSeg('driving', t, at, endEntry);
          legSegs.forEach((s) => { s.entry = endEntry; });
          legSegs = [];
        }
        finished = true;
      }
    }
    let tEnd = last;
    if (!finished) { // the day runs on to dayEnd (when given): the open state continues
      const de = toMs(dayEnd);
      tEnd = Math.max(last, de != null && !isNaN(de) ? de : last);
      if (tEnd > t) {
        if (state === 'onsite') closeOnSite(tEnd);
        else addSeg(state === 'between' ? 'between' : 'driving', t, tEnd, null);
      }
    }
    const totals = Object.assign({}, noTotals);
    segs.forEach((s) => {
      const l = overlap(s.from, s.to), min = (s.to - s.from - l) / MIN;
      s.min = min; s.lunchMin = l / MIN;
      totals[KIND_FIELD[s.kind]] += min; totals.lunchMin += s.lunchMin;
      if (s.entry) { s.entry[KIND_FIELD[s.kind]] += min; s.entry.lunchMin += s.lunchMin; }
    });
    totals.totalMin = Math.max(0, (tEnd - start) / MIN);
    totals.endDriveMin = endEntry.driveMin; totals.endBetweenMin = endEntry.betweenMin;
    totals.anySplitEstimated = entries.some((x) => x.splitEstimated) || !!(end && end.navMissing);
    totals.anyEstimated = totals.anySplitEstimated;
    totals.end = end;
    return { segments: segs.map((s) => ({ kind: s.kind, from: s.from, to: s.to, stopId: s.stopId, min: s.min, lunchMin: s.lunchMin })), perStop: entries, end, totals };
  }

  // The day-log summary as timeline events: every navigation tap recorded as an event (sum.navs, v3 days) plus the per-stop
  // navStartedAt / arrivedEndNavAt of days recorded under the previous format (deduplicated against the events: the same tap
  // is never counted twice), the Reached + DONE of each visit, the SKIP of a stop that had been reached, ARRIVED.
  function timelineEventsOfSummary(sum) {
    const ev = [], seen = {}, dwells = {};
    const nav = (stopId, at, isEnd) => {
      if (at == null) return;
      const k = (isEnd ? '@end' : stopId) + '|' + at;
      if (seen[k]) return;
      seen[k] = true;
      ev.push({ type: 'nav', stopId: isEnd ? null : stopId, at });
    };
    ((sum && sum.navs) || []).forEach((n) => nav(n.stopId, n.at, n.end));
    ((sum && sum.visits) || []).forEach((v) => {
      nav(v.stopId, v.navStartedAt, false);
      if (v.dwellMin != null) dwells[v.stopId] = v.dwellMin;
      if (v.reachedAt != null) ev.push({ type: 'reached', stopId: v.stopId, at: v.reachedAt, name: v.name, fuel: v.fuel });
      ev.push({ type: 'done', stopId: v.stopId, at: v.doneAt, name: v.name, fuel: v.fuel });
    });
    ((sum && sum.skips) || []).forEach((s) => {
      if (s.reachedAt == null) return; // skipped without being reached: no effect on the timeline
      ev.push({ type: 'reached', stopId: s.stopId, at: s.reachedAt, name: s.name });
      ev.push({ type: 'skip', stopId: s.stopId, at: s.at, name: s.name });
    });
    if (sum && sum.arrivedEndNavAt != null) nav(null, sum.arrivedEndNavAt, true);
    if (sum && sum.arrivedEndAt != null) ev.push({ type: 'arrived', stopId: null, at: sum.arrivedEndAt });
    return { events: ev, dwells };
  }

  // The split for a day-log summary (DayLog.summarise()), or null when there is nothing to split.
  //   v: 2 (a day recorded with the navigation-tap timing, sum.timeSplitV >= 2: the previous format with a per-stop
  //        navStartedAt, or the current one with nav events): four buckets from dayTimeline, the break included;
  //        a break still running counts up to nowMs.
  //   v: 1 (a day closed before that): driving vs on site only (daySplit), and only when some done stop has a Reached time
  //        (nothing is backfilled).
  function splitOfSummary(sum, nowMs) {
    const visits = (sum && sum.visits) || [];
    const v2 = !!(sum && sum.timeSplitV >= 2);
    if (v2 ? !visits.length : !visits.some((v) => v.reachedAt != null)) return null;
    if (v2) {
      const o = {};
      if (sum.breakStartedAt != null) { o.breakStartedAt = sum.breakStartedAt; o.breakEndedAt = sum.breakEndedAt != null ? sum.breakEndedAt : (nowMs != null ? nowMs : null); }
      const te = timelineEventsOfSummary(sum);
      const tl = dayTimeline(te.events, te.dwells, sum.startedAt, null, o);
      return { v: 2, stops: tl.perStop.map((x) => Object.assign({}, x, { name: x.name || '(stop)' })), totals: tl.totals, breakTaken: sum.breakStartedAt != null, timeline: tl };
    }
    const sp = daySplit(visits, sum.startedAt, { endArrivedAt: sum.arrivedEndAt });
    return { v: 1, stops: visits.map((v, i) => Object.assign({}, v, sp.stops[i])), totals: sp.totals, breakTaken: false };
  }

  // "Driving 2 h 10 min · On site 1 h 47 min · Between stops 38 min · Lunch 52 min (part estimated)" (dur = minutes -> text)
  function splitLine(sp, dur) {
    const t = sp.totals;
    if (sp.v !== 2) return 'Driving ' + dur(t.driveMin) + ' · On site ' + dur(t.onSiteMin) + (t.anyEstimated ? ' (part estimated)' : '');
    return 'Driving ' + dur(t.driveMin) + ' · On site ' + dur(t.onSiteMin) + ' · Between stops ' + dur(t.betweenMin)
      + (sp.breakTaken && t.lunchMin > 0 ? ' · Lunch ' + dur(t.lunchMin) : '') + (t.anySplitEstimated ? ' (part estimated)' : '');
  }
  // Per stop: "left prev 13:40 · nav 13:52 · arr 14:10 · done 14:32" (only the values that exist; "~" on an estimated
  // arrival). v1: "arr 14:10 · left 14:32" as before. hm = ms -> "HH:MM".
  function stopLine(x, v, hm) {
    if (v !== 2) return 'arr ' + (x.estimated ? '~' : '') + hm(x.arrivalMs) + ' · left ' + hm(x.departMs);
    const p = [];
    if (x.prevDepartMs != null) p.push('left prev ' + hm(x.prevDepartMs));
    if (x.navMs != null) p.push('nav ' + hm(x.navMs));
    if (x.arrivalMs != null) p.push('arr ' + (x.estimated ? '~' : '') + hm(x.arrivalMs));
    if (x.departMs != null) p.push((x.skipped ? 'skipped ' : 'done ') + hm(x.departMs));
    return p.join(' · ');
  }

  return { RADIUS_M, MAX_ACCURACY_M, TAP_GUARD_MS, MIN_ON_SITE_MS, isReached, buttonLabel, tapIgnored, stampReached, undoReached, undoDone, carryForward,
    keptState, keepStateOf, stampNav, WATCH_OPTS, WATCH_RETIME_MS, shouldWatch, retimeDue,
    reachedText, onSiteStop, autoReachTarget, daySplit, dayTimeline, timelineEventsOfSummary, splitOfSummary, splitLine, stopLine };
});
