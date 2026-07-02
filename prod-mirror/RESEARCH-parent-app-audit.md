# RESEARCH — Parent `davis-nuvizz` App Audit (reference for dispatch-map)

Read-only audit of the parent app at the **repo root** (NOT `/dispatch-map`). Goal: a durable
reference so future dispatch-map milestones don't re-discover how the parent app talks to NuVizz,
Motive, and Firestore. All citations are `path:line` relative to the repo root.

Scope read: `README.md`, `package.json`, `vite.config.js`, `netlify.toml`, `index.html`,
`src/**` (App, main, lib, components, all 7 screens), `netlify/functions/**`
(`nuvizz.cjs`, `dispatch.cjs`, `fleet-refresh-background.mjs`, `nuvizz-probe.js`, `lib/firestore.cjs`).
Total ≈ 5,300 LOC.

---

## 1. ARCHITECTURE OVERVIEW

- **Tech stack:** React 18 SPA + Vite 5, Tailwind 3, `lucide-react` icons. Hosted on Netlify
  (Functions = Node, `esbuild` bundler). No TypeScript in the parent app (plain `.jsx`/`.cjs`/`.mjs`).
  `package.json:2` name `davis-nuvizz`, version **0.2.0** (note: `src/App.jsx:16` hard-codes
  `APP_VERSION = '1.2.0'` — the in-app version and the package version disagree; see §7).
- **Build/deploy:** `netlify.toml:1-4` → `npm run build`, publish `dist/`, functions in
  `netlify/functions`. `vite.config.js:11-14` injects `__BUILD_COMMIT__` / `__BUILD_TIME__` from
  Netlify's `COMMIT_REF` so the running app footer can prove which deploy is live (`src/App.jsx:224-227`).
- **Entry:** `src/main.jsx` mounts `<App/>`. `index.html` is a bare Vite shell.
- **Component tree:** `App` (shell: top bar, tenant switch, **shared date bar**, health banner,
  bottom nav) → one of 7 screens, or a detail view. `src/App.jsx:182-209` is the router.
  - Screens: `Dashboard`, `MapScreen`, `LoadsScreen`, `StopsScreen`, `DriversScreen` +
    detail views `LoadDetail`, `StopDetail` (`src/screens/*`).
  - Shared presentational components in `src/components/UI.jsx` (`StatusPill`, `KPI`,
    `ProgressBar`, `Loading`, `ErrorBox`, `EmptyState`, `TenantSwitch`, `TabBtn`, `Field`).
- **Routing:** No router library. `App` holds `tab` + `detail` state (`src/App.jsx:38-40`) and
  swaps screens with conditional rendering. Cross-screen navigation via callbacks
  (`onOpenLoad`/`onOpenStop`/`goToTab`). Tab-with-filter handoff via `tabFilter` (`src/App.jsx:39,58-61`).
- **State management:** Plain React `useState`/`useEffect`. No Redux/Zustand/Context. Two pieces of
  cross-screen state live in `App` and are passed as props: `tenant` and `viewDate`
  (`src/App.jsx:31-56`). `tenant` persists to `localStorage('dn_tenant')`; `viewDate` is in-memory,
  UTC `YYYY-MM-DD`, shared so switching tabs keeps the day (`src/App.jsx:44-56`).
- **Multi-tenant:** three tenants in `src/lib/api.js:6-10` — `davis`, `uline` (both NuVizz),
  and `glorybound` (Firestore-backed, different data source entirely; see §4).

---

## 2. NUVIZZ INTEGRATION

All NuVizz traffic is proxied through one Netlify function, `netlify/functions/nuvizz.cjs`
(the browser never calls NuVizz directly). Client wrapper: `src/lib/api.js`.

- **Base URLs** (`nuvizz.cjs:31-32`): API `https://portal.nuvizz.com/deliverit/openapi/v7`
  (env `NUVIZZ_BASE_URL`); documents `…/openapi/documentapi` (env `NUVIZZ_DOC_BASE`).
