'use strict';
// TomTom budget: the live re-time triggers (Budget.retimeDecision) and the daily counter / guard (UTC day).
// Run as its own node script: node test/budget.test.js
const Budget = require('../budget.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const MIN = 60000, SEC = 1000;

console.log('triggers: 30 min driving, watch every 10 s, DONE at 12, visible at 20');
{
  const T0 = Date.UTC(2026, 10, 24, 1, 0, 0); // 09:00 MYT
  const evs = [{ type: 'plan', at: T0 }];
  for (let t = 0; t <= 30 * 60; t += 10) evs.push({ type: 'watch', at: T0 + t * SEC });
  for (let m = 1; m <= 30; m++) evs.push({ type: 'tick', at: T0 + m * MIN }); // the app's minute timer
  evs.push({ type: 'done', at: T0 + 12 * MIN }, { type: 'visible', at: T0 + 20 * MIN });
  const rank = { plan: 0, watch: 1, tick: 2, done: 3, visible: 3 }; // same instant: the watch fix, the timer, then the tap / event
  evs.sort((a, b) => a.at - b.at || rank[a.type] - rank[b.type]);
  let st = { lastAt: null };
  const calls = [];
  let watchCalls = 0, watchSeen = 0;
  evs.forEach((e) => {
    const d = Budget.retimeDecision(st, Object.assign({ visible: true, pending: true, guard: false }, e));
    st = d.state;
    if (e.type === 'watch') { watchSeen++; if (d.call) watchCalls++; }
    if (d.call) calls.push({ min: (e.at - T0) / MIN, type: e.type });
  });
  ok(watchSeen === 181 && watchCalls === 0, 'NO watch update on its own calls TomTom (181 updates, 0 calls)', { watchSeen, watchCalls });
  const want = [{ min: 0, type: 'plan' }, { min: 10, type: 'tick' }, { min: 12, type: 'done' }, { min: 20, type: 'visible' }, { min: 30, type: 'tick' }];
  ok(JSON.stringify(calls) === JSON.stringify(want), 'calls exactly at minute 0 (PLAN), 10 (periodic), 12 (DONE), 20 (visible), 30 (periodic from the last call)', calls);
}

console.log('triggers: gaps, always, hidden, idle');
{
  const t = Date.UTC(2026, 10, 24, 2, 0, 0);
  const st = { lastAt: t };
  const dec = (type, dt, extra) => Budget.retimeDecision(st, Object.assign({ type, at: t + dt, visible: true, pending: true, guard: false }, extra || {})).call;
  ok(!dec('visible', 4 * MIN + 59 * SEC) && dec('visible', 5 * MIN), 'visible: under 5 min after the last re-time no, from 5 min yes');
  ok(!dec('edit', 2 * MIN) && dec('edit', 5 * MIN), 'fuel added / removed (edit): the same 5-min gap');
  ok(!dec('tick', 9 * MIN + 59 * SEC) && dec('tick', 10 * MIN), 'tick: every 10 min from the last re-time');
  ok(['plan', 'done', 'skip', 'undo', 'reached', 'tap'].every((k) => dec(k, 1 * SEC)), 'PLAN / DONE / SKIP / Undo / Reached / tap: always, even 1 s after a re-time');
  ok(!dec('tick', 20 * MIN, { visible: false }) && !dec('tick', 20 * MIN, { pending: false }), 'tick: never while hidden or with no stop pending');
  ok(!dec('watch', 60 * MIN) && !Budget.retimeDecision({ lastAt: null }, { type: 'watch', at: t }).call, 'watch: never, however long since the last call');
  const d0 = Budget.retimeDecision({ lastAt: t }, { type: 'visible', at: t + MIN, visible: true, pending: true });
  ok(d0.state.lastAt === t, 'a refused trigger does not move the throttle');
  ok(Budget.retimeDecision({ lastAt: null }, { type: 'visible', at: t, visible: true }).call, 'the first visible (launch) with no re-time yet: yes');
}

console.log('counter: UTC day rollover (08:00 Malaysia time)');
{
  const before = Date.UTC(2026, 10, 23, 23, 59, 0); // 24 Nov 07:59 MYT
  const after = Date.UTC(2026, 10, 24, 0, 0, 1); //   24 Nov 08:00 MYT
  let rec = Budget.addUsage(null, before, 3, 192);
  rec = Budget.addUsage(rec, before, 1, 1);
  ok(rec.day === '2026-11-23' && rec.requests === 4 && rec.cells === 193, 'counts requests and cells on the UTC day', rec);
  const u = Budget.usage(rec, after);
  ok(u.day === '2026-11-24' && u.requests === 0 && u.cells === 0, 'at 08:00 MYT (00:00 UTC) the day rolls over to 0 / 0', u);
  const r2 = Budget.addUsage(rec, after, 1, 1);
  ok(r2.day === '2026-11-24' && r2.requests === 1 && r2.cells === 1, 'the first call of the new day starts from 0', r2);
  ok(Budget.usageLine(Budget.addUsage(null, after, 12, 1234), after) === 'TomTom today: 12 requests / 1,234 cells (free limit 2,500 per day, resets 08:00 Malaysia time)', 'Settings line wording', Budget.usageLine(Budget.addUsage(null, after, 12, 1234), after));
  ok(Budget.usageLine(null, after) === 'TomTom today: 0 requests / 0 cells (free limit 2,500 per day, resets 08:00 Malaysia time)', 'no usage yet: 0 / 0');
}

console.log('guard at 2,000 (the larger of requests and cells)');
{
  const t = Date.UTC(2026, 10, 24, 5, 0, 0);
  const low = Budget.addUsage(null, t, 1999, 1999);
  ok(!Budget.guardHit(low, t), '1,999 / 1,999: not hit');
  const byCells = Budget.addUsage(null, t, 30, 2000), byReq = Budget.addUsage(null, t, 2000, 10);
  ok(Budget.guardHit(byCells, t) && Budget.guardHit(byReq, t), 'hit at 2,000 cells (30 requests) and at 2,000 requests (10 cells)');
  const st = { lastAt: t - 30 * MIN };
  const dec = (type) => Budget.retimeDecision(st, { type, at: t, visible: true, pending: true, guard: Budget.guardHit(byCells, t) });
  ok(!dec('tick').call && dec('tick').why === 'guard' && !dec('visible').call, 'guard: the automatic re-times (10-minute tick, visible) stop');
  ok(dec('plan').call && dec('done').call && dec('skip').call && dec('undo').call && dec('tap').call, 'guard: PLAN, DONE-driven and tapped re-times continue');
  const next = Date.UTC(2026, 10, 25, 0, 0, 1);
  ok(!Budget.guardHit(byCells, next), 'the next UTC day: the guard is lifted');
}

console.log('live origin: counts down until the next re-time');
{
  const t = 1e12;
  ok(Budget.originKept({ usedAt: t }, t + 14 * MIN) && !Budget.originKept({ usedAt: t }, t + 16 * MIN), 'a live TomTom time is kept 15 min (longer than the 10-minute period)');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
