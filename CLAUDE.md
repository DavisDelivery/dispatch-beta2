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
                      #   Map (/map) — day's stops plotted on a GOOGLE map;
                      #     api.Marker per stop, coloured by status bucket; clustered;
                      #     fitBounds to visible markers; InfoWindow w/ name/addr/ETA +
                      #     Street View; Plan mode = box/lasso/in-view select -> plan/unplan
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

## Mock vs live

- `VITE_USE_MOCK_NUVIZZ=true` → pages render the bundled loads fixture, no creds
  needed (first deploy preview + `npm run dev`). Handled client-side in
  `src/lib/nuvizzApi.js`; the function is never called.
- `VITE_USE_MOCK_NUVIZZ=false` + the `NUVIZZ_*` server vars → live NuVizz data
  via `GET /.netlify/functions/nuvizz?path=…`.

## Map page (Google Maps; Plan mode v0.13.0)

`/map` — **Google Maps JS API** (imperative; `src/lib/googleMaps.js` script loader +
`@googlemaps/markerclusterer`). Key in `VITE_GOOGLE_MAPS_API_KEY` (public, referrer-
restricted; no key → "Map unavailable" overlay). *(Earlier docs said Leaflet/OSM — the
page was migrated to Google Maps; this section is the source of truth.)*
- `api.Marker` per stop with valid `latitude`/`longitude`; circle symbol colored by status
  bucket (same hex palette as the stopcard status CSS); clustered via MarkerClusterer.
- `map.fitBounds()` re-fits to the **currently visible (filtered)** markers when the
  filtered set changes; selection restyle does NOT re-fit. Empty-state overlays.
- `InfoWindow` (DOM node) shows name, address, ETA (12h), appt, status, Non-Uline Rev,
  and a Street View button (opens the embedded panorama).
- **Status filters** + **flag filters** (appt/liftgate/restriction/unflagged) + **driver
  filter** — all `.filterchip`/`<select>`, reusing `STATUS_FILTERS`/`matchesStatusFilter`
  + parsed comment flags; counts are of *mapped* stops; filters AND together.
- React 18 StrictMode guard: map instance + InfoWindow + clusterer + projection overlay
  held in refs; second init is a no-op; refs dropped on unmount so a remount re-creates.
- Mock mode: fixture stops have lat/lng, so the map renders without credentials. (Plan
  mode writes are disabled in mock — UAT only.)

### Plan mode (v0.13.0) — map-driven plan/unplan

A **"✋ Plan mode"** toggle (in the driver row) turns the read-only map into a write
surface that drives the existing gated NuVizz write function (`nuvizz-write.cjs`;
UAT-only, `NUVIZZ_WRITE_ENABLED`). Read paths and the warm cache are untouched.
- **Select** stops three ways: click a marker to toggle; **＋ In view** (current map
  bounds); **▱ Box** (drag a rectangle); **⬠ Lasso** (draw a shape). Selected markers
  enlarge + gain a light ring. Esc cancels an armed draw tool.
- Geometry is the pure, tested `src/lib/routingSelect.js` (`pointInPolygon`,
  `latLngInBounds`, `boxFromCorners`, `stopKey`) — ported from the davis-nuvizz routing
  tool. Screen-pixel→LatLng uses an invisible `OverlayView.getProjection()`
  (`fromContainerPixelToLatLng`, exact even when tilted) held in `projectionRef`.
- `<PlanBar>` (`src/components/PlanBar.jsx`) shows the selection tally (skids/loose/
  weight), an inline UAT creds bar when missing (shared via `useWriteCreds` →
  sessionStorage `dd_write_creds`, same as Builder), a **target-load** `<select>`
  (distinct loads derived from the day's stops; carries `loadId`), and **Plan →** /
  **Unplan** buttons.
- **Plan** resolves each selected stop's `stopId` (now on the read shape — see below —
  else a `getStop` fallback) and calls `insertStops(creds, targetLoadId, stopIds)` once.
  **Unplan** groups the selection by current `loadNbr` and calls `removeStops` per load
  (`load/edit` full-header echo). After either, it refetches stops and clears selection.
- **`stopId` on the read shape:** `normalizeStop` in `netlify/functions/lib/nuvizz.cjs`
  now emits `stopId`, so map stops carry it and plan/unplan needs no extra reads.
- Selection keys on `loadNbr|stopNbr` (`stopKey`) since coords aren't unique. Marker
  rebuild (on filter change) and selection restyle are separate effects so toggling a
  selection never re-fits the map; both read plan state via refs to avoid rebuild churn.

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
