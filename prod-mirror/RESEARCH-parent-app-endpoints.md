# P1 — Parent App Forensics

**Date:** 2026-05-22
**Scope:** Identify the parent app patterns that resolve Problem A (PROs missing) and Problem B (routes missing). Problem C (M2.1 scanner) deferred — see [RESEARCH-m21-regression.md](./RESEARCH-m21-regression.md).

## Parent app layout

- Framework: React + Vite + Tailwind. Single SPA, screens under `src/screens/`.
- NuVizz API wrapper: `src/lib/api.js` (a thin proxy that hits `netlify/functions/nuvizz.cjs` with `?tenant=<x>&path=<y>`).
- Normalization: `src/lib/normalize.js`.
- The single NuVizz Netlify function: `netlify/functions/nuvizz.cjs` (1342 lines, owns auth, scanning, caching, Firestore mirror).

All NuVizz calls go through one server-side function with internal "virtual paths" (`__fleet`, `__driver`, `__fleetstops`, `__lookup`, etc.). Native NuVizz endpoints (`/load/info/...`, `/stop/info/...`) are called only from inside `nuvizz.cjs`.

## Endpoint inventory

| # | Endpoint (NuVizz native) | Method | Notes | Used by (parent app file) |
|---|---|---|---|---|
| 1 | `https://portal.nuvizz.com/deliverit/openapi/v7/load/info/{loadNbr}/{companyCode}` | GET | Basic auth. Returns `{ Load: { loadHeader, loadAssignment, loadExecutionInfo, stops:[…] } }`. | `nuvizz.cjs:probe()` used inside `__fleet`, `__fleetstops`, `__driver`, `__refreshFleet`, `__refreshLoad`, `__lookup`. Dispatch-map already mirrors this in `nuvizz-pull-today-stops.mts:scanLoadRangeForDate()` and `nuvizz-driver-route.mts:buildRouteFromLoadScan()`. |
| 2 | `https://portal.nuvizz.com/deliverit/openapi/v7/stop/info/{stopNbr}/{companyCode}` | GET | Basic auth. Single stop detail. | `nuvizz.cjs:fetchStop()`, parent screens via `fetchStop` in `api.js`. |
| 3 | `https://portal.nuvizz.com/deliverit/openapi/v7/stop/etainfo/{companyCode}?stopNbr=…` | GET | ETA detail per stop. | Parent `fetchStopETA`. |
| 4 | `https://portal.nuvizz.com/deliverit/openapi/v7/stop/eventinfo/{companyCode}?stopNbr=…` | GET | Event log per stop. | Parent `fetchStopEvents`. |
| 5 | `https://portal.nuvizz.com/deliverit/openapi/v7/user/info/{userName}/{companyCode}` | GET | Driver/user record. Used to discover the DAVIS_DRIVERS registry. | Not called at runtime — registry baked into `src/lib/api.js`. |

The parent's "fleet scan" technique (probe a load-number range in parallel, anchor on a known date+loadNbr, filter by `earliestStartDttm`) is already mirrored in `dispatch-map/netlify/functions/nuvizz-pull-today-stops.mts`. No new native endpoints to discover.

## PRO extraction — the answer

### What the brief assumed

PROs live at `stop.proNumber` and are 9-digit zero-padded numbers (e.g., `007122719`).

### What the live response actually contains

I probed `https://dd-dispatch-map.netlify.app/.netlify/functions/nuvizz-pull-today-stops?date=2026-05-22` (648 stops in production). Per-stop fields with PRO-like content:

| Field | Sample value | Meaning |
|---|---|---|
| `stop.stopNbr` | `"007122719"` | **The 9-digit identifier dispatchers call a "PRO".** Always present, always 9 digits. |
| `stop.shipmentNbr` | `"007122719"` | Always equals `stopNbr`. Redundant. |
| `stop.proNumber` | `"G1"`, `"G6"` | A delivery-type **code**, not a number. Two characters. |
| `stop.reference1` | `"#2D-21293354"`, `"P297659"` | Uline 2D barcode / PO. |
| `stop.reference2` | `"19851899"`, `"888946"` | Uline order number. |

So the field NuVizz calls `proNumber` is *not* what dispatchers call a PRO. The actual PRO is `stopNbr`. Parent app implicitly knows this — `src/screens/StopDetail.jsx:152` and `src/screens/Dashboard.jsx:339` both display `s.nbr` (which `normalize.js` maps from `stop.stopNbr`) as the user-facing identifier.

### Multi-PRO case

The brief's "+N" display assumes some stops have multiple PROs. The live data does **not** have multiple `stopNbr`s per stop (1:1). There is, however, a related phenomenon: **multiple stops can share the same address.**

In today's data (648 stops, 612 unique addresses):
- 582 addresses have 1 stop
- 25 have 2 stops
- 4 have 3 stops
- 1 has 4 stops

