// test/routing-loads.test.mjs — pure helpers for the Shared Loads view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDateTime, tsToMillis, loadTruckCount, loadStopCount, loadSummary, buildLoadAutoName,
} from '../src/lib/routing-loads.js';

test('formatDateTime renders the standard ET format', () => {
  // 2026-06-05T18:14:00Z = 2:14 PM EDT (UTC-4)
  assert.equal(formatDateTime(Date.parse('2026-06-05T18:14:00Z')), 'Jun 5, 2026 2:14p');
  // 2026-01-05T13:05:00Z = 8:05 AM EST (UTC-5)
  assert.equal(formatDateTime(Date.parse('2026-01-05T13:05:00Z')), 'Jan 5, 2026 8:05a');
  assert.equal(formatDateTime(null), '');
  assert.equal(formatDateTime('not a date'), '');
});

test('tsToMillis normalizes Firestore Timestamp / millis / Date / ISO', () => {
  assert.equal(tsToMillis({ toMillis: () => 1717610040000 }), 1717610040000);
  assert.equal(tsToMillis({ seconds: 1717610040, nanoseconds: 0 }), 1717610040000);
  assert.equal(tsToMillis(new Date(1717610040000)).valueOf(), 1717610040000);
  assert.equal(tsToMillis(1717610040000), 1717610040000);
  assert.equal(tsToMillis(null), null);
});

const result = {
  routes: [
    { truckId: 'A', orderedStopIds: ['1', '2', '3'] },
    { truckId: 'B', orderedStopIds: ['4', '5'] },
  ],
  unassigned: [{ stopId: '9', reasons: ['x'] }],
};

test('truck/stop counts and summary', () => {
  assert.equal(loadTruckCount(result), 2);
  assert.equal(loadStopCount(result), 5);
  assert.equal(loadSummary(result), '2 trucks · 5 stops · 1 spilled');
  assert.equal(loadSummary({ routes: [{ truckId: 'A', orderedStopIds: ['1'] }] }), '1 truck · 1 stop');
  assert.equal(loadSummary({}), '0 trucks · 0 stops');
});

test('buildLoadAutoName combines time + summary (no spill in the name)', () => {
  assert.equal(
    buildLoadAutoName(result, Date.parse('2026-06-05T18:14:00Z')),
    'Jun 5, 2026 2:14p · 2 trucks · 5 stops',
  );
});
