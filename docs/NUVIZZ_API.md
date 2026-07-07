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
comes from the **§10.1 full-echo order import**; membership from `insertStops` — see §10).
The **`from.schedule`** (pickup) is pinned to **06:00–07:00**, before every delivery slot
(NuVizz rejects `from > to`).

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

## 10. Stop SEQUENCING (manual order) — TWO LEVERS: membership via insertStops, order via the §10.1 import

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
order.** That was long the only known control — until the **load import (§10.1)** was cracked
as the ORDER lever. The division of labor today (the **two-lever engine**): **membership** =
`insertStops`/`removeStops` (real records; bulk insert is fine because the follow-up order
import seats the sequence), **order** = the §10.1 import with full-echo entries.

### 10.1 BATCH ordering — `load/update/{serviceName}/{cc}`

The async **load import** (`loadImport` op; serviceName `default` works):
`{ companyCode, loads: [{ loadHeader, stops: [...] }] }`. First verified Jul 1 2026 against
UAT DAVISV5; **matching semantics corrected Jul 2 2026** after the same-day prod incident
(freight wipe + duplicate stops) was reproduced by controlled UAT experiments.

**⚠️ THE MATCHING / REPLACE / CLONE SEMANTICS (UAT-proven Jul 2 2026 — this is the part the
Jul 1 verification got wrong):**

- **A `stops[]` entry MATCHES an existing stop ONLY when that `stopNbr` is already ON the
  target load.** Matched = same `stopId`; the array order applies (reorders work).
- **A MATCHED stop is FULL-REPLACED by its entry** — any field not sent is BLANKED. A
  to-only entry (`stopNbr` + `stopType` + `to` block) wiped a live on-load record's
  `totalPallets`/`totalCartons`/`weight`/`proNumber`/references (3 pallets/812 lb → null/null).
- **An entry whose `stopNbr` is NOT on the target load NEVER matches — NuVizz CREATES A NEW
  STOP RECORD (a CLONE) and plans the clone; the original is untouched.** Proven three ways:
  an unplanned original (stopId `…3974`, freight intact) got a null-freight clone `…edb6`
  planned instead; a cross-load "steal" made a THIRD record `…edbd` on the second load; and a
  FULL payload for an existing off-load number STILL cloned (`…edc1` vs original `…3976`) —
  data completeness does not change identity.
- **REFUTED, do not rely on:** *"existing stops plan by reference (`stopNbr` + `to` block)"*
  and *"the stop's `from` side and other fields survive the upsert"*. Both wrong. The Jul 1
  runs only ever re-imported stops the import itself had created on that load (always the
  matched case) and never compared `stopId`s — which is how the clone behavior slipped
  through. ("Either From or To information should be present" is merely the entry's
  VALIDATION rule, not a reference mechanism.)

**What HELD from Jul 1 (still true, still verified):**

- **The `stops[]` ARRAY ORDER is the visit order** for matched (on-load) entries — `stopSeq`
  values and the `stopSeqOrder` flag are ignored; the optimizer does not rearrange an
  imported load.
- **Omission-unplan:** an ON-LOAD stop omitted from a re-import is UNPLANNED (the stop
  record survives, unassigned).
- **Create-with-order:** a NEW `loadNbr` + FULL inline stop payloads for numbers that exist
  NOWHERE lands as a load with `to.seq` exactly matching the array — the created records are
  complete when the payloads are (the clone in the full-payload experiment carried its
  freight). Gate every number with a `getStop` 404 check first; a collision would clone.
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
The Jul 2 refutation evidence: `SQTW901` (freight 2/4/645, stopId `…3974`) cloned onto
`SQTLOADK` as `…edb6` (null freight) and onto `SQTLOADL` as `…edbd`; `SQTW902` (3/7/812,
`…3976`) cloned onto `SQTLOADM` as `…edc1` even with a FULL payload; a to-only re-import of
the on-load `…edc1` kept its stopId (matched) but nulled its freight. All three repro loads
cancelled after the experiments.

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
  `src/lib/loadImportEngine.js` (`applyLoadOrder` — read, insert arrivals, full-echo
  import, converge) behind `usePlanning.sequenceLoad` and `usePlanning.commit`.
- Injection (post-Jul 2 semantics) = 1 `insertStops` (the REAL record joins the load; a
  lone insert appends) + 1–2 order imports (seat it) — constant calls, vs the
  anchor+remove+re-insert path's ~2N+1. (The Jul 1 note that a new stop "appends on its
  first import" was the clone landing at the end — the position observation still holds,
  the mechanism was a clone; never inject via the import.)

> ⚠️ **Delivery windows do NOT set the order.** An earlier hypothesis — that NuVizz seats a
> bulk insert by `to.schedule.timeFrom` — was a **measurement artifact** (the "confirming" tests
> used identical addresses, which gave the optimizer no distance signal, or set array order =
> reverse-of-window so the two were indistinguishable). Controlled tests with distinct real
> addresses + scrambled windows refuted it: the geographic optimizer wins. The 30-min delivery
> slots we stamp (`deliverySlot(index)`) are the **displayed ETA/appointment**, kept aligned to
> the chosen sequence — they are NOT the ordering mechanism.

