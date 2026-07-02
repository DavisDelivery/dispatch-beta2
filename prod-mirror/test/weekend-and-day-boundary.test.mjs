// test/weekend-and-day-boundary.test.mjs
//
// Unit tests for the weekend-skip + ET-day-counter changes:
//   - isWeekendDate (history-core): scheduled history snapshot skips Sat/Sun.
//   - etDayString (firestore): NuVizz call counter keyed to a midnight-to-midnight
//     ET day, so a 2am-ET (06:00 UTC) job lands on the correct local day.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isWeekendDate } from '../netlify/functions/lib/history-core.mts';
import { etDayString } from '../netlify/functions/lib/firestore.mts';

test('isWeekendDate: Sat/Sun true, weekdays false', () => {
  assert.equal(isWeekendDate('2026-06-19'), false); // Friday
  assert.equal(isWeekendDate('2026-06-20'), true);  // Saturday
  assert.equal(isWeekendDate('2026-06-21'), true);  // Sunday
  assert.equal(isWeekendDate('2026-06-22'), false); // Monday
});

test('etDayString: 2am ET (06:00 UTC) counts on the local ET day, not the next UTC day', () => {
  // 2026-06-21T03:00:00Z = 2026-06-20 23:00 EDT → ET day is still the 20th.
  assert.equal(etDayString(new Date('2026-06-21T03:00:00Z')), '2026-06-20');
  // 2026-06-21T06:00:00Z = 2026-06-21 02:00 EDT → ET day is the 21st (the
  // history snapshot instant) — same ET day a dispatcher would call "today".
  assert.equal(etDayString(new Date('2026-06-21T06:00:00Z')), '2026-06-21');
  // Late-morning UTC is unambiguous.
  assert.equal(etDayString(new Date('2026-06-21T16:00:00Z')), '2026-06-21');
});
