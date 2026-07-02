# Dispatch Map — Handoff

## ⏰ OPEN REMINDER (set 2026-06-18 eve) — surface this at the next session
- **Evaluate the unplanned "periodic deep sweep" (Phase 7 candidate) call cost.** Chad
  chose to MEASURE FIRST (not implement yet). Tomorrow during work: (1) read the CLEAN
  daily NuVizz counter (`nuvizz_ops/calls__<date>`, byRoute) now that Phase 6
  terminal-skip (`NUVIZZ_TERMINAL_SKIP=on`, set on dd-dispatch-map) has run a full day —
  compare /stop/info vs 6/18's 18,142 and total vs 24,446; (2) estimate how many EXTRA
  calls a periodic full-band descent would add (mostly offset by Phase 6 caching the
  delivered stops), then decide deep-sweep vs widen-buffer.
- **Why the sweep is needed:** stop numbers track CREATION order, not delivery date, so an
  order created early for a later delivery (e.g. PRO 7135100 — created 6/17 for 6/18) gets
  a LOW number below its delivery-date cluster. The descent's early-stop
  (POST_TARGET_CHUNKS_TO_STOP=3) quits before reaching such outliers, and the lean warm
  floor (highWaterUnplanned − 200) never revisits them → silently missed. The deep sweep
  must descend the full multi-day creation window WITHOUT early-stopping to catch them.

## Incremental-scan call reduction (Jul 2025) — Phase 1 SHADOW (v0.27.14)
Goal: cut NuVizz calls/scan (~690 measured: 510 /load/info + 180 /stop/info) by
probing only known-active loads + a small buffer instead of a ±300 window.
- **Phase 1 (this PR, shadow only — NO behavior change):** after every load scan,
  `refresh-stops-core` writes `scan_state/{date}` (roster: `knownLoads[{loadNbr,
  routeName,allTerminal,lastSeenAt}]`, `min/maxLoadNbr`, `highWaterStopNbr`,
  `routeMap`, `scanCount`) and logs `[scan-shadow] … WOULD_PROBE_LOADS=<active+buffer>
  CURRENT_WINDOW=<~600>`. A load is `allTerminal` only when EVERY stop is DELIVERED
  (status 90/91 — exceptions keep it active). Pure helpers `buildScanState` /
  `shadowWouldProbe` in `nuvizz-scan.mts` (unit-tested, `test/scan-state.test.mjs`).
  Routing window (thorough vs lean) = `isInRoutingWindow` in `scan-schedule.mts`.
  **Window is OVERNIGHT 20:00–07:00 ET (wraps midnight)** — that's when Davis builds/
  edits routes (volatile → thorough discovery, forward buffer +50, frequent gap sweep).
  Daytime 07:00–20:00 = stable (trucks delivering, loads only going terminal) → lean
  (re-pull non-terminal only, buffer +10, gap sweep low/off). Env `NUVIZZ_ROUTING_WINDOW_*_ET`.
  **Phase 2 cold-start/growth:** overnight the roster legitimately grows from ~0 (≈8 PM)
  toward ~55 by ~7 AM — do NOT force-probe up to the prior-day count before those loads
  exist (wastes calls on empties). Seed the start near prior-day `maxLoadNbr+1` (numbers
  regenerate ~+100/day in order); let forward-buffer + gap-sweep accrue loads cycle by
  cycle; use prior-day count only as a soft "discovery likely complete" signal near 6–7 AM.
  Full ±window probe stays the fallback ONLY when there is no prior scan_state at all.
- Builds on #108 counter/breaker (count__load_info / count__stop_info measure the cut).
- Phases 2–5 (act on scan_state + terminal-skip, unplanned high-water, history
  Firestore snapshot, 7-day straggler watch + undelivered report) follow once the
  shadow log confirms the roster matches reality. Cold-start wide-window probe stays
  as the fallback; four-layer data preservation intact (freeze = stop querying, keep data).
- **Phase 2 (v0.27.16) — act on scan_state, behind `NUVIZZ_LEAN_DISCOVERY=on` (default OFF):**
  `selectLoadProbeTargets` (pure, in `nuvizz-scan.mts`) builds the load NUMBERS to probe:
  WARM = non-terminal known loads (terminal-skip) + forward buffer (+50 overnight / +10 day)
  above maxLoadNbr + a gap re-sweep across [min,max] every 3rd cycle in-window only;
  COLD-START with a prior day = forward span from prior `maxLoadNbr+1` (~+100/day regen);
  no state at all ⇒ null ⇒ scanDate falls back to the wide ±window. `scanDate({loadTargets})`
  probes the explicit set via `scanLoadNumbers`; absent ⇒ unchanged window scan. Default OFF
  so merging changes nothing; flip ON only AFTER a deploy-preview confirms the written
  stop-set matches the wide-window scan for the same day (brief's parity gate). Unit-tested.
  **Data-loss guard (v0.27.17):** lean re-pulls only a SUBSET of loads (terminal skipped),
  so `writeStops({partialLoads:true})` PRESERVES planned stops it didn't re-scan instead of
  pruning them (`preserveStopOnWrite`, unit-tested) — terminal-skip can never delete already-
  delivered stops. This is what makes the lean stop-set equal the wide-scan stop-set.
- **Phase 3 (v0.27.19) — incremental unplanned descent, behind the same flag:** on a WARM
  cycle (roster + `highWaterStopNbr` present) the order descent only probes NEW stop numbers
  above the UNPLANNED-only high-water (`highWaterUnplannedStopNbr`, +200 buffer) via `unplannedFloor()`
  (pure, unit-tested) instead of the full `FLOOR_MARGIN` range — new orders are the newest/highest
  numbers. (v0.27.20 audit fix: bound on the unplanned-only frontier, NOT the global high-water, so
  a high PLANNED stop number can't ratchet the floor past genuine new orders.) `writeStops({partialUnplanned})`
  + `preserveStopOnWrite` preserve older still-unplanned orders not re-probed (mirrors partialLoads).
  COLD cycles still do the full descent (establishes the high-water). Default OFF.
- **Phase 4 (v0.27.21) — history snapshot from Firestore, behind the flag:** `captureDate`
  (history-core.mts) builds the just-closed day's immutable snapshot from `readStops` (the
  accumulated index, final ~02:00) instead of a fresh `scanDate()` — the daily 6 AM history
  job drops from ~690 NuVizz calls to ~0. Snapshot is "as of last scan"; late (post-snapshot)
  deliveries are reconciled by Phase 5's 7-day straggler watch. Flag OFF → unchanged (fresh scan).
  (Phase 4b TODO: targeted /stop/info re-probe of the handful of non-terminal stragglers at
  capture time, for same-day final status — deferred; the straggler watch covers it cross-day.)
- **Phase 5 (v0.27.23) — undelivered/late/aged report + 91-vs-90, IMPLEMENTED:** pure
  derivation over the multi-day history warehouse (`lib/straggler-report.mts`,
  unit-tested) — ZERO NuVizz calls. Read-only endpoint `nuvizz-undelivered-report?days=N`
  returns: deliveredLate (PRO terminal on a LATER day than scheduled — the rolled-PRO
  case), open (non-terminal within the window), agedOut (non-terminal ≥ window), and the
  91(manual portal)-vs-90(system) completion summary overall + per route with a 91-rate.
  Derived because a missed stop rolls to a later day's board under the same PRO (NuVizz
  ground truth) and every day is snapshotted — so no stateful /stop/info watchlist is
  needed. FOLLOW-UP: a sortable UI surface consuming the endpoint (data layer is complete).
- **Phase 5 report — manually-completed (91) dimension (amendment):** terminal-skip is
  unchanged (freeze on {90,91}; a 91 can't revert — a redo returns as a new PRO "-1",
  discovered normally — so NO re-verify, max savings). The undelivered/aged-out report
  ALSO flags stops whose terminal status is **91 (dispatch-portal manual completion)**
  distinctly from **90 (system/scan completion)** — a derived view off the already-stored
  status, ZERO extra NuVizz calls, no new ingest. Surface: per-day 91-vs-90 count +
  breakdown by route/driver with each route's 91-rate (% of its completions); sortable;
  dates "Mon D, YYYY". The 91 flag rides into the daily history snapshot so the report
  works for past days too.

Status of the build that landed on branch `claude/dispatch-map-build-eEbYe`.
M3 + M5 still pending. v0.4.0 = M4.1 (resizable panel, search, driver
labels, day-snapshot). v0.5.0 = Part 9 restriction iconography (badge
overlays). v0.5.1 = M4.1.6 pin-replacement (restriction icons become the
marker itself when restricted). v0.6.0 = M4.2 (PRO pipeline fix, route
matching fix, column toggle). v0.7.0 = M4.4 (filter toolbar, hours/closed-day
scanner, time iconography). v0.7.1 = M4.5 PR 1 of 3 (mobile foundation).
v0.7.2 = M4.5 PR 2 of 3 (stop-detail + driver-snapshot drawers).
v0.8.0 = M4.5 PR 3 of 3 (final polish: marker labels, snapshot tap-through,
mobile diagnostics, RESEARCH doc).

## v0.23.1 — Phase 3 growth-guard fix (#52 retro / PR #58)

Retro-review of #52 found one blocker in `assign()`. The Phase 3 region-growth
loop capped iterations with `guard++ <= remaining.length + 5`, **re-reading the
shrinking `remaining.length` every pass**. Since each pass splices one stop out,
the budget halved as `guard` climbed: once the growth phase held ≳8 stops the
loop bailed early and routable stops fell through to the post-loop spill —
**phantom-spilling with empty reasons**. End-to-end the stops weren't dropped
(repair Phase B recovers them) but recovery is first-truck-with-room
(geography-blind), reintroducing skewed loads and the exact two-truck
criss-cross Chunk B exists to prevent.

### Fix (`routing-solver.mts` `assign()` only)
Hoist the cap to a constant before the loop so the budget stays fixed:
`const maxIters = remaining.length + 5;` then `while (remaining.length &&
guard++ < maxIters)`. No other logic touched — anchor/seed/grow,
`truckCanCarry`/`capacityFits` gates, spill reasons, sequencing, repair,
pipeline, constraints, matrix, and cost are all unchanged.

### Tests + CI
- New regression: a dense 14-co-located-stop cluster on two trucks asserts
  **0 raw spill** from `assign()` and all stops served (the 4 existing Chunk B
  tests passed only because they used ≤7 growth-phase stops).
- Added a `node --test` GitHub Actions job — the suite previously had **no CI
  signal** beyond Netlify deploy checks, so a solver regression could merge
  unseen. Full suite: 101/101.

## v0.23.0 — Routing quality (Chunk B): geographic truck assignment + green markers

Chunk A fixed *within-truck* sequencing; the remaining defect was *cross-truck
assignment* geography — `assign()` was capacity-only, so two trucks criss-crossed the
same cluster. Solver-assignment-only change (+ marker styling + a version list).

### Fix 1 — geographic assignment (`routing-solver.mts` `assign()` only)
Replaced the capacity-tightest-fit selection with a **deterministic, pure,
geography-aware capacitated assignment**:
1. **Anchor** oversize/equipment-restricted stops first onto a capable truck
   (`truckCanCarry`/`capacityFits` remain the **only** gates; spill reasons unchanged).
2. **Seed** each still-empty truck via **farthest-point sampling** (so separated
   clusters land on different trucks).
3. **Grow** territories by **global nearest-pair** — repeatedly assign the unassigned
   stop nearest to any truck's territory that still **fits** (skids binding).
Proximity is a **pure haversine on lat/lng** (added `haversineM`), independent of the
matrix mode. Capacity bounds territory; no load-balancing objective.
`sequence()`/`nearestNeighbor`/`twoOpt`, `routing-repair`, `routing-pipeline`,
`routing-constraints`, matrix, and cost are **untouched**.
- **Repair re-assignment check:** Phase A spills only capacity/equipment/(strict-window)
  violators; Phase B only re-inserts **spilled** stops. A valid geographic assignment is
  never reshuffled across trucks → geography is preserved. (Not changed.)

### Fix 2 — green stop markers (`src/App.jsx`)
Routed stop markers are now **green and slightly larger** (scale 12→14), keep the
**sequence-number label**, and a **restricted** stop (equipment restriction / oversize)
keeps its signal via a **red ring**. **ASSUMPTION (confirm on preview):** markers are
**uniformly green** and per-truck distinction is the **route LINE color** (lines stay
red/purple). If you'd rather keep per-truck **dot** color, it's a one-line change
(`fillColor: numbered ? routed : …`). Selection-phase dots (pre-build) are unchanged.

### Added (per Chad) — beta version list
The **build badge is now tappable** → opens a **"Beta version history"** popup
(`VERSION_LOG`, newest first, current highlighted), so it's easy to track what changed.

### Tests / evidence (100 green; +4)
- **Two separated clusters** → each truck gets exactly one cluster, **no criss-cross**.
- **Equipment overrides geography** → a straight-truck-only stop in the trailer's
  cluster rides the **box**.
- **Only the tractor selected** → a straight-truck-only stop **spills** with
  `noTruckFits` + `needsStraightTruck`; the rest route.
- **Cluster exceeds one truck** → 6 stops / two maxSkids-3 trucks → **3+3, 0 unassigned**.
- **Couldn't verify** (no live NuVizz/map): how it looks on the real map (green dot
  legibility, real-data criss-cross), real `customer_notes` restriction coverage.
- **On-preview:** rebuild the ~22-stop/2-truck MIN_DISTANCE set → box & tractor each
  cover a coherent area (no Dalton criss-cross); a straight/box-only stop rides the box;
  deselect the box → that stop shows in risk flags as "needs straight/box truck"; markers
  green + numbered + red ring on restricted; badge reads `v0.23.0 · preview`.

Files: `netlify/functions/lib/routing-solver.mts`; `src/App.jsx`;
`test/routing-solver.test.mjs`. APP_VERSION 0.22.0 → 0.23.0. Out of scope: loose-pieces,
inches→feet floor length, dunnage, NuVizz write-back, Beta 2 app.

## v0.22.0 — Routing quality (Chunk A, keystone): un-clobber the optimizer

A ~22-stop MIN_DISTANCE / CLOSEST_FIRST build was ignoring the chosen strategy and
shipping roughly the raw input order (zig-zag routes). Three exact points fixed; the
solver/matrix/cost/skid-gate/deck math is untouched.

