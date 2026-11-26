'use strict';
// In-app camera (camera.js, pure parts): pickBackDevice, nextBackDevice, and the stream chain (acquire) over a fake mediaDevices.
// Run: node test/camera.test.js
const Camera = require('../camera.js');

let failures = 0, passes = 0;
function ok(cond, name, extra) {
  if (cond) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

// a Samsung-like list: one front and three back cameras (plus a microphone)
const DEVS = [
  { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' },
  { kind: 'videoinput', deviceId: 'f1', label: 'camera2 1, facing front' },
  { kind: 'videoinput', deviceId: 'b0', label: 'camera2 0, facing back' },
  { kind: 'videoinput', deviceId: 'b2', label: 'camera2 2, facing back' },
  { kind: 'videoinput', deviceId: 'b3', label: 'camera2 3, facing back' },
];
const id = (d) => (d ? d.deviceId : null);

console.log('pickBackDevice');
eq(id(Camera.pickBackDevice(DEVS, null)), 'b0', 'no remembered lens: the first back camera');
eq(id(Camera.pickBackDevice(DEVS, 'b3')), 'b3', 'a remembered lens that still exists is asked for first');
eq(id(Camera.pickBackDevice(DEVS, 'gone')), 'b0', 'a remembered lens that is gone: the first back camera');
eq(id(Camera.pickBackDevice(DEVS, 'f1')), 'b0', 'a remembered id that is the front camera is never used');
{
  const blank = DEVS.map((d) => Object.assign({}, d, { label: '' })); // labels are empty before permission
  eq(id(Camera.pickBackDevice(blank, null)), null, 'labels empty before permission: none known to be back (the chain asks by facing mode)');
  eq(id(Camera.pickBackDevice(blank, 'b2')), 'b2', 'labels empty: a remembered id still in the list is used');
  eq(id(Camera.pickBackDevice([{ kind: 'videoinput', deviceId: 'r', label: 'Rear Camera' }, { kind: 'videoinput', deviceId: 'e', label: 'environment' }], null)), 'r', '"rear" counts as back');
  eq(id(Camera.pickBackDevice([], null)), null, 'no devices: null');
}

console.log('nextBackDevice');
eq(id(Camera.nextBackDevice(DEVS, 'b0')), 'b2', 'b0 -> b2');
eq(id(Camera.nextBackDevice(DEVS, 'b2')), 'b3', 'b2 -> b3');
eq(id(Camera.nextBackDevice(DEVS, 'b3')), 'b0', 'b3 -> b0 (cycles, the front camera skipped)');
eq(id(Camera.nextBackDevice(DEVS, 'f1')), 'b0', 'from the front camera (or an unknown id): the first back camera');
eq(id(Camera.nextBackDevice(DEVS, 'gone')), 'b0', 'a current id that is gone: the first back camera');
eq(Camera.backDevices(DEVS).length, 3, 'three back cameras (Switch lens shown)');
eq(id(Camera.nextBackDevice(DEVS.map((d) => Object.assign({}, d, { label: '' })), 'b0')), null, 'labels empty: no back lens to switch to');

console.log('acquire: the stream chain');
function fakeMd(rule) {
  const calls = [];
  return {
    calls,
    getUserMedia: async (c) => {
      calls.push(c.video);
      const r = rule(c.video, calls.length);
      if (r instanceof Error) throw r;
      return { id: 's' + calls.length, getVideoTracks: () => [], getTracks: () => [] };
    },
    enumerateDevices: async () => DEVS,
  };
}
const err = (name) => { const e = new Error(name); e.name = name; return e; };
(async () => {
  {
    const md = fakeMd((v) => (v.facingMode && v.facingMode.exact ? err('OverconstrainedError') : true));
    const r = await Camera.acquire(md, null);
    ok(r.stream && r.step === 2, 'exact environment refused (no facing mode, as the fake device): ideal environment gives the stream', r.step);
    ok(md.calls[0].facingMode.exact === 'environment' && md.calls[0].width.ideal === 4000 && md.calls[0].height.ideal === 3000, 'first ask: exact environment, 4000 x 3000 ideal', md.calls[0]);
  }
  {
    const md = fakeMd((v) => (v.deviceId && v.deviceId.exact === 'b2' ? true : err('OverconstrainedError')));
    const r = await Camera.acquire(md, 'b2');
    ok(r.step === 0 && md.calls.length === 1, 'the remembered lens is tried first', md.calls);
  }
  {
    const md = fakeMd((v) => (v.deviceId && v.deviceId.exact === 'b0' ? true : err(v.deviceId ? 'NotFoundError' : 'OverconstrainedError')));
    const r = await Camera.acquire(md, 'gone');
    ok(r.step === 3 && md.calls.length === 4 && md.calls[3].deviceId.exact === 'b0', 'remembered lens gone, no facing mode: a back-labelled device by id', md.calls);
  }
  {
    const md = fakeMd((v) => (v.facingMode || v.deviceId ? err('OverconstrainedError') : true));
    const r = await Camera.acquire(md, null);
    ok(r.step === 4 && !md.calls[md.calls.length - 1].facingMode && !md.calls[md.calls.length - 1].deviceId, 'last: any video device', md.calls);
  }
  {
    const md = fakeMd(() => err('NotAllowedError'));
    const r = await Camera.acquire(md, null);
    ok(!r.stream && r.error === 'denied' && md.calls.length === 1, 'permission refused: the chain stops at once, "denied"', { r, n: md.calls.length });
  }
  {
    const md = fakeMd(() => err('NotFoundError'));
    const r = await Camera.acquire(md, null);
    ok(!r.stream && r.error === 'nocamera', 'no camera at all: "nocamera"', r);
    ok(md.calls.every((v) => !(v.facingMode && (v.facingMode.exact === 'user' || v.facingMode.ideal === 'user'))), 'the front camera is never asked for', md.calls);
  }
  ok((await Camera.acquire(null, null)).error === 'nocamera', 'no mediaDevices: "nocamera"');
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
