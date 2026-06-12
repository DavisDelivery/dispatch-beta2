# Beta 2 (dispatch-beta2) — Orchestrator Handoff & Progress Log

*Last updated: Jun 10, 2026.*

This document is a self-contained handoff so a fresh orchestrator session can pick up
without prior context. Read sections 4 and 5 first — they prevent the two mistakes that
have already cost a rebuild.

---

## 1. What this is

**Beta 2** is a standalone, mobile-first logistics cockpit (repo `DavisDelivery/dispatch-beta2`,
Netlify site `dispatch-beta2`) that recreates and improves the NuVizz TMS workflows Davis
Delivery uses daily — over Davis's own data — and will eventually **write loads back into
NuVizz** in a later, separately-authorized phase. For now it is **read-only** against NuVizz.

It is a *separate* app from `DavisDelivery/davis-nuvizz` (the existing live mobile app + the
dispatch-map routing app). Beta 2 must not modify davis-nuvizz.

Starting page set: **Stops, Dashboard, Loads** (the operational core). Route Workbench is a
planned fold-in. Customer 360 and Driver Roster are parked.

---

## 2. Operating model (roles)

- **Orchestrator** (a Claude chat session): evaluates the NuVizz UI, writes Claude Code agent
  briefs, and independently reviews every PR via the GitHub tools. Has a **read-only** GitHub
  connector — see section 4.