### Fix 1 — real-window detection (`routing-pipeline.mts`)
NuVizz placeholder schedules (`00:00`/`00:00` + a strict flag) were turning nearly
every stop into STRICT-with-window, which made `routing-repair.orderForTruck` take
the EDF (`windowAwareOrder`) branch and **discard `sequence(strategy)`** on every
build. New `realWindowSec()` accepts a window only if **both ends present, neither a
midnight/zero placeholder, both parse, and end > start**; `timeConstraint` is STRICT
**only** when a real window exists AND NuVizz flags strict (else `null`/SOFT).
`hhmmToEpochSec` hardened to parse `H:MM` / `HH:MM` / `HH:MM:SS`. **Net:** a normal
build is `hasStrict=false`, so `orderForTruck` re-runs `sequence(strategy)` — the
optimizer's order ships. `orderForTruck`/`windowAwareOrder` logic itself is unchanged.
*(Could not reach live NuVizz to confirm the 00:00 placeholders — proceeded on the
placeholder/zero-length guard, flagged. Genuine windows like 08:00–08:05 stay strict.)*

### Fix 2 — re-sequence dropdown works on a fresh build (`src/App.jsx onResequence`)
It no-op'd when `routeState` had no entry for the truck. It now **seeds from the
engine route's `orderedStopIds`** (current rendered order) when `routeState` lacks
the truck, then applies `resequence` — so "Closest first" / "Min distance" / etc.
reorder a freshly built route. Unresolvable ids are preserved at the tail (no silent
drops). Depot = `meta.depot` (Buford).

### Fix 3 — risk flags collapsed (Result panel)
The risk-flag wall is now a **collapsed disclosure**: a single "⚠ N risk flags" row
that expands on tap and collapses again; never auto-expands (resets per build).
Touch-safe, desktop + mobile.

### Tests / evidence
- Real-window detection + the key **ordering** test: a placeholder-window build's
  route **equals `sequence(nodes,'MIN_DISTANCE',matrix)`** and **≠ raw input order**;
  CLOSEST_FIRST equals the depot-distance sort; placeholder windows never flag/spill;
  a genuine wide window stays served + unflagged. Existing strict/advisory window
  tests (real 08:00–08:05 windows) stay green. **96 tests green.**
- Before → after for the skew fixture (depot at origin; stops A=lng3, B=lng1, C=lng2):
  before (clobbered) `A,B,C`; after (MIN_DISTANCE / CLOSEST_FIRST) `B,C,A`.

Files: `routing-pipeline.mts`, `src/App.jsx`; `test/routing-pipeline.test.mjs`.
APP_VERSION 0.21.0 → 0.22.0. Out of scope: geographic truck assignment (Chunk B).

## v0.21.0 — Appointment windows become advisory (flag, don't spill)

A ~21-stop build routed only 8; 13 spilled "appointment window cannot be met" with
skid headroom to spare. Root cause: the repair loop **dropped** any stop whose
STRICT window it couldn't satisfy (`REASON.windowUnsatisfiable`) — a hard gate, the
same class of problem deck length was in before #47. Windows now **flag, not spill**.

### Engine
- New **window-enforcement mode**, default **`advisory`**. In advisory the repair
  loop never spills a stop for a window: it **keeps** it on the assigned truck and
  records it in **`BuiltRoute.windowViolatedIds`**. EDF (`windowAwareOrder`)
  sequencing still tries to honor windows as a soft preference; `canInsert` ignores
  windows for validity (capacity + equipment only). `worstViolator` only spills on
  windows when enforcing.
- **`strict`** (the old behavior — drop on unsatisfiable window) is an **opt-in kill
  switch**: `request.windowMode === 'strict'` or env **`ROUTING_WINDOWS=strict`**
  (handled in `routing-build-background`). Default is advisory.
- `windowViolatedIds` flows `routing-types` → `routing-repair` → `routing-pipeline`
  → route result. The appointment window + STRICT designation are **preserved** on
  the stop (`SolverStop.timeWindow` / `timeConstraint`) for a future window-respecting
  solver. The pipeline's risk flags now name the stops **actually out of window**
  (with the window), not every STRICT stop.

### UI (`src/App.jsx`)
- Route-card rows and the PRO detail popup show **"⚠ outside appointment window"**
  (with the window, e.g. `8:00a–8:05a`) when the stop is in `windowViolatedIds`; the
  detail also shows the appointment window + `(strict)`. Existing "Manual order /
  straight-line estimate" labeling unchanged.

