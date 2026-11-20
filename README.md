# L-Tech Waypoint

Delivery-run planner PWA for L-Tech Automation. Vanilla HTML/CSS/JS — no framework, no build step. Phone-first (400 px), dark mode follows the system. Works under a sub-path (`/waypoint/`): all URLs are relative.

Live: https://happymale96.github.io/waypoint/

## Files

| File | Role |
|---|---|
| `index.html`, `styles.css`, `app.js` | UI (Plan / Route / Places / Settings tabs) |
| `solver.js` | Pure planning logic (node + browser). Constraints, branch-and-bound search, top-5 plans |
| `providers.js` | Google Places (New) text search; TomTom Matrix Routing v2 |
| `storage.js` | Async `get/set/list/remove` over localStorage — swap for a hosted backend later |
| `messages.js` | WhatsApp text: greeting, ETA rounding, templates, `wa.me` links |
| `daylog.js` | End-of-day record + `summarise()` (pure: km, hours, collected/delivered, carry-forward, CSV / WhatsApp text, history) |
| `sw.js`, `manifest.json`, `icon-*.png` | PWA shell |
| `tools/make-icons.js` | Builds the 192/512 maskable icons (`npm install` in `tools/` first) |
| `tools/stamp-sw.js` | Writes the build stamp into `sw.js` and `app.js` — **run before every commit** (see below) |
| `test/*.test.js` | `node test/solver.test.js && node test/messages.test.js && node test/daylog.test.js` |

## Releases and the build stamp
The service worker's cache name is `waypoint-<stamp>`. The stamp is an 8-character content hash of the whole app shell (html, css, js, json, icons), written by `tools/stamp-sw.js` into `sw.js` (`BUILD`) and `app.js` (`BUILD_STAMP`, shown in **Settings → build …**).

```
node tools/stamp-sw.js          # stamp (run before every commit; idempotent — same files, same stamp)
node tools/stamp-sw.js --check  # exit 1 if the stamp is stale (use in CI or a pre-commit hook)
```
How a release reaches the phone: the page and every `.html/.js/.css/.json` file are fetched **network-first** (bypassing the HTTP cache, so GitHub Pages' 10-minute `max-age` can't serve stale code) and only fall back to the cache when offline; icons are cache-first. A new `sw.js` installs with `skipWaiting()`, deletes old `waypoint-*` caches on activate, `clients.claim()`s the open page, and the page reloads once. The app also calls `registration.update()` on every launch and whenever it returns to the foreground. API calls (TomTom, Google) are never cached. If the reload would interrupt an open sheet or a running plan, it waits until you are done.

## Keys
Paste them in Settings; they live in this phone's localStorage only (never committed, never exported).
- **TomTom** — all travel times (Matrix Routing v2, live traffic). 3 calls per plan (depart, +2 h, +4 h); results are cached in memory for the session, so the *No detour* toggle re-solves with zero API calls. *Replan from here* forces fresh calls.
- **Google Places (New)** — place search only, and only when you tap *Search Google*. Saved places are searched locally first. The Settings screen shows a client-side call counter; set the real quota cap (150/day) in Google Cloud console.

TomTom's current docs list `routeSummary.travelTimeInSeconds` (and `trafficDelayInSeconds`) in the response; `noTrafficTravelTimeInSeconds` is not documented, so it is only used as a fallback if present. `departAt` must be `now` or a future time; the first slice uses `now` when departing immediately.

## Solver rules (solver.js)
- One visit per distinct place (merging all pickups, deliveries, errands there). Max 12 places.
- Hard: pickups before their delivery; urgent deliveries before every non-urgent delivery, in `urgentRank` order (a merged stop uses the lowest rank delivered there); with *No detour*, stops that contain no urgent-job action wait until every urgent delivery is done; `arriveBefore` is hard (if nothing fits, the 5 least-late plans are returned with violations named). `arriveAfter` makes you wait at the stop (shown as a wait), it is not a violation.
- Closed windows are `{days:[1..7] (ISO, Mon=1), from, to}` per place, matched against the weekday of the predicted arrival. By default they are advisory (CLOSED badge only). With `respectClosedWindows` an arrival inside a window waits until it ends (the wait counts toward the total; dwell starts after) — the solver reorders when that beats waiting. The Route tab's **Avoid lunch** button runs exactly that on the not-done stops from the cached matrices (no API call) and shows it as an alternative card with the time delta; *Use this* adopts it.
- `Solver.retime(plan, fromStopIndex, nowISO)` re-times the not-done stops of a stored plan (order unchanged, nearest-slice matrices, dwell, waits). The app calls it on DONE/SKIP, on launch and when the app returns to the foreground. Travel times older than 30 min are re-fetched at a DONE.
- The current plan (order, ETAs, done/skipped state, matrices with `fetchedAt`) is stored, so the Route tab survives closing the app and the service-worker reload. *Clear plan* forgets it.
- Objective: minimum elapsed time start → end (drive + dwell + waits). Each leg uses the matrix slice whose `departAt` is nearest the leg's predicted departure.
- Search: DFS with constraint pruning, an admissible lower bound, and a top-5 dominance table; hard time-limit of 1.8 s (returns best found).

## First use
1. Open the live URL on the phone (Chrome / Safari).
2. Settings → paste the TomTom key (and the Google key if you want Google place search).
3. Menu → *Add to Home Screen* / *Install app*.
4. Places → check Home and Office; add suppliers/factories (+ WhatsApp number, closed windows).
5. Plan → *Add job*: pickups (place + item), delivery, urgent / time window — or *Errand*.
6. Pick start (My location / a place), end (default Home), depart time (blank = now).
7. Tap **PLAN**. Route tab shows the timeline; *No detour* re-solves instantly.
8. Per stop: **WAZE** to navigate, **MSG** for a WhatsApp ETA, **DONE** when finished (offers to message the next delivery).
9. If plans change: **SKIP**, then *Replan from here*.
10. Settings → Export JSON for a backup.
