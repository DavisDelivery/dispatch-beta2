# RESEARCH — M5.2 (Polyline Ordering Fix + Stop-to-Route Navigation)

Target: v0.11.6 · Branch: `claude/dispatch-map-m5.2-route-polylines-fix`

## P1.2 — Current polyline implementation

- **Route data source:** computed entirely **client-side** from the already-loaded `stops`
  array (the Firestore stop-index reader's payload). There is no separate
  `nuvizz-routes` endpoint involved — the M5 brief proposed one, but the live code
  groups loaded stops by `loadNbr` at `dispatch-map/src/App.jsx:3816-3846` (`routeData`).
- **Grouping:** every positioned stop (lat/lng + loadNbr + driverUserName) is bucketed by
  `loadNbr` into a `loadGroups` Map (`App.jsx:3818-3830`).
- **Per-group ordering (THE BUG):** `App.jsx:3834` sorts by
  `(a.loadStopSeq ?? 0) - (b.loadStopSeq ?? 0)`. `loadStopSeq` comes from
  `nuvizz-scan.mts:127` and traces back to the scan's enrichment at
  `nuvizz-scan.mts:236-239` where each stop is tagged
  `load: { ..., stopSeq: i }` — i.e. the stop's **array index** in NuVizz's
  `Load.stops` response. NuVizz returns those stops in creation/import order, NOT
  delivery order, so the sort produces a non-route-shaped sequence.
- **Polyline render:** one straight-line `google.maps.Polyline` per *loadNbr* group at
  `App.jsx:3936-3957` — `strokeWeight 3`, `strokeOpacity 0.7`, `zIndex 1`, color from
  `routeColorFor(driverUserName)` (deterministic djb2 palette, 16 colors, `App.jsx:117-122`).
- **Driver color separation:** working — same driver across multiple loads shares a color
  (legend aggregates per driver at `App.jsx:3839-3844`). Two drivers' paths can cross visually
  but their colors are distinct.

## P1.3 — Is `loadStopSeq` reliable?

**No.** Per `RESEARCH-parent-app-audit.md` §7 ("Known quirks"):
> `stopSeq` is unreliable — it's almost always `1`. Driver-day ordering uses
> `plannedEtaDTTM` instead, with a synthetic `displaySeq` assigned post-sort
> (parent `nuvizz.cjs:1086-1099`).

The dispatch-map scan side-steps the raw `1`-everywhere problem by substituting the array
index (`nuvizz-scan.mts:238`) — but NuVizz's array order is creation/insert order, not the
actual driver delivery sequence. **This is the chaos Chad sees.** The parent app's
canonical fix is to **order by `plannedEtaDTTM`** (with `loadStopSeq` as a tiebreaker for
nulls). That field lives at `raw.stopExecutionInfo.to.plannedEtaDTTM` on every planned
stop and was confirmed populated in 5/27 live data (M5.1 audit).

## P1.4 — Fix plan

1. **Server normalizer** (`nuvizz-scan.mts`): expose `plannedEtaDTTM` as a top-level field
   on the normalized stop (alongside `arrivalDTTM` / `deliveredDTTM` shipped in M5.1).
   Pure additive — no schema break.
2. **Polyline ordering** (`App.jsx:3834`): sort each load's stops by
   `plannedEtaDTTM` ascending; nulls go to the end; tiebreaker `loadStopSeq` then `stopNbr`.
   Mirrors `parent nuvizz.cjs:1089-1096`.
3. **Stop → Route navigation:**
   - In `StopSidebar` (desktop) and `StopInfoTabContent` (mobile), add a "Route" section:
     loadNbr + driverName + "View full route" button. For unplanned stops (no `loadNbr`)
     show "Not yet assigned" (matches existing M5 behavior).
   - New `selectedRoute` state (loadNbr or null) in `MapScreen`.
   - New `RouteDetailPanel` (desktop sidebar) and `MobileRouteDetailDrawer` (mobile
     bottom-sheet) that:
     - Receives the stops for that loadNbr (already in `stops`), sorts them by
       `plannedEtaDTTM`, renders each as a row with `<StatusBadge>` + delivery time +
       PRO + business name.
     - Row click → close route view, set `selectedStop`, pan + zoom to the stop.
   - Polyline highlight: in the polyline effect, when `selectedRoute === route.loadNbr`,
     render with `strokeWeight: 6, strokeOpacity: 1, zIndex: 3`; other routes drop to
     `strokeOpacity: 0.25` so the highlighted route stands out without hiding context.
4. **Mobile:** the route drawer reuses the existing `BottomSheet` primitive (the same
   pattern as `MobileStopDetailDrawer`); when `selectedRoute` is set we render the route
   drawer in place of (or above) the stop drawer.

No data-layer changes other than the additive `plannedEtaDTTM` field; the polyline +
navigation work is purely client-side.