- **Auth pattern — HTTP Basic on every call, NO JWT** (`nuvizz.cjs:4-8, 62-66, 163-188`).
  Despite the README mentioning a `/auth/token` JWT exchange, the live code sends
  `Authorization: Basic base64(user:pass)` directly. Two credential sets, chosen per `tenant`
  query param (`getCreds`, `nuvizz.cjs:47-60`). Documents try **ULINE creds first, DAVIS fallback**
  (`nuvizz.cjs:68-115`). `nuvizz-probe.js:171` is the only place that hits `/auth/token/{company}`
  (just as an auth sanity check before its write-endpoint probe).
- **Core fetch** `nvFetch` (`nuvizz.cjs:163-188`): JSON in/out, bubbles the NuVizz error payload
  (`data.message` / `data.reasons[0].description`) instead of a bare HTTP code.

### Endpoints the parent app calls

Real NuVizz REST paths (via `nvFetch` / `scanFleet.probe` / `fetchDocument`):

| NuVizz path | Method | Where | Purpose |
|---|---|---|---|
| `/load/info/{loadNbr}/{company}` | GET | `nuvizz.cjs:257,272,340,669,1043,1159,1308` | Full load (header, assignment, stops). The workhorse. |
| `/stop/info/{pro}/{company}` | GET | `nuvizz.cjs:657`; `api.js:43` | Single stop by 9-digit PRO. |
| `/stop/info/customer/{company}` | GET | `nuvizz.cjs:249` | All stops in a `fromDTTM..toDTTM` window (the `__today` aggregator path). |
| `/stop/info/__probe__/{company}` | GET | `nuvizz.cjs:609` | Health check — any non-401/403 = auth OK. |
| `/stop/etainfo/{company}?stopNbr=` | GET | `api.js:44-45` | Stop ETA (StopDetail). |
| `/stop/eventinfo/{company}?stopNbr=` | GET | `api.js:46-47`; `nuvizz.cjs:232` | Stop event timeline; also a load-discovery fallback. |
| `/event/eventactivity/{company}?entityType=ROUTE` | GET | `nuvizz.cjs:212` | Load-nbr discovery strategy 1. |
| `/load/static/info/{company}?routeDate=` | GET | `nuvizz.cjs:222` | Load-nbr discovery strategy 2. |
| `/user/info/{company}?userName=` | GET | `nuvizz.cjs:965` | Driver profile sanity. |
| `/doc/getdocument/{company}?documentGuid&objectType&extension` | GET | `nuvizz.cjs:89` | Document/POD bytes (base64). |

Server-side aggregator/synthetic paths (the client always calls these via `?path=__…`, never the
raw REST paths above except indirectly). Handler dispatch at `nuvizz.cjs:586-1342`:

| Synthetic `path` | Returns | Citation |
|---|---|---|
| `__health` | per-tenant auth check | `nuvizz.cjs:602-617` |
| `__today` / `__daterange` | stops+loads+summary for a window (stop-customer search → parallel load fetch) | `nuvizz.cjs:620-635`, `fetchLoadsAndStopsForRange:243-283` |
| `__loadsbydate` | unique loadNbrs for a date | `nuvizz.cjs:638-642` |
| `__lookup&pro=` | normalized PRO → stop + parent load + stops-away | `nuvizz.cjs:648-698` |
| `__doc&guid=&ext=` | document data URI (dual-cred + tracking-chain fallback) | `nuvizz.cjs:703-725` |
| `__fleet` | dispatch board (loads+summary) for a date | `nuvizz.cjs:732-820` |
| `__fleetstops` | flat stop list across loads (Map/Stops) | `nuvizz.cjs:826-946` |
| `__driver&userName=` | one driver's loads+stops for a day | `nuvizz.cjs:952-1144` |
| `__refreshLoad&loadNbr=` | live re-fetch one load, rewrite its Firestore doc | `nuvizz.cjs:1151-1256` |
| `__refreshFleet` | full scan + Firestore rewrite, return summary | `nuvizz.cjs:1262-1297` |
| `__stopsaway&loadNbr=&stopNbr=` | count of undelivered stops before a stop | `nuvizz.cjs:1301-1322` |
| anything else | raw passthrough to NuVizz | `nuvizz.cjs:1324-1334` |

