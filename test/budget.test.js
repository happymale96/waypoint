'use strict';
// TomTom budget: the live re-time triggers (Budget.retimeDecision), the usage counters (per day / UTC month) and the 90% guard.
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

console.log('15. counters: per day (Malaysia date) and per UTC calendar month; the month rolls over at 00:00 UTC on the 1st');
{
  const lastMin = Date.UTC(2026, 10, 30, 23, 59, 0); // 30 Nov 23:59 UTC = 1 Dec 07:59 MYT
  const nextMonth = Date.UTC(2026, 11, 1, 0, 0, 1); //  1 Dec 00:00 UTC = 1 Dec 08:00 MYT
  let u = Budget.bump(null, 'routing', Date.UTC(2026, 10, 30, 3, 0, 0), 40); // 30 Nov 11:00 MYT
  u = Budget.bump(u, 'routing', lastMin, 2);
  const c1 = Budget.countOf(u.routing, lastMin);
  ok(c1.month === 42 && c1.today === 2, 'November: 42 this month; 2 today (the Malaysia date is already 1 Dec)', c1);
  const c2 = Budget.countOf(u.routing, nextMonth);
  ok(c2.month === 0 && c2.today === 2, '1 Dec 00:00 UTC: the month starts again at 0 (today still 2: same Malaysia date)', c2);
  u = Budget.bump(u, 'routing', nextMonth, 1);
  ok(Budget.countOf(u.routing, nextMonth).month === 1 && Budget.countOf(u.routing, nextMonth).today === 3, 'the first request of December: month 1, today 3');
  u = Budget.bump(u, 'places', nextMonth, 5);
  ok(Budget.countOf(u.places, nextMonth).month === 5 && Budget.countOf(u.matrix, nextMonth).month === 0, 'Places counted on their own; Matrix stays 0');
  const L = Budget.usageLines(u, nextMonth, 20000, 5);
  ok(L.routing === 'TomTom Routing   3 today · 1 this month of 20,000' && L.places === 'Google Places    5 today · 5 this month  (daily guard 140)' && L.matrix === null, 'the Usage card lines (Matrix hidden while 0)', L);
  const L2 = Budget.usageLines(Budget.bump(u, 'matrix', nextMonth, 1), nextMonth, 20000, 5);
  ok(L2.matrix === 'TomTom Matrix    1 today · 1 this month', 'Matrix shown once it is above 0', L2.matrix);
  ok(!/08:00|resets/.test(JSON.stringify(L) + Budget.DOWN_MSG + Budget.GUARD_MSG), 'no daily-reset / 08:00 wording anywhere');
  ok(Budget.DOWN_MSG === 'TomTom unavailable or monthly allowance used up - using estimated times', 'the banner text');
}

