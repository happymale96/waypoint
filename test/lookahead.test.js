'use strict';
// After each stop: the live look-ahead (TravelTimes.lookAhead) with the real solver (TravelTimes.solverAdapter), the decision
// (TravelTimes.decide) and the re-order (TravelTimes.reorderStops). Scenarios 17 (first-leg probe), 18 (full refresh, the
// owner's example) and 19 (a jam two legs ahead). Every clock is pinned; dwell 0.
// Run as its own node script: node test/lookahead.test.js
const TT = require('../traveltimes.js');
const Solver = require('../solver.js');
const Budget = require('../budget.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const NOW = Date.UTC(2026, 10, 24, 3, 0); // 11:00 Malaysia time
const O = TT.ORIGIN, E = TT.END;

const LL = { X: [3.10, 101.60], A: [3.12, 101.62], B: [3.14, 101.64], C: [3.16, 101.66], D: [3.18, 101.68], E: [3.08, 101.70] };
const places = {};
Object.keys(LL).forEach((id) => { places[id] = { id, name: id, lat: LL[id][0], lng: LL[id][1], type: 'other', dwellMin: 0, closedWindows: [] }; });
const job = (id, o) => Object.assign({ id, pickups: [], deliveryPlaceId: null, notes: '', urgent: false, urgentRank: 0, arriveBefore: null, arriveAfter: null, status: 'pending', createdAt: id }, o);
const errand = (id, pid) => job(id, { errandPlaceId: pid, dwellMin: 0 });
const nd = (key, pid) => ({ key, pid, lat: places[pid].lat, lng: places[pid].lng });
const k2 = (a, b) => (a === O ? 'X' : a) + '>' + (b === E ? 'E' : b);

// run one look-ahead. learnedMin / liveMin: {"A>B": minutes} with X = the origin, E = the end point.
async function run(o) {
  const pending = o.pending.map((p) => nd(p, p));
  const base = { start: places[o.at || 'X'], end: places.E, jobs: o.jobs, places, departAtISO: new Date(NOW).toISOString(), noDetour: false };
  const prec = Solver.precedence(base);
  const links = [];
  o.jobs.forEach((j) => { if (j.deliveryPlaceId) (j.pickups || []).filter((p) => !p.done).forEach((p) => links.push([p.placeId, j.deliveryPlaceId])); });
  const calls = [];
  const ad = TT.solverAdapter(Solver, base, null);
  const res = await TT.lookAhead({
    origin: nd(O, o.at || 'X'), pending, end: nd(E, 'E'), links, before: prec.before, current: o.current,
    fullRefreshMax: o.fullRefreshMax,
    learned: (a, b) => { const v = o.learned[k2(a, b)]; return v == null ? null : v * 60; },
    fallback: () => 9999 * 60,
    fetchLive: async (a, b) => { calls.push(k2(a.key, b.key)); const v = o.live[k2(a.key, b.key)]; return { seconds: (v != null ? v : o.learned[k2(a.key, b.key)]) * 60, metres: 1000, typicalSeconds: null }; },
    solve: (leg) => ad.solve(leg), arrival: (order, leg) => ad.arrival(order, leg),
  });
  return { res, calls };
}
// the app's after-stop path: the mode rule, then the look-ahead, then the decision. Returns what happened.
async function afterStop(o) {
  const mode = Budget.afterStopMode({ setting: o.setting || 'auto', pending: o.pending.length, guard: !!o.guard, down: false });
  if (mode !== 'lookahead') return { mode, lookAheadRequests: 0, singleRetime: 1, order: o.current };
  const r = await run(o);
  const d = TT.decide({ res: r.res, setting: o.setting || 'auto', current: o.current, messagedNext: !!o.messagedNext });
  const stops = o.current.map((id) => ({ placeId: id }));
  let order = o.current, notice = null, card = null, undo = null;
  if (d.action === 'switch') {
    const prev = JSON.parse(JSON.stringify(stops));
    order = TT.reorderStops(stops, r.res.best).map((s) => s.placeId);
    notice = TT.reorderText(o.current, r.res.best, r.res.saveSec) + ' · Undo';
    undo = () => prev.map((s) => s.placeId);
  } else if (d.action === 'ask') card = { text: TT.reorderText(o.current, r.res.best, r.res.saveSec), extra: d.messaged ? o.current[0] + ' was already messaged' : null, buttons: ['Switch', 'Keep mine'] };
  return { mode, lookAheadRequests: r.calls.length, calls: r.calls, res: r.res, order, notice, card, undo, action: d.action };
}

(async () => {
  const learned17 = { 'A>B': 10, 'B>A': 10, 'A>C': 20, 'C>A': 20, 'B>C': 10, 'C>B': 10, 'A>E': 30, 'B>E': 30, 'C>E': 30 };
  const jobs3 = [errand('j1', 'A'), errand('j2', 'B'), errand('j3', 'C')];
  const base17 = { pending: ['A', 'B', 'C'], current: ['A', 'B', 'C'], jobs: jobs3, learned: learned17, fullRefreshMax: 0 };

  console.log('17. first-leg probe (fullRefreshMax 0, so 3 pending counts as "more")');
  const a = await afterStop(Object.assign({}, base17, { live: { 'X>A': 60, 'X>B': 15, 'X>C': 25 } }));
  ok(a.res.mode === 'first' && a.lookAheadRequests === 3 && a.calls.sort().join() === 'X>A,X>B,X>C', 'a: 3 requests, origin -> each stop that may come next', a.calls);
  ok(Math.round((a.res.curEnd - NOW) / 60000) === 110, 'a: current A, B, C = 60 + 10 + 10 + 30 = 110 min', (a.res.curEnd - NOW) / 60000);
  ok(a.res.best.join() === 'B,A,C' && Math.round((a.res.bestEnd - NOW) / 60000) === 75, 'a: best B, A, C = 75 (tie with B, C, A: keeps more of the current order)', a.res.best);
  ok(a.action === 'switch' && a.order.join() === 'B,A,C' && a.res.saveSec === 35 * 60, 'a: saving 35 -> automatic mode switches to B, A, C', { action: a.action, order: a.order });
  ok(a.notice === 'Order updated: next is B (was A) - saves about 35 min · Undo', 'a: the notice', a.notice);
  ok(a.undo().join() === 'A,B,C', 'a: Undo restores A, B, C exactly');
  const aAsk = await afterStop(Object.assign({}, base17, { setting: 'ask', live: { 'X>A': 60, 'X>B': 15, 'X>C': 25 } }));
  ok(aAsk.action === 'ask' && aAsk.order.join() === 'A,B,C' && aAsk.card.buttons.join() === 'Switch,Keep mine', 'a: "Ask me" shows the card and does not switch');

  const b = await afterStop(Object.assign({}, base17, { live: { 'X>A': 22, 'X>B': 15, 'X>C': 25 } }));
  ok(b.lookAheadRequests === 3 && Math.round((b.res.curEnd - NOW) / 60000) === 72 && b.action === 'none' && b.order.join() === 'A,B,C', 'b: current 72, best alternative 75 -> nothing happens', { cur: (b.res.curEnd - NOW) / 60000, action: b.action });

  const c = await afterStop(Object.assign({}, base17, { live: { 'X>A': 30, 'X>B': 15, 'X>C': 25 } }));
  ok(c.lookAheadRequests === 3 && Math.round((c.res.curEnd - NOW) / 60000) === 80 && c.res.saveSec === 5 * 60 && c.action === 'none', 'c: current 80, best 75, saving 5 < 10 -> nothing happens', { save: c.res.saveSec, action: c.action });

  const jobsD = [job('j1', { pickups: [{ placeId: 'A', item: 'box' }], deliveryPlaceId: 'B' }), errand('j3', 'C')];
  const d = await afterStop(Object.assign({}, base17, { jobs: jobsD, live: { 'X>A': 60, 'X>B': 15, 'X>C': 25 } }));
  ok(d.lookAheadRequests === 2 && !d.calls.includes('X>B'), 'd: B is a delivery whose pickup A is not done: not a candidate (2 requests)', d.calls);
  ok(d.res.best.indexOf('A') < d.res.best.indexOf('B'), 'd: no order puts B before A', d.res.best);
  const dIn = { start: places.X, end: places.E, jobs: jobsD, places, departAtISO: new Date(NOW).toISOString() };
  ok(TT.solverAdapter(Solver, dIn, null).solve(() => 600).every((p) => p.order.indexOf('A') < p.order.indexOf('B')), 'd: every order the solver offers keeps A before B');

  const e = await afterStop(Object.assign({}, base17, { guard: true, live: { 'X>A': 60, 'X>B': 15, 'X>C': 25 } }));
  ok(e.lookAheadRequests === 0 && e.order.join() === 'A,B,C' && e.singleRetime === 1, 'e: allowance guard on -> 0 look-ahead requests, no switch (a single next-stop re-time)');

  const f = await afterStop(Object.assign({}, base17, { messagedNext: true, live: { 'X>A': 60, 'X>B': 15, 'X>C': 25 } }));
  ok(f.lookAheadRequests === 3 && f.action === 'ask' && f.order.join() === 'A,B,C' && f.card.extra === 'A was already messaged', 'f: MSG already used today for A -> no switch; the card with "A was already messaged"', f.card);

  const g = await afterStop(Object.assign({}, base17, { setting: 'off', live: { 'X>A': 60, 'X>B': 15, 'X>C': 25 } }));
  ok(g.lookAheadRequests === 0 && g.singleRetime === 1 && g.order.join() === 'A,B,C', 'g: setting Off -> 0 look-ahead requests; a single next-stop re-time');
  ok([a, b, c, d, e, f, g].map((x) => x.lookAheadRequests).join() === '3,3,3,2,0,3,0', 'look-ahead request counts: a 3, b 3, c 3, d 2, e 0, f 3, g 0');
  ok(TT.reorderText(['A', 'B', 'C'], ['A', 'C', 'B'], 14 * 60) === 'Order updated: after A, C then B - saves about 14 min', 'the notice when the next stop is unchanged');

  console.log('18. full refresh (default fullRefreshMax 5): the owner\'s example');
  {
    const learned = { 'X>C': 40, 'X>D': 35, 'C>D': 30, 'D>C': 30, 'C>E': 20, 'D>E': 20 }; // X = B, the stop just done
    const r = await afterStop({ at: 'B', pending: ['C', 'D'], current: ['C', 'D'], jobs: [errand('j1', 'C'), errand('j2', 'D')], learned, live: { 'X>C': 95, 'X>D': 35, 'C>D': 30, 'D>C': 30, 'C>E': 20, 'D>E': 20 } });
    ok(r.res.mode === 'full' && r.lookAheadRequests === 6, 'requests = 6', r.calls);
    ok(Math.round((r.res.curEnd - NOW) / 60000) === 145 && Math.round((r.res.bestEnd - NOW) / 60000) === 85, 'current C, D = 145; D, C = 85');
    ok(r.res.saveSec === 60 * 60 && r.action === 'switch' && r.order.join() === 'D,C', 'saving 60 -> switch to D, C', r.order);
  }

  console.log('19. a full refresh sees a jam TWO legs ahead');
  {
    const learned = { 'X>A': 10, 'X>B': 20, 'X>C': 20, 'A>B': 10, 'B>A': 10, 'A>C': 10, 'C>A': 10, 'B>C': 10, 'C>B': 10, 'A>E': 10, 'B>E': 10, 'C>E': 10 };
    const live = Object.assign({}, learned, { 'B>C': 70 });
    const o = { pending: ['A', 'B', 'C'], current: ['A', 'B', 'C'], jobs: jobs3, learned, live };
    const r = await afterStop(o);
    ok(r.res.mode === 'full' && r.lookAheadRequests === 12, 'requests = 12', r.lookAheadRequests);
    ok(Math.round((r.res.curEnd - NOW) / 60000) === 100 && r.res.best.join() === 'A,C,B' && Math.round((r.res.bestEnd - NOW) / 60000) === 40, 'current 100; best A, C, B = 40', r.res.best);
    ok(r.action === 'switch' && r.order.join() === 'A,C,B' && r.res.saveSec === 60 * 60, 'saving 60 -> switch to A, C, B');
    ok(r.notice === 'Order updated: after A, C then B - saves about 60 min · Undo', 'the notice names the unchanged next stop', r.notice);
    const r0 = await afterStop(Object.assign({}, o, { fullRefreshMax: 0 }));
    ok(r0.lookAheadRequests === 3 && !r0.calls.includes('B>C') && r0.action === 'none' && r0.order.join() === 'A,B,C', 'fullRefreshMax 0 on the same data: 3 requests, B->C not fetched, no switch', r0.calls);
  }

  console.log('F8: the look-ahead only re-orders');
  ok(TT.reorderStops([{ placeId: 'A', status: 'done' }, { placeId: 'B' }, { placeId: 'C', status: 'skipped' }, { placeId: 'D' }], ['D', 'B']).map((s) => s.placeId + (s.status ? ':' + s.status : '')).join() === 'A:done,D,C:skipped,B', 'done / skipped stops keep their places, the pending ones take the new order');
  ok(TT.reorderStops([{ placeId: 'B' }, { placeId: 'D' }], ['D', 'B', 'C']) === null && TT.reorderStops([{ placeId: 'B' }, { placeId: 'D' }], ['D']) === null, 'an order that adds or drops a stop is refused');

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
