/* L-Tech Waypoint — messages.js (pure, testable): WhatsApp text helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Messages = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_TEMPLATES = {
    ms: '{salam} {salutation}. Barang {salutation} ada dengan saya, saya akan hantar ke {salutation} sekitar pukul {time}. Terima kasih.\n— Calvin, L-Tech Automation',
    en: "{salam}. Your items are with me, I'll deliver them to you around {time}. Thank you.\n— Calvin, L-Tech Automation",
  };

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
  function etaText(arriveAt, paddingMin, lang) {
    let mins = toMinutes(arriveAt) + (Number(paddingMin) || 0);
    mins = Math.ceil(mins / 5) * 5;
    mins = ((mins % 1440) + 1440) % 1440;
    const h = Math.floor(mins / 60), m = mins % 60;
    const mm = (m < 10 ? '0' : '') + m;
    if (lang === 'en') {
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return h12 + ':' + mm + ' ' + (h < 12 ? 'am' : 'pm');
    }
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const part = h < 12 ? 'pagi' : h < 14 ? 'tengah hari' : h < 19 ? 'petang' : 'malam';
    return h12 + ':' + mm + ' ' + part;
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
    return fill(tpls[lang], {
      salam: greeting(now.getHours(), lang),
      salutation: place.salutation || 'Encik',
      items: opts.items || '',
      time: etaText(opts.arriveAt, s.etaPaddingMin != null ? s.etaPaddingMin : 15, lang),
      name: place.name || '',
    });
  }

  // Malaysian numbers: strip spaces/dashes/+; leading 0 -> 60.
  function normaliseNumber(n) {
    let d = String(n == null ? '' : n).replace(/[^\d]/g, '');
    if (!d) return '';
    if (d.startsWith('0')) d = '60' + d.slice(1);
    else if (d.startsWith('1') && !d.startsWith('60')) d = '60' + d; // 123456789 -> 60123456789
    return d;
  }

  // Returns the wa.me link, or null when there is no number (caller copies text to clipboard).
  function waLink(number, text) {
    const n = normaliseNumber(number);
    if (!n) return null;
    return 'https://wa.me/' + n + '?text=' + encodeURIComponent(text);
  }

  return { DEFAULT_TEMPLATES, greeting, etaText, fill, langFor, buildMessage, normaliseNumber, waLink };
});
