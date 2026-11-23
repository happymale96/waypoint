/* L-Tech Waypoint — daylog.js
 * End-of-day record + summary. Pure logic (no DOM, no network, no storage): the app owns I/O, this file owns the
 * data model and every number shown in the summary, so it can be unit tested and recomputed after an undo.
 *
 * One record per calendar date, keyed by the DEVICE'S LOCAL date of the activity (never UTC, never the date End day
 * is tapped). A plan run is keyed by the local date it departed (plan.ctx.dayKey); its DONE / ARRIVED taps belong to
 * that run's record even past midnight. Activity on a date whose record is closed is merged into it (totals recomputed).
 * Record:
 *   { schemaVersion, date, driverId, startedAt, endedAt, closed, planSnapshot, events[],
 *     jobsSnap{}, places{}, legs{}, routed, edits{}, decisions{}, carried[] }
 *   events: { t (ISO), type: plan|replan|done|undo|arrived_end|endday, jobId, stopId, lat, lng, accuracy, [kind, item, departAt, jobIds, of] }
 *   startedAt = depart time of the first plan; closedAt = when Close day was tapped (endedAt = same, kept for old records).
 *   Finished / Hours out come from the arrived_end event if there is one, else the LAST DONE event (edits.finishedAt beats both),
 *   never from closedAt. arrived_end {endPoint:{lat,lng,name}} also adds a final leg (last done stop -> end point) to km / drive time;
 *   it never closes the day. An undo with of:'arrived_end' cancels the latest one.
 *   done events also carry reachedAt (ms | null), reachedSource ('tap' | 'auto' | null) and dwellMin (the planned dwell):
 *   summarise().visits lists them per done stop; reached.js turns that into the driving / on-site split.
 *   edits.startedAt / edits.finishedAt = user overrides (ISO) of Started / Finished.
 *   legs  = per-leg metres/seconds already held from routing responses: "lat,lng>lat,lng" -> {m, s}
 *   routed = result of the ONE routing request made at End Day: {key, legs:[{m,s}], at}
 * Exports via module.exports (node) or window.DayLog.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DayLog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 1;
  const KEEP_DAYS = 120;
  const REPAIR_VERSION = 2; // one-time history repair (see repairHistory / runRepairOnce)
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const REASONS = ['Closed', 'Item not ready', 'Ran out of time', 'Customer postponed', 'Other'];
  const CSV_HEADER = ['date', 'driver', 'type', 'item', 'from', 'to', 'done time', 'status', 'reason', 'urgent', 'late'];
  const SUFFIX_RE = /[\s,]+(?:sdn\.?\s*bhd\.?|s\/b\.?|bhd\.?)\s*$/i; // same display rule as the app's dName()
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const clean = (n) => { const s = String(n == null ? '' : n); const t = s.replace(SUFFIX_RE, '').trim(); return t || s; };

  // ---------- date / time (device local) ----------
  function klParts(ms) {
    const d = new Date(ms);
    return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  }
  const dateKey = (ms) => { const p = klParts(ms); return p.y + '-' + pad2(p.mo + 1) + '-' + pad2(p.d); };
  function parseKey(key) { const a = String(key).split('-').map(Number); return { y: a[0], m: a[1], d: a[2] }; }
  const keyDays = (key) => { const p = parseKey(key); return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000); };
  function addDaysKey(key, n) {
    const d = new Date((keyDays(key) + n) * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  const fmtDate = (key) => { const p = parseKey(key); return pad2(p.d) + ' ' + MON[p.m - 1] + ' ' + p.y; };
  const fmtTime = (ms) => { const p = klParts(ms); return pad2(p.h) + ':' + pad2(p.mi); };
  function fmtDur(min) {
    if (min == null || !isFinite(min)) return '—';
    min = Math.round(min);
    const h = Math.floor(min / 60), m = min % 60;
    return h ? h + ' h ' + pad2(m) + ' min' : m + ' min';
  }
  const fmtKm = (km) => (km == null ? '—' : km.toFixed(1) + ' km');
  const dayStartMs = (key) => { const p = parseKey(key); return new Date(p.y, p.m - 1, p.d).getTime(); }; // local midnight
  function hmToMin(hm) {
    if (!hm || typeof hm !== 'string') return null;
    const p = hm.split(':').map(Number);
    return isNaN(p[0]) ? null : p[0] * 60 + (p[1] || 0);
  }
  const ms = (iso) => (iso == null ? null : Date.parse(iso));

  // ---------- record ----------
  function newDay(o) {
    return {
      schemaVersion: SCHEMA, date: o.date, driverId: o.driverId || 'Calvin', startedAt: null, endedAt: null, closedAt: null, closed: false,
      planSnapshot: null, events: [], jobsSnap: {}, places: {}, legs: {}, routed: null, edits: {}, decisions: {}, carried: [],
    };
  }

  function appendEvent(day, ev) {
    const e = Object.assign({ t: new Date().toISOString(), type: '', jobId: null, stopId: null, lat: null, lng: null, accuracy: null }, ev);
    day.events.push(e);
    return e;
  }

  function snapJob(j) {
    return {
      id: j.id, kind: j.errandPlaceId ? 'errand' : 'delivery',
      pickups: (j.pickups || []).map((p) => ({ placeId: p.placeId, item: p.item || '', done: !!p.done })),
      deliveryPlaceId: j.deliveryPlaceId || null, errandPlaceId: j.errandPlaceId || null,
      inHandItem: j.inHandItem || '', urgent: !!j.urgent, arriveBefore: j.arriveBefore || null, notes: j.notes || '',
    };
  }
  function snapPlace(day, places, id) {
    const p = places && places[id];
    if (p) day.places[id] = { name: p.name, lat: p.lat, lng: p.lng };
  }

  // A PLAN or REPLAN happened. info: {nowIso, replan, start:{lat,lng}, departAtIso, jobs[], places{}, stopOrder[], plannedKm, plannedDriveMin}
  function recordPlan(day, info) {
    const first = !day.planSnapshot;
    (info.jobs || []).forEach((j) => { if (!day.jobsSnap[j.id]) day.jobsSnap[j.id] = snapJob(j); }); // first sight wins (prior-collected flags)
    const ids = new Set(info.stopOrder || []);
    (info.jobs || []).forEach((j) => {
      if (j.errandPlaceId) ids.add(j.errandPlaceId);
      if (j.deliveryPlaceId) ids.add(j.deliveryPlaceId);
      (j.pickups || []).forEach((p) => ids.add(p.placeId));
    });
    ids.forEach((id) => snapPlace(day, info.places, id));
    if (first) {
      day.planSnapshot = {
        t: info.nowIso, departAt: info.departAtIso || info.nowIso, start: info.start ? { lat: info.start.lat, lng: info.start.lng } : null,
        stopOrder: (info.stopOrder || []).slice(), jobCount: (info.jobs || []).length,
        plannedKm: info.plannedKm == null ? null : info.plannedKm, plannedDriveMin: info.plannedDriveMin == null ? null : info.plannedDriveMin,
      };
      day.startedAt = day.planSnapshot.departAt;
    }
    return appendEvent(day, {
      t: info.nowIso, type: first ? 'plan' : (info.replan ? 'replan' : 'plan'),
      departAt: info.departAtIso || info.nowIso, jobIds: (info.jobs || []).map((j) => j.id),
    });
  }

  // A replan that is not a fresh PLAN: "Avoid lunch" adopted, or the "No detour" re-solve. via = 'avoid-lunch' | 'no-detour'.
  function recordReplan(day, info) { // info: {nowIso, via}
    return appendEvent(day, { t: info.nowIso, type: 'replan', via: info.via || null });
  }

  // A DONE tap: one event per action at the stop, all sharing t (the fix, if any, is patched in later).
  // The stop's Reached state rides on every event of the tap, raw: reachedAt (ms | null), reachedSource ('tap' | 'auto' | null)
  // and the planned dwell in minutes (what daySplit estimates an arrival with).
  const reachedFields = (info) => ({
    reachedAt: info.reachedAt != null ? info.reachedAt : null, reachedSource: info.reachedAt != null ? (info.reachedSource || 'tap') : null,
    dwellMin: info.dwellMin != null ? info.dwellMin : null,
  });
  function recordDone(day, info) { // info: {nowIso, stopId, actions:[{jobId,kind,item}], places{}, reachedAt?, reachedSource?, dwellMin?}
    snapPlace(day, info.places, info.stopId);
    return info.actions.map((a) => appendEvent(day, Object.assign({ t: info.nowIso, type: 'done', jobId: a.jobId || null, stopId: info.stopId, kind: a.kind, item: a.item || '' }, reachedFields(info))));
  }
  // The fuel stop: recorded as a stop with its done time (kind 'fuel', no job). It is never a job: job counts ignore it and
  // closeDay never carries it forward. info: {nowIso, stopId, name, places{}}
  const FUEL_KIND = 'fuel';
  function recordFuel(day, info) {
    snapPlace(day, info.places, info.stopId);
    return appendEvent(day, Object.assign({ t: info.nowIso, type: 'done', jobId: null, stopId: info.stopId, kind: FUEL_KIND, item: info.name || '' }, reachedFields(info)));
  }
  const isFuelGroup = (g) => g.events.some((e) => e.kind === FUEL_KIND);
  function recordUndo(day, info) { // info: {nowIso, stopId}
    return appendEvent(day, { t: info.nowIso, type: 'undo', stopId: info.stopId });
  }

  // ARRIVED at the end point of the route. info: {nowIso, endPoint:{lat,lng,name}}. Never closes the day.
  function recordArrivedEnd(day, info) {
    return appendEvent(day, { t: info.nowIso, type: 'arrived_end', endPoint: info.endPoint ? { lat: info.endPoint.lat, lng: info.endPoint.lng, name: info.endPoint.name || '' } : null });
  }
  function recordUndoArrivedEnd(day, info) { return appendEvent(day, { t: info.nowIso, type: 'undo', of: 'arrived_end' }); }
  // the active (not undone) arrived_end event, or null
  function arrivedEnd(day) {
    let cur = null;
    (day.events || []).forEach((e) => {
      if (e.type === 'arrived_end') cur = e;
      else if (e.type === 'undo' && e.of === 'arrived_end') cur = null;
    });
    return cur;
  }

  // Groups of DONE events (one per tap), in tap order, after removing the ones an undo cancelled.
  function doneGroups(day) {
    const groups = [];
    (day.events || []).forEach((e) => {
      if (e.type === 'done') {
        const g = groups.find((x) => x.stopId === e.stopId && x.t === e.t);
        if (g) g.events.push(e); else groups.push({ stopId: e.stopId, t: e.t, tMs: ms(e.t), events: [e] });
      } else if (e.type === 'undo' && e.stopId) {
        for (let i = groups.length - 1; i >= 0; i--) if (groups[i].stopId === e.stopId) { groups.splice(i, 1); break; }
      }
    });
    return groups;
  }
  const hasActiveDone = (day, stopId, t) => doneGroups(day).some((g) => g.stopId === stopId && g.t === t);

  // ---------- legs / distance ----------
  const ptKey = (p) => Number(p.lat).toFixed(5) + ',' + Number(p.lng).toFixed(5);
  const legKey = (a, b) => ptKey(a) + '>' + ptKey(b);
  const seqKey = (pts) => pts.map(ptKey).join('|');

  // Metres/seconds for the exact pair (a,b) from routing matrices, if both points are in the matrices' point list.
  // matrices: [{departAt, m[][] seconds, d[][] metres?}], points in matrix index order. Nearest slice to atMs.
  function legFromMatrices(matrices, points, a, b, atMs) {
    if (!matrices || !matrices.length || !points) return null;
    const ia = points.findIndex((p) => ptKey(p) === ptKey(a)), ib = points.findIndex((p) => ptKey(p) === ptKey(b));
    if (ia < 0 || ib < 0) return null;
    if (ia === ib) return { m: 0, s: 0 };
    const ordered = matrices.slice().sort((x, y) => Math.abs(Date.parse(x.departAt) - atMs) - Math.abs(Date.parse(y.departAt) - atMs));
    let s = null, m = null;
    for (const sl of ordered) {
      if (s == null && sl.m && sl.m[ia] && sl.m[ia][ib] != null) s = sl.m[ia][ib];
      if (m == null && sl.d && sl.d[ia] && sl.d[ia][ib] != null) m = sl.d[ia][ib];
    }
    return s == null && m == null ? null : { m, s };
  }
  // keep the leg just driven (called at DONE, while the plan's matrices still cover it)
  function captureLeg(day, a, b, matrices, points, atMs) {
    if (!a || !b) return null;
    const leg = legFromMatrices(matrices, points, a, b, atMs);
    if (leg) day.legs[legKey(a, b)] = leg;
    return leg;
  }
  // planned km / drive minutes over start -> stops in order (null when the matrices hold no distances)
  function plannedFromMatrices(matrices, points, seq, atMs) {
    let m = 0, s = 0, mOk = true, sOk = true;
    for (let i = 0; i + 1 < seq.length; i++) {
      const l = legFromMatrices(matrices, points, seq[i], seq[i + 1], atMs);
      if (!l || l.m == null) mOk = false; else m += l.m;
      if (!l || l.s == null) sOk = false; else s += l.s;
    }
    return { plannedKm: mOk && seq.length > 1 ? m / 1000 : null, plannedDriveMin: sOk && seq.length > 1 ? s / 60 : null };
  }

  // ---------- summarise ----------
  function lis(a) { // length of the longest strictly increasing subsequence
    const best = [];
    for (let i = 0; i < a.length; i++) {
      best[i] = 1;
      for (let j = 0; j < i; j++) if (a[j] < a[i] && best[j] + 1 > best[i]) best[i] = best[j] + 1;
    }
    return best.reduce((x, y) => Math.max(x, y), 0);
  }

  function summarise(day, jobs, places) {
    const jobMap = {};
    (jobs || []).forEach((j) => { jobMap[j.id] = j; });
    const placeOf = (id) => (places && places[id]) || day.places[id] || null;
    const nameOf = (id) => (placeOf(id) ? clean(placeOf(id).name) : '(deleted place)');
    const groups = doneGroups(day);
    const active = [].concat(...groups.map((g) => g.events));
    const dayStart = dayStartMs(day.date);
    const snap = day.planSnapshot;

    // scope = every job planned that day (+ any job with a done event)
    const ids = Object.keys(day.jobsSnap);
    active.forEach((e) => { if (e.jobId && ids.indexOf(e.jobId) < 0) ids.push(e.jobId); });

    const rows = ids.map((id) => {
      const live = jobMap[id], sn = day.jobsSnap[id];
      const base = sn || (live ? snapJob(live) : { id, kind: 'delivery', pickups: [], deliveryPlaceId: null, errandPlaceId: null, inHandItem: '', urgent: false, arriveBefore: null, notes: '' });
      const evs = active.filter((e) => e.jobId === id);
      const pk = evs.filter((e) => e.kind === 'pickup'), dl = evs.filter((e) => e.kind === 'deliver'), er = evs.filter((e) => e.kind === 'errand');
      const prior = base.pickups.filter((p) => p.done).length, total = base.pickups.length;
      const collectedCount = prior + pk.length;
      const collectedAny = collectedCount > 0, collectedAll = total === 0 || collectedCount >= total;
      const isErrand = base.kind === 'errand' || !!base.errandPlaceId;
      const type = isErrand ? 'errand' : total === 0 ? 'in-hand' : base.deliveryPlaceId ? 'delivery' : 'collect';
      const complete = isErrand ? er.length > 0 : type === 'collect' ? collectedAll : dl.length > 0;
      const doneEv = isErrand ? er[er.length - 1] : type === 'collect' ? pk[pk.length - 1] : dl[dl.length - 1];
      const items = [];
      const add = (x) => { if (x && items.indexOf(x) < 0) items.push(x); };
      if (isErrand) add(base.notes || (er[0] && er[0].item) || 'Errand');
      else { base.pickups.forEach((p) => add(p.item)); add(base.inHandItem); pk.forEach((e) => add(e.item)); }
      const fromIds = [];
      base.pickups.forEach((p) => { if (fromIds.indexOf(p.placeId) < 0) fromIds.push(p.placeId); });
      pk.forEach((e) => { if (fromIds.indexOf(e.stopId) < 0) fromIds.push(e.stopId); });
      const toId = isErrand ? base.errandPlaceId : base.deliveryPlaceId;
      const dec = day.decisions[id] || {};
      const doneMs = doneEv ? ms(doneEv.t) : null;
      const winMin = hmToMin(base.arriveBefore);
      const late = !!(type !== 'errand' && dl.length && winMin != null && doneMs != null && Math.floor((doneMs - dayStart) / 60000) > winMin);
      const withYou = !complete && !isErrand && type !== 'collect' && (type === 'in-hand' || collectedAny);
      const carry = dec.carry !== false;
      return {
        jobId: id, type, item: items.join(', '), from: type === 'in-hand' ? 'in hand' : fromIds.map(nameOf).join(' + '), to: toId ? nameOf(toId) : '',
        fromIds, toId, doneMs, complete, withYou, collectedAll, collectedAny,
        urgent: live ? !!live.urgent : !!base.urgent, late, reason: dec.reason || '', carry,
        status: complete ? 'done' : withYou ? 'collected, not delivered' : 'not done',
        notes: (live && live.notes) || base.notes || '',
      };
    });

    const collected = [], delivered = [], errands = [];
    active.forEach((e) => {
      const row = rows.find((r) => r.jobId === e.jobId);
      const t = ms(e.t);
      if (e.kind === 'pickup') collected.push({ jobId: e.jobId, item: e.item || (row && row.item) || '', place: nameOf(e.stopId), t });
      else if (e.kind === 'deliver') delivered.push({ jobId: e.jobId, item: (row && row.item) || e.item || '', place: nameOf(e.stopId), t, urgent: !!(row && row.urgent), late: !!(row && row.late) });
      else if (e.kind === 'errand') errands.push({ jobId: e.jobId, item: (row && row.item) || e.item || 'Errand', place: nameOf(e.stopId), t });
    });

    // ---- time ----
    const lastDone = groups.reduce((acc, g) => Math.max(acc, g.tMs), -Infinity);
    // Started = first plan's depart, but never after the first DONE (a DONE can predate the first logged plan, e.g. backfilled)
    const firstDone = groups.reduce((acc, g) => Math.min(acc, g.tMs), Infinity);
    const planStart = snap ? ms(snap.departAt || snap.t) : null;
    const autoStart = planStart != null ? (isFinite(firstDone) ? Math.min(planStart, firstDone) : planStart) : null;
    const startedAt = ms(day.edits.startedAt) != null ? ms(day.edits.startedAt) : autoStart;
    const arrEv = arrivedEnd(day), arrivedAt = arrEv ? ms(arrEv.t) : null;
    const finishedAt = ms(day.edits.finishedAt) != null ? ms(day.edits.finishedAt) : arrivedAt != null ? arrivedAt : (isFinite(lastDone) ? lastDone : null);
    const hoursOutMin = startedAt != null && finishedAt != null ? Math.max(0, (finishedAt - startedAt) / 60000) : null;

    // ---- distance / drive time over: day start -> stops in the order DONE was tapped ----
    const doneSeq = [];
    groups.forEach((g) => { if (doneSeq.indexOf(g.stopId) < 0) doneSeq.push(g.stopId); });
    // the fuel stop is driven to (so it stays in the km chain) but is neither a job nor a planned stop
    const fuelIds = new Set(groups.filter(isFuelGroup).map((g) => g.stopId));
    const fuelGroup = groups.filter(isFuelGroup).pop() || null;
    const fuel = fuelGroup ? { place: (fuelGroup.events[0] && fuelGroup.events[0].item) || nameOf(fuelGroup.stopId), t: fuelGroup.tMs } : null;
    const visitSeq = doneSeq.filter((id) => !fuelIds.has(id));
    // The chain starts at the plan's start point only if that plan departed BEFORE the first visited stop; otherwise it
    // starts at the first visited stop (a plan that departed after the first DONE never drove a leg from its start).
    const pts = [];
    const planStartOk = !!(snap && snap.start);
    const useStart = planStartOk && (planStart == null || !isFinite(firstDone) || planStart < firstDone);
    if (useStart) pts.push({ lat: snap.start.lat, lng: snap.start.lng });
    let pointsOk = planStartOk;
    doneSeq.forEach((id) => { const p = placeOf(id); if (p) pts.push({ lat: p.lat, lng: p.lng }); else pointsOk = false; });
    if (arrEv && arrEv.endPoint && pointsOk && pts.length) pts.push({ lat: arrEv.endPoint.lat, lng: arrEv.endPoint.lng }); // final leg: last done stop -> end point
    const key = seqKey(pts);
    const routed = day.routed && day.routed.key === key ? day.routed.legs : null;
    let kmM = 0, driveS = 0, mOk = true, sOk = true;
    for (let i = 0; i + 1 < pts.length; i++) {
      const held = day.legs[legKey(pts[i], pts[i + 1])] || null;
      const r = routed && routed[i] ? routed[i] : null;
      const same = ptKey(pts[i]) === ptKey(pts[i + 1]);
      const m = same ? 0 : held && held.m != null ? held.m : r && r.m != null ? r.m : null;
      const s = same ? 0 : held && held.s != null ? held.s : r && r.s != null ? r.s : null;
      if (m == null) mOk = false; else kmM += m;
      if (s == null) sOk = false; else driveS += s;
    }
    const enough = pts.length > 1;
    const km = !enough && pointsOk ? { status: 'none', value: 0 } : (enough && pointsOk && mOk ? { status: 'ok', value: kmM / 1000 } : { status: 'unavailable', value: null });
    const driveMin = enough && pointsOk && sOk ? driveS / 60 : (!enough && pointsOk ? 0 : null);
    const atStopsMin = hoursOutMin != null && driveMin != null ? Math.max(0, hoursOutMin - driveMin) : null;

    // ---- plan vs actual ----
    const order = snap ? snap.stopOrder : [];
    const ranks = visitSeq.map((id) => order.indexOf(id));
    const inPlan = ranks.filter((r) => r >= 0);
    const outOfOrder = ranks.length - lis(inPlan);
    const firstPlanIdx = day.events.findIndex((e) => e.type === 'plan' || e.type === 'replan');
    const replans = day.events.filter((e, i) => e.type === 'replan' || (e.type === 'plan' && i !== firstPlanIdx)).length;

    // every done stop in tap order with its raw Reached data (Reached.splitOfSummary turns this into driving vs on site)
    const visits = groups.map((g) => {
      const e0 = g.events[0] || {};
      return { stopId: g.stopId, name: isFuelGroup(g) ? 'Fuel: ' + (e0.item || nameOf(g.stopId)) : nameOf(g.stopId), fuel: isFuelGroup(g), doneAt: g.tMs,
        reachedAt: e0.reachedAt != null ? e0.reachedAt : null, reachedSource: e0.reachedSource || null, dwellMin: e0.dwellMin != null ? e0.dwellMin : null };
    });

    return {
      visits,
      date: day.date, driverId: day.driverId, closed: !!day.closed, closedAt: ms(day.closedAt != null ? day.closedAt : day.endedAt),
      jobsDone: rows.filter((r) => r.complete).length, jobsTotal: rows.length,
      stopsVisited: visitSeq.length, doneSeq, fuel,
      km, driveMin, hoursOutMin, atStopsMin, startedAt, finishedAt, arrivedEndAt: arrivedAt,
      startedSource: ms(day.edits.startedAt) != null ? 'edited' : snap ? 'first plan' : '—',
      collected, delivered, errands,
      stillWithYou: rows.filter((r) => r.withYou),
      notDone: rows.filter((r) => !r.complete),
      plan: { plannedKm: snap ? snap.plannedKm : null, plannedDriveMin: snap ? snap.plannedDriveMin : null, replans, outOfOrder, stopsDone: visitSeq.length, stopsPlanned: order.length },
      rows,
      route: { key, points: pts, needs: enough && pointsOk && (!mOk || !sOk), startDropped: planStartOk && !useStart },
    };
  }

  // ---------- carry forward ----------
  // Close the day: write endday, set closed, apply carry-forward IN PLACE on the same jobs (no copies, so two closes
  // cannot duplicate anything). Returns the jobs that changed (to be saved). Closing a closed day does nothing.
  function closeDay(day, jobs, places, nowIso) {
    if (day.closed) return [];
    const sum = summarise(day, jobs, places);
    const byId = {}; (jobs || []).forEach((j) => { byId[j.id] = j; });
    const changed = [];
    day.carried = [];
    sum.notDone.forEach((r) => {
      const j = byId[r.jobId];
      if (!j) return;
      const before = { status: j.status || 'pending', pickups: JSON.parse(JSON.stringify(j.pickups || [])), inHandItem: j.inHandItem || '', carryReason: j.carryReason || '', carriedFrom: j.carriedFrom || '' };
      if (!r.carry) {
        j.status = 'dropped'; j.droppedOn = day.date; j.droppedReason = r.reason || '';
        day.carried.push({ jobId: j.id, mode: 'dropped', reason: r.reason, before });
      } else if (r.type === 'delivery' && r.collectedAll && j.deliveryPlaceId) {
        // collected but not delivered: tomorrow it is an in-hand deliver-only job (notes / urgent kept, reason attached)
        j.pickups = []; j.inHandItem = r.item; j.carryReason = r.reason || ''; j.carriedFrom = day.date;
        day.carried.push({ jobId: j.id, mode: 'inhand', reason: r.reason, before });
      } else {
        j.carryReason = r.reason || ''; j.carriedFrom = day.date;
        day.carried.push({ jobId: j.id, mode: 'keep', reason: r.reason, before });
      }
      changed.push(j);
    });
    appendEvent(day, { t: nowIso, type: 'endday' });
    day.closed = true; day.endedAt = nowIso; day.closedAt = nowIso;
    refreshTotals(day, jobs, places);
    return changed;
  }

  // ---------- which record: open day, merge, End day ----------
  // Stored totals of a record (written at close and again whenever activity is merged into a closed record).
  function refreshTotals(day, jobs, places) {
    const s = summarise(day, jobs, places);
    day.totals = {
      jobsDone: s.jobsDone, jobsTotal: s.jobsTotal, stopsVisited: s.stopsVisited,
      km: s.km.status === 'ok' ? s.km.value : s.km.status === 'none' ? 0 : null, hoursOutMin: s.hoursOutMin,
    };
    return day.totals;
  }
  // The record for a local date: the existing one (closed or not: activity is merged into it), else a new one.
  function recordFor(days, key, driverId) {
    if (!days[key]) days[key] = newDay({ date: key, driverId });
    return days[key];
  }
  // Local date a piece of activity belongs to: its plan run's date when it happened inside a run, else its own local date.
  const activityKey = (atMs, planDayKey) => planDayKey || dateKey(atMs);
  // Anything worth closing: a plan, an active DONE, or an active ARRIVED.
  const hasActivity = (day) => !!(day && (day.planSnapshot || doneGroups(day).length || arrivedEnd(day)));
  // 0 jobs, 0 stops, no km, no start time (the repair removes these; End day never creates one)
  function isEmptyRecord(day, jobs, places) {
    const s = summarise(day, jobs, places);
    return s.jobsTotal === 0 && s.stopsVisited === 0 && !(s.km.status === 'ok' && s.km.value > 0) && s.startedAt == null;
  }
  // The open day End day closes, whenever it is tapped: the current plan run's record if it is open, else the latest
  // unclosed record with activity. null = nothing to close.
  function openDayKey(days, planDayKey) {
    const open = (d) => d && !d.closed && hasActivity(d);
    if (planDayKey && open(days[planDayKey])) return planDayKey;
    const keys = Object.keys(days).filter((k) => open(days[k])).sort();
    return keys.length ? keys[keys.length - 1] : null;
  }
  // End day: close the open day (opts.key = a specific record, else openDayKey). Never creates a record.
  // Returns {key|null, changed jobs[]}. key null = nothing saved.
  function endDay(days, opts) {
    const key = opts.key ? (days[opts.key] && !days[opts.key].closed && hasActivity(days[opts.key]) ? opts.key : null) : openDayKey(days, opts.planDayKey);
    if (!key) return { key: null, changed: [] };
    return { key, changed: closeDay(days[key], opts.jobs, opts.places, opts.nowIso) };
  }

  // ---------- one-time repair of stored history ----------
  // 1) remove empty records (0 jobs, 0 stops, no km, no start time);
  // 2) backfill DONEs that never reached the day log (jobs marked done whose doneAt local date has a non-empty record,
  //    and which no record shows as complete) as events at their doneAt. Never removes events, never shrinks a record.
  // 3) drops the stored route of any day whose km chain starts at its first visited stop instead of the plan start.
  // Pure + idempotent: a second run finds nothing to do. Returns {removed:[keys], backfilled:{key:[jobIds]}, changed:[keys], routeDropped:[keys]}.
  function repairHistory(days, jobs, places) {
    const out = { removed: [], backfilled: {}, changed: [], routeDropped: [] };
    Object.keys(days).forEach((k) => { if (isEmptyRecord(days[k], jobs, places)) { delete days[k]; out.removed.push(k); } });
    const completeSomewhere = new Set();
    Object.values(days).forEach((d) => summarise(d, jobs, places).rows.forEach((r) => { if (r.complete) completeSomewhere.add(r.jobId); }));
    (jobs || []).forEach((j) => {
      if (j.status !== 'done' || !j.doneAt || completeSomewhere.has(j.id)) return;
      const t = ms(j.doneAt);
      if (t == null || isNaN(t)) return;
      const key = dateKey(t), day = days[key];
      if (!day) return; // never create a record from job data alone
      const iso = new Date(t).toISOString();
      const ev = (stopId, kind, item) => ({ t: iso, type: 'done', jobId: j.id, stopId, lat: null, lng: null, accuracy: null, kind, item: item || '', backfill: true });
      let evs = [];
      const pickupOnly = !j.errandPlaceId && !j.deliveryPlaceId;
      if (!day.jobsSnap[j.id]) {
        const sn = snapJob(j);
        if (pickupOnly) sn.pickups.forEach((p) => { p.done = false; }); // its pickups ARE the job: count them as done that day
        day.jobsSnap[j.id] = sn;
      }
      if (j.errandPlaceId) evs = [ev(j.errandPlaceId, 'errand', j.notes || 'Errand')];
      else if (j.deliveryPlaceId) evs = [ev(j.deliveryPlaceId, 'deliver', '')];
      else {
        const logged = day.events.filter((e) => e.type === 'done' && e.jobId === j.id && e.kind === 'pickup').map((e) => e.stopId);
        evs = (j.pickups || []).filter((p) => logged.indexOf(p.placeId) < 0).map((p) => ev(p.placeId, 'pickup', p.item));
      }
      evs.forEach((e) => {
        snapPlace(day, places, e.stopId);
        const at = day.events.findIndex((x) => ms(x.t) > t); // chronological: the driven order stays the tap order
        if (at < 0) day.events.push(e); else day.events.splice(at, 0, e);
      });
      if (!evs.length) return;
      (out.backfilled[key] = out.backfilled[key] || []).push(j.id);
      if (out.changed.indexOf(key) < 0) out.changed.push(key);
    });
    // 3) km chain rule: a day whose chain no longer starts at the plan's start point (the plan departed after the first
    //    DONE) loses its stored route, so km is recomputed (tap-to-retry) instead of keeping the never-driven first leg.
    Object.keys(days).forEach((k) => {
      const d = days[k];
      if (!d.routed || !summarise(d, jobs, places).route.startDropped) return;
      d.routed = null;
      out.routeDropped.push(k);
      if (out.changed.indexOf(k) < 0) out.changed.push(k);
    });
    out.changed.forEach((k) => { if (days[k].closed) refreshTotals(days[k], jobs, places); });
    return out;
  }
  // Runs the repair once per REPAIR_VERSION over a WPStore-like store ({get,set,list,remove}). Before changing anything
  // it copies the whole stored history to backup:daylogs-repair-<v>. Returns the repair result, or null if already done.
  async function runRepairOnce(store, jobs, places, nowIso) {
    const flag = await store.get('meta', 'daylogRepair');
    if (flag && flag.version >= REPAIR_VERSION) return null;
    const list = (await store.list('daylogs')).filter((d) => d && d.date && Array.isArray(d.events));
    const days = {};
    list.forEach((d) => { days[d.date] = d; });
    const fixed = JSON.parse(JSON.stringify(days)); // the repair works on a copy; storage is untouched until the backup exists
    const res = repairHistory(fixed, jobs, places);
    if (res.removed.length || res.changed.length) {
      const bk = 'daylogs-repair-' + REPAIR_VERSION;
      if (!(await store.get('backup', bk))) await store.set('backup', bk, { at: nowIso, days: list });
      for (const k of res.changed) await store.set('daylogs', k, fixed[k]);
      for (const k of res.removed) await store.remove('daylogs', k);
    }
    await store.set('meta', 'daylogRepair', { version: REPAIR_VERSION, at: nowIso, removed: res.removed, backfilled: res.backfilled });
    return res;
  }

  // ---------- Export / Import JSON (day log + day history) ----------
  // dayLog = the full records (everything the summary is computed from); dayHistory = their per-day totals.
  function exportPayload(days, jobs, places) {
    const recs = Object.keys(days).sort().map((k) => days[k]);
    return {
      dayLog: JSON.parse(JSON.stringify(recs)),
      dayHistory: recs.map((d) => { const s = summarise(d, jobs, places); return { date: d.date, closed: !!d.closed, jobsDone: s.jobsDone, jobsTotal: s.jobsTotal, stopsVisited: s.stopsVisited, km: s.km.status === 'ok' ? s.km.value : s.km.status === 'none' ? 0 : null, hoursOutMin: s.hoursOutMin }; }),
    };
  }
  // -> {present:false} for an export made before day logs were exported (keep the current ones), else
  //    {present:true, records:[valid records]} (dayHistory is derived from the records, so it comes back with them).
  function importPayload(data) {
    if (!data || !Array.isArray(data.dayLog)) return { present: false, records: [] };
    const records = data.dayLog.filter((d) => d && typeof d.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(d.date) && Array.isArray(d.events))
      .map((d) => Object.assign(newDay({ date: d.date, driverId: d.driverId }), d));
    return { present: true, records };
  }

  // Undo the close: restore every carried / dropped job, reopen the day.
  function reopenDay(day, jobs, nowIso) {
    if (!day.closed) return [];
    const byId = {}; (jobs || []).forEach((j) => { byId[j.id] = j; });
    const changed = [];
    (day.carried || []).forEach((c) => {
      const j = byId[c.jobId];
      if (!j) return;
      j.status = c.before.status; j.pickups = c.before.pickups; j.inHandItem = c.before.inHandItem;
      delete j.droppedOn; delete j.droppedReason;
      if (c.before.carryReason) j.carryReason = c.before.carryReason; else delete j.carryReason;
      if (c.before.carriedFrom) j.carriedFrom = c.before.carriedFrom; else delete j.carriedFrom;
      changed.push(j);
    });
    day.carried = [];
    day.closed = false; day.endedAt = null; day.closedAt = null;
    appendEvent(day, { t: nowIso, type: 'undo', of: 'endday' });
    return changed;
  }

  // ---------- retention / history ----------
  const ageDays = (key, todayKey) => keyDays(todayKey) - keyDays(key);
  // keys of records to delete: keep today + the 119 days before it (120 days), prune everything older
  const pruneDates = (keys, todayKey, keep) => keys.filter((k) => ageDays(k, todayKey) >= (keep || KEEP_DAYS));
  function weekRange(todayKey) { // Monday..Sunday containing todayKey
    const dow = (new Date(keyDays(todayKey) * 86400000).getUTCDay() + 6) % 7; // Mon = 0
    const from = addDaysKey(todayKey, -dow);
    return { from, to: addDaysKey(from, 6) };
  }
  // rows: [{date, jobsDone, jobsTotal, km (number|null), hoursOutMin (number|null)}]
  function weekTotals(rows, todayKey) {
    const w = weekRange(todayKey);
    const mine = rows.filter((r) => r.date >= w.from && r.date <= w.to);
    return {
      from: w.from, to: w.to, days: mine.length,
      jobsDone: mine.reduce((a, r) => a + (r.jobsDone || 0), 0), jobsTotal: mine.reduce((a, r) => a + (r.jobsTotal || 0), 0),
      km: mine.reduce((a, r) => a + (r.km || 0), 0), hoursOutMin: mine.reduce((a, r) => a + (r.hoursOutMin || 0), 0),
      kmMissing: mine.filter((r) => r.km == null).length,
    };
  }
  const historyKeys = (keys, todayKey, n) => keys.filter((k) => { const a = ageDays(k, todayKey); return a >= 0 && a < (n || 30); }).sort().reverse();

  // ---------- export ----------
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(sum) { // one row per job
    const lines = [CSV_HEADER.join(',')];
    sum.rows.forEach((r) => {
      const status = r.complete ? 'done' : r.status + (r.carry ? ' - carried' : ' - dropped');
      lines.push([fmtDate(sum.date), sum.driverId, r.type, r.item, r.from, r.to, r.doneMs != null ? fmtTime(r.doneMs) : '', status, r.reason, r.urgent ? 'yes' : 'no', r.late ? 'yes' : 'no'].map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  function toWhatsApp(sum) {
    const L = [];
    const t = (x) => fmtTime(x);
    L.push('*Waypoint day summary - ' + fmtDate(sum.date) + '*', 'Driver: ' + sum.driverId, '');
    L.push('*Totals*', 'Jobs done: ' + sum.jobsDone + ' of ' + sum.jobsTotal, 'Stops visited: ' + sum.stopsVisited);
    L.push('Est. km (road route between stops, not odometer): ' + (sum.km.status === 'ok' ? sum.km.value.toFixed(1) : sum.km.status === 'none' ? '0.0' : 'unavailable'));
    L.push('Hours out: ' + (sum.hoursOutMin == null ? '—' : fmtDur(sum.hoursOutMin)) + (sum.startedAt != null && sum.finishedAt != null ? ' (' + t(sum.startedAt) + '-' + t(sum.finishedAt) + ')' : ''));
    L.push('Drive (est.): ' + fmtDur(sum.driveMin) + ' | At stops/other: ' + fmtDur(sum.atStopsMin));
    if (sum.fuel) L.push('Fuel: ' + sum.fuel.place + ' ' + t(sum.fuel.t));
    const sec = (title, lines) => { if (lines.length) L.push('', '*' + title + '*', ...lines); };
    sec('Collected', sum.collected.map((c) => '- ' + t(c.t) + ' ' + c.item + ' - ' + c.place));
    sec('Delivered', sum.delivered.map((d) => '- ' + t(d.t) + ' ' + d.item + ' - ' + d.place + (d.urgent ? ' [URGENT]' : '') + (d.late ? ' [LATE]' : '')));
    sec('Errands done', sum.errands.map((e) => '- ' + t(e.t) + ' ' + e.item + ' - ' + e.place));
    sec('Still with me', sum.stillWithYou.map((r) => '- ' + r.item + ' -> ' + r.to));
    sec('Not done', sum.notDone.map((r) => '- ' + (r.item || r.type) + (r.to ? ' -> ' + r.to : '') + (r.urgent ? ' [URGENT]' : '') + (r.reason ? ' (' + r.reason + ')' : '') + (r.carry ? ' [carried to tomorrow]' : ' [dropped]')));
    return L.join('\n');
  }

  return {
    SCHEMA, KEEP_DAYS, REASONS, CSV_HEADER,
    dateKey, fmtDate, fmtTime, fmtDur, fmtKm, addDaysKey, dayStartMs, ageDays,
    newDay, appendEvent, recordPlan, recordReplan, recordDone, recordFuel, recordUndo, recordArrivedEnd, recordUndoArrivedEnd, arrivedEnd, doneGroups, hasActiveDone,
    ptKey, legKey, seqKey, legFromMatrices, captureLeg, plannedFromMatrices,
    summarise, closeDay, reopenDay, refreshTotals, recordFor, activityKey, hasActivity, isEmptyRecord, openDayKey, endDay,
    REPAIR_VERSION, repairHistory, runRepairOnce, exportPayload, importPayload, pruneDates, weekRange, weekTotals, historyKeys, toCSV, csvCell, toWhatsApp,
  };
});
