'use strict';
// Part E: keep the screen on while a day is running (wakelock.js), with a mocked navigator.wakeLock. No real clock is read: the
// keeper itself never looks at the time (the app decides "a day is running"). Run: node test/wakelock.test.js
const WakeKeep = require('../wakelock.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
Date.now = () => Date.UTC(2026, 10, 25, 1, 0); // pinned (not used by the keeper)

// a mocked navigator.wakeLock: request('screen') resolves a sentinel (or rejects when told to); release() fires 'release'
function mockNav(o) {
  o = o || {};
  const log = { requests: 0, releases: 0, types: [] };
  const nav = { wakeLock: { request(type) {
    log.requests++; log.types.push(type);
    if (o.reject) return Promise.reject(new Error('NotAllowedError: battery saver'));
    const ls = [];
    const s = { released: false, addEventListener: (ev, fn) => { if (ev === 'release') ls.push(fn); },
      release() { if (!s.released) { s.released = true; log.releases++; ls.forEach((f) => f()); } return Promise.resolve(); } };
    log.last = s;
    return Promise.resolve(s);
  } } };
  return { nav, log };
}
// the app's world: is a day running (plan for today, End day not tapped), the toggle, the page visible
function world(navObj) {
  const w = { running: false, toggle: true, visible: true, states: [] };
  w.k = WakeKeep.create({ nav: () => navObj, wanted: () => w.toggle && w.running, visible: () => w.visible, onChange: (s) => w.states.push(s) });
  return w;
}

(async () => {
  console.log('requested after PLAN');
  {
    const m = mockNav(), w = world(m.nav);
    await w.k.sync(); // launch, no plan
    ok(m.log.requests === 0, 'no day running: not requested');
    w.running = true; // PLAN made today's plan
    await w.k.sync({ retry: true });
    ok(m.log.requests === 1 && m.log.types[0] === 'screen', 'requested once, type "screen"', m.log);
    ok(w.k.state() === 'held' && WakeKeep.STATUS_TEXT[w.k.state()] === 'Screen lock held', 'state: Screen lock held');
    await w.k.sync(); await w.k.sync(); // every render
    ok(m.log.requests === 1, 'not requested again while held (renders)');
  }
  console.log('requested again when the page becomes visible during a running day');
  {
    const m = mockNav(), w = world(m.nav);
    w.running = true;
    await w.k.sync({ retry: true });
    w.visible = false; m.log.last.release(); // the browser releases it when the page is hidden
    ok(w.k.state() === 'idle', 'released by the browser: not held');
    await w.k.sync(); // a render while hidden
    ok(m.log.requests === 1, 'not requested while hidden');
    w.visible = true; await w.k.sync({ retry: true }); // visibilitychange -> visible
    ok(m.log.requests === 2 && w.k.state() === 'held', 'requested again on visible', m.log);
  }
  console.log('released on End day');
  {
    const m = mockNav(), w = world(m.nav);
    w.running = true;
    await w.k.sync({ retry: true });
    w.running = false; // End day closed the day
    await w.k.sync();
    ok(m.log.releases === 1 && w.k.state() === 'idle' && !w.k.held(), 'released, nothing held', m.log);
    await w.k.sync();
    ok(m.log.requests === 1, 'no day running: not requested again');
  }
  console.log('never requested with the toggle off');
  {
    const m = mockNav(), w = world(m.nav);
    w.toggle = false; w.running = true;
    await w.k.sync({ retry: true }); await w.k.sync();
    ok(m.log.requests === 0, 'toggle off: never requested');
    w.toggle = true; await w.k.sync({ retry: true });
    ok(m.log.requests === 1, 'toggle on again: requested');
    w.toggle = false; await w.k.sync();
    ok(m.log.releases === 1, 'toggle off while held: released');
  }
  console.log('no exception when the API is missing or the request rejects');
  {
    let threw = false;
    const w = world({}); // no wakeLock
    w.running = true;
    try { await w.k.sync({ retry: true }); } catch (e) { threw = true; }
    ok(!threw && w.k.state() === 'unavailable', 'API missing: carries on, state unavailable');
    ok(WakeKeep.STATUS_TEXT.unavailable === 'Not available on this phone right now', 'the line reads "Not available on this phone right now"');
    const w0 = world(null); w0.running = true;
    try { await w0.k.sync({ retry: true }); } catch (e) { threw = true; }
    ok(!threw, 'no navigator at all: no exception');
    const m = mockNav({ reject: true }), w2 = world(m.nav);
    w2.running = true;
    try { await w2.k.sync({ retry: true }); } catch (e) { threw = true; }
    ok(!threw && w2.k.state() === 'unavailable', 'request rejected (battery saver): no exception, state unavailable');
    await w2.k.sync(); await w2.k.sync(); await w2.k.sync();
    ok(m.log.requests === 1, 'no retry loop: renders do not ask again', m.log);
    await w2.k.sync({ retry: true });
    ok(m.log.requests === 2, 'asked again only on the next visible / PLAN', m.log);
  }
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
