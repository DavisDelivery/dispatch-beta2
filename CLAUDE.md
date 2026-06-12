# CLAUDE.md — agent operating notes

Operating notes for any agent (or human) working in this repo.

## Workflow

- **Branch → draft PR → Chad squash-merges.** The connector/agent does NOT merge.
  Do all work on a feature branch, open a **draft** PR against `main`, and stop.
  Chad tests the Netlify deploy preview (on a phone) and squash-merges.
- **CI green ≠ UI works.** A passing build only means it compiled. The real
  gate is Chad exercising the deploy preview against the on-preview test script
  (see the brief / PR body). Don't claim a feature works because the build is green.
- **Bump `APP_VERSION` + the build badge on every functional change.**
  `APP_VERSION` lives in `src/version.js`; the badge renders it with the
  7-char commit and environment on every page. The version is how Chad knows the
  preview he's looking at is the one he just pushed.

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
  pages/              # Dashboard, Loads, Stops, Workbench, Driver, Map (all built)
                      #   Driver (/driver/:userName) — focused single-driver day view:
                      #     loads + ordered stop sequence via fetchDriver; reachable from
                      #     the "View day ›" link in each Workbench driver-group header
                      #   Map (/map) — day's stops plotted on a Leaflet/OSM map;
                      #     L.circleMarker per stop, coloured by status bucket;
                      #     fitBounds to visible markers; popup with name/addr/ETA/status
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

## Map page (v0.7.0)

`/map` — Leaflet 1.9.4 (imperative API, no react-leaflet) with OpenStreetMap tiles.
- `L.circleMarker` per stop with valid `latitude`/`longitude`; colored by status bucket
  (same hex palette as the stopcard status CSS).
- `map.fitBounds()` frames all markers; popups show name, address, ETA (12h), appt, status,
  and Non-Uline Rev (via `buildStopView`).
- Tile source: `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`
  (OSM tiles only — no NuVizz or proprietary map assets).
- Leaflet CSS is imported in `Map.jsx` (not `index.css`) so Vite bundles it correctly.
- React 18 StrictMode guard: the map instance is held in a `useRef`; a second init call
  is a no-op; `map.remove()` + null on unmount.
- Mock mode: all 11 fixture stops have lat/lng, so the map renders without credentials.

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