### The "no list-loads endpoint" problem and the **fleet scan** (critical pattern)

NuVizz v7 has **no native "list today's loads" endpoint**. The app works around this by probing a
**range of sequential load numbers** in parallel (`scanFleet`, `nuvizz.cjs:333-446`):
- Load numbers are `{COMPANY}{9-digit zero-padded}` and roughly sequential (~80–100/day,
  `nuvizz.cjs:531`).
- `estimateLoadRange` (`nuvizz.cjs:536-550`) guesses a ±250 window from an anchor
  (`ANCHOR_DATE 2026-04-22`, `ANCHOR_LOAD 192900`, `nuvizz.cjs:529-531`).
- `calibrateLoadRange` (`nuvizz.cjs:564-583`) narrows the cached window to the actual min/max found
  (pad −20 low / +100 high for late dispatches), TTL 10 min, only if ≥50 loads found.
- Scan runs at concurrency 30, descending, filtering each load to the target date by
  `loadHeader.earliestStartDttm` (`nuvizz.cjs:348-350`).

> **Note for dispatch-map:** dispatch-map's `lib/nuvizz-scan.mts` is a TypeScript descendant of this
> exact technique (same anchor/loads-per-day idea), plus a separate stop-number "unplanned" descent
> the parent app does not have.

### Request / response shapes (normalization)

- **Raw NuVizz stop** = `{ stop, stopExecutionInfo, load }`. `stop.to.address` / `stop.from.address`
  by `stopType` (DO vs PU). Client normalizer `src/lib/normalize.js:44-160` flattens this; server
  `scanFleet` builds a slim stop at `nuvizz.cjs:391-424`.
- **Raw NuVizz load** = `{ Load: { loadHeader, loadAssignment, loadExecutionInfo, stops[] } }`.
  Client `normalizeLoad` `normalize.js:163-228`.
- **Status codes** (`normalize.js:4-24`, `StopDetail.jsx:15-22`): `10`=Created, `30`=Scheduled,
  `40`=Out-for-Delivery/Arrived/In-Transit, `50`=Exception, `90`=Delivered. (Parent app does **not**
  reference code `20`, which dispatch-map sees on planned stops — worth reconciling.)
- **Key timestamp fields** live under `stopExecutionInfo.to` (DO) / `.from` (PU):
  `plannedEtaDTTM`, `etaDttm`, `arrivalDTTM`, `departureDTTM`, `confirmedDTTM`, `duration`,
  `etaCode` (`normalize.js:120-126`; `nuvizz.cjs:413-417`).

### How status changes are detected — **NO realtime; cron + on-demand pull**

- **No polling, no websockets, no webhooks** anywhere in the client. A repo-wide search for
  `setInterval` in `src/` returns nothing. Screens fetch **once on mount / on `viewDate` change**
  and otherwise only on an explicit user "refresh" tap.
- Freshness comes from the **server side**: a scheduled function pre-warms Firestore every 5 min
  (`fleet-refresh-background.mjs`, §4/§5), and screens read that cache. So "live status" =
  *cron cadence (≤5 min) + the user reloading the screen*.
- Detail screens force freshness on open: `StopDetail`/`LoadDetail` call `__refreshLoad`
  (single live NuVizz call, ~1s) so the screen you're staring at is current
  (`api.js:88-90`; `nuvizz.cjs:1146-1256`). `Dashboard` has a manual `refreshFleet` button
  (~10–12s full scan, `Dashboard.jsx:41-42`).

### Driver-level scoping (per-driver vs all-driver)

- `__driver` (`nuvizz.cjs:952-1144`) is **per-driver and deliberately fresh**: it reads the Firestore
  `driverIndex` (userName → [loadNbr]) to find just that driver's loads, then **re-fetches each of
  those loads live** from NuVizz (`nuvizz.cjs:1036-1058`) rather than serving the whole-fleet cache.
