# Orchestrator Brief — Reduce NuVizz Scan Volume / New Schedule

**Purpose:** Hand this to a new orchestrator chat session to design a new scan
schedule for the Dispatch Map's NuVizz polling — cutting call volume materially
below today's ~4,000 calls/hour (~100k/day) while keeping the board usefully
fresh. **Output a concrete schedule/parameter spec to hand back for
implementation. Do NOT implement in that chat — decide the numbers.**

## Repo / paths
- Repo: `DavisDelivery/davis-nuvizz` · App subdir: `/dispatch-map`
- Prod site: `dd-dispatch-map` (Netlify). Scheduled functions run only on the
  **published prod deploy** (not deploy previews).

## How scanning works today (read these files)

- **`netlify/functions/nuvizz-refresh-stops-background.mts`**
  Scheduled BACKGROUND writer. **CRON: `*/15 * * * *`** (every 15 min, 24/7).
  Delegates to `runRefreshStops`.

- **`netlify/functions/lib/refresh-stops-core.mts`** (`runRefreshStops`)
  Per run it scans **`DEFAULT_DAYS = 2`** dates: TODAY + the next BUSINESS day
  (`scanDatesFrom` / `nextBusinessDayUTC`). Guards, in order:
  1. `NUVIZZ_SCANS_ENABLED=false` → skip entirely (kill switch).
  2. `breakerTripped()` → skip (daily ceiling hit).
  3. Per-date **min-interval floor** → skip a date scanned within
     `MIN_SCAN_INTERVAL_MS` (default 10 min) unless a manual `?date`/`?days` run.

  Then per date: `scanDate()` → `writeStops()` (Firestore index) + `writeFleetIndex()`.

- **`netlify/functions/lib/nuvizz-scan.mts`** (the actual NuVizz calls)
  `scanDate(date)` = TWO scans in parallel:
  - **A) `scanLoadRangeForDate`** — planned/routed stops. Probes `/load/info`
    across a load-number window. Window = `estimateLoadRange()`: center ±
    `LOAD_WINDOW_HALF` (=300 → ~601 numbers) on first run; `calibrateLoadRange()`
    then TIGHTENS it to `[minSeen-20, maxSeen+100]` (~120–220 numbers), cached
    10 min. Davis runs ~100 loads/biz day (`LOADS_PER_BIZ_DAY`). concurrency 30.
  - **B) `scanUnplannedStops`** — status-10 orders NOT on any load. Descends the
    `/stop/info` number space from a calibrated ceiling down to
    `(frontier - FLOOR_MARGIN=2500)`, capped `maxProbes=2500`, concurrency 40,
    with early-stop heuristics (usually stops well before the cap). **This is the
    single biggest call driver and the hardest to bound.**
  - Plus `findCeiling()` probing (gallop + binary search): a few dozen `/stop/info`.

- **`netlify/functions/lib/nuvizz-request.mts`** (accounting + safety)
  Every NuVizz call is counted into a SHARED daily Firestore counter.
  **HARD DAILY CEILING = `NUVIZZ_DAILY_CEILING`** (env; currently **250000**, code
  default 100000). Crossing it auto-TRIPS a circuit breaker → all scans skip
  until reset. Also de-dupes in-flight calls + backoff-retries.
  `MIN_SCAN_INTERVAL_MS = NUVIZZ_MIN_SCAN_INTERVAL_MS` (default 10 min).

- **`netlify/functions/nuvizz-history-snapshot-background.mts`**
  SEPARATE nightly job. **CRON: `0 6 * * *`** (once/day). One `scanDate()` of
  ET-yesterday for the immutable history warehouse. Low volume but it IS a NuVizz
  scan — include in the budget.

- **`netlify/functions/nuvizz-pull-today-stops.mts`**
  The FRONT-END read. Reads the Firestore index ONLY — makes **ZERO NuVizz
  calls.** The app auto-refreshes from this every 2 min (silent). So front-end
  freshness is decoupled from scan cadence EXCEPT that the index only changes as
  often as the scan writes it.

## Current volume math (approx)
- Cadence: 4 runs/hour (`*/15`), each scanning 2 dates.
- Per date (steady-state, calibrated): ~150–220 `/load/info` + a variable
  `/stop/info` unplanned descent (hundreds, capped 2500) + ceiling probes.
- Observed ≈ ~1,000 calls/run → **~4,000/hour → ~96k/day** ≈ the ~100k Uline is
  flagging. Ceiling (250k) means the breaker rarely fires; volume is steady.

## Env knobs (tunable with NO code change)
- `NUVIZZ_SCANS_ENABLED` (`true | false` — master kill switch)
- `NUVIZZ_DAILY_CEILING` (currently 250000; breaker trips at this)
- `NUVIZZ_MIN_SCAN_INTERVAL_MS` (default 600000 = 10 min; per-date floor)

## Levers to decide (with trade-offs) — pick a combination + target numbers
1. **Cron interval** `*/15` → `*/20` or `*/30`. 30 min ≈ halves volume. Cost:
   index up to 30 min stale (front-end still repaints every 2 min, older data).
2. **`MIN_SCAN_INTERVAL_MS` up** (e.g. 20–30 min) while leaving cron granularity.
   Decouples "how fresh" from cron; cheapest dial, **env-only, no deploy**.
3. **Scan fewer dates:** today every tick, tomorrow only every Nth tick / once an
   hour (tomorrow changes slowly). `DEFAULT_DAYS=2` exists so tomorrow isn't
   empty — don't drop to 1 outright; throttle the 2nd date instead.
4. **Business-hours window:** scan often during dispatch hours (~6a–8p ET), rarely
   overnight. Reclaims 8–10 idle hours/day. (Old code had ET windows; now 24/7.)
5. **Unplanned-scan throttle:** it's the biggest cost. Scan planned loads every
   tick but the unplanned number-space far less often (e.g. every 30–60 min)
   and/or lower `maxProbes` / tighten `FLOOR_MARGIN`. New unplanned orders are the
   main reason to scan often — confirm how fast those must appear.
6. **Lower `NUVIZZ_DAILY_CEILING`** as a hard backstop (not a smooth reducer — it
   just freezes the board when hit).

## Constraints to preserve
- Unplanned (status-10) orders only appear via the number-space scan — don't
  starve it so much that new Uline orders take too long to show.
- Tomorrow's board shouldn't be empty (why `DEFAULT_DAYS=2`).
- Weekend / Friday→Monday business-day stepping must hold (Sat/Sun UTC edge).
- The nightly history snapshot (`0 6 * * *`) must keep running for the warehouse.

## Decisions needed from Chad
- Target ceiling: acceptable calls/day (and Uline's stated limit)?
- Max acceptable staleness for: (a) planned loads, (b) NEW unplanned orders,
  (c) tomorrow's board?
- OK to reduce/stop overnight scanning? Which dispatch hours (ET) to protect?
- Should the unplanned scan run on a slower cadence than the load scan?

## Deliverable back to implementation
A concrete spec, e.g.: *"cron `*/20` during 10:00–01:00 UTC only; today every run,
tomorrow every 3rd run; unplanned descent every 40 min, `maxProbes` 1500;
`MIN_SCAN_INTERVAL_MS` 20 min; ceiling 60k."* With those numbers, implementation
will wire the crons + env + `refresh-stops-core` changes and report the projected
new calls/day.
