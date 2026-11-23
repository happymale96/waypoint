'use strict';
// Pinned places (geo.js): the picker order, the Places tab order and the one-time office pin migration.
// Run as its own node script: node test/pins.test.js
const Geo = require('../geo.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const names = (l) => l.map((p) => p.name);

const P = () => [
  { id: 'home', name: 'Home', address: 'Bloomsvale', type: 'home' },
  { id: 'office', name: 'Office', address: 'L-Tech', type: 'office', pinned: true },
  { id: 'carrier', name: 'Carrier', address: 'Shah Alam', type: 'factory' },
  { id: 'ao', name: 'AO Advance', address: 'Klang', type: 'supplier' },
];

console.log('picker order');
eq(names(Geo.pickerOrder(P(), '')), ['Office', 'AO Advance', 'Carrier', 'Home'], 'empty query: Office first, then name order');
eq(names(Geo.pickerOrder(P(), 'car')), ['Office', 'Carrier'], '"car": Office first (even though it does not match), then Carrier');
eq(names(Geo.pickerOrder(P(), 'off')), ['Office'], '"off": Office once, not repeated');
{
  const l = P(); l.find((p) => p.id === 'home').pinned = true;
  eq(names(Geo.pickerOrder(l, '')), ['Home', 'Office', 'AO Advance', 'Carrier'], 'two pinned places: both first, in name order');
  eq(names(Geo.pickerOrder(l, 'zzz')), ['Home', 'Office'], 'no text match: only the pinned rows');
  eq(names(Geo.pickerOrder(l, 'car')), ['Home', 'Office', 'Carrier'], 'two pinned + the match');
}
ok(!Geo.pickerOrder(P(), '').some((p, i, a) => a.indexOf(p) !== i), 'no place listed twice');
ok(Geo.pickerOrder(P(), 'AO ADV').length === 2, 'matching is case-insensitive');

console.log('Places tab order');
eq(names(Geo.pinnedFirst(P())), ['Office', 'AO Advance', 'Carrier', 'Home'], 'pinned first, then the name order');

console.log('migration: pins exactly the office-type places, once');
{
  const places = P(); places[1].pinned = false; // Office not pinned yet
  places.push({ id: 'o2', name: 'Branch office', type: 'office' }, { id: 'f', name: 'Office Supplies Co', type: 'supplier' });
  const r = Geo.migratePins({ places, migrations: {} });
  eq(r.state.places.filter((p) => p.pinned).map((p) => p.id).sort(), ['o2', 'office'], 'exactly the office-type places are pinned (a name with "Office" in it is not)');
  ok(r.count === 2 && r.changed, 'two places changed');
  ok(r.state.migrations[Geo.PIN_FLAG] === true && Geo.PIN_FLAG === 'pinOffice2026_11_24', 'the flag is set');
  ok(places.every((p) => !p.pinned), 'the input is not mutated');
  const again = Geo.migratePins({ places: r.state.places.map((p) => Object.assign({}, p, { pinned: false })), migrations: r.state.migrations });
  ok(again.count === 0 && !again.changed && again.state.places.every((p) => !p.pinned), 'with the flag set it does nothing (runs once)');
  ok(Geo.migratePins({ places: [] }).changed === false, 'no places: nothing changed');
}

console.log(passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