- Fallbacks if the index is missing: in-memory fleet cache → Firestore `listLoads` → full scan
  (`nuvizz.cjs:988-1023`), then text-match on `driverUserName` / `driverName`.
- Stop ordering within a driver-day uses **`plannedEtaDTTM`, not `stopSeq`** — see §7 gotcha
  (`nuvizz.cjs:1086-1099`).
- The full roster is a **baked-in registry** `DAVIS_DRIVERS` (35 drivers, userName/name/userId/status)
  in `src/lib/api.js:98-134`, discovered by probing `/user/info`. `DriversScreen` filters to
  `status === 'ENABLED'` (`DriversScreen.jsx:61`).

---

## 3. MOTIVE INTEGRATION

**None in the parent app.** Repo-wide search for `motive|gps|keeptruckin` across `src/` and
`netlify/functions/` returns nothing. The README lists "Motive GPS overlay on map" as a *future*
item (`README.md:121`), and the Map screen draws stops/routes only, with no live truck layer.

> Motive lives in **dispatch-map**, not here: dispatch-map ships `netlify/functions/motive-driver-positions`
> and a "Show vehicle location" toggle. If a future task needs truck-to-driver mapping, treat
> dispatch-map as the source of truth, not the parent app.

---

## 4. FIRESTORE / FIREBASE USAGE

The parent app touches **two different Firebase projects** for two unrelated purposes:

### (a) `davismarginiq` — the NuVizz fleet cache (`netlify/functions/lib/firestore.cjs`)
- **Project:** `davismarginiq` (resolved at runtime from the service account's `project_id`,
  `firestore.cjs:158`).
- **Auth:** service-account JSON in env `FIREBASE_SA`; the lib signs an RS256 JWT and exchanges it
  at `oauth2.googleapis.com/token` for a datastore access token, cached in-memory ~50 min
  (`firestore.cjs:25-90`). Talks to the Firestore **REST** API directly (no Admin SDK).
- **Collections / schema** (`firestore.cjs:9-17`):
  - `nuvizzFleet/{tenant}__{date}` — parent doc (e.g. `davis__2026-04-25`); double-underscore key
    because the REST API needs each path level to be a real doc (`firestore.cjs:215-217`).
  - `nuvizzFleet/{tenant}__{date}/loads/{loadNbr}` — one doc per load (incl. inline `stops[]`).
  - `nuvizzFleet/{tenant}__{date}/meta/summary` — aggregate stats.
  - `nuvizzFleet/{tenant}__{date}/meta/driverIndex` — `{ map: { userName: [loadNbr] } }`.
- **Read vs write:**
  - **Writes:** only from `nuvizz.cjs` after a live scan (`writeFleetToFirestore`, `nuvizz.cjs:498-521`)
    — batches of 10 load docs + summary + driver index. Triggered by `__fleet`/`__fleetstops`/
    `__driver`/`__refreshLoad`/`__refreshFleet` and by the cron (§5).
  - **Reads:** `readFleetFromFirestore` (`nuvizz.cjs:476-494`) with a **10-min staleness gate**
    (`FLEET_FIRESTORE_MAX_AGE_MS`, `nuvizz.cjs:473`) — older than that → fall back to live scan.
- Helpers: `readLoad/writeLoad/listLoads/readSummary/writeSummary/readDriverIndex/writeDriverIndex`
  (`firestore.cjs:219-259`). REST value encode/decode at `firestore.cjs:95-152`.

> dispatch-map's `lib/firestore.mts` is the TypeScript port of this exact client (same JWT flow,
> same value-encoding), but writes a different collection (`nuvizz_stop_index`) — confirmed by the
> M5.2 commit history.

### (b) `glorybounddispatch` — the Glory Bound manifest source (`netlify/functions/dispatch.cjs`)
- A **separate** Firestore project read by the `dispatch` function for the `glorybound` tenant
  (Emser, Florida Tile, etc.), blended into the same dashboard UI shape.
