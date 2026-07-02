// test/routing-constraints.test.mjs — the capacity gate (skid-count hotfix).
// Imports the REAL gate so what's asserted is what ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capacityFits, truckCanCarry, emptyLoad, REASON, CAPACITY_GATES,
} from '../netlify/functions/lib/routing-constraints.mts';

const stop = (over = {}) => ({
  id: 'S', lat: 0, lng: 0, skids: 2, weightLbs: 500, linearFeetIn: 48, oversize: false,
  serviceMin: 20, timeWindow: null, timeConstraint: 'SOFT', equipmentReqs: [], ...over,
});
const truck = (over = {}) => ({
  id: 'T', label: 'T', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312,
  capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true }, ...over,
});

test('config: skids + weight gate on, deck gate off by default', () => {
  assert.equal(CAPACITY_GATES.skids, true);
  assert.equal(CAPACITY_GATES.weightLbs, true);
  assert.equal(CAPACITY_GATES.deckLengthIn, false);
});

test('SKIDS: still the binding gate (over maxSkids → overSkids)', () => {
  const r = capacityFits(emptyLoad(), stop({ skids: 20 }), truck({ maxSkids: 14 }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes(REASON.overSkids));
  // cumulative: 10 in cart + 6 more over a 14 cap
  const r2 = capacityFits({ skids: 10, weightLbs: 0, linearFeetIn: 0 }, stop({ skids: 6 }), truck({ maxSkids: 14 }));
  assert.ok(r2.reasons.includes(REASON.overSkids));
});

test('DECK never blocks regardless of linearFeetIn (the bug that spilled everything)', () => {
  // 2976in (a 30-carton flooring stop) vs a 636in trailer deck — used to spill.
  const r = capacityFits(emptyLoad(), stop({ linearFeetIn: 2976, skids: 3 }), truck({ deckLengthIn: 636, maxSkids: 28 }));
  assert.equal(r.ok, true);
  assert.ok(!r.reasons.includes(REASON.overDeck));
});

test('a stop that fit no truck ONLY due to deck now places by skids', () => {
  const r = truckCanCarry(stop({ linearFeetIn: 5000, skids: 2 }), truck({ deckLengthIn: 312, maxSkids: 14 }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test('WEIGHT: blocks only when the truck has a real positive weight cap', () => {
  const over = capacityFits(emptyLoad(), stop({ weightLbs: 20000 }), truck({ maxWeightLbs: 10000 }));
  assert.ok(over.reasons.includes(REASON.overWeight));
  // maxWeightLbs 0/unset → weight cannot block
  assert.equal(capacityFits(emptyLoad(), stop({ weightLbs: 20000 }), truck({ maxWeightLbs: 0 })).ok, true);
  assert.equal(capacityFits(emptyLoad(), stop({ weightLbs: 20000 }), truck({ maxWeightLbs: undefined })).ok, true);
});

test('HARDENING: any non-positive / unset cap means unlimited (never spills)', () => {
  for (const bad of [0, -1, null, undefined, NaN]) {
    const r = capacityFits(emptyLoad(), stop({ skids: 999, weightLbs: 9e6 }), truck({ maxSkids: bad, maxWeightLbs: bad, deckLengthIn: bad }));
    assert.equal(r.ok, true, `cap=${bad} should be unlimited`);
  }
});

test('EQUIPMENT constraints are UNCHANGED (still enforced)', () => {
  // no_tractor_trailer on a tractor → still blocked
  const r = truckCanCarry(stop({ equipmentReqs: ['no_tractor_trailer'] }), truck({ capabilities: { tractor: true, liftgate: false, lengthClassFt: 53, overheadClearance: true } }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes(REASON.needsStraightTruck));
  // liftgate_required on a non-liftgate truck → still blocked
  const r2 = truckCanCarry(stop({ equipmentReqs: ['liftgate_required'] }), truck({ capabilities: { tractor: false, liftgate: false, lengthClassFt: 26, overheadClearance: true } }));
  assert.ok(r2.reasons.includes(REASON.needsLiftgate));
});
