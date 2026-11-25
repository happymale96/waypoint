/* L-Tech Waypoint — wakelock.js
 * Keep the screen on while a day is running (Settings -> "Keep screen on while a day is running", default on). A web app only gets GPS
 * while it is visible, so a phone that dims and locks stops auto-Reached. Uses the Screen Wake Lock API (navigator.wakeLock.request
 * ('screen')), feature-detected: missing API or a rejected request (battery saver, ...) = carry on silently (no banner, no retry loop;
 * the next sync() tries once more).
 *
 *   const k = WakeKeep.create({ nav: () => navigator, wanted: () => bool, visible: () => bool, onChange(state) })
 *   k.sync(o)   request when wanted and visible and not held; release when not wanted. The browser releases the lock whenever the
 *               page is hidden: call sync({retry:true}) on every visibilitychange to visible and after PLAN (a rejected request is
 *               asked again only then); the app calls sync() on every render (End day releases).
 *   k.state()   'held' | 'unavailable' (no API, or the last request was rejected) | 'idle' (not wanted, or released by the browser)
 *   STATUS_TEXT the one small line under the Settings toggle ('' = no line)
 * Exports via module.exports (node) or window.WakeKeep.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WakeKeep = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUS_TEXT = { held: 'Screen lock held', unavailable: 'Not available on this phone right now', idle: '' };
  const hasApi = (nav) => !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function');

  function create(o) {
    let sentinel = null, pending = null, state = 'idle';
    const set = (s) => { if (s !== state) { state = s; try { if (o.onChange) o.onChange(s); } catch (e) { /* never break the page */ } } };
    const wanted = () => { try { return !!o.wanted(); } catch (e) { return false; } };
    const visible = () => { try { return o.visible ? !!o.visible() : true; } catch (e) { return true; } };
    async function release() {
      const s = sentinel;
      sentinel = null;
      if (s && !s.released) { try { await s.release(); } catch (e) { /* already gone */ } }
      set('idle');
    }
    async function request(nav) {
      try {
        const s = await nav.wakeLock.request('screen');
        if (!s) { set('unavailable'); return; }
        sentinel = s;
        try { if (typeof s.addEventListener === 'function') s.addEventListener('release', () => { if (sentinel === s) { sentinel = null; set('idle'); } }); } catch (e) { /* ignore */ }
        if (!wanted()) { await release(); return; } // the day ended while the request was out
        set('held');
      } catch (e) { sentinel = null; set('unavailable'); }
    }
    // retry = a fresh occasion (the page became visible, PLAN): only then is a rejected request asked again (no retry loop)
    async function sync(opts) {
      try {
        if (!wanted()) { if (sentinel || state !== 'idle') await release(); return; }
        if (!visible()) return; // hidden: the browser holds nothing; asked again when the page is visible
        if (sentinel && !sentinel.released) { set('held'); return; }
        if (state === 'unavailable' && !(opts && opts.retry)) return;
        let nav = null;
        try { nav = o.nav(); } catch (e) { nav = null; }
        if (!hasApi(nav)) { set('unavailable'); return; }
        if (pending) return pending;
        pending = request(nav).finally(() => { pending = null; });
        return pending;
      } catch (e) { set('unavailable'); }
    }
    return { sync, release, state: () => state, held: () => !!(sentinel && !sentinel.released) };
  }

  return { create, STATUS_TEXT, hasApi };
});
