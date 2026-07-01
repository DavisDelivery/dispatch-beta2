# How we unplan orders from NuVizz

Handoff note for another agent. If you're trying to remove stops from a load in
NuVizz and it isn't working, read this first — the mechanism is **not** what the
name suggests.

## TL;DR — the one thing that trips everyone up

**There is no "unplan" or "removeStops" endpoint in NuVizz.** Unplanning a stop is
done through **`POST load/edit/{cc}`**, and `load/edit` is a **FULL load-header
replace**. So you cannot just fire "remove stop X." You must:

1. **GET the load first** (`load/info`) to read its current `loadHeader` + `versionId`.
2. **POST `load/edit`** echoing that **entire header back**, plus a `removeStopIds`
   array and the `versionId`.

If you skip the GET-and-echo and send a partial header, NuVizz silently blanks the
fields you omitted (depot, volume, weight, references, …). And two more traps:

- **`removeStopIds` uses the internal `stopId`, NOT the human `stopNbr`.**
- **Removing *every* stop CANCELS the route** ("Cannot insert stops to a Cancelled
  route" on the next insert). Leave at least one stop if you want the load to survive.

## The call chain (client → NuVizz)

```
Dispatch/Routing UI
  └─ usePlanning().unplan(list)                 src/hooks/usePlanning.js:70
       └─ removeStops({}, loadNbr, stopIds)     src/lib/nuvizzWrite.js:230
            └─ POST /.netlify/functions/nuvizz-write  { op:'removeStops', loadNbr, removeStopIds }
                 └─ case 'removeStops'           netlify/functions/nuvizz-write.cjs:164
                      ├─ GET  load/info/{loadNbr}/{cc}   (read header + versionId)
                      └─ POST load/edit/{cc}             (full-header echo + removeStopIds)
```

Two upstream NuVizz round-trips per load (info + edit). Both are counted by the
call-counter at the `nuvizz()` chokepoint (`nuvizz-write.cjs:37`).

### Identifier asymmetry (important)

- **Plan / `insertStops`** takes the load's **`loadId`** (internal id).
- **Unplan / `removeStops`** takes the load's **`loadNbr`** (human number) — the
  write function resolves the `versionId` and header itself via `load/info`. Don't
  pass a `loadId` to the unplan path; it wants the number.
- **`removeStopIds`** are **`stopId`s** (internal), not `stopNbr`s.

## Step 1 — the client hook: `usePlanning().unplan(list)`

`src/hooks/usePlanning.js:70`

```js
const unplan = useCallback(async (list) => {
  // Group the selected orders by the load they're currently on — removeStops
  // targets ONE load per call, so a selection spanning loads is split up.
  const byLoad = new Map()
  for (const o of list) {
    if (!o.plannedLoadNbr || !o.stopId) continue   // skip unplanned / id-less
    if (!byLoad.has(o.plannedLoadNbr)) byLoad.set(o.plannedLoadNbr, [])
    byLoad.get(o.plannedLoadNbr).push(o)
  }
  if (!byLoad.size) return { ok: false, message: 'Nothing planned to remove.' }

  let total = 0
  const failures = []
  for (const [loadNbr, group] of byLoad) {
    const r = summarize(await removeStops({}, loadNbr, group.map((o) => o.stopId)))
    if (r.ok) {
      total += group.length
      setPlanned(group.map((o) => o.stopNbr), null)   // mark unplanned locally
    } else failures.push(`${loadNbr}: ${r.message}`)
  }
  // ...ok/failure summary
}, [setPlanned])
```

Three things to notice:

1. **Group by `plannedLoadNbr`.** One `removeStops` call = one load. A multi-load
   selection is fanned out into one call per load.
2. **Each order already carries its `stopId`** (created orders store it from their
   create response — `src/lib/createdOrders.js`). That's why unplan needs **no**
   `getStop` read to translate `stopNbr → stopId`.
3. **Local registry update.** On success, `setPlanned(stopNbrs, null)` flips those
   orders to unplanned in the created-orders registry, so the board reflects the
   change immediately with **no refetch**. (The registry is the source of truth for
   the local board; NuVizz is only touched by the write itself.)

## Step 2 — the thin client wrapper

`src/lib/nuvizzWrite.js:230`

```js
export const removeStops = (creds, loadNbr, removeStopIds) =>
  call('removeStops', creds, { loadNbr, removeStopIds })
```

`creds` is `{}` — credentials come from server env, the UI never sends them (see
"Auth & gating" below). `call()` POSTs to the write function and fires the
`dd-api-call` window event so the counter pill refreshes.

## Step 3 — the write function: `case 'removeStops'`

`netlify/functions/nuvizz-write.cjs:164`

```js
case 'removeStops': {
  const { loadNbr, removeStopIds } = req
  if (!loadNbr || !Array.isArray(removeStopIds) || !removeStopIds.length) {
    return json(400, { error: 'removeStops needs loadNbr and removeStopIds[]' })
  }
  // 1) Read the load to get its live header + versionId.
  const info = await nuvizz('GET', `load/info/${encodeURIComponent(loadNbr)}/${cc}`, auth)
  const L = (info.data && (info.data.Load || info.data.load)) || info.data || {}
  const header = L.loadHeader
  if (!header) return json(400, { error: `Load ${loadNbr} not found`, detail: info.data })

  // 2) Echo the WHOLE header back + the stops to drop.
  const payload = {
    loadHeader: toEditHeader(header),   // full field-by-field echo (see below)
    removeStopIds,                      // internal stopIds
    routeSeq: [],
    versionId: String(L.versionId || ''),
  }
  const r = await nuvizz('POST', `load/edit/${cc}`, auth, payload)
  return json(200, r)
}
```

### Why the full-header echo matters — `toEditHeader`

`nuvizz-write.cjs:63`. `load/edit` is a full replace: any header field you don't
send gets **blanked** (depot, facility, volume/weight + UOM, all the reference
fields, vehicle type, custom attributes, …). `toEditHeader` maps every relevant
`load/info` `loadHeader` field into the `load/edit` header shape so nothing is lost.
Two mappings to be aware of:

- `scheduleStartDttm` ← `earliestStartDttm`, `scheduleEndDttm` ← `latestStartDttm`.
- **`seqMode` is forced to `'None'`.** (Shortest-path; we drive real visit order via
  delivery windows elsewhere — see `docs/NUVIZZ_API.md` §10.)

### The exact `load/edit` payload

```json
{
  "loadHeader": { "loadId": "...", "routeName": "...", "depot": {...},
                  "volume": ..., "weight": ..., "seqMode": "None", ... },
  "removeStopIds": ["<stopId>", "<stopId>"],
  "routeSeq": [],
  "versionId": "<versionId from load/info>"
}
```

Reference: `docs/NUVIZZ_API.md` §3.5.

## Success / error parsing

Wrap the response in `summarize()` (`src/lib/nuvizzWrite.js:206`). It treats
**HTTP 2xx with no `reasons` / `error` in the body** as success, and otherwise digs
the reason out of `reasons[0].description` / `apiResult.errors[].msgs` / `error` /
`message`. `load/edit` doesn't return a special success envelope, so this generic
check is the right one (do **not** reuse `assignOk()` — that's only for
`assignanddispatch`, which keys on `status: "Success"`).

## Gotchas checklist

- [ ] **Use `stopId`, not `stopNbr`, in `removeStopIds`.**
- [ ] **Pass `loadNbr`** (human number) to the unplan path, not `loadId`.
- [ ] **Always GET the load first and echo the full header** — partial header = blanked fields.
- [ ] **Include `versionId`** from `load/info` (stringified). Missing/stale versionId → edit rejected.
- [ ] **Include `routeSeq: []`.**
- [ ] **Removing ALL stops cancels the route.** Keep an anchor stop if the load must live.
- [ ] **One load per `removeStops` call.** Group multi-load selections by `loadNbr` first.
- [ ] **Cost = 2 upstream calls per load** (info + edit). Batch all of a load's removals into one call.
- [ ] After success, **update local state** (`setPlanned(stopNbrs, null)`) so the board reflects it without a refetch.

## Auth & gating (why a call might just 403/500)

`nuvizz-write.cjs` header:

- **`NUVIZZ_WRITE_ENABLED` must be exactly `'true'`**, or every call returns **403**.
- Credentials come from server env (`NUVIZZ_DAVIS_COMPANY_CODE` / `_USER` / `_PASS`);
  a request may override them but the UI never does. Missing config → **500**.
- **UAT-only.** Base URL is hard-coded to `uat.nuvizz.com`; a `companyCode` of
  `DAVIS` (prod) is rejected with **400**.

## If local state drifts from NuVizz

The registry's `plannedLoadNbr` is local and can drift (e.g. someone unplanned in
the NuVizz portal). `usePlanning().reconcile()` (`src/hooks/usePlanning.js:100`)
reads each relevant load once, rebuilds the true `stopNbr → loadNbr` membership, and
corrects each order's planned flag. Run it (the **Sync** button, or it auto-runs once
per page load) if the board disagrees with reality after an unplan.

## One-line mental model

> Unplan = "edit the load, minus these stopIds." NuVizz has no delete-stop verb, so
> we read the load, echo its whole header back, and hand `load/edit` a
> `removeStopIds` list + the `versionId`.
