# CLAUDE.md — agent operating notes

Operating notes for any agent (or human) working in this repo.

## Workflow

- **Branch → push → squash-merge straight to `main`. Ship forward.**
  Do all work on a feature branch, open the PR, and **merge it yourself**
  (squash) once the build/tests pass — no draft gate, no waiting for a
  preview to be tested first. If something is wrong in production, we fix
  forward in the next change. Always still open the PR (record + clean
  squash) and run `npm run build` + `npm test` before merging.
  (Exception: pause for explicit sign-off only when the change is risky or
  irreversible — schema/data migrations, auth, deletes, anything that can't
  be cheaply rolled back.)
- **CI green ≠ UI works.** A passing build only means it compiled. Don't
  claim a feature *works* on its build alone — say what you verified
  (tests, a live round-trip) versus what's only compiled. We catch the rest
  in production and fix forward.
- **Bump `APP_VERSION` + the build badge on every functional change.**
  `APP_VERSION` lives in `src/version.js`; the badge renders it with the
  7-char commit and environment on every page. The version is how Chad knows
  the deploy he's looking at is the one that just shipped.

## Conventions (see ORCHESTRATION.md for the full list)

- Mobile-first; multi-file + routed; no mega-files.
- Dates: `Jul 2025` / `Jul 14, 2025`, 4-digit years, never ISO or bare numeric.
  Use `src/lib/format.js`.
- Every table uses `useSortableTable` (`src/hooks/`) + `SortableTh`
  (`src/components/`). Don't hand-roll sorting per page.
- NuVizz is **READ-ONLY** until a later, separately-authorized write-back phase.
  Never port or add write/assign/dispatch/tender paths in this phase.
- No NuVizz proprietary assets. Davis branding text + generic icons only.

## Date selector (v0.4.0)

All four pages are driven by a shared `?date=YYYY-MM-DD` URL param. When absent
or invalid the app defaults to today (clean URL). The `<DateNav>` bar sits
directly below the topbar and provides ‹ Prev / Next › business-day steppers
(skipping weekends), a native date picker, and a "Today" button (shown only when
not on today). The hook is `src/hooks/useSelectedDate.js`; helpers live in
`src/lib/dateNav.js`. The `?date` param coexists with `?status` on Loads.

## Layout map

```
src/
  main.jsx            # React + router bootstrap
  App.jsx             # routes
  version.js          # APP_VERSION + build identity (badge)
  index.css           # mobile-first styles (single 768px breakpoint)
  components/         # Layout, BuildBadge, DateNav, SortableTh, SortPills,
                      #   StopChips, StopCard, FreshnessStamp, ComingSoon,
                      #   ExportButton (CSV download; props: stops, filename),
                      #   PrintButton (calls window.print(); no props)
  hooks/              # useSortableTable, useSelectedDate
  lib/                # format, dateNav (+ tests), parseStopComments(.ts) + tests,
                      #   stopView, loadsModel, workbenchModel, nuvizzApi,
                      #   csv (+ tests) — escapeCsvField, toCsv, stopsToCsv, downloadCsv
  hooks/              # useSortableTable, useSelectedDate, useWriteCreds (no-op now:
                      #   write creds come from server env, UI never collects them)
  pages/              # Dashboard, Loads, Stops, Workbench, Driver, Map (all built)
                      #   Driver (/driver/:userName) — focused single-driver day view:
                      #     loads + ordered stop sequence via fetchDriver; reachable from
                      #     the "View day ›" link in each Workbench driver-group header
                      #   Map (/map) — day's stops on a GOOGLE map (READ-ONLY);
                      #     api.Marker per stop, coloured by status bucket; clustered;
                      #     fitBounds to visible markers; InfoWindow + Street View; filters
                      #   Routing (/routing) — map-driven PLAN/UNPLAN (v0.14.0): box/lasso/
                      #     in-view select -> target load -> insertStops/removeStops (UAT,
                      #     gated). Left controls · map · right Stops/Loads rail.
netlify/functions/
  nuvizz.cjs          # GET endpoint: ?path=__fleet|__fleetstops|__driver|
                      #   __refreshLoad|__refreshFleet (the only HTTP surface)
  fleet-refresh-background.mjs # scheduled (*/5m) cron that warms the cache
  lib/nuvizz.cjs      # NuVizz v7 read client (read-only; stateless HTTP Basic;
                      #   CACHE-FIRST: L1 60s mem -> L2 Blobs -> L3 live scan)
  lib/fleetCache.cjs  # graceful Netlify Blobs wrapper (warm fleet/stops cache)
public/test-fixtures/ # nuvizz-today-loads.json (mock-mode fixture: loads+stops)
```

