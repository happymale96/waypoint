#!/usr/bin/env node
/* The TomTom Routing rate limiter (providers.js createLimiter): at most ONE request start every 300 ms, first in
 * first out; a 429 is retried once, through the same limiter, no sooner than 1,200 ms after the 429.
 * Everything runs on a FAKE clock and timer (no test waits in real time):  node test/limiter.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const Providers = require('../providers.js');

let fails = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

// a fake steady clock + timer; drive() runs the pending timers in order, jumping the clock, after each microtask flush
function fakeClock() {
  let t = 0, seq = 0;
  const timers = [];
  const flush = () => new Promise((r) => setImmediate(r)); // microtasks only: no waiting
  const api = {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.push({ id, at: t + Math.max(0, ms), fn }); return id; },
    clearTimer(id) { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    pending: () => timers.length,
    async drive() {
      for (let guard = 0; guard < 100000; guard++) {
        await flush();
        if (!timers.length) return;
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const nx = timers.shift();
        t = Math.max(t, nx.at);
        nx.fn();
      }
      throw new Error('the fake clock did not settle');
    },
    async advanceTo(ms) { // run everything due up to ms, then park the clock there
      for (let guard = 0; guard < 100000; guard++) {
        await flush();
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!timers.length || timers[0].at > ms) break;
        const nx = timers.shift();
        t = Math.max(t, nx.at);
        nx.fn();
      }
      t = Math.max(t, ms);
      await flush();
    },
  };
  return api;
}
const mk = (clk, o) => Providers.createLimiter(Object.assign({ now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer }, o || {}));
// the smallest gap between two consecutive starts (Infinity for fewer than two)
const minGap = (starts) => starts.length < 2 ? Infinity : Math.min(...starts.slice(1).map((x, i) => x - starts[i]));
const evenly = (n, gap) => Array.from({ length: n }, (_, i) => i * gap);

(async () => {
  console.log('1. 12 requests queued at t=0');
  {
    const clk = fakeClock(), lim = mk(clk), starts = [], order = [];
    const ps = Array.from({ length: 12 }, (_, i) => lim.run(() => { starts.push(clk.now()); order.push(i); return i; }));
    const before = starts.length;
    await clk.drive();
    const got = await Promise.all(ps);
    ok(JSON.stringify(starts) === JSON.stringify(evenly(12, 300)) && starts[11] === 3300, 'starts at 0, 300, 600 ... 3,300 ms', starts);
    ok(before === 1, 'only 1 starts at once, the rest wait in the queue', before);
    ok(minGap(starts) >= 300, 'never two starts closer than 300 ms', minGap(starts));
    ok(JSON.stringify(order) === JSON.stringify(got) && order.every((v, i) => v === i), 'first in, first out: started and answered in submission order', order);
  }

  console.log('2. 42 requests queued at t=0 (a 6-stop PLAN with nothing learned)');
  {
    const clk = fakeClock(), lim = mk(clk), starts = [];
    const ps = Array.from({ length: 42 }, () => lim.run(() => { starts.push(clk.now()); return 1; }));
    await clk.drive(); await Promise.all(ps);
    ok(starts.length === 42 && starts[41] === 12300 && starts[40] === 12000, 'the last start is at 12,300 ms', starts.slice(-4));
    ok(JSON.stringify(starts) === JSON.stringify(evenly(42, 300)) && minGap(starts) === 300, 'all 42 on the 300 ms grid', minGap(starts));
    ok(minGap(starts) >= 300, 'never two starts closer than 300 ms', minGap(starts));
  }

  console.log('3. requests arriving over time: one start every 300 ms at most, never early, in arrival order');
  {
    const clk = fakeClock(), lim = mk(clk), starts = [], ps = [];
    const arrivals = [0, 0, 100, 250, 300, 300, 640, 900, 1000, 1001, 1500, 1500, 1500, 1999, 2000, 2000, 2000, 2000, 2000, 5000, 5000, 5000, 5000, 5000, 5000];
    for (const at of arrivals) {
      await clk.advanceTo(at);
      ps.push(lim.run(() => { starts.push(clk.now()); return at; }));
    }
    await clk.drive(); await Promise.all(ps);
    ok(starts.length === arrivals.length, 'every request started', starts.length);
    ok(minGap(starts) >= 300, 'never two starts closer than 300 ms', { gap: minGap(starts), starts });
    ok(starts.every((s, i) => s >= arrivals[i]) && starts.every((s, i) => i === 0 || s >= starts[i - 1]), 'nobody starts before it arrived, and in arrival order', starts);
    const model = []; arrivals.forEach((at, i) => model.push(Math.max(at, i ? model[i - 1] + 300 : 0)));
    ok(JSON.stringify(starts) === JSON.stringify(model), 'each starts as soon as it has arrived and 300 ms have passed since the previous start', { starts, model });
  }

  console.log('4. an error in a request frees its slot and reaches only its caller');
  {
    const clk = fakeClock(), lim = mk(clk), starts = [];
    const bad = lim.run(() => { starts.push(clk.now()); throw new Error('boom'); }).then(() => 'ok', (e) => e.message);
    const rej = lim.run(() => { starts.push(clk.now()); return Promise.reject(new Error('later')); }).then(() => 'ok', (e) => e.message);
    const good = Array.from({ length: 4 }, () => lim.run(() => { starts.push(clk.now()); return 'fine'; }));
    await clk.drive();
    const r1 = await bad, r2 = await rej;
    ok(r1 === 'boom' && r2 === 'later' && (await Promise.all(good)).every((v) => v === 'fine'), 'both failures rejected, the others answered', { r1, r2 });
    ok(starts.length === 6 && JSON.stringify(starts) === JSON.stringify(evenly(6, 300)), 'a failed request still used its start (the request was sent)', starts);
  }

  console.log('5. routeLeg: every attempt goes through the limiter; a 429 retry waits >= 1,200 ms and obeys the spacing');
  {
    ok(Providers.RETRY_MS.length === 1 && Providers.RETRY_MS[0] === 1200, 'one retry, 1,200 ms after the 429', Providers.RETRY_MS);
    const A = { lat: 3.1, lng: 101.6 }, B = { lat: 3.2, lng: 101.7 };
    const res200 = () => ({ ok: true, status: 200, json: async () => ({ routes: [{ summary: { lengthInMeters: 9000, travelTimeInSeconds: 600, historicTrafficTravelTimeInSeconds: 500 } }] }) });
    const res429 = () => ({ ok: false, status: 429, json: async () => ({}) });
    const saved = global.fetch;
    try {
      // (a) alone: 429 at t=0 -> the retry starts at 1,200
      {
        const clk = fakeClock(); Providers.setLimiter(mk(clk));
        const log = []; let n = 0;
        global.fetch = async (url) => { log.push({ at: clk.now(), url: String(url) }); return n++ === 0 ? res429() : res200(); };
        let counted = 0;
        const p = Providers.routeLeg(A, B, null, 'KEY', (k) => { counted += k; });
        await clk.drive();
        const r = await p;
        ok(log.length === 2 && log[0].at === 0 && log[1].at === 1200 && log[0].url === log[1].url, 'a 429 at t=0 is re-sent at 1,200 ms, the same request', log.map((x) => x.at));
        ok(r.seconds === 600 && r.typicalSeconds === 500 && counted === 2, 'the retry\'s answer is the answer; both attempts counted', { r, counted });
      }
      // (b) the queue is busy when the retry is due: 8 requests at t=0, the first answers 429 at t=0
      {
        const clk = fakeClock(); Providers.setLimiter(mk(clk));
        const log = []; let first = true;
        global.fetch = async (url) => { const at = clk.now(); log.push(at); if (first) { first = false; return res429(); } return res200(); };
        const ps = Array.from({ length: 8 }, () => Providers.routeLeg(A, B, null, 'KEY'));
        await clk.drive(); await Promise.all(ps);
        const retry = log[log.length - 1];
        ok(log.length === 9 && retry >= 1200, 'the retry is not sent before 1,200 ms after its 429', log);
        ok(JSON.stringify(log.slice(0, 8)) === JSON.stringify(evenly(8, 300)) && retry === 2400, 'it goes to the back of the same queue (behind the 8 already waiting) -> 2,400 ms', log);
        ok(minGap(log) >= 300, 'never two starts closer than 300 ms, the retry included', minGap(log));
      }
      // (c) a second 429 behaves as before: one friendly "limit" error, no third request
      {
        const clk = fakeClock(); Providers.setLimiter(mk(clk));
        const log = []; const downs = [];
        Providers.setTomTomHook({ count() {}, ok() {}, down: (st) => downs.push(st) });
        global.fetch = async () => { log.push(clk.now()); return res429(); };
        const p = Providers.routeLeg(A, B, null, 'KEY').then(() => null, (e) => e);
        await clk.drive();
        const e = await p;
        ok(log.length === 2 && log[1] === 1200 && e && e.kind === 'limit' && e.status === 429 && downs.length === 1 && downs[0] === 429, 'a second 429: two requests only, the one "limit" error, TomTom marked out', { log, kind: e && e.kind, downs });
        Providers.setTomTomHook(null);
      }
      // (d) a failure of fetch itself (offline) = the one "limit" error with status 0, as before
      {
        const clk = fakeClock(); Providers.setLimiter(mk(clk));
        global.fetch = async () => { throw new TypeError('Failed to fetch'); };
        const p = Providers.routeLeg(A, B, null, 'KEY').then(() => null, (e) => e);
        await clk.drive();
        const e = await p;
        ok(e && e.kind === 'limit' && !e.status, 'unreachable: the same friendly error as before', e && { kind: e.kind, status: e.status });
      }
    } finally { global.fetch = saved; Providers.setLimiter(null); }
  }

  console.log('6. no TomTom Routing request bypasses the limiter');
  {
    const root = path.resolve(__dirname, '..');
    const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');
    const shell = fs.readdirSync(root).filter((f) => /\.js$/.test(f));
    const withUrl = shell.filter((f) => /calculateRoute/.test(src(f)));
    ok(withUrl.length === 1 && withUrl[0] === 'providers.js', 'only providers.js builds a calculateRoute request', withUrl);
    const prov = src('providers.js');
    const fetches = (prov.match(/\bfetch\(/g) || []).length;
    ok(/limiter\.run\(\(\) => fetch\(url\)\)/.test(prov), 'routeLeg sends its fetch through limiter.run');
    ok(fetches === 3, 'providers.js has exactly 3 fetch calls (routeLeg\'s, Google Places, the Matrix API\'s); nothing new bypasses', fetches);
    const app = src('app.js');
    const callers = (app.match(/Providers\.routeLeg\(/g) || []).length;
    ok(callers === 1 && /function ttLeg\([^)]*\) \{\s*return[^;]*Providers\.routeLeg\(/.test(app), 'app.js reaches routeLeg only through ttLeg (table, check legs, live re-time, look-ahead, fuel shortlist)');
    const raw = (app.match(/\bfetch\(/g) || []).length;
    ok(!/api\.tomtom\.com/.test(app) && raw === 0, 'app.js sends no network request of its own', raw);
  }

  console.log(fails ? '\n' + fails + ' FAILED' : '\nall limiter tests passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
