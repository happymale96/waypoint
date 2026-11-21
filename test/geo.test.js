'use strict';
// Manual place entry (Part B) + the shared geolocation fix rules (A3): pure functions only.
const Geo = require('../geo.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const near = (r, lat, lng) => r.ok === true && Math.abs(r.lat - lat) < 1e-9 && Math.abs(r.lng - lng) < 1e-9;

(async () => {
  console.log('parseCoords: plain pairs');
  ok(near(Geo.parseCoords('3.1234, 101.5678'), 3.1234, 101.5678), 'plain pair with a comma');
  ok(near(Geo.parseCoords('3.1234 101.5678'), 3.1234, 101.5678), 'plain pair with a space');
  ok(near(Geo.parseCoords('  Kedai Ah Seng (3.1234, 101.5678) KL  '), 3.1234, 101.5678), 'brackets and text around it');
  ok(near(Geo.parseCoords('[3.1234,101.5678]'), 3.1234, 101.5678), 'square brackets, no space');
  ok(near(Geo.parseCoords('Lot 12, Jalan 4  3.1234, 101.5678'), 3.1234, 101.5678), 'other numbers in the text do not confuse it');
  ok(near(Geo.parseCoords('-33.8688, -70.6693'), -33.8688, -70.6693) && Geo.parseCoords('-33.8688, -70.6693').outsideMalaysia === true, 'negative longitude (and latitude)');
  ok(near(Geo.parseCoords('3, 101'), 3, 101), 'a bare whole-number pair is accepted when it is all there is');

  console.log('parseCoords: Google Maps URLs');
  ok(near(Geo.parseCoords('https://www.google.com/maps/place/Foo/@3.1234,101.5678,17z/data=abc'), 3.1234, 101.5678), 'URL with @lat,lng');
  ok(near(Geo.parseCoords('https://www.google.com/maps/place/Foo/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d3.1111!4d101.2222'), 3.1111, 101.2222), 'URL with !3dLAT!4dLNG');
  ok(near(Geo.parseCoords('https://www.google.com/maps?q=3.1234,101.5678'), 3.1234, 101.5678), 'URL with q=lat,lng');
  ok(near(Geo.parseCoords('https://maps.google.com/?ll=3.1234,101.5678&z=15'), 3.1234, 101.5678), 'URL with ll=lat,lng');
  ok(near(Geo.parseCoords('https://www.google.com/maps?q=3.1234%2C101.5678'), 3.1234, 101.5678), 'percent-encoded q=');
  ok(near(Geo.parseCoords('https://www.google.com/maps/place/X/@3.5,101.5,15z/data=!3d3.1111!4d101.2222'), 3.1111, 101.2222), 'the pin (!3d!4d) wins over the map centre (@)');

  console.log('parseCoords: rejections and flags');
  const SHORT = "Short links can't be read. In Google Maps, long-press the spot, copy the coordinates, and paste them here.";
  ok(Geo.SHORT_LINK_MSG === SHORT, 'the short-link message is exactly the specified text');
  const s1 = Geo.parseCoords('https://maps.app.goo.gl/AbCdEf123'), s2 = Geo.parseCoords('https://goo.gl/maps/xyz'), s3 = Geo.parseCoords('maps.app.goo.gl/AbCdEf123');
  ok(s1.ok === false && s1.error === SHORT && s2.ok === false && s2.error === SHORT && s3.error === SHORT, 'maps.app.goo.gl and goo.gl short links are rejected with the exact message', [s1, s2]);
  const nn = Geo.parseCoords('hello world');
  ok(nn.ok === false && typeof nn.error === 'string' && nn.error.length > 5, 'non-numeric text is rejected');
  ok(Geo.parseCoords('').ok === false && Geo.parseCoords(null).ok === false, 'empty input is rejected');
  ok(Geo.parseCoords('95.5, 101.5').ok === false && /Latitude/.test(Geo.parseCoords('95.5, 101.5').error), 'latitude out of range is rejected');
  ok(Geo.parseCoords('3.5, 190.5').ok === false && /Longitude/.test(Geo.parseCoords('3.5, 190.5').error), 'longitude out of range is rejected');
  const my = Geo.parseCoords('1.3521, 103.8198'), out = Geo.parseCoords('13.7563, 100.5018');
  ok(my.ok && my.outsideMalaysia === false, 'Singapore-side Johor point is inside the Malaysia box');
  ok(out.ok === true && out.outsideMalaysia === true, 'outside Malaysia is flagged, not blocked (ok stays true)', out);
  ok(Geo.outsideMalaysia(0.7, 101) && Geo.outsideMalaysia(7.6, 101) && Geo.outsideMalaysia(3, 99.4) && Geo.outsideMalaysia(3, 119.6) && !Geo.outsideMalaysia(0.8, 99.5) && !Geo.outsideMalaysia(7.5, 119.5), 'box edges: lat 0.8-7.5, lng 99.5-119.5');
  ok(Geo.mapsCheckUrl(3.1234, 101.5678) === 'https://www.google.com/maps?q=3.1234,101.5678', 'Check in Google Maps URL');

  console.log('records');
  let n = 0;
  const ctx = { uid: (p) => p + '_' + (++n), dwellDefaults: { other: 10, supplier: 5, factory: 20, office: 10, home: 0 }, DEFAULT_DWELL: { other: 10, supplier: 5, factory: 20, office: 10, home: 0 } };
  const searched = Geo.makePlace({ name: 'Searched Sdn Bhd', address: 'Jln 1', lat: 3.1, lng: 101.6, type: 'other' }, ctx);
  const manual = Geo.manualPlace({ name: '  Kedai Ah Seng ', address: ' near the mosque ', type: 'supplier', lat: 3.1234, lng: 101.5678, accuracy: 12.4 }, ctx);
  const req = Object.keys(searched).sort();
  ok(req.every((k) => k in manual), 'manual record has every required field of a searched record', req.filter((k) => !(k in manual)));
  ok(manual.source === 'manual' && manual.accuracy === 12 && manual.name === 'Kedai Ah Seng' && manual.address === 'near the mosque', 'manual record: source "manual", accuracy kept, text trimmed');
  ok(manual.dwellMin === 5 && Array.isArray(manual.closedWindows) && manual.closedWindows.length === 0 && typeof manual.id === 'string', 'type default dwell applied, closed windows editable (empty list), id assigned');
  ok(!('accuracy' in Geo.manualPlace({ name: 'X', lat: 3, lng: 101 }, ctx)), 'no accuracy key when the location was pasted');

  console.log('update location to where I am now');
  const p = Geo.manualPlace({ name: 'Pin', lat: 3.1, lng: 101.6, accuracy: 30 }, ctx);
  const moved = Geo.moveLocation(p, { lat: 3.2, lng: 101.7, accuracy: 8.6 }, '2026-11-21T01:00:00.000Z');
  ok(moved.lat === 3.2 && moved.lng === 101.7 && moved.accuracy === 9, 'new coordinates and accuracy stored');
  ok(moved.previousLocation && moved.previousLocation.lat === 3.1 && moved.previousLocation.lng === 101.6 && moved.previousLocation.accuracy === 30, 'update-location stores the old coordinates as previousLocation', moved.previousLocation);
  ok(p.lat === 3.1 && !p.previousLocation, 'the original record is not mutated');
  const again = Geo.moveLocation(moved, { lat: 3.3, lng: 101.8, accuracy: 5 });
  ok(again.previousLocation.lat === 3.2, 'a second update keeps only ONE level of history (the latest old pin)');
  const undone = Geo.undoMove(moved);
  ok(undone.lat === 3.1 && undone.lng === 101.6 && undone.accuracy === 30 && !('previousLocation' in undone), 'undo restores the old pin and clears previousLocation (undoable once)');
  ok(Geo.undoMove(undone).lat === 3.1, 'a second undo changes nothing');

  console.log('getFix: shared fix rules');
  const calls = [];
  const geoOf = (script) => ({ getCurrentPosition: (ok_, err, opts) => { calls.push(opts); const r = script[calls.length - 1]; if (r.pos) ok_({ coords: { latitude: r.pos[0], longitude: r.pos[1], accuracy: r.pos[2] } }); else err({ code: r.code }); } });
  let f = await Geo.getFix(geoOf([{ pos: [3.1, 101.6, 25] }]));
  ok(f.ok && f.lat === 3.1 && f.accuracy === 25 && calls.length === 1, 'first attempt succeeds: one call');
  ok(calls[0].enableHighAccuracy === true && calls[0].timeout === 10000 && calls[0].maximumAge === 60000, 'first attempt: high accuracy, 10 s timeout, maximumAge 60 s', calls[0]);
  calls.length = 0;
  f = await Geo.getFix(geoOf([{ code: 3 }, { pos: [3.2, 101.7, 150] }]));
  ok(f.ok && f.lat === 3.2 && calls.length === 2, 'on timeout it retries once');
  ok(calls[1].enableHighAccuracy === false && calls[1].timeout === 5000, 'retry: low accuracy, 5 s timeout', calls[1]);
  calls.length = 0;
  f = await Geo.getFix(geoOf([{ code: 3 }, { code: 3 }, { pos: [0, 0, 1] }]));
  ok(f.ok === false && f.code === 'timeout' && calls.length === 2, 'two timeouts: gives up after exactly one retry');
  calls.length = 0;
  f = await Geo.getFix(geoOf([{ code: 1 }, { pos: [0, 0, 1] }]));
  ok(f.ok === false && f.code === 'denied' && calls.length === 1, 'permission denied: no retry');
  calls.length = 0;
  f = await Geo.getFix(geoOf([{ code: 2 }]));
  ok(f.ok === false && f.code === 'unavailable' && calls.length === 1, 'position unavailable: reported, no retry');
  ok((await Geo.getFix(null)).code === 'unavailable', 'no geolocation object: unavailable');

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
