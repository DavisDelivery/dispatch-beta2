// test/load-stop-date.test.mjs — a load matches a board day by each STOP's own
// scheduled delivery date, so carryover / multi-day routes (started earlier but
// delivering today) surface their today-stops as planned instead of going stale-
// unplanned. Regression for the BEN 1 / 007136514 case.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadStopsForDate, rawStopScheduledDate } from '../netlify/functions/lib/nuvizz-scan.mts';

const doStop = (nbr, date) => ({ stop: { stopNbr: nbr, stopType: 'DO', to: { schedule: { timeFrom: date ? `${date}T08:00:00` : undefined } } } });
const puStop = (nbr, date) => ({ stop: { stopNbr: nbr, stopType: 'PU', from: { schedule: { timeFrom: `${date}T06:00:00` } } } });

test('rawStopScheduledDate reads the primary schedule date (DO=to, PU=from)', () => {
  assert.equal(rawStopScheduledDate(doStop('A', '2026-06-22')), '2026-06-22');
  assert.equal(rawStopScheduledDate(puStop('C', '2026-06-22')), '2026-06-22');
  assert.equal(rawStopScheduledDate(doStop('D', null)), null);
});

test('keeps only stops delivering on the board date (carryover load)', () => {
  const stops = [
    doStop('A', '2026-06-22'),   // today
    doStop('B', '2026-06-19'),   // earlier day — drop
    puStop('C', '2026-06-22'),   // today pickup
  ];
  const kept = loadStopsForDate(stops, '2026-06-22', '2026-06-19'); // load started 6/19
  assert.deepEqual(kept.map((x) => x.s.stop.stopNbr), ['A', 'C']);
  assert.deepEqual(kept.map((x) => x.i), [0, 2]); // original indices preserved (stopSeq)
});

test('schedule-less stops fall back to the load start date', () => {
  const stops = [doStop('A', '2026-06-22'), doStop('N', null)];
  // start date == board date → keep the schedule-less stop
  assert.deepEqual(loadStopsForDate(stops, '2026-06-22', '2026-06-22').map((x) => x.s.stop.stopNbr), ['A', 'N']);
  // start date != board date → drop the schedule-less stop, keep the dated one
  assert.deepEqual(loadStopsForDate(stops, '2026-06-22', '2026-06-19').map((x) => x.s.stop.stopNbr), ['A']);
});

test('normal same-day load is unchanged (all stops kept)', () => {
  const stops = [doStop('A', '2026-06-22'), doStop('B', '2026-06-22')];
  assert.equal(loadStopsForDate(stops, '2026-06-22', '2026-06-22').length, 2);
});

test('today\'s load keeps a rolled-in older order (re-added undelivered stop)', () => {
  // PAULSEN case: an order from a prior day that failed delivery, was put back to
  // unplanned, and re-added to TODAY's load — it keeps its original (older) date
  // but must still show on today's route. Load STARTED today, so membership wins.
  const stops = [
    doStop('A', '2026-06-23'),   // today
    doStop('PAULSEN', '2026-06-19'), // rolled-in older order — KEEP
    doStop('FUTURE', '2026-06-25'),  // pre-staged future stop — drop
  ];
  const kept = loadStopsForDate(stops, '2026-06-23', '2026-06-23').map((x) => x.s.stop.stopNbr);
  assert.deepEqual(kept, ['A', 'PAULSEN']);
});

test('carryover load still excludes older-dated stops (no regression)', () => {
  const stops = [doStop('A', '2026-06-23'), doStop('OLD', '2026-06-19')];
  // load started 6/19 (carryover) → only today-dated stops kept
  assert.deepEqual(loadStopsForDate(stops, '2026-06-23', '2026-06-19').map((x) => x.s.stop.stopNbr), ['A']);
});
