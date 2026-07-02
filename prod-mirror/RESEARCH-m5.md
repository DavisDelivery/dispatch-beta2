# M5.2 — Background stop-index architecture

**Date:** 2026-05-26
**Branch:** `claude/dispatch-map-m6-hotfix-502`
**Context:** M6 added an unplanned (status-10) stop scan inline in
`nuvizz-pull-today-stops`. Combined with the load scan it exceeded the 26s
function cap and 502'd every map load. The hotfix disabled it. This work moves
the scan off the request path entirely.

## 1. No bulk stop endpoint exists in NuVizz v7 (confirmed)

The parent app references several date/range-shaped endpoints, but they are
silent-try/catch *fallbacks*, not a working bulk path. Grepping the parent app
(`netlify/functions/nuvizz.cjs`) surfaced only these candidates:

- `/stop/info/customer/{company}?fromDTTM&toDTTM`
- `/stop/eventinfo/{company}?eventDate`
- `/event/eventactivity/{company}?entityType=ROUTE&eventDttm`
- `/load/static/info/{company}?routeDate`

No endpoint with a POST filter body exists. Prior forensics
(`RESEARCH-parent-app-endpoints.md`, 2026-05-22) already concluded "No new
native endpoints to discover."

**Live verification (2026-05-26, via the deployed parent proxy's raw passthrough,
real Davis creds):**

| Endpoint | Result |
|---|---|
| `/stop/eventinfo?eventDate=2026-05-26` | `400 "Either stopId or stopNbr is mandatory"` (reasonCode 901) — per-stop event log; eventDate ignored |
| `/stop/info/customer?fromDTTM&toDTTM` | `400 "Required parameter 'custAccNbr' is not present"` — per-customer only |
| `/event/eventactivity?entityType=ROUTE&eventDttm` | `400 "Required parameter 'entityId' is not present"` — per-entity |
| `/load/static/info?routeDate` | `501 Not Implemented` |
| `/stop/info/{nbr}` (control) | `200 OK` — single-record GET works |

Every list-style endpoint demands a per-record id. **The per-stop / per-load GET
is the only functional read path → a number-space scan is the only way to
discover a day's stops, especially unplanned orders that aren't on any load.**

## 2. Scan call sequence

`lib/nuvizz-scan.mts` → `scanDate(date)` runs two scans concurrently:

1. **Planned stops — load-number scan.** Estimate the day's load-number range
   from a calibrated anchor (`ANCHOR_LOAD` 192900 @ 2026-04-22, ~80 loads/day,
   ±250 window). Probe `/load/info/{DAVIS+9digit}` in parallel (concurrency 30);
   keep loads whose `loadHeader.earliestStartDttm` matches the date; flatten
   their `stops[]`, stamping load context (loadNbr, driver, stopSeq) onto each.
2. **Unplanned stops — stop-number scan.** Find a ceiling just above the live
   frontier (highest existing stop number) via a doubling gallop + binary search
   on `/stop/info/{9digit}` (anchor `STOP_ANCHOR_NBR` 7124000 @ 2026-05-26,
   ~440 stops/day). Descend in chunks of 40, keeping stops with
   `stopExecutionInfo.stopStatus === '10'` whose `to.schedule.timeFrom` date
   matches; early-stop once past the (contiguous, newest-at-top) unplanned
   cluster. Self-calibrates the observed frontier.

Results are deduped (a stop already on a load wins), normalized
(`normalizeStop`), and tagged `isPlanned = !!loadNbr`.

## 3. Scan timing (measured live, 2026-05-26)

| Scan | Time | Result |
|---|---|---|
| Load scan only (`?unplanned=0`, nocache) | **14.0s** | 103 planned stops |
| Load + unplanned inline (`nocache`) | **502 @ 22.3s** | exceeds 26s request cap |

→ The load scan alone is 54% of the request budget; adding the unplanned scan
tips it over. **Inline is non-viable regardless of bounding.** A background
function (15-min limit) is required.

**Background per-date estimate:** ~20–35s per date (load + unplanned, no cap).
Scanning today + 7 days sequentially ≈ **3–5 min**. The `*/5` cron is adequate;
if scan duration ever approaches 5 min (more days / slower NuVizz), reduce the
day count or widen the interval so runs don't overlap.

## 4. Firestore schema — `nuvizz_stop_index`

Project: `davismarginiq` (same SA as the parent app, `FIREBASE_SA`). Layout
mirrors the parent's proven `nuvizzFleet` pattern (each REST path level is a real
doc; `{tenant}__{date}` parent id):

```
nuvizz_stop_index/{tenant}__{date}                  ← meta doc
    { tenant, date, last_scanned_at, count, plannedCount, unplannedCount }
nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr}  ← one doc per stop
    { ...normalizedStop, isPlanned, last_scanned_at, raw }
```

