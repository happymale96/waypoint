/* L-Tech Waypoint — traveltimes.js
 * Travel times from the TomTom Routing API (one origin -> one destination per request), learned per part of the day.
 * Pure logic + small async orchestration with INJECTED fetchers (no DOM, no storage, no network of its own); every clock is
 * passed in. Exports via module.exports (node) or window.TravelTimes.
 *
 *  - Buckets (Malaysia time, UTC+8, no DST): AM peak 06:30-09:30 · Day 09:30-16:30 · PM peak 16:30-20:00 · Night 20:00-06:30.
 *  - Pair memory {pairs: {"fromId>toId@bucket": [{s, m, at}]}}: up to 5 most recent samples per (from, to, bucket); the value
 *    is the MEDIAN sample (upper middle for an even count). Samples come only from TomTom answers between two saved places,
 *    stored under the bucket of their departure; a typical (historic) time is stored when TomTom returns one.
 *  - neededPairs: only pairs the ordering can use (see the rule list on the function).
 *  - buildTable: the plan's table for one bucket (learned -> other bucket -> fetch at the bucket's middle), or live (all
 *    needed pairs fetched for now). Never mixed: one pair without any real time = the ORDER uses estimates for all pairs.
 *  - twoStep: order, then check the chosen order's legs at their planned departures; >15% off = one re-solve (+ one check).
 *  - lookAhead: after DONE / SKIP, live times for now (first-leg probe or full refresh) and a re-solve of the pending stops.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./budget.js'));
  else root.TravelTimes = factory(root.Budget);
})(typeof self !== 'undefined' ? self : this, function (Budget) {
  'use strict';

  const MYT_MS = 8 * 3600e3;
  const DAY_MS = 86400e3;
  const MAX_SAMPLES = 5;
  const SNAP_M = 150;
  const CONCURRENCY = 4;
  const CHECK_RATIO = 0.15;
  const SWITCH_MIN_SEC = 600;
  const FULL_REFRESH_MAX = 5;
  const LIVE_TABLE_MAX = 5; // 5 stops or fewer: the PLAN table is fetched live (depart now), no check pass
  const BUCKETS = ['am', 'day', 'pm', 'night'];
  const LABEL = { am: 'AM peak', day: 'Day', pm: 'PM peak', night: 'Night' };
  const MID_MIN = { am: 480, day: 780, pm: 1095, night: 1515 }; // 08:00 · 13:00 · 18:15 · 01:15 (the next day)

  // ---------- buckets ----------
  const minOfDay = (ms) => { const d = new Date(ms + MYT_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const mytDayStart = (ms) => Math.floor((ms + MYT_MS) / DAY_MS) * DAY_MS - MYT_MS;
  function bucketOf(ms) {
    const m = minOfDay(ms);
    if (m >= 390 && m < 570) return 'am';
    if (m >= 570 && m < 990) return 'day';
    if (m >= 990 && m < 1200) return 'pm';
    return 'night';
  }
  // the departure used to fetch a pair for `bucket`: now when now is inside it, else its middle on the plan's date
  // (moved forward a day while it is in the past: TomTom predicts future departures)
  function bucketDepart(bucket, planMs, nowMs) {
    if (nowMs != null && bucketOf(nowMs) === bucket) return nowMs;
    let t = mytDayStart(planMs) + MID_MIN[bucket] * 60000;
    if (nowMs != null) while (t < nowMs) t += DAY_MS;
    return t;
  }
  // the plan's bucket: the one holding the midpoint between the start and the rough finish (start + dwells + 3 h)
  function planBucket(startMs, dwellSumSec) {
    if (startMs == null || !isFinite(startMs)) return 'day';
    const finish = startMs + ((Number(dwellSumSec) || 0) + 3 * 3600) * 1000;
    return bucketOf(startMs + (finish - startMs) / 2);
  }

  // ---------- pair memory ----------
  const emptyMemory = () => ({ v: 1, pairs: {} });
  const memKey = (a, b, bucket) => a + '>' + b + '@' + bucket;
  function medianSample(list) {
    if (!list || !list.length) return null;
    const sorted = list.slice().sort((x, y) => x.s - y.s);
    return sorted[Math.floor(sorted.length / 2)];
  }
  function addSample(mem, a, b, bucket, sample) {
    if (!mem || a == null || b == null || a === b || !sample || !isFinite(sample.s)) return mem;
    mem.pairs = mem.pairs || {};
    const k = memKey(a, b, bucket);
    const arr = mem.pairs[k] || (mem.pairs[k] = []);
    arr.push({ s: Math.round(sample.s), m: sample.m != null && isFinite(sample.m) ? Math.round(sample.m) : null, at: sample.at != null ? sample.at : null });
    while (arr.length > MAX_SAMPLES) arr.shift();
    return mem;
  }
  // {s, m, bucket, exact} from the asked bucket, else the bucket with the most samples (then the BUCKETS order), else null
  function learned(mem, a, b, bucket) {
    const P = (mem && mem.pairs) || {};
    const own = medianSample(P[memKey(a, b, bucket)]);
    if (own) return { s: own.s, m: own.m, bucket, exact: true };
    let best = null, bn = 0;
    BUCKETS.forEach((bk) => { const l = P[memKey(a, b, bk)]; if (l && l.length > bn) { bn = l.length; best = bk; } });
    if (!best) return null;
    const md = medianSample(P[memKey(a, b, best)]);
    return { s: md.s, m: md.m, bucket: best, exact: false };
  }
  function pairCount(mem) {
    const seen = new Set();
    Object.keys((mem && mem.pairs) || {}).forEach((k) => { if (mem.pairs[k] && mem.pairs[k].length) seen.add(k.slice(0, k.lastIndexOf('@'))); });
    return seen.size;
  }
  function normaliseMemory(x) { // Import: keep only well-formed samples, at most 5 per key
    const out = emptyMemory();
    const P = x && x.pairs && typeof x.pairs === 'object' ? x.pairs : {};
    Object.keys(P).forEach((k) => {
      if (!/^.+>.+@(am|day|pm|night)$/.test(k) || !Array.isArray(P[k])) return;
      const list = P[k].filter((s) => s && isFinite(s.s)).slice(-MAX_SAMPLES).map((s) => ({ s: Math.round(s.s), m: s.m != null && isFinite(s.m) ? Math.round(s.m) : null, at: s.at != null ? s.at : null }));
      if (list.length) out.pairs[k] = list;
    });
    if (x && x.lastTypicalAt != null && isFinite(x.lastTypicalAt)) out.lastTypicalAt = Number(x.lastTypicalAt);
    if (x && x.last && isFinite(x.last.at)) out.last = { at: Number(x.last.at), typical: x.last.typical !== false };
    return out;
  }

  // ---------- saved places: a point within 150 m of one IS that place ----------
  function snap(pt, places, radiusM) {
    if (!pt || pt.lat == null || pt.lng == null) return null;
    const r = radiusM != null ? radiusM : SNAP_M;
    let best = null, bd = Infinity;
    (places || []).forEach((p) => {
      if (!p || p.id == null || p.lat == null || p.lng == null) return;
      const d = Budget.distanceM(pt, p);
      if (d <= r && d < bd) { bd = d; best = p.id; }
    });
    return best;
  }

  // ---------- which pairs the ordering can use ----------
  // nodes: {key, pid (saved place id or null), lat, lng}. links: [[pickupKey, deliveryKey]] (pending pickup -> its delivery).
  // Rules: never a place to itself (same key, or the same saved place: 0 s, no request); nothing TO the start; nothing FROM
  // the end; start -> end only when there is no stop; never a delivery -> its own (pending) pickup.
  const samePlace = (a, b) => a.key === b.key || (a.pid != null && a.pid === b.pid);
  function neededPairs(start, stops, end, links) {
    const out = [];
    const forbidden = new Set((links || []).map((l) => l[1] + '>' + l[0]));
    const add = (a, b) => { if (!samePlace(a, b) && !forbidden.has(a.key + '>' + b.key)) out.push([a, b]); };
    if (!stops.length) { add(start, end); return out; }
    stops.forEach((s) => add(start, s));
    stops.forEach((s) => stops.forEach((t) => { if (s !== t) add(s, t); }));
    stops.forEach((s) => add(s, end));
    return out;
  }

  // ---------- running fetches: at most 4 at a time; a TomTom "limit / down" answer stops the rest ----------
  async function runFetches(jobs, fetchOne, opts) {
    opts = opts || {};
    const limit = opts.concurrency || CONCURRENCY;
    let next = 0, done = 0, down = null, started = 0;
    const results = new Array(jobs.length).fill(null);
    async function worker() {
      while (next < jobs.length && !down) {
        const i = next++;
        started++;
        try { results[i] = await fetchOne(jobs[i]); } catch (e) {
          if (e && e.kind === 'limit') down = e;
          results[i] = null;
        }
        done++;
        if (opts.onProgress) { try { opts.onProgress(done, jobs.length); } catch (e) { /* display only */ } }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
    return { results, down, started };
  }
  // the sample a TomTom answer leaves: ONLY the typical time (historicTrafficTravelTimeInSeconds, computeTravelTimeFor=all).
  // No typical time in the answer = no sample (the live figure is never stored as if it were typical).
  const hasTypical = (r) => !!r && r.typicalSeconds != null && isFinite(r.typicalSeconds);
  const sampleOf = (r, atMs) => (hasTypical(r) ? { s: r.typicalSeconds, m: r.metres, at: atMs } : null);
  // r = a successful answer {seconds, metres, typicalSeconds|null}. mem.last = {at, typical} (the most recent answer),
  // mem.lastTypicalAt = when the last typical time came back (Settings -> Travel times).
  function remember(mem, a, b, departMs, r, nowMs) {
    if (!mem || !r) return;
    const typ = hasTypical(r);
    mem.last = { at: nowMs, typical: typ };
    if (typ) mem.lastTypicalAt = nowMs;
    if (!typ || !a || !b || a.pid == null || b.pid == null || a.pid === b.pid) return;
    addSample(mem, a.pid, b.pid, bucketOf(departMs), sampleOf(r, nowMs));
  }
  // Settings -> Travel times: "Learned: N pairs · last typical time from TomTom: today HH:MM | 23 Nov | none yet"
  // (+ " · last reply had no typical time" when the most recent answer had none). Malaysia time.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function learnedLine(mem, nowMs) {
    const n = pairCount(mem), at = mem && mem.lastTypicalAt;
    let when = 'none yet';
    if (at != null && isFinite(at)) {
      const d = new Date(at + MYT_MS), now = new Date(nowMs + MYT_MS);
      const p2 = (x) => (x < 10 ? '0' : '') + x;
      when = d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
        ? 'today ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes())
        : d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + (d.getUTCFullYear() !== now.getUTCFullYear() ? ' ' + d.getUTCFullYear() : '');
    }
    return 'Learned: ' + n + ' pair' + (n === 1 ? '' : 's') + ' · last typical time from TomTom: ' + when +
      (mem && mem.last && mem.last.typical === false ? ' · last reply had no typical time' : '');
  }

  // ---------- the plan's table ----------
  // o = {start, stops:[node], end, links, mem, bucket, planMs, nowMs, live (bool), liveDepartMs?, fetchLeg(a, b, departMs)
  //      -> Promise<{seconds, metres, typicalSeconds?}>, onProgress?, concurrency?}
  // Returns {nodes, m (timing seconds), d (metres), est (flags), ord (the ORDER table), estimated (order on estimates),
  //          requests, needed, missing, down}.
  async function buildTable(o) {
    const nodes = [o.start].concat(o.stops, [o.end]);
    const n = nodes.length, idx = new Map(nodes.map((x, i) => [x, i]));
    const val = Array.from({ length: n }, () => new Array(n).fill(null)); // real {s, m} per needed pair
    const pairs = neededPairs(o.start, o.stops, o.end, o.links);
    const jobs = [];
    const nowMs = o.nowMs;
    pairs.forEach(([a, b]) => {
      const i = idx.get(a), j = idx.get(b);
      if (o.live) { jobs.push({ i, j, a, b, at: o.liveDepartMs != null ? o.liveDepartMs : nowMs }); return; }
      if (a.pid != null && b.pid != null) {
        const l = learned(o.mem, a.pid, b.pid, o.bucket);
        if (l) { val[i][j] = { s: l.s, m: l.m }; return; }
      }
      jobs.push({ i, j, a, b, at: bucketDepart(o.bucket, o.planMs != null ? o.planMs : nowMs, nowMs) });
    });
    const run = await runFetches(jobs, async (jb) => {
      const r = await o.fetchLeg(jb.a, jb.b, jb.at);
      if (!r || r.seconds == null || !isFinite(r.seconds)) return null;
      remember(o.mem, jb.a, jb.b, jb.at, r, nowMs);
      return r;
    }, { onProgress: o.onProgress, concurrency: o.concurrency });
    run.results.forEach((r, k) => { if (r) val[jobs[k].i][jobs[k].j] = { s: r.seconds, m: r.metres }; });
    const neededSet = new Set(pairs.map(([a, b]) => idx.get(a) + ',' + idx.get(b)));
    let missing = 0;
    neededSet.forEach((k) => { const [i, j] = k.split(',').map(Number); if (!val[i][j]) missing++; });
    const estimated = missing > 0;
    const m = [], d = [], est = [], ord = [];
    for (let i = 0; i < n; i++) {
      m.push([]); d.push([]); est.push([]); ord.push([]);
      for (let j = 0; j < n; j++) {
        if (i === j || samePlace(nodes[i], nodes[j])) { m[i].push(0); d[i].push(0); est[i].push(false); ord[i].push(0); continue; }
        const e = Budget.estSec(nodes[i], nodes[j]), em = Budget.estMetres(nodes[i], nodes[j]);
        const v = val[i][j];
        m[i].push(v ? v.s : e); d[i].push(v && v.m != null ? v.m : em); est[i].push(!v);
        ord[i].push(estimated ? e : (v ? v.s : e));
      }
    }
    return { nodes, m, d, est, ord, estimated, requests: run.started, needed: neededSet.size, missing, down: run.down };
  }

  // ---------- the route check: one request per leg, at that leg's planned departure ----------
  // legs: [{a, b, at}] -> {values: [{s, m} | null], down}
  async function checkLegs(legs, fetchLeg, mem, nowMs, opts) {
    const run = await runFetches(legs, async (l) => {
      const r = await fetchLeg(l.a, l.b, l.at);
      if (!r || r.seconds == null || !isFinite(r.seconds)) return null;
      remember(mem, l.a, l.b, l.at, r, nowMs);
      return { s: r.seconds, m: r.metres };
    }, opts);
    return { values: run.results, down: run.down, requests: run.started };
  }

  // ORDER, then CHECK (C1-C3). o = {table (n x n seconds, mutated copy is made), solve(table) -> {order (node indices of the
  // stops, in visit order), legs: [{i, j, at}]} | null, check(legs) -> Promise<{values:[{s,m}|null], down}>}.
  // At most two solves and two check passes. Returns {result, table, checked: Map "i>j" -> {s, m}, solves, checks, ratio}.
  async function twoStep(o) {
    let table = o.table.map((r) => r.slice());
    let res = o.solve(table);
    let solves = 1, checks = 0, ratio = 0;
    const checked = new Map();
    if (!res) return { result: null, table, checked, solves, checks, ratio };
    const pass = async (legs) => {
      const todo = legs.filter((l) => !checked.has(l.i + '>' + l.j));
      if (!todo.length) return null;
      checks++;
      const got = await o.check(todo);
      todo.forEach((l, k) => { const v = got.values[k]; if (v) checked.set(l.i + '>' + l.j, v); });
      return got;
    };
    const p1 = await pass(res.legs);
    const legsOk = res.legs.every((l) => checked.has(l.i + '>' + l.j));
    if (p1 && !p1.down && legsOk) {
      const tableTotal = res.legs.reduce((a, l) => a + table[l.i][l.j], 0);
      const checkedTotal = res.legs.reduce((a, l) => a + checked.get(l.i + '>' + l.j).s, 0);
      ratio = tableTotal > 0 ? (checkedTotal - tableTotal) / tableTotal : 0;
      if (Math.abs(ratio) > CHECK_RATIO) {
        checked.forEach((v, k) => { const [i, j] = k.split('>').map(Number); table[i][j] = v.s; });
        const res2 = o.solve(table);
        solves++;
        if (res2) {
          const changed = res2.order.join(',') !== res.order.join(',');
          if (changed) await pass(res2.legs);
          res = res2;
        }
      }
    }
    return { result: res, table, checked, solves, checks, ratio };
  }

  // ---------- after DONE / SKIP: live look-ahead ----------
  // Agreement with the current order: how many (x before y) pairs of the current order a new order keeps.
  function agreement(order, current) {
    const pos = new Map(order.map((id, i) => [id, i]));
    let n = 0;
    for (let i = 0; i < current.length; i++) for (let j = i + 1; j < current.length; j++) {
      if (pos.has(current[i]) && pos.has(current[j]) && pos.get(current[i]) < pos.get(current[j])) n++;
    }
    return n;
  }
  // Which pending stops may be visited NEXT: those with no pending stop that must come before them.
  // before = {stopKey: [stopKeys that must precede it]} (pickup before delivery, urgent rules: from Solver.precedence).
  const nextCandidates = (pending, before) => pending.filter((s) => !((before && before[s.key]) || []).some((k) => pending.some((p) => p.key === k)));

  // o = {origin, pending:[node], end, links, before, current:[keys], fullRefreshMax, learned(aKey, bKey) -> sec | null,
  //      fallback(aKey, bKey) -> sec (the plan's own table), fetchLive(a, b) -> Promise<{seconds, metres, typicalSeconds?}>,
  //      solve(leg) -> [{order:[keys], endMs}], arrival(order, leg) -> endMs, minSaveSec?}
  // Returns {mode, requests, live: Map "a>b" -> sec, leg, best, bestEnd, curEnd, saveSec, change, aborted}.
  async function lookAhead(o) {
    const max = o.fullRefreshMax != null ? o.fullRefreshMax : FULL_REFRESH_MAX;
    const mode = o.pending.length > max ? 'first' : 'full';
    const pairs = mode === 'first'
      ? nextCandidates(o.pending, o.before).filter((s) => !samePlace(o.origin, s)).map((s) => [o.origin, s])
      : neededPairs(o.origin, o.pending, o.end, o.links);
    const live = new Map();
    const run = await runFetches(pairs, async ([a, b]) => {
      const r = await o.fetchLive(a, b);
      if (r && r.seconds != null && isFinite(r.seconds)) live.set(a.key + '>' + b.key, r.seconds);
      return r;
    }, { concurrency: o.concurrency });
    const out = { mode, requests: run.started, live, aborted: !!run.down, change: false };
    if (run.down) return out;
    const leg = (a, b) => {
      if (a === b) return 0;
      const k = a + '>' + b;
      if (live.has(k)) return live.get(k);
      const l = o.learned ? o.learned(a, b) : null;
      if (l != null && isFinite(l)) return l;
      return o.fallback ? o.fallback(a, b) : null;
    };
    out.leg = leg;
    const curEnd = o.arrival(o.current, leg);
    const plans = (o.solve(leg) || []).filter((p) => p && p.endMs != null && isFinite(p.endMs)).sort((x, y) => x.endMs - y.endMs);
    out.curEnd = curEnd;
    if (!plans.length || curEnd == null) return out;
    const top = plans[0].endMs;
    const ties = plans.filter((p) => p.endMs - top <= 60000); // within a minute: keep more of the current order
    ties.sort((x, y) => (agreement(y.order, o.current) - agreement(x.order, o.current)) || (x.endMs - y.endMs));
    const best = ties[0];
    out.best = best.order; out.bestEnd = best.endMs;
    out.saveSec = Math.round((curEnd - best.endMs) / 1000);
    out.change = best.order.join(',') !== o.current.join(',') && out.saveSec >= (o.minSaveSec != null ? o.minSaveSec : SWITCH_MIN_SEC);
    return out;
  }

  // What to do with a lookAhead result (F5 / F7): 'switch' (automatic), 'ask' (the card), or 'none' (refresh the ETAs only).
  // o = {res, setting: 'auto'|'ask'|'off', messagedNext (MSG used today for the current next stop), held (Undo: no switch
  // until the next DONE / SKIP)}. In automatic mode a switch that would no longer visit an already-messaged next stop next
  // becomes the "Ask me" card with the extra line.
  function decide(o) {
    const r = o.res;
    if (!r || r.aborted || !r.change || o.held || o.setting === 'off') return { action: 'none' };
    const leavesMessaged = !!o.messagedNext && r.best[0] !== o.current[0];
    if (o.setting === 'ask' || leavesMessaged) return { action: 'ask', messaged: leavesMessaged };
    return { action: 'switch' };
  }
  // "Order updated: next is B (was A) - saves about 14 min" / "Order updated: after A, C then B - saves about 14 min"
  function reorderText(current, best, saveSec, nameOf) {
    const nm = nameOf || ((x) => x);
    const save = ' - saves about ' + Math.max(1, Math.round(saveSec / 60)) + ' min';
    if (best[0] !== current[0]) return 'Order updated: next is ' + nm(best[0]) + ' (was ' + nm(current[0]) + ')' + save;
    const rest = best.slice(1).map(nm);
    return 'Order updated: after ' + nm(best[0]) + ', ' + (rest.length > 1 ? rest.slice(0, -1).join(', ') + ' then ' + rest[rest.length - 1] : rest[0]) + save;
  }
  // The plan's stops with the PENDING ones (no status) put in `order` (placeIds); done / skipped stops keep their places.
  // Nothing is added, removed, skipped or un-skipped: an order that is not exactly the pending set returns null.
  function reorderStops(stops, order) {
    const pend = stops.filter((s) => !s.status);
    if (pend.length !== order.length || !pend.every((s) => order.indexOf(s.placeId) >= 0)) return null;
    const byId = new Map(pend.map((s) => [s.placeId, s]));
    let n = 0;
    return stops.map((s) => (s.status ? s : byId.get(order[n++])));
  }

  // The solver behind lookAhead / twoStep for a set of keys: points = [origin, stops (Solver.buildStops order), end].
  // base = {start, end, jobs, places, departAtISO, noDetour, respectClosedWindows}; post(plan) -> plan (e.g. the lunch break).
  function solverAdapter(Solver, base, post) {
    const stopIds = Solver.buildStops(base.jobs, base.places).stopIds;
    const keys = [ORIGIN].concat(stopIds, [END]);
    const mats = (leg) => [{ departAt: base.departAtISO, m: keys.map((a, i) => keys.map((b, j) => (i === j ? 0 : leg(a, b)))) }];
    const fin = (p) => (post ? post(p) : p);
    return {
      stopIds, keys,
      solve(leg) {
        const r = Solver.solve(Object.assign({}, base, { matrices: mats(leg) }));
        if (r.error) return [];
        return r.plans.map((p) => { const q = fin(p); return { order: q.order, endMs: q.endArrival, plan: q, late: q.violations && q.violations.length }; });
      },
      arrival(order, leg) {
        try { return fin(Solver.evaluate(Object.assign({}, base, { matrices: mats(leg) }), order)).endArrival; } catch (e) { return null; }
      },
    };
  }
  const ORIGIN = '__origin__', END = '__end__';

  // ---------- PLAN with the Routing API (C1-C4) ----------
  // o = {Solver, input: {start, end, jobs, places, departAtISO, noDetour}, start, end (nodes; key '__start__' / '__end__'),
  //      nodeOfStop(placeId) -> node, mem, nowMs, fetchLeg, timed(plan) -> plan (lunch break applied; optional), onProgress?}
  // 5 stops or fewer: every needed pair live (depart = the plan's departure), no check. More: the table for the plan's bucket
  // (learned, else another bucket, else fetched at the bucket's middle), order, check the chosen order's legs at their planned
  // departures (one request per leg), >15% off -> one re-solve (+ one check if the order changed).
  // Returns {res (Solver result; plans timed on the timing table), matrices (timing, est flags), estimated (order on estimates),
  //          requests, tableRequests, checkRequests, checks, solves, live, bucket, down}.
  async function planRoute(o) {
    const Solver = o.Solver, input = o.input, t0 = Date.parse(input.departAtISO), nowMs = o.nowMs;
    const bs = Solver.buildStops(input.jobs, input.places);
    const k = bs.stopIds.length;
    const stops = bs.stopIds.map((pid) => o.nodeOfStop(pid));
    const links = [];
    bs.jobs.forEach((j) => { if (j.deliveryPlaceId) (j.pickups || []).filter((p) => !p.done).forEach((p) => { if (p.placeId !== j.deliveryPlaceId) links.push([p.placeId, j.deliveryPlaceId]); }); });
    const dwellSum = bs.stopIds.reduce((a, pid) => a + (Number(input.places[pid].dwellMin) || 0) * 60, 0);
    const live = k <= LIVE_TABLE_MAX;
    const bucket = planBucket(t0, dwellSum);
    const tab = await buildTable({ start: o.start, stops, end: o.end, links, mem: o.mem, bucket, planMs: t0, nowMs, live, liveDepartMs: t0, fetchLeg: o.fetchLeg, onProgress: o.onProgress });
    let checkRequests = 0, checks = 0, solves = 1;
    const base = { start: input.start, end: input.end, jobs: input.jobs, places: input.places, departAtISO: input.departAtISO, noDetour: !!input.noDetour, respectClosedWindows: !!input.respectClosedWindows };
    const timing = [{ departAt: input.departAtISO, m: tab.m.map((r) => r.slice()), d: tab.d.map((r) => r.slice()), est: tab.est.map((r) => r.slice()) }];
    const solveOn = (m) => Solver.solve(Object.assign({}, base, { matrices: [{ departAt: input.departAtISO, m, d: tab.d, est: tab.est }] }));
    let res;
    if (tab.estimated || live || tab.down) res = solveOn(tab.ord);
    else {
      const legsOf = (p) => { // each leg departs at its planned departure from that solve (dwell, lunch, windows included)
        let q = p;
        if (o.timed) { try { q = o.timed(Solver.retime(p, -1, input.departAtISO)); } catch (e) { q = p; } }
        const seq = [0].concat(q.order.map((pid) => bs.stopIds.indexOf(pid) + 1), [k + 1]);
        const deps = [t0].concat(q.stops.map((x) => x.departAt));
        const L = q.lunch;
        return seq.slice(0, -1).map((a, n) => {
          let at = deps[n];
          const nextPid = n < q.stops.length ? q.stops[n].placeId : null;
          if (L && L.endMs != null && (L.beforePlaceId === nextPid || (L.beforePlaceId == null && nextPid == null))) at = Math.max(at, L.endMs);
          return { i: a, j: seq[n + 1], at };
        });
      };
      const ts = await twoStep({
        table: tab.m,
        solve: (m) => { const r = solveOn(m); return r.error || !r.plans.length ? null : { order: r.plans[0].order, legs: legsOf(r.plans[0]), r }; },
        check: async (legs) => { const got = await checkLegs(legs.map((l) => ({ a: tab.nodes[l.i], b: tab.nodes[l.j], at: l.at })), o.fetchLeg, o.mem, nowMs, { onProgress: o.onProgress }); checkRequests += got.requests; return got; },
      });
      checks = ts.checks; solves = ts.solves;
      res = ts.result ? ts.result.r : solveOn(tab.m);
      ts.checked.forEach((v, key) => { // the times returned for today on the chosen legs (C4)
        const [i, j] = key.split('>').map(Number);
        timing[0].m[i][j] = v.s; if (v.m != null) timing[0].d[i][j] = v.m; timing[0].est[i][j] = false;
      });
    }
    if (!res.error) res = Object.assign({}, res, { plans: res.plans.map((p) => Solver.evaluate(Object.assign({}, base, { matrices: timing }), p.order)) });
    return { res, matrices: timing, estimated: tab.estimated || !!tab.down, requests: tab.requests + checkRequests, tableRequests: tab.requests, checkRequests, checks, solves, live, bucket, down: tab.down, stopIds: bs.stopIds };
  }

  return {
    BUCKETS, LABEL, MAX_SAMPLES, SNAP_M, CONCURRENCY, CHECK_RATIO, SWITCH_MIN_SEC, FULL_REFRESH_MAX, LIVE_TABLE_MAX, ORIGIN, END,
    bucketOf, bucketDepart, planBucket, minOfDay,
    emptyMemory, memKey, medianSample, addSample, learned, pairCount, normaliseMemory, sampleOf, remember, learnedLine,
    snap, neededPairs, runFetches, buildTable, checkLegs, twoStep, planRoute, agreement, nextCandidates, lookAhead, decide, reorderText, reorderStops, solverAdapter,
  };
});
