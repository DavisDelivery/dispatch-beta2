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
(`deliverySlot(index)`): index 0 → 08:00–08:30, 1 → 08:30–09:00, … This is the **displayed
ETA/appointment** only — it does NOT set the visit order (NuVizz's optimizer ignores it; order
comes from the **load import**, §10.1 — one-at-a-time insertion is the incremental fallback,
see §10). The **`from.schedule`** (pickup) is pinned to **06:00–07:00**, before every delivery
slot (NuVizz rejects `from > to`).

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

## 10. Stop SEQUENCING (manual order) — BATCH via load import (§10.1); one-at-a-time as fallback

The order a driver visits stops is `stop.to.seq` on a load (1 = origin pickup,
2..N = deliveries). `normalizeLoad` surfaces it as `seq`. Array order in the payload is
unreliable; always sort by `to.seq`. The load header's **`seqMode`** is NuVizz's optimizer
mode: `Far` (farthest first) · `Near` (nearest first) · `None` (shortest-path) · `Manual`.

**How NuVizz assigns sequence on `insertStops` (rigorously verified live):**
- A **bulk `insertStops`** (array of stopIds in one call) is **re-optimized GEOGRAPHICALLY**
  by NuVizz. It ignores BOTH the array order AND the stops' delivery windows. Reproduced
  deterministically: inserting 4 real distinct-address stops `[GVL, ATL, KEN, AUS]` always
  seated `ATL, KEN, GVL, AUS` regardless of array order or window.
- A **one-at-a-time insert** (one call per stop) **APPENDS** each stop to the end. Inserting
  the same 4 stops one-by-one in `GVL, ATL, KEN, AUS` order yields exactly that `to.seq` order.

So on the *insertStops* path, **manual sequencing = insert one stop at a time, in the desired
order.** That was long the only known control — until the **load import (§10.1)** was cracked:
one call now creates or rebuilds a whole load in an exact chosen order. Prefer §10.1; keep
one-at-a-time as the fallback for incremental single-stop appends.

### 10.1 BATCH ordering — `load/update/{serviceName}/{cc}` (verified live, Jul 1 2026)

The async **load import** (`loadImport` op; serviceName `default` works) is the 1-call batch
lever: `{ companyCode, loads: [{ loadHeader, stops: [...] }] }`. Verified against UAT DAVISV5:

- **The `stops[]` ARRAY ORDER is the visit order.** Two controlled conflict tests (array order
  vs deliberately contradicting `stopSeq` numbers, with and without `stopSeqOrder: 1` in the
  header) both seated the stops in ARRAY order — the `stopSeq` values and the `stopSeqOrder`
  flag are ignored. The optimizer does NOT rearrange an imported load (anti-geographic zigzag
  orders came back exactly as sent).
- **Create-with-order:** a new `loadNbr` + full inline stop payloads lands as a load with
  `to.seq` exactly matching the array. 1 call for N stops.
- **Re-order in ONE call:** re-importing the SAME `loadNbr` with the stops permuted rebuilds
  the load in the new order. The import is **declarative**: stops omitted from a re-import are
  UNPLANNED from the load (the stop itself survives, unassigned) — one import = "this is the
  load's complete stop list, in this order". A board Save = one import per touched load.
- **Existing (already-created) stops** plan by reference: `stopNbr` + `stopType` + a `to`
  block (address + schedule) suffices ("Either From or To information should be present" —
  bare `stopNbr` refs are rejected). The stop's `from` side and other fields survive the
  upsert (checked: origin address/schedule intact after a to-only import).
