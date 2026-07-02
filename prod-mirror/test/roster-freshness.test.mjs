// test/roster-freshness.test.mjs — future-date load-roster capture gate.
// Tomorrow's load SET is fixed once it exists (per Chad), so the scheduled scan
// captures it ONCE per scan day — but a capture only COUNTS when it carries real
// load NUMBERS. The Jul 1 2026 regression this guards: the morning capture ran
// before the Load-Number parser fix (#336), wrote 102 rows with ZERO numbers, and
// the old "non-empty → done" dedup froze the number-less snapshot all day, so
// every evening reorder/unplan Save was refused ("needs a load number").
import test from 'node:test';
import assert from 'node:assert/strict';

import { futureRosterCaptured } from '../netlify/functions/lib/refresh-stops-core.mts';

// 2026-07-02T20:00Z = 4:00pm ET Jul 2 — the "now" of an afternoon acting cycle.
const NOW = new Date('2026-07-02T20:00:00Z');
const NUMBERED = [{ loadId: 'a', name: '2 M', loadNbr: 'DAVIS000198000' }];
const NUMBERLESS = [{ loadId: 'a', name: '2 M', loadNbr: null }, { loadId: 'b', name: 'SUW 5', loadNbr: null }];

test('a same-ET-day NUMBERED capture counts — once a day is the whole job', () => {
  // 12:00Z = 8:00am ET the same day (the normal morning capture).
  assert.equal(futureRosterCaptured({ at: '2026-07-02T12:00:00Z', loads: NUMBERED }, NOW), true);
});

test('a same-day capture with ZERO numbers never counts (the Jul 1 frozen-snapshot regression)', () => {
  assert.equal(futureRosterCaptured({ at: '2026-07-02T12:00:00Z', loads: NUMBERLESS }, NOW), false);
});

test('one numbered row is enough — partial numbers is NuVizz data, not a broken parser', () => {
  assert.equal(futureRosterCaptured({ at: '2026-07-02T12:00:00Z', loads: [...NUMBERLESS, ...NUMBERED] }, NOW), true);
});

test('a PRIOR scan-day capture never counts, even numbered — each day recaptures once', () => {
  assert.equal(futureRosterCaptured({ at: '2026-07-01T12:00:00Z', loads: NUMBERED }, NOW), false);
});

test('the day boundary is the ET day, not UTC (mirrors the board anchor)', () => {
  // 2026-07-02T02:00Z is 10:00pm ET Jul 1 — same UTC date as NOW, but the PRIOR ET day.
  assert.equal(futureRosterCaptured({ at: '2026-07-02T02:00:00Z', loads: NUMBERED }, NOW), false);
});

test('empty / missing / garbled cache never counts', () => {
  assert.equal(futureRosterCaptured({ at: '2026-07-02T12:00:00Z', loads: [] }, NOW), false);
  assert.equal(futureRosterCaptured({ at: '2026-07-02T12:00:00Z' }, NOW), false);
  assert.equal(futureRosterCaptured({ loads: NUMBERED }, NOW), false);
  assert.equal(futureRosterCaptured({ at: 'not-a-date', loads: NUMBERED }, NOW), false);
  assert.equal(futureRosterCaptured(null, NOW), false);
  assert.equal(futureRosterCaptured(undefined, NOW), false);
});
