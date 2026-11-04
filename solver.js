/* L-Tech Waypoint — solver.js
 * Pure logic, no DOM, no network. Exports via module.exports (node) or window.Solver.
 *
 * Matrix indexing convention (shared with providers.js): points = Solver.pointsFor(input)
 *   index 0            = start
 *   index 1..k         = stops, in the order of Solver.buildStops(jobs, places).stopIds
 *   index k+1          = end
 * matrices: [{departAt: ISO, m: [[sec]]}]  (m[i][j] = seconds from point i to point j)
 *
 * Time model: legs depart at a predicted time; the slice whose departAt is nearest to
 * that time is used. Service at a stop = arrive (waiting for arriveAfter if early) + dwell.
 * Output times (arriveAt / departAt / endArrival) are epoch milliseconds.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Solver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_STOPS = 12;
  const TOP_N = 5;
  const BIG = 3 * 86400;        // seconds, used for missing/failed matrix cells
  const LATE_W = 1e7;           // soft mode: lateness dominates total time
  const DEFAULT_DWELL = { factory: 20, supplier: 5, other: 10, office: 10, home: 0 };

  // ---------- small helpers ----------
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  function formatETA(ms) {
    const d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (h === 0) return m + ' min';
    return h + ' h ' + pad2(m === 60 ? 59 : m) + ' min';
  }
  function hmToSec(hm) {
    if (!hm || typeof hm !== 'string') return null;
    const p = hm.split(':');
    const h = Number(p[0]), m = Number(p[1] || 0);
    if (!isFinite(h) || !isFinite(m)) return null;
    return h * 3600 + m * 60;
  }
  const isPending = (j) => !j.status || j.status === 'pending';
  const isErrand = (j) => !!j.errandPlaceId;

  // ---------- stop set ----------
  // One visit per distinct place; merges all pickups / deliveries / errands at that place.
  function buildStops(jobs, places) {
    const order = [];
    const map = {};
    const get = (pid) => {
      if (!map[pid]) {
        map[pid] = { placeId: pid, pickups: [], deliveries: [], errands: [], errandDwell: null };
        order.push(pid);
      }
      return map[pid];
    };
    const active = (jobs || []).filter(isPending);
    active.forEach((j) => {
      if (isErrand(j)) {
        const s = get(j.errandPlaceId);
        s.errands.push({ jobId: j.id, kind: 'errand', item: j.notes || 'Errand' });
        if (j.dwellMin != null && j.dwellMin !== '') {
          s.errandDwell = Math.max(s.errandDwell || 0, Number(j.dwellMin));
        }
        return;
      }
      const pk = j.pickups || [];
      const items = pk.map((p) => p.item).filter(Boolean).join(', ');
      pk.filter((p) => !p.done).forEach((p) =>
        get(p.placeId).pickups.push({ jobId: j.id, kind: 'pickup', item: p.item || '' }));
      if (j.deliveryPlaceId) {
        get(j.deliveryPlaceId).deliveries.push({ jobId: j.id, kind: 'deliver', item: items });
      }
    });
    return { stopIds: order, stops: map, jobs: active };
  }

  function pointsFor(input) {
    const bs = buildStops(input.jobs, input.places);
    const pts = [{ lat: input.start.lat, lng: input.start.lng }];
    bs.stopIds.forEach((pid) => {
      const p = input.places[pid];
      pts.push({ lat: p.lat, lng: p.lng });
    });
    pts.push({ lat: input.end.lat, lng: input.end.lng });
    return pts;
  }

  // ---------- preparation ----------
  function prepare(input) {
    const places = input.places || {};
    const bs = buildStops(input.jobs, places);
    const k = bs.stopIds.length;
    const N = k + 2;
    const idx = {};
    bs.stopIds.forEach((p, i) => { idx[p] = i; });
    bs.stopIds.forEach((pid) => {
      if (!places[pid]) throw new Error('A job refers to a place that no longer exists (' + pid + ').');
    });
    const matrices = input.matrices || [];
    if (!matrices.length) throw new Error('No travel-time matrices supplied.');
    const t0ms = input.departAtISO ? Date.parse(input.departAtISO) : Date.now();
    const dayStart = new Date(t0ms);
    dayStart.setHours(0, 0, 0, 0);
    const dayRel = (hm) => {
      const s = hmToSec(hm);
      return s == null ? null : (dayStart.getTime() + s * 1000 - t0ms) / 1000;
    };

    const slices = matrices.map((s) => {
      if (!s.m || s.m.length < N) throw new Error('Matrix is smaller than the number of points (' + N + ').');
      const f = new Float64Array(N * N);
      for (let a = 0; a < N; a++) {
        for (let b = 0; b < N; b++) {
          if (a === b) { f[a * N + b] = 0; continue; }
          const v = s.m[a][b];
          f[a * N + b] = (v == null || !isFinite(v) || v < 0) ? BIG : v;
        }
      }
      return { off: (Date.parse(s.departAt) - t0ms) / 1000, f };
    });

    const jobById = {};
    bs.jobs.forEach((j) => { jobById[j.id] = j; });

    // per-stop facts
    const dwell = new Float64Array(k);
    const before = new Float64Array(k).fill(Infinity);
    const after = new Float64Array(k).fill(-Infinity);
    const targets = [];            // per stop: [{jobId, before, after}] for violation text
    const urgentDel = new Array(k).fill(false);
    const nonUrgentDel = new Array(k).fill(false);
    const urgentAction = new Array(k).fill(false);
    const rankKey = new Array(k).fill(Infinity);

    bs.stopIds.forEach((pid, i) => {
      const s = bs.stops[pid];
      const pl = places[pid];
      const placeDwell = (pl.dwellMin != null ? Number(pl.dwellMin) : (DEFAULT_DWELL[pl.type] != null ? DEFAULT_DWELL[pl.type] : 10)) * 60;
      const hasOther = s.pickups.length + s.deliveries.length > 0;
      if (s.errandDwell != null) {
        dwell[i] = hasOther ? Math.max(placeDwell, s.errandDwell * 60) : s.errandDwell * 60;
      } else dwell[i] = placeDwell;

      targets[i] = [];
      const addTarget = (a) => {
        const j = jobById[a.jobId];
        const b = dayRel(j.arriveBefore), af = dayRel(j.arriveAfter);
        if (b != null) before[i] = Math.min(before[i], b);
        if (af != null) after[i] = Math.max(after[i], af);
        if (b != null || af != null) targets[i].push({ jobId: j.id, before: b, after: af, label: a.item || j.notes || '' });
      };
      s.deliveries.forEach((a) => {
        addTarget(a);
        const j = jobById[a.jobId];
        if (j.urgent) { urgentDel[i] = true; urgentAction[i] = true; rankKey[i] = Math.min(rankKey[i], j.urgentRank != null ? j.urgentRank : 0); }
        else nonUrgentDel[i] = true;
      });
      s.errands.forEach((a) => { addTarget(a); if (jobById[a.jobId].urgent) urgentAction[i] = true; });
      s.pickups.forEach((a) => {
        const j = jobById[a.jobId];
        if (j.urgent) urgentAction[i] = true;
        if (!j.deliveryPlaceId && !isErrand(j)) addTarget(a); // pickup-only job: window applies to pickup
      });
    });

    // static prerequisites (bitmasks over stop indices)
    let urgentDelMask = 0;
    for (let i = 0; i < k; i++) if (urgentDel[i]) urgentDelMask |= (1 << i);
    const pre = new Array(k).fill(0);
    const noDetour = !!input.noDetour;
    for (let i = 0; i < k; i++) {
      const s = bs.stops[bs.stopIds[i]];
      // (1) every pickup of a job precedes that job's delivery
      s.deliveries.forEach((d) => {
        const j = jobById[d.jobId];
        (j.pickups || []).filter((p) => !p.done).forEach((p) => {
          const q = idx[p.placeId];
          if (q !== i && q != null) pre[i] |= (1 << q);
        });
      });
      // (2) urgent deliveries before non-urgent deliveries
      if (nonUrgentDel[i]) pre[i] |= urgentDelMask & ~(1 << i);
      // (2b) urgentRank order among urgent deliveries (stop key = lowest rank delivered there)
      if (urgentDel[i]) {
        for (let o = 0; o < k; o++) if (o !== i && urgentDel[o] && rankKey[o] < rankKey[i]) pre[i] |= (1 << o);
      }
      // (3) noDetour: stops with no urgent-job action wait for all urgent deliveries
      if (noDetour && !urgentAction[i]) pre[i] |= urgentDelMask & ~(1 << i);
    }

    // admissible bound pieces
    const minIn = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      let mn = Infinity;
      const p = i + 1;
      for (let a = 0; a <= k; a++) {
        if (a === p) continue;
        for (let s = 0; s < slices.length; s++) mn = Math.min(mn, slices[s].f[a * N + p]);
      }
      minIn[i] = mn;
    }
    let minInEnd = Infinity;
    for (let a = 0; a <= k; a++) for (let s = 0; s < slices.length; s++) minInEnd = Math.min(minInEnd, slices[s].f[a * N + (k + 1)]);

    const ctx = {
      input, places, bs, k, N, idx, t0ms, dayStart, slices, jobById,
      dwell, before, after, targets, urgentDel, urgentAction, pre, minIn, minInEnd, urgentDelMask,
    };
    ctx.leg = function (a, b, t) {
      let best = 0, bd = Infinity;
      for (let s = 0; s < slices.length; s++) {
        const d = Math.abs(slices[s].off - t);
        if (d < bd) { bd = d; best = s; }
      }
      return slices[best].f[a * N + b];
    };
    return ctx;
  }

  // ---------- search ----------
  function search(c, soft, deadline) {
    const { k, N, pre, dwell, before, after, minIn, minInEnd } = c;
    const top = [];
    let nodes = 0, timedOut = false;
    const path = new Int8Array(k);
    const rem = new Float64Array(k);
    let remAll = 0;
    for (let i = 0; i < k; i++) { rem[i] = dwell[i] + minIn[i]; remAll += rem[i]; }
    const memo = soft ? null : new Float64Array((1 << k) * k * TOP_N).fill(Infinity);
    const full = (1 << k) - 1;

    function offer(score, depth) {
      if (top.length === TOP_N && score >= top[TOP_N - 1].score) return;
      const entry = { score, order: Array.prototype.slice.call(path, 0, depth) };
      let p = top.length;
      while (p > 0 && top[p - 1].score > score) p--;
      top.splice(p, 0, entry);
      if (top.length > TOP_N) top.pop();
    }

    function dfs(depth, last, t, mask, remSum, late) {
      if (timedOut) return;
      if ((++nodes & 2047) === 0 && Date.now() > deadline) { timedOut = true; return; }
      if (mask === full) {
        const e = t + c.leg(last, k + 1, t);
        offer(late * LATE_W + e, depth);
        return;
      }
      const ci = [], cl = [];
      for (let i = 0; i < k; i++) {
        if (mask & (1 << i)) continue;
        if (pre[i] & ~mask) continue;
        const l = c.leg(last, i + 1, t);
        // insertion sort by leg time (nearest first finds a good incumbent early)
        let p = cl.length;
        while (p > 0 && cl[p - 1] > l) p--;
        cl.splice(p, 0, l); ci.splice(p, 0, i);
      }
      for (let n = 0; n < ci.length; n++) {
        const i = ci[n];
        let arrive = t + cl[n];
        if (after[i] > arrive) arrive = after[i];
        let nl = late;
        if (arrive > before[i] + 0.0001) {
          if (!soft) continue;
          nl += arrive - before[i];
        }
        const dep = arrive + dwell[i];
        const nrem = remSum - rem[i];
        const lb = nl * LATE_W + dep + nrem + minInEnd;
        if (top.length === TOP_N && lb >= top[TOP_N - 1].score) continue;
        if (memo) {
          // keep the TOP_N best departure times per (visited set, last stop); exact under FIFO legs
          const base = ((mask | (1 << i)) * k + i) * TOP_N;
          if (dep >= memo[base + TOP_N - 1]) continue;
          let q = TOP_N - 1;
          while (q > 0 && memo[base + q - 1] > dep) { memo[base + q] = memo[base + q - 1]; q--; }
          memo[base + q] = dep;
        }
        path[depth] = i;
        dfs(depth + 1, i + 1, dep, mask | (1 << i), nrem, nl);
        if (timedOut) return;
      }
    }

    dfs(0, 0, 0, 0, remAll, 0);
    return { top, nodes, timedOut };
  }

  // ---------- plan building ----------
  function buildPlan(c, order) {
    const { k, bs, places, t0ms } = c;
    let t = 0, last = 0, late = 0;
    const stops = [];
    const violations = [];
    const lastUrgentPos = order.reduce((acc, i, pos) => (c.urgentDel[i] ? pos : acc), -1);
    order.forEach((i, pos) => {
      const pid = bs.stopIds[i];
      const s = bs.stops[pid];
      const arrive0 = t + c.leg(last, i + 1, t);
      let arrive = arrive0;
      if (c.after[i] > arrive) arrive = c.after[i];
      c.targets[i].forEach((tg) => {
        if (tg.before != null && arrive > tg.before + 0.0001) {
          late += arrive - tg.before;
          violations.push('Arrive-before missed at ' + places[pid].name + ': arrives ' +
            formatETA(t0ms + arrive * 1000) + ', must be before ' + formatETAfromRel(c, tg.before) +
            ' (job ' + tg.jobId + ')');
        }
      });
      const dep = arrive + c.dwell[i];
      const pl = places[pid];
      const arriveAt = t0ms + Math.round(arrive * 1000);
      const sod = secOfDay(arriveAt);
      const closed = (pl.closedWindows || []).some((w) => {
        const f = hmToSec(w.from), to = hmToSec(w.to);
        return f != null && to != null && sod >= f && sod < to;
      });
      stops.push({
        placeId: pid,
        arriveAt,
        departAt: t0ms + Math.round(dep * 1000),
        waitSec: Math.round(arrive - arrive0),
        actions: [].concat(s.deliveries, s.errands, s.pickups).map((a) => ({ jobId: a.jobId, kind: a.kind, item: a.item })),
        detour: !c.urgentAction[i] && pos < lastUrgentPos,
        closedWarning: closed,
      });
      t = dep; last = i + 1;
    });
    const e = t + c.leg(last, k + 1, t);
    return {
      order: order.map((i) => bs.stopIds[i]),
      stops,
      totalSec: Math.round(e),
      endArrival: t0ms + Math.round(e * 1000),
      violations,
      lateSec: Math.round(late),
    };
  }
  function secOfDay(ms) {
    const d = new Date(ms);
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  function formatETAfromRel(c, rel) { return formatETA(c.t0ms + rel * 1000); }

  // ---------- public ----------
  function solve(input, opts) {
    opts = opts || {};
    const started = Date.now();
    const bs = buildStops(input.jobs, input.places);
    if (bs.stopIds.length > MAX_STOPS) {
      return {
        plans: [], stopIds: bs.stopIds,
        error: 'Too many stops: ' + bs.stopIds.length + ' distinct places (max ' + MAX_STOPS +
          '). Park some jobs or merge deliveries to the same place.',
      };
    }
    let c;
    try { c = prepare(input); } catch (e) { return { plans: [], stopIds: bs.stopIds, error: e.message }; }
    if (c.k === 0) {
      const p = buildPlan(c, []);
      return { plans: [p], stopIds: [], error: null, stats: { nodes: 0, ms: 0, mode: 'strict', truncated: false } };
    }
    const limit = opts.timeLimitMs != null ? opts.timeLimitMs : 1800;
    let r = search(c, false, started + limit);
    let mode = 'strict';
    if (!r.top.length) {
      r = search(c, true, Date.now() + limit);
      mode = 'soft';
    }
    if (!r.top.length) {
      return {
        plans: [], stopIds: bs.stopIds,
        error: 'No order satisfies the pickup / urgent rules (they contradict each other). Un-flag an urgent job or park one.',
      };
    }
    const plans = r.top.map((x) => buildPlan(c, x.order));
    return {
      plans, stopIds: bs.stopIds, error: null,
      stats: { nodes: r.nodes, ms: Date.now() - started, mode, truncated: r.timedOut },
    };
  }

  // Evaluate one explicit order of placeIds (used by tests and "what-if"); does not check precedence.
  function evaluate(input, orderPlaceIds) {
    const c = prepare(input);
    return buildPlan(c, orderPlaceIds.map((p) => c.idx[p]));
  }

  return { solve, evaluate, buildStops, pointsFor, formatETA, formatDuration, hmToSec, MAX_STOPS, DEFAULT_DWELL };
});