## TMS UI overhaul (v0.19.0) — design system + app shell

The UI is being rebuilt into a premium TMS cockpit (see `docs/TMS.md` for the brief).
Stack stays Vite/React/Netlify — **all NuVizz wiring is kept**. Added **Tailwind**
(`tailwind.config.js`, preflight OFF so it coexists with the legacy `index.css` during
the incremental reskin), a token theme (`src/styles/theme.css`, HSL vars, dark-first +
`.light`), **Inter**, **lucide-react** icons, **cmdk**.
- `src/ui/` — design-system primitives (Button, Badge, Card, Kbd) using the `cn()` helper
  (`src/lib/cn.js` = clsx + tailwind-merge) + token colors (`bg-card`, `text-muted-foreground`…).
- `src/components/shell/` — `AppShell` (replaces `Layout`): `Sidebar` (grouped nav +
  "coming soon" items, `nav.js`), `Topbar` (title · ⌘K search · theme toggle · CallCounter
  · BuildBadge), `CommandPalette` (⌘K → navigate + actions), `ThemeProvider` (dark/light,
  localStorage `dd_theme`). Legacy pages render inside the new frame unchanged; `DateNav`
  still shows on the legacy date routes.
- `src/pages/Dispatch.jsx` (`/dispatch`) — flagship: KPI strip + **Board / Map** views over one
  shared selection. Board = unassigned queue + load lanes with **pointer drag-and-drop** (mouse +
  touch via `useBoardDrag` — drag from a card's grip handle onto a lane = plan / move; onto
  Unassigned = unplan). Map = `components/dispatch/DispatchMap.jsx` (Google markers,
  amber=unassigned/blue=planned, click to select; **box/lasso** select via `SelectionDraw` +
  `routingSelect` + an OverlayView projection). Coords come from `useGeocode`
  (`src/hooks/useGeocode.js` — client-side Google Geocoder, cached in `dd_geocode_cache`; NOT a NuVizz
  call). Plan/unplan via `usePlanning` (`src/hooks/usePlanning.js`); API touched only on plan/unplan.
  Each load lane has a **driver picker** (`KNOWN_DRIVERS` in `src/lib/drivers.js` — the enabled
  `DI_Driver` accounts of the tenant we WRITE to; currently UAT `DAVISV5` = 53. The file header
  documents the `user/list` pull so it's repeatable for the DAVIS prod switch — there the roster is
  clean enough to drop office roles → 60 road drivers). Assignments are server-backed + cross-device via
  `netlify/functions/assignments.cjs` + `src/hooks/useAssignments.js` (load→driver map in Blobs).
  Picking a driver ALSO dispatches in NuVizz: `usePlanning().dispatchDriver` resolves the load's loadId
  and calls the write fn's `assignDriver` op → `POST load/assignanddispatch/{cc}`
  `{action:'ASSIGN_DISPATCH',dispatchRoute:[{routeId:loadId,assignDtls:{driverId}}]}` (driverId = the
  roster userId in `KNOWN_DRIVERS`). "Unassigned" clears the board record only (NuVizz un-dispatch not
  yet captured). Each lane also has a **Dispatch** button → `usePlanning().dispatchLoad` → write fn
  `dispatchLoad` op → same endpoint with `{action:'DISPATCH',dispatchRoute:[{routeId:loadId}]}` (releases
  the load to its assigned driver).
