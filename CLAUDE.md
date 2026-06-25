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
  hooks/              # useSortableTable, useSelectedDate, useWriteCreds (shared
                      #   UAT creds in sessionStorage 'dd_write_creds')
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

## Created-orders registry (v0.15.0)

`src/lib/createdOrders.js` (+ `useCreatedOrders` hook) — a localStorage list
(`dd_created_orders`) of orders we've created in UAT, each carrying its `stopId`.
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

## Routing page (v0.16.0) — watchlist plan/unplan (UAT, no read-fn dependency)

`/routing` — dedicated workspace mirroring the davis-nuvizz Routing layout: **left
controls · center map · right Orders/Selected/Loads rail** (`.routing__grid`; on mobile the
map stacks first via grid-areas). The board is **driven entirely by the gated write
function** (`getLoad`/`getStop`/`insertStops`/`removeStops`; UAT-only, `NUVIZZ_WRITE_ENABLED`)
— **no read function / scan / mock**. So it works on UAT as soon as creds are entered,
independent of any read-fn redeploy. Phase 1 = plan/unplan; route optimizer is the next layer.
- **Board = created orders + watched loads.** `useWatchedLoads` (localStorage
  `dd_watched_loads`) is the set of load #s on the board; any load an order is planned onto
  is auto-watched. Each watched load is read live: `getLoad` → its stops, each enriched by
  `getStop` (name/city/coords, so they can map + be selected). Refetched after every action.
- **Select** stops: click a marker to toggle; **＋ In view** (map bounds); **▱ Box**
  (drag); **⬠ Lasso** (draw). Selected markers enlarge + gain a light ring; Esc cancels.
- Geometry is the pure, tested `src/lib/routingSelect.js` (`pointInPolygon`,
  `latLngInBounds`, `boxFromCorners`, `stopKey`) — ported from davis-nuvizz. Screen-pixel→
  LatLng uses an invisible `OverlayView.getProjection()` (`fromContainerPixelToLatLng`,
  exact even when tilted). The draw overlay is `src/components/SelectionDraw.jsx`.
- **Two selectable sources** funnel into one selection: (1) **created orders** (Orders tab;
  carry their `stopId`) and (2) **watched-load stops** (Loads tab + map markers, when
  geocoded). Keys: orders `order|stopNbr`, load stops `load|loadNbr|stopNbr`. Box/lasso/
  in-view select geocoded markers; the geometry is the pure `src/lib/routingSelect.js`.
- `<PlanBar>` (left): selection tally, inline UAT creds bar when missing (`useWriteCreds` →
  sessionStorage `dd_write_creds`, shared with Builder), a **typeable target-load** field
  (datalist of watched loads, but any UAT load # works), and **Plan →** / **Unplan**.
- `<RoutingPanel>` (right rail): **Orders** tab = created-orders registry (checkboxes);
  **Selected** tab = sortable table of the selection with remove; **Loads** tab = the
  watchlist — add a load #, see its live stops, check stops to unplan/move, click the
  header to set the Plan target, × to stop watching.
- **Plan** resolves the target load # → `loadId` (from a watched load, else `getLoad`),
  `insertStops` the selection's `stopId`s once, marks planned orders + auto-watches the
  target. **Unplan** groups by current load and `removeStops` per load. Both refetch the
  watched loads (`tick`) and clear the selection.
- Selection keys on `loadNbr|stopNbr` (`stopKey`). Marker rebuild (on data change) and
  selection restyle are separate effects so toggling never re-fits the map; both read
  selection via a ref to avoid rebuild churn. Shared colours: `src/lib/statusColors.js`.

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