- **Agent** (Claude Code, holds Chad's GitHub PAT): executes briefs on a branch, opens a draft PR.
  Single-repo-scoped — see section 4.
- **Chad** (owner): authorizes work, squash-merges PRs, runs the live (P4) tests, sets secrets.

Flow: orchestrator writes a brief → Chad pastes it into a Claude Code session pointed at
dispatch-beta2 → agent executes + opens a draft PR → Chad pastes the agent's summary back →
orchestrator reviews the PR → Chad squash-merges → Chad runs P4.

---

## 3. Repo / infra facts

- Repo: `DavisDelivery/dispatch-beta2`. Default branch `main`. Multi-file routed (react-router):
  `src/pages`, `src/components`, `src/lib`, `netlify/functions`.
- Netlify site: `dispatch-beta2` (under `chad@davisdelivery.com`). Netlify PAT is supplied fresh
  per session by Chad — never stored.
- Single NuVizz HTTP surface: `/.netlify/functions/nuvizz?path=__fleet|__fleetstops|__driver&userName=X|__refreshLoad|__refreshFleet&date=YYYY-MM-DD`.
- Env vars (server-side only; **values never stored in this doc or in client/VITE vars**):
  `NUVIZZ_DAVIS_USER`, `NUVIZZ_DAVIS_PASS`, `NUVIZZ_DAVIS_COMPANY_CODE=DAVIS`,
  `NUVIZZ_BASE_URL=https://portal.nuvizz.com/deliverit/openapi/v7`. Client toggle: `VITE_USE_MOCK_NUVIZZ`.

---

## 4. Hard constraints & lessons (READ FIRST)

1. **The GitHub connector is READ-ONLY on these repos.** The orchestrator can read every repo,
   PR, file, and diff, but every write returns `403 "Resource not accessible by integration"`
   — no branch creation, no commits, no closing PRs, no merges. **All writes go through the
   agent (PAT) or Chad.** Do not promise to push/commit/merge. (To change this, Chad can grant
   the GitHub connector `Contents: write` + `Pull requests: write`.)
2. **Claude Code sessions are single-repo-scoped.** The agent cannot read other repos. This
   already caused a wrong-repo incident: v0.2.0 was first built in `davis-nuvizz` (PR #56,
   discarded) instead of dispatch-beta2. Therefore:
   - **Every brief must open with a hard repo guard:** the agent runs `git remote -v` and STOPS
     if origin is not `DavisDelivery/dispatch-beta2`.
   - Chad must point the Claude Code session at dispatch-beta2 before pasting a brief.
   - Because the agent can't read davis-nuvizz, **the orchestrator must hand it any cross-repo
     facts inside the brief** (e.g. the verified NuVizz contract in section 5).
3. **Mock mode is client-side only.** The Netlify function/client is NOT exercised in mock — the
   preview proves UI + parser, not the wiring. The wiring is only proven by the live test (P4).

---

## 5. Verified NuVizz read contract (authoritative)

Extracted from Davis's real, deployed client (`davis-nuvizz/netlify/functions/nuvizz.cjs`).
This is ground truth — hand it to the agent verbatim whenever NuVizz wiring is in scope.

- **Auth:** stateless HTTP Basic on every request — `Authorization: Basic base64(user:pass)`.
  **No login / JWT / session step.** Company code uppercase (`DAVIS`).
- **No "list loads/stops" endpoint.** Discover loads by **scanning the sequential load-number
  range**: `GET {BASE}/load/info/{loadNbr}/{companyCode}`, where
  `loadNbr = companyCode + 9-digit zero-padded number` (e.g. `DAVIS000196143`). Keep loads whose
  `Load.loadHeader.earliestStartDttm` date == target date.
- **Range estimate:** anchor `2026-06-05` ≈ center `196143` (real range that day 196094–196192);
  ~100 loads per **business** day (Mon–Fri), zero on weekends;
  `center = 196143 + businessDaysBetween("2026-06-05", target) * 100`; window center ± 300.
  Calibrate per date after a scan (min−20 .. max+100), narrow only on ≥50 hits.
- **Per-load response:** `{ Load: { loadHeader, loadAssignment, loadExecutionInfo, stops[] } }`.
  - loadHeader: loadNbr, loadId, routeName, vehicleType, totalPallets, totalCartons, weight,
    weightUOM, volume, volumeUOM, pronbr, reference, earliestStartDttm, latestStartDttm, origin*.
  - loadAssignment: driverName, driverUserName, driverEmail.
  - loadExecutionInfo: loadStatus (Draft/Planned/Dispatched/Cancelled).
- **Per-stop** (`Load.stops[i]` = `s`):
  - `s.stop`: stopNbr, stopType, bol, totalPallets, totalCartons, weight, sealNbr,
    `to.address.{name,addr1,city,state,zip,latitude,longitude}`,
    `to.schedule.{timeFrom,timeTo}` (appt window).
  - comments: flatten `.commentDescription` from `s.stop.comments[]` + `s.stop.to.comments[]`
    + `s.stop.from.comments[]` (the `SPL-INSTR-TEXT:` strings; never drop).
  - `s.stopExecutionInfo.stopStatus`: 90=Delivered, 40=En Route, 30=Scheduled,
    50=Exception (OFTEN FALSE), 10=Created/Pending; plus `exceptionPresent`, `exceptions[]`,
    `to.{plannedEtaDTTM, etaDttm, arrivalDTTM, confirmedDTTM, etaCode, duration}`.
  - `stopSeq` is ALWAYS 1 (useless) → sort by `plannedEtaDTTM`.
  - **True exception** only when `exceptionPresent === true OR exceptions.length > 0` (a bare
    status-50 is frequently a false positive).
- **Speed pattern (how davis-nuvizz is instant):** a scheduled **background** function
  (`fleet-refresh-background.mjs`, cron `*/5 * * * *`, Mon–Fri) runs the full scan off the
  request path and writes a cache; user reads hit the cache in <1s. davis-nuvizz caches to
  Firestore; **beta2 uses Netlify Blobs** to stay standalone.

---

## 6. Architecture decisions

- Standalone repo; not integrated with the other Davis apps (MarginIQ/SENTINEL/Fleet) for now.
- NuVizz read client lives in `netlify/functions/lib/nuvizz.cjs`; the HTTP handler is
  `netlify/functions/nuvizz.cjs`.
- **Cache-first reads** (added in v0.2.1): L1 = 60s in-memory, L2 = Netlify Blobs
  (`netlify/functions/lib/fleetCache.cjs`, keys `fleet:<date>` / `stops:<date>`), L3 = live scan.
  A scheduled background function warms L2 every 5 min (Mon–Fri). Cache failures degrade to live;
  never crash.
- **Read-only against NuVizz.** The write surface exists only as inert markers in
  `loadsModel.writeReadyModel()`: `// TODO(write): POST /load/update` and
  `// TODO(write): POST /load/assignanddispatch`. No write controls in the UI.
- Receiving hours are **soft/advisory only** (`RECEIVING_HOURS_HARD = false`); placeholder
  appointment windows (00:00 / 00:00–23:59 / zero-width / none) are rendered "no appt", never as
  a real appointment.

---

## 7. Progress log (PRs) — all MERGED to `main`

- **#1 v0.1.0** — foundation (routed shell, build badge, sortable tables, 4-page nav).
- **#2 v0.2.0** — verified NuVizz client + Stops/Dashboard/Loads + `parseStopComments.ts` (parser) + chips/cards.
- **#3 v0.2.1** — warm cache + scheduled background refresh (cache-first L1→L2→L3).
- **#4 docs** — this handoff log.
- **#5 v0.3.0** — Route Workbench (driver-grouped route board).
- **#6 v0.3.1** — Stops/chips/cards professional UI polish.
- **#7 v0.4.0** — date selector (`?date`, any business day; `DateNav`).
- **#8 v0.4.1** — consistency polish (Loads status badges, Dashboard, Workbench headers).
- **#9 v0.5.0** — Driver-day view (`/driver/:userName` via `__driver`; reached from Workbench "View day").
- **#10 v0.6.0** — CSV export (Stops + Driver; `csv.js` + tests + `ExportButton`).
- **#11 v0.6.1** — print manifest (`@media print` + `PrintButton`).
- **#12 v0.7.0** — Map view (Leaflet + OSM; `/map`; status-colored markers + popups).
- **#13 v0.7.1** — warm-cache diagnostic (`?path=__cacheDiag`).
- **#14 v0.7.2** — explicit Netlify Blobs config fallback.

(Discarded: davis-nuvizz PR #56 — v0.2.0 built in the wrong repo; ignored/closed.)

---

## 8. Current state / open items

**LIVE.** Production (`dispatch-beta2.netlify.app`) runs on **real NuVizz data**. The site has the
`NUVIZZ_DAVIS_*` secrets + `VITE_USE_MOCK_NUVIZZ=false`; the verified field map is **confirmed against
live data** (the old "P4" is done). The app is a **feature-complete READ-ONLY cockpit**: Dashboard,
Route Workbench, Loads, Stops, Driver-day, Map — plus the shared date selector, CSV export, and print
manifest.

**OPERATING-MODEL UPDATE (supersedes §4 for the current connector).** In this session the orchestrator
had **full GitHub write** (open + squash-merge PRs) and **Netlify access** (set env vars, trigger
deploys) and drove the whole loop itself: spawn agent (isolated git worktree) → review (re-run
tests/build, read the diff, screenshot via headless Chromium) → squash-merge → repeat. §4's
"read-only connector" reflects an EARLIER connector — **verify current capabilities per session.**

**OPEN ITEMS (need Chad):**
1. **Warm-cache token.** Diagnosed via `__cacheDiag`: Netlify isn't auto-injecting
   `NETLIFY_BLOBS_CONTEXT`, so `getStore('fleet')` throws `MissingBlobsEnvironmentError` and reads
   fall back to a live scan (masked by the 60s in-instance L1 cache — warm reads are still sub-second;
   worst case is one ~7s cold scan). Code is ready: `fleetCache.cjs` falls back to explicit
   `getStore({ name, siteID, token })`, and `NETLIFY_SITE_ID` is already set on the site. **To
   activate:** add a `NETLIFY_BLOBS_TOKEN` env var (a Netlify PAT — broad scope, a security call), or
   investigate with Netlify why the auto-context is off (token-free). Then `__cacheDiag` should report
   `roundTrip: true` and `__fleet` returns `source: 'cache'`.
2. **NuVizz write-back** — the north star, still **GATED**. Needs Chad's explicit authorization + the
   agreed guardrails (lowest-blast-radius first, preview-diff, per-write confirm, sandbox-first, undo).
   The seam is `writeReadyModel()` + the `// TODO(write)` markers in `loadsModel.js`.
3. **Fuller Route Workbench** (fold in the dispatch-map routing view) — needs davis-nuvizz routing
   facts from Chad.

**DIAGNOSTIC:** `GET /.netlify/functions/nuvizz?path=__cacheDiag` — read-only Blobs round-trip probe.

---

## 9. Deferred / roadmap

- **Route Workbench** — fold in the dispatch-map routing view (heavier; its own brief).
- **NuVizz write-back phase** — the eventual goal. Guardrails agreed: lowest-blast-radius writes
  first, preview-diff before any write, per-write confirmation, sandbox-first, undo. The
  `writeReadyModel()` values + the `// TODO(write)` markers are the seam. NuVizz stays the system
  of record.
- Re-confirm the receiving-hours posture (soft) with Chad when convenient.

---

## 10. Conventions

**Brief format (orchestrator → agent):**

- One triple-backtick fenced block, no language tag, no nested triple backticks.
- Plain text inside; `=== HEADERS ===`; P1/P2 priority labels; dashes for lists; no markdown headers.
- Open every brief with: (a) the hard repo guard (`git remote -v`, STOP if not dispatch-beta2),
  and (b) an unmerged-work / base-resolution pass.
- When NuVizz wiring is in scope, embed the section-5 contract verbatim (the agent can't read davis-nuvizz).
- Instruct the agent to return its final summary in its OWN fenced block (one-click copy).

**App standing rules:**

- `APP_VERSION` + a persistent build badge (version + 7-char commit + prod|preview) on every page.
- Dates: "Jul 2025" / "Jul 14, 2025"; times 12h ("7:05a"); 4-digit years; never ISO or bare numeric.
- All tables/columns sortable by header click.
- Four-layer data preservation: keep each stop's raw comment string end to end.
- No NuVizz proprietary assets (logos/icons/copy); Davis text branding only.