- **Header contract (the silent-failure trap):** the header MUST carry
  `earliestStartDttm`/`latestStartDttm` (NOT `scheduleStartDttm` — that's `load/edit` naming)
  **and the flat origin fields** (`origin`, `originName`, `originAddr1/2`, `originCity`,
  `originState`, `originZip`, `originCountry`, `loadTimeZone`). Omitting the origin fields
  passes sync validation ("Async import is SUCCESS…AppMessageLog Id") but the background
  worker silently creates nothing — the reason lives only in NuVizz's AppMessageLog, which
  the open API has NO endpoint for. Poll `load/info/{loadNbr}` (~5–15 s) to confirm it landed.
- Spec limit ≤500 loads/request. Full schema + `LoadAPIExample`: the OpenAPI spec is embedded
  in `developer.nuvizzapps.com/v7/webservices.html` (ReDoc `__redoc_state` JSON — there is no
  standalone spec URL).

Live evidence (UAT): `SQTLOADC` — created in 1 call in order MAR→DUL→DEC→ROS, reversed in
1 call to ROS→DEC→DUL→MAR, then re-imported without DUL (unplanned, stop preserved) as
ROS→MAR→DEC. A control load + two lever-conflict loads were cancelled after verification.

**Scale + injection test (Jul 1 2026, 9→10 real stops, load `SQTLOADH`, kept in UAT):**
- 9 orders (real Davis consignees, Dalton→Forest Park whipsaw order) created + imported in
  ONE call: exact match at 9 stops. Full 10-stop reversal: exact. "Optimizer" reorder to a
  sensible driving loop: exact, first try. Tail-only swap (8-stop matching prefix): exact.
- **Mid-route injection of a NEW stop lands at the END on the first import** — the add is
  applied, its position is not. Follow-up reorder imports sent within the next ~minutes
  also no-opped twice (same payload later applied unchanged), which looks like a **stale-state
  window in the async worker right after a membership change**. Once settled, every reorder
  applied on the first try.
- **Robust recipe (self-healing, still O(1) calls per load):** after EVERY import, poll
  `load/info` and compare `to.seq` to the requested order. Converged → done. Not converged
  after ~60–90 s → re-send the same import; if still stuck, send the array REVERSED, then
  the desired order (verified to unstick it). Never trust the 200 alone. **This recipe is
  what the app now runs**: `src/lib/loadImport.js` (pure builders/comparators/planner) +
  `src/lib/loadImportEngine.js` (`applyLoadOrder` — read, echo, import, converge) behind
  `usePlanning.sequenceLoad` and `usePlanning.commit`.
- Injection therefore = 1 import (add, appends) + 1–2 reorder imports (seat it) — constant
  calls, vs the anchor+remove+re-insert path's ~2N+1.

> ⚠️ **Delivery windows do NOT set the order.** An earlier hypothesis — that NuVizz seats a
> bulk insert by `to.schedule.timeFrom` — was a **measurement artifact** (the "confirming" tests
> used identical addresses, which gave the optimizer no distance signal, or set array order =
> reverse-of-window so the two were indistinguishable). Controlled tests with distinct real
> addresses + scrambled windows refuted it: the geographic optimizer wins. The 30-min delivery
> slots we stamp (`deliverySlot(index)`) are the **displayed ETA/appointment**, kept aligned to
> the chosen sequence — they are NOT the ordering mechanism.

**Setting a stop's window** (delivery-slot ETA): the 30-min sequence-aligned slots are the
**driver-visible appointment only** and now ride **inside the import payload** (each stop
reference's `to.schedule`, stamped by visit position) — the sequencing path makes **no separate
per-stop window writes**. The old `setStopWindow` helper (a full `stop/sync/update` upsert per
stop) is **retired**: a partial upsert blanks/replaces whatever it omits — it blanked the
destination address, and even the "full" rebuild blanked freight fields (`proNumber`/`pallets`/
`weight`) not carried on the order record. An import *reference* leaves the stop's other fields
intact (§10.1), which eliminates that whole hazard class. The origin/pickup window must still sit
**before** every delivery slot (NuVizz rejects `from > to`), so creates pin it to 06:00–07:00.

**Re-sequencing an existing load** (`usePlanning.sequenceLoad` / the `commit` engine — the
**LOAD IMPORT path**, `src/lib/loadImport.js` + `src/lib/loadImportEngine.js`):
1. `load/info` once — the echo source for the header (trap fields) and every on-load stop's
   `to` block. Stops not on the load (arrivals) are echoed from `stop/info` — **echo, never
   invent**; a bare `stopNbr` reference is rejected.
2. ONE declarative `load/update/default/{cc}` import with `stops[]` in the desired order
   (array order = visit order). On-load stops omitted from a *reorder* request are PRESERVED
   (appended in current order) — only the commit engine's explicit departures are omitted
   (declarative unplan). Delivery-slot windows ride inside the payload.
3. **Converge** (mandatory): poll `load/info` on the ~6/10/15/25s ladder (≤5 polls), comparing
   the read-back delivery order (sorted by `to.seq`, stopNbrs normalized: trim/uppercase/strip
   leading zeros, and only when every delivery has a real `to.seq`) to the requested array.
   Not converged → re-send the SAME import once; still stuck → send the array REVERSED, one
   beat, then the desired order (verified unstick). `ok` comes ONLY from the read-back; a 404
   while a new load is being created is not-yet-converged, not failure.
4. If the requested state would leave the load EMPTY → **`load/cancel`**, never an empty
   `stops[]` import (and never remove-all, which cancelled the route as a side effect).
5. Cost: 1 read + 1 import + ~1 poll when the worker is prompt — O(1) per load vs the anchor
   method's ~2N+1.

*(History/fallback — the ruled-out anchor method, the pre-import engine: keep the FIRST desired
stop as an anchor because removing ALL stops cancels the route, `removeStops` the rest, then
re-insert one-at-a-time in order, each append landing at the end; cost ≈ 2 + (N−1) calls, plus N
per-stop window writes. It works and single-insert-appends remains the incremental append
fallback, but it is O(N) calls, its window writes carried the field-blanking hazard above, and
emptying a load cancelled the route implicitly. Middle-injection under that method meant keeping
the pre-*k* stops as anchors, removing from *k* on, and re-inserting the new stop + tail
one-at-a-time. On the import path, injection = 1 import (the add APPENDS on its first import) +
the resend that seats it — the convergence loop does this automatically.)*

**Draft → Save (batch) pattern** (`usePlanning.commit`): stage all moves/reorders locally (zero
calls), then commit — ONE declarative import per touched load: stop set + order become exactly
that load's `stops[]`; departures are simply omitted (the stop record survives, unplanned).
Cross-load moves run **sources before destinations** (import A *without* the stop first, then B
*with* it — never rely on a declarative steal); `planCommitOrder` topologically sorts the batch
and refuses a genuine cycle (a two-load swap — save it as two steps). A load the draft empties is
retired via `load/cancel`, explicitly. Each load converges (read-back) before the next dependent
load fires; a stuck source stops the batch. Cost is bounded by *loads touched* (reads + 1 import
+ polls each), not by how many moves were dragged.

**`seqMode:'Manual'` does NOT give a cheaper path (tested, ruled out).** Exhaustively tested on
**5 fresh empty loads** (`setSeqMode` op + the portal's own Manual toggle), both `STRICT` and
`PREFERRED` windows:
- Manual + **bulk insert** still reorders — inserting `[GVL,KEN,AUS,ATL]` came back `GVL,AUS,KEN,ATL`
  (ends right, middle swapped). It honors neither insertion order nor ETA.
- Manual + **single insert** still **appends** — a stop whose ETA sits between two seated stops
  lands last, not between (immediately and after an 8s recheck).
- Window constraint (`STRICT` vs `PREFERRED`) made **no difference** to either.

Conclusion: **no load setting or window trick makes a bulk/single `insertStops` honor an order**
on the clean Basic-auth API. The levers are the **load import (§10.1, batch)** and one-at-a-time
insertion (incremental). The portal's
drag-to-reorder / ETA ordering runs through its internal **session-gated** resequence endpoints
(see below), which Basic auth can't reach — that's why ordering "works in the portal" but not here.

> ⚠️ Note: `removeStops` (our `load/edit` echo) resets the load to `seqMode:'None'`. The
> `setSeqMode` op (`load/edit` with a chosen mode) sets it, but `load/info` does **not** echo
> `seqMode` back, so it's a write-only black box — you can't read the current mode.

**Dead ends / gated (don't waste time):**
- `load/edit` has a documented `routeSeq: [{stopNbr, sequence, …}]` field — it is a
  **no-op** (200, no effect). Tested every shape. Do not use it.
- `routePlan/update/{serviceName}/{cc}` — still dead (retested Jul 1 2026 with the
  example-faithful payload incl. flat origin fields, serviceNames `default` and
  `RouteExistingStops`): **500 "deliverItLoad is null"** every time. The route-plan
  integration service isn't provisioned for the tenant. Use §10.1 instead — it does the
  same job and works today.
- `stop/partialUpdate/{cc}` — the spec shows per-stop `stopSeq`/`altStopSeq` (≤500 stops
  per call), but on UAT DAVISV5 it **500s "Something Went Wrong"** for EVERY payload,
  even a single non-seq field (`reference1`) on one stop — the endpoint itself is broken/
  unprovisioned here, not our shape. Re-check on prod before ruling it out there.
- The portal's Route Workbench (`dirouteworkbench/*`, `opt-job/routeopt/resequenceRoute`,
  `resequenceBuildManualRoute`, `saveComparedRouteData`) does 1-call sequencing/optimize,
  but is **session cookie + CSRF** only (rejects Basic auth, 401). Would need a server-side
  portal-login layer (login HAR required).

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
