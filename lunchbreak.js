/* L-Tech Waypoint — lunchbreak.js
 * The DRIVER's lunch break (not a customer's closed window): pure helpers (no DOM, no network, no storage, no clock of its
 * own). Settings (device-stored, in Export / Import): lunchBreakOn (default true), lunchBreakFrom ('HH:MM', default 12:15),
 * lunchBreakMin (default 60).
 *
 * Today's break state = {date, startedAt (ms|null), endedAt (ms|null), skipped (bool)}. Its phase:
 *   'off'      setting off and no break started          -> nothing in the timeline
 *   'assumed'  setting on, neither taken nor skipped      -> the planned break: length added once, at the first departure
 *                                                            at or after "Available from"
 *   'active'   started, not ended, length not yet elapsed -> the real break: the next departure is no earlier than
 *                                                            startedAt + length (= now + remaining)
 *   'taken'    ended (End break, or the length elapsed)   -> nothing more (one break a day); times run from now
 *   'skipped'  Skip today                                 -> nothing in the timeline
 * applyBreak() is applied to every re-timed plan (the app's one timing path), so Route ETAs, LATE, the end arrival and the
 * WhatsApp ETA all see it. Exports via module.exports (node) or window.LunchBreak.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./solver.js'));
  else root.LunchBreak = factory(root.Solver);
})(typeof self !== 'undefined' ? self : this, function (Solver) {
  'use strict';

  const MIN = 60000;
  const DEFAULTS = { lunchBreakOn: true, lunchBreakFrom: '12:15', lunchBreakMin: 60 };
  const HM = /^(\d{1,2}):(\d{2})$/;

  // normalised settings: {on, from 'HH:MM', lenMin > 0}
  function settingsOf(s) {
    s = s || {};
    const from = HM.test(String(s.lunchBreakFrom || '')) ? String(s.lunchBreakFrom) : DEFAULTS.lunchBreakFrom;
    const len = Number(s.lunchBreakMin);
    return { on: s.lunchBreakOn !== false, from, lenMin: isFinite(len) && len > 0 ? Math.round(len) : DEFAULTS.lunchBreakMin };
  }
  // 'HH:MM' on the local date of dayMs, as ms
  function atLocal(dayMs, hm) {
    const m = HM.exec(String(hm || '')), d = new Date(dayMs);
    d.setHours(m ? Number(m[1]) : 12, m ? Number(m[2]) : 15, 0, 0);
    return d.getTime();
  }
  // "1 h" / "45 min" / "1 h 30 min"
  function lenLabel(min) {
    min = Math.round(Number(min) || 0);
    const h = Math.floor(min / 60), m = min % 60;
    return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
  }

  // ---------- today's state ----------
  const fresh = (date) => ({ date: date || null, startedAt: null, endedAt: null, skipped: false });
  // the stored state if it is for this date, else a fresh one (yesterday's break never carries over)
  function forDay(stored, date) {
    return stored && stored.date === date ? Object.assign(fresh(date), stored) : fresh(date);
  }
  const untilMs = (st, settings) => (st && st.startedAt != null ? st.startedAt + settingsOf(settings).lenMin * MIN : null);
  function phase(st, settings, nowMs) {
    st = st || {};
    if (st.startedAt != null) return st.endedAt != null || nowMs >= untilMs(st, settings) ? 'taken' : 'active';
    if (st.skipped) return 'skipped';
    return settingsOf(settings).on ? 'assumed' : 'off';
  }
  // the length elapsed without End break: endedAt = startedAt + length (else the same state back)
  function autoEnd(st, settings, nowMs) {
    if (!st || st.startedAt == null || st.endedAt != null) return st;
    const u = untilMs(st, settings);
    return nowMs >= u ? Object.assign({}, st, { endedAt: u }) : st;
  }
  // Start lunch break (once a day)
  function start(st, nowMs) {
    if (st && st.startedAt != null) return st;
    return Object.assign({}, st, { startedAt: nowMs, endedAt: null, skipped: false });
  }
  // End break: now, never after the length elapsed
  function end(st, settings, nowMs) {
    if (!st || st.startedAt == null || st.endedAt != null) return st;
    return Object.assign({}, st, { endedAt: Math.min(nowMs, untilMs(st, settings)) });
  }
  const skip = (st) => (st && st.startedAt != null ? st : Object.assign({}, st, { skipped: true }));
  const unskip = (st) => Object.assign({}, st, { skipped: false });

  // The Route-tab bar: {kind:'start', label} from "Available from" on while a stop is pending and the break is neither
  // taken nor skipped; {kind:'active', untilMs} during the break; {kind:'skipped'} after Skip today; else null.
  function bar(st, settings, nowMs, hasPending) {
    const ph = phase(st, settings, nowMs), cfg = settingsOf(settings);
    if (ph === 'active') return { kind: 'active', untilMs: untilMs(st, settings) };
    if (ph === 'skipped') return { kind: 'skipped' };
    if (ph === 'assumed' && hasPending && nowMs >= atLocal(nowMs, cfg.from)) return { kind: 'start', label: 'Start lunch break (' + lenLabel(cfg.lenMin) + ')' };
    return null;
  }

  // ---------- the break in the timeline ----------
  // timeline = a re-timed plan (Solver.retime output: stops with arriveAt / departAt / waitSec, departFromMs, endArrival,
  // model). Returns a NEW plan with the break applied (or the same plan when there is none):
  //   assumed: walking the pending stops in order, the first DEPARTURE at or after "Available from" (leaving the current
  //            point - the start of the route - or a pending stop) gets the break length; every later stop and the end
  //            arrival shift by it (an arriveAfter wait absorbs what it can; closed windows are re-checked). No departure
  //            at or after that time (the day finishes before it): nothing is added.
  //   active:  the next departure (from the current point, or from the stop you are on site at) is no earlier than
  //            startedAt + length; later stops follow.
  // LATE / violations are recomputed. plan.lunch = {kind, startMs, endMs, beforePlaceId} says where the break sits.
  function applyBreak(timeline, st, settings, nowMs) {
    if (timeline && timeline.lunch) { timeline = Object.assign({}, timeline); delete timeline.lunch; } // never a stale marker
    const ph = phase(st, settings, nowMs);
    if (!timeline || !timeline.model || !Array.isArray(timeline.stops) || (ph !== 'assumed' && ph !== 'active')) return timeline;
    const m = timeline.model, cfg = settingsOf(settings), lenMs = cfg.lenMin * MIN;
    const stops = timeline.stops.map((s) => Object.assign({}, s));
    const pend = [];
    stops.forEach((s, i) => { if (!s.status && s.arriveAt != null && s.departAt != null) pend.push(i); });
    if (!pend.length) return timeline;
    const depart0 = timeline.departFromMs != null ? timeline.departFromMs : m.t0ms;
    const onSite0 = stops[pend[0]].reachedAt != null;
    // departures in order: k = 0 is leaving the current point (only when not on site), k = j + 1 is leaving pend[j]
    let k = -1, breakStart = null, newDep = null;
    if (ph === 'assumed') {
      const fromMs = atLocal(nowMs, cfg.from);
      if (!onSite0 && depart0 >= fromMs) { k = 0; breakStart = depart0; }
      else {
        for (let j = 0; j < pend.length; j++) {
          const d = stops[pend[j]].departAt;
          if (d >= fromMs) { k = j + 1; breakStart = d; break; }
        }
      }
      if (k < 0) return timeline;
      newDep = breakStart + lenMs;
    } else {
      const until = untilMs(st, settings);
      breakStart = st.startedAt;
      k = onSite0 ? 1 : 0;
      const dep = onSite0 ? stops[pend[0]].departAt : depart0;
      newDep = Math.max(dep, until);
      if (onSite0) stops[pend[0]].departAt = Math.round(newDep); // on site during the break: you leave after it
    }
    let delta = k === 0 ? newDep - depart0 : newDep - (ph === 'assumed' ? breakStart : timeline.stops[pend[0]].departAt);
    for (let j = k; j < pend.length && delta > 0; j++) {
      const s = stops[pend[j]];
      if (s.reachedAt != null) continue; // a reached stop's arrival is a fact
      const arrive0 = s.arriveAt - (s.waitSec || 0) * 1000 + delta;
      let arrive = arrive0;
      const af = m.afterMs ? m.afterMs[s.placeId] : null;
      if (af != null && af > arrive) arrive = af;
      const wins = Solver.normWindows((m.closed || {})[s.placeId]);
      if (m.respectClosed && wins.length) arrive = Solver.pushPastClosed(wins, arrive);
      const dep = arrive + (s.departAt - s.arriveAt);
      delta = dep - s.departAt;
      s.arriveAt = Math.round(arrive); s.departAt = Math.round(dep);
      s.waitSec = Math.round((arrive - arrive0) / 1000);
      s.closedWarning = Solver.isClosedAt((m.closed || {})[s.placeId], s.arriveAt);
    }
    const endArrival = Math.round(timeline.endArrival + Math.max(0, delta));
    const out = Object.assign({}, timeline, { stops, endArrival, totalSec: Math.round((endArrival - m.t0ms) / 1000),
      lunch: { kind: ph, startMs: breakStart, endMs: newDep, beforePlaceId: k < pend.length ? stops[pend[k]].placeId : null } });
    Solver.markLate(out);
    return out;
  }

  return { DEFAULTS, settingsOf, atLocal, lenLabel, fresh, forDay, untilMs, phase, autoEnd, start, end, skip, unskip, bar, applyBreak };
});
