// test/nuvizz-write-sequence.test.mjs — §10 "anchor method" manual sequencing (PURE).
// No network: planSequence is a pure function. Covers the doc's verified reorder example
// plus add / remove / no-op / unsafe-refusal cases.
import test from 'node:test';
import assert from 'node:assert/strict';

import { planSequence } from '../netlify/functions/lib/nuvizz-write-ops.mts';

test('planSequence: the doc-verified reorder [M,C,K,Ca] → [Ca,K,C,M]', () => {
  // BEFORE order, WANT order — anchor is the first DESIRED stop (Ca), already on the load.
  const p = planSequence(['M', 'C', 'K', 'Ca'], ['Ca', 'K', 'C', 'M']);
  assert.equal(p.ok, true);
  assert.equal(p.unchanged, false);
  assert.equal(p.anchor, 'Ca');
  assert.deepEqual(p.removeStopIds, ['M', 'C', 'K'], 'remove every current delivery except the anchor');
  assert.deepEqual(p.insertOrdered, ['K', 'C', 'M'], 'insert the rest one-at-a-time in desired order');
  // cost ≈ 2 (load/info+load/edit) + (N-1) inserts = 2 + 3.
  assert.equal(p.insertOrdered.length, 3);
});

test('planSequence: add a new stop to an in-order load → ZERO removes, just append it', () => {
  // Minimal calls: [A,B] is already the correct prefix of [A,B,C], so keep both and only insert C.
  const p = planSequence(['A', 'B'], ['A', 'B', 'C']);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, 'A');
  assert.deepEqual(p.removeStopIds, [], 'nothing removed — A,B already in order');
  assert.deepEqual(p.insertOrdered, ['C'], 'only the new stop is inserted');
});

test('planSequence: remove a middle stop → 1 remove, 0 inserts (prefix [A,C] kept)', () => {
  const p = planSequence(['A', 'B', 'C'], ['A', 'C']);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, 'A');
  assert.deepEqual(p.removeStopIds, ['B']);
  assert.deepEqual(p.insertOrdered, [], 'B removed; A,C already correctly ordered → no inserts');
});

test('planSequence: minimal calls — one out-of-place stop is a single remove + single insert', () => {
  // [A,B,C,D] → [A,B,D,C]: keep the prefix [A,B,D] (in-order on the load), move only C.
  const p = planSequence(['A', 'B', 'C', 'D'], ['A', 'B', 'D', 'C']);
  assert.equal(p.ok, true);
  assert.deepEqual(p.removeStopIds, ['C']);
  assert.deepEqual(p.insertOrdered, ['C']);
});

test('planSequence: combined move (swap first two existing) keeps the anchor on the load', () => {
  const p = planSequence(['A', 'B'], ['B', 'A']);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, 'B');           // B is current, so it's a valid anchor
  assert.deepEqual(p.removeStopIds, ['A']);
  assert.deepEqual(p.insertOrdered, ['A']);  // → [B,A]
});

test('planSequence: no change → unchanged, ZERO calls', () => {
  const p = planSequence(['A', 'B', 'C'], ['A', 'B', 'C']);
  assert.equal(p.ok, true);
  assert.equal(p.unchanged, true);
  assert.deepEqual(p.removeStopIds, []);
  assert.deepEqual(p.insertOrdered, []);
});

test('planSequence: REFUSE an empty desired order (would cancel the route)', () => {
  const p = planSequence(['A', 'B'], []);
  assert.equal(p.ok, false);
  assert.match(p.reason, /empty-order|cancel/);
});

test('planSequence: NEW stop as first delivery → anchorInsert it first, then rebuild', () => {
  // X isn't on the load and must be first. Insert X first (anchor), then remove the current
  // deliveries and re-insert them after X → [X,A,B]. Never empties the load.
  const p = planSequence(['A', 'B'], ['X', 'A', 'B']);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, 'X');
  assert.equal(p.anchorInsert, 'X', 'X inserted BEFORE any remove so the load never empties');
  assert.deepEqual(p.removeStopIds, ['A', 'B']);
  assert.deepEqual(p.insertOrdered, ['A', 'B']);
});

test('planSequence: DEDUPES a duplicate in the desired order (no duplicate re-insert)', () => {
  // ['C','A','A','B'] dedupes to ['C','A','B'] → anchor C, no double-insert of A.
  const p = planSequence(['A', 'B', 'C'], ['C', 'A', 'A', 'B']);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, 'C');
  assert.deepEqual(p.removeStopIds, ['A', 'B']);
  assert.deepEqual(p.insertOrdered, ['A', 'B'], 'duplicate A collapsed to one insert');
});

test('planSequence: tolerates null/blank ids and numeric ids', () => {
  const p = planSequence([1, 2, null, 3], [3, 1, 2]);
  assert.equal(p.ok, true);
  assert.equal(p.anchor, '3');
  assert.deepEqual(p.removeStopIds, ['1', '2']);
  assert.deepEqual(p.insertOrdered, ['1', '2']);
});
