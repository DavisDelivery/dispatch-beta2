// test/load-calibration.test.mjs — SITE B load-number estimator (business-day
// anchor + self-calibration). Regression for the 2026-06-15 miss: the old
// calendar-day×80 estimate centered at 197220 and a ±250 window [196970,197470]
// clipped every real load (~196690). The business-day estimate centers at 196743.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  businessDaysBetween,
  estimateLoadRange,
  calibrateLoadRange,
} from '../netlify/functions/lib/nuvizz-scan.mts';

const D = (s) => new Date(s + 'T00:00:00Z');

test('businessDaysBetween counts Mon–Fri only, signed', () => {
  assert.equal(businessDaysBetween(D('2026-06-05'), D('2026-06-15')), 6, 'Fri Jun5 → Mon Jun15 = 6 biz days (8,9,10,11,12,15)');
  assert.equal(businessDaysBetween(D('2026-06-05'), D('2026-06-05')), 0);
  assert.equal(businessDaysBetween(D('2026-06-15'), D('2026-06-05')), -6, 'reverse is negative');
  assert.equal(businessDaysBetween(D('2026-06-05'), D('2026-06-08')), 1, 'Fri → Mon = 1 biz day (weekend skipped)');
});

test('estimateLoadRange centers on business days — covers 2026-06-15 loads', () => {
  const r = estimateLoadRange('2026-06-15');
  // center = 196143 + 6×100 = 196743 ; window ±300
  assert.equal(r.startNbr, 196443);
  assert.equal(r.endNbr, 197043);
  assert.ok(196690 >= r.startNbr && 196690 <= r.endNbr, "covers today's real loads (~196690)");
  // Regression: the old calendar-day window [196970,197470] started ABOVE the real loads.
  assert.ok(196690 < 196970, 'the buggy calendar-day window would have missed them');
});

test('estimateLoadRange advances one business day at a time', () => {
  const tue = estimateLoadRange('2026-06-16'); // 7 biz days → center 196843
  assert.equal(tue.startNbr, 196543);
  assert.equal(tue.endNbr, 197143);
});

test('calibrateLoadRange narrows the window to the actual span (≥50 loads)', () => {
  const date = '2030-03-04';
  // 61 loads spanning 196600..196720
  const loads = Array.from({ length: 61 }, (_, i) => `DAVIS${String(196600 + i * 2).padStart(9, '0')}`);
  calibrateLoadRange(date, loads);
  const r = estimateLoadRange(date);
  assert.equal(r.startNbr, 196580, 'min(196600) − 20');
  assert.equal(r.endNbr, 196820, 'max(196720) + 100');
});

test('calibrateLoadRange ignores a too-small batch (early-morning safety)', () => {
  const date = '2030-03-05';
  const few = Array.from({ length: 10 }, (_, i) => `DAVIS${String(190000 + i).padStart(9, '0')}`);
  calibrateLoadRange(date, few);
  const r = estimateLoadRange(date); // unchanged → static business-day estimate
  // 2030-03-05 is far from the anchor; just assert it did NOT take the tiny batch's range
  assert.ok(!(r.startNbr === 189980), 'did not calibrate to the 10-load batch');
  assert.equal(r.endNbr - r.startNbr, 600, 'still the static ±300 window');
});
