# NuVizz call-reduction — build brief (staged, evidence-gated)

Goal: cut NuVizz API calls by treating **Firestore as the source of truth for the
known board** and calling NuVizz only for **deltas**. Nothing risky goes live
without a flag flip, and every flip is gated on shadow evidence.

## Verified premise (checked against live `/load/info` 2026-06-19)
`/load/info` returns full `stopExecutionInfo` per stop (`stopStatus`, ETA,
`exceptions`, `cancellation`) — same shape `/stop/info` gives. So **delivery
status, exceptions and cancellations all flow from the load scan.** A stop can
only be delivered while on a load. Therefore `/stop/info` is needed ONLY to
discover NEW unplanned orders, plus a periodic safety sweep.

## Risk register (from the adversarial review — must be respected)
- **R1 (blocker):** lean mode sets `partialLoads:true`, which preserves EVERY
  un-rescanned planned stop globally → a stop pulled OFF a load is never
  reclassified. Off-load reconciliation must be **per-load-membership** aware:
  only prune/reclassify a planned stop whose load WAS re-pulled this cycle.
- **R2 (blocker):** terminal loads are never re-probed → a same-day delivery
  correction / re-added stop on a "done" load goes stale forever. Need a
  cool-down (keep terminal loads N cycles) or deep-sweep re-confirm.
- **R3:** "absent from load scans → unplanned" is unsound under lean coverage
  (terminal loads not scanned → ambiguous). Only infer for re-pulled loads.
- **R4:** frontier-only misses orders whose number is BELOW the frontier —
  advance-order stragglers (PRO 7135100) AND orders whose delivery date CHANGES
  to today (old/low number). Deep sweep must use the FULL floor, run before
  ~6 AM ET deliveries.
- **R5:** `scan_state` is date-keyed without a tenant prefix — scope it
  `${tenant}__${date}` before relying on it more heavily.
- **R6:** UTC-day vs ET-day; confirm NuVizz `earliestStartDttm`/`timeFrom`
  timezone so `.slice(0,10)` date bucketing doesn't misclassify near the
  00:00-UTC / ~20:00-ET boundary. (Measured by the date-slice audit.)
- **R7:** cold-start unplanned descent can be truncated by `maxProbes` before
  reaching low stragglers — deep sweep must be a separate, generous pass.
- **R9:** a truncated descent (breaker/budget/cap) ratchets high-water off a
  PARTIAL scan → lean then skips numbers. Persist a `descentComplete` flag; do
  not advance the lean floor on a truncated scan.
- **R10:** manual scans should bypass lean (force wide + full floor) so a human
  "refresh" is always authoritative.
- **R11:** size the forward buffer from the MEASURED p99 of per-cycle
  `Δ maxLoadNbr`, not a guess.

## Staged plan
- **Step 1 — Instrumented shadow (THIS step; zero behaviour change).** Emit the
  evidence + persist the data future steps need. No scanning change; lean/
  frontier stay OFF. Gathers a full day of parity + audit data.
- **Step 2 — Fix the blockers.** Per-load-membership reconciliation (R1),
  terminal cool-down (R2), `descentComplete` gating (R9), manual bypass (R10),
  tenant-scope `scan_state` (R5).
- **Step 3 — Flip lean loads + frontier stops** with an ADAPTIVE buffer sized
  from the measured Δmax-load p99 (R11). Only after Step-1 evidence shows the
  parity gates pass.
- **Step 4 — Periodic deep sweep + known-unplanned re-confirm** (R2/R4/R7
  safety net): a separate, generously-budgeted full-floor pass, ≥1× per ET day
  before deliveries, plus a bounded re-probe of the known-unplanned numbers.

## Parity gates (must hold for a FULL ET day incl. delivery window + UTC rollover)
1. **Load set parity:** every load the wide scan finds is in the lean plan →
   `MISSED_LOADS = []`.
2. **Frontier parity:** no unplanned order is found below the lean frontier
   floor → `BELOW_FLOOR = []` (or every below-floor order is provably caught by
   the deep sweep within its cadence).
3. **Membership:** off-load transitions are observed and would reconcile
   correctly (`LOAD_REMOVED` reflects reality).
4. **Date-slice:** `DATE_SLICE_MISMATCH = 0` near the UTC boundary.
5. **Truncation:** high-water only advanced on `descentComplete = true` scans.
6. **Buffer headroom:** observed max `Δ maxLoadNbr` per cycle < chosen `fwdIn`.

## Step 1 deliverables (zero behaviour change)
- `lib/scan-parity.mts` (PURE, unit-tested): `loadProbeParity`,
  `frontierParity`, `loadMembershipDelta`, `dateSliceMismatch`.
- `ScanState` gains optional additive fields: `loadMembers`,
  `descentComplete`, `observedFrontierStopNbr`.
- `scanUnplannedStops` reports completeness (truncated by cap/budget/breaker?)
  → surfaced on `ScanResult` → persisted.
- The `[scan-shadow]` log line is enriched with the parity + audit metrics
  above (LOGGING ONLY — lean/frontier remain inert).
- `test/scan-parity.test.mjs` covering the real scenarios + edges.

Verification: ≥5 sub-agents review each step from independent angles before it
ships. The production flag flip (Step 3) waits on a full day of green parity.