- **Project:** `glorybounddispatch`, base URL hard-coded `dispatch.cjs:18`.
- **Auth:** the **public Firebase web API key** via env `GLORYBOUND_FIREBASE_KEY`, appended as
  `?key=` (`dispatch.cjs:19,242`). The code explicitly notes this key is a public identifier and
  security is enforced by **Firestore rules**, not key secrecy; it's in an env var only so Netlify's
  secret scanner doesn't block deploys (`dispatch.cjs:14-23`).
- **Schema:** `manifests/{YYYY-MM-DD}` → `{ entries: [...], updatedAt }` (`dispatch.cjs:12,241-249`).
- **Read-only.** Paths `__today` / `__date` / `__range` (`dispatch.cjs:266-329`). `entryToStop`
  (`dispatch.cjs:53-142`) maps a manifest entry into the same normalized stop shape as NuVizz so the
  UI is source-agnostic.

### Security rules
Not present in this repo — both projects' rules live server-side in Firebase, not in source. The
`davismarginiq` project is reached with a privileged **service account** (full datastore scope,
`firestore.cjs:53`), so rules are effectively bypassed for that path; `glorybounddispatch` is reached
with a public key and *relies* on rules. **Not investigated** (no access) — see §9.

---

## 5. CACHING + RATE-LIMITING

- **Three-layer fleet cache** (read order, `nuvizz.cjs:736-819`):
  1. **In-memory** `__fleetCache` Map, **60 s TTL**, per warm function instance, keyed
     `tenant:date` (+`:stops`) (`nuvizz.cjs:451-466`). Evicts oldest past size 50.
  2. **Firestore** (cross-instance), **10-min** staleness gate (`nuvizz.cjs:473-494`).
  3. **Live scan** fallback (~10–12 s) which then writes back to layers 1 & 2.
  - `X-Cache` response header reports `HIT-MEM` / `HIT-FS` / `MISS`. `?nocache=1` bypasses 1+2.
- **Range-calibration cache** `__rangeCache`, 10-min TTL (`nuvizz.cjs:534-583`) — narrows the
  scan window per date so repeat scans are tight/fast.
- **Token cache:** Firestore access token in-memory ~50 min (`firestore.cjs:43-44,85-89`).
- **Scheduled pre-warm:** `fleet-refresh-background.mjs` runs **`*/5 * * * *`** (`:65-67`) but
  **skips Sat/Sun in-handler** via `getUTCDay()` (`:23-27`). For each tenant it calls
  `__refreshFleet` against its own site (`process.env.URL`/`DEPLOY_URL`, `:16,35`). This is what keeps
  user-facing reads sub-second during the week.
- **Concurrency limiting (not rate-limiting):** `parallelMap` cap 5 for load detail fetches
  (`nuvizz.cjs:191-203`); scans run at concurrency 20–30 (`nuvizz.cjs:333,783`). There is **no
  explicit rate-limit / backoff / retry** against NuVizz — failed probes just return `null`
  (`nuvizz.cjs:343,427`) and the load is silently omitted.
