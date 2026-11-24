'use strict';
// 22. Contact name on a place (Geo.cleanContact / Geo.waCardText). Run as its own node script: node test/contact.test.js
const Geo = require('../geo.js');

let failures = 0, passes = 0;
function eq(actual, expected, name) {
  if (actual === expected) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + ' -> got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); }
}

console.log('22. contact name');
eq(Geo.cleanContact('   Encik Ali  '), 'Encik Ali', 'saved with surrounding spaces -> stored trimmed');
const fifty = 'A'.repeat(50);
eq(Geo.cleanContact(fifty), 'A'.repeat(40), '50 characters -> stored as 40');
eq(Geo.cleanContact(''), '', 'empty -> nothing stored');
eq(Geo.waCardText('Encik Ali', '012-345 6789'), 'Encik Ali · 012-345 6789', 'name + number -> one line "Encik Ali · 012-345 6789"');
eq(Geo.waCardText('Encik Ali', ''), 'Encik Ali', 'name only -> "Encik Ali"');
eq(Geo.waCardText('', '+60123456789'), 'WA +60123456789', 'number only -> as before ("WA <number>")');
eq(Geo.waCardText(undefined, ''), '', 'neither -> no line');
eq(Geo.waCardText('Encik Ali', '+60123456789').includes('\n'), false, 'never a second line');

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
