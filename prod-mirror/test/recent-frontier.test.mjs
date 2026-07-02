// test/recent-frontier.test.mjs — cross-day frontier carry. Folds prior-day
// scan states into the max load / stop / unplanned-stop frontier used to seed the
// adaptive forward scan on a cold/resumption day (e.g. Sunday after the weekend).
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeFrontier } from '../netlify/functions/lib/firestore.mts';

test('folds the max load / stop / unplanned-stop across prior states', () => {
  const f = mergeFrontier([
    { maxLoadNbr: 196900, highWaterStopNbr: 7125000, highWaterUnplannedStopNbr: 7124800, observedFrontierStopNbr: 7125100 },
    { maxLoadNbr: 196990, highWaterStopNbr: 7125300, highWaterUnplannedStopNbr: 7125200 },
    null,
    undefined,
  ]);
  assert.equal(f.maxLoadNbr, 196990);
  assert.equal(f.maxStopNbr, 7125300);          // max(7125000, 7125100, 7125300)
  assert.equal(f.maxUnplannedStopNbr, 7125200); // max(7124800, 7125200)
});

test('all-empty / nullish input → all null', () => {
  assert.deepEqual(
    mergeFrontier([null, undefined, {}, { maxLoadNbr: null }]),
    { maxLoadNbr: null, maxStopNbr: null, maxUnplannedStopNbr: null, carriedLoadNbrs: [] },
  );
});

test('collects non-terminal prior loads as carryover candidates (terminal dropped)', () => {
  const f = mergeFrontier([
    { knownLoads: [
      { loadNbr: 'DAVIS000197197', allTerminal: false },
      { loadNbr: 'DAVIS000197100', allTerminal: true },  // delivered → not carried
    ] },
    { knownLoads: [{ loadNbr: 'DAVIS000197197', allTerminal: false }] }, // dup → unique
  ]);
  assert.deepEqual(f.carriedLoadNbrs, [197197]);
});

test('observedFrontier alone seeds the stop frontier when high-water is missing', () => {
  const f = mergeFrontier([{ observedFrontierStopNbr: 7126000 }]);
  assert.equal(f.maxStopNbr, 7126000);
  assert.equal(f.maxLoadNbr, null);
  assert.equal(f.maxUnplannedStopNbr, null);
});