- **Manual sequencing (v0.35.0 — the LOAD IMPORT path)**: each load lane shows stops in
  NuVizz's real `to.seq` order (captured by `reconcile`, surfaced via `normalizeLoad`'s
  `seq` = `stop.to.seq`) with number badges + ▲▼ reorder; edits build a local draft that
  Save commits. `usePlanning().sequenceLoad` + `commit` now run the **§10.1 load import**
  (`docs/NUVIZZ_API.md`): ONE declarative `load/update/default` per touched load — the
  `stops[]` array order IS the visit order; omitted stops are unplanned; sequence-aligned
  30-min delivery windows ride inside the payload (no per-stop window writes; the old
  `setStopWindow` full-upsert, which blanked freight fields, is retired). The engine
  (`src/lib/loadImport.js` + `src/lib/loadImportEngine.js`) echoes every to-block/header
  from NuVizz's own reads, then CONVERGES: poll `load/info` (backoff ~6/10/15/25s, ≤5
  polls), compare read-back order (normalized stopNbrs, delivery stops by `to.seq`);
  resend once, then reversed + desired to unstick; ok ONLY from the read-back. Cross-load
  moves import sources before destinations; an emptied load goes through `load/cancel`
  (never an empty import / remove-all, which cancelled the route implicitly). The old
  anchor method (keep-first + removeStops + one-at-a-time re-insert, ≈2+(N−1) calls) is
  retired from the active path but documented in §10.1 as history; a SINGLE `insertStops`
  still APPENDS and remains the incremental add fallback (a BULK insert geo-reoptimizes).
- **Sync (reconcile)**: the registry's `plannedLoadNbr` is local and can drift from NuVizz reality
  (e.g. planned-shows-unplanned). `usePlanning().reconcile()` reads each relevant load (`KNOWN_LOADS`
  + any load an order claims) ONCE via `getLoad` — a scoped, cheap "scan" (NOT the davis-nuvizz
  ~3000-call number-probe) — builds the true stopNbr→loadNbr membership and corrects each order's
  planned flag. Runs on a **Sync** button + auto-once per page load (`autoSyncDone` module flag).
- Reskin is incremental: new screens use the design system; legacy pages get migrated
  page-by-page, then `index.css` retires.

## Warm cache (v0.2.1)

The ~600-load range scan is OFF the request path. `fleet-refresh-background.mjs`
runs every 5 min (weekdays) and calls `refreshFleetCache(date)`, which scans once
and writes `fleet:<date>` / `stops:<date>` to Netlify Blobs. `getFleet` /
`getFleetStops` / `getDriver` are cache-first (L1 in-memory → L2 Blobs → L3 live)
and tag responses with `source: 'cache'|'live'` + `cachedAt`. Blobs is best-effort:
any failure degrades to a live scan, never a crash. Manual warm: `?path=__refreshFleet`.

## Live only — no mock (v0.15.0)

Mock mode was removed (`VITE_USE_MOCK_NUVIZZ`, the fixture, and the `IS_MOCK`
branches are gone). `src/lib/nuvizzApi.js` always calls the Netlify read function
`GET /.netlify/functions/nuvizz?path=…`. The environment is chosen entirely by the
function's server env vars (`NUVIZZ_*`).

**Reading UAT** (the orders/loads we create live in UAT). The read function
discovers a day's loads by scanning a numeric range of load numbers — tuned to
production (`DAVIS…196xxx`, +100/business-day). UAT numbers are different
(`LOAD000112xxx`), so `getConfig` (`netlify/functions/lib/nuvizz.cjs`) takes
env knobs, all defaulting to current prod behaviour:
- `NUVIZZ_BASE_URL` = `https://uat.nuvizz.com/deliverit/openapi/v7`
- `NUVIZZ_DAVIS_COMPANY_CODE` = `DAVISV5`, `NUVIZZ_DAVIS_USER` / `NUVIZZ_DAVIS_PASS`
- `NUVIZZ_LOAD_PREFIX` = `LOAD` (load-number prefix; default = company code)
- `NUVIZZ_SCAN_MIN` / `NUVIZZ_SCAN_MAX` = scan this FIXED range (UAT loads aren't a
  per-day sequence; bypasses the date-center estimate + calibration)
- `NUVIZZ_SCAN_IGNORE_DATE=true` = keep every load found in range (UAT test loads
  are Draft/Cancelled with no today date; otherwise the date filter hides them)

## No scans + call counter (v0.17.0) — local-first

