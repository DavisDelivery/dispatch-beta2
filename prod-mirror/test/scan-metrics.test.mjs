// test/scan-metrics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { maxConsecutiveGap, summarizeScanMetrics } from '../netlify/functions/lib/scan-metrics.mts';

test('maxConsecutiveGap: largest gap between sorted numbers', () => {
  assert.equal(maxConsecutiveGap([196100, 196101, 196102]), 1);
  assert.equal(maxConsecutiveGap([196100, 196110, 196112]), 10);
  assert.equal(maxConsecutiveGap([5]), 0);
  assert.equal(maxConsecutiveGap([]), 0);
  assert.equal(maxConsecutiveGap([3, 3, 3]), 0); // de-duped
});

test('summarizeScanMetrics: empty → safe defaults', () => {
  const s = summarizeScanMetrics([]);
  assert.equal(s.scans, 0);
  assert.equal(s.recommendedEmptyStop, 25);
});

test('summarizeScanMetrics: recommends maxGap + margin, floored at 25', () => {
  const samples = [
    { date: '2026-06-22', at: 't1', foundLoads: 60, newLoads: 9, maxGap: 4, windowProbed: 35, lean: true, missed: 0 },
    { date: '2026-06-23', at: 't2', foundLoads: 62, newLoads: 11, maxGap: 7, windowProbed: 40, lean: true, missed: 0 },
    { date: '2026-06-24', at: 't3', foundLoads: 58, newLoads: 8, maxGap: 30, windowProbed: 45, lean: true, missed: 0 },
  ];
  const s = summarizeScanMetrics(samples);
  assert.equal(s.scans, 3);
  assert.equal(s.maxNewLoads, 11);
  assert.equal(s.avgNewLoads, Math.round(((9 + 11 + 8) / 3) * 10) / 10);
  assert.equal(s.maxGap, 30);
  assert.equal(s.recommendedEmptyStop, 40); // 30 + 10
  assert.equal(s.missedScans, 0);
});

test('summarizeScanMetrics: small gaps keep the 25 floor and count misses', () => {
  const samples = [
    { date: 'd', at: 't', foundLoads: 60, newLoads: 10, maxGap: 3, windowProbed: 30, lean: true, missed: 0 },
    { date: 'd', at: 't', foundLoads: 60, newLoads: 10, maxGap: 2, windowProbed: 30, lean: true, missed: 2 },
  ];
  const s = summarizeScanMetrics(samples);
  assert.equal(s.recommendedEmptyStop, 25); // max(25, 3+10)=25
  assert.equal(s.missedScans, 1);
});
