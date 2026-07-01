# NuVizz API — integration handoff (Davis Dispatch)

Everything another app/agent needs to drive NuVizz the way Davis Dispatch does:
every call we make, its exact request/response, what to extract, and the
**production switch** checklist. Source of truth for the live code:
`netlify/functions/nuvizz-write.cjs` + `src/lib/nuvizzWrite.js`.

> **Mental model.** The NuVizz portal is itself just a client of the NuVizz API.
> Every write you do here (create / plan / unplan / assign / dispatch) is the
> *same* API call the portal makes — **1:1, often fewer**, because we skip the
> portal's validation/refresh chatter. Writes are cheap and unavoidable. The only
> place call volume grows is **reads** (populating boards/maps); we keep those
> near zero by holding state locally (see §7) and never scanning.

---

## 1. Connection & auth

| | UAT (current) | Production (DAVIS) |
|---|---|---|
| API base (v7) | `https://uat.nuvizz.com/deliverit/openapi/v7` | `https://portal.nuvizz.com/deliverit/openapi/v7` |
| Entity base (grids) | `https://uat.nuvizz.com/deliverit/openapi` | `https://portal.nuvizz.com/deliverit/openapi` |
| Company code (`{cc}` in paths) | `DAVISV5` | `DAVIS` |
| Auth | HTTP Basic | HTTP Basic |

- **Auth header:** `Authorization: Basic base64(username:password)`. Same NuVizz
  user/pass for every call. We store them server-side as env vars
  `NUVIZZ_DAVIS_USER` / `NUVIZZ_DAVIS_PASS` / `NUVIZZ_DAVIS_COMPANY_CODE`.
- **Content type:** `application/json` on every POST. Send `Accept: application/json`.
- The company code is both the **path segment** `{cc}` and (for `createStop`) a
  body field `companyCode`.

---

## 2. How our app routes the calls

```
Browser UI ──POST {op,…}──► Netlify fn  nuvizz-write.cjs ──Basic auth──► NuVizz v7
                                  │
                                  └─ counts every upstream call (callCounter.cjs)
```

The browser never holds NuVizz creds; it POSTs an **op** to our function, which
adds Basic auth from env and forwards to NuVizz. You don't have to keep this
proxy — another backend can call NuVizz directly with the same
endpoints/payloads below. The proxy exists for (a) keeping creds server-side and
(b) the call counter chokepoint.

**Op envelope** (POST to the write fn): `{ "op": "<name>", …args }`. Creds fall
back to env; a request may override `companyCode`/`username`/`password`.

---

## 3. The calls

For each: what it does · method + path · request · response · what to extract.
`{cc}` = URL-encoded company code. All paths are under the **v7 base** unless noted.

### 3.1 createStop — create an order (delivery stop)
- **POST** `stop/sync/update/{cc}`
- **Body:** `{ "companyCode": "<cc>", "stop": <STOP_PAYLOAD> }` (see §4 for the stop shape)
- **Response (success):**
  ```json
  { "apiResult": { "created": 1 },
    "entityInfoList": [ { "entityId": "6a3f…523d", "entityNbr": "007139395" } ] }
  ```
- **Extract:** `entityInfoList[0].entityId` = the **stopId** (needed to plan), `entityNbr` = the stop number. Keep both.
- Upstream calls: **1**.

