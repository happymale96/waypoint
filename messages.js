/* L-Tech Waypoint — messages.js (pure, testable): WhatsApp text helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Messages = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The owner's own wording (one line, no signature). OLD_MS_DEFAULT is the previous default: a stored template equal to
  // it is replaced once by the new default (migrateTemplates); an edited one is left alone.
  const DEFAULT_TEMPLATES = {
    ms: '{salam} {salutation}, barang {salutation} nanti saya sebelum pukul {time} hantar ke kilang {salutation} ye. Tq👍',
    en: "{salam}. Your items are with me, I'll deliver them to you around {time}. Thank you.\n— Calvin, L-Tech Automation",
  };
  const OLD_MS_DEFAULT = '{salam} {salutation}. Barang {salutation} ada dengan saya, saya akan hantar ke {salutation} sekitar pukul {time}. Terima kasih.\n— Calvin, L-Tech Automation';
  const TEMPLATE_FLAG = 'msTemplate2026_11_24';
  // templates -> {templates, changed}: the Bahasa Malaysia template moves to the new default only if it is exactly the old one
  function migrateTemplates(templates) {
    const t = Object.assign({}, templates || {});
    if (t.ms === OLD_MS_DEFAULT) { t.ms = DEFAULT_TEMPLATES.ms; return { templates: t, changed: true }; }
    return { templates: t, changed: false };
  }
  // the time of day in Bahasa Malaysia (the app's boundaries: pagi < 12:00, tengah hari < 14:00, petang < 19:00, malam)
  const partOfDay = (hour) => (hour < 12 ? 'pagi' : hour < 14 ? 'tengah hari' : hour < 19 ? 'petang' : 'malam');
  const salamMs = (hour) => 'Salam ' + partOfDay(hour);
  // 12-hour, a dot, no leading zero on the hour, am/pm with no space: 12.10pm, 9.05am, 12.05am
  function timeDot(mins) {
    const h = Math.floor(mins / 60) % 24, m = mins % 60;
    return (h % 12 === 0 ? 12 : h % 12) + '.' + (m < 10 ? '0' : '') + m + (h < 12 ? 'am' : 'pm');
  }

  function greeting(hour, lang) {
    if (lang === 'en') return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    if (hour < 12) return 'Selamat pagi';
    if (hour < 14) return 'Selamat tengah hari';
    return 'Selamat petang';
  }

  // Accepts Date | epoch ms | "HH:MM". Adds padding, rounds UP to the next 5 minutes.
  function toMinutes(v) {
    if (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v)) {
      const p = v.split(':');
      return Number(p[0]) * 60 + Number(p[1]);
    }
    const d = v instanceof Date ? v : new Date(v);
    return d.getHours() * 60 + d.getMinutes();
  }
  // The time the customer is told: ETA + padding, rounded UP to the next 5-minute mark only if it is not already on one. Nothing
  // else is added. Returns minutes since midnight (0..1439).
  function messageMinutes(arriveAt, paddingMin) {
    let mins = toMinutes(arriveAt) + (Number(paddingMin) || 0);
    if (mins % 5 !== 0) mins = Math.ceil(mins / 5) * 5;
    return ((mins % 1440) + 1440) % 1440;
  }
  function etaText(arriveAt, paddingMin, lang) {
    const mins = messageMinutes(arriveAt, paddingMin);
    const h = Math.floor(mins / 60), m = mins % 60;
    const mm = (m < 10 ? '0' : '') + m;
    if (lang === 'en') {
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return h12 + ':' + mm + ' ' + (h < 12 ? 'am' : 'pm');
    }
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + mm + ' ' + partOfDay(h);
  }

  function fill(template, vars) {
    return String(template).replace(/\{(salam|salutation|items|time|name)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
  }

  function langFor(place, settings) {
    const l = place && place.lang && place.lang !== 'default' ? place.lang : (settings && settings.defaultLang) || 'ms';
    return l === 'en' ? 'en' : 'ms';
  }

  // opts: {place, settings, arriveAt, items, now}
  function buildMessage(opts) {
    const s = opts.settings || {};
    const place = opts.place || {};
    const lang = langFor(place, s);
    const tpls = Object.assign({}, DEFAULT_TEMPLATES, s.templates || {});
    const now = opts.now ? new Date(opts.now) : new Date();
    const pad = s.etaPaddingMin != null ? s.etaPaddingMin : 10;
    if (lang === 'ms') { // Bahasa Malaysia: "Salam pagi", lowercase encik / puan / cik, 12.10pm
      return fill(tpls.ms, {
        salam: salamMs(now.getHours()),
        salutation: String(place.salutation || 'Encik').toLowerCase(),
        items: opts.items || '',
        time: timeDot(messageMinutes(opts.arriveAt, pad)),
        name: place.name || '',
      });
    }
    return fill(tpls[lang], {
      salam: greeting(now.getHours(), lang),
      salutation: place.salutation || 'Encik',
      items: opts.items || '',
      time: etaText(opts.arriveAt, pad, lang),
      name: place.name || '',
    });
  }

  // Digits-only international form. Strips spaces, dashes, brackets, dots and the +, so "+60194347041" and
  // "+60 11-2618 6640" both work. Malaysian rules: leading 0 -> 60; bare 1xxxxxxxx -> 601xxxxxxxx; "+60 0..." -> "60...".
  function normaliseNumber(n) {
    const raw = String(n == null ? '' : n).trim();
    let d = raw.replace(/[^\d]/g, '');
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2); // 0060... international prefix
    if (d.startsWith('600')) d = '60' + d.slice(3); // "+60 012-..." (trunk 0 kept by mistake)
    else if (d.startsWith('0')) d = '60' + d.slice(1);
    else if (d.startsWith('1') && !raw.startsWith('+')) d = '60' + d; // 123456789 -> 60123456789
    return d;
  }

  // The compact "+60..." form the place form saves. Applied when a stored number is READ (display, form, link);
  // stored values are never rewritten in bulk.
  function compactNumber(n) {
    const d = normaliseNumber(n);
    return d ? '+' + d : '';
  }

  // Place type as shown to the user. The stored value stays "factory" (saved places, dwell defaults and exports key on it).
  const TYPE_LABELS = { factory: 'customer factory' };
  function typeLabel(t) { return TYPE_LABELS[t] || String(t == null ? '' : t); }

  // Returns the wa.me link, or null when there is no number (caller copies text to clipboard).
  function waLink(number, text) {
    const n = normaliseNumber(number);
    if (!n) return null;
    return 'https://wa.me/' + n + '?text=' + encodeURIComponent(text);
  }

  return { DEFAULT_TEMPLATES, OLD_MS_DEFAULT, TEMPLATE_FLAG, migrateTemplates, partOfDay, salamMs, timeDot, greeting, messageMinutes, etaText, fill, langFor, buildMessage, normaliseNumber, compactNumber, typeLabel, waLink };
});
