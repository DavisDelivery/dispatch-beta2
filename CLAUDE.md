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

## Layout map

```
src/
  main.jsx            # React + router bootstrap
  App.jsx             # routes
  version.js          # APP_VERSION + build identity (badge)
  index.css           # mobile-first styles (single 768px breakpoint)
  components/         # Layout (nav shell), BuildBadge, SortableTh, ComingSoon
  hooks/              # useSortableTable
  lib/                # format, stopsApi, stopColumns
  pages/              # Dashboard, Workbench, Loads (stubs), Stops (built)
netlify/functions/
  stops.cjs           # GET endpoint -> normalized stops (the only HTTP surface)
  lib/nuvizz.cjs      # NuVizz v7 read client (shared code; read-only; direct-live)
public/test-fixtures/ # nuvizz-today-stops.json (mock-mode fixture)
```

## Mock vs live

- `VITE_USE_MOCK_NUVIZZ=true` → Stops renders the bundled fixture, no creds
  needed (used for the first deploy preview and for `npm run dev`).
- `VITE_USE_MOCK_NUVIZZ=false` + the `NUVIZZ_*` server vars → Stops shows live
  NuVizz data via `GET /.netlify/functions/stops`.
