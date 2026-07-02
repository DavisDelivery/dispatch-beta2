// test/scan-dates.test.mjs — scheduled-scan date horizon (today + next business
// day). Business-day stepping so a Friday run covers Monday, not empty Saturday.
import test from 'node:test';
import assert from 'node:assert/strict';

import { nextBusinessDayUTC, scanDatesFrom } from '../netlify/functions/lib/refresh-stops-core.mts';
import { etDayString } from '../netlify/functions/lib/firestore.mts';

// The board day is anchored on the EASTERN calendar day (etDayString), not the UTC date.
// They agree all day and diverge only after ~8pm ET, when UTC has already rolled to tomorrow.
// A UTC anchor made the Friday-evening scan file FRIDAY's live board under the SATURDAY doc
// key, and with no weekend scan to re-derive it, Friday's deliveries sat on Saturday's board
// all weekend. This locks the anchor to ET so that regression can't return.
test('board anchor is the ET day, not UTC — Friday-evening window stays on Friday', () => {
  // 2026-06-27T02:00Z = Friday Jun 26, 10:00pm ET. UTC already says Saturday.
  const friEvening = new Date('2026-06-27T02:00:00Z');
  assert.equal(friEvening.toISOString().slice(0, 10), '2026-06-27', 'UTC date has rolled to Saturday');
  assert.equal(etDayString(friEvening), '2026-06-26', 'but the ET calendar day is still Friday');
  // So the evening scan, anchored on ET, refreshes Friday + the next business day (Monday) —
  // it never writes a Saturday-keyed doc out of Friday-evening content.
  assert.deepEqual(scanDatesFrom(etDayString(friEvening), 2), ['2026-06-26', '2026-06-29'], 'Fri + Mon, never Sat');
});

test('nextBusinessDayUTC skips weekends', () => {
  assert.equal(nextBusinessDayUTC('2026-06-16'), '2026-06-17', 'Tue after Mon');
  assert.equal(nextBusinessDayUTC('2026-06-19'), '2026-06-22', 'Fri → Mon (skip Sat/Sun)');
  assert.equal(nextBusinessDayUTC('2026-06-18'), '2026-06-19', 'Thu → Fri');
});

test('scanDatesFrom: today + next business day (default horizon = 2)', () => {
  assert.deepEqual(scanDatesFrom('2026-06-16', 2), ['2026-06-16', '2026-06-17'], 'Mon + Tue');
  assert.deepEqual(scanDatesFrom('2026-06-19', 2), ['2026-06-19', '2026-06-22'], 'Fri + Mon');
});

test('scanDatesFrom: n=1 is today only; n=3 spans three business days', () => {
  assert.deepEqual(scanDatesFrom('2026-06-16', 1), ['2026-06-16']);
  assert.deepEqual(scanDatesFrom('2026-06-19', 3), ['2026-06-19', '2026-06-22', '2026-06-23'], 'Fri,Mon,Tue');
});