console.log('A. Google Places: today AND this month from one record, counted the way TomTom is');
{
  const d1 = Date.UTC(2026, 10, 24, 3, 0, 0); // 24 Nov 11:00 MYT
  const d2 = Date.UTC(2026, 10, 25, 3, 0, 0); // 25 Nov, same month
  const d3 = Date.UTC(2026, 11, 1, 3, 0, 0);  //  1 Dec, a new month
  const card = (u, ms) => Budget.usageLines(u, ms, 20000, 0).places; // an old separate "today" figure (0) must not be used
  let u = { routing: Budget.addCount(null, d1, 19) };
  u = Budget.countPlaces(u, d1);
  const p1 = Budget.placesCount(u, d1);
  ok(p1.today === 1 && p1.month === 1, 'one Places request: today 1, month 1', p1);
  ok(card(u, d1) === 'Google Places    1 today · 1 this month  (daily guard 140)', 'the Usage card line: 1 today · 1 this month', card(u, d1));
  ok(Budget.countOf(u.routing, d1).today === 19 && Budget.countOf(u.routing, d1).month === 19, 'TomTom Routing untouched (19 · 19)');
  u = Budget.countPlaces(u, d2);
  const p2 = Budget.placesCount(u, d2);
  ok(p2.today === 1 && p2.month === 2, 'a second request the next day, same month: today 1, month 2', p2);
  ok(card(u, d2) === 'Google Places    1 today · 2 this month  (daily guard 140)', 'the card the next day', card(u, d2));
  u = Budget.countPlaces(u, d3);
  const p3 = Budget.placesCount(u, d3);
  ok(p3.today === 1 && p3.month === 1, 'the first request of a new month: today 1, month 1', p3);

  console.log('A3. one-time repair: this month never below today (never lowers a number)');
  const day = Budget.dayKey(d1), mon = Budget.monthKey(d1);
  let r = Budget.repairPlacesMonth({ routing: u.routing }, { date: day, count: 1 }, d1); // the phone: old today 1, no month
  ok(r.changed && Budget.placesCount(r.usage, d1).today === 1 && Budget.placesCount(r.usage, d1).month === 1 && r.usage.routing === u.routing, 'old today 1, month 0 -> today 1, month 1 (Routing kept)', r.usage.places);
  r = Budget.repairPlacesMonth({ places: { day, d: 1, month: mon, m: 0 } }, null, d1);
  ok(r.changed && Budget.placesCount(r.usage, d1).month === 1, 'stored month 0 < stored today 1 -> month 1', r.usage.places);
  r = Budget.repairPlacesMonth({ places: { day, d: 1, month: mon, m: 0 } }, { date: day, count: 3 }, d1);
  ok(Budget.placesCount(r.usage, d1).today === 3 && Budget.placesCount(r.usage, d1).month === 3, 'the higher of the two "today" figures wins; month raised to it', r.usage.places);
  const fine = { places: { day, d: 2, month: mon, m: 9 } };
  r = Budget.repairPlacesMonth(fine, { date: day, count: 1 }, d1);
  ok(!r.changed && r.usage === fine, 'month 9 >= today 2: nothing changes (never lowers)', r.usage.places);
  r = Budget.repairPlacesMonth(fine, { date: '2026-11-23', count: 50 }, d1);
  ok(!r.changed, 'an old counter from another day is ignored');
  const once = Budget.repairPlacesMonth({}, { date: day, count: 2 }, d1).usage;
  ok(!Budget.repairPlacesMonth(once, { date: day, count: 2 }, d1).changed, 'running it again changes nothing');
}

console.log('15. 90% of the monthly allowance pauses the automatic re-times and the look-ahead only');
{
  const t = Date.UTC(2026, 10, 24, 5, 0, 0);
  const below = Budget.bump(null, 'routing', t, 17999), at90 = Budget.bump(null, 'routing', t, 18000);
  ok(!Budget.guardHit(below, t, 20000) && Budget.guardHit(at90, t, 20000), '20,000 allowance: 17,999 not paused, 18,000 (90%) paused');
  ok(Budget.guardHit(Budget.bump(null, 'routing', t, 900), t, 1000) && !Budget.guardHit(Budget.bump(null, 'routing', t, 899), t, 1000), 'the allowance is editable (1,000 -> 900)');
  ok(!Budget.guardHit(at90, Date.UTC(2026, 11, 1, 0, 0, 1), 20000), 'the next UTC month: the pause is lifted');
  const st = { lastAt: t - 30 * MIN };
  const dec = (type) => Budget.retimeDecision(st, { type, at: t, visible: true, pending: true, guard: Budget.guardHit(at90, t, 20000) });
  ok(!dec('tick').call && dec('tick').why === 'guard' && !dec('visible').call, 'paused: the 10-minute and the on-visible re-times');
  ok(dec('plan').call && dec('tap').call && dec('done').call && dec('skip').call, 'not paused: PLAN, tapped re-times, DONE / SKIP re-times');
  ok(Budget.afterStopMode({ setting: 'auto', pending: 3, guard: true }) === 'single' && Budget.afterStopMode({ setting: 'auto', pending: 3, guard: false }) === 'lookahead', 'paused: the after-stop look-ahead (DONE falls back to a single next-stop re-time)');
  ok(Budget.afterStopMode({ setting: 'auto', pending: 1 }) === 'single' && Budget.afterStopMode({ setting: 'off', pending: 4 }) === 'single' && Budget.afterStopMode({ setting: 'ask', pending: 2 }) === 'lookahead', 'look-ahead only with 2+ pending and the setting not Off');
  ok(Budget.afterStopMode({ setting: 'auto', pending: 3, down: true }) === 'single', 'TomTom unavailable: no look-ahead');
}

console.log('live origin: counts down until the next re-time');
{
  const t = 1e12;
  ok(Budget.originKept({ usedAt: t }, t + 14 * MIN) && !Budget.originKept({ usedAt: t }, t + 16 * MIN), 'a live TomTom time is kept 15 min (longer than the 10-minute period)');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
