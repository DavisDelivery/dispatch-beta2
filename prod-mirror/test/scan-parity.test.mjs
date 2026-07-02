// test/scan-parity.test.mjs — Step 1 shadow-parity helpers (call-reduction).
// Pure logic only: compare what lean/frontier WOULD probe vs what a wide scan
// found, plus the buildScanState additions that feed the parity log. No I/O.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadProbeParity, frontierParity, loadMembershipDelta, dateSliceMismatch } from '../netlify/functions/lib/scan-parity.mts';
import { buildScanState, groupLoadMembers } from '../netlify/functions/lib/nuvizz-scan.mts';

// ── loadProbeParity ──────────────────────────────────────────────────────────
test('loadProbeParity: cold cycle (null targets) → never reports a miss', () => {
  const r = loadProbeParity(null, [100, 101, 102]);
  assert.equal(r.mode, 'cold');
  assert.deepEqual(r.missed, []);
  assert.deepEqual(r.extra, []);
  assert.equal(r.foundCount, 3);
});

test('loadProbeParity: warm, all found loads covered → MISSED empty, extra = probed-but-empty', () => {
  const r = loadProbeParity([100, 101, 102, 103], [101, 102]);
  assert.equal(r.mode, 'warm');
  assert.deepEqual(r.missed, []);
  assert.deepEqual(r.extra, [100, 103]); // probed, no load there (informational)
  assert.equal(r.targetCount, 4);
});

test('loadProbeParity: a found load NOT in the lean plan is flagged as MISSED (gate failure)', () => {
  const r = loadProbeParity([100, 101], [100, 101, 199]); // 199 appeared, lean would skip it
  assert.deepEqual(r.missed, [199]);
});

test('loadProbeParity: dedups found, sorts missed ascending', () => {
  const r = loadProbeParity([1], [9, 3, 9, 3, 1]);
  assert.deepEqual(r.missed, [3, 9]);
  assert.equal(r.foundCount, 3);
});

test('loadProbeParity: empty wide scan (no loads found) gates clean', () => {
  const r = loadProbeParity([100, 101], []);
  assert.deepEqual(r.missed, []);       // nothing found → nothing missed
  assert.deepEqual(r.extra, [100, 101]); // probed-but-empty (informational)
  assert.equal(r.foundCount, 0);
});

test('loadProbeParity: filters non-finite found values (NaN/Infinity)', () => {
  const r = loadProbeParity([100], [NaN, Infinity, -Infinity, 100, 200]);
  assert.deepEqual(r.missed, [200]);    // only the real, finite, uncovered load
});

// ── frontierParity ───────────────────────────────────────────────────────────
test('frontierParity: null floor → nothing flagged', () => {
  const r = frontierParity(null, [1, 2, 3]);
  assert.deepEqual(r.belowFloorNew, []);
  assert.deepEqual(r.belowFloorKnown, []);
});

test('frontierParity: all above floor → clean', () => {
  const r = frontierParity(7_134_800, [7_135_000, 7_135_100]);
  assert.deepEqual(r.belowFloorNew, []);
  assert.deepEqual(r.belowFloorKnown, []);
});

test('frontierParity: a NEW below-floor order is a harmful miss; a KNOWN one is benign', () => {
  // floor 7_134_800. 7_133_000 is below. It is NEW (not in priorKnown) → harmful.
  const newMiss = frontierParity(7_134_800, [7_135_000, 7_133_000], [7_120_000]);
  assert.deepEqual(newMiss.belowFloorNew, [7_133_000]);
  assert.deepEqual(newMiss.belowFloorKnown, []);
  // Same number, but it WAS known last cycle → benign (already in Firestore).
  const known = frontierParity(7_134_800, [7_135_000, 7_133_000], [7_133_000]);
  assert.deepEqual(known.belowFloorNew, []);
  assert.deepEqual(known.belowFloorKnown, [7_133_000]);
});

test('frontierParity: PRO 7135100-style advance straggler (low number, new) is caught as harmful', () => {
  // High-water ~7_136_000 → floor ~7_135_800; the straggler 7_135_100 is below + new.
  const r = frontierParity(7_135_800, [7_136_050, 7_135_100], [7_136_000, 7_135_900]);
  assert.deepEqual(r.belowFloorNew, [7_135_100]);
});

test('frontierParity: floor is STRICT < (a stop exactly AT the floor is not below)', () => {
  const r = frontierParity(100, [99, 100, 101], []);
  assert.deepEqual(r.belowFloorNew, [99]); // 100 is NOT < 100
});

test('frontierParity: empty descent → clean', () => {
  const r = frontierParity(7_135_000, [], [7_134_500]);
  assert.deepEqual(r.belowFloorNew, []);
  assert.equal(r.foundCount, 0);
});

