/* L-Tech Waypoint — camera.js: the in-app camera of the proof sheet (back lens, full-size stills). No library, no network.
 * Pure (node + browser): isBackLabel, isFrontLabel, backDevices, pickBackDevice, nextBackDevice, acquire (the stream chain, given a
 * mediaDevices object), photoSize (the takePhoto() size from getPhotoCapabilities(): the largest, long side capped at 4096 px),
 * useFrame (the video frame wins when takePhoto() failed or gave a long side under 1600 px while the frame is larger).
 * Every still says its own pixel size to onShot ({srcW, srcH}).
 * Browser only: open(kind, hooks) shows a full-screen camera view (live preview, shutter, "2 of 6", Done, Switch lens when there is
 * more than one back camera); close() stops every track. The last lens used is remembered (localStorage, the deviceId only).
 * The stream chain, first that works: the remembered lens; facingMode {exact: "environment"}; {ideal: "environment"}; a videoinput
 * labelled back / rear / environment by deviceId; any video device. The front camera is never asked for.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Camera = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const LENS_KEY = 'waypoint:meta:cameraLens';
  const SIZE = { width: { ideal: 4000 }, height: { ideal: 3000 } };
  const TAKE_PHOTO_MS = 8000, CAPS_MS = 3000;
  const STILL_MAX = 4096; // the long side asked of takePhoto(), at most
  const STILL_MIN = 1600; // a still with a shorter long side loses to a larger video frame

  // photoSize(caps, maxLong) -> {imageWidth, imageHeight} for takePhoto(): the largest size getPhotoCapabilities() offers, scaled
  // down (aspect kept, on its step) to a long side of at most maxLong (4096); null when the capabilities give no size.
  function photoSize(caps, maxLong) {
    const rw = caps && caps.imageWidth, rh = caps && caps.imageHeight;
    const W = rw && Number(rw.max), H = rh && Number(rh.max);
    if (!(W > 0) || !(H > 0)) return null;
    const k = Math.min(1, (maxLong || STILL_MAX) / Math.max(W, H));
    const fit = (v, r) => {
      const mn = Number(r.min) > 0 ? Number(r.min) : 1, st = Number(r.step) > 0 ? Number(r.step) : 1;
      const x = Math.floor(v * k + 1e-9);
      return Math.max(mn, mn + Math.floor((x - mn) / st + 1e-9) * st);
    };
    return { imageWidth: fit(W, rw), imageHeight: fit(H, rh) };
  }
  // useFrame(still {w, h} | null, frame {w, h}) -> true when the video frame is the better source: takePhoto() gave nothing, or a
  // still whose long side is under 1600 px while the video frame is larger
  function useFrame(still, frame) {
    const fl = frame ? Math.max(frame.w || 0, frame.h || 0) : 0;
    if (!still || !(still.w > 0) || !(still.h > 0)) return fl > 0;
    const sl = Math.max(still.w, still.h);
    return sl < STILL_MIN && fl > sl;
  }

  const isBackLabel = (label) => /back|rear|environment/i.test(String(label || ''));
  const isFrontLabel = (label) => /front|user|selfie|facetime/i.test(String(label || ''));
  const videoInputs = (devices) => (devices || []).filter((d) => d && d.kind === 'videoinput');
  // the back-facing video inputs, in the browser's order (by label: empty labels, before permission, are not known to be back)
  const backDevices = (devices) => videoInputs(devices).filter((d) => isBackLabel(d.label) && !/front/i.test(d.label));

  // pickBackDevice(devices, rememberedId) -> the device to ask for first, or null: the remembered lens while it is still in the
  // list (and not labelled front), else the first back-labelled one.
  function pickBackDevice(devices, rememberedId) {
    const vids = videoInputs(devices);
    if (rememberedId) {
      const r = vids.find((d) => d.deviceId === rememberedId);
      if (r && !isFrontLabel(r.label)) return r;
    }
    return backDevices(devices)[0] || null;
  }
  // nextBackDevice(devices, currentId) -> the next back lens after currentId (cycling; the first when currentId is not a back lens),
  // null when no back lens is known
  function nextBackDevice(devices, currentId) {
    const back = backDevices(devices);
    if (!back.length) return null;
    const i = back.findIndex((d) => d.deviceId === currentId);
    return back[(i + 1) % back.length];
  }

  const isDenied = (e) => !!e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'PermissionDeniedError');
  // acquire(md, rememberedId) -> {stream, step, error}: step 0 remembered lens, 1 exact environment, 2 ideal environment,
  // 3 a back-labelled device by deviceId, 4 any video device. A permission refusal stops the chain (error 'denied');
  // nothing working -> error 'nocamera'.
  async function acquire(md, rememberedId) {
    if (!md || typeof md.getUserMedia !== 'function') return { stream: null, step: -1, error: 'nocamera' };
    let denied = null;
    const ask = async (video) => {
      try { return await md.getUserMedia({ video, audio: false }); } catch (e) { if (isDenied(e)) denied = e; return null; }
    };
    let s = null;
    if (rememberedId) { s = await ask(Object.assign({ deviceId: { exact: rememberedId } }, SIZE)); if (s) return { stream: s, step: 0, error: null }; if (denied) return { stream: null, step: 0, error: 'denied' }; }
    s = await ask(Object.assign({ facingMode: { exact: 'environment' } }, SIZE));
    if (s) return { stream: s, step: 1, error: null };
    if (denied) return { stream: null, step: 1, error: 'denied' };
    s = await ask(Object.assign({ facingMode: { ideal: 'environment' } }, SIZE));
    if (s) return { stream: s, step: 2, error: null };
    if (denied) return { stream: null, step: 2, error: 'denied' };
    let devices = [];
    try { devices = (md.enumerateDevices ? await md.enumerateDevices() : []) || []; } catch (e) { devices = []; }
    const back = pickBackDevice(devices, null);
    if (back && back.deviceId) {
      s = await ask(Object.assign({ deviceId: { exact: back.deviceId } }, SIZE));
      if (s) return { stream: s, step: 3, error: null };
      if (denied) return { stream: null, step: 3, error: 'denied' };
    }
    s = await ask(Object.assign({}, SIZE));
    if (s) return { stream: s, step: 4, error: null };
    return { stream: null, step: 4, error: denied ? 'denied' : 'nocamera' };
  }

  // ---------- browser ----------
  function el(tag, props, ...kids) {
    const e = root.document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach((c) => { if (c != null) e.append(c.nodeType ? c : root.document.createTextNode(String(c))); });
    return e;
  }
  function remembered() { try { return root.localStorage.getItem(LENS_KEY) || null; } catch (e) { return null; } }
  function remember(id) { try { if (id && id.length < 300) root.localStorage.setItem(LENS_KEY, id); } catch (e) { /* ignore */ } }
  const stopStream = (s) => { if (s) s.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } }); };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  function frameBlob(video) {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return Promise.resolve(null);
    const c = root.document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    return new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', 0.92));
  }
  async function blobSize(blob) {
    try {
      let b;
      try { b = await root.createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { b = await root.createImageBitmap(blob); }
      const r = { w: b.width, h: b.height };
      try { b.close && b.close(); } catch (e) { /* ignore */ }
      return r;
    } catch (e) { return null; }
  }
  // still(st, video) -> {blob, w, h} | null: ImageCapture.takePhoto() at the largest size getPhotoCapabilities() offers (capped at
  // a 4096 px long side; asked once per track), takePhoto() with no size when that fails, then the video frame when it is the
  // larger source (useFrame)
  async function still(st, video) {
    let blob = null, dims = null;
    if (typeof root.ImageCapture === 'function' && st.track && st.track.readyState === 'live') {
      try {
        if (!st.ic || st.icTrack !== st.track) { st.ic = new root.ImageCapture(st.track); st.icTrack = st.track; st.photoSettings = undefined; }
        if (st.photoSettings === undefined) {
          try { st.photoSettings = photoSize(await withTimeout(st.ic.getPhotoCapabilities(), CAPS_MS), STILL_MAX); } catch (e) { st.photoSettings = null; }
        }
        try { blob = await withTimeout(st.photoSettings ? st.ic.takePhoto(st.photoSettings) : st.ic.takePhoto(), TAKE_PHOTO_MS); }
        catch (e) {
          blob = null;
          if (st.photoSettings) { st.photoSettings = null; try { blob = await withTimeout(st.ic.takePhoto(), TAKE_PHOTO_MS); } catch (e2) { blob = null; } }
        }
      } catch (e) { blob = null; }
    }
    if (blob && blob.size) dims = await blobSize(blob);
    if (!dims) blob = null;
    const frame = { w: video.videoWidth || 0, h: video.videoHeight || 0 };
    if (useFrame(dims, frame)) {
      const fb = await frameBlob(video).catch(() => null);
      if (fb) return { blob: fb, w: frame.w, h: frame.h, from: 'frame' };
    }
    return blob ? { blob, w: dims.w, h: dims.h, from: 'photo' } : null;
  }

  let cur = null; // the open view
  // open(kind, hooks): hooks = {count(kind) -> n, max, label, onShot(blob, kind, {srcW, srcH}) -> Promise, onFallback(kind),
  // onGallery(kind) (a "From gallery" text button in the top bar; called inside the tap), onClose()}
  function open(kind, hooks) {
    if (cur) close();
    const H = hooks || {};
    const max = H.max || 6;
    const md = root.navigator && root.navigator.mediaDevices;
    const video = el('video', { class: 'cam-video', id: 'camVideo', autoplay: true, playsinline: true, muted: true });
    video.muted = true;
    const flash = el('div', { class: 'cam-flash', id: 'camFlash' });
    const count = el('span', { class: 'cam-count', id: 'camCount' });
    const msg = el('div', { class: 'cam-msg', id: 'camMsg', hidden: true });
    const shutter = el('button', { class: 'cam-shutter', id: 'camShutter', type: 'button', 'aria-label': 'Take photo', disabled: true });
    const sw = el('button', { class: 'cam-side', id: 'camSwitch', type: 'button', hidden: true }, 'Switch lens');
    const done = el('button', { class: 'cam-side cam-done', id: 'camDone', type: 'button' }, 'Done');
    const gallery = H.onGallery ? el('button', { class: 'cam-link', id: 'camGallery', type: 'button' }, 'From gallery') : null;
    const view = el('div', { class: 'cam-view', id: 'camView', role: 'dialog', 'aria-label': (H.label || 'Camera'), 'data-kind': kind },
      video, flash,
      el('div', { class: 'cam-top' }, el('span', { class: 'cam-kind' }, H.label || 'Camera'), gallery, count),
      msg,
      el('div', { class: 'cam-bar' }, el('div', { class: 'cam-slot' }, sw), shutter, el('div', { class: 'cam-slot' }, done)));
    root.document.body.append(view);
    const st = { kind, view, stream: null, track: null, deviceId: null, busy: false, closed: false, starting: null, hooks: H, popped: false };
    cur = st;
    const n = () => (H.count ? H.count(kind) : 0);
    const paint = () => {
      count.textContent = n() + ' of ' + max;
      shutter.disabled = st.busy || !st.track || n() >= max;
      if (gallery) gallery.disabled = st.busy || n() >= max;
    };
    st.paint = paint;
    if (gallery) gallery.addEventListener('click', () => { if (!st.busy && n() < max) H.onGallery(kind); });
    function fail(kindOfErr) {
      msg.replaceChildren(
        el('p', null, kindOfErr === 'denied' ? 'Camera permission is off for this app, so the camera cannot open here.' : 'No camera was found on this phone.'),
        el('button', { class: 'primary', id: 'camFallback', type: 'button', onclick: () => { const fb = H.onFallback; close(); if (fb) fb(kind); } }, 'Use phone camera'));
      msg.hidden = false;
      paint();
    }
    async function start(preferId) {
      if (st.closed) return;
      const p = (async () => {
        const r = await acquire(md, preferId || remembered());
        if (st.closed || cur !== st) { stopStream(r.stream); return; }
        if (!r.stream) { fail(r.error); return; }
        st.stream = r.stream; st.step = r.step;
        st.track = r.stream.getVideoTracks()[0] || null;
        const set = st.track && st.track.getSettings ? st.track.getSettings() : {};
        st.deviceId = set.deviceId || null;
        if (st.deviceId && set.facingMode !== 'user' && !isFrontLabel(st.track && st.track.label)) remember(st.deviceId);
        video.srcObject = r.stream;
        try { await video.play(); } catch (e) { /* autoplay muted: fine */ }
        msg.hidden = true;
        try {
          const devs = md.enumerateDevices ? await md.enumerateDevices() : [];
          sw.hidden = backDevices(devs).length < 2;
        } catch (e) { sw.hidden = true; }
        paint();
      })();
      st.starting = p;
      await p;
      st.starting = null;
    }
    function stopTracks() { stopStream(st.stream); st.stream = null; st.track = null; video.srcObject = null; paint(); }
    async function shoot() {
      if (st.busy || !st.track || n() >= max) return;
      st.busy = true; paint();
      let s = null;
      try { s = await still(st, video); } catch (e) { s = null; }
      if (!s || st.closed) { st.busy = false; if (!st.closed) paint(); return; }
      st.last = { w: s.w, h: s.h, from: s.from };
      flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
      try { if (H.onShot) await H.onShot(s.blob, kind, { srcW: s.w, srcH: s.h }); } catch (e) { /* the sheet shows its own error */ }
      st.busy = false;
      if (!st.closed) paint();
    }
    shutter.addEventListener('click', shoot);
    done.addEventListener('click', () => close());
    sw.addEventListener('click', async () => {
      if (!md || st.busy) return;
      let devs = [];
      try { devs = await md.enumerateDevices(); } catch (e) { return; }
      const next = nextBackDevice(devs, st.deviceId);
      if (!next || next.deviceId === st.deviceId) return;
      stopTracks();
      remember(next.deviceId);
      await start(next.deviceId);
    });
    st.onVis = () => {
      if (st.closed) return;
      if (root.document.visibilityState === 'hidden') stopTracks();
      else if (!st.stream && !st.starting && msg.hidden) start(st.deviceId);
    };
    root.document.addEventListener('visibilitychange', st.onVis);
    // the back gesture closes the camera view (not the sheet)
    st.onPop = () => { if (cur === st) { st.popped = true; close(); } };
    try { root.history.pushState({ wpCamera: 1 }, ''); root.addEventListener('popstate', st.onPop); } catch (e) { /* ignore */ }
    paint();
    start();
    return st;
  }
  // close(): every track stopped, the view gone, an open corner screen resolved as Retake
  function close() {
    const st = cur;
    if (!st) return;
    cur = null;
    st.closed = true;
    stopStream(st.stream); st.stream = null; st.track = null;
    try { const v = st.view.querySelector('video'); if (v) v.srcObject = null; } catch (e) { /* ignore */ }
    try { if (root.Scan && root.Scan.closeCornerScreen) root.Scan.closeCornerScreen(); } catch (e) { /* ignore */ }
    root.document.removeEventListener('visibilitychange', st.onVis);
    try { root.removeEventListener('popstate', st.onPop); } catch (e) { /* ignore */ }
    if (!st.popped) { try { if (root.history.state && root.history.state.wpCamera) root.history.back(); } catch (e) { /* ignore */ } }
    st.view.remove();
    if (st.hooks.onClose) st.hooks.onClose();
  }
  const isOpen = () => !!cur;
  const view = () => (cur ? cur.view : null);
  const refresh = () => { if (cur && cur.paint) cur.paint(); }; // the counter again (photos added from the gallery)
  const lastStill = () => (cur && cur.last ? Object.assign({}, cur.last) : null);

  return { LENS_KEY, STILL_MAX, STILL_MIN, isBackLabel, isFrontLabel, backDevices, pickBackDevice, nextBackDevice, acquire, photoSize, useFrame, open, close, isOpen, view, refresh, lastStill };
});
