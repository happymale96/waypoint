'use strict';
// Simple lunch window <-> stored closed windows, validation, and the Places card text: pure functions in geo.js.
const Geo = require('../geo.js');

let failures = 0, passes = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + ' -> got ' + a + ', expected ' + e); }
}

console.log('simpleToStored');
eq(Geo.simpleToStored({ from: '12:00', to: '13:00' }), [{ days: [1, 2, 3, 4, 5], from: '12:00', to: '13:00' }], 'one window = Mon-Fri');
eq(Geo.simpleToStored({ from: '12:30', to: '13:30', friFrom: '13:00', friTo: '14:30' }),
  [{ days: [1, 2, 3, 4], from: '12:30', to: '13:30' }, { days: [5], from: '13:00', to: '14:30' }], 'Friday window = Mon-Thu + Fri');
eq(Geo.simpleToStored({ from: '', to: '' }), [], 'empty = no windows');
eq(Geo.simpleToStored({ from: '12:00', to: '' }), [], 'half-filled main window = no windows');
eq(Geo.simpleToStored({ from: '', to: '', friFrom: '13:00', friTo: '14:30' }), [], 'Friday without a main window = no windows');
eq(Geo.simpleToStored({ from: '12:00', to: '13:00', friFrom: '12:00', friTo: '13:00' }), [{ days: [1, 2, 3, 4, 5], from: '12:00', to: '13:00' }], 'Friday equal to main = single Mon-Fri window');

console.log('storedToSimple');
const S1 = Geo.storedToSimple([{ days: [1, 2, 3, 4, 5], from: '12:00', to: '13:00' }]);
eq(S1, { from: '12:00', to: '13:00', friFrom: '', friTo: '', fits: true }, 'Mon-Fri window fits');
const FRI = [{ days: [5], from: '13:00', to: '14:30' }, { days: [1, 2, 3, 4], from: '12:30', to: '13:30' }];
eq(Geo.storedToSimple(FRI), { from: '12:30', to: '13:30', friFrom: '13:00', friTo: '14:30', fits: true }, 'Mon-Thu + Fri fits (any order)');
eq(Geo.storedToSimple([]), { from: '', to: '', friFrom: '', friTo: '', fits: true }, 'empty fits');
eq(Geo.storedToSimple(undefined).fits, true, 'undefined fits (no windows)');
eq(Geo.storedToSimple([{ days: [6], from: '12:00', to: '13:00' }]).fits, false, 'Saturday window does not fit');
eq(Geo.storedToSimple([{ days: [1, 2, 3, 4, 5, 6, 7], from: '12:00', to: '13:00' }]).fits, false, 'every day (incl. weekend) does not fit');
eq(Geo.storedToSimple([{ days: [1, 2, 3, 4, 5], from: '12:00', to: '13:00' }, { days: [1, 2, 3, 4, 5], from: '15:00', to: '15:30' }]).fits, false, 'two windows in a day do not fit');
eq(Geo.storedToSimple([{ days: [1, 2, 3, 4], from: '12:30', to: '13:30' }]).fits, false, 'Mon-Thu only does not fit');
eq(Geo.storedToSimple([{ days: [5], from: '13:00', to: '14:30' }]).fits, false, 'Friday only does not fit');
eq(Geo.storedToSimple([{ days: [1, 2, 3, 4], from: '12:30', to: '13:30' }, { days: [5, 6], from: '13:00', to: '14:30' }]).fits, false, 'Fri+Sat does not fit');
eq(Geo.storedToSimple([{ from: '12:00', to: '13:00' }]).fits, false, 'legacy window without days (= every day) does not fit');
eq(Geo.storedToSimple([{ days: [1, 2, 3, 4, 5], from: '12:00', to: '13:00' }, { days: [6], from: '12:00', to: '13:00' }]).fits, false, 'Mon-Fri + Saturday does not fit');

console.log('round trip');
for (const s of [{ from: '12:00', to: '13:00' }, { from: '13:00', to: '14:00', friFrom: '12:30', friTo: '14:30' }, { from: '', to: '' }]) {
  const back = Geo.storedToSimple(Geo.simpleToStored(s));
  eq([back.from, back.to, back.friFrom || '', back.friTo || '', back.fits], [s.from, s.to, s.friFrom || '', s.friTo || '', true], 'simple -> stored -> simple ' + JSON.stringify(s));
}
const stored = [{ days: [1, 2, 3, 4], from: '12:30', to: '13:30' }, { days: [5], from: '13:00', to: '14:30' }];
eq(Geo.simpleToStored(Geo.storedToSimple(stored)), stored, 'stored (Mon-Thu + Fri) -> simple -> stored is identical');

console.log('validateSimple');
eq(Geo.validateSimple({ from: '12:00', to: '13:00' }, false), [], 'valid main window');
eq(Geo.validateSimple({ from: '', to: '' }, false), [], 'empty is valid (clears)');
eq(Geo.validateSimple({ from: '13:00', to: '12:00' }, false).length, 1, 'To before From is blocked');
eq(Geo.validateSimple({ from: '12:00', to: '12:00' }, false).length, 1, 'To equal From is blocked');
eq(Geo.validateSimple({ from: '23:00', to: '01:00' }, false).length, 1, 'midnight crossing is blocked');
eq(Geo.validateSimple({ from: '12:00', to: '' }, false).length, 1, 'only From filled is blocked');
eq(Geo.validateSimple({ from: '12:00', to: '13:00', friFrom: '14:00', friTo: '13:00' }, true).length, 1, 'Friday To before From is blocked');
eq(Geo.validateSimple({ from: '12:00', to: '13:00', friFrom: '14:00', friTo: '13:00' }, false), [], 'Friday pair ignored when the box is unticked');
eq(Geo.validateSimple({ from: '12:00', to: '13:00', friFrom: '13:00', friTo: '14:30' }, true), [], 'valid Friday window');

console.log('Places card text (after the "Lunch " prefix)');
eq(Geo.lunchCardText([{ days: [1, 2, 3, 4, 5], from: '12:00', to: '13:00' }]), '12:00–13:00', 'simple window');
eq(Geo.lunchCardText(stored), '12:30–13:30 · Fri 13:00–14:30', 'Friday difference');
eq(Geo.lunchCardText([{ days: [1, 2, 3, 4], from: '12:30', to: '13:30' }, { days: [5], from: '13:00', to: '14:30' }, { days: [6], from: '10:00', to: '11:00' }]),
  'Mon–Thu 12:30–13:30, Fri 13:00–14:30, Sat 10:00–11:00', 'non-fitting shape keeps the long formatter');
eq(Geo.lunchCardText([]), '', 'no windows = nothing');
eq(Geo.lunchCardText(undefined), '', 'undefined = nothing');
eq(Geo.formatWindows([{ days: [1, 2, 3, 4], from: '12:30', to: '13:30' }, { days: [5], from: '13:00', to: '14:30' }]), 'Mon–Thu 12:30–13:30, Fri 13:00–14:30', 'long formatter unchanged');

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
