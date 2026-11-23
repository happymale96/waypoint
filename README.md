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
| `daylog.js` | End-of-day record + `summarise()` (pure: km, hours, collected/delivered, carry-forward, CSV / WhatsApp text, history). One record per device-local date (a plan run keeps its depart date past midnight); End day closes the open day and never creates an empty record; activity on a closed date merges into it. One-time repair on load (`runRepairOnce`, flag `meta:daylogRepair`, backup `backup:daylogs-repair-1`). Export/Import JSON carry `dayLog` + `dayHistory` |
| `geo.js` | Pure location helpers: coordinate parsing (manual place entry), the geolocation fix rules, place-record builders, pin move / undo |
| `reached.js` | Pure "Reached before Done" helpers: the one-button state (REACHED, then DONE, 500 ms double-tap guard), Undo rules, `autoReachTarget` (within 150 m, fresh fix, accuracy 100 m or better, exactly one pending stop, never the end point), `daySplit` (driving vs on site, estimated arrivals) and carry-forward |
| `fuel.js` | Pure "Add fuel stop" helpers: sample points along the remaining route, allowed legs (never before an urgent delivery), shortlist by straight-line detour, lowest-minutes insertion, Places search budget (daily guard 140), permanent station memory merge, 10-minute reuse key |
| `sw.js`, `manifest.json`, `icon-*.png` | PWA shell |
| `tools/smoke-fuel.js` | `node tools/smoke-fuel.js`: mocked browser smoke of the fuel-stop flow (own local server, headless Chrome / Edge over DevTools; Places, TomTom, geolocation and the clock are mocked; no screenshots) |
| `tools/smoke-reached.js` | `node tools/smoke-reached.js`: mocked browser smoke of Reached / auto-reach / the double-tap guard / the End day driving-vs-on-site line (TomTom, geolocation, visibility and the clock are mocked; no screenshots) |
| `tools/verify-icons.js` | `node tools/verify-icons.js <icon-pack folder>`: checks icon references, PNG sizes and the pack's SHA-256s. The icon PNGs/SVGs are a pre-rendered pack from the official vector logo; never regenerate or resize them |
| `tools/stamp-sw.js` | Writes the build stamp into `sw.js` and `app.js` — **run before every commit** (see below) |
| `test/*.test.js` | `TZ=Asia/Kuala_Lumpur sh -c "node test/solver.test.js && node test/messages.test.js && node test/daylog.test.js && node test/location.test.js && node test/route.test.js && node test/geo.test.js && node test/endday.test.js && node test/changes.test.js && node test/lunch.test.js && node test/fuel.test.js && node test/reached.test.js && node tools/check-icons.js"` (day keys are the device's local date) |

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
- **Google Places (New)** — place search only, and only when you tap *Search Google*. Saved places are searched locally first. The Settings screen shows a client-side call counter (this device only; no Google-side cap is set yet). One request type: `POST places:searchText`, field mask `places.displayName,places.formattedAddress,places.location` (Text Search **Pro** SKU; all three fields are read).

TomTom's current docs list `routeSummary.travelTimeInSeconds` (and `trafficDelayInSeconds`) in the response; `noTrafficTravelTimeInSeconds` is not documented, so it is only used as a fallback if present. `departAt` must be `now` or a future time; the first slice uses `now` when departing immediately.

## Solver rules (solver.js)
- One visit per distinct place (merging all pickups, deliveries, errands there). Max 12 places.
- Hard: pickups before their delivery; urgent deliveries before every non-urgent delivery, in `urgentRank` order (a merged stop uses the lowest rank delivered there); with *No detour*, stops that contain no urgent-job action wait until every urgent delivery is done; `arriveBefore` is hard (if nothing fits, the 5 least-late plans are returned with violations named). `arriveAfter` makes you wait at the stop (shown as a wait), it is not a violation.
- Closed windows are `{days:[1..7] (ISO, Mon=1), from, to}` per place, matched against the weekday of the predicted arrival. By default they are advisory (CLOSED badge only). With `respectClosedWindows` an arrival inside a window waits until it ends (the wait counts toward the total; dwell starts after) — the solver reorders when that beats waiting. The Route tab's **Avoid lunch** button runs exactly that on the not-done stops from the cached matrices (no API call) and shows it as an alternative card with the time delta; *Use this* adopts it.
- `Solver.retime(plan, fromStopIndex, nowISO)` re-times the not-done stops of a stored plan (order unchanged, nearest-slice matrices, dwell, waits). The app calls it on DONE/SKIP, on launch and when the app returns to the foreground. Travel times older than 30 min are re-fetched at a DONE.
- The current plan (order, ETAs, done/skipped state, matrices with `fetchedAt`) is stored, so the Route tab survives closing the app and the service-worker reload. *Clear plan* forgets it.
- Objective: minimum elapsed time start → end (drive + dwell + waits). Each leg uses the matrix slice whose `departAt` is nearest the leg's predicted departure.
- Search: DFS with constraint pruning, an admissible lower bound, and a top-5 dominance table; hard time-limit of 1.8 s (returns best found).

## Fuel stop (Route tab → Add fuel stop)
Settings → **Fuel**: brand (default Caltex), fuel stop dwell (7 min), max searches per tap (1–50, default 50). A tap searches Google Places for the brand around sample points every ~4 km along the **whole remaining route** (≤ 5 at a time, every call counted in the daily counter; the daily guard stops at 140 calls a day), keeps results whose name contains the brand, and adds them to a permanent **station memory** (Export/Import JSON; never shown in the Places tab; Settings → *Forget stations*). The 5 stations with the smallest straight-line detour are timed with TomTom (existing lookup + cache) and the one with the fewest extra minutes, at the best of its 2 best legs, is shown in a preview: **Add**, **Next best** (no new search), **Cancel**. Fuel never goes before a pending urgent delivery. Nothing is added without **Add**. A search of the same remaining route under 10 minutes ago is reused (0 Places calls); with no Google key, offline or no budget left the remembered stations are used. One fuel stop per plan (*Change fuel stop* replaces it). It is a normal stop (DONE / SKIP / REMOVE, no WhatsApp); *Replan from here*, *No detour* and *Avoid lunch* keep it. In the day log it is a stop with a done time, **not a job**: job counts ignore it and it never carries forward; the summary shows `Fuel: <station> <time>`.

## Reached before Done (Route tab)
Every ordinary stop and the fuel stop has ONE primary button: **REACHED** until you arrive, then **DONE** (same place and size). REACHED only stamps the arrival time (no WhatsApp message, no day-log entry); for 500 ms after it the button ignores taps. The card then shows `Reached 14:10` (`· auto` when it was automatic) with a small **Undo**; Undo returns the button to REACHED and stops auto-reach for that stop for the rest of the plan. Undo of DONE returns to the reached state (reachedAt kept); SKIP works from either state. The end-point card keeps its ARRIVED button.
- **Auto-reach** (Settings → Reached, default on): within 150 m of exactly one pending stop, app open, with a fresh fix (the app's 5-minute origin rule) accurate to 100 m or better, evaluated on every GPS update and when the page becomes visible. Toast `Reached <name> 14:10 (auto) · Undo`. No background work, no new permission.
- **Re-time**: a reached, not-done stop is *on site*: expected departure = max(now, reachedAt + planned dwell), later stops are timed from that; the status line reads `On site at <name> since 14:10`.
- **Day log / summary**: each done event keeps reachedAt, reachedSource and the planned dwell (raw). End day and the day's history show `Driving 2 h 40 min · On site 1 h 47 min` (`(part estimated)`) and per stop `arr 14:10 · left 14:32`. Arrival = reachedAt, except when it is missing or under 60 s before DONE (a double-tap on leaving): then `doneAt − planned dwell`, never before the previous departure, shown as `~14:12`. The final drive counts once the end point was marked ARRIVED. Days with no reachedAt anywhere show the summary as before (nothing is backfilled).

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

## ETAs from your location
On opening the Route tab, returning to the app, and after DONE (at most once per 2 minutes, skipped if you moved under 300 m), the app takes a geolocation fix **only if permission is already granted** (high accuracy, 5 s; accuracy worse than 200 m is ignored). With a good fix it makes ONE TomTom Matrix request (you → next stop, live traffic) and re-times the stops via `Solver.retime(plan, from, now, {durationToNextSec})`: first ETA = now + that duration, later ETAs follow through the existing legs and dwell times; order never changes. Within 150 m of the next stop it counts as arrived (no request). CLOSED / LATE flags and the Avoid-lunch delta follow the new times. The Route tab says "Times from your location, HH:MM" or "Times from plan start" (no fix, denied, offline, provider error).

## Route tab: what the header and status line mean
- Header = the current re-timed plan: stops left (not done, not skipped), time left to the re-timed end arrival, the end arrival, "Departed HH:MM" (original depart). The Route tab re-renders once a minute (no network call); no stop or end time is ever shown in the past (a past ETA becomes now and later times shift with it).
- Status line (tap = retry now, bypassing the 2-min / 300 m throttle): "Times from your location, HH:MM", "Times from last DONE, HH:MM" or "Times from plan start"; without a live fix it adds why: location not allowed / no GPS fix / routing failed / offline. A live origin older than 5 min is never reused.
- Fix rules (everywhere): high accuracy, 10 s timeout, maximumAge 60 s; on timeout one retry at low accuracy, 5 s. Route ETAs accept 200 m or better.
- SKIP is an explicit tap only; a skipped stop is greyed, has no ETA, is out of the chain and the counts, and has **Undo skip**.
- The end point is a card (**WAZE**, **ARRIVED**). ARRIVED writes `arrived_end` to the day log (Finished = that time unless edited; the summary adds the last-stop -> end-point leg), shows "Day complete - view summary" and never closes the day. **End day** is also at the bottom of the Route tab.

## Manual places
In any place picker the last row is **Can't find it? Add manually** (always, also offline / on a failed search): name, type, salutation / language, location from **Use where I am now** or pasted coordinates / a long Google Maps link (short links can't be read), optional address note. Saved with `source: "manual"`; zero Google Places or routing requests. In the place editor, **Update location to where I am now** moves a wrong pin (the old one is kept as `previousLocation` for one undo).