- **Doc key:** `stopNbr` (9-digit, e.g. `007123931`) — unique, slash-free.
- Each stop doc carries the full normalized shape (address, lat/lng, status,
  route assignment, scheduled window, etc.) + `isPlanned` (false on unplanned
  status-10 stops) + `last_scanned_at` + `raw` payload, per brief.
- The writer **prunes** stop docs that disappeared since the previous scan
  (cancelled / replanned orders) and writes the meta doc last so a reader never
  sees a fresh timestamp over a half-written set.

## 5. Components

| File | Role |
|---|---|
| `lib/nuvizz-scan.mts` | Shared scan + normalize (`scanDate`) |
| `lib/firestore.mts` | Firestore REST client + `writeStops` / `readStops` |
| `lib/refresh-stops-core.mts` | Shared writer handler (`runRefreshStops`); scans today+7, writes the index. HTTP-triggerable. |
| `nuvizz-refresh-stops-background.mts` | Daytime scheduled wrapper (`*/5 14-23 * * 1-5`) → core |
| `nuvizz-refresh-stops-evening-background.mts` | Evening + Sun-night scheduled wrapper (`*/5 0-3 * * 1-6`) → core |
| `nuvizz-pull-today-stops.mts` | Map feed — reads the index in <2s, returns `lastScannedAt` |
| `src/App.jsx` | "Stops as of HH:MM" freshness label (`fmtStopFreshness`) |

## 5a. Cron schedule + DST handling

**Target (Eastern):** every 5 min, Mon–Fri 10:00am–11:59pm ET, **plus** Sun
10:00pm–11:59pm ET (catches stops Uline drops over the weekend so Monday's
dispatch starts fresh).

**Netlify capability (confirmed via the Netlify coding context):** a scheduled
function accepts exactly **one** cron expression (`config.schedule` is a single
string — no arrays); crons run in **UTC**; the **`-background` suffix** grants the
15-min budget the multi-day scan needs (a plain scheduled function caps at 30s);
and **schedules only fire on published deploys** (never previews — use the manual
POST to test). The target needs two disjoint UTC windows, so per option (a) we
use **two scheduled function files** sharing one handler (`refresh-stops-core`).

| Window | Cron (UTC) | Covers (ET, EDT) |
|---|---|---|
| Daytime | `*/5 14-23 * * 1-5` | Mon–Fri 10:00am–7:59pm |
| Evening + Sun-night | `*/5 0-3 * * 1-6` | Sun 10pm–11:59pm **and** Mon–Fri 8pm–11:59pm |

UTC weekday numbering ≠ ET: Sun-10pm-ET → Mon-02:00-UTC (day 1), Fri-evening-ET →
Sat-00:00-UTC (day 6) — which is why the evening cron is `1-6` and there is **no**
`getUTCDay()` weekend skip in the handler (it would wrongly drop the Fri-evening
run that lands on Saturday UTC). A single union expression was rejected as lossy
(`0-3,14-23 * * 1-6` would also scan Sat 10am–8pm ET, which Davis never dispatches).

**DST:** expressions are tuned for **EDT (UTC−4)**. On **2026-11-01** ET → EST
(UTC−5); shift every UTC hour **+1** to keep the same ET local times:

| Window | EST cron (UTC) |
|---|---|
| Daytime | `*/5 15-23 * * 1-5` |
| Evening + Sun-night | `*/5 0-4 * * 1-6` |

Reverts on **2027-03-08** (EST→EDT) — restore the EDT expressions. Netlify cron is
fixed UTC with no auto-DST, so this is a manual ~2-line edit per file each flip;
the flip dates + replacement expressions are documented in-code at the top of
`nuvizz-refresh-stops-background.mts`.

## 6. Acceptance test

**Prereq:** `FIREBASE_SA` must be set in the **dd-dispatch-map** Netlify site
env (separate from the parent site). Without it the writer/reader degrade safely
(reader serves the fixture; writer no-ops with a logged error).

1. Trigger the writer on the deploy preview (background fns accept HTTP and run
   async):
   ```
   curl -X POST "https://<preview>--dd-dispatch-map.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?date=2026-05-26"
   ```
2. Wait ~30s, then read:
   ```
   curl "https://<preview>--dd-dispatch-map.netlify.app/.netlify/functions/nuvizz-pull-today-stops?date=2026-05-26"
   ```
3. **Expected:** `source:"firestore"`, `count` ≈ 220 (≈103 planned + ≈119
   unplanned), `unplannedCount` ≈ 119, every unplanned stop has `isPlanned:false`,
   and `lastScannedAt` is set. The map shows "Stops as of HH:MM".

**Local validation done (mocked NuVizz + Firestore against the real bundled
libs):** `scanDate` splits planned/unplanned correctly with right `isPlanned`
flags; `writeStops` encodes, prunes, and writes meta; `readStops` round-trips
nested fields (raw / signalSources / arrays) and strips internal fields.
Live + cron validation is pending the `FIREBASE_SA` provisioning above.