test('frontierParity: undefined priorKnown → below-floor orders all count as new (first warm cycle)', () => {
  const r = frontierParity(100, [50, 60], undefined);
  assert.deepEqual(r.belowFloorNew, [50, 60]);
});

// ── loadMembershipDelta ──────────────────────────────────────────────────────
test('loadMembershipDelta: no prior → empty', () => {
  const r = loadMembershipDelta(null, { L1: ['s1', 's2'] });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.added, []);
});

test('loadMembershipDelta: stop pulled OFF a still-present load is a removal (R1 evidence)', () => {
  const r = loadMembershipDelta({ L1: ['s1', 's2', 's3'] }, { L1: ['s1', 's3'] });
  assert.deepEqual(r.removed, [{ loadNbr: 'L1', stopNbr: 's2' }]);
  assert.deepEqual(r.added, []);
});

test('loadMembershipDelta: stop added to a load', () => {
  const r = loadMembershipDelta({ L1: ['s1'] }, { L1: ['s1', 's9'] });
  assert.deepEqual(r.added, [{ loadNbr: 'L1', stopNbr: 's9' }]);
  assert.deepEqual(r.removed, []);
});

test('loadMembershipDelta: a load absent from THIS cycle is NOT a removal (R3 guard)', () => {
  // L2 was terminal-skipped / not re-scanned this cycle → its members must not
  // be reported as removed (absence is ambiguous, not a real off-load event).
  const r = loadMembershipDelta({ L1: ['s1'], L2: ['s2', 's3'] }, { L1: ['s1'] });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.added, []);
});

test('loadMembershipDelta: identical membership → no churn', () => {
  const r = loadMembershipDelta({ L1: ['s1', 's2'] }, { L1: ['s1', 's2'] });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.added, []);
});

test('loadMembershipDelta: total replacement of a load\'s members', () => {
  const r = loadMembershipDelta({ L1: ['s1', 's2', 's3'] }, { L1: ['s9', 's10'] });
  assert.deepEqual(r.removed.map((x) => x.stopNbr).sort(), ['s1', 's2', 's3']);
  assert.deepEqual(r.added.map((x) => x.stopNbr).sort(), ['s10', 's9']);
});

// ── groupLoadMembers ─────────────────────────────────────────────────────────
test('groupLoadMembers: groups planned stops by load, ignores unplanned, sorts', () => {
  const stops = [
    { stopNbr: '7002', loadNbr: 'L1', isPlanned: true },
    { stopNbr: '7001', loadNbr: 'L1', isPlanned: true },
    { stopNbr: '8000', loadNbr: 'L2', isPlanned: true },
    { stopNbr: '9999', loadNbr: null, isPlanned: false }, // unplanned → ignored
    { stopNbr: '7003', isPlanned: true },                  // no loadNbr → ignored
  ];
  assert.deepEqual(groupLoadMembers(stops), { L1: ['7001', '7002'], L2: ['8000'] });
});

test('groupLoadMembers: empty / nullish input → {}', () => {
  assert.deepEqual(groupLoadMembers([]), {});
  assert.deepEqual(groupLoadMembers(null), {});
});

test('groupLoadMembers: dedups a stop listed twice on the same load', () => {
  const stops = [
    { stopNbr: '7001', loadNbr: 'L1', isPlanned: true },
    { stopNbr: '7001', loadNbr: 'L1', isPlanned: true },
  ];
  assert.deepEqual(groupLoadMembers(stops), { L1: ['7001'] });
});

test('groupLoadMembers: numeric and string stopNbr coerce to the same key', () => {
  const stops = [
    { stopNbr: 7001, loadNbr: 'L1', isPlanned: true },
    { stopNbr: '7001', loadNbr: 'L1', isPlanned: true },
  ];
  assert.deepEqual(groupLoadMembers(stops), { L1: ['7001'] });
});

// ── dateSliceMismatch ────────────────────────────────────────────────────────
test('dateSliceMismatch: counts disagreeing slices + unauditable blanks separately', () => {
  const slices = ['2026-06-19T09:00:00', '2026-06-18T23:00:00', null, '', '2026-06-19'];
  const r = dateSliceMismatch(slices, '2026-06-19');
  assert.equal(r.mismatch, 1);       // only the 06-18 one
  assert.equal(r.unauditable, 2);    // null + '' — so mismatch=0 isn't falsely reassuring
});

// ── buildScanState additions (feed the parity log) ───────────────────────────
const planned = (stopNbr, loadNbr, status = 'SCHEDULED') => ({ stopNbr, loadNbr, isPlanned: true, normalizedStatus: status, routeName: null });
const unplanned = (stopNbr) => ({ stopNbr, loadNbr: null, isPlanned: false });