### Guardrails
- Skids remain the only hard capacity gate; weight gates only when `maxWeightLbs>0`;
  **deck stays advisory (#47 `capacityFits` gates untouched)**; equipment / matrix /
  cost / cache / Phase 1 / solver seeding / NuVizz write all untouched.

### Tests / files
- `routing-types.mts` (`WindowMode`, `SolverInput.windowMode`, `BuiltRoute.windowViolatedIds`),
  `routing-repair.mts` (mode gating + `windowViolatedIds`), `routing-pipeline.mts`
  (thread mode + window-specific risk flags), `routing-build-background.mts` (default
  advisory + env kill switch), `src/App.jsx` (row + popup flags, `apptWindowLabel`).
  `test/routing-repair.test.mjs` + `test/routing-pipeline.test.mjs` cover both modes
  (the prior strict-assuming tests now opt into `windowMode:'strict'`). **92 tests green.**
- APP_VERSION 0.20.0 → 0.21.0. (Built on the v0.20.0 version-badge branch — stacked on #49.)

## v0.20.0 — Persistent build badge on the Routing screen

The `APP_VERSION` chip only rendered on the main **Map** view (above the FAB) and
the desktop footer — neither reaches `RoutingScreen`, so the Routing tabs
(Stops/Loads/Result) showed no version. This adds a small persistent badge so the
dispatcher always knows which build they're on.

- **Where:** the map's **top-right corner** of the routing surface (the map is
  always shown, so it's visible on every routing tab at both widths). `~10px`, muted
  slate text, translucent white background, `pointer-events-none` so it never blocks
  map drag/selection; doesn't overlap the tabs, the selection chip (top-left), the
  viewing banner (top-center), map controls, or the Save/Discard row.
- **Shows:** `v0.20.0 · <7-char commit> · <prod|preview>` so prod vs preview is
  unambiguous. Full build time on hover (`title`).
- **Build constants:** `vite.config.js` now also defines `__BUILD_CONTEXT__` from
  Netlify `CONTEXT` (`production`→`prod`, `deploy-preview`→`preview`,
  `branch-deploy`→`branch`, absent→`dev`), alongside the existing `__BUILD_COMMIT__`
  / `__BUILD_TIME__`. App reads `BUILD_CONTEXT` + `BUILD_SHORT` (7-char commit, or
  `local` when the vite fallback `dev` is in effect).
- **Local dev** (no Netlify env) degrades to `v0.20.0 · local · dev` — never blank
  or `undefined`. Verified the env→define→badge path by building with `COMMIT_REF` +
  `CONTEXT` (preview → `a1b2c3d · preview`, production → `deadbee · prod`).
- The existing map-view chip + desktop footer are **unchanged** (this only adds the
  routing-screen badge). No engine/functions/cache/Phase 1 touched.
- **Divergence note:** `netlify/functions/lib/history-core.mts` keeps its own capture
  `APP_VERSION` const (unchanged); it is intentionally separate from the UI
  `APP_VERSION` in `src/App.jsx`.

Files: `vite.config.js` (+`__BUILD_CONTEXT__`), `src/App.jsx` (`BUILD_CONTEXT` /
`BUILD_SHORT` consts + inline `RoutingBuildBadge`, rendered in both routing map
containers). **89 tests green.** APP_VERSION 0.19.0 → 0.20.0.

## v0.19.0 — Routing UX: drag-lasso · PRO detail popups · per-load re-sequence

Three dispatcher-requested interaction upgrades. Client-side selection + display +
client-side re-sequencing only; engine/matrix/cost/cache/Phase 1/equipment/skid-gate
untouched; NuVizz read-only; feature-flagged.

### True drag-lasso (desktop) + tap-vertices fallback (touch)
- **Desktop:** in Lasso mode, hold and draw a freehand shape; release selects every
  stop inside it (`pointInPolygon`). Drawn on a **pointer-captured SVG overlay** (the
  same approach as the box-drag overlay) — **NOT** the Google DrawingManager (removed
  in #41 and staying gone). While lasso is armed the overlay intercepts events so the
  **map can't pan**; when lasso is off, pan/zoom is normal (no regression). Stays armed
  for repeat draws; Cancel/Esc exits.
- **Touch:** the existing **tap-vertices + Done** lasso is kept (freehand drag fights
  map-pan on touch). Both paths select through the same `pointInPolygon`.

### PRO/order number → full-detail popup
- Every PRO/order number is a clickable `ProLink` — in the selected-stops list, the
  desktop stops table, route-card rows, the **spill ("could not place") rows** (PRO
  added there), and the stop detail. Clicking opens `RoutingStopModal` (reuses
  `RoutingStopDetail`): business, address, order/PRO + load #, appointment/hours,
  weight, skids, loose pieces, line items, restriction badges. Closes via **X /
  backdrop / Esc**; guards a null stop (never empty). Works desktop + mobile.
  (BOL isn't in the normalized NuVizz stop today — shown only if a `bol` field is
  present; otherwise order/PRO + load # stand in.)

### Per-load re-sequence dropdown
- Each route card has a **Re-sequence…** dropdown: **Min distance · Closest first ·
  Farthest first · Reverse**, computed **client-side** (new pure helpers in
  `routing-select.js`: `depotSort`, `nearestNeighbor`, `twoOpt`, `resequence` — depot
  haversine, nearest-neighbour + bounded 2-opt, reverse). Applying writes the new order
  into the **same `routeState` as manual drag**, so markers/polyline/ETAs update live
  and it carries the **"Manual order / straight-line estimate"** labeling. Load/skids
  are order-independent (unchanged); manual drag/▲▼ still fine-tunes afterward. Hidden
  when viewing a saved load (read-only).

### Discard / cancel a built plan
- A **"Discard plan"** button sits **beside Save load** in the Result panel, shown
  whenever a finished plan is present and you're **not** viewing a saved load. It
  clears the build output — `job`, `routeState` (incl. any manual reorder / P3
  re-sequence), `saveState` — so the Result returns to its empty "Build a plan…"
  state and the map drops the route markers/polylines (back to the selected stops).
  **Selection + trucks are kept** (discards the output, not the input); on mobile it
  bounces to the Setup tab. Purely **local — no Firestore write; saved Loads
  untouched.** A plain build discards in one tap; a **hand-edited** plan (reorder or
  re-sequence) shows a one-tap confirm. Styled as a secondary/destructive action,
  distinct from Save.

### Files
- `src/lib/routing-select.js` — `depotSort`/`nearestNeighbor`/`twoOpt`/`resequence`
  (+ existing `pointInPolygon`/`recomputeRoute`). `test/routing-select.test.mjs` — 4
  new re-sequence tests. **89 tests green.**
- `src/App.jsx` — desktop drag-lasso overlay + handlers; `ProLink` + `RoutingStopModal`
  + PRO links wired through list/table/route/spill/detail; per-load `onResequence`.
  Single-file kept. APP_VERSION 0.18.0 → 0.19.0.

## v0.18.0 — Shared loads: real-time persistence + live Loads view

#44 persisted one dispatcher's plan; this makes saved loads **shared and live** — a
load saved on any device shows up for everyone within seconds and can be opened on
the map. Firestore read/write on the existing `routing_routes` collection + UI;
engine/matrix/cost/cache/Phase 1/NuVizz untouched; feature-flagged. No auth built.

### Live, shared list
- `useSavedLoads()` subscribes via `onSnapshot(query(routing_routes, orderBy('created_at','desc')))`
  with clean teardown; explicit loading / empty / error (never a silent catch).
- A **Loads** tab (desktop right rail + mobile sheet) lists every load: name, status
  chip (Saved/Dispatched), Manual-order chip, `N trucks · M stops`, created time
  (`Jun 5, 2026 2:14p`), saved-by, and app_version. Sortable (name/status/stops/created).

### Save with a name
- The Save panel takes a **name** (prefilled with `buildLoadAutoName` →
  "Jun 5, 2026 2:14p · 3 trucks · 28 stops"; no native prompt) + optional **saved-by**
  initials. Writes `name`, `updated_at`, `created_by` (unchanged), and a self-contained
  **`stops_snapshot`** ({name,lat,lng,pallets,cartons,weight} per stop) so the load
  renders on the map on any day. **Verified by readback** (re-`getDoc`, check `name`).

### Open a load → view on map + panel (read-only)
- Selecting a load sets `viewedLoad`; `baseResult`/`vStopById`/`vPositioned` switch what's
  RENDERED (reusing #44's `routesView`/`routeInfo` — numbered markers + per-route
  polylines, map auto-fit to the load). The live build state (selectedIds/routeState/
  job/selectedDate) is **never touched**, so "Back to build" returns to it intact.
- An indigo **"Viewing saved load"** banner (map + panel) makes saved-vs-build
  unmistakable; reorder affordances are hidden (view-only). Honesty labels (Manual
  order / straight-line estimate) carry through from the saved doc.

### Manage
- **Rename** (inline, no prompt), **Delete** (explicit confirm), **toggle Dispatched** —
  each `updateDoc`/`deleteDoc` **verified by readback**; the live snapshot reflects every
  change everywhere. The open viewed-load tracks edits via `updated_at` and closes if
  deleted elsewhere.

### Files
- `src/lib/routing-loads.js` *(new)* — `formatDateTime`, `tsToMillis`, `loadSummary`,
  `buildLoadAutoName` (+ counts). `test/routing-loads.test.mjs` *(new)*. **78 tests green.**
- `src/App.jsx` — `useSavedLoads`; view state + effective stop maps; save-with-name +
  snapshot + readback; manage handlers; `RoutingLoadsPanel` / `LoadRow` /
  `SavedLoadManageBar`; route card `readOnly`. Single-file kept. APP_VERSION 0.17.0 → 0.18.0.

## v0.17.1 — Hotfix: route by skid count; deck/floor length no longer blocks

A real build (v0.17.0) spilled **all 25 selected stops** with "over deck length"
and routed **0 trucks**. Surgical fix to the capacity gate only
(`netlify/functions/lib/routing-constraints.mts#capacityFits`); the solver,
sequencing, matrix, cost, equipment logic, cache, and Phase 1 are untouched.

### Root cause (diagnosed via the real `deriveGeometryDeterministic`)
The selected trucks have **real** deck caps (26ft box `deckLengthIn` 312in, 53ft
trailer 636in — not 0/unset). The spill came from **inflated per-stop
`linearFeetIn`**: the oversize estimator counts **every oversize piece as a full
~pallet-length (~96in) × quantity**, so:

```
box_26 deck=312in · tractor_53 deck=636in   (maxSkids 14 / 28)
plain 2-skid stop            → linearFeetIn 48     (fits)
flooring, 30 ctn (cat L)     → linearFeetIn 2976   (OVER both)  ← 96 + 30×96
cabinetry, 12 ea (cat L)     → linearFeetIn 1200   (OVER both)
trim, 8 ea @144in (cat L)    → linearFeetIn 1200   (OVER both)
```

With deck as a hard gate, every flooring/LVT/cabinetry stop exceeded the deck on
its own → `truckCanCarry` failed for all trucks → 0 routed. **Units:** both
`deckLengthIn` and `linearFeetIn` are **inches**; the caps are right, the per-stop
estimate is the wrong magnitude.

### The fix
- **Skid count is the binding gate** (always, when `maxSkids > 0`).
- **Deck/floor length no longer blocks** — behind `CAPACITY_GATES = { skids:true,
  weightLbs:true, deckLengthIn:false }`. It's still computed and still shown on the
  CapacityBar as **info** (the bar may read over 100% until the feet rework, since
  the underlying estimate is inflated — that's informational, not a spill).
- **Weight** blocks only when `maxWeightLbs > 0`.
- **Hardening:** `capLimited(cap)` — any non-positive / null / undefined / NaN cap
  means **UNLIMITED** for that dimension. A missing/zero cap can never spill a stop
  again (this whole class of bug is gone).

### Deferred (explicitly): floor-length in FEET
Rename "deck length" → "floor length", convert inches → **feet**, and fix the
oversize linear estimate (cartons that stack/nest don't each consume a full pallet
length — only genuinely long, non-stackable items do). Re-enabling the gate is then
a one-line flip of `CAPACITY_GATES.deckLengthIn`. The diagnostic above feeds it.

Files: `routing-constraints.mts` (gate + `CAPACITY_GATES` + `capLimited`);
`test/routing-constraints.test.mjs` *(new)*. **81 tests green.** APP_VERSION 0.17.0 → 0.17.1.
## v0.17.0 — Manual route reorder: drag-and-drop, numbered stops, live map sync

The load/route panel is now a working surface — the manual override every
dispatcher reaches for. Client-side only (panel + map + recompute); the engine,
matrix/cost path, cache, and Phase 1 are untouched; still feature-flagged.

### Numbered stops (panel ↔ map locked together)
- Each route's stops are numbered **1..N** (per route) in the load panel, shown as a
  route-colored badge.
- The route's map markers display the **same** sequence number as a white label on
  the route-colored dot (markers grew to fit the number). Panel number and marker
  number for a stop always match, and both update live on reorder.

### Drag-and-drop reorder (desktop) + guaranteed fallback (touch)
- Drag a stop row up/down to reorder **within** its route (HTML5 drag; drop target is
  highlighted). On drop it renumbers 1..N immediately.
- **▲▼ move buttons** on every row are the always-works fallback (HTML5 drag doesn't
  fire on touch) — disabled at the ends, never a silent no-op.
- Cross-route moves are out of scope (future); reorder is within-route only.

### Live map sync + client-side recompute
- On every reorder the map updates **in place** (no reload): marker numbers update and
  the route **polyline redraws** depot→1→2→…→N. Driven by `routesView` (the current
  per-truck order is the source of truth).
- Legs / cumulative ETAs / route totals (miles, time) recompute instantly in the
  browser from the stops' lat/lng via **haversine** (`recomputeRoute`), mirroring the
  free build's 1.3× road factor + ~30 mph. **Load-vs-capacity is order-independent and
  unchanged.** No server round-trip.

### Road-number honesty
- A reordered route is badged **"Manual order"** and its drive times are labeled
  **straight-line estimates**; if the build had used Google road distances, the note
  adds that the original Google road times no longer apply to this order. Stale Google
  numbers are never presented as exact after a manual reorder. (A future per-route
  Compute Routes call can recompute real road legs — out of scope here.)

### Persist
- **Save** writes the current manual order to `routing_routes` (`editedResultForSave`
  applies the reordered `orderedStopIds`/`etas`/`legs`; `manual_reorder` flagged). Full
  shared/multi-user persistence is a later brief.

### Files
- `src/lib/routing-select.js` — new pure helpers `moveItem`, `recomputeRoute`,
  `haversineMeters` (+ road-factor/speed/service constants).
- `src/App.jsx` — `routeState` (per-truck order + reordered flag), `routesView` /
  `routeInfo` derivations, numbered markers + live polyline, reorderable
  `RoutingRouteCard`, Save captures the manual order. Single-file kept.
- `test/routing-select.test.mjs` — reorder/recompute tests. **74 tests green.**
- APP_VERSION 0.16.1 → **0.17.0**.

## v0.16.1 — Build reliability: killed the hang, made it fast (Phase 2 PR 5A)

A normal route build hung and was slow. Two concrete defects in the build path
(NOT the solver) were the cause; both fixed. Functions/engine-reliability only;
solver math, cheap-by-default cost/matrix behavior, NuVizz read-only, cache, and
Phase 1 untouched.

### Root causes → fixes
- **P0 dropped work (the hang).** `routing-build-background.mts` ran the
  resolve→build→solve→write sequence in an **un-awaited** `(async () => {…})()` IIFE
  and returned 202 immediately. In the background/serverless runtime, work after the
  handler returns isn't guaranteed to finish, so the instance could freeze/recycle
  before the result was written → job stuck at `status:'running'` forever, client
  polling indefinitely. **Fix:** the handler now `await`s the full sequence to
  completion (background functions are allowed the long duration). Every path ends
  at `done` or `error`.
- **P1 model in the hot path (slow / stallable).** The Opus deps were passed to the
  pipeline whenever `isAnthropicEnabled()`, regardless of free/haversine mode, and
  `callAnthropic` had no timeout — so a slow model call hung the build and many
  ambiguous stops meant many sequential calls. **Fix:** the model is **opt-in via
  `request.aiAssist`** (default **false**, exactly parallel to the Google matrix
  opt-in). Off → the pipeline gets `undefined` model deps and runs fully
  deterministically (**zero model calls** on a normal build).

### Belt-and-suspenders
- **P2 timeouts:** an 8s `AbortController` on **both** the Anthropic and Google
  fetches (new `lib/async-util.mts#fetchWithTimeout`). On stall → abort → deterministic
  fallback (haversine for the matrix; skip for the model). A stalled call can't hang
  the build.
- **P3 geometry cap:** even when AI is on, per-stop geometry assist is hard-capped
  (`GEO_ASSIST_CAP = 10`) — never an unbounded sequential loop. Default off → never runs.
- **P4 watchdog:** the whole pipeline runs under a 25s `withDeadline`; on overrun it
  writes `status:'error'` ("build timed out — try fewer stops") so the client stops
  polling. Belt-and-suspenders with the per-call timeouts.

### Measured (real deterministic path, haversine, zero model calls)
- **~3ms for 25 stops**, **~48ms for 100 stops** (placed all, no spill).

### Files
- `netlify/functions/lib/async-util.mts` *(new)* — `fetchWithTimeout`, `withDeadline`.
- `netlify/functions/routing-build-background.mts` — await the work; `aiAssist`
  opt-in gating; capped geometry assist; watchdog.
- `netlify/functions/anthropic-routing.mts`, `google-route-matrix.mts` — 8s fetch timeouts.
- `test/routing-reliability.test.mjs` *(new)* — watchdog, abort, fallback, and a
  zero-model-call deterministic build (+ a <1s perf assertion). **69 tests green.**
- No UI control needed (`aiAssist` defaults off). APP_VERSION 0.16.0 → 0.16.1.

## v0.16.0 — Desktop dispatch console (Phase 2 PR 4)

Per the desktop-primary directive, the desktop Routing surface is now a real
dispatch console; mobile keeps the v0.15.0 bottom-sheet flow unchanged. UI/layout
only; engine/matrix/cost/cache/Phase 1 untouched; still feature-flagged.

### Desktop: three-zone console
- **Left (340px):** the Setup stack — 1 Select stops, 2 Trucks, 3 Plan (intent,
  strategy, the Google live-drive-times opt-in, Build).
- **Center:** the map as a large full-height canvas (markers + route polylines).
- **Right (380px):** tabs — **Selected stops** (full sortable table + docked detail
  panel) and **Result** (route cards, spill, cost readout). Result auto-surfaces on
  build completion; Stops stays one click away. Tab choice persists (localStorage
  `routing.rail`, a view pref).

### Mouse-native selection (desktop)
- **Click-drag rubber-band box** is the primary desktop gesture: a capture overlay
  (rendered only while Box mode is armed) draws a rectangle, and mouseup converts the
  two container-pixel corners to LatLng via a `google.maps.OverlayView` projection,
  then reuses the **proven** `boxFromCorners` + `latLngInBounds` (no new geometry).
  Esc or Cancel aborts. Drag works in any direction (unit-tested).
- Click-toggle, **Add stops in view**, **Lasso** (click vertices → Done), and
  **Clear** all kept and work with a mouse. The Box button arms drag on desktop and
  tap-two-corners on mobile (width-aware prompt). No control silently no-ops.
- Double-click-to-close lasso was intentionally NOT added (it would require disabling
  the map's normal double-click-zoom); the Done button is the close action and works
  with mouse + touch.

### Live map ↔ list linkage
- A shared `hoverId` drives both directions: hovering a table row emphasizes its
  marker (larger, dark ring, raised z) and hovering a marker highlights + scrolls its
  row into view. Only the two affected markers are re-iconned per hover (not all).
  Selection stays the single source of truth; removes flow back through `onRemove`.

### Loose pieces (the flagged gap)
- **Loose pieces** = NuVizz `totalCartons` (already normalized as `stop.cartons`),
  now counted/shown at the **group tally**, **per stop** (mobile list rows + detail,
  desktop table column + detail), and **per route card** (column + route total).
  (If NuVizz exposes a distinct floor-loaded/“loose” count separate from cartons, it
  can be wired later; `totalCartons` is the piece count available today.)

### Files
- `src/App.jsx` — desktop three-zone layout; new `RoutingStopsPanel` (desktop table +
  hover linkage + docked detail); drag-box overlay + handlers; hover-emphasis effect;
  loose-pieces wiring across tally/list/detail/route card. Mobile path unchanged
  except the floating chip + tally now show pieces. Single-file kept.
- `test/routing-select.test.mjs` — added a drag-direction-independence test. **62 green.**

## v0.15.0 — Routing Setup: usability + correctness pass (Phase 2 PR 3)

The selection bones from v0.14.x worked on desktop but two of three tools were
**dead on touch** (the owner dispatches from a phone), the per-stop intelligence
we already track wasn't surfaced, and there was no way to see the stops you'd
selected. This pass fixes all three. UI-only; engine/matrix/cost/cache/Phase 1
untouched; still feature-flagged.

### No dead buttons — touch-native selection
- **Removed the Google `DrawingManager`.** Its drag-to-draw never worked on a
  phone (the drag pans the map) and its `importLibrary('drawing')` had no error
  path, so a load failure made Box/Lasso silently no-op. There is now no drawing
  library to fail.
- **Tap a stop** — toggle (unchanged, kept; it worked).
- **Add stops in view** — selects every positioned stop inside the current map
  bounds. The primary, bulletproof touch primitive: pan/zoom to a cluster, tap.
- **Box = tap two corners** — tap corner 1, tap corner 2; the enclosed stops are
  added. Prompt shows "1 of 2 / 2 of 2"; Cancel aborts. Works on touch and mouse.
- **Lasso = tap-to-place vertices** — tap points around a group, then **Done**
  (needs ≥3); Cancel aborts. Shown on both mobile and desktop (works on both).
- Every tool gives visible feedback ("Added N stops" / "No stops in that area"),
  and an active draw mode replaces the buttons with a prompt + Cancel, so nothing
  shown can silently do nothing. `gestureHandling: 'greedy'` for one-finger pan.

### Per-stop intelligence (reuses the existing helpers)
- Each selected stop resolves its `customer_notes` by `matchKey` and renders the
  SAME badges as the map via `getRestrictionBadgeKeys` + `RESTRICTION_ICONS`
  (no-tractor-trailer, 26ft max, liftgate, appointment, receiving hours via
  `hasReceivingHours`, closed days) plus an oversize chip from `stopDetails` L-flag.
- The vague "equipment restriction in selection" line is replaced by a specific
  count summary (e.g. "2 No T/T · 1 Appt · 3 Hours · 1 oversize"). No false flags
  when a stop has no note.

### The selected-stops list (new core surface)
- Collapsible "Selected stops (N)" section under the tally — collapsed by default
  on mobile, persistent on desktop. Sortable (Customer / City / Skids / Wt) via the
  shared `useSortable` hook. Each row: customer, city, skids/weight, restriction
  badges + oversize chip; a per-row **×** removes it (two-way map/tally sync).
- Tap a row → inline detail: full address, contact, skids + weight, restriction
  badges **with labels**, formatted receiving hours ("Mon–Fri 8:00a–3:00p · Sat
  Closed"), appointment note, and the **products / line items** from `stopDetails[]`
  (name/SKU, qty, weight, dims; "No line items" if empty).

### Files
- `src/App.jsx` — `RoutingScreen` selection rewrite; new `RoutingSelectedList` +
  `RoutingStopDetail` inline components; specific tally summary. Single-file kept.
- `src/lib/routing-select.js` (new) — pure geometry + display helpers
  (`pointInPolygon`, `latLngInBounds`, `boxFromCorners`, `fmtTime12`,
  `formatReceivingHours`, `lineItemDims`), so the selection math is unit-testable.
- `test/routing-select.test.mjs` (new) — 10 tests covering bounds/box/lasso
  selection and hours/dims formatting. **61 tests green** total.

## v0.14.1 — Routing (beta) mobile layout

Makes the Routing tab usable on a phone (it was desktop-only in v0.14.0).
- **Mobile menu entry**: the version-chip menu (`MobileAppBar`) gains a flag-gated
  "Routing (beta)" item; `Shell.onSelectMenu` routes it to the tab.
- **Responsive `RoutingScreen`**: desktop keeps the three side rails; mobile
  (`<768px`) renders a full-bleed map + a **collapsible bottom sheet** that toggles
  between **Setup** (select / trucks / plan) and **Result**, with a floating
  "N selected · N skids" tally on the map. Same state/handlers — the control and
  result JSX are shared via `controlsContent` / `resultContent`.
- The map **re-inits across the breakpoint** via a `mapReady` signal so markers +
  the drawing manager rebind if the viewport crosses 768px.
- UI-only, additive, still feature-flagged; engine untouched. `APP_VERSION` → 0.14.1.

## v0.14.0 — Phase 2: Routing (beta) tab (PR 2 of 2)

The dispatcher-facing UI for the routing engine, inline in `App.jsx`, **feature-
flagged OFF in production**. Plus the one authorized engine change: **cheap by
default**.

### Feature flag

`VITE_ROUTING_BETA=true` (build-time env) **or** `?routing=1` on the URL. Off →
the tab doesn't render and nothing changes. Turn on for the deploy preview with
the query param; turn on in prod later by setting the env var.

### The tab (desktop nav "Routing (beta)")

- **Select** stops by click (toggle), box (rectangle), or lasso (polygon) — Google
  Maps drawing lib loaded via `importLibrary('drawing')`. Live tally: count, skids,
  weight, + an oversize/equipment-restriction flag. 150-stop client bound.
- **Trucks**: choose + inline-edit profiles (skids/weight/deck/liftgate), persisted
  to `truck_profiles` (seeded on first run from the server defaults).
- **Plan**: free-text intent, strategy dropdown, and the **"Use live Google
  drive-times (costs money)"** toggle (default OFF, shows the would-be element
  count + $ estimate).
- **Build**: writes `routing_jobs/{jobId}` → POSTs `routing-build-background` →
  polls the job doc via `onSnapshot`. Renders exactly what the engine returns:
  per-truck colored polylines (M5 palette), a **sortable** stop list (seq /
  customer / ETA / skids / weight), **load-vs-capacity bars**, the **spill list
  with reasons**, and the **rationale + risk flags**.
- **Cost/quality readout**: matrix source (Free estimate vs Google live), element
  count, estimated $ (0 when free), AI assist on/off.
- **Save** → `routing_routes` (inputs + outputs), with an explicit banner: this is
  a plan in our system and was **NOT** dispatched to NuVizz.

### Engine change (the one authorized edit) — cheap by default (Appendix B)

`matrixMode` is now a per-build choice: **haversine (free) is the default even when
the Google key is present**; Google is an explicit opt-in. `resolveMatrix(depot,
stops, mode='haversine')` only calls Google when `mode==='google'`. `result.meta`
gains `matrixSource`, `googleElementCount`, `estimatedCostUsd` (Basic tier, ~$5/1k).
The pipeline dep tolerates a bare matrix or `{matrix,source}` so existing callers
are unchanged. 7 new tests in `test/routing-cost.test.mjs`; 51 total green.

### Guardrails

NuVizz read-only (no write path; routes only in `routing_routes`); live cache +
Phase 1 untouched; secrets server-side only (client calls only our functions);
`App.jsx` stays single-file; graceful degradation (haversine / deterministic
rationale / job error all render cleanly). `APP_VERSION` → **0.14.0**.

## v0.13.0 — Phase 2: routing-engine foundation (PR 1 of 2, backend only)

First half of Phase 2 (ORCHESTRATION charter): the AI-led / solver-backed routing
ENGINE, server-side and fully unit-tested. **No UI in this PR** — the inline
"Routing (beta)" tab in `App.jsx` is PR 2 of 2 (the engine/UI split the brief
permits). `APP_VERSION` → **0.13.0**.

### Pipeline (five individually-testable stages, `lib/routing-pipeline.mts`)

`parseIntent` (Opus, optional) → `buildMatrix` (Google) → `solve` (deterministic)
→ `repair` (deterministic) → `explain` (Opus, optional). Dependencies are injected,
so the whole pipeline runs deterministically with the model/Google disabled and is
unit-tested with mocks.

### Files added (all under `netlify/functions/`)

- `lib/routing-types.mts` — shared contracts; the `RoutingSolver` interface Google
  optimizeTours (P2.4, deferred) can implement later without touching callers.
- `lib/routing-constraints.mts` — equipment→capability mapping, capacity, windows.
- `lib/freight-geometry.mts` — PURE skids/weight/linear-inches/oversize derivation;
  deterministic-first, Opus assist only on ambiguous stops, cached by SKU.
- `lib/routing-solver.mts` — best-fit bin-packing + strategy sequencing
  (CLOSEST/FARTHEST by depot distance; MIN_DISTANCE/MIN_TIME = nearest-neighbor + 2-opt).
- `lib/routing-repair.mts` — feasibility/repair; **guarantees every shown route is
  valid** (capacity + equipment + STRICT windows), spills the rest with reasons.
- `lib/routing-intent.mts` — defensive parsing of model JSON with deterministic fallback.
- `lib/truck-profiles.mts` — seed profiles (26ft box / 53ft trailer) + `truck_profiles` store.
- `lib/routing-store.mts` — `routing_jobs` / `routing_routes` helpers (reuse firestore.mts).
- `google-route-matrix.mts` — computeRouteMatrix proxy; server-only
  `GOOGLE_ROUTES_API_KEY`; chunks to the element cap; **haversine fallback** when unkeyed.
- `anthropic-routing.mts` — Opus proxy; server-only `ANTHROPIC_API_KEY`,
  `ANTHROPIC_MODEL` (default current Opus); JSON-structured + graceful.
- `routing-build-background.mts` — async job orchestration; client writes
  `routing_jobs/{jobId}` + polls; this runs the pipeline and writes the result.
- Tests: `routing-geometry`, `routing-solver`, `routing-repair`, `routing-intent`,
  `routing-pipeline` (+ fixtures). **44 tests green** via `npm test`.

### normalizeStop extension (additive)

`lib/nuvizz-scan.mts` now also surfaces `stopDetails[]` (SKU/qty/weight/dims/L flag),
`timeConstraint`, `estimatedDurationMin` (UNRELIABLE flat ~20m), `plannedDistance/
DurationToNextStop`, `stopDistance`, `contact`, `origin`, `markfor`. No field renamed
or removed; `.raw` preserved — verified the cache + Phase 1 derive still read fine.

### Env to set (Netlify dd-dispatch-map, functions scope) — tab stays dark until then

`GOOGLE_ROUTES_API_KEY` (enable Routes API on the key), `ANTHROPIC_API_KEY`,
optional `ANTHROPIC_MODEL`. `FIREBASE_SA` already present. No keys → engine runs
deterministic-only (haversine matrix, no AI rationale).

### Guardrails

NuVizz read-only (no write path exists); `nuvizz_stop_index`, refresh functions, and
Phase 1 history untouched; secrets server-side only; degrades gracefully without keys.

## v0.12.0 — Phase 1: immutable daily history warehouse (backend only)

First Phase 1 deliverable from the Davis Logistics Platform charter
(`ORCHESTRATION.md`). Adds a scheduled, idempotent, immutable daily capture of
every stop, route (load), and driver-day into NEW Firestore collections. No UI
this phase; `APP_VERSION` bumped to **0.12.0** and still rendered in the map
footer/chip per the standing rule.

### What landed (all additive)

- `netlify/functions/nuvizz-history-snapshot-background.mts` — scheduled
  background writer, cron `0 6 * * *` (06:00 UTC ≈ 01:00–02:00 ET, after ET
  midnight). Background (not plain scheduled) for the 15-min budget, same reason
  as `nuvizz-refresh-stops-background`. Manual backfill: `?date=YYYY-MM-DD` or
  `?from=...&to=...` (≤31 days).
- `lib/history-core.mts` — shared capture core (mirrors `refresh-stops-core`):
  parse target date(s), `scanDate()`, derive, write, verify-by-readback, manifest
  last. Target for a scheduled run = the just-closed **America/New_York** day
  (`etYesterday`, DST-safe).
- `lib/history-derive.mts` — **pure** derivation (stops→routes→drivers, ordering,
  sums, completion counts, on-time, checksum). Unit-tested.
- `lib/history-store.mts` — thin warehouse Firestore layer; reuses the exported
  `getDoc/setDoc/listDocs` from `firestore.mts` (no auth/codec duplication).
- `lib/firestore.mts` — **export-only** change: `getDoc/setDoc/listDocs` are now
  exported. Live-cache `writeStops/readStops` and behavior unchanged.
- `test/history-derive.test.mjs` + `test/fixtures/history-normalized-stops.json`
  — 11 passing tests (`npm test`, Node ≥22 strips `.mts` types natively).

### Collections (immutable; separate from the live `nuvizz_stop_index` cache)

```
history_days/{davis}__{YYYY-MM-DD}                      manifest (written LAST)
history_days/{davis}__{YYYY-MM-DD}/stops/{stopNbr}      full normalized stop + raw
history_days/{davis}__{YYYY-MM-DD}/routes/{loadNbr}     ordered stops + sums + driver
history_days/{davis}__{YYYY-MM-DD}/drivers/{driverKey}  loads + stop/completion counts
history_days/{davis}__{YYYY-MM-DD}/captures/v{n}        append-only lineage audit
history_driver_days/{davis}__{driverKey}/days/{date}    cross-day loads-by-driver index
```

### Invariants enforced

Immutable (a past day is never pruned — re-capture UPSERTS and KEEPS absent
prior stops, logging the discrepancy in the captures audit); append-only capture
lineage with incrementing `capture_version` + content checksum; four-layer raw
preserved on every stop (incl. `stopExecutionInfo`); verify-by-readback with the
manifest written last and non-200 on mismatch; NuVizz read-only (only call is
`scanDate`); the live cache and refresh functions are untouched.

### Notes for the next agent

- `motiveActuals` on each driver doc is `null` with a v1.1 TODO hook — do NOT
  call Motive in v1.
- A future "settle pass" (re-capture day-2 to absorb late POD) is a TODO, out of
  v1 scope.
- Phase 3 history UI is where the "Mon D, YYYY" date-display rule applies; storage
  keys here intentionally use `YYYY-MM-DD` (internal).

## v0.8.0 — M4.5 mobile responsive complete (PR 3 of 3)

Closes out the M4.5 milestone. Adds the smaller items that round out the
mobile path and the deliverables called out in the brief.

### Driver marker labels — mobile-aware default (brief P3.3)

`showDriverLabels` defaulted to `true` for all viewports in M4.4, which made
the small mobile viewport noisy when 35 driver labels were drawn at once.
The default is now viewport-conditional: when the dispatcher has never
touched the toggle, mobile (<768px) starts with labels **off**, and desktop
starts with labels **on**. Once flipped, the preference is persisted to
`dispatchMap.driverLabelsVisible` and respected on every subsequent load.
This is detection-on-first-mount only — resizing the window after that does
not flip the default.

### Driver snapshot → stop detail (brief P4.2 follow-through)

Tapping a stop row inside the `MobileDriverSnapshotDrawer` now resolves the
snapshot's row back to a live stop from today's stops payload via **PRO
match** (checks `primaryPro`, `pro`, and the `pros` array). When a match is
found, the driver drawer closes, the map pans / zooms to the stop, and the
stop detail drawer opens. When no match is found (e.g. snapshot stop is
not in today's planned stops), the map pans to the snapshot's lat/lng
without opening the detail drawer.

### Diagnostics page — mobile padding

`DiagnosticsScreen` switched from `p-6 space-y-6` to `p-3 sm:p-6
space-y-4 sm:space-y-6` so the placeholders / TODO panels render reasonably
on a 375 px viewport. The screen itself is still M3-stub heavy; M4.5's
contribution is layout only. The version-chip menu (wired in PR 1) is the
mobile path to reach this screen.

### Deliverables

- `RESEARCH-mobile-breakpoints.md` — full breakpoint matrix, touch-target
  audit, safe-area inset usage, localStorage keys, scoped-out items, and
  the pre-prod real-device verification checklist.
- `APP_VERSION` 0.7.2 → **0.8.0** (matches M4.5 brief target).
- `package.json` / `package-lock.json` bumped.
- `HANDOFF.md` (this file) — v0.8.0 section.

### Bundle size — final

App bundle landed at 569.51 KB raw / 154.64 KB gzipped. M4.5 delta over
v0.7.0 (M4.4): +17.67 KB raw, +3.53 KB gzipped — under the brief's 50 KB
code-split threshold. No `manualChunks` work needed.

### Scoped-out items (intentional)

See `RESEARCH-mobile-breakpoints.md` § "What was deliberately scoped out"
for the full list. Notable: the brief referenced a satellite-toggle that
the M4.4 HANDOFF mentioned but never shipped to code, so M4.5 does not
attempt to mobilize an absent control.

### Real-device verification

Required from Chad before declaring M4.5 production-ready. The
`RESEARCH-mobile-breakpoints.md` § "Known limitations not yet tested on
real devices" lists the five plausible iOS-specific issues to walk through.

## v0.7.2 — M4.5 mobile drawers (PR 2 of 3)

Replaces the temporary full-screen `StopSidebar` / `DriverSnapshotSidebar`
overlays from PR 1 with proper slide-up bottom-sheet drawers. Desktop /
tablet (≥768px) layouts remain unchanged.

### New shared primitive — `BottomSheet`

Pulled the slide / drag / snap / backdrop behavior out of `MobileDrawer` and
into a reusable `BottomSheet` component. Each consumer picks its own snap
stops (`SHEET_HEIGHTS` 30/60/95vh for the main drawer, `STOP_DETAIL_HEIGHTS`
30/80/95vh for the stop and driver detail drawers — defaults to 80vh per
brief P2/P4). Touch handling is still native (no library).

`MobileDrawer` is now a thin tab-header wrapper over `BottomSheet`.

### `MobileStopDetailDrawer` (brief P2)

Tap a stop card (or marker) on mobile → this drawer slides up.

- Header: PRO label + customer name + truncated address line + 44×44 × close
  button.
- Tabs: **Info** / **Notes** / **Hours** / **PROs**.
- **Info** — read-only address, addr2 (amber callout if present), city/state/zip,
  window times, items summary, load + driver line.
- **Notes** — view mode renders the existing `ReadOnlyNoteView`. Tap **Edit**
  to expand into the full edit form (priority flag chips, appt + liftgate
  44×44 toggle rows, equipment-restriction chips, dock type chips, dock
  notes textarea, appointment notes input, contacts editor with add/remove).
  All controls are touch-sized (44×44 minimum).
- **Hours** — view mode renders a 7-row read-only list. Edit mode shows the
  M4.4 hours editor: 44×44 day open/closed toggles, **Copy Mon → Tue-Fri**
  helper, per-day native `<input type="time">` pairs (44px tall) or a red
  "Closed" pill with inline **Open** action.
- **PROs** — list of PROs, each row 48px. Tap copies to clipboard + shows
  a green "Copied" toast at the top of the drawer for 2 seconds.
- **Sticky Save / Cancel bar** appears at the bottom of the drawer while in
  edit mode on Notes or Hours. Buttons are 44px tall and clear the iOS
  home-indicator safe area. Save calls the same `handleSave` path the
  desktop sidebar uses.
- **Discard-changes confirm** — closing the drawer with unsaved edits opens
  a modal dialog asking "Discard changes?". "Keep editing" returns to the
  drawer; "Discard" closes without saving.
- **Cross-tab draft preservation** — the draft is held at the drawer level,
  so switching tabs while in edit mode does not lose changes; a single
  Save commits the entire customer-notes document.

### `MobileDriverSnapshotDrawer` (brief P4)

Tap a driver row in the main drawer's Drivers tab (or a driver marker on
the map) → this drawer slides up.

- Re-uses two newly extracted subcomponents from `DriverSnapshotSidebar`:
  `DriverSnapshotHeader` (truck label, driver name, HOS line) and
  `DriverSnapshotBody` (Route Summary / Today's Stops / Live Telemetry /
  Performance Today sections). Desktop sidebar still renders the same
  subcomponents inside its 380px aside.
- Each stop row in the snapshot is tap-friendly. Tap pans the map to that
  stop and closes the snapshot drawer. (Opening the stop detail drawer
  from a snapshot tap is deferred to PR 3 — would need a live-stop lookup
  by PRO since the snapshot uses a different row shape than the live
  stops list.)

### `DriverSnapshotSidebar` refactor

Body extracted into `DriverSnapshotHeader` + `DriverSnapshotBody` so both
the desktop aside and the mobile drawer render identical content. No
behavioral change on desktop.

### Build size

App bundle went from 552KB → 569KB raw (+17KB), 151KB → 154KB gzipped
(+3KB). Under the brief's 50KB code-split threshold; no `manualChunks` work
needed in this PR.

### What's deferred to PR 3

- Map interaction polish: satellite-toggle icon-only mode on mobile,
  driver marker labels hidden by default + tap-to-show.
- Diagnostics page mobile layout (cards instead of tables; access via
  the app-bar version chip menu — already wired in PR 1).
- Edit-mode polish per brief P6: drag-to-reorder restrictions (not
  applicable per brief), restriction-chip type-ahead selector if needed.
- Tap-to-open-stop-detail from inside the driver snapshot drawer.
- M4.5 test pass + `RESEARCH-mobile-breakpoints.md` + final version bump
  to 0.8.0.

## v0.7.1 — M4.5 mobile foundation (PR 1 of 3)

First slice of mobile responsive support. Adds the layout shell only — stop
detail and driver snapshot still ride the existing right-side sidebars
(rendered full-screen on mobile via a `mobile` prop until PR 2 replaces them
with proper drawers).

### What's mobile (<768px)

- **App bar** — `MobileAppBar` replaces the desktop header. 48px compact, brand
  blue, "D" mark + "Dispatch" label + tap-able version chip. Chip menu lets
  the dispatcher jump to Diagnostics or back to Map (the desktop tab nav
  has no room in the small bar).
- **Map fills the viewport** — no left filter rail, no top sheet, no
  persistent bottom nav. Map sits behind everything; status pill rides
  top-right.
- **FAB** — `MobileFAB`. Bottom-right, 56px circle, brand blue, list icon.
  Open it and the drawer slides up; the FAB rotates 45° to act as the close
  button. Sits above iOS safe-area inset.
- **Mobile drawer** — `MobileDrawer`. Slides up from the bottom edge with a
  drag handle. Three height stops (mini 30vh / default 60vh / expanded 95vh)
  snap-aligned on release. Backdrop dim + tap-to-dismiss. Three tabs:
  - **Stops** — search input + count, then a card list (1 tap = pan map to
    stop + close drawer + open the existing StopSidebar full-screen).
  - **Filters** — desktop `FilterPanel` re-used (priority flag, appt,
    liftgate, has-any-restriction, unflagged, equipment), with the M4.4
    map-display toggles stacked below. Clustering toggle is required on
    mobile (locked ON, brief P3.4).
  - **Drivers** — list of active Motive drivers. Tap a row pans the map
    and opens the existing DriverSnapshotSidebar full-screen.
- **Version chip in-map** — small `v0.7.1` chip positioned above the FAB so
  dispatcher can confirm the live version without opening the bar menu.

### Desktop / tablet (≥768px)

Unchanged. The `MapScreen` branches on `isMobile` early and falls through to
the existing JSX otherwise. M4.4 filter toolbar, resizable left panel,
StopMiniTable, sidebars, footer — all behave exactly as before.

### Why no separate `MobileApp.jsx`

Per the brief's Rules of Engagement (prefer conditional renders to splitting
single-file App.jsx). Adds ~400 lines to App.jsx but keeps every component
co-located with its data plumbing. PR 2 + PR 3 will continue adding inline
mobile components rather than spawning new files, unless the diff balloons.

### localStorage keys added

- `dispatchMap.mobileDrawerTab` — last-active drawer tab (`stops` | `filters`
  | `drivers`). Defaults to `stops`. Drawer height intentionally NOT persisted.

### Touch targets

All mobile buttons / list rows are at minimum 44×44px (FAB is 56px, drawer
tab headers 44px min-height, stop cards 64px, driver rows 56px, refresh
button 32px+ padded). The search input is 44px tall. No hover-dependent
behavior on any mobile control.

### iOS safe-area handling

- App bar uses `env(safe-area-inset-top)` padding (matches the pre-existing
  desktop header pattern).
- FAB and version chip add `env(safe-area-inset-bottom)` to their bottom
  offset so neither hides under the home indicator.
- Drawer's bottom padding consumes `env(safe-area-inset-bottom)` so its
  interior content clears the home indicator.

### What's deferred to PR 2 / PR 3

- **PR 2**: replace `StopSidebar`/`DriverSnapshotSidebar` mobile overlays
  with proper slide-up drawers (Info / Notes / Hours / PROs tabs for stops;
  full snapshot drawer for drivers).
- **PR 3**: marker-label tap behavior, satellite icon-only toggle, edit-mode
  optimizations, diagnostics layout cards, M4.5 test pass + RESEARCH doc +
  final version bump to 0.8.0.

### Real-device testing

Not done in this PR — the agent cannot test on actual iOS/Android. Verified
in Chrome DevTools mobile emulation (iPhone 14 Pro and Pixel 7 viewport
profiles). Real-device verification is dispatcher / Chad responsibility.

## v0.6.0 — M4.2 (PRO pipeline + route matching + column toggle)

Two production bugs and one UX addition. The M2.1 scanner work that was in
the original brief turned out to never have shipped to `main` — see
[RESEARCH-m21-regression.md](./RESEARCH-m21-regression.md) for the diagnosis
and the deferred-scope decision. Forensics on the parent app patterns that
back this change are in
[RESEARCH-parent-app-endpoints.md](./RESEARCH-parent-app-endpoints.md).

### Problem A — PROs missing on every stop (FIXED)

**Bug:** `nuvizz-pull-today-stops.mts` extracted PROs from `stop.proNumber`.
Live NuVizz responses have `proNumber: "G1"` (a delivery-type **code**, not
a number). The 9-digit identifier dispatchers call a "PRO" lives in
`stop.stopNbr` (e.g. `"007122719"`). Parent app does the same: see
`src/screens/StopDetail.jsx:152` displays `s.nbr` = `stop.stopNbr` as the
user-facing identifier.

**Fix:** `normalizeStop()` now sets `pro = stopNbr` and exposes
`pros: [stopNbr]`, `primaryPro`, `proCount` for the brief's array shape
(future-proof for stop grouping; today `proCount` is always 1).
`normalizePro()` was removed as dead code.

### Problem B — "No route assigned today" for every driver (FIXED)

**Bug:** `nuvizz-driver-route.mts` compared
`a.driverName.toLowerCase().trim() === driverName.toLowerCase().trim()`.
Live NuVizz returns `driverName` with inconsistent internal whitespace
(`"VINCENT  BONZO"` with two spaces). Motive sends single-spaced names.
`.trim()` doesn't collapse internal whitespace, so every comparison
failed.

**Fix:** Two layers.

1. The DAVIS_DRIVERS registry from the parent app
   (`src/lib/api.js:99-134`) is now baked into
   `dispatch-map/netlify/functions/nuvizz-driver-route.mts`. The function
   resolves the Motive-supplied full name → stable `userName` (e.g.
   `"Vincent Bonzo"` → `"VINCENT"`) and matches NuVizz loads on
   `loadAssignment.driverUserName` first. This mirrors how the parent's
   `netlify/functions/nuvizz.cjs:__driver` handler works.
2. As a fallback the function does a whitespace-normalized name compare
   (`normName()` lowercases, collapses all internal whitespace runs to one
   space, trims). So even drivers not in the registry can be matched.

Function response now includes a `matchedBy: 'userName' | 'driverName' | null`
field for diagnostics.

`nuvizz-debug-driver-routes.mts` is **deleted** — its purpose was to
discover the route endpoint, and we now have a working pattern.

### Stops table — column toggle (NEW)

The stops mini-table in the left panel has a Columns gear icon
(`Settings` from lucide-react) in its header. Click to toggle visibility
of Flag, Customer, City, PRO, Priority. Defaults: Customer / City /
Priority on; Flag / PRO off. State persists across reloads in
`localStorage["dispatchMap.tableColumns"]`.

PRO cell display:
- `proCount === 1` (today's data): full PRO shown (e.g. `007122719`)
- `proCount > 1`: matched PRO first if a search is active, then ` +N`
- `proCount === 0`: em dash
- Multi-PRO cells get a `title` attribute (and `tabIndex={0}` for
  keyboard focus) listing all PROs line by line

### Search — PRO matching

`stopMatchesSearch` now matches against every entry in `stop.pros`,
case-insensitive substring. Searching `"007122"` matches any stop whose
PRO contains that substring. `matchedPro(stop, q)` returns the specific
matched PRO so the table cell can show it first.

### Stop sidebar — PROs section (NEW)

The stop detail sidebar now has a "PROs (N)" block above Customer Notes.
Each PRO is a button — click to copy to clipboard, with a brief
"copied" indicator. `proCount === 0` shows `— No PROs —` in italic
gray.

### Driver day-snapshot — per-stop PRO display

The Today's Stops list in the driver day-snapshot sidebar now shows
`primaryPro +N` to the right of the business name. Hover/focus reveals
the full list.

### localStorage keys added

| Key | Default | Purpose |
|---|---|---|
| `dispatchMap.tableColumns` | `{ flag:false, customer:true, city:true, pro:false, priority:true }` | Stops-table column visibility |

### Out of scope (deferred to a future PR)

- **M2.1 SPL-INSTR-TEXT scanner.** The brief framed this as a regression, but
  the scanner was never merged into `main` — see RESEARCH-m21-regression.md
  for the full story. Chad confirmed defer to a separate PR.
- **`/diagnostics` page.** Was scoped to verify scanner detections; with the
  scanner deferred, the diagnostic page has no purpose. Skipped from this PR.
- **Shared cache between `nuvizz-pull-today-stops` and
  `nuvizz-driver-route`.** Today each driver-route call re-scans the full
  500-load range (~10s latency). Sharing one cache (as the parent app
  does) would drop this to ~50ms after the first scan of the day.
  Documented in RESEARCH-parent-app-endpoints.md as a follow-up.

### Deploy expectation

Per Chad, the production `dd-dispatch-map.netlify.app` is currently served
from the unmerged `claude/dispatch-map-m2.1-scanner` branch — not `main`.
M4.2 changes land on `main` and will only be visible in prod after the
Netlify deploy alias is re-pointed to `main` (or the M2.1 branch is
forward-merged).


## v0.5.1 — M4.1.6 (pin replacement)

In v0.5.0 the restriction icons were small badges layered on top of the
existing pin. Visual review showed dispatchers still scanned for the pin
shape and missed the restrictions. In v0.5.1 the pin disappears entirely
when a stop has restrictions — the restriction icon(s) become the marker.

### Marker rendering — three states

| State | Trigger | Rendering |
|---|---|---|
| A | No restrictions | Classic 28×36 purple pin (unchanged from M4.1) |
| B | Exactly 1 restriction | 36-diameter circle: white background, 2 px accent-color border, 22×22 monochrome icon glyph centered, drop shadow |
| C | 2+ restrictions | 32-diameter circles side-by-side, 2 px gap, max 3 elements; 4+ → first 2 icons + dark gray "+N" overflow badge |

Geographic anchor is the **bottom-center** of the marker group in all
three states (so the marker visually "stands on" the lat/lng point).

### Function split

`pinSvg(color, badges)` from M4.1.5 is gone. Two functions replace it:

- `pinSvgClassic(color)` — the 28×36 pin only. Used for State A. Returns
  a data URL string.
- `iconMarkerSvg(restrictions)` — used for States B and C. Returns
  `{ url, width, height, anchor: [x, y] }` so the marker effect picks the
  correct `scaledSize` and `anchor`.

The marker effect (in `MapScreen`) picks one path:

```js
if (restrictions.length === 0) {
  // State A
  icon = { url: pinSvgClassic(color), scaledSize: 28×36, anchor: (14, 34) };
} else {
  // States B / C
  const spec = iconMarkerSvg(restrictions);
  icon = { url: spec.url, scaledSize: (spec.width, spec.height), anchor: spec.anchor };
}
```

### Restriction-to-color (marker accent)

The new `accent` field on each restriction defines the marker's border +
glyph color. Distinct from the M4.1.5 `bg` field (still used for the
badge background in the sidebar / legend per-icon list):

| Kind | M4.1.6 marker accent | M4.1.5 badge bg (unchanged) |
|---|---|---|
| no_tractor_trailer | red `#dc2626` | red `#dc2626` |
| straight_truck_only → box_truck_only | red `#dc2626` | slate `#475569` |
| box_truck_only | red `#dc2626` | slate `#475569` |
| liftgate_required | blue `#1e5b92` | purple `#7c3aed` |
| appointment_required | amber `#f59e0b` | cyan `#0891b2` |
| 26ft_max | red `#dc2626` | orange `#ea580c` |
| no_53ft | red `#dc2626` | red `#dc2626` |
| no_overhead_clearance | amber-brown `#a16207` | amber-brown `#a16207` |
| unknown (fallback) | gray `#6b7280` | yellow `#eab308` |

This split keeps the M4.1.5 sidebar badge appearance unchanged (preserves
backward-compat) while giving the M4.1.6 marker a cleaner, more deliberate
color language: red for vehicle-class restrictions, blue for equipment
requirements, amber for time-based requirements.

### Cluster behavior — unchanged

When markers cluster (zoom out, multiple stops at same address), the
cluster icon takes over. Individual restriction icons only show on
un-clustered markers. Same as M4.1.5.

### Sidebar — unchanged

The sidebar restriction chips continue to use the small 14×14 badges
(M4.1.5 `glyph` field). The brief explicitly preserved this behavior.

### Legend — new "Restricted Stops" section

The Legend panel (collapsible, persists to
`localStorage["dispatchMap.legendExpanded"]`) now opens with a new
"Restricted stops" section that:

1. Explains the pin-replacement behavior in one sentence.
2. Shows live examples rendered through the same `iconMarkerSvg` function
   the map uses (so legend previews are byte-identical to map markers):
   - Single restriction
   - Multiple restrictions (2)
   - Four or more (first 2 + overflow)
3. The existing per-icon list (showing what each badge means) stays below.

### Visual verification

Each marker variant was rendered standalone via `rsvg-convert` and visually
inspected. STADLER's `no_tractor_trailer` reads cleanly at a glance: red
circle outline, red tractor-trailer silhouette, red diagonal slash. The
3-element overflow case ("+2") reads as expected.

### Known limitations (v0.5.1)

1. The marker SVGs are slightly more complex than the M4.1 pin (more
   shapes per icon). At 648 stops we haven't seen render lag, but if
   future growth pushes past ~1500 markers, consider migrating to
   `AdvancedMarkerElement` (the Google deprecation track that was
   already pending) which renders via DOM and may be faster at scale.
2. The marker glyphs use `currentColor` as a sentinel that's substituted
   via string replace at render time. No CSS cascade required — works in
   every SVG renderer we tested (browser, rsvg-convert).
3. Prohibition slash on red glyphs: when both glyph and slash are red,
   the slash visually merges where it crosses the icon. The gestalt of
   cancellation still reads correctly because the slash extends into the
   white background portions of the circle. If this looks unclear in
   practice, the slash can be given a white outline (one-line change in
   `renderMarkerGlyph`).

## v0.5.0 — Part 9 (restriction iconography)

Map markers now visually communicate equipment restrictions. Layered visual
hierarchy: priority-flag color still drives the base pin color; restriction
icons render as small 14×14 circular badges in the bottom-right of the
marker, on top of the existing pin.

- **Icon library:** seven canonical restriction kinds defined once in
  `RESTRICTION_ICONS` (in `src/App.jsx`). Each has a `bg` color and a raw
  SVG glyph fragment. Single source of truth — the same fragment renders
  inside the marker data URL (Option A from the brief) AND inside the
  React `<RestrictionIcon/>` component used by the sidebar + legend.
  Aliases (e.g. `straight_truck_only` → `box_truck_only`) live in
  `RESTRICTION_ALIASES`. Unknown kinds render a generic ⚠ badge and log
  once to `console.warn`.
- **Marker SVG:** 28×36 pin when there are no restrictions (unchanged from
  M4.1); expands to 44×44 with badges stacked on the right when 1+
  restrictions exist. Single restriction → 1 badge centered next to the
  pin; 2 → 2 stacked; 3+ → first badge + dark "+N" overflow badge. Pin
  anchor stays at (14, 34) in either size so the geographic point is
  identical.
- **`<Legend/>`** panel sits between `<FilterPanel/>` and the
  Show-Live-Drivers controls. Collapsed by default. Expand state persists
  to `localStorage["dispatchMap.legendExpanded"]`. Shows priority-flag
  colors and every restriction icon with its label, plus the "+N" overflow
  indicator.
- **Sidebar consistency:** the read-only note view now renders restriction
  rows with the same icon next to each label; the editable equipment-
  restriction chips also include the icon. The visual language between
  marker, legend, and sidebar is identical.
- **Live updates:** the existing `onSnapshot` subscription on
  `customer_notes` already drives marker re-renders. Editing a stop's
  restrictions in the sidebar → Save → marker icon updates immediately.

### Edge cases handled

| Scenario | Behavior |
|---|---|
| Stop has no customer_notes doc | No badges (existing flagColor unchanged) |
| Unknown restriction kind | Generic ⚠ badge, console.warn once per unique value |
| 3+ restrictions on one stop | First badge + dark "+N" badge |
| Restriction edit saved in sidebar | onSnapshot re-fires, marker rebuilds with new badges |
| Marker is inside a cluster | Cluster icon unchanged (existing behavior — restriction icons only show on un-clustered markers) |

### Test against STADLER (College Park, GA)

STADLER is tagged `no_tractor_trailer`. After this lands its marker should
render with a red "no tractor trailer" badge in the bottom-right —
visually distinguishable from unrestricted purple-tinted markers nearby.

### New localStorage key

| Key | Type | Default |
|---|---|---|
| `dispatchMap.legendExpanded` | boolean | `false` |

### Known limitations (Part 9)

- The brief mentioned **Option B (AdvancedMarkerElement + HTML content)**
  as an alternative aligned with the Google deprecation migration. I went
  with **Option A (SVG embedded in data URL)** since it requires no API
  surface migration and keeps the existing cluster/marker plumbing
  unchanged. The deprecation migration is still pending and tracked
  separately in the v0.3.0 known-issues list.
- Driver markers (truck pins) do **not** show restriction badges — only
  stop pins do. That's intentional: restrictions are properties of the
  destination customer, not the truck.
- The Legend panel doesn't have a tooltip or "click to filter by
  restriction" affordance. Useful future enhancement but out of scope here.

## v0.4.0 — M4.1 (resizable panel + search + driver labels + day-snapshot)

Five-part epic shipped on branch
`claude/dispatch-map-m4.1-search-and-driver-id`. Summary by part:

### Part 1 — Resizable left panel

- Drag handle is a 6-px visible vertical strip inside a 12-px hit area
  (`<ResizeHandle/>`). Hover lightens; active drag turns brand-blue at 30%
  opacity. Document-level mousemove/mouseup so the drag survives the mouse
  leaving the strip.
- Width clamped to `[240, 60vw]`. Default on first load: 320 px. On every
  drag tick we re-clamp and trigger `google.maps.event.trigger(map,
  'resize')` so the map redraws without a gap. Width is persisted to
  `localStorage["dispatchMap.leftPanelWidth"]` on drag end (not mid-drag).
- Double-click the handle resets to 320 px.
- Content tiers at width breakpoints:
  - `>= 300 px`: city column shown, customer names no longer hard-truncated
    (up to ~320 px column cap)
  - `>= 450 px`: extra "Pri" priority-flag column (red/yellow/green/purple-R)
  - At narrow widths the table itself becomes horizontally scrollable
    (`overflow-x: auto`) instead of forcing rows to wrap.
- Mobile (< 768 px viewport): we **disable** the drag handle and render the
  panel as a top sheet (`max-height: 40vh`). The full drawer-slide UX from
  the brief is intentionally deferred — see "Known limitations" below.

### Part 2 — Search bar

- Lives at the top of the left panel, above `<FilterPanel/>`. Single text
  input, 200 ms debounce via `useDebouncedValue`.
- Matches case-insensitive substrings against six fields per stop:
  `businessName`, `pro`, `addr1`, `city`, `zip`,
  `customer_notes.dock_notes`, `customer_notes.appointment_notes`.
- Map behavior on a non-empty query:
  - All markers stay on the map; non-matching pins drop to **0.3 opacity** so
    spatial context is preserved.
  - 1 match → `panTo` + zoom-in to ≥ 14, open the stop sidebar.
  - 2–10 matches → `fitBounds` with 60 px padding.
  - 11+ matches → no auto-zoom (would over-compress the view).
- The left-rail "Stops (n)" table also filters to matching rows, and the
  search bar shows `Showing N of M stops` (or a `No stops match "xyz"` empty
  state).
- Keyboard:
  - `/` from anywhere focuses the search input (skipped while another
    INPUT/TEXTAREA has focus).
  - `Esc` clears + blurs.
  - `Enter` commits the current query to history.
- Search history: last 5 unique committed queries, in
  `localStorage["dispatchMap.searchHistory"]`. Empty-input focus opens a
  recent-searches dropdown; clicking a row re-applies it.

### Part 3 — Driver marker labels

- Each driver marker gets a custom `google.maps.OverlayView` label sitting
  4 px below the pin. Two lines:

    ```
    0608 · Trevor S.
    Stop 4 of 12
    ```

- Label rendering uses a lazy-instantiated class (the OverlayView base class
  isn't available until Maps loads). White-85%-opacity background, 1-px
  black-10%-opacity border, 11-px sans-serif, brand-blue line 1, slate
  line 2. The label is `pointer-events: none` so it doesn't steal marker
  clicks.
- Line 2 status resolution order (matches brief):
  1. `Stop {completed} of {total}` if route + progress known
  2. `Route {route_id} · {total} stops` if assigned but no progress yet
  3. `No route assigned` otherwise
  4. Suffixes: ` · en route` (speed > 5 mph), ` · stopped` (speed ≤ 5 mph
     for > 5 min), ` · stale` (GPS ping age > 30 min).
- Toggle button below the "Show live drivers" button:
  `[ Show Labels ]` / `[ Hide Labels ]`. Persists to
  `localStorage["dispatchMap.driverLabelsVisible"]`. Default ON.
- Drivers aren't clustered today, so the brief's "suppress labels within a
  cluster" behavior is moot — but if the driver layer is ever clusterable
  the OverlayView's `setVisible(false)` hook is in place.

### Part 4 — Motive driver augmentation

`netlify/functions/motive-driver-positions.mts` now returns the per-vehicle
shape spec'd in the brief:

| Field | Source |
|---|---|
| `vehicleId`, `vehicleNumber` | `vehicle.id`, `vehicle.number` / `vehicle.name` |
| `driverId`, `driverName`, `driverFirstName`, `driverLastInitial` | `current_driver` on the vehicle entry, with a fallback enrichment via `/v2/driver_vehicle_assignments` when an entry has no `current_driver` attached |
| `lat`, `lng`, `speedMph`, `heading`, `locatedAt`, `address` | `current_location` |
| `routeAssigned`, `routeId`, `routeTotalStops`, `routeProgress`, `stoppedMinutes` | Placeholders — populated by the day-snapshot's per-driver call to `nuvizz-driver-route`, not by this endpoint |

In-function 60-second cache keyed by `'default'` (one global call set);
`?nocache=1` bypasses. The client polls every 60 s anyway, so the cache
just smooths repeated re-renders.

**Field shapes still need live verification.** I assumed the Motive
documented `{ vehicles: [{ vehicle, current_location, current_driver }] }`
shape. If a tenant returns a different envelope (`data: [...]` vs
`vehicles: [...]`), the normalizer is tolerant of either — but the inner
field names (`number`, `current_driver.full_name`, `current_location.lat`)
need a smoke test against the live key. To verify:

```bash
curl -H "X-API-KEY: $MOTIVE_API_KEY" https://api.gomotive.com/v1/vehicle_locations | jq .vehicles[0]
```

If `current_driver` isn't attached, run the same against
`/v2/driver_vehicle_assignments` and confirm `assignments[].driver.full_name`.

### Part 5 — Driver day-snapshot sidebar

Click a driver marker → right sidebar swaps to
`<DriverSnapshotSidebar/>` (the stop sidebar is hidden while a driver is
selected; clicking "← Back to stops" exits driver mode).

Layout sections:
1. Header — truck #, driver name, login time + on-duty duration (from HOS)
2. Route Summary — id, total/completed/remaining, next stop with naive ETA
3. Today's Stops — list with status icons (✓/▶/○) and on-time deltas;
   each row is clickable when the stop has coordinates (centers map + zooms)
4. Live Telemetry — speed, last ping (relative time), location
5. Performance Today — on-time %, avg dwell (placeholder until data wired),
   miles driven

Data plumbing:
- `useDriverSnapshot(driver)` (in `App.jsx`) calls
  `/.netlify/functions/nuvizz-driver-route?truck=...&driver=...`. Per-driver
  30-second in-memory cache keyed by truck #. The function ALSO caches 30 s
  server-side (per-function-instance) for defense in depth.
- `nuvizz-driver-route.mts` uses a load-info scan
  (`/load/info/{loadNbr}/{companyCode}` across the same anchored range that
  `nuvizz-pull-today-stops` uses), filters to loads assigned to the target
  driver, and rebuilds a route + stop list. As of v0.6.0 (M4.2) the match
  prefers `loadAssignment.driverUserName` (resolved from a baked-in
  DAVIS_DRIVERS registry) and falls back to a whitespace-normalized
  `driverName` compare.
- Naive ETA: `haversine(driver_lat_lng, next_stop_lat_lng)` ÷ 30 mph effective.
  Implementation in `src/lib/distance.js`. Intentionally crude — upgrade to
  Google Distance Matrix later.

#### NuVizz route endpoint — using load-info scan (v0.6.0 status)

The brief originally instructed a stop-and-report if the NuVizz route
endpoint couldn't be discovered. The chosen pattern is the same load-info
scan the parent app uses for `__driver` — there is no list-loads-by-driver
endpoint in NuVizz v7, so scanning the load-number range is the working
pattern across both apps.

`nuvizz-debug-driver-routes.mts` was deleted in v0.6.0; the M4.2 fix made
its discovery purpose moot.

#### Motive HOS + daily miles — best-effort

- HOS: tries `/v1/users/duty_status_logs`, filters to the driver by name
  and to today's date, sums on-duty time. If the tier doesn't expose that
  endpoint, the snapshot just shows no login-time / on-duty-time row.
- Daily miles: **not wired.** Motive exposes per-vehicle daily summary on a
  separate endpoint that I didn't discover — the field is `null` and the
  UI shows an em-dash. To complete, find the daily-miles endpoint for this
  tier and populate `out.dailyMiles` in `nuvizz-driver-route.mts`.

### localStorage keys (M4.1)

| Key | Type | Default |
|---|---|---|
| `dispatchMap.leftPanelWidth` | number (px) | 320 |
| `dispatchMap.driverLabelsVisible` | boolean | `true` |
| `dispatchMap.searchHistory` | string[] (max 5) | `[]` |

All three are clamped/validated on read. Width is re-clamped to
`[240, viewport*0.6]` on every load and on viewport resize, so localStorage
tampering can't hide the map.

### Keyboard shortcuts

| Key | Effect |
|---|---|
| `/` | Focus the search input (no-op while typing in another input) |
| `Esc` (in search input) | Clear query + blur |
| `Enter` (in search input) | Commit current query to history |

### Naive ETA (intentional limitation)

The Next Stop ETA uses `haversineMiles(driver, stop) / 30 mph × 60 = minutes`.
This ignores roads, traffic, and dwell time. It is correct for v1 — upgrade
to Google Distance Matrix when route-quality matters more than crow-flies
distance.

### Known limitations (M4.1)

1. **NuVizz route endpoint** — see "discovery still pending" above. The
   day-snapshot's Route Summary section may show `No route assigned today`
   until the right endpoint is wired.
2. **Mobile panel** — we ship a fixed top sheet on `< 768 px`, not the
   drawer-slide UX in the brief. Functional but not animated.
3. **Daily miles** — null until the Motive vehicle-daily-summary endpoint
   is identified.
4. **Avg dwell** — placeholder em-dash. Computable from stop arrival vs
   completion timestamps once the NuVizz route endpoint is wired.
5. **Driver markers don't cluster.** Brief specified suppressing labels
   inside clusters; behavior is in `setVisible` on the OverlayView but
   currently unreachable because the driver layer is single-pin.
6. **Search-and-cluster interaction** — faded (non-matching) pins still
   participate in cluster counts. The dispatcher gets visual context (the
   pins are 0.3 opacity) but at very low zoom the cluster numbers don't
   distinguish matched from context. Acceptable trade-off given that
   `fitBounds` snaps to the matched set on small result counts.

## v0.3.0 — auth removed

Firebase Authentication has been removed from the app to match the no-login
pattern used by Glory Bound Dispatch and MarginIQ. The app now renders the
map directly on load — no login screen, no `firebase/auth` import, no
sign-out button.

**Firestore rules:** no change needed. The
[davismarginiq project](https://console.firebase.google.com/project/davismarginiq/firestore/rules)
already grants `allow read, write: if true` on `/{document=**}`, which
covers `customer_notes` (and every other collection). Sidebar Save and any
future auto-scanner writes will work as-is.

If the wildcard is ever tightened to per-collection rules, the
`customer_notes` rule will need to be `allow read, write: if true` (no auth
gate) for dispatcher writes to land.

**Other v0.3.0 changes:**
- `customer_notes.updated_by` is now hardcoded to `'dispatcher'` everywhere
  (see `NOTES_UPDATED_BY` constant in `src/App.jsx`). No per-user identity.
- `firebase/auth` is gone from the bundle (~72 KB drop).
- `VITE_FIREBASE_*` env vars are still required — Firestore needs them.
- Header right side is empty (no email, no sign-out button).

## TL;DR

- M1 (read-only map) and M2 (metadata + edit UI) are fully wired.
- M4 (Motive overlay) is implemented and toggleable.
- M3 (Diagnostics) is a page shell with TODO comments — nothing actually runs yet.
- M5 (Route polylines) is not implemented; spec at the bottom of this doc.
- The app builds (`npm run build` green) and both Netlify Functions bundle clean
  via esbuild. End-to-end live testing against NuVizz still needs the env
  credentials and a Netlify dev session.

## Repo layout decision (READ ME)

The brief asked me to create a new `DavisDelivery/dispatch-map` repo. My GitHub
MCP scope in this session was restricted to `davisdelivery/davis-nuvizz`
**only**, so I could not create a separate repo. Instead I scaffolded the
entire app as a self-contained `/dispatch-map/` subdirectory inside this repo
on branch `claude/dispatch-map-build-eEbYe`.

**To promote it to its own repo:**

```bash
# Option A — git subtree split (preserves history of the subdir only):
git subtree split --prefix=dispatch-map -b dispatch-map-extract
# then push that branch to the new empty DavisDelivery/dispatch-map repo as main

# Option B — copy + fresh-init (simpler, drops history):
cp -r dispatch-map /tmp/dispatch-map
cd /tmp/dispatch-map && git init && git add . && git commit -m "initial scaffold"
git remote add origin git@github.com:DavisDelivery/dispatch-map.git
git push -u origin main
```

Either way, point Netlify (`dd-dispatch-map.netlify.app`) at the new repo with
publish dir `dist`, functions dir `netlify/functions`, and the env vars listed
below.

## What's built — M1

`src/App.jsx` → `<MapScreen/>`

- Login gate (`<LoginGate/>`) wraps the whole app. Email/password sign-in via
  Firebase Auth. Until the user resolves, nothing renders.
- `useStops()` hits `/.netlify/functions/nuvizz-pull-today-stops` on mount and
  on the manual refresh button. The function:
  - Calls NuVizz `/stop/info/customer/{DAVIS}?fromDTTM=...&toDTTM=...` (today
    UTC by default) via HTTP Basic auth — same pattern as davis-nuvizz's
    `netlify/functions/nuvizz.cjs`.
  - Falls back to `test/fixtures/nuvizz-today-stops.json` if `NUVIZZ_DAVIS_USER`
    isn't set OR `?mock=1` is on the URL. This is how the UI works without
    creds.
  - Returns a normalized shape — PRO (9-digit zero-padded), business name,
    addr1/2, city, state, zip, lat/lng, scheduled window, items summary,
    driver name. **Raw NuVizz payload is preserved on `.raw`** per the
    "preserve raw at every layer" rule.
- Map centered on Buford GA (33.9719, -84.0008), zoom 10.
- `MarkerClusterer` from `@googlemaps/markerclusterer` v2 — handles 750+ markers
  without lag.
- Click a marker → right sidebar (`<StopSidebar/>`) shows PRO, business name,
  full address, **raw addr2 in its own amber-highlighted block** (so the
  dispatcher can see "what's already in the dumping ground"), items, window,
  load + driver.
- Manual refresh button in the top-right map overlay with `last-refreshed` ago
  timestamp + source label ("NuVizz" vs "MOCK DATA").

## What's built — M2

- `src/lib/firebase.js` — initializes Firebase Auth + Firestore from
  `VITE_FIREBASE_*` env. Gracefully no-ops if not configured (login screen
  shows a config warning instead of crashing).
- `src/lib/matchKey.js` — `normalizeMatchKey(name, addr1, city, zip)` per the
  spec in the brief (suffix stripping, street-type abbreviation, underscore
  collapse). Same algorithm runs client-side and (would run) server-side if we
  ever need batch matching server-side.
- `useCustomerNotes()` subscribes to the full `customer_notes` collection live
  via `onSnapshot`. Cheap — ~hundreds of docs max — and means dispatcher edits
  show up instantly across tabs.
- When a stop is clicked the sidebar looks up `notes.get(stop.matchKey)`. If
  present → read-only summary + Edit button. If absent → form is pre-filled
  with `emptyNote(stop)` and "save" creates the doc.
- All schema fields editable:
  - `priority_flag` (red/yellow/green/none)
  - `receiving_hours` (per-day text inputs)
  - `appointment_required` + `appointment_notes`
  - `equipment_restrictions` (multi-select chips: `no_tractor_trailer`,
    `26ft_max`, `no_53ft`, `box_truck_only`, `no_overhead_clearance`)
  - `liftgate_required`
  - `dock_type` (radio: dock_high / ground / either / unknown)
  - `dock_notes`
  - `contacts[]` (name / phone / role rows, add/remove)
- `photo_urls` is in the schema and gets written through, but there's no upload
  UI yet — needs Firebase Storage wiring. Field is intentionally left empty
  until M3 or whenever you wire up Storage.
- **Marker color logic** (`flagColor()`):
  - `priority_flag === 'red'` → `#dc2626`
  - `'yellow'` → `#eab308`
  - `'green'` → `#16a34a`
  - any restriction/liftgate/appointment but no priority → `#7c3aed` purple
  - no note at all → brand blue `#1e5b92`
- **Filter rail** (left side, `<FilterPanel/>`): priority flag chips,
  appointment-required, liftgate, has-any-restriction, unflagged-only,
  equipment-restriction dropdown. Reset button. Filtered count shown.
- **pro_history**: appended on every save (idempotent — only adds if the
  last entry isn't already today's PRO). Max 20, FIFO. Displayed as compact
  chips at the bottom of the sidebar.
- **Sortable mini-table** below the filter rail shows the currently-visible
  stops sortable by Flag / Customer / City / PRO via the `useSortable` hook +
  `<SortableTh/>` component — per the standing dev rule.

## What's built — M2.1 (auto-scanner)

Passive scanner that watches each stop's NuVizz signals and auto-populates
`customer_notes.equipment_restrictions` when known patterns appear. v1 covers
the `no_tractor_trailer` flag only; the pattern table is hardcoded and easy to
extend.

### Where SPL-INSTR-TEXT lives in the NuVizz response

Confirmed by inspecting the live `/load/info/{loadNbr}/{companyCode}` response
(the same payload that `nuvizz-pull-today-stops.mts` already pulls — no second
endpoint needed). Each stop carries:

```
Load.stops[].stop.comments[]   // array of comment objects
```

Each comment with `cmtType === 'ORD_IN'` is an order instruction. Its
`commentDescription` field is prefixed `"SPL-INSTR-TEXT: ..."`. The function
joins all such comments by `\n` and surfaces them as
`signalSources.orderInstructions` on the normalized stop payload.

Sample (real, today): 1,994 comments across 713 stops, 1,280 of which are
`SPL-INSTR-TEXT:` prefixed.

### Performance — zero extra NuVizz calls

The original spec assumed we might need a per-PRO fetch. We do not. The
existing `/load/info/` response already contains `stop.comments[]` inline, so
the scanner runs entirely against data we were already fetching. Map load time
is unchanged.

### Signal sources scanned

```
signalSources.addressLine2      // raw addr2 string — DAVIS-curated, trusted
signalSources.orderInstructions // joined SPL-INSTR-TEXT comments — ULINE, advisory
```

Both raw, both nullable. Per the standing rule we preserve raw — the scanner
reads these, doesn't mutate them.

### Source-locked flags (v0.3.0)

The two sources have different confidence levels, so they map to different
flags. Same physical icon (truck-with-slash) but different color:

| Source | Flag | Marker | Trust |
|---|---|---|---|
| `addressLine2` | `no_tractor_trailer` | red truck-slash pin | Davis dispatcher curated |
| `orderInstructions` | `uline_straight_truck` | amber truck-slash pin | Uline-supplied, verify |

Source-locked, not text-locked: the same phrase (e.g. "STRAIGHT TRUCK ONLY")
can appear in either field, but the trust level is determined by *who wrote
it*, not what they wrote.

### Pattern rules

Hardcoded in [`src/lib/signal-scanner.ts`](src/lib/signal-scanner.ts).
Two separate lists, one per source (`ADDR2_PATTERNS`, `ORDER_INSTR_PATTERNS`).
v0.3.0 covers Davis "NO TRACTOR TRL / NO TT / STRAIGHT TRUCK ONLY / 26FT MAX /
NO 53" phrasings, and Uline's standard SPL-INSTR wording.

To extend: append to the appropriate `*_PATTERNS` array (or add a new source
entry under `SOURCE_RULES`). When the rule set grows past ~5 flags, move to a
Firestore `scanner_config` doc.

### Legacy migration

v0.2.0 wrote `no_tractor_trailer` for *any* hit, including SPL-INSTR-TEXT.
The v0.3.0 writer auto-migrates those docs: if `auto_sources.no_tractor_trailer`
contains only `'orderInstructions'` and `manual_overrides.equipment_restrictions`
is false, the writer swaps `no_tractor_trailer` → `uline_straight_truck` on
the next scan. Manual overrides are always respected.

### Writer behavior

[`src/lib/customer-notes-writer.ts`](src/lib/customer-notes-writer.ts) walks
scan results, groups by `match_key` (so two stops at the same customer merge
into one write), and chunks writes into Firestore batches of 450. Each write
is a `setDoc(..., {merge: true})` so we never clobber human fields.

Schema additions on `customer_notes`:

| Field | Type | Purpose |
|---|---|---|
| `manual_overrides.equipment_restrictions` | `boolean` | Dispatcher locked this field against the auto-scanner |
| `auto_sources` | `{ [flag]: ('addressLine2' \| 'orderInstructions')[] }` | Which sources detected each flag |
| `auto_matches` | `{ [flag]: { source, text, pattern }[] }` | Exact substring + pattern that hit |
| `auto_detected_at` | `Timestamp` | Last auto-scan write |
| `auto_detected_by` | `string` | `'auto-scanner v0.2.0'` |

`equipment_restrictions` uses `arrayUnion` so the auto-scanner adds the flag
without clobbering anything else the dispatcher has set on that array.

### Manual-override mechanism

The auto-scanner respects two signals:

1. **`manual_overrides.equipment_restrictions === true`** — set explicitly by
   the "Override auto-detection" button in the sidebar. While true, the scanner
   updates `auto_*` audit fields but never touches `equipment_restrictions`.
2. **Implicit override on save** — `handleSave()` in `App.jsx` compares the
   draft `equipment_restrictions` against the existing doc as sets. If they
   differ (added, removed, or replaced), the flag flips to `true` automatically.

The override never disables the audit trail, so dispatchers can always see
"the scanner would have detected X" via the Detection Source section.

### UI disclosure

The sidebar has a "Detection source" section (above the existing Customer
Notes block). For every flag currently set OR currently detected, it shows:

- The flag label (e.g. "No tractor trailer")
- A small badge — `Auto-detected`, `Manually set`, `Auto + manual`, or
  `Override · auto also detected`
- The matched text strings indented under the source label

When auto detections exist and `manual_overrides.equipment_restrictions` is
false, an "Override auto-detection" button is shown that flips the flag.

### Marker rendering

Three tiers (highest confidence wins):

| Variant | When | Pin | zIndex |
|---|---|---|---|
| Davis no-TT | `equipment_restrictions` includes `no_tractor_trailer` OR live scan hit | red truck-slash | 600 |
| Uline advisory | `equipment_restrictions` includes `uline_straight_truck` OR live scan hit | amber truck-slash | 500 |
| Default | otherwise | standard colored pin via `flagColor()` | — |

The first-paint "live scan" path means a stop's marker takes the right color
immediately, before the Firestore round-trip. Once the write lands the
doc-driven path keeps it in place.

### General notes field

Schema field `general_notes: string` on customer_notes. Free-form textarea in
the sidebar Edit form (above Contacts). Persists per `match_key` like every
other field — recurs automatically on future stops at the same customer.
Designed for "anything that recurs" — gate codes, security desk procedures,
specific contacts to call, weird parking instructions, etc.

The existing structured fields (`receiving_hours`, `contacts[]`,
`appointment_notes`, `dock_notes`) cover the common cases; `general_notes` is
the catch-all when the recurring info doesn't fit a structured slot.

### Satellite toggle

`<MapScreen/>` carries a `satelliteMode` state and renders a toggle button
just below the top-right status pill. ON → `google.maps.MapTypeId.HYBRID`
(satellite imagery + road labels), OFF → `ROADMAP`. Hybrid keeps road labels
so the dispatcher stays oriented while visually verifying Uline straight-truck
advisories against actual site geometry (truck courts, gate sizes, etc.).

### Search (v0.4.0)

Top of the left rail. Substring match across PRO digits (leading zeros
stripped), `businessName`, `addr1`, `city`, `zip`. Filters both the stops
table AND the map markers — the dispatcher's map shrinks to the search
result while typing. Clear with the X button or by deleting the input.

### Expandable map legend (v0.4.0)

Each legend item is a count + chevron. Click to expand a scrollable list of
business names that currently match that bucket (Davis-verified, Uline
advisory, has-notes, no-notes). Click a name in the list to open its sidebar
AND pan/zoom the map to it (`focusStop` helper). Cheap to compute — runs
once per render at ~700 stops.

### Stops mini-table dot colors (v0.4.0)

Dots now mirror the map marker color so the table and the map agree at a
glance:

1. `no_tractor_trailer` present (or live scan hit) → red
2. `uline_straight_truck` present (or live scan hit) → amber
3. priority_flag set → red/yellow/green
4. has any restriction/note → purple
5. unflagged → gray

Order matters: Davis-verified wins over everything else.

### Confirm / Dismiss Uline advisory (v0.4.0)

When a stop carries `uline_straight_truck`, two buttons appear in the
sidebar's Detection Source section:

- **Confirm (it's true)** — promotes the advisory to `no_tractor_trailer`
  (Davis-verified, red pin). Sets `manual_overrides.equipment_restrictions =
  true` AND adds `uline_straight_truck` to `auto_scan_dismissed` so the
  scanner can't reintroduce it.
- **Dismiss (wrong)** — removes `uline_straight_truck` from
  `equipment_restrictions` and adds it to `auto_scan_dismissed`. Marker drops
  off the red/amber tier on next refresh.

**New schema field:** `auto_scan_dismissed: string[]` — flags the user
explicitly told the scanner to leave alone. The writer skips detected flags
present in this list (no audit-trail update, no equipment_restrictions
change). This is more surgical than the global `manual_overrides` lock — it
silences specific advisories without disabling the whole field.

### Detection Source label semantics

v0.3.0 only shows "Manually set" / "Override · auto also detected" when
`manual_overrides.equipment_restrictions === true`. Without that flag, a value
in `equipment_restrictions` is assumed to be the auto-scanner's write
(because the scanner is also a writer). The earlier "Auto + manual" badge was
ambiguous and is gone.

## What's built — M4

- `<MapScreen/>` has a "Show live drivers" toggle in the left rail.
- `useDriverPositions(enabled)` polls `/.netlify/functions/motive-driver-positions`
  every 60s while the toggle is on; clears the interval cleanly on toggle-off
  or unmount.
- Driver markers are rendered as 40×40 dark-truck icons (`truckSvg()`), NOT
  added to the cluster (separate layer, `zIndex: 1000` so they sit on top of
  stop pins).
- `motive-driver-positions.mts` calls `GET /v1/vehicle_locations` with
  `X-API-KEY` header. Returns `{ drivers: [{ vehicleNumber, driverName, lat,
  lng, speedMph, heading, locatedAt, address }] }`.

**Motive API caveat I didn't get to verify:** I used the documented
`/vehicle_locations` endpoint and assumed the standard `{ vehicles: [{
vehicle, current_location, current_driver }] }` response shape based on
public Motive docs. **If Davis's Motive account uses a different endpoint
(some accounts use `/users/{id}/locations` or `/fleet/locations`), the
function will return zero drivers.** Test against your account and adjust the
parse in `motive-driver-positions.mts` if needed.

## What's stubbed — M3

`<DiagnosticsScreen/>` in `App.jsx` has three `<Panel/>` sections, each with a
`Placeholder` that just shows a count. The TODO comments explain exactly what
each one should do:

- **M3-A "Unmatched Stops Today"** — `stops` where `notes.get(stop.matchKey)`
  is undefined. Sortable table + "Create notes" button that should open the
  sidebar editor (needs lifting selectedStop state up to App level, or
  switching to a global store).
- **M3-B "Stale Customers (90+ days)"** — `notes` where `last_updated` is older
  than 90 days. Tricky bit: these customers may not be on today's map, so the
  editor needs a "free-floating" mode that doesn't depend on a selected stop.
- **M3-C "Address Line 2 Migration"** — group today's stops by `addr2`,
  surface unique values, "Promote to Notes" per-customer to convert
  free-form addr2 into structured fields (regex heuristics: `/liftgate/i` →
  `liftgate_required: true`, `/26ft|no.*tractor/i` → push into
  `equipment_restrictions`, `/appt|appointment/i` → `appointment_required: true`).

## Environment variables

### Client (Vite — must be prefixed `VITE_`)

| Var | Where it comes from |
|---|---|
| `VITE_FIREBASE_API_KEY` | davismarginiq Firebase console → Project settings |
| `VITE_FIREBASE_AUTH_DOMAIN` | `davismarginiq.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | `davismarginiq` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `davismarginiq.appspot.com` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | davismarginiq console |
| `VITE_FIREBASE_APP_ID` | davismarginiq console (create a new "Dispatch Map" web app there) |
| `VITE_GOOGLE_MAPS_API_KEY` | new key in GCP, restrict by HTTP referrer to `*.davisdelivery.com/*` and `dd-dispatch-map.netlify.app/*` |
| `VITE_USE_MOCK_NUVIZZ` | optional, `true` to force fixture |

### Server (Netlify Functions only — NEVER prefix `VITE_`)

| Var | Value / source |
|---|---|
| `NUVIZZ_DAVIS_USER` | same as davis-nuvizz project |
| `NUVIZZ_DAVIS_PASS` | same as davis-nuvizz project |
| `NUVIZZ_DAVIS_COMPANY_CODE` | `DAVIS` |
| `NUVIZZ_BASE_URL` | `https://portal.nuvizz.com/deliverit/openapi/v7` |
| `MOTIVE_API_KEY` | `__REDACTED__` (per brief) |
| `MOTIVE_BASE_URL` | optional, `https://api.gomotive.com/v1` |

`.env.example` in the repo lists all of these with the right shape.

## Firestore — required setup

Create the `customer_notes` collection in the `davismarginiq` project (no
manual schema — Firestore is schemaless; first `setDoc` makes it). Doc IDs are
the match key.

You also need **Firestore rules** allowing authenticated users to read/write
`customer_notes`. The existing rules in davismarginiq likely cover this with a
catch-all `request.auth != null` rule; verify before going live or add:

```
match /customer_notes/{key} {
  allow read, write: if request.auth != null;
}
```

## NuVizz API integration notes

- The function uses **HTTP Basic auth** directly against
  `https://portal.nuvizz.com/deliverit/openapi/v7` — no JWT exchange. This
  matches the pattern in `davis-nuvizz/netlify/functions/nuvizz.cjs` (line ~64
  `basicAuthHeader`).
- The endpoint `/stop/info/customer/{companyCode}?fromDTTM=...&toDTTM=...` with
  no customer filter returns every stop in the window — confirmed working in
  davis-nuvizz's `__today` aggregator (see `fetchLoadsAndStopsForRange`,
  same file).
- I did NOT replicate the load-info fan-out that the existing davis-nuvizz
  aggregator does (`parallelMap` over `loadNbrs`). For the dispatch map all we
  need is the stop record itself — load detail is shown only as `loadNbr` +
  `driverName` from the stop's `.load` sub-object. If you need richer load
  data (vehicle type, total miles, etc.) in the sidebar, copy
  `fetchLoadsAndStopsForRange` from nuvizz.cjs.
- **Latitude/longitude:** I trust the `address.latitude` / `address.longitude`
  fields on each stop. If those are null for any customer the marker is
  silently dropped. M3 diagnostics should surface these as "unmappable stops".
- The function **falls back to the bundled fixture** if `NUVIZZ_DAVIS_USER` is
  unset, which means the app appears to "work" in environments without creds.
  Watch the source label on the top-right status pill — "MOCK DATA" means the
  fallback fired.

## Known issues / open questions for Chad

1. **Marker `google.maps.Marker` is deprecated** in favor of
   `AdvancedMarkerElement`. I used the classic Marker because Advanced requires
   a `mapId` (Map ID configured in GCP). Working as-is — Google still serves
   them — but you may want to migrate when M5 routes ship.
2. **Photo upload not built.** `photo_urls` writes through but no upload UI.
   Needs Firebase Storage rules + a `<PhotoUploader/>` component. Probably an
   M3 task.
3. **No undo on Firestore writes.** Save is immediate and replaces the doc.
   If you fat-finger a field there's no history view. Consider a
   `customer_notes_history` subcollection on each save in a later pass.
4. **Diagnostics duplicates the data fetch.** `<DiagnosticsRoute/>` calls
   `useStops` and `useCustomerNotes` independently of `<MapScreen/>`, so
   switching tabs re-fetches. Promote to a context (or top-level state in
   `<Shell/>`) when M3 starts doing real work.
5. **No date picker.** The brief only asks for "today" so the function defaults
   to today UTC. Add `?date=YYYY-MM-DD` to the function URL to view another
   day (the function supports it; UI doesn't expose it).
6. **Match-key collisions:** the algorithm collapses both "St" and "Street" to
   `st` but doesn't distinguish "1234 Main St" from "1234 Main St Suite 4"
   well — `Suite 4` becomes `ste_4`. Two units of the same building share a
   match key. Probably correct (same customer, different suite = same notes?)
   but flag it as you encounter cases.
7. **Address parsing is NuVizz's job.** If a customer types the same address
   in two different formats across two PROs, the match keys diverge. M3-C
   migration UI should expose this so the dispatcher can manually merge.

## Testing locally

```bash
cd dispatch-map
npm install
cp .env.example .env
# Fill in at least VITE_FIREBASE_* and VITE_GOOGLE_MAPS_API_KEY
npx netlify dev    # starts vite + the functions on http://localhost:8888
```

If `NUVIZZ_DAVIS_USER` isn't set the function falls back to the fixture and
you'll see the 10 sample stops around metro Atlanta. Once you set real creds
in `.env`, refresh — should pull live data.

End-to-end smoke test once live:

1. Sign in with a Firebase Auth user from davismarginiq.
2. Map loads, ~750 markers cluster across north Georgia.
3. Click a marker → sidebar opens, addr2 highlighted in amber.
4. Click Edit → fill in a flag + a restriction → Save → marker color
   changes immediately (Firestore live subscribe).
5. Refresh the page → edit persists.
6. Toggle "Show live drivers" → truck icons appear (if Motive API call works
   against the account — see caveat above).

## M5 — next session

Spec from the brief:

> Once NuVizz Route Workbench finalizes routes, pull route assignments per
> driver, draw polylines connecting stops in route order, color by driver.

Suggested approach:

1. New function `nuvizz-pull-routes.mts` that fetches `/load/info/{loadNbr}`
   for every active load today (use davis-nuvizz's `__fleet` scan pattern
   from `nuvizz.cjs` line 333 `scanFleet` — probes the load-number range
   parallel x20).
2. Build a per-driver map: `{ driverUserName: [stopNbr, ...] }` ordered by
   `stopSeq`.
3. On the map, draw a `google.maps.Polyline` per driver connecting stops in
   sequence. Color from a fixed palette keyed off `driverUserName` (steal
   the `DAVIS_DRIVERS` list from `davis-nuvizz/src/lib/api.js` for the
   roster).
4. UI: filter rail toggle "Show routes" + a per-driver legend with
   show/hide checkboxes.
5. Performance: 35 drivers × ~20 stops = 700 polyline segments. Should be
   fine — polylines are cheap. If lag appears, batch into one Polyline per
   driver with all path points in one array (Google handles that natively).

The cluster layer should NOT cluster polylines — they're a separate map
overlay, just like the M4 driver markers.

## File map

```
dispatch-map/
├── README.md
├── HANDOFF.md                                    ← you are here
├── .env.example
├── netlify.toml
├── package.json, vite.config.js, tailwind.config.js, postcss.config.js
├── index.html
├── public/
├── src/
│   ├── main.jsx
│   ├── index.css
│   ├── App.jsx                                   ← single-file React app
│   └── lib/
│       ├── firebase.js                           ← Firebase Auth + Firestore init
│       └── matchKey.js                           ← normalizeMatchKey()
├── netlify/
│   └── functions/
│       ├── nuvizz-pull-today-stops.mts           ← M1 data source
│       └── motive-driver-positions.mts           ← M4 live drivers
└── test/
    └── fixtures/
        └── nuvizz-today-stops.json               ← 10-stop mock around metro Atlanta
```
