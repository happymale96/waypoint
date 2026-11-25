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
  const DEFAULT_DWELL = { factory: 30, supplier: 10, other: 10, office: 10, home: 0 };

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

  // ---------- First stop and the second visit ----------
  // A job (or errand) with firstStop = true pins its first stop: the errand place, its FIRST pickup, or its delivery when it is
  // deliver-only. That place is the first visit after the start (hard; it beats urgent). A first pickup already collected = the
  // first stop was made: no further effect. At that place everything that can be done on arrival is done in the first visit; a
  // delivery there whose item is collected elsewhere today becomes a SECOND visit, a separate stop keyed '<placeId>#2' at the same
  // coordinates (VISIT2). A job copy may carry visit2 = placeId: its delivery there belongs to a second visit already in the plan,
  // so with no First stop at that place the whole (single, merged) visit keeps the '#2' key through a re-solve.
  const VISIT2 = '#2';
  const baseId = (key) => (typeof key === 'string' && key.length > VISIT2.length && key.slice(-VISIT2.length) === VISIT2 ? key.slice(0, -VISIT2.length) : key);
  const isVisit2 = (key) => baseId(key) !== key;
  const placeOf = (places, key) => (places && (places[key] || places[baseId(key)])) || null;
  function firstStopPlace(j) {
    if (!j || !j.firstStop || !isPending(j)) return null;
    if (isErrand(j)) return j.errandPlaceId;
    const pk = j.pickups || [];
    if (pk.length) return pk[0].done ? null : pk[0].placeId;
    return j.deliveryPlaceId || null;
  }

  // ---------- stop set ----------
  // One visit per distinct place; merges all pickups / deliveries / errands at that place (the First stop's place may get a
  // second visit, see above). stops[key].placeId = the saved place; first = the key of the First stop visit (or null).
  function buildStops(jobs, places) {
    const order = [];
    const map = {};
    const active = (jobs || []).filter(isPending);
    let first = null;
    active.some((j) => { first = firstStopPlace(j); return first != null; });
    const alias = {};
    active.forEach((j) => { if (j.visit2 && j.visit2 !== first) alias[j.visit2] = j.visit2 + VISIT2; });
    const keyOf = (pid) => (pid === first ? pid : alias[pid] || pid);
    const entry = {}; // jobId -> the stop key of "this entry's stop" (the After rule): its delivery, else its last pending pickup, else the errand
    const get = (key) => {
      if (!map[key]) {
        map[key] = { placeId: baseId(key), pickups: [], deliveries: [], errands: [], errandDwell: null };
        order.push(key);
      }
      return map[key];
    };
    active.forEach((j) => {
      if (isErrand(j)) {
        const s = get(keyOf(j.errandPlaceId));
        entry[j.id] = keyOf(j.errandPlaceId);
        s.errands.push({ jobId: j.id, kind: 'errand', item: j.notes || 'Errand' });
        if (j.dwellMin != null && j.dwellMin !== '') {
          s.errandDwell = Math.max(s.errandDwell || 0, Number(j.dwellMin));
        }
        return;
      }
      const pk = j.pickups || [];
      const items = pk.map((p) => p.item).filter(Boolean).join(', ');
      pk.filter((p) => !p.done).forEach((p) => {
        get(keyOf(p.placeId)).pickups.push({ jobId: j.id, kind: 'pickup', item: p.item || '' });
        entry[j.id] = keyOf(p.placeId);
      });
      if (j.deliveryPlaceId) {
        const d = j.deliveryPlaceId;
        const later = d === first && pk.some((p) => !p.done && p.placeId !== d); // collected elsewhere today: the second visit
        const dk = later ? d + VISIT2 : keyOf(d);
        get(dk).deliveries.push({ jobId: j.id, kind: 'deliver', item: items });
        entry[j.id] = dk;
      }
    });
    return { stopIds: order, stops: map, jobs: active, first: first != null && map[first] ? first : null, keyOf, entry };
  }

  // ---------- the "After" rule (one day only; job.afterPlaces = [placeId]) ----------
  // "This entry's stop" (its delivery, else its last pending pickup, else the errand place) comes after the LAST visit today to each
  // chosen place: a hard "must come before" edge from every pending stop of that place, like collect-before-deliver. A chosen place with
  // nothing pending today (done, skipped, cancelled) is satisfied. An impossible rule (on the First stop, or a cycle through other After
  // rules or collect-before-deliver) is left out, never silently: one text per impossible group, "Can't put X after Y: ... Remove one of
  // the rules." First stop and collect-before-deliver always win. hard = the masks of those rules (stop index -> stops that must come
  // earlier). Returns {kept: masks of the After edges kept, conflicts: [text]}.
  function ancestors(pre, k) { // transitive closure: anc[i] = every stop that must come before i
    const anc = pre.slice();
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < k; i++) {
        let a = anc[i];
        for (let j = 0; j < k; j++) if (a & (1 << j)) a |= anc[j];
        if (a !== anc[i]) { anc[i] = a; changed = true; }
      }
    }
    return anc;
  }
  function afterRules(bs, idx, hard, firstIdx, nameOf) {
    const k = bs.stopIds.length;
    const kept = new Array(k).fill(0), conflicts = [], edges = [];
    bs.jobs.forEach((j) => {
      const list = Array.isArray(j.afterPlaces) ? j.afterPlaces.filter((p, n, a) => typeof p === 'string' && a.indexOf(p) === n) : [];
      const ek = bs.entry[j.id];
      if (!list.length || ek == null || idx[ek] == null) return;
      const e = idx[ek];
      list.forEach((p) => {
        const ts = [];
        bs.stopIds.forEach((key, i) => { if (i !== e && baseId(key) === p) ts.push(i); });
        if (!ts.length) return; // nothing pending there today: satisfied
        if (e === firstIdx) { conflicts.push(cantText(nameOf(ek), nameOf(p), nameOf(ek) + ' is the First stop')); return; }
        edges.push({ e, ts, ek, p });
      });
    });
    if (!edges.length) return { kept, conflicts };
    const all = hard.slice();
    edges.forEach((x) => x.ts.forEach((t) => { all[x.e] |= 1 << t; }));
    const anc = ancestors(all, k), ancHard = ancestors(hard, k);
    const groups = [];
    edges.forEach((x) => {
      const onCycle = x.ts.some((t) => anc[t] & (1 << x.e)); // e must already come before t: a cycle
      if (!onCycle) { x.ts.forEach((t) => { kept[x.e] |= 1 << t; }); return; }
      let scc = 1 << x.e; // the stops mutually ordered with e: one message per group
      for (let i = 0; i < k; i++) if ((anc[i] & (1 << x.e)) && (anc[x.e] & (1 << i))) scc |= 1 << i;
      const hardWay = x.ts.some((t) => ancHard[t] & (1 << x.e));
      const g = groups.find((y) => y.scc === scc);
      const text = cantText(nameOf(x.ek), nameOf(x.p), hardWay
        ? nameOf(x.p) + ' has to come after ' + nameOf(x.ek) + ' (an item collected at ' + nameOf(x.ek) + ' is delivered there)'
        : nameOf(x.p) + ' is already set to come after ' + nameOf(x.ek));
      if (g) g.text = text; else groups.push({ scc, text }); // the rule that closes the circle is the one named
    });
    groups.forEach((g) => conflicts.push(g.text));
    return { kept, conflicts };
  }
  const cantText = (a, b, why) => "Can't put " + a + ' after ' + b + ': ' + why + '. Remove one of the rules.';
  // pending pickup -> its delivery, as stop keys ([[pickupKey, deliveryKey]]): the reversed pairs are never needed
  function linksOf(bs) {
    const out = [];
    const byId = {}; bs.jobs.forEach((j) => { byId[j.id] = j; });
    bs.stopIds.forEach((key) => bs.stops[key].deliveries.forEach((d) => {
      ((byId[d.jobId] || {}).pickups || []).filter((p) => !p.done).forEach((p) => { const q = bs.keyOf(p.placeId); if (q !== key) out.push([q, key]); });
    }));
    return out;
  }

  function pointsFor(input) {
    const bs = buildStops(input.jobs, input.places);
    const pts = [{ lat: input.start.lat, lng: input.start.lng }];
    bs.stopIds.forEach((pid) => {
      const p = placeOf(input.places, pid);
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
      if (!placeOf(places, pid)) throw new Error('A job refers to a place that no longer exists (' + pid + ').');
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
      const pl = placeOf(places, pid);
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
        if (b != null || af != null) targets[i].push({ jobId: j.id, kind: a.kind, before: b, after: af, label: a.item || (a.kind === 'deliver' ? j.inHandItem : '') || j.notes || '' });
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
    const hard = new Array(k).fill(0), urg = new Array(k).fill(0);
    const noDetour = !!input.noDetour;
    for (let i = 0; i < k; i++) {
      const s = bs.stops[bs.stopIds[i]];
      // (1) every pickup of a job precedes that job's delivery
      s.deliveries.forEach((d) => {
        const j = jobById[d.jobId];
        (j.pickups || []).filter((p) => !p.done).forEach((p) => {
          const q = idx[bs.keyOf(p.placeId)];
          if (q !== i && q != null) hard[i] |= (1 << q);
        });
      });
      // (2) urgent deliveries before non-urgent deliveries
      if (nonUrgentDel[i]) urg[i] |= urgentDelMask & ~(1 << i);
      // (2b) urgentRank order among urgent deliveries (stop key = lowest rank delivered there)
      if (urgentDel[i]) {
        for (let o = 0; o < k; o++) if (o !== i && urgentDel[o] && rankKey[o] < rankKey[i]) urg[i] |= (1 << o);
      }
      // (3) noDetour: stops with no urgent-job action wait for all urgent deliveries
      if (noDetour && !urgentAction[i]) urg[i] |= urgentDelMask & ~(1 << i);
    }
    // (4) First stop: its visit comes first after the start (hard, beats urgent and After); every other stop waits for it. The
    // urgent rules then apply to everything after it, as above.
    const firstIdx = bs.first != null ? idx[bs.first] : -1;
    if (firstIdx >= 0) {
      hard[firstIdx] = 0; urg[firstIdx] = 0;
      for (let i = 0; i < k; i++) if (i !== firstIdx) hard[i] |= (1 << firstIdx);
    }
    // (5) After (beats urgent): the kept After edges; an urgent edge that would contradict them is left out (no banner)
    const nameOfKey = (key) => (placeOf(places, key) || {}).name || baseId(key);
    const ar = afterRules(bs, idx, hard, firstIdx, nameOfKey);
    const pre = hard.map((m, i) => m | ar.kept[i]);
    const anyAfter = ar.kept.some((m) => m);
    for (let i = 0; i < k; i++) {
      if (!anyAfter) { pre[i] |= urg[i]; continue; }
      for (let o = 0; o < k; o++) {
        if (!(urg[i] & (1 << o))) continue;
        const anc = ancestors(pre, k);
        if (!(anc[o] & (1 << i))) pre[i] |= 1 << o; // o before i, unless i already has to come before o
      }
    }
    const afterReq = anyAfter ? ancestors(ar.kept, k) : null;

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

    // closed windows per stop (weekday-aware); only enforced (arrival waits) when input.respectClosedWindows
    const closedWin = bs.stopIds.map((pid) => normWindows(placeOf(places, pid).closedWindows));
    const respect = !!input.respectClosedWindows;

    const ctx = {
      input, places, bs, k, N, idx, t0ms, dayStart, slices, jobById,
      dwell, before, after, targets, urgentDel, urgentAction, pre, minIn, minInEnd, urgentDelMask,
      closedWin, respect, afterConflicts: ar.conflicts, afterReq,
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
        if (c.respect && c.closedWin[i].length) arrive = pushPastClosedRel(c, i, arrive);
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
    // a stop an After rule puts before an urgent delivery is not a detour
    const urgentNeeds = c.afterReq ? order.reduce((m, i) => (c.urgentDel[i] ? m | c.afterReq[i] : m), 0) : 0;
    const nameOf = (key) => (placeOf(places, key) || {}).name || baseId(key);
    // the "it has to come after <pickup>" reason of a missed delivery window: the latest-visited pending pickup of that job, when
    // going there first makes the delivery late although driving straight to it would not (collect-before-deliver is the cause)
    const ruleOf = (i, pos, tg) => {
      if (tg.kind !== 'deliver' || tg.before == null) return null;
      const j = c.jobById[tg.jobId];
      let best = null, bp = -1;
      ((j && j.pickups) || []).filter((p) => !p.done).forEach((p) => {
        const q = c.idx[bs.keyOf(p.placeId)];
        const qp = q == null ? -1 : order.indexOf(q);
        if (q != null && qp >= 0 && qp < pos && qp > bp) { bp = qp; best = { q, p }; }
      });
      if (!best) return null;
      const direct = Math.max(c.leg(0, i + 1, 0), c.after[i]);
      let via = Math.max(c.leg(0, best.q + 1, 0), c.after[best.q]) + c.dwell[best.q];
      via = Math.max(via + c.leg(best.q + 1, i + 1, via), c.after[i]);
      if (!(direct <= tg.before + 0.0001 && via > tg.before + 0.0001)) return null;
      return { place: nameOf(bs.stopIds[best.q]), item: best.p.item || tg.label || '' };
    };
    const ruleAt = {};
    order.forEach((i, pos) => {
      const pid = bs.stopIds[i];
      const s = bs.stops[pid];
      const arrive0 = t + c.leg(last, i + 1, t);
      let arrive = arrive0;
      if (c.after[i] > arrive) arrive = c.after[i];
      if (c.respect && c.closedWin[i].length) arrive = pushPastClosedRel(c, i, arrive);
      c.targets[i].forEach((tg) => {
        const rule = ruleOf(i, pos, tg);
        if (rule) ruleAt[pid + '|' + tg.jobId] = rule;
        if (tg.before != null && arrive > tg.before + 0.0001) {
          late += arrive - tg.before;
          violations.push(missedText(nameOf(pid), t0ms + arrive * 1000, c.t0ms + tg.before * 1000, tg, rule));
        }
      });
      const dep = arrive + c.dwell[i];
      const pl = placeOf(places, pid);
      const arriveAt = t0ms + Math.round(arrive * 1000);
      const closed = !!windowAt(c.closedWin[i], arriveAt); // weekday of the predicted arrival date
      const out = {
        placeId: pid,
        arriveAt,
        departAt: t0ms + Math.round(dep * 1000),
        waitSec: Math.round(arrive - arrive0),
        actions: [].concat(s.deliveries, s.errands, s.pickups).map((a) => ({ jobId: a.jobId, kind: a.kind, item: a.item })),
        detour: !c.urgentAction[i] && pos < lastUrgentPos && !(urgentNeeds & (1 << i)),
        closedWarning: closed,
      };
      if (pid === bs.first) out.first = true;          // the First stop visit (the FIRST tag)
      if (isVisit2(pid)) out.visitOf = baseId(pid);    // a second visit to that saved place
      stops.push(out);
      t = dep; last = i + 1;
    });
    const e = t + c.leg(last, k + 1, t);
    // everything retime() needs to re-time this plan later without re-solving (matrices are shared by reference)
    const model = {
      t0ms,
      start: { lat: c.input.start.lat, lng: c.input.start.lng },
      end: { lat: c.input.end.lat, lng: c.input.end.lng },
      stopIds: bs.stopIds.slice(),
      matrices: c.input.matrices,
      dwellSec: {}, afterMs: {}, closed: {}, beforeMs: {}, names: {},
      respectClosed: c.respect,
    };
    bs.stopIds.forEach((pid, i) => {
      model.dwellSec[pid] = c.dwell[i];
      model.afterMs[pid] = c.after[i] > -Infinity ? Math.round(t0ms + c.after[i] * 1000) : null;
      const pl = placeOf(places, pid);
      model.closed[pid] = pl.closedWindows || [];
      model.names[pid] = pl.name;
      model.beforeMs[pid] = c.targets[i].filter((tg) => tg.before != null).map((tg) => ({ jobId: tg.jobId, ms: Math.round(t0ms + tg.before * 1000),
        kind: tg.kind, label: tg.label, rule: ruleAt[pid + '|' + tg.jobId] || null }));
    });
    return {
      order: order.map((i) => bs.stopIds[i]),
      stops,
      totalSec: Math.round(e),
      endArrival: t0ms + Math.round(e * 1000),
      violations,
      lateSec: Math.round(late),
      model,
    };
  }
  function secOfDay(ms) {
    const d = new Date(ms);
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }

  // ---------- closed windows: {days:[1..7] ISO Mon=1, from:"HH:MM", to:"HH:MM"}; legacy entries (no days) = every day ----------
  function normWindows(list) {
    return (list || []).map((w) => ({
      days: Array.isArray(w.days) ? w.days.map(Number) : [1, 2, 3, 4, 5, 6, 7],
      from: hmToSec(w.from), to: hmToSec(w.to),
    })).filter((w) => w.from != null && w.to != null);
  }
  const isoWeekday = (ms) => { const d = new Date(ms).getDay(); return d === 0 ? 7 : d; };
  // the (normalised) window containing this instant on that instant's weekday, or null
  function windowAt(wins, ms) {
    const wd = isoWeekday(ms), sod = secOfDay(ms);
    for (let i = 0; i < wins.length; i++) {
      if (wins[i].days.indexOf(wd) >= 0 && sod >= wins[i].from && sod < wins[i].to) return wins[i];
    }
    return null;
  }
  // an arrival inside a window waits until it ends (windows can chain); ms in, ms out
  function pushPastClosed(wins, ms) {
    for (let g = 0; g < 12; g++) {
      const w = windowAt(wins, ms);
      if (!w) return ms;
      ms += (w.to - secOfDay(ms)) * 1000;
    }
    return ms;
  }
  function pushPastClosedRel(c, i, relSec) { // relSec = seconds after the plan's departure
    const ms = c.t0ms + relSec * 1000;
    const pm = pushPastClosed(c.closedWin[i], ms);
    return pm > ms ? relSec + (pm - ms) / 1000 : relSec;
  }
  const isClosedAt = (windows, ms) => !!windowAt(normWindows(windows), ms);
  function formatETAfromRel(c, rel) { return formatETA(c.t0ms + rel * 1000); }
  // The text of a missed arrive-before window. Never an internal job id: the item and the place. rule = {place, item} when the
  // collect-before-deliver rule is what made it late.
  function missedText(name, arriveMs, beforeMs, tg, rule) {
    if (rule) return name + ' arrives ' + formatETA(arriveMs) + ', must be before ' + formatETA(beforeMs) + ' — it has to come after ' + rule.place + ' (' + (rule.item || 'the item') + ' is collected there)';
    const what = String((tg && tg.label) || '').trim() || (tg && tg.kind === 'errand' ? 'Errand' : 'Item');
    const rel = tg && tg.kind === 'deliver' ? ' to ' : tg && tg.kind === 'pickup' ? ' from ' : ' at ';
    return 'Arrive-before missed at ' + name + ': arrives ' + formatETA(arriveMs) + ', must be before ' + formatETA(beforeMs) + ' (' + what + rel + name + ')';
  }

  // ---------- live re-timing ----------
  // Recompute arrive/depart for every stop that is not done/skipped, WITHOUT changing the order, starting at the
  // location of stop `fromStopIndex` (-1 = the plan's start point) at time `nowISO`. Uses the plan's own model
  // (stored matrices with the nearest-slice rule, dwell, arriveAfter waits, closed windows). Pure: returns a new plan;
  // done/skipped stops (stop.status) are copied untouched.
  // origin (optional) = {durationToNextSec}: the first not-done stop is reached after that many seconds from NOW
  // (a live fix + one routing request) instead of the matrix leg from the last done stop / start. Order never changes.
  function retime(plan, fromStopIndex, nowISO, origin) {
    const m = plan && plan.model;
    if (!m || !m.matrices || !m.matrices.length) throw new Error('retime: plan has no model/matrices');
    const nowMs = Date.parse(nowISO);
    const k = m.stopIds.length;
    const slices = m.matrices.map((s) => ({ at: Date.parse(s.departAt), m: s.m }));
    const pidx = (pid) => { const i = m.stopIds.indexOf(pid); return i < 0 ? null : i + 1; };
    const leg = (a, b, ms) => {
      if (a === b) return 0;
      let best = slices[0], bd = Infinity;
      slices.forEach((s) => { const d = Math.abs(s.at - ms); if (d < bd) { bd = d; best = s; } });
      const v = best.m[a][b];
      return (v == null || !isFinite(v) || v < 0) ? BIG : v;
    };
    // Fuel stop (s.fuel): not a model point. Its legs come from model.fuelT, a table keyed by rounded coordinates:
    //   {lat, lng, pid2key:{placeId:key}, ll:{key:{lat,lng}}, slices:[{at, to:{key:sec}, from:{key:sec}}]}  (to = point -> fuel)
    // pos / pi === FUEL means "at / going to the fuel station". Without a table the stop is left untouched.
    const FUEL = -1, fz = m.fuelT || null;
    const ck = (p) => Number(p.lat).toFixed(5) + ',' + Number(p.lng).toFixed(5);
    const keyOfIdx = (i) => (i === 0 ? ck(m.start) : i === k + 1 ? ck(m.end) : (fz && fz.pid2key ? fz.pid2key[m.stopIds[i - 1]] : null));
    const fuelLeg = (a, b, ms) => {
      if (a === b) return 0;
      let best = null, bd = Infinity;
      fz.slices.forEach((s) => { const d = Math.abs(s.at - ms); if (d < bd) { bd = d; best = s; } });
      const other = a === FUEL ? b : a, key = keyOfIdx(other);
      const v = best && key != null ? (a === FUEL ? best.from : best.to)[key] : null;
      if (v != null && isFinite(v) && v >= 0) return v;
      const ll = key != null && fz.ll ? fz.ll[key] : null; // no table cell: straight line at 35 km/h x 1.4
      return ll ? Math.round(distanceM(ll, fz) / 1000 * 1.4 / 35 * 3600) : BIG;
    };
    const legAny = (a, b, ms) => (a === FUEL || b === FUEL ? fuelLeg(a, b, ms) : leg(a, b, ms));
    let pos = 0; // point index 0 = start. A stop that is not in the model (e.g. done before a re-solve) = the model's start.
    if (fromStopIndex >= 0 && plan.stops[fromStopIndex]) {
      const fs = plan.stops[fromStopIndex];
      if (fs.fuel && fz) pos = FUEL;
      else { const p = pidx(fs.placeId); pos = p == null ? 0 : p; }
    }
    const ov = origin && origin.durationToNextSec != null && isFinite(origin.durationToNextSec) ? Math.max(0, Number(origin.durationToNextSec)) : null;
    let firstLeft = true;
    let t = nowMs;
    const stops = plan.stops.map((s) => {
      if (s.status === 'done' || s.status === 'skipped') return Object.assign({}, s);
      const pi = s.fuel ? (fz ? FUEL : null) : pidx(s.placeId);
      if (pi == null) return Object.assign({}, s);
      const onSite = s.reachedAt != null; // reached, not done: we ARE here. Arrival = the Reached time, expected
      const legSec = onSite ? 0 : firstLeft && ov != null ? ov : legAny(pos, pi, t); // departure = max(now, reached + planned dwell)
      firstLeft = false;
      const arrive0 = onSite ? Number(s.reachedAt) : t + legSec * 1000;
      let arrive = arrive0;
      const af = m.afterMs ? m.afterMs[s.placeId] : null;
      if (!onSite && af != null && af > arrive) arrive = af;
      const wins = normWindows((m.closed || {})[s.placeId]);
      if (!onSite && m.respectClosed && wins.length) arrive = pushPastClosed(wins, arrive);
      const dwellMs = ((m.dwellSec || {})[s.placeId] || 0) * 1000;
      const dep = onSite ? Math.max(nowMs, arrive + dwellMs) : arrive + dwellMs;
      const out = Object.assign({}, s, {
        arriveAt: Math.round(arrive), departAt: Math.round(dep),
        waitSec: Math.round((arrive - arrive0) / 1000),
        closedWarning: !!windowAt(wins, Math.round(arrive)),
      });
      t = dep; pos = pi;
      return out;
    });
    // every stop done/skipped: the live origin (a fix + one routing request) targets the end point instead
    const endMs = t + (firstLeft && ov != null ? ov : legAny(pos, k + 1, t)) * 1000;
    // departFromMs = when the walk leaves the current point (the lunch break's "start of the route" departure)
    const out = Object.assign({}, plan, { stops, endArrival: Math.round(endMs), totalSec: Math.round((endMs - m.t0ms) / 1000), departFromMs: nowMs });
    markLate(out);
    return out;
  }
  // Window lateness follows the plan's current times (stops still ahead only): sets stop.late, plan.violations, plan.lateSec.
  // In place on `plan` (a fresh copy made by the caller).
  function markLate(plan) {
    const m = plan.model;
    if (!m || !m.beforeMs) return plan;
    const violations = []; let lateMs = 0;
    plan.stops.forEach((s) => {
      if (s.status) return;
      s.late = false;
      (m.beforeMs[s.placeId] || []).forEach((tg) => {
        if (s.arriveAt > tg.ms + 1) {
          s.late = true; lateMs += s.arriveAt - tg.ms;
          violations.push(missedText((m.names || {})[s.placeId] || baseId(s.placeId), s.arriveAt, tg.ms, tg, tg.rule || null));
        }
      });
    });
    plan.violations = violations; plan.lateSec = Math.round(lateMs / 1000);
    return plan;
  }

  // ---------- live-location rules (pure; the app supplies the clock and the fix) ----------
  const LOC = { REFRESH_MS: 120000, MOVED_M: 300, ARRIVED_M: 150, MAX_ACCURACY_M: 200, ORIGIN_MAX_AGE_MS: 300000 };
  function distanceM(a, b) { // haversine, metres
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  // at most one location refresh per 2 minutes (force = the driver tapped the status line: always due)
  const refreshDue = (nowMs, lastAtMs, force) => !!force || lastAtMs == null || nowMs - lastAtMs >= LOC.REFRESH_MS;
  // a live origin older than 5 minutes is never reused (a poor / failed fix must fall back to the last DONE)
  const originFresh = (o, nowMs) => !!o && nowMs - (o.usedAt || 0) <= LOC.ORIGIN_MAX_AGE_MS;
  // What to do with a fix {lat,lng,accuracy}: 'ignore' (none / accuracy worse than 200 m), 'arrived' (within 150 m of the
  // next stop: no routing request), 'unmoved' (under 300 m from lastFix, the position of the previous refresh), else 'route'.
  function judgeFix(fix, lastFix, nextStop, opts) {
    if (!fix || fix.lat == null || fix.lng == null || !(fix.accuracy <= LOC.MAX_ACCURACY_M)) return 'ignore';
    if (nextStop && distanceM(fix, nextStop) <= LOC.ARRIVED_M) return 'arrived';
    if (!(opts && opts.force) && lastFix && distanceM(fix, lastFix) < LOC.MOVED_M) return 'unmoved';
    return 'route';
  }

  // ---------- what the Route tab shows (pure; the app supplies the clock) ----------
  // The header / cards follow the CURRENT re-timed plan, never the first snapshot. No remaining stop and no end arrival
  // may be in the past: if the next not-done stop's ETA is before `nowMs`, it becomes `nowMs` and every remaining stop
  // (and the end arrival) shifts by the same amount. The end arrival is never earlier than any remaining stop or now.
  function liveView(plan, nowMs) {
    const stops = plan.stops.map((s) => Object.assign({}, s));
    const left = stops.filter((s) => !s.status);
    let shiftMs = 0;
    if (left.length && left[0].reachedAt != null) { // on site: its arrival is a fact; only the departure (and everything after) rolls forward
      shiftMs = Math.max(0, nowMs - left[0].departAt);
      left[0].departAt += shiftMs;
      left.slice(1).forEach((s) => { s.arriveAt += shiftMs; s.departAt += shiftMs; });
    } else {
      shiftMs = left.length && left[0].arriveAt < nowMs ? nowMs - left[0].arriveAt : 0;
      if (shiftMs) left.forEach((s) => { s.arriveAt += shiftMs; s.departAt += shiftMs; });
    }
    let end = Math.max(plan.endArrival + shiftMs, nowMs);
    left.forEach((s) => { end = Math.max(end, s.arriveAt, s.departAt); });
    return { stops, endArrival: end, left: left.length, leftSec: Math.max(0, Math.round((end - nowMs) / 1000)), shiftMs };
  }
  const TIMES_REASON = { denied: 'location off or not allowed', nofix: 'no GPS fix', routing: 'routing failed', offline: 'offline' };
  const GETTING = 'getting location…';
  // st = {liveAt (ms of the live fix used) | null, lastDoneAt (ms) | null, reason: 'denied'|'nofix'|'routing'|'offline'|null,
  //       busy: a fix is being fetched}. A fallback anchor ALWAYS carries a reason: while a fix is being fetched (e.g. after
  //       location comes back), or before the first attempt has reported, that reason is "getting location…".
  function timesLine(st) {
    if (st.liveAt != null) return 'Times from your location, ' + formatETA(st.liveAt);
    const base = st.lastDoneAt != null ? 'Times from last DONE, ' + formatETA(st.lastDoneAt) : 'Times from plan start';
    return base + ' - ' + (st.busy ? GETTING : TIMES_REASON[st.reason] || GETTING);
  }

  // Sub-matrices for a smaller problem: keep only the listed point indices, in that order (used to re-solve the
  // remaining stops from a cached matrix without calling the API). Diagonal stays 0.
  function reindexMatrices(matrices, idxList) {
    return matrices.map((s) => ({
      departAt: s.departAt, fetchedAt: s.fetchedAt,
      m: idxList.map((a, i) => idxList.map((b, j) => (i === j ? 0 : s.m[a][b]))),
      d: s.d ? idxList.map((a, i) => idxList.map((b, j) => (i === j ? 0 : s.d[a][b]))) : undefined, // metres (day log), when held
      est: s.est ? idxList.map((a, i) => idxList.map((b, j) => (i === j ? false : !!s.est[a][b]))) : undefined, // estimated cells (TomTom out)
    }));
  }

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
      return { plans: [p], stopIds: [], error: null, afterConflicts: [], stats: { nodes: 0, ms: 0, mode: 'strict', truncated: false } };
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
        plans: [], stopIds: bs.stopIds, afterConflicts: c.afterConflicts,
        error: 'No order satisfies the pickup / urgent rules (they contradict each other). Un-flag an urgent job or park one.',
      };
    }
    const plans = r.top.map((x) => buildPlan(c, x.order));
    return {
      plans, stopIds: bs.stopIds, error: null, afterConflicts: c.afterConflicts, // the After rules left out, each as its banner text
      stats: { nodes: r.nodes, ms: Date.now() - started, mode, truncated: r.timedOut },
    };
  }

  // Evaluate one explicit order of placeIds (used by tests and "what-if"); does not check precedence.
  function evaluate(input, orderPlaceIds) {
    const c = prepare(input);
    return buildPlan(c, orderPlaceIds.map((p) => c.idx[p]));
  }

  // The ordering rules as "must come before" lists (read only; the same prerequisites the search uses):
  // {stopIds, before: {placeId: [placeIds that must be visited earlier]}}. Used to say which stops may be visited NEXT.
  function precedence(input) {
    const bs = buildStops(input.jobs, input.places);
    const N = bs.stopIds.length + 2;
    const zero = Array.from({ length: N }, () => new Array(N).fill(0));
    const c = prepare(Object.assign({}, input, { matrices: [{ departAt: input.departAtISO || new Date().toISOString(), m: zero }] }));
    const before = {};
    bs.stopIds.forEach((pid, i) => { before[pid] = bs.stopIds.filter((q, o) => c.pre[i] & (1 << o)); });
    return { stopIds: bs.stopIds, before };
  }

  return { VISIT2, baseId, isVisit2, placeOf, firstStopPlace, linksOf, missedText, solve, evaluate, precedence, retime, markLate, normWindows, pushPastClosed, reindexMatrices, distanceM, refreshDue, judgeFix, originFresh, liveView, timesLine, LOC, isClosedAt, buildStops, pointsFor, formatETA, formatDuration, hmToSec, MAX_STOPS, DEFAULT_DWELL };
});
