# RESEARCH — M5.1 (Stop Status Visual + Filter Toolbar Restoration)

Target: v0.11.1 · Branch: `claude/dispatch-map-m5.1-status-and-filters`

## P1.2 — Stop status field audit

### Where status comes from
- Scan normalizer: `netlify/functions/lib/nuvizz-scan.mts` → `normalizeStop(raw)`.
  - `status: exec.stopStatus || stop.status || null` (line ~129) — the raw NuVizz code, preserved as a string.
  - `isPlanned: !!loadNbr` (line ~149) — true when the stop is attached to a load (routed); false for board / number-space stops.
  - `raw` is preserved in full (rule #5), so the client can reach `raw.stopExecutionInfo`.
- An older keyword matcher `normalizeStopStatus()` exists in `nuvizz-driver-route.mts` but it maps free-text driver-route statuses, not the numeric scan codes — separate concern, left untouched.

### Status codes observed in REAL data (date=2026-05-27, 669 stops, source=firestore)
| code | count | isPlanned | meaning |
|------|-------|-----------|---------|
| `10` | 566   | false     | Created / board stop, not yet routed → **UNPLANNED** |
| `20` | 103   | true      | Assigned / planned, not yet en route → **SCHEDULED** |

No `30 / 40 / 50 / 90` are present: at scan time the day's stops are not yet executed, so `stopExecutionInfo.to` only carries `plannedEtaDTTM` / `etaCode` (no actual arrival or completion timestamps). The executed-state mapping below is therefore coded to the NuVizz API guide + the `nuvizz-driver-route.mts` precedent, but could NOT be verified against live executed data for 5/27.

### Canonical status mapping (implemented in `classifyStopStatus`)
Evaluated most-progressed first:
```
DELIVERED    stopStatus == 90  OR  a completion/confirm timestamp present
EXCEPTION    stopStatus == 50
ARRIVED      stopStatus == 40  AND an arrival timestamp present
OUT_FOR_DEL  stopStatus == 40  (no arrival timestamp yet)
UNPLANNED    isPlanned === false        (board stops; observed code 10)
SCHEDULED    default — planned & not en route (observed code 20; also 10/30)
```
Timestamp probes are defensive (`exec.arrivalDTTM | exec.arrivalDttm | exec.to.arrivalDTTM`, etc.) because the live field name for executed stops is unconfirmed in current data.

### isPlanned vs stopStatus
Independent signals. `isPlanned` = has a load assignment (routing); `stopStatus` = execution lifecycle. UNPLANNED is keyed off `isPlanned=false` (not a status code) because board stops keep code 10 until they are routed.

## P1.3 — Filter Toolbar State

### Root cause: NOT removed; fragile absolute offset / overlap, not a media-query bug
- `FilterToolbar` (App.jsx ~1458) is intact with all five toggles: Hide terminal, Hide stem out, Show unplanned, Show vehicle location, Show clustered.
- It is mounted in the **desktop** branch of `MapScreen` (App.jsx ~4321). `MapScreen` early-returns a separate mobile layout when `isMobile` (`viewportWidth < 768`), so the toolbar is already desktop-only by control flow.
- `useViewportWidth()` initialises to `window.innerWidth` on the client — so `isMobile` is correctly false on desktop. There is **no** viewport-detection / media-query defaulting bug.
- The real fragility: the toolbar is `position:absolute; top:64px; right:16px; z-index:5`, sitting flush beneath the M5 top-right control stack (status pill + Routes toggle) at `top:12px; right:12px; z-index:6`. The pill's height varies with its content (stop count + freshness line); when it grows it overlaps and visually buries the toolbar header, since the stack paints above it. This is the same "overlapping map controls" class of issue that PR #22 partially addressed.
- On mobile the five toggles live in `MobileFiltersTab` inside the bottom drawer's Filters tab (App.jsx ~4137) — present, but not surfaced as a floating toolbar.

### Fix approach (P3)
Restructure the desktop top-right controls into a single right-aligned vertical column (status pill row → toolbar) so positions are deterministic and can never overlap, and move the **Show Routes** toggle into the FilterToolbar toggle list (route polylines shipped in M5). This guarantees the toolbar is visible top-right on desktop without magic pixel offsets.

### NOTE on UI verification
No headless browser or `VITE_GOOGLE_MAPS_API_KEY` is available in this environment, so changes are verified by code inspection + production build, not a live browser session.