The app no longer scans NuVizz. The only API calls are the user's write actions
(create order, plan/insertStops, unplan/removeStops), each through the write fn.
- **Scans OFF.** `discoverLoads` (`lib/nuvizz.cjs`) returns `[]` unless
  `NUVIZZ_ALLOW_SCANS==='true'`, so `getFleet/getFleetStops/getDriver` are cache-only
  (empty on a cold cache — the broad board pages show empty; that's intended). The
  `fleet-refresh-background.mjs` cron schedule was REMOVED (no more `*/5min` scan).
- **Call counter** (`netlify/functions/lib/callCounter.cjs`) — modeled on davis-nuvizz's
  `nuvizz_ops`: every upstream NuVizz round-trip is counted at the write fn's `nuvizz()`
  chokepoint into a Blobs key `calls:<ET-day>` `{ count, byRoute, byHour }` (ET-day key
  = implicit daily reset; Blobs read-modify-write since no atomic increment). Ceiling
  `NUVIZZ_DAILY_CEILING` (default 1000), mode `NUVIZZ_BREAKER_MODE` (monitor default).
  Exposed by the GET `nuvizz-ops` fn (Blobs only — never calls NuVizz). The topbar
  `<CallCounter>` pill ("API N / ceiling (mode)") polls it + refreshes on the
  `dd-api-call` event that `nuvizzWrite.call()` fires after every write.
- **Known loads** (`src/lib/loads.js`, `KNOWN_LOADS`) — the hardcoded loads the Routing
  board targets, so no discovery read. `loadId` is optional; if absent Routing resolves
  it once via `getLoad` on first Plan and caches it (`localStorage dd_loadid_cache`).

## Server-side write creds (v0.18.0)

The write fn (`nuvizz-write.cjs`) no longer requires per-request credentials — it
falls back to server env `NUVIZZ_DAVIS_COMPANY_CODE` / `NUVIZZ_DAVIS_USER` /
`NUVIZZ_DAVIS_PASS` (already set on Netlify; production = the UAT `DAVISV5` tenant).
A request MAY still override any field, but the UI never collects creds: `useWriteCreds`
is a no-op (`canWrite: true`, empty creds), and the Builder/PlanBar creds bars are gone.
Trade-off: the public site can now trigger UAT writes with no creds — acceptable for a
gated (`NUVIZZ_WRITE_ENABLED`) UAT-only beta; add Netlify visitor password if that matters.

## Created-orders registry (v0.23.0 — server-backed, cross-device)

The registry now **syncs across devices**: Netlify Blobs is the source of truth via
`netlify/functions/orders.cjs` (GET → list; POST `{op}` add/remove/setPlanned/merge/clear,
each a read-modify-write returning the canonical list; seeds the starter orders on first
read). `src/lib/createdOrders.js` keeps a localStorage **mirror** (`dd_created_orders`) for
instant render + offline, mutates it optimistically, then POSTs the op and reconciles to the
server's list. `useCreatedOrders` syncs on mount (one-time `merge` of any pre-existing local
orders up, flagged `dd_orders_synced`), then refreshes on window focus + a 20s interval so a
change made on one device shows on another. (Earlier this was localStorage-only / per-browser.)

`src/lib/createdOrders.js` (+ `useCreatedOrders` hook) — the list of orders we've created in
UAT, each carrying its `stopId`.
The **Builder** appends to it on every successful create and shows the list
(`CreatedOrdersPanel`). The **Routing** page reads it (Orders tab) so created
orders are selectable to plan onto a load with no extra read. Planning/unplanning
updates each order's `plannedLoadNbr`. A `dd-created-orders` window event keeps
both screens live.

## Map page (Google Maps; read-only browse)

`/map` — **Google Maps JS API** (imperative; `src/lib/googleMaps.js` script loader +
`@googlemaps/markerclusterer`). Key in `VITE_GOOGLE_MAPS_API_KEY` (public, referrer-
restricted; no key → "Map unavailable" overlay). *(Earlier docs said Leaflet/OSM — the
page was migrated to Google Maps; this section is the source of truth.)* **Read-only**;
plan/unplan lives on `/routing` (links there from the header).
- `api.Marker` per stop with valid `latitude`/`longitude`; circle symbol colored by status
  bucket (shared `src/lib/statusColors.js`); clustered via MarkerClusterer.
