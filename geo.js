/* L-Tech Waypoint — geo.js
 * Pure helpers for locations (no DOM, no network, no storage): coordinate parsing for manual place entry, the
 * geolocation fix rules, and the place-record builders. Exports via module.exports (node) or window.Geo.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHORT_LINK_MSG = "Short links can't be read. In Google Maps, long-press the spot, copy the coordinates, and paste them here.";
  const MY_BOX = { latMin: 0.8, latMax: 7.5, lngMin: 99.5, lngMax: 119.5 };
  const GOOD_ACCURACY_M = 50; // manual entry: worse than this is flagged (saving is still allowed)

  const inRange = (lat, lng) => isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  const outsideMalaysia = (lat, lng) => lat < MY_BOX.latMin || lat > MY_BOX.latMax || lng < MY_BOX.lngMin || lng > MY_BOX.lngMax;

  // ---------- coordinate parsing ----------
  const N = '(-?\\d+(?:\\.\\d+)?)';
  const SEP = '(?:\\s*,\\s*|\\s+)';
  const URL_FORMS = [ // pin position first (!3d!4d), then the explicit query / centre parameters, then the map centre (@)
    new RegExp('!3d' + N + '!4d' + N),
    new RegExp('[?&]q=' + N + '(?:,|\\+|\\s)+' + N),
    new RegExp('[?&]ll=' + N + '(?:,|\\+|\\s)+' + N),
    new RegExp('@' + N + ',' + N),
  ];
  const PAIR_DECIMAL = new RegExp('(-?\\d{1,3}\\.\\d+)' + SEP + '(-?\\d{1,3}\\.\\d+)');
  const PAIR_WHOLE = new RegExp('^[\\s\\[\\](){}]*' + N + SEP + N + '[\\s\\[\\](){}]*$');

  function result(lat, lng) {
    lat = Number(lat); lng = Number(lng);
    if (!isFinite(lat) || !isFinite(lng)) return { ok: false, error: 'Those are not numbers.' };
    if (lat < -90 || lat > 90) return { ok: false, error: 'Latitude must be between -90 and 90.' };
    if (lng < -180 || lng > 180) return { ok: false, error: 'Longitude must be between -180 and 180.' };
    return { ok: true, lat, lng, outsideMalaysia: outsideMalaysia(lat, lng) };
  }

  // "3.1234, 101.5678" (comma or space, text / brackets around it tolerated) or a Google Maps URL with
  // !3dLAT!4dLNG, q=lat,lng, ll=lat,lng or @lat,lng. Short links are rejected. Returns {ok, lat, lng, outsideMalaysia} | {ok:false, error}.
  function parseCoords(text) {
    let s = String(text == null ? '' : text).trim();
    if (!s) return { ok: false, error: 'Paste the coordinates or a Google Maps link.' };
    if (/(^|[\/.\s])(maps\.app\.goo\.gl|goo\.gl)(\/|\b)/i.test(s)) return { ok: false, error: SHORT_LINK_MSG };
    try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch (e) { /* keep the raw text */ }
    if (/https?:\/\/|google\.[a-z.]+\/maps|[?&](q|ll)=|!3d|@-?\d/i.test(s)) {
      for (const re of URL_FORMS) { const m = s.match(re); if (m) return result(m[1], m[2]); }
    }
    const m = s.match(PAIR_DECIMAL) || s.match(PAIR_WHOLE);
    if (m) return result(m[1], m[2]);
    return { ok: false, error: "Couldn't find coordinates. Use the form 3.1234, 101.5678 or a Google Maps link." };
  }

  const mapsCheckUrl = (lat, lng) => 'https://www.google.com/maps?q=' + lat + ',' + lng;

  // ---------- geolocation fix rules ----------
  // High accuracy, 10 s timeout, maximumAge 60 s; on a TIMEOUT retry once with low accuracy and a 5 s timeout.
  // geo = navigator.geolocation (or a mock). Resolves {ok:true, lat, lng, accuracy} | {ok:false, code:'denied'|'timeout'|'unavailable'}.
  // o.fresh = never a cached position (maximumAge 0): the "back in the foreground" fix that auto-reach is evaluated on.
  function getFix(geo, o) {
    const maxAge = o && o.fresh ? 0 : 60000;
    const attempt = (opts) => new Promise((resolve) => {
      try {
        geo.getCurrentPosition(
          (p) => resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp != null ? p.timestamp : Date.now() }), // at = when the position was measured (ms)
          (e) => resolve({ ok: false, code: e && e.code === 1 ? 'denied' : e && e.code === 3 ? 'timeout' : 'unavailable' }),
          opts);
      } catch (e) { resolve({ ok: false, code: 'unavailable' }); }
    });
    if (!geo || typeof geo.getCurrentPosition !== 'function') return Promise.resolve({ ok: false, code: 'unavailable' });
    return attempt({ enableHighAccuracy: true, timeout: 10000, maximumAge: maxAge })
      .then((r) => (!r.ok && r.code === 'timeout' ? attempt({ enableHighAccuracy: false, timeout: 5000, maximumAge: maxAge }) : r));
  }

  // ---------- place records ----------
  // The one place-record builder. A searched place and a manual one have the same required fields.
  // ctx = {uid(prefix), dwellDefaults, DEFAULT_DWELL}
  function makePlace(o, ctx) {
    const type = o.type || 'other';
    const dd = (ctx.dwellDefaults && ctx.dwellDefaults[type] != null) ? ctx.dwellDefaults[type] : ctx.DEFAULT_DWELL[type];
    return Object.assign({
      id: ctx.uid('p'), name: '', address: '', lat: 0, lng: 0, type,
      dwellMin: dd, closedWindows: [], whatsapp: '', salutation: 'Encik', lang: 'default',
    }, o);
  }
  // form = {name, address, type, salutation, lang, lat, lng, accuracy}
  function manualPlace(form, ctx) {
    const o = {
      name: String(form.name || '').trim(), address: String(form.address || '').trim(), lat: form.lat, lng: form.lng,
      type: form.type || 'other', source: 'manual',
    };
    if (form.salutation) o.salutation = form.salutation;
    if (form.lang) o.lang = form.lang;
    if (form.accuracy != null && isFinite(form.accuracy)) o.accuracy = Math.round(form.accuracy);
    return makePlace(o, ctx);
  }
  // "Update location to where I am now": returns a NEW record; the old coordinates are kept as previousLocation (one level).
  function moveLocation(place, fix, nowIso) {
    const out = Object.assign({}, place, { lat: fix.lat, lng: fix.lng });
    out.previousLocation = { lat: place.lat, lng: place.lng, accuracy: place.accuracy != null ? place.accuracy : null, at: nowIso || null };
    if (fix.accuracy != null && isFinite(fix.accuracy)) out.accuracy = Math.round(fix.accuracy); else delete out.accuracy;
    return out;
  }
  // Undo the last move (once): the coordinates come back, previousLocation is gone. No previousLocation = unchanged copy.
  function undoMove(place) {
    const out = Object.assign({}, place);
    const p = place.previousLocation;
    if (!p) return out;
    out.lat = p.lat; out.lng = p.lng;
    if (p.accuracy != null) out.accuracy = p.accuracy; else delete out.accuracy;
    delete out.previousLocation;
    return out;
  }

  // ---- closed (lunch) windows. Stored format (unchanged): [{ days: [1..7] (ISO, Mon=1), from: 'HH:MM', to: 'HH:MM' }]
  const DAY3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const WEEKDAYS = [1, 2, 3, 4, 5], MON_THU = [1, 2, 3, 4], FRI = [5];
  function daysLabel(days) { // [] -> 'never'; all seven -> ''; [1,2,3,4] -> "Mon–Thu"; [5] -> "Fri"
    const d = Array.from(new Set(days || [])).sort((a, b) => a - b);
    if (d.length === 7 || !d.length) return d.length ? '' : 'never';
    const out = [];
    for (let i = 0; i < d.length;) {
      let j = i;
      while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
      out.push(j === i ? DAY3[d[i] - 1] : (j === i + 1 ? DAY3[d[i] - 1] + ', ' + DAY3[d[j] - 1] : DAY3[d[i] - 1] + '–' + DAY3[d[j] - 1]));
      i = j + 1;
    }
    return out.join(', ');
  }
  const mins = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
  const daySet = (w) => Array.from(new Set(Array.isArray(w.days) ? w.days : [1, 2, 3, 4, 5, 6, 7])).sort((a, b) => a - b).join(',');
  // {from,to,friFrom,friTo} -> stored windows. No from/to -> none. A Friday window equal to the main one adds nothing.
  function simpleToStored(s) {
    const from = (s && s.from) || '', to = (s && s.to) || '', fF = (s && s.friFrom) || '', fT = (s && s.friTo) || '';
    if (!from || !to) return [];
    if (fF && fT && !(fF === from && fT === to)) return [{ days: MON_THU.slice(), from, to }, { days: FRI.slice(), from: fF, to: fT }];
    return [{ days: WEEKDAYS.slice(), from, to }];
  }
  // stored windows -> {from,to,friFrom,friTo,fits}. fits = exactly "one window Mon-Fri" or "one Mon-Thu + one Fri"; else false.
  function storedToSimple(stored) {
    const none = { from: '', to: '', friFrom: '', friTo: '' };
    const w = Array.isArray(stored) ? stored : [];
    if (!w.length) return Object.assign({}, none, { fits: true });
    const bad = Object.assign({}, none, { fits: false });
    if (w.some((x) => !x || !x.from || !x.to)) return bad;
    if (w.length === 1 && daySet(w[0]) === WEEKDAYS.join(',')) return { from: w[0].from, to: w[0].to, friFrom: '', friTo: '', fits: true };
    if (w.length === 2) {
      const a = w.find((x) => daySet(x) === MON_THU.join(',')), b = w.find((x) => daySet(x) === FRI.join(','));
      if (a && b && a !== b) return { from: a.from, to: a.to, friFrom: b.from === a.from && b.to === a.to ? '' : b.from, friTo: b.from === a.from && b.to === a.to ? '' : b.to, fits: true };
    }
    return bad;
  }
  // Messages for the simple form (empty = valid). No midnight crossing: To must be after From.
  function validateSimple(s, fridayOn) {
    const errs = [];
    const from = (s && s.from) || '', to = (s && s.to) || '';
    if ((from || to) && !(from && to)) errs.push('Enter both From and To for the lunch window.');
    else if (from && to && !(mins(to) > mins(from))) errs.push('Lunch window: To must be after From.');
    if (fridayOn) {
      const fF = (s && s.friFrom) || '', fT = (s && s.friTo) || '';
      if ((fF || fT) && !(fF && fT)) errs.push('Enter both From and To for Friday.');
      else if (fF && fT && !(mins(fT) > mins(fF))) errs.push('Friday window: To must be after From.');
      else if (fF && fT && !(from && to)) errs.push('Enter the Mon–Fri window before a different Friday window.');
    }
    return errs;
  }
  // Long formatter (any stored shape): "Mon–Thu 12:30–13:30, Fri 13:00–14:30"
  function formatWindows(stored) {
    return (stored || []).map((w) => (daysLabel(w.days) ? daysLabel(w.days) + ' ' : '') + w.from + '–' + w.to).join(', ');
  }
  // Text after the "Lunch " prefix on the Places card ('' = nothing to show)
  function lunchCardText(stored) {
    if (!(stored || []).length) return '';
    const s = storedToSimple(stored);
    if (!s.fits) return formatWindows(stored);
    return s.from + '–' + s.to + (s.friFrom ? ' · Fri ' + s.friFrom + '–' + s.friTo : '');
  }

  return { SHORT_LINK_MSG, MY_BOX, GOOD_ACCURACY_M, parseCoords, outsideMalaysia, inRange, mapsCheckUrl, getFix, makePlace, manualPlace, moveLocation, undoMove,
    daysLabel, simpleToStored, storedToSimple, validateSimple, formatWindows, lunchCardText };
});