**Setting a stop's window** (delivery-slot ETA): the 30-min sequence-aligned slots are the
**driver-visible appointment only** and ride **inside the import's full-echo entries** (each
entry's `to.schedule`, stamped by visit position — the ONE field the echo deliberately
rewrites) — the sequencing path makes **no separate per-stop window writes**. The old
`setStopWindow` helper (a full `stop/sync/update` upsert per stop) is **retired**: a partial
upsert blanks/replaces whatever it omits. ⚠️ The import has the SAME replace semantics for a
matched stop (Jul 2 2026) — which is exactly why every entry must be a **full echo** of the
just-read record; a partial "reference" entry reproduces the freight wipe on the import
surface. The origin/pickup window must still sit **before** every delivery slot (NuVizz
rejects `from > to`), so creates pin it to 06:00–07:00.

**Re-sequencing an existing load** (`usePlanning.sequenceLoad` / the `commit` engine — the
**TWO-LEVER engine**, `src/lib/loadImport.js` + `src/lib/loadImportEngine.js`):
1. `load/info` once — the echo source for the header (trap fields) and every on-load stop's
   FULL record.
2. **MEMBERSHIP (never via import):** desired stops not on the load (arrivals) are planned
   with ONE bulk `insertStops` on their real `stopId`s (`stop/info` resolves each id and
   confirms the stop isn't still planned on another load — sources release first). Then
   re-read `load/info` so the freshly-planned records become echo sources. A stop leaves a
   load by being OMITTED from that load's own order import (survives, unplanned) or by
   `removeStops`. **A stop not on the load must NEVER appear in import `stops[]`** — that
   entry would CLONE a new stop record (the engine's `buildImportLoad` guard makes this
   unrepresentable: every entry must be in the just-read on-load set).
3. **ORDER:** ONE `load/update/default/{cc}` import with `stops[]` in the desired order
   (array order = visit order), every entry a **FULL ECHO** of the just-read on-load record —
   `stopType`, `shipmentType`, `stopExecution`, `sourceType`, `shipmentNbr`, `proNumber`,
   `reference1/2/3`, `totalPallets`, `totalCartons`, `weight` (numbers stay numbers),
   `weightUOM`, the whole `from` block (address + schedule) and `to` block — because a
   matched stop is FULL-REPLACED and anything omitted is blanked. On-load stops omitted from
   a *reorder* request are PRESERVED (appended in current order) — only the commit engine's
   explicit departures are omitted (declarative unplan). Delivery-slot windows ride inside
   the entries.
4. **Converge** (mandatory): poll `load/info` on the ~6/10/15/25s ladder (≤5 polls), comparing
   the read-back delivery order (sorted by `to.seq`, stopNbrs normalized: trim/uppercase/strip
   leading zeros, and only when every delivery has a real `to.seq`) to the requested array.
   Not converged → re-send the SAME import once; still stuck → send the array REVERSED, one
   beat, then the desired order (verified unstick). `ok` comes ONLY from the read-back; a 404
   while a new load is being created is not-yet-converged, not failure.
5. If the requested state would leave the load EMPTY → **`load/cancel`**, never an empty
   `stops[]` import (and never remove-all, which cancelled the route as a side effect).
6. Cost: 1 read + 1 import + ~1 poll for a pure reorder (plus 1 `stop/info` + 1 insert + 1
   re-read per arrival batch) — still O(1) imports per load vs the anchor method's ~2N+1.

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
calls), then commit per touched load with the two levers — arrivals join via `insertStops`
(real records), departures are omitted from their source's own order import (the record
survives, unplanned), then ONE full-echo order import seats the sequence. Cross-load moves run
**sources before destinations** (release A first, then plan onto B — an import "steal" CLONES,
and even `insertStops` on a still-planned stop is refused unless its source already converged
in this batch, via `allowFromLoads`); `planCommitOrder` topologically sorts the batch and
refuses a genuine cycle (a two-load swap — save it as two steps). A load the draft empties is
retired via `load/cancel`, explicitly. Each load converges (read-back) before the next
dependent load fires; a stuck source stops the batch. Cost is bounded by *loads touched*, not
by how many moves were dragged.

**`seqMode:'Manual'` does NOT give a cheaper path (tested, ruled out).** Exhaustively tested on
**5 fresh empty loads** (`setSeqMode` op + the portal's own Manual toggle), both `STRICT` and
`PREFERRED` windows:
- Manual + **bulk insert** still reorders — inserting `[GVL,KEN,AUS,ATL]` came back `GVL,AUS,KEN,ATL`
  (ends right, middle swapped). It honors neither insertion order nor ETA.
- Manual + **single insert** still **appends** — a stop whose ETA sits between two seated stops
  lands last, not between (immediately and after an 8s recheck).
- Window constraint (`STRICT` vs `PREFERRED`) made **no difference** to either.

Conclusion: **no load setting or window trick makes a bulk/single `insertStops` honor an order**
on the clean Basic-auth API. The levers are exactly two: **membership via
`insertStops`/`removeStops`** and **order via the §10.1 full-echo import**. The portal's
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