- `map.fitBounds()` re-fits to the **currently visible (filtered)** markers when the
  filtered set changes. Empty-state overlays.
- `InfoWindow` (DOM node) shows name, address, ETA (12h), appt, status, Non-Uline Rev,
  and a Street View button (opens the embedded panorama).
- **Status filters** + **flag filters** (appt/liftgate/restriction/unflagged) + **driver
  filter** — all `.filterchip`/`<select>`, reusing `STATUS_FILTERS`/`matchesStatusFilter`
  + parsed comment flags; counts are of *mapped* stops; filters AND together.
- React 18 StrictMode guard: map instance + InfoWindow + clusterer held in refs; second
  init is a no-op; refs dropped on unmount so a remount re-creates.
- Mock mode: fixture stops have lat/lng, so the map renders without credentials.

## Routing page (v0.17.0) — local-first plan/unplan

`/routing` — a **local-first** plan/unplan workspace (`.routing__grid--nomap`: left
controls · right Orders/Selected/Loads rail; no map, since we hold no coordinates without
a read). The board is built **entirely from local state** — the created-orders registry +
the hardcoded `KNOWN_LOADS` — so it makes **zero** API calls until you Plan or Unplan.
- **Orders tab** = the created-orders registry (checkboxes; each carries its `stopId`).
  **Selected** = sortable table of the selection. **Loads** = `KNOWN_LOADS` + any load our
  orders are planned onto, with a count of our orders on each; click to set the Plan target.
- `<PlanBar>` (left): tally, inline UAT creds (`useWriteCreds`), a **typeable target-load**
  field (datalist of known loads, any UAT load # works), and **Plan →** / **Unplan**.
- **Plan** = resolve target `loadId` (from `KNOWN_LOADS`, else the `dd_loadid_cache`, else
  one `getLoad` cached forever) → `insertStops(loadId, stopIds)` → mark orders planned in the
  registry. **Unplan** = group selected planned orders by `loadNbr` → `removeStops` per load →
  mark unplanned. No refetch (the registry is the source of truth). Every call hits the
  counter pill.
- Created orders carry `stopId` from their create response, so Plan/Unplan need **no**
  `getStop`. (The earlier map/watchlist/box-lasso version is gone; `SelectionDraw`,
  `useWatchedLoads`, `statusColors` remain in the tree but are unused by `/routing` now.)

## Print manifest (v0.6.1)

Driver and Stops pages have a **Print** button (`.tool-btn .print-btn`) in the
`.tools-row` next to the Export CSV button. `window.print()` triggers the browser
print dialog. A `@media print` block in `src/index.css` produces a clean
white-background / black-text document:

- Hidden on print: `.topbar, .datenav, .rail, .bottom-nav, .tools-row, .filterbar,
  .filterpanel, .stops__controls, .build-badge, .pill--mock, .driver-back,
  .driver-group__day-link, .sortpills, .pager, .export-btn, .tool-btn, .legend`
  and any `.no-print` element.
- `.print-only` (display:none on screen) shows a header block with "Davis Dispatch
  — Driver/Stops Manifest", driver name, date, and counts.
- `.stopcard` prints as a white bordered block with `break-inside: avoid`;
  `.chip` elements are outlined labels; `.wb-seq` is a black-bordered circle.
- `.driver-summary` / `.driver-stat` render as light-bordered stat boxes.
- On-screen UI is completely unchanged — all print rules are scoped to
  `@media print {}` or the normally-hidden `.print-only` block.

`PrintButton` lives in `src/components/PrintButton.jsx` (presentational, no props).

## Comment parser (the keystone)

`src/lib/parseStopComments.ts` is a PURE module turning NuVizz `SPL-INSTR-TEXT`
free text into chips + an advisory receiving window + Non-Uline Rev, without ever
dropping the operator's verbatim words (raw → flags → `other[]`). Receiving hours
are ADVISORY ONLY (`RECEIVING_HOURS_HARD = false`). Tests: `npm test`.
