/* L-Tech Waypoint — storage.js
 * Persistence behind an async interface so a hosted backend can replace it later:
 *   get(col, id) / set(col, id, value) / list(col) / remove(col, id)
 * Collections used: "places", "jobs", "settings" (single doc id "main").
 * Backend today: localStorage (falls back to memory if unavailable).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.WPStore = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const PREFIX = 'waypoint:';
  const mem = new Map();
  function ls() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  const key = (col, id) => PREFIX + col + ':' + id;

  function rawGet(k) {
    const s = ls();
    try { if (s) return s.getItem(k); } catch (e) { /* fall through */ }
    return mem.has(k) ? mem.get(k) : null;
  }
  function rawSet(k, v) {
    const s = ls();
    try { if (s) { s.setItem(k, v); return; } } catch (e) { /* fall through */ }
    mem.set(k, v);
  }
  function rawRemove(k) {
    const s = ls();
    try { if (s) s.removeItem(k); } catch (e) { /* ignore */ }
    mem.delete(k);
  }
  function rawKeys() {
    const out = new Set(mem.keys());
    const s = ls();
    try { if (s) for (let i = 0; i < s.length; i++) out.add(s.key(i)); } catch (e) { /* ignore */ }
    return Array.from(out);
  }

  async function get(col, id) {
    const v = rawGet(key(col, id));
    return v == null ? null : JSON.parse(v);
  }
  async function set(col, id, value) {
    rawSet(key(col, id), JSON.stringify(value));
    return value;
  }
  async function list(col) {
    const p = PREFIX + col + ':';
    return rawKeys().filter((k) => k.startsWith(p)).map((k) => JSON.parse(rawGet(k)));
  }
  async function remove(col, id) {
    rawRemove(key(col, id));
  }
  async function clear(col) {
    const p = PREFIX + col + ':';
    rawKeys().filter((k) => k.startsWith(p)).forEach(rawRemove);
  }

  return { get, set, list, remove, clear };
});
