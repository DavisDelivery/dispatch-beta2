// test/preserve-stop.test.mjs — writeStops preserve-vs-prune rule (Phase 2 safety).
// The data-loss guard for lean discovery: a partial load scan (terminal loads
// skipped) must PRESERVE the planned stops it didn't re-pull, not prune them.
import test from 'node:test';
import assert from 'node:assert/strict';

import { preserveStopOnWrite } from '../netlify/functions/lib/firestore.mts';

const planned = { isPlanned: true };
const unplanned = { isPlanned: false };

test('full scan (loads + unplanned): nothing preserved — un-rescanned stops prune as before', () => {
  const o = { includeUnplanned: true, includeLoads: true };
  assert.equal(preserveStopOnWrite(planned, o), false);
  assert.equal(preserveStopOnWrite(unplanned, o), false);
});

test('load-only run preserves existing unplanned; unplanned-only run preserves existing planned', () => {
  assert.equal(preserveStopOnWrite(unplanned, { includeUnplanned: false, includeLoads: true }), true);
  assert.equal(preserveStopOnWrite(planned, { includeUnplanned: false, includeLoads: true }), false);
  assert.equal(preserveStopOnWrite(planned, { includeUnplanned: true, includeLoads: false }), true);
  assert.equal(preserveStopOnWrite(unplanned, { includeUnplanned: true, includeLoads: false }), false);
});

test('partialLoads (lean): PRESERVES planned stops not re-scanned (terminal-skip safety)', () => {
  const o = { includeUnplanned: true, includeLoads: true, partialLoads: true };
  assert.equal(preserveStopOnWrite(planned, o), true, 'delivered/terminal planned stop survives the lean cycle');
  // unplanned still follows the unplanned-feed rule (descent ran, so not preserved here)
  assert.equal(preserveStopOnWrite(unplanned, o), false);
});

test('partialUnplanned (lean): PRESERVES older still-unplanned orders below the high-water', () => {
  const o = { includeUnplanned: true, includeLoads: true, partialUnplanned: true };
  assert.equal(preserveStopOnWrite(unplanned, o), true, 'older unplanned order not re-probed this cycle survives');
  assert.equal(preserveStopOnWrite(planned, o), false, 'partialUnplanned does not affect planned stops');
});

// ── R1: membership-aware preserve (off-load reconciliation) ──────────────────
const plannedOn = (loadNbr) => ({ isPlanned: true, loadNbr });

test('R1: a planned stop whose load WAS re-pulled but is now absent → PRUNE (off-load removal)', () => {
  // rescannedLoads contains 197184 (the load we re-pulled); the stop is no longer
  // in the fresh results → it was removed from that load → must not be preserved.
  const o = { includeUnplanned: true, includeLoads: true, partialLoads: true, rescannedLoads: new Set([197184, 197185]) };
  assert.equal(preserveStopOnWrite(plannedOn('DAVIS000197184'), o), false, 'removed-from-re-scanned-load stop prunes');
});

test('R1: a planned stop on a load we did NOT re-pull → PRESERVE (terminal/not-rescanned)', () => {
  const o = { includeUnplanned: true, includeLoads: true, partialLoads: true, rescannedLoads: new Set([197185, 197186]) };
  assert.equal(preserveStopOnWrite(plannedOn('DAVIS000197184'), o), true, 'stop on an un-rescanned load survives');
});

test('R1: no rescannedLoads (legacy partial-loads) → preserve all planned (no data loss)', () => {
  const o = { includeUnplanned: true, includeLoads: true, partialLoads: true };
  assert.equal(preserveStopOnWrite(plannedOn('DAVIS000197184'), o), true);
});

test('R1: planned stop with an unparseable loadNbr is preserved (never prune on ambiguity)', () => {
  const o = { includeUnplanned: true, includeLoads: true, partialLoads: true, rescannedLoads: new Set([197184]) };
  assert.equal(preserveStopOnWrite({ isPlanned: true, loadNbr: null }, o), true);
  assert.equal(preserveStopOnWrite({ isPlanned: true }, o), true);
});

test('R1: empty rescannedLoads → preserve (conservative; treated as "no loads re-pulled")', () => {
  const o = { includeUnplanned: true, includeLoads: true, partialLoads: true, rescannedLoads: new Set() };
  assert.equal(preserveStopOnWrite(plannedOn('DAVIS000197184'), o), true);
});

test('R1: full scan (partialLoads false) ignores rescannedLoads → normal prune', () => {
  const o = { includeUnplanned: true, includeLoads: true, partialLoads: false, rescannedLoads: new Set([197184]) };
  assert.equal(preserveStopOnWrite(plannedOn('DAVIS000197184'), o), false, 'full scan prunes vanished stops as before');
});

test('R1 integration: lean cycle prunes a stop removed from a re-pulled load, keeps the rest', () => {
  // Mirrors writeStops: preserved = existing not in fresh that pass preserveStopOnWrite.
  const existing = [
    { _id: '100', isPlanned: true, loadNbr: 'DAVIS000197184' }, // re-pulled, still present (in fresh)
    { _id: '101', isPlanned: true, loadNbr: 'DAVIS000197184' }, // re-pulled, REMOVED (absent) → prune
    { _id: '102', isPlanned: true, loadNbr: 'DAVIS000197185' }, // terminal, NOT re-pulled → preserve
    { _id: '103', isPlanned: false },                            // existing unplanned (descent ran) → prune
  ];
  const freshNbrs = new Set(['100']);                            // only 100 came back this cycle
  const o = { includeUnplanned: true, includeLoads: true, partialLoads: true, partialUnplanned: false, rescannedLoads: new Set([197184]) };
  const preserved = existing.filter((d) => !freshNbrs.has(d._id) && preserveStopOnWrite(d, o)).map((d) => d._id);
  assert.deepEqual(preserved, ['102'], 'only the stop on the un-re-pulled load survives; 101 (off-load) prunes');
});