Example: VINCENT BONZO has 3 separate stops at INTERROLL ATLANTA LLC, each with its own `stopNbr` (007122987, 007123227, 007123289). Each is one delivery with its own PRO; they share a delivery point.

**Decision for this PR:** keep one row per stop (one PRO per row). Implement `pros: [stopNbr]`, `primaryPro: stopNbr`, `proCount: 1` for forward compatibility with the brief's UI shape, but the `+N` display path will never fire on this data. Future enhancement could roll up by address, but that's a separate UX decision.

### Port plan

In `dispatch-map/netlify/functions/nuvizz-pull-today-stops.mts:normalizeStop()`:

```typescript
// BEFORE
pro: normalizePro(stop.proNumber),

// AFTER
const stopNbr = stop.stopNbr ?? null;
const pros = stopNbr ? [stopNbr] : [];
return {
  pro: stopNbr,           // kept for back-compat with existing PRO column
  pros,                   // new — array per brief
  primaryPro: stopNbr,    // new — first PRO per brief
  proCount: pros.length,  // new — count per brief
  ...
};
```

No N+1 follow-up calls needed: PROs are already on the load-info response.

## Route assignment extraction — the answer

### Parent app pattern

`netlify/functions/nuvizz.cjs:952` (`__driver` handler):
1. Client passes `userName` (e.g., `"VINCENT"`) — the stable Motive-independent driver code.
2. Server reads the shared `__fleetCache` for today's fleet (populated by the load-number scan).
3. Filters loads where `loadAssignment.driverUserName === userName`.
4. Returns the matching loads + their stops.

The key field is **`loadAssignment.driverUserName`** — a stable code that matches the parent's `DAVIS_DRIVERS` registry (`src/lib/api.js:99-134`).

### What dispatch-map does today

`dispatch-map/netlify/functions/nuvizz-driver-route.mts:105`:

```typescript
if (loadDriver.toLowerCase().trim() === driverName.toLowerCase().trim()) { ... }
```

Where `loadDriver = a.driverName` (from NuVizz) and `driverName` is the value passed from Motive via the client.

### Why it returns no routes

Live data shows `loadAssignment.driverName = "VINCENT  BONZO"` (two spaces). Motive presumably sends `"Vincent Bonzo"` (one space). After lowercase+trim, `"vincent  bonzo" !== "vincent bonzo"` — internal whitespace is not collapsed by `.trim()`. Match fails.

This is consistent with Chad's "No route assigned today" symptom for every driver — the NuVizz formatting is just inconsistent enough to break exact equality across the board.

### Port plan

In `dispatch-map/netlify/functions/nuvizz-driver-route.mts`:

1. Accept an optional `userName` query param (in addition to existing `driver` and `truck`).
2. Bake the parent's `DAVIS_DRIVERS` registry (`src/lib/api.js:99-134`) into dispatch-map. Resolve `driver` (full name) → `userName` via the registry.
3. When matching NuVizz loads, prefer `loadAssignment.driverUserName === userName` (exact). Fall back to normalized-name compare (lowercase, collapse all internal whitespace, trim).
4. App.jsx already passes `driver.driverName` from Motive — keep that param. Add a registry-backed lookup so we can resolve to userName even if the client doesn't send it.

This mirrors the parent app's matching logic and removes the whitespace-sensitivity bug.

## SPL-INSTR-TEXT extraction — out of scope

Deferred with the M2.1 scanner work per [RESEARCH-m21-regression.md](./RESEARCH-m21-regression.md). For the record:
- Parent app has no SPL-INSTR-TEXT references (the scanner only ever lived on the unmerged `claude/dispatch-map-m2.1-scanner` branch).
- The live `/load/info/` response does carry `stop.from.address.addr2` and `stop.to.address.addr2` (where free-form instructions like "ATTN JB BERNARD" live), and `stop.comments` (frequently empty). The M2.1 branch scanned `addr2` plus a `SPL-INSTR-TEXT` field that we have not located in the current response shape.

When the scanner PR is revived, repeat this probing exercise against current live responses to confirm the field still exists.

## Other findings worth recording

- **Shared cache opportunity:** `nuvizz-driver-route.mts` re-runs the full ~500-load scan every time a driver sidebar is opened. The parent app shares one `__fleetCache` across `__fleet`, `__fleetstops`, and `__driver`. Adopting the same pattern in dispatch-map would drop per-driver-open latency from ~10s to ~50ms after the first scan of the day. **Out of scope for M4.2** but documented as a follow-up.
- **31 stops have null `driverName`** in today's data (617/648 have one). Not a bug — those loads are unassigned. The driver-route function will correctly return no route for unassigned drivers.
- **Netlify deploy:** Per Chad, prod is currently serving from a non-`main` branch (the M2.1 branch). M4.2 will need a deploy alias re-point before its changes are visible in prod.
