// test/unplanned-target.test.mjs
//
// Regression: a stop that is already assigned to a load is PLANNED even when it
// is still status-10 (not yet dispatched). The unplanned descent must NOT claim
// it, or it overwrites the load scan's isPlanned=true record and the stop wrongly
// appears under "Unplanned only".
import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnplannedTarget } from '../netlify/functions/lib/nuvizz-scan.mts';

const DATE = '2026-06-22';

test('status-10, right date, NO load → genuine unplanned target', () => {
  assert.equal(isUnplannedTarget('10', DATE, DATE, null), true);
  assert.equal(isUnplannedTarget('10', DATE, DATE, undefined), true);
  assert.equal(isUnplannedTarget('10', DATE, DATE, ''), true);
});

test('status-10 but ON A LOAD → NOT a target (planned, load scan owns it)', () => {
  assert.equal(isUnplannedTarget('10', DATE, DATE, 'DAVIS000196999'), false);
});

test('wrong date → not a target even if unplanned', () => {
  assert.equal(isUnplannedTarget('10', '2026-06-23', DATE, null), false);
});

test('non-10 status → not a target regardless of load', () => {
  assert.equal(isUnplannedTarget('40', DATE, DATE, null), false);
  assert.equal(isUnplannedTarget('90', DATE, DATE, 'DAVIS000196999'), false);
});
