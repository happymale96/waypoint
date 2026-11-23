'use strict';
const M = require('../messages.js');

let failures = 0, passes = 0;
function eq(actual, expected, name) {
  if (actual === expected) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + ' -> got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); }
}

console.log('greeting');
eq(M.greeting(0, 'ms'), 'Selamat pagi', 'ms 0h');
eq(M.greeting(11, 'ms'), 'Selamat pagi', 'ms 11h');
eq(M.greeting(12, 'ms'), 'Selamat tengah hari', 'ms 12h');
eq(M.greeting(13, 'ms'), 'Selamat tengah hari', 'ms 13h');
eq(M.greeting(14, 'ms'), 'Selamat petang', 'ms 14h');
eq(M.greeting(21, 'ms'), 'Selamat petang', 'ms 21h');
eq(M.greeting(11, 'en'), 'Good morning', 'en 11h');
eq(M.greeting(12, 'en'), 'Good afternoon', 'en 12h');
eq(M.greeting(17, 'en'), 'Good afternoon', 'en 17h');
eq(M.greeting(18, 'en'), 'Good evening', 'en 18h');

console.log('etaText');
eq(M.etaText('14:21', 15, 'ms'), '2:40 petang', '14:21 + 15 -> 2:40 petang');
eq(M.etaText('14:30', 15, 'ms'), '2:45 petang', 'exact multiple of 5 stays');
eq(M.etaText('10:11', 15, 'ms'), '10:30 pagi', '10:11 + 15 -> 10:30 pagi');
eq(M.etaText('11:55', 15, 'ms'), '12:10 tengah hari', 'crosses noon -> tengah hari');
eq(M.etaText('12:00', 15, 'ms'), '12:15 tengah hari', '12:15 tengah hari');
eq(M.etaText('14:21', 15, 'en'), '2:40 pm', 'en pm');
eq(M.etaText('09:02', 0, 'en'), '9:05 am', 'en am rounds up');
eq(M.etaText('23:50', 15, 'en'), '12:05 am', 'wraps past midnight');
eq(M.etaText(new Date(2030, 0, 1, 14, 21), 15, 'ms'), '2:40 petang', 'accepts Date');

console.log('numbers + links');
eq(M.normaliseNumber('012-345 6789'), '60123456789', '012-345 6789');
eq(M.normaliseNumber('+60 12-345 6789'), '60123456789', '+60 12-345 6789');
eq(M.normaliseNumber('60123456789'), '60123456789', 'already normalised');
eq(M.normaliseNumber(''), '', 'empty');
eq(M.waLink('012-345 6789', 'Hi there'), 'https://wa.me/60123456789?text=Hi%20there', 'waLink encodes');
eq(M.waLink('', 'x'), null, 'no number -> null (caller copies to clipboard)');

console.log('templates');
eq(M.fill('{salam} {salutation} {items} {time} {name}', { salam: 'A', salutation: 'B', items: 'C', time: 'D', name: 'E' }), 'A B C D E', 'all placeholders');
eq(M.fill('{time} and {time}', { time: 'T' }), 'T and T', 'repeated placeholder');
const settings = { defaultLang: 'ms', etaPaddingMin: 15, templates: M.DEFAULT_TEMPLATES };
const msg = M.buildMessage({ place: { name: 'Acme', salutation: 'Puan', lang: 'default' }, settings, arriveAt: '14:21', now: new Date(2030, 0, 1, 9, 0) });
eq(msg, 'Selamat pagi Puan. Barang Puan ada dengan saya, saya akan hantar ke Puan sekitar pukul 2:40 petang. Terima kasih.\n— Calvin, L-Tech Automation', 'default ms message');
const en = M.buildMessage({ place: { name: 'Acme', lang: 'en' }, settings, arriveAt: '14:21', now: new Date(2030, 0, 1, 15, 0) });
eq(en, "Good afternoon. Your items are with me, I'll deliver them to you around 2:40 pm. Thank you.\n— Calvin, L-Tech Automation", 'place.lang overrides default');
eq(M.langFor({ lang: 'default' }, { defaultLang: 'en' }), 'en', 'default lang from settings');

console.log('message time = ETA + padding, rounded UP to a 5-minute mark only if not already on one');
{
  const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const t = (eta, pad) => hm(M.messageMinutes(eta, pad));
  eq(t('17:00', 10), '17:10', 'padding 10: ETA 17:00 -> 17:10');
  eq(t('17:02', 10), '17:15', 'padding 10: ETA 17:02 -> 17:15');
  eq(t('17:05', 10), '17:15', 'padding 10: ETA 17:05 -> 17:15');
  eq(t('16:56', 10), '17:10', 'padding 10: ETA 16:56 -> 17:10');
  eq(t('17:02', 0), '17:05', 'padding 0: ETA 17:02 -> 17:05');
  eq(t('17:00', 0), '17:00', 'padding 0: ETA 17:00 stays 17:00');
  eq(t('23:55', 10), '00:05', 'midnight wrap: ETA 23:55, padding 10 -> 00:05');
  eq(t('17:00', 15), '17:15', 'padding 15: ETA 17:00 -> 17:15 (nothing hidden is added)');
  eq(t(new Date(2030, 0, 1, 17, 0, 40), 10), '17:10', 'a Date ETA with seconds: the minute counts, as on the Route card');
  eq(M.etaText('17:00', 10, 'en'), '5:10 pm', 'etaText (en) uses the same minutes');
  eq(M.etaText('17:02', 10, 'ms'), '5:15 petang', 'etaText (ms) uses the same minutes');
  eq(M.buildMessage({ place: { lang: 'en' }, settings: { defaultLang: 'ms' }, arriveAt: '17:00', now: new Date(2030, 0, 1, 15, 0) }).includes('around 5:10 pm'), true, 'with no padding setting the default is 10');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
