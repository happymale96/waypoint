/* Waypoint - editing a job (pure; node + browser, exports via module.exports or window.JobEdit).
 *
 * A job on the Plan tab can be changed in place: same id, same position in the list, same hold state, same carry-forward history,
 * same link to a loose "with you" item. The form of the Add job sheet is the one used (EDIT mode, pre-filled).
 *
 *   form = { mode: 'delivery' | 'errand',
 *            pickups: [{ref?, placeId, item}],   // ref = index of the pickup in the job it came from (none = a new pickup)
 *            deliveryPlaceId, inHandItem,
 *            errandPlaceId, dwellMin,            // '' = the place's own dwell (the caller passes placeDwell)
 *            notes, urgent, after, before }       // after / before = 'HH:MM' or ''
 *
 *   validate(form)                       -> error text or ''   (the one validation: Add job and Edit job)
 *   isEditable(job)                      -> false for a fully done job
 *   donePickups(job)                     -> the pickups already collected (read-only in the form)
 *   formOf(job)                          -> the form a job opens with
 *   updateJob(jobs, id, form, opts)      -> {ok:true, jobs (a new list, same order, same length), job, ignored:[...]} or {ok:false, error, jobs (unchanged)}
 *       opts.placeDwell(placeId) -> default dwell of an errand place
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JobEdit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isDonePickup = (p) => !!(p && p.done);
  const isEditable = (j) => !!j && j.status !== 'done';
  const donePickups = (j) => (j.pickups || []).filter(isDonePickup);

  // The one validation of the job form (Add job and Edit job). Returns '' when the form is fine, else what is wrong.
  function validate(form, job) {
    if (form.mode === 'errand') return form.errandPlaceId ? '' : 'Pick the errand place';
    const done = job ? donePickups(job) : [];
    const entries = (form.pickups || []);
    if (entries.some((p) => !p.placeId && String(p.item || '').trim())) return 'A pickup has an item but no place';
    const places = entries.filter((p) => p.placeId).map((p) => p.placeId).concat(done.map((p) => p.placeId));
    if (!places.length && !form.deliveryPlaceId) return 'Add a pickup or a delivery place';
    if (form.deliveryPlaceId && places.includes(form.deliveryPlaceId)) return 'Pickup and delivery cannot be the same place';
    return '';
  }

  function formOf(job) {
    const errand = !!job.errandPlaceId;
    return {
      mode: errand ? 'errand' : 'delivery',
      pickups: (job.pickups || []).map((p, i) => ({ ref: i, placeId: p.placeId, item: p.item || '', done: !!p.done, doneAt: p.doneAt || null })),
      deliveryPlaceId: job.deliveryPlaceId || null, inHandItem: job.inHandItem || '',
      errandPlaceId: job.errandPlaceId || null, dwellMin: job.dwellMin != null ? String(job.dwellMin) : '',
      notes: job.notes || '', urgent: !!job.urgent, after: job.arriveAfter || '', before: job.arriveBefore || '',
    };
  }

  // Edit job `id` of `jobs` from `form`. Nothing is changed unless it all validates.
  function updateJob(jobs, id, form, opts) {
    opts = opts || {};
    const i = jobs.findIndex((j) => j.id === id);
    if (i < 0) return { ok: false, error: 'Job not found', jobs };
    const old = jobs[i];
    if (!isEditable(old)) return { ok: false, error: 'A job that is done cannot be edited', jobs };
    const hasDone = donePickups(old).length > 0;
    if (hasDone && form.mode === 'errand') return { ok: false, error: 'A job with a part already done cannot become an errand', jobs };
    const err = validate(form, old);
    if (err) return { ok: false, error: err, jobs };

    const j = JSON.parse(JSON.stringify(old)); // keeps id, status (held stays held), createdAt, looseId, carriedFrom, carryReason, doneAt, ...
    const ignored = [];
    j.notes = String(form.notes || '').trim();
    j.arriveAfter = form.after || null;
    j.arriveBefore = form.before || null;

    if (form.mode === 'errand') {
      j.errandPlaceId = form.errandPlaceId;
      j.dwellMin = form.dwellMin === '' || form.dwellMin == null ? (opts.placeDwell ? opts.placeDwell(form.errandPlaceId) : 10) : Number(form.dwellMin);
      j.pickups = []; j.deliveryPlaceId = null; delete j.inHandItem;
      j.urgent = false; j.urgentRank = 0;
    } else {
      delete j.errandPlaceId; if (old.errandPlaceId) delete j.dwellMin;
      // the done pickups stay exactly as they were (a changed place / item for them is ignored); the pending ones follow the form
      const keep = donePickups(old);
      (form.pickups || []).forEach((p) => {
        const o = p.ref != null ? (old.pickups || [])[p.ref] : null;
        if (o && o.done && (p.placeId !== o.placeId || String(p.item || '').trim() !== String(o.item || '').trim())) ignored.push('pickup');
      });
      const fresh = (form.pickups || []).filter((p) => p.placeId && !((p.ref != null) && (old.pickups || [])[p.ref] && (old.pickups || [])[p.ref].done))
        .map((p) => ({ placeId: p.placeId, item: String(p.item || '').trim(), done: false }));
      j.pickups = keep.map((p) => Object.assign({}, p)).concat(fresh);
      j.deliveryPlaceId = form.deliveryPlaceId || null;
      if (!j.pickups.length) j.inHandItem = String(form.inHandItem || '').trim(); else delete j.inHandItem;
    }

    // urgent: switching it on = next rank; off = cleared and the rest renumbered 1..n (what the Urgent button does)
    let list = jobs.map((x, k) => (k === i ? j : x));
    const wantUrgent = form.mode !== 'errand' && !!form.urgent;
    if (wantUrgent && !old.urgent) {
      const max = Math.max(0, ...jobs.filter((x) => x.id !== id && x.urgent && x.status !== 'done').map((x) => x.urgentRank || 0));
      j.urgent = true; j.urgentRank = max + 1;
    } else if (!wantUrgent && old.urgent) {
      j.urgent = false; j.urgentRank = 0;
      const rest = list.filter((x) => x.urgent && x.status !== 'done').sort((a, b) => (a.urgentRank || 0) - (b.urgentRank || 0));
      const rank = new Map(rest.map((x, k) => [x.id, k + 1]));
      list = list.map((x) => (rank.has(x.id) && x.urgentRank !== rank.get(x.id) ? Object.assign({}, x, { urgentRank: rank.get(x.id) }) : x));
    } else if (wantUrgent) { j.urgent = true; j.urgentRank = old.urgentRank || 0; }
    else { j.urgent = false; j.urgentRank = 0; }
    list[i] = j;
    return { ok: true, jobs: list, job: j, ignored, changedIds: list.filter((x, k) => x !== jobs[k]).map((x) => x.id) };
  }

  return { validate, isEditable, donePickups, formOf, updateJob };
});