test('buildScanState: persists loadMembers from the scan (numeric order)', () => {
  const s = buildScanState('2026-06-19', [planned('7002', 'DAVIS000196001'), planned('70010', 'DAVIS000196001'), planned('7009', 'DAVIS000196001')], null, 'T0');
  assert.deepEqual(s.loadMembers, { DAVIS000196001: ['7002', '7009', '70010'] }); // numeric, not lexicographic
});

test('buildScanState: cold start seeds highWater + unplanned set from scratch', () => {
  const s = buildScanState('2026-06-19', [unplanned('7136000'), planned('7001', 'DAVIS000196001')], null, 'T0', { descentComplete: true });
  assert.equal(s.highWaterStopNbr, 7136000, 'max over ALL stops');
  assert.equal(s.highWaterUnplannedStopNbr, 7136000, 'max over UNPLANNED only');
  assert.deepEqual(s.unplannedStopNbrs, [7136000]);
  assert.equal(s.descentComplete, true);
});

test('buildScanState: known-unplanned set refreshes only on a COMPLETE descent', () => {
  const prev = buildScanState('2026-06-19', [unplanned('7135900'), unplanned('7135800')], null, 'T0', { descentComplete: true });
  assert.deepEqual(prev.unplannedStopNbrs, [7135800, 7135900]);
  // Load-only cycle (no descent) must NOT wipe the known set.
  const loadOnly = buildScanState('2026-06-19', [planned('7001', 'DAVIS000196001')], prev, 'T1');
  assert.deepEqual(loadOnly.unplannedStopNbrs, [7135800, 7135900]);
  // A fresh COMPLETE descent refreshes it.
  const rescan = buildScanState('2026-06-19', [unplanned('7136000')], prev, 'T2', { descentComplete: true });
  assert.deepEqual(rescan.unplannedStopNbrs, [7136000]);
});

test('buildScanState (R9): a TRUNCATED descent must NOT advance high-water or refresh the known set', () => {
  const prev = buildScanState('2026-06-19', [unplanned('7135900')], null, 'T0', { descentComplete: true });
  // Truncated descent that happened to find a HIGHER number — must be ignored.
  const truncated = buildScanState('2026-06-19', [unplanned('7136500')], prev, 'T1', { descentComplete: false });
  assert.equal(truncated.highWaterUnplannedStopNbr, 7135900, 'high-water frozen on truncated descent');
  assert.deepEqual(truncated.unplannedStopNbrs, [7135900], 'known set carried, not overwritten by partial');
  assert.equal(truncated.descentComplete, false);
});

test('buildScanState: kill-switch / empty scan (descentComplete undefined) carries the prior set', () => {
  const prev = buildScanState('2026-06-19', [unplanned('7135900'), unplanned('7135800')], null, 'T0', { descentComplete: true });
  const killed = buildScanState('2026-06-19', [], prev, 'T1'); // empty stops, no extra
  assert.deepEqual(killed.unplannedStopNbrs, [7135800, 7135900], 'empty scan must not wipe the known set');
  assert.equal(killed.highWaterUnplannedStopNbr, 7135900);
});

test('buildScanState: descentComplete + observedFrontier carried across a load-only cycle', () => {
  const prev = buildScanState('2026-06-19', [unplanned('7135900')], null, 'T0', { descentComplete: true, observedFrontierStopNbr: 7135950 });
  assert.equal(prev.descentComplete, true);
  assert.equal(prev.observedFrontierStopNbr, 7135950);
  const loadOnly = buildScanState('2026-06-19', [planned('7001', 'DAVIS000196001')], prev, 'T1');
  assert.equal(loadOnly.descentComplete, true, 'carried when this cycle did not descend');
  assert.equal(loadOnly.observedFrontierStopNbr, 7135950, 'frontier ceiling carried, not regressed');
});

test('buildScanState: descentComplete defaults to false (never undefined) on a fresh load-only cycle', () => {
  const s = buildScanState('2026-06-19', [planned('7001', 'DAVIS000196001')], null, 'T0');
  assert.equal(s.descentComplete, false);
  assert.deepEqual(s.unplannedStopNbrs, []); // never undefined → Firestore-clean
});

test('buildScanState: merges prior loadMembers for loads not re-scanned this cycle', () => {
  const prev = buildScanState('2026-06-19', [planned('7001', 'L1'), planned('8001', 'L2')], null, 'T0');
  // This cycle only re-pulled L1 → L2's members must persist.
  const next = buildScanState('2026-06-19', [planned('7001', 'L1'), planned('7002', 'L1')], prev, 'T1');
  assert.deepEqual(next.loadMembers.L1, ['7001', '7002']);
  assert.deepEqual(next.loadMembers.L2, ['8001'], 'prior load members preserved');
});