- **502 / timeout handling:** `netlify.toml:10-13` raises the `nuvizz` & `dispatch` sync-function
  timeout to **26 s** (Pro plan max). Individual probe failures are swallowed (`null`); top-level
  errors return `{ error, detail }` with the NuVizz status (`nuvizz.cjs:1335-1340`). There is no
  circuit-breaker. (This 26 s ceiling is exactly the constraint that pushed **dispatch-map** to move
  its scan to a background function — see dispatch-map's `nuvizz-pull-today-stops` / RESEARCH-m5.md.)

---

## 6. ENVIRONMENT VARIABLES (names only)

From a `process.env` grep across `netlify/functions/**`:

| Var | Used for | Citation |
|---|---|---|
| `NUVIZZ_DAVIS_COMPANY_CODE` | Davis tenant company code (default `DAVIS`) | `nuvizz.cjs:56` |
| `NUVIZZ_DAVIS_USER` / `NUVIZZ_DAVIS_PASS` | Davis Basic-auth creds | `nuvizz.cjs:57-58` |
| `NUVIZZ_ULINE_COMPANY_CODE` | Uline tenant company code (default `ULINE`) | `nuvizz.cjs:50` |
| `NUVIZZ_ULINE_USER` / `NUVIZZ_ULINE_PASS` | Uline Basic-auth creds (doc retrieval) | `nuvizz.cjs:51-52` |
| `NUVIZZ_BASE_URL` | NuVizz v7 API base (override) | `nuvizz.cjs:31`; `nuvizz-probe.js:21` |
| `NUVIZZ_DOC_BASE` | NuVizz document API base | `nuvizz.cjs:32` |
| `NUVIZZ_COMPANY` / `NUVIZZ_USER` / `NUVIZZ_PASS` | **legacy fallbacks**, only `nuvizz-probe.js` | `nuvizz-probe.js:18-20` |
| `FIREBASE_SA` | `davismarginiq` service-account JSON (fleet cache auth) | `firestore.cjs:27,34` |
| `GLORYBOUND_FIREBASE_KEY` | `glorybounddispatch` public web API key | `dispatch.cjs:19` |
| `URL` / `DEPLOY_URL` | Netlify-provided site URL (background fn self-call) | `fleet-refresh-background.mjs:16` |
| `COMMIT_REF` | Netlify-provided, build-stamp (vite define) | `vite.config.js:6` |

(Client reads no `VITE_*` vars; all secrets stay server-side in the functions.)

---

## 7. KNOWN QUIRKS / GOTCHAS

- **PRO numbers = 9 digits, zero-padded**, e.g. `7100000` → `007100000`. Normalizer strips leading
  zeros then re-pads (`nuvizz.cjs:38-45`; client mirror `api.js:53-60`). URL param order is
  **stopNumber FIRST, then companyCode** (`nuvizz.cjs:14`). Inputs > 9 digits are passed through as-is.
- **`stopStatus = 50` is not always a real exception.** When `exceptions[]` is empty and
  `exceptionPresent` is false, the driver just didn't tap "Complete" — paperwork, not a problem.
  Both the server scan (`nuvizz.cjs:353-360`) and client normalizer (`normalize.js:72-89`) reclassify
  those to `inProgress` (if arrived) or `pending` so they don't inflate the dispatcher's issue count.
- **`stopSeq` is unreliable — it's almost always `1`.** Driver-day ordering uses `plannedEtaDTTM`
  instead, with a synthetic `displaySeq` assigned post-sort (`nuvizz.cjs:1086-1099`).
- **`confirmedDTTM` is the real delivery time**, NOT `createdDTTM` (explicit per the integration
  guide, `StopDetail.jsx:5-6,136,209`).
- **NuVizz ETAs run optimistic** — `StopDetail` displays them as a rounded **1-hour window** rather
  than a precise time (`StopDetail.jsx:24-32`).
- **Documents frequently 404 on the direct API** (`reasonCode 923`) despite valid auth; the tracker
  portal uses an `X-API-KEY` header the app doesn't have. Hence the **dual strategy**: try direct
  (ULINE→DAVIS × several `objectType`s), then **chain to `tracking.davisdelivery.com/.netlify/
  functions/doc`** as the working fallback (`nuvizz.cjs:68-149`).
- **Dates/timezones:** the client computes `viewDate` in **UTC** (`src/App.jsx:25-28`), and the
  date bar renders with `timeZone: 'UTC'` (`App.jsx:143`). But the `__today` window in the function
  is built from **server-local** `now.getFullYear()/getMonth()/getDate()` (`nuvizz.cjs:621-623`).
  Mixing UTC (client) and server-local (function) day boundaries is a latent source of off-by-one-day
  edge cases around midnight. The background cron also keys "today" off `new Date().toISOString()`
  (UTC) (`fleet-refresh-background.mjs:22`).
- **Weekend handling is doubled:** the cron skips Sat/Sun (`fleet-refresh-background.mjs:23-27`) and
  the client date-stepper has `goToPrevBusinessDay` (`App.jsx:52-56`). Davis doesn't dispatch weekends.
- **Version drift:** `package.json` says `0.2.0` but `App.jsx:16` hard-codes `1.2.0`; the README's
  file map describes an older 238-line `nuvizz.js` while the live file is 1,342 lines of `.cjs`.
  Treat the README's line counts as stale; trust the code.
- **No TODO/FIXME markers** were found in the parent source, but the README "Next" list
  (`README.md:116-121`) doubles as the de-facto backlog (actions-from-detail, historical ranges,
  Uline billing reconcile, Motive overlay, PWA).

---

## 8. REUSABLE PATTERNS FOR DISPATCH-MAP

- **Firestore-over-REST client** (`firestore.cjs`) is the canonical implementation — JWT-sign →
  token-exchange → typed value encode/decode → get/set/list. dispatch-map already ported it; keep them
  in sync (e.g. paging cap 300, in-memory token cache).
- **Load-number range scan + calibration** (`scanFleet`, `estimateLoadRange`, `calibrateLoadRange`)
  is the proven answer to "NuVizz has no list endpoint." dispatch-map's scan derives from it.
- **Three-layer cache discipline** (mem 60 s → Firestore 10 min → live) with an `X-Cache` header is a
  clean, debuggable model worth mirroring for any new heavy endpoint.
- **`status=50` reclassification** and **`plannedEtaDTTM`-based ordering** are correctness rules
  dispatch-map must honor too (its `classifyStopStatus` already buckets 50→EXCEPTION only on real
  exception data; the ordering rule is worth double-checking in dispatch-map's stop sort).
- **Idempotent normalizers** (`normalize.js:48-50,164-167`) let pre-normalized (Firestore) and raw
  (NuVizz) payloads flow through one render path — a nice pattern for dispatch-map's mixed sources.

### Real-time status updates — can dispatch-map borrow the pattern?
The parent app has **no true realtime** — it's **scheduled-pull**: a 5-min cron writes Firestore and
clients read on mount / manual refresh, with detail screens doing a single live `__refreshLoad` for
freshness. dispatch-map already adopted the *better* version of this (M5.2 background writer + instant
Firestore reads), and this milestone widened that cron to **24/7 `*/5 * * * *`**. So the borrowable
pattern is exactly what dispatch-map now runs; the parent app's extra trick worth copying is the
**per-entity live refresh on open** (`__refreshLoad`) — when a user focuses one load/stop/driver,
re-fetch just that entity live instead of waiting for the next cron tick. True push (websockets/SSE)
does not exist in either app and would be net-new; NuVizz exposes no webhook the code uses.

---

## 9. DEFERRED / NOT INVESTIGATED

- **Firestore security rules** for both `davismarginiq` and `glorybounddispatch` — not in this repo
  (configured in Firebase consoles). Couldn't verify what the public `glorybound` key is actually
  allowed to read.
- **The `tracking.davisdelivery.com` doc function** — referenced as a fallback (`nuvizz.cjs:121`) but
  its source lives in a different repo; its exact auth/`X-API-KEY` handling is unknown.
- **NuVizz write/admin endpoints** — `nuvizz-probe.js` is a *discovery* tool (read-safe, never run as
  part of the app). Which of its probed paths (`/stop/status`, `/load/dispatch`, `/load/assign`, etc.)
  actually work is **not determined here** — running `?run=yes` against production would be required,
  and that's out of scope for a read-only audit. This is the key unknown blocking the README's
  "actions from detail screens" feature.
- **`@netlify/blobs` dependency** (`package.json:12`) is installed but I found no import of it in the
  source read — possibly vestigial or used only by tooling. Not confirmed.
- **The parent app's own Netlify site/deploy wiring** — `.netlify/state.json` in this repo points at
  the *dd-dispatch-map* site id, so the parent `davis-nuvizz` site is configured elsewhere; its
  exact site name/env config wasn't confirmed from source (the probe comments reference
  `davis-warehouse-wms.netlify.app`, which may be a third related site).
- **Exact NuVizz response schemas** beyond the fields the code consumes — only the consumed subset is
  documented above; the full `/load/info` and `/stop/info` payloads have many more fields.
