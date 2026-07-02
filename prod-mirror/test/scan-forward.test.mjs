// test/scan-forward.test.mjs — adaptive forward discovery primitive.
// Walk forward in chunks from a seeded frontier, extend while a chunk turns up
// new items, stop after a run of empty chunks. Backstops: maxProbes + time budget.
import test from 'node:test';
import assert from 'node:assert/strict';

import { scanForward } from '../netlify/functions/lib/nuvizz-scan.mts';

// Fake probe: numbers in `targets` are existing NEW items carrying a record.
function makeProbe(targets) {
  const set = new Set(targets);
  return async (n) => (set.has(n)
    ? { exists: true, isNew: true, record: n }
    : { exists: false, isNew: false });
}

test('walks forward, extends while productive, stops after the empty streak', async () => {
  const probe = makeProbe([101, 102, 103, 104, 105, 106, 107, 108]);
  const r = await scanForward(100, probe, { chunk: 5, stopAfterEmpty: 2 });
  // chunks: [100-104] new=4, [105-109] new=4, [110-114] new=0, [115-119] new=0 → stop
  assert.deepEqual(r.records.slice().sort((a, b) => a - b), [101, 102, 103, 104, 105, 106, 107, 108]);
  assert.equal(r.maxSeen, 108);
  assert.equal(r.complete, true);
  assert.equal(r.probes, 20);
});

test('stopAfterEmpty=1 stops at the first empty chunk', async () => {
  const probe = makeProbe([1, 2, 3]);
  const r = await scanForward(0, probe, { chunk: 5, stopAfterEmpty: 1 });
  // [0-4] finds 1,2,3 → continue; [5-9] none → stop
  assert.equal(r.probes, 10);
  assert.deepEqual(r.records.slice().sort((a, b) => a - b), [1, 2, 3]);
});

test('respects the maxProbes backstop and reports incomplete', async () => {
  const probe = async (n) => ({ exists: true, isNew: true, record: n }); // frontier never runs dry
  const r = await scanForward(0, probe, { chunk: 10, maxProbes: 30 });
  assert.equal(r.probes, 30);
  assert.equal(r.complete, false);
  assert.equal(r.records.length, 30);
});

test('existing-but-not-new numbers are not "productive"', async () => {
  const probe = async () => ({ exists: true, isNew: false }); // exist, but nothing new
  const r = await scanForward(0, probe, { chunk: 5, stopAfterEmpty: 1 });
  assert.equal(r.probes, 5);          // first chunk already has 0 new → stop
  assert.equal(r.records.length, 0);
  assert.equal(r.maxSeen, 4);         // still tracks the highest existing number seen
});
