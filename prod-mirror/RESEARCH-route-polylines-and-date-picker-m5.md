# M5 Research — Route Polylines + Date Picker

Branch: `claude/dispatch-map-m5-route-polylines-and-date-picker`
Date of research: 2026-05-24

## CRITICAL FINDING — the route endpoint in the brief does not exist

The brief states:

> The route endpoint was discovered in M4.2 and is already in use for the driver day-snapshot sidebar:
> `GET /route/list/customer/DAVIS?date=YYYY-MM-DD`

This is **not accurate**. A repo-wide search finds **zero** references to
`/route/list/customer` anywhere — not in `dispatch-map/`, not in the parent
`davis-nuvizz` app, not in any function, component, or doc:

```
grep -rn "route/list/customer" .   # (excluding node_modules) → no matches
grep -rn "/route/"             .   # → no matches in any source file
```

### What M4.2 actually built

`dispatch-map/netlify/functions/nuvizz-driver-route.mts` powers the driver
day-snapshot. It does **not** call a route endpoint. It derives a single
driver's route by **scanning the load-info endpoint** — the same load-number
range probe that `nuvizz-pull-today-stops.mts` uses:

- Endpoint actually used (VERIFIED, cited): `GET /load/info/{loadNbr}/{company}`
  - `nuvizz-driver-route.mts:172` — `${NUVIZZ_BASE}/load/info/{loadNbr}/{company}`
  - `nuvizz-pull-today-stops.mts:196` — same endpoint
- Mechanism: probe load numbers `center ± 250` (anchor 192900 @ 2026-04-22,
  ~80 loads/day), filter by `loadHeader.earliestStartDttm` date, then match
  `loadAssignment.driverUserName` (preferred) or `loadAssignment.driverName`.
- `nuvizz-driver-route.mts:238-240` even has a standing comment:
  > "Use the first load's loadNbr as a stand-in 'route id' **until the real
  > route endpoint is wired**."

So the "route endpoint" was never wired. Routes are a load-scan artifact.

## The route data is ALREADY client-side (M4.4)

M4.4 (this session's earlier work) added per-stop route-join fields to the
normalized stop shape in `nuvizz-pull-today-stops.mts`:

- `stopNbr` — 9-digit PRO string (the join key, fixed in M4.2)
- `loadNbr` — e.g. `DAVIS000195190`
- `loadStopSeq` — 0-based position within the load's stop array
- `driverUserName` — stable driver code (e.g. `HEAD`, `VINCENT`)
- `lat` / `lng` — coordinates

Verified against live data for 2026-05-22 (a weekday with deliveries):

```
GET /.netlify/functions/nuvizz-pull-today-stops?date=2026-05-22
→ 624 stops, 624 with driverUserName, 624 with loadStopSeq, 47 distinct drivers
sample: {stopNbr:"007122719", loadNbr:"DAVIS000195190", loadStopSeq:0,
         driverUserName:"HEAD", lat:34.11543, lng:-84.20188}
```

**Implication:** route polylines can be drawn entirely client-side by grouping
the already-fetched stops list — no new endpoint, no new Netlify function, no
second NuVizz round-trip. This is faster (one fetch already paid for stops) and
avoids inventing an endpoint (which Standing Rule #7 forbids).

### Nuance — drivers can have multiple loads per day

Sample driver `HEAD` on 2026-05-22 had 8 stops with `loadStopSeq`
`[0,1,2,3,4,0,1,2]` — i.e. **two loads** (sequence restarts at 0 per load).
So per-driver polylines must group by `loadNbr` first (each load = one ordered
path segment), then optionally color all of a driver's segments with that
driver's color. Drawing a single line across both loads in raw seq order would
zig-zag incorrectly (two seq-0 stops).

## Date handling audit

- `nuvizz-pull-today-stops.mts`: accepts `?date=YYYY-MM-DD`, defaults to
  `todayUTC()` (`new Date().toISOString().slice(0,10)`) when absent.
- `nuvizz-driver-route.mts:306`: accepts `?date=`, defaults to `todayUTC()`.
- `motive-driver-positions.mts`: live GPS only — no date param (Motive returns
  current position only; meaningless for non-today).
- **"Today" is currently computed UTC, not ET.** Standing Rule #11 requires
  America/New_York. At 00:00–04:59 ET, UTC is already tomorrow, so the current
  default can show the wrong day overnight. M5 must centralize a `todayInET()`
  util and have the **client** send an explicit ET date on every fetch.

## Decision (confirmed by Chad)

Chad confirmed the parent mobile app "shows drivers' routes once they're built"
— and indeed the parent's `src/screens/MapScreen.jsx` is the reference
implementation. It builds route polylines **entirely client-side** with no
route endpoint:

- `MapScreen.jsx:2` — "Route lines grouped by load/driver (one color per load)."
- `MapScreen.jsx:297-301` — groups visible stops by `loadNbr`.
- `MapScreen.jsx:311-339` — one polyline per load, stops sorted by `seq`,
  `coords.length < 2` skipped, color from a per-load palette.
- `MapScreen.jsx:14` — `ROUTE_COLORS` 10-color palette.

**Decision: Option A — client-side route grouping**, mirroring the parent app.
No new Netlify function; no new NuVizz endpoint. The dispatch-map stops payload
already carries `loadStopSeq` (the parent has to infer sequence from
`plannedEta` because its cached payload lacks it — we're strictly better off).

Differences from the parent, per the M5 brief:
- Color by **driver** (`djb2(driverUserName) % 16`) not by load — brief P3.1.
  A driver with multiple loads shares one color.
- Still draw **one polyline per load** (not per driver) so sequence doesn't
  zig-zag across a driver's two loads (seq restarts at 0 per load).
- Google Maps `google.maps.Polyline`, not Leaflet (dispatch-map uses Google).

Standing Rule #7 (never invent endpoints) and #8 (NuVizz calls through Netlify
Functions) are both satisfied: the only NuVizz call is the existing stops fetch
through `nuvizz-pull-today-stops`.

The Date Picker (Phase 2) is unaffected and fully specified.

