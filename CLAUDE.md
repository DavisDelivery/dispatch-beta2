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
  components/         # Layout, BuildBadge, SortableTh, SortPills, StopChips,
                      #   StopCard, ComingSoon
  hooks/              # useSortableTable
  lib/                # format, parseStopComments(.ts) + tests, stopView,
                      #   loadsModel, nuvizzApi (client data access)
  pages/              # Dashboard, Loads, Stops (built); Workbench (stub)
netlify/functions/
  nuvizz.cjs          # GET endpoint: ?path=__fleet|__fleetstops|__driver|
                      #   __refreshLoad (the only HTTP surface)
  lib/nuvizz.cjs      # NuVizz v7 read client (read-only; stateless HTTP Basic;
                      #   live range-scan discovery; no Firestore)
public/test-fixtures/ # nuvizz-today-loads.json (mock-mode fixture: loads+stops)
```

## Mock vs live

- `VITE_USE_MOCK_NUVIZZ=true` → pages render the bundled loads fixture, no creds
  needed (first deploy preview + `npm run dev`). Handled client-side in
  `src/lib/nuvizzApi.js`; the function is never called.
- `VITE_USE_MOCK_NUVIZZ=false` + the `NUVIZZ_*` server vars → live NuVizz data
  via `GET /.netlify/functions/nuvizz?path=…`.

## Comment parser (the keystone)

`src/lib/parseStopComments.ts` is a PURE module turning NuVizz `SPL-INSTR-TEXT`
free text into chips + an advisory receiving window + Non-Uline Rev, without ever
dropping the operator's verbatim words (raw → flags → `other[]`). Receiving hours
are ADVISORY ONLY (`RECEIVING_HOURS_HARD = false`). Tests: `npm test`.