### 3.2 getStop — read a stop (and its current load)
- **GET** `stop/info/{stopNbr}/{cc}`
- **Response:** `{ "Stop": { "stop": {…}, "stopExecutionInfo": {…}, "load": { "loadNbr", "routeName" } } }`
- **Extract:** `Stop.stop.stopId`, `Stop.stopExecutionInfo.stopStatus`, **`Stop.load.loadNbr`** (which load it's on now — null/absent ⇒ unplanned), `Stop.stop.to.address.{name,city,state,latitude,longitude}`.
- Upstream calls: **1**.

### 3.3 getLoad — read a load + its stops
- **GET** `load/info/{loadNbr}/{cc}`
- **Response:** `{ "Load": { "loadHeader": { "loadId", "loadNbr", "routeName", … }, "loadExecutionInfo": { "loadStatus" }, "versionId", "stops": [ { "stop": { "stopId", "stopNbr", "stopSeq", "stopType" } } ], "loadAssignment": {} } }`
- **Extract:** `loadHeader.loadId` (the internal id used as **routeId** for assign/dispatch, and as **loadId** for insertStops), `loadExecutionInfo.loadStatus`, `versionId` (needed for `load/edit`), and `stops[].stop.stopNbr` (membership → which orders are on this load).
- Upstream calls: **1**.

### 3.4 insertStops — plan stops onto a load
- **POST** `load/insertstops/{cc}`
- **Body:** `{ "insertStopIds": ["<stopId>", …], "loadId": "<loadId>" }`
  (stopIds from createStop/getStop; loadId from getLoad.)
- **Response:** success body (no special parse needed; treat HTTP 200 + no `reasons`/`error` as ok).
- Upstream calls: **1** (accepts MANY stopIds in one call — batch them).

### 3.5 removeStops — unplan stops from a load
- **POST** `load/edit/{cc}` — but `load/edit` is a **FULL header replace**, so you must first GET the load and echo its whole header back, or fields blank out.
- **Step 1:** GET `load/info/{loadNbr}/{cc}` → `loadHeader` + `versionId`.
- **Step 2:** POST `load/edit/{cc}` with:
  ```json
  { "loadHeader": <ECHOED_EDIT_HEADER>, "removeStopIds": ["<stopId>", …],
    "routeSeq": [], "versionId": "<versionId>" }
  ```
  The echoed header maps load/info → edit fields (see §5 `toEditHeader`).
- Upstream calls: **2** (load/info + load/edit).

### 3.6 assignDriver — assign a driver to a load
- **POST** `load/assignanddispatch/{cc}`
- **Body:**
  ```json
  { "action": "ASSIGN_DISPATCH",
    "dispatchRoute": [ { "routeId": "<loadId>", "assignDtls": { "driverId": <driverId> } } ] }
  ```
  - `routeId` = the load's **loadId** (from getLoad).
  - `driverId` = the driver's **roster userId** (a number — see §6). NOT the userName.
- **Response:** `{ "status": "Success", "successMsgs": [], "reasons": [] }`
- **Success check:** `status === "Success"` (note: capital-S "Success", not "SUCCESS"). On failure `reasons[0].description` has the reason.
- Upstream calls: **1**. (The portal also fires assignValidation + several refresh GETs; you don't need them.)

### 3.7 dispatchLoad — release a load to its assigned driver
- **POST** `load/assignanddispatch/{cc}`
- **Body:** `{ "action": "DISPATCH", "dispatchRoute": [ { "routeId": "<loadId>" } ] }`
- **Response / success check:** same as §3.6 (`status: "Success"`).
- Upstream calls: **1**. Typical flow: plan stops → assignDriver → dispatchLoad.

### 3.8 user/list — the driver roster (one-time, to build the driver list)
- **POST** `user/list/{cc}` (v7 base)
- **Body:**
  ```json
  { "pageInfo": { "pageSize": 0, "page": 1, "maxResult": 500 },
    "searchCriteria": { "name": "", "groupNames": ["-1"], "vendorId": ["-1"],
      "email": "", "userRoles": ["-1"], "status": "-1", "companyId": "" } }
  ```
- **Response:** `{ "totalRecords", "users": [ { "userId", "userName", "firstName", "lastName", "accountStatus", "userRoles": [ { "role" } ], "mobileNumber" } ] }`
- **Build the driver list:** keep `accountStatus === "ENABLED"` with a `DI_Driver` role. For a clean roster (production DAVIS) also drop office roles: `DI_Dispatcher, MemberAdmin, GroupAdmin, Account_CSR, DI_Biller, ROUTE_ANALYST, CUST_ADMIN, CUST_ASSOCIATE, DWH_USER, DI_Receiver, DI_Inquiry, DI_Integration, DI_User`. **`driverId` = `userId`.** (UAT is a shared sandbox so every account is over-provisioned — there the driver-only filter yields nothing; just use enabled `DI_Driver`.)
- Upstream calls: **1**. Re-run per tenant; not per dispatch.

### 3.9 The 3-call read scan (loads + stops grids) — optional, for full board reads
Cheap "where is everything" without per-load reads. **Entity base** (`…/openapi`, *no* `/v7`).
- **Loads — POST** `entity/filterdata/PkgRoute/{cc}`
  ```json
  { "filterList": [ {"sequence":1,"value":"{\"period\":\"0d\"}"},
      {"sequence":2,"value":"-1"},{"sequence":3,"value":"-1"},
      {"sequence":4,"value":"-1"},{"sequence":5,"value":"-1"} ],
    "listDefId":"", "customListDefId": <LOAD_LISTDEF>, "userDefaultFilter": false,
    "currentPageSize":0, "canDelete":false, "canEdit":false, "canShow":false,
    "canSelect":true, "page":1, "maxResult":500, "defaultSize":500,
    "filterArgsJson":{}, "filterValues":[] }
  ```
  Response: `{ "filterData":[<col→def>], "values":[[…row…]] }`. Map columns by pattern (`KeyColumn`→loadId, name, status).
- **Stops — POST** `entity/filterdata/VizzonStop/{cc}` — same envelope, 12 `filterList` sequences (sequence 10 = `{"period":"0d"}`), `customListDefId: <STOP_LISTDEF>`. Each row carries the stop + its load identity (planned vs unplanned).
- **`customListDefId` is a per-tenant saved-search id** and is **mandatory** (no default — the grid 500s without a valid one). **Production DAVIS** ids (from the davis-nuvizz scans bundle): **loads `35833`, stops `35824`, active saved-search `77128`, completed `77131`, attempts `77203`**. **UAT has different ids** — capture them from a UAT portal HAR (open the Loads + Stops grids, read `customListDefId` from each `entity/filterdata` request) before using this in UAT.
- ⚠️ Do **not** number-probe load ranges to discover loads — that path costs ~3,000 calls and NuVizz has a runaway/blacklist history. Use the saved-search list-defs (2–3 calls) or known load numbers only.

---

## 4. The stop (order) payload — `STOP_PAYLOAD` for createStop

Built by `buildStopPayload(row, settings)` in `src/lib/nuvizzWrite.js`. Required
row fields: `name, addr1, city, state, zip` (+ optional `addr2, pallets, cartons,
weight, pro`). Settings: the origin/depot + service date.

```json
{
  "stopNbr": "<your order number>",
  "stopType": "DO", "shipmentType": "REG", "stopExecution": "APP", "sourceType": "INTG",
  "shipmentNbr": "<pro?>", "proNumber": "<pro?>", "reference1": "PRO <pro?>",
  "totalPallets": 1, "totalCartons": null, "weight": null, "weightUOM": "LBS",
  "from": {
    "address": { "addressType": "COM", "name": "<origin name>", "addr1": "<origin addr1>",
      "city": "<origin city>", "state": "<origin st>", "zip": "<origin zip>", "country": "USA" },
    "schedule": { "timeFrom": "<serviceDate>T06:00:00", "timeTo": "<serviceDate>T07:00:00",
      "timeZone": "America/New_York", "timeConstraint": "PREFERRED" }
  },
  "to": {
    "address": { "addressType": "COM", "name": "<consignee>", "addr1": "<addr1>", "addr2": "<addr2?>",
      "city": "<city>", "state": "<st>", "zip": "<zip>", "country": "USA" },
    "schedule": { "timeFrom": "<serviceDate>T08:00:00", "timeTo": "<serviceDate>T08:30:00",
      "timeZone": "America/New_York", "timeConstraint": "PREFERRED" }
  }
}
```
The **`to.schedule` is a 30-minute delivery slot staggered by the stop's visit index**
(`deliverySlot(index)`): index 0 → 08:00–08:30, 1 → 08:30–09:00, … This encodes the visit
order so a bulk `insertStops` seats the load correctly (see §10). The **`from.schedule`** (pickup)
is pinned to **06:00–07:00**, before every delivery slot (NuVizz rejects `from > to`).

Gotchas (learned live): do **not** send `shipForBP` or `profile` on the open
import ("ShipForBP is Invalid" / "profile … does not exist"). NuVizz geocodes
from the address; include a real `zip`. A PARTIAL upsert (just `stopNbr` + `to.schedule`)
**replaces the destination address with the origin** — always send the full payload.

---

## 5. `toEditHeader` — load/info header → load/edit header (for removeStops)

`load/edit` blanks anything you don't echo. Map the load/info `loadHeader` to:
`loadId, routeName, routeDesc, scheduleStartDttm (=earliestStartDttm),
scheduleEndDttm (=latestStartDttm), signatureRequired, rtOrigin, depot, facility,
masterBol, pronbr, reference, reference2, reference3, sealNbr, totalCartons,
totalPallets, vehicleType, volume, volumeUOM, weight, weightUOM, cusAccNbr,
returnToDepot, congestionFactor, sourceType, customAttributes, maxRouteTime,
shiftType, maxDistMiles, cutOffTime, seqMode:"None"`. (Full mapping in
`nuvizz-write.cjs` `toEditHeader`.)

---

## 6. Response parsing helpers (in `src/lib/nuvizzWrite.js`)
- `summarize(resp)` — createStop/insert/remove: ok if `apiResult.created/updated`
  + `entityInfoList`, or `status==="SUCCESS"`, or 2xx with no `reasons`/`error`.
  Pulls `entityId`/`entityNbr`. Error text from `reasons[0].description` /
  `apiResult.errors[0].msgs` / `error` / `message`.
- `assignOk(resp)` — assign/dispatch: ok if `status` (case-insensitive) `=== "success"`.
- `normalizeStop(resp)` → `{ stopId, stopNbr, status, assignedLoadNbr, toName, toCity, toState, latitude, longitude }`.
- `normalizeLoad(resp)` → `{ loadId, loadNbr, routeName, status, versionId, stops:[{stopId,stopNbr,stopSeq,stopType}] }`.

---

## 7. What is **NOT** a NuVizz call (our local state)
These never touch NuVizz — they're our own stores so the board needs zero reads:
- **Created-orders registry** — `netlify/functions/orders.cjs` (Netlify Blobs). The
  list of orders we created (each with its `stopId` + planned load). Source of truth
  for the board.
- **Load→driver assignments** — `netlify/functions/assignments.cjs` (Blobs). Board
  record of who's on each load (mirrors what we dispatched).
- **loadId cache** (`localStorage dd_loadid_cache`) — loadNbr→loadId, so we resolve a
  load's id at most once.
- **Geocode cache** (`dd_geocode_cache`) — addresses→lat/lng via **Google** (not NuVizz).
- **Known loads** (`src/lib/loads.js`) / **Known drivers** (`src/lib/drivers.js`) — static lists.

The only time we read NuVizz is the on-demand **Sync** (reconcile): `getLoad` each
known load (~8 calls) to correct planned/unplanned drift. Replace with the §3.9
3-call scan once you have the tenant list-def ids.

---

## 8. Call counter (optional but recommended)
`netlify/functions/lib/callCounter.cjs` counts every upstream round-trip at the one
`nuvizz()` chokepoint into a Blobs key `calls:<ET-day>` `{count, byRoute, byHour}`
(ET-day key = implicit daily reset). Exposed read-only by `nuvizz-ops.cjs`. Honors
`NUVIZZ_DAILY_CEILING` (default 1000) + `NUVIZZ_BREAKER_MODE` (monitor/enforce).

---

## 9. PRODUCTION SWITCH CHECKLIST (UAT `DAVISV5` → prod `DAVIS`)

1. **Base URL.** `nuvizz-write.cjs` hard-codes `UAT_BASE = https://uat.nuvizz.com/…`.
   Change to `https://portal.nuvizz.com/deliverit/openapi/v7` (ideally read from
   `NUVIZZ_BASE_URL`).
2. **Remove the prod-tenant guard.** `nuvizz-write.cjs` currently `return 400` when
   `companyCode === "DAVIS"` (a UAT safety). Delete that check for production.
3. **Env vars** (Netlify): `NUVIZZ_DAVIS_COMPANY_CODE=DAVIS`, `NUVIZZ_DAVIS_USER`,
   `NUVIZZ_DAVIS_PASS` (production creds), `NUVIZZ_WRITE_ENABLED=true`.
4. **Driver roster.** Re-run §3.8 against `DAVIS` → regenerate `src/lib/drivers.js`
   (clean roster ≈ 60 road drivers; `driverId = userId`).
5. **Known loads.** Put the real production load numbers in `src/lib/loads.js`
   (or wire the §3.9 scan to discover them — prod list-def ids are known: loads
   `35833`, stops `35824`).
6. **Sanity:** create one order → plan → assign a driver → dispatch on a throwaway
   prod load, confirm each returns success, before going live.

---

## 10. Stop SEQUENCING (manual order) — tested, works on the clean API

The order a driver visits stops is `stop.to.seq` on a load (1 = origin pickup,
2..N = deliveries). `normalizeLoad` surfaces it as `seq`. Array order is unreliable;
always sort by `to.seq`. The load header's **`seqMode`** controls how NuVizz orders:
`Far` (farthest first) · `Near` (nearest first) · `None` (shortest-path) · `Manual`.

**How NuVizz assigns sequence on `insertStops` (verified live):**
- A bulk `insertStops` seats the set by **each stop's DELIVERY window** (`to.schedule.timeFrom`),
  NOT by distance — confirmed on both empty and non-empty loads. (Without distinct windows it
  falls back to auto-optimize per `seqMode`; a one-at-a-time insert simply APPENDS.)

So **manual sequencing = encode the order into the delivery windows, then bulk insert.**
We hand every stop a **30-minute delivery slot** staggered by its visit position
(`deliverySlot(index)` in `src/lib/nuvizzWrite.js`): index 0 → 08:00–08:30, 1 → 08:30–09:00, …
The driver/customer ETA the dispatcher sees IS the sequence — windows are the source of truth.

**Setting a stop's window** (`setStopWindow`): a PARTIAL `stop/sync/update` (just `stopNbr` +
`to.schedule`) **blanks/replaces the destination address** — so always send a FULL stop payload.
When the order carries its address + `serviceDate` (created in-app) we rebuild from it (1 call);
otherwise we read the stop first to preserve `addr2` + its date (2 calls). ⚠️ The origin/pickup
window must sit **before** every delivery slot (NuVizz rejects `from > to`), so it's pinned to
06:00–07:00.

**Re-sequencing an existing load** (`usePlanning.sequenceLoad` / the `commit` engine):
1. `setStopWindow` each stop to its 30-min slot for the desired order.
2. ⚠️ **Removing ALL stops cancels the route** ("Cannot insert stops to a Cancelled route"),
   so keep the FIRST desired stop as an **anchor**; `removeStops` the rest.
3. `insertStops` the rest in ONE bulk call — they seat after the anchor in window order.
4. Cost ≈ `N (windows) + 2`. Verified: anchor `ALPHA(08:00)` + bulk-insert `[BRAVO(09:00),
   CHARLIE(08:30)]` (array order reversed) → seats `ALPHA → CHARLIE → BRAVO` (window order).

**Bake-at-create shortcut:** `buildStopPayload` already stamps the 30-min slot at create time
(by paste-row index), so a fresh-load plan (`plan` / a single bulk `insertStops`) seats in that
order with **no window calls** — only reorders pay the per-stop `setStopWindow` cost.

**Draft → Save (batch) pattern** (`usePlanning.commit`): stage all moves/reorders
locally (zero calls), then commit — Phase 1 unplans departures, Phase 2 window-encodes each
touched load's order and rebuilds it (anchor + remove-rest + one bulk insert). Cost is bounded
by *loads touched + their stops*, not by how many moves were dragged.

**Dead ends / gated (don't waste time):**
- `load/edit` has a documented `routeSeq: [{stopNbr, sequence, …}]` field — it is a
  **no-op** (200, no effect). Tested every shape. Do not use it.
- `routePlan/update/{serviceName}/{cc}` IS the clean 1-call "send full ordered route"
  endpoint (`{companyCode, route:{loadHeader, planStops:[{stopNbr, from:{seq,schedule},
  to:{seq,schedule}}]}}`, example `RouteExistingStops`). Our payload is correct (the
  wrapper validates), but it **500s "deliverItLoad is null"** — the `default` route-plan
  service isn't wired for the tenant. **Needs NuVizz to enable the route-plan integration
  service** (or a real `serviceName`); then it's a clean one-call save.
- The portal's Route Workbench (`dirouteworkbench/*`, `opt-job/routeopt/resequenceRoute`,
  `saveComparedRouteData`) does **1-call sequencing/optimize** and — **now PROVEN
  (Jul 2026)** — the result **propagates to the load's real `to.seq`** (driver-facing), not
  just a workbench draft. It's session-gated (Basic-JWT + CSRF + cookies), not the clean
  Basic-auth surface. Full contract + proof in **§10.1**.

## 10.1 Route Workbench (session-gated) — PROVEN reachable + propagates (Jul 2026)

We replayed a captured UAT dispatch session server-side (from the Netlify container) and
confirmed the whole resequence path. This is the true 1-call resequence; the §10
window-encode rebuild (N+2 calls) is the fallback for the clean Basic-auth surface.

**Auth (the reason this is "session-gated").**
- Header: `Authorization: Basic base64("JWT:" + <token>)` — the Basic *username* is the
  literal string `JWT`; the *password* is an **auth0-minted HS256 JWT** (`iss:"auth0"`,
  `sub` = userName, claims carry `companyCode`, `userId`, `roles`, `userType:"DISPATCH"`).
- **TTL = 900 s (15 min).** Verified: requests 401 within seconds of `exp`; the session
  cookie does NOT extend it. ⇒ **Hand-captured tokens cannot be replayed** (capture→use
  latency > 15 min). A server-side login that mints its own token is required.
- Also required on writes: `_csrf` (form field) + cookies (`SESSION`, `JSESSIONID`, `Instance=ndv2`).
- Base is the **portal** host `uat.nuvizz.com/deliverit/...`, NOT the openapi v7 host.

**`routePlanId` == `loadId`.** The workbench's `routePlanId` is exactly the load's internal
`loadId` (confirmed in the response body and via `getLoad`). No extra lookup — our existing
read already has it.

**The three calls (all `multipart/form-data`):**
1. `POST dirouteworkbench/routePlan/fetchUpdatedJson` — **read-only** ETA/metrics preview.
   Fields: `originLat,originLng,originOption,stoplist(<stopId>_PU/_DO,…),routePlanId,returnToDepot,computeLatestEta,_csrf`.
   ⚠️ **Ignores the order you send** — reversed `stoplist` returned byte-identical `stopSeq`/ETAs/totals.
   It's a metrics refresh, not the reorder. But it's a **scoring goldmine**: per-stop ETA,
   `earliestStartDTTM`/`latestStartDTTM`, `plnDistToNxtStop`/`plnDurToNxtStop`, `deadHeadMiles/Mins`,
   `stemOutMiles/Mins`, `idleTime`, and route `distance`/`duration`/`estRtCost` (OSRM-accurate).
2. `POST opt-job/routeopt/resequenceRoute` — **NuVizz's 1-call optimizer.**
   Fields: `routePlanId, stopIdsStr(<stopId>_PU/_DO,…), returnToDepot, seqMode(Far|Near|None), reqSource=RWB_CP, _csrf`.
   (Quality is poor — see §11 — but it's one call.)
3. `POST dirouteworkbench/routePlan/saveComparedRouteData` — **1-call commit of an EXACT
   order** (this is the one we want with our own optimizer). Fields: `routeJsonData` (a
   JSON *array*, one element), `planningMode=true`, `_csrf`. The element carries
   `{routePlanId, originLat, originLong, routeStartTime, routeEndTime, routeDistance,
   transitTime, seqMode:"Manual", stopDataJsonArray:[{stopId,plannedETA,tripId,timeZone,…}],
   tripDataJsonArray:[…ordered tripIds…], list:"list1"}`. **The order lives in
   `tripDataJsonArray`** (ordered `tripId`s = `stopId` minus the `_PU`/`_DO` suffix; all PU
   tripIds, then DO in visit order).

**Propagation proof (no session needed to verify).** After the session's optimize, a plain
`getLoad LOAD000113021` (ABC5) showed `to.seq` **decoupled from the delivery windows** —
e.g. `ABC5S8` (11:30 window) at seq 3, ahead of `ABC5S1` (08:00 window) at seq 5. Only a
real resequence can produce that, so the RWB write reaches the driver-facing sequence.

**To use it in the app we must build a server-side portal-login layer** that (a) logs a
dispatch user into UAT (`loginqa.nuvizz.com` / tenant `DAVISV5`) to mint the auth0 JWT,
(b) obtains a `_csrf` token + session cookie, then (c) calls `resequenceRoute` (their
optimize) or `saveComparedRouteData` (our exact order). **Missing piece: the login HAR**
(`loginqa.nuvizz.com`) showing how username/password → JWT and where `_csrf` is issued.

**Two roads to 1-call resequence (pick one):**
- **A — openapi `routePlan/update` (§10):** clean Basic auth, no session layer, but 500s
  until NuVizz enables the route-plan integration service. One email to NuVizz unblocks it.
- **B — RWB `saveComparedRouteData` (this section):** works TODAY, but we build+maintain the
  portal-login+CSRF layer and manage the 15-min token refresh.

## 11. Route OPTIMIZATION — do it yourself

**NuVizz's optimizer is poor.** Measured on 8 metro-Atlanta stops: NuVizz `seqMode None`
gave **280.7 road-mi / 385 min**; a naive nearest-neighbor gave **159.7 mi / 261 min**
(43% shorter). So **don't use their optimizer** — compute the order locally (nearest-
neighbor + 2-opt, or your own), then apply it via the manual sequencing above.

NuVizz still computes **road-accurate** distance/time (OSRM) for *whatever* order you set:
after applying an order, `load/info`'s `loadExecutionInfo` returns `plannedDistanceMiles`,
`plannedDriveTime`, `plannedDuration`. Read those to score routes — road-accurate metrics,
your sequencing, zero dependence on their optimizer.

## 12. Not yet wired
- **Un-dispatch / un-assign driver**: `POST /load/unassign/driver/{cc}` and
  `/load/assign/driver/{cc}` exist on the clean API (return 400 "missing info" on empty
  body, i.e. reachable). Get the request shape from the OpenAPI spec
  (`developer.nuvizzapps.com/v7/webservices.html`) or a portal HAR.
- **Live GPS / ELD** — separate (Samsara/Motive), not NuVizz.

> The full v7 catalog (164 endpoints) is the ReDoc page at
> `https://developer.nuvizzapps.com/v7/webservices.html` (download the OpenAPI spec for
> request schemas + examples). Almost the entire platform is on this clean Basic-auth
> surface — only the Route Workbench optimize/save UI calls are session-gated.
</content>
