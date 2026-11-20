/* L-Tech Waypoint — daylog.js
 * End-of-day record + summary. Pure logic (no DOM, no network, no storage): the app owns I/O, this file owns the
 * data model and every number shown in the summary, so it can be unit tested and recomputed after an undo.
 *
 * One record per calendar day (Asia/Kuala_Lumpur, fixed UTC+8, no DST), keyed by the date the day STARTED:
 *   { schemaVersion, date, driverId, startedAt, endedAt, closed, planSnapshot, events[],
 *     jobsSnap{}, places{}, legs{}, routed, edits{}, decisions{}, carried[] }
 *   events: { t (ISO), type: plan|replan|done|undo|endday, jobId, stopId, lat, lng, accuracy, [kind, item, departAt, jobIds, of] }
 *   startedAt = depart time of the first plan; closedAt = when Close day was tapped (endedAt = same, kept for old records).
 *   Finished / Hours out come from the LAST DONE event (or edits.finishedAt), never from closedAt.
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
  const KL_MS = 8 * 3600e3; // Asia/Kuala_Lumpur is UTC+8 all year
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const REASONS = ['Closed', 'Item not ready', 'Ran out of time', 'Customer postponed', 'Other'];
  const CSV_HEADER = ['date', 'driver', 'type', 'item', 'from', 'to', 'done time', 'status', 'reason', 'urgent', 'late'];
  const SUFFIX_RE = /[\s,]+(?:sdn\.?\s*bhd\.?|s\/b\.?|bhd\.?)\s*$/i; // same display rule as the app's dName()
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const clean = (n) => { const s = String(n == null ? '' : n); const t = s.replace(SUFFIX_RE, '').trim(); return t || s; };

  // ---------- date / time (KL) ----------
  function klParts(ms) {
    const d = new Date(ms + KL_MS);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
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
  const dayStartMs = (key) => { const p = parseKey(key); return Date.UTC(p.y, p.m - 1, p.d) - KL_MS; };
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
  function recordDone(day, info) { // info: {nowIso, stopId, actions:[{jobId,kind,item}], places{}}
    snapPlace(day, info.places, info.stopId);
    return info.actions.map((a) => appendEvent(day, { t: info.nowIso, type: 'done', jobId: a.jobId || null, stopId: info.stopId, kind: a.kind, item: a.item || '' }));
  }
  function recordUndo(day, info) { // info: {nowIso, stopId}
    return appendEvent(day, { t: info.nowIso, type: 'undo', stopId: info.stopId });
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
    const startedAt = ms(day.edits.startedAt) != null ? ms(day.edits.startedAt) : (snap ? ms(snap.departAt || snap.t) : null);
    const finishedAt = ms(day.edits.finishedAt) != null ? ms(day.edits.finishedAt) : (isFinite(lastDone) ? lastDone : null);
    const hoursOutMin = startedAt != null && finishedAt != null ? Math.max(0, (finishedAt - startedAt) / 60000) : null;

    // ---- distance / drive time over: day start -> stops in the order DONE was tapped ----
    const doneSeq = [];
    groups.forEach((g) => { if (doneSeq.indexOf(g.stopId) < 0) doneSeq.push(g.stopId); });
    const pts = [];
    if (snap && snap.start) pts.push({ lat: snap.start.lat, lng: snap.start.lng });
    let pointsOk = !!(snap && snap.start);
    doneSeq.forEach((id) => { const p = placeOf(id); if (p) pts.push({ lat: p.lat, lng: p.lng }); else pointsOk = false; });
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
    const ranks = doneSeq.map((id) => order.indexOf(id));
    const inPlan = ranks.filter((r) => r >= 0);
    const outOfOrder = ranks.length - lis(inPlan);
    const firstPlanIdx = day.events.findIndex((e) => e.type === 'plan' || e.type === 'replan');
    const replans = day.events.filter((e, i) => e.type === 'replan' || (e.type === 'plan' && i !== firstPlanIdx)).length;

    return {
      date: day.date, driverId: day.driverId, closed: !!day.closed, closedAt: ms(day.closedAt != null ? day.closedAt : day.endedAt),
      jobsDone: rows.filter((r) => r.complete).length, jobsTotal: rows.length,
      stopsVisited: doneSeq.length, doneSeq,
      km, driveMin, hoursOutMin, atStopsMin, startedAt, finishedAt,
      startedSource: ms(day.edits.startedAt) != null ? 'edited' : snap ? 'first plan' : '—',
      collected, delivered, errands,
      stillWithYou: rows.filter((r) => r.withYou),
      notDone: rows.filter((r) => !r.complete),
      plan: { plannedKm: snap ? snap.plannedKm : null, plannedDriveMin: snap ? snap.plannedDriveMin : null, replans, outOfOrder, stopsDone: doneSeq.length, stopsPlanned: order.length },
      rows,
      route: { key, points: pts, needs: enough && pointsOk && (!mOk || !sOk) },
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
    return changed;
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
    newDay, appendEvent, recordPlan, recordReplan, recordDone, recordUndo, doneGroups, hasActiveDone,
    ptKey, legKey, seqKey, legFromMatrices, captureLeg, plannedFromMatrices,
    summarise, closeDay, reopenDay, pruneDates, weekRange, weekTotals, historyKeys, toCSV, csvCell, toWhatsApp,
  };
});
