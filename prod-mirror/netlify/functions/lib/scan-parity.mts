// PURE shadow-parity helpers — no I/O, no NuVizz, no Firestore. They compare what
// the future LEAN / FRONTIER strategy WOULD have probed against what the live wide
// scan actually found, so we can PROVE (in shadow, before flipping any flag) that
// turning lean on would miss nothing. Unit-tested in test/scan-parity.test.mjs.
//
// All inputs are plain numbers/strings the caller already has (lean targets from
// selectLoadProbeTargets, found load/stop numbers from the wide scan's stops, the
// prior roster's loadMembers). Keeping this dependency-free avoids import cycles
// and makes every gate trivially testable.

export interface LoadProbeParity {
  mode: 'cold' | 'warm';
  /** Load numbers the wide scan FOUND that the lean plan would NOT have probed — the correctness gate (must be []). */
  missed: number[];
  /** Numbers lean WOULD probe that held no load this cycle (informational waste, not a correctness issue). */
  extra: number[];
  foundCount: number;
  targetCount: number;
}

// Compare the lean load-probe target set (or null on a cold cycle where lean
// falls back to the wide window) against the load numbers the wide scan found.
export function loadProbeParity(leanTargets: number[] | null, foundLoadNbrs: number[]): LoadProbeParity {
  const found = [...new Set(foundLoadNbrs.filter((n) => Number.isFinite(n)))];
  if (!leanTargets) return { mode: 'cold', missed: [], extra: [], foundCount: found.length, targetCount: 0 };
  const target = new Set(leanTargets);
  const missed = found.filter((n) => !target.has(n)).sort((a, b) => a - b);
  const foundSet = new Set(found);
  const extra = [...new Set(leanTargets.filter((n) => !foundSet.has(n)))].sort((a, b) => a - b);
  return { mode: 'warm', missed, extra, foundCount: found.length, targetCount: leanTargets.length };
}

export interface FrontierParity {
  /** NEW (not seen last cycle) unplanned orders found below the floor — the harmful misses a frontier probe would drop (R4; gate = []). */
  belowFloorNew: number[];
  /** Below-floor orders already known last cycle — BENIGN (already in Firestore; frontier needn't re-probe). Informational. */
  belowFloorKnown: number[];
  foundCount: number;
  floor: number | null;
}

// Compare the floor a lean frontier descent WOULD use against the unplanned stop
// numbers the full wide descent actually found. A below-floor order only MATTERS
// if it is NEW since last cycle (an advance straggler or a delivery-date-changed
// order that appeared below the frontier) — an already-known below-floor order is
// safe because it is already in Firestore and the frontier never needs it again.
export function frontierParity(
  floor: number | null,
  foundUnplannedNbrs: number[],
  priorKnownNbrs?: number[] | null,
): FrontierParity {
  const found = [...new Set(foundUnplannedNbrs.filter((n) => Number.isFinite(n)))];
  if (floor == null) return { belowFloorNew: [], belowFloorKnown: [], foundCount: found.length, floor: null };
  const known = new Set(priorKnownNbrs || []);
  const below = found.filter((n) => n < floor);
  const belowFloorNew = below.filter((n) => !known.has(n)).sort((a, b) => a - b);
  const belowFloorKnown = below.filter((n) => known.has(n)).sort((a, b) => a - b);
  return { belowFloorNew, belowFloorKnown, foundCount: found.length, floor };
}

export interface MembershipDelta {
  /** Stops on a load LAST cycle, gone THIS cycle while the load is still present — the off-load transition (R1). */
  removed: { loadNbr: string; stopNbr: string }[];
  /** Stops newly on a load this cycle. */
  added: { loadNbr: string; stopNbr: string }[];
}

// Diff per-load membership between the prior scan and this scan. Only loads
// present in BOTH are diffed — a load absent this cycle was terminal-skipped /
// not re-scanned, so its members' absence is NOT a removal (R3 guard).
export function loadMembershipDelta(
  prevMembers: Record<string, string[]> | undefined | null,
  currMembers: Record<string, string[]>,
): MembershipDelta {
  const removed: { loadNbr: string; stopNbr: string }[] = [];
  const added: { loadNbr: string; stopNbr: string }[] = [];
  if (!prevMembers) return { removed, added };
  for (const loadNbr of Object.keys(currMembers)) {
    if (!Object.prototype.hasOwnProperty.call(prevMembers, loadNbr)) continue; // load not in prior → can't infer removal
    const prev = new Set(prevMembers[loadNbr] || []);
    const curr = new Set(currMembers[loadNbr] || []);
    for (const sn of prev) if (!curr.has(sn)) removed.push({ loadNbr, stopNbr: sn });
    for (const sn of curr) if (!prev.has(sn)) added.push({ loadNbr, stopNbr: sn });
  }
  return { removed, added };
}

export interface DateSliceAudit {
  /** Stops whose YYYY-MM-DD slice disagrees with the bucket date — UTC/NuVizz-local drift (R6). */
  mismatch: number;
  /** Stops with a blank/missing date slice — can't be audited (so mismatch=0 isn't falsely reassuring). */
  unauditable: number;
}

// Compare each date string's YYYY-MM-DD slice to the bucket date the scan is filed
// under, surfacing UTC-day vs NuVizz-local-day drift near the midnight-UTC /
// ~20:00-ET boundary (R6). Blanks are counted as `unauditable`, not as matches.
export function dateSliceMismatch(slices: (string | null | undefined)[], bucketDate: string): DateSliceAudit {
  let mismatch = 0, unauditable = 0;
  for (const s of slices) {
    if (!s) { unauditable++; continue; }
    if (String(s).slice(0, 10) !== bucketDate) mismatch++;
  }
  return { mismatch, unauditable };
}
