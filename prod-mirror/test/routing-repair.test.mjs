// test/routing-repair.test.mjs — repair loop GUARANTEES valid shown routes + spill.
import test from 'node:test';
import assert from 'node:assert/strict';

import { solveRouting } from '../netlify/functions/lib/routing-solver.mts';
import { repair } from '../netlify/functions/lib/routing-repair.mts';

const stop = (id, over = {}) => ({
  id, lat: 0, lng: 0, skids: 1, weightLbs: 100, linearFeetIn: 48, oversize: false,
  serviceMin: 0, timeWindow: null, timeConstraint: 'SOFT', equipmentReqs: [], ...over,
});
const truck = (over = {}) => ({
  id: 'T1', maxSkids: 100, maxWeightLbs: 1e6, deckLengthIn: 1e6,
  capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 }, ...over,
});

// Assert a repaired route is provably valid against capacity + STRICT windows.
function assertRouteValid(route, input) {
  const byId = new Map(input.stops.map((s) => [s.id, s]));
  assert.ok(route.load.skids <= route.capacity.skids, `skids ${route.load.skids}<=${route.capacity.skids}`);
  assert.ok(route.load.weightLbs <= route.capacity.weightLbs, 'weight within cap');
  assert.ok(route.load.linearFeetIn <= route.capacity.linearFeetIn, 'deck within cap');
  route.orderedStopIds.forEach((id, i) => {
    const s = byId.get(id);
    if (s.timeConstraint === 'STRICT' && s.timeWindow) {
      assert.ok(route.etas[i] >= s.timeWindow.startSec && route.etas[i] <= s.timeWindow.endSec,
        `stop ${id} eta ${route.etas[i]} within [${s.timeWindow.startSec},${s.timeWindow.endSec}]`);
    }
  });
}

// A is 200s from everywhere → never reachable within a [0,100] window.
const unreachableMatrix = {
  durationSec: [[0, 200, 50], [200, 0, 200], [50, 200, 0]],
  distanceMeters: [[0, 200, 50], [200, 0, 200], [50, 200, 0]],
};

test('STRICT mode: an unsatisfiable window is spilled with reason; rest stays valid', () => {
  const A = stop('A', { timeConstraint: 'STRICT', timeWindow: { startSec: 0, endSec: 100 } });
  const B = stop('B', { timeConstraint: 'STRICT', timeWindow: { startSec: 0, endSec: 100 } });
  const input = { stops: [A, B], trucks: [truck()], depot: { lat: 0, lng: 0 }, matrix: unreachableMatrix, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 }, departEpochSec: 0, windowMode: 'strict' };
  const out = repair(input, solveRouting(input));
  out.routes.forEach((r) => assertRouteValid(r, input));
  const spilledIds = out.unassigned.map((u) => u.stopId);
  assert.ok(spilledIds.includes('A'));
  assert.ok(out.unassigned.find((u) => u.stopId === 'A').reasons.some((r) => /window/.test(r)));
});

test('ADVISORY (default): an unsatisfiable window is KEPT on the truck and flagged, not spilled', () => {
  const A = stop('A', { timeConstraint: 'STRICT', timeWindow: { startSec: 0, endSec: 100 } });
  const B = stop('B', { timeConstraint: 'STRICT', timeWindow: { startSec: 0, endSec: 100 } });
  const input = { stops: [A, B], trucks: [truck()], depot: { lat: 0, lng: 0 }, matrix: unreachableMatrix, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 }, departEpochSec: 0 /* default advisory */ };
  const out = repair(input, solveRouting(input));
  const served = out.routes.flatMap((r) => r.orderedStopIds);
  assert.ok(served.includes('A') && served.includes('B'), 'both stops kept');
  assert.equal(out.unassigned.length, 0, 'no window spill in advisory mode');
  const flagged = out.routes.flatMap((r) => r.windowViolatedIds || []);
  assert.ok(flagged.includes('A'), 'A flagged as outside its window');
  // capacity still holds even though windows are advisory
  out.routes.forEach((r) => assert.ok(r.load.skids <= r.capacity.skids));
});

test('ADVISORY: a stop with no window is never window-flagged', () => {
  const A = stop('A'); // SOFT, no window
  const B = stop('B', { timeConstraint: 'STRICT', timeWindow: { startSec: 0, endSec: 100 } });
  const input = { stops: [A, B], trucks: [truck()], depot: { lat: 0, lng: 0 }, matrix: unreachableMatrix, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 }, departEpochSec: 0 };
  const out = repair(input, solveRouting(input));
  const flagged = new Set(out.routes.flatMap((r) => r.windowViolatedIds || []));
  assert.ok(!flagged.has('A'), 'no-window stop never flagged');
  assert.equal(out.unassigned.length, 0);
});

test('repair fixes a deliberately over-capacity candidate by spilling biggest stop(s)', () => {
  const stops = [stop('A', { skids: 4 }), stop('B', { skids: 4 }), stop('C', { skids: 4 })];
  const small = truck({ maxSkids: 9 }); // can hold at most 2 of the 4-skid stops
  const matrix = {
    durationSec: [[0, 1, 2, 3], [1, 0, 1, 2], [2, 1, 0, 1], [3, 2, 1, 0]],
    distanceMeters: [[0, 1, 2, 3], [1, 0, 1, 2], [2, 1, 0, 1], [3, 2, 1, 0]],
  };
  const input = { stops, trucks: [small], depot: { lat: 0, lng: 0 }, matrix, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 }, departEpochSec: 0 };
  // Hand-craft an INVALID candidate that puts all three on the small truck.
  const badCandidate = {
    routes: [{ truckId: 'T1', orderedStopIds: ['A', 'B', 'C'], legs: [], etas: [], load: { skids: 12, weightLbs: 300, linearFeetIn: 144 }, capacity: { skids: 9, weightLbs: 1e6, linearFeetIn: 1e6 }, feasible: true }],
    unassigned: [], meta: {},
  };
  const out = repair(input, badCandidate);
  out.routes.forEach((r) => assertRouteValid(r, input));
  const carried = out.routes.reduce((a, r) => a + r.orderedStopIds.length, 0);
  assert.equal(carried, 2, 'only two 4-skid stops fit in a 9-skid truck');
  assert.equal(out.unassigned.length, 1);
  assert.ok(out.unassigned[0].reasons.some((r) => /skid/.test(r)));
});

test('repair never returns an invalid route (mixed infeasible input)', () => {
  const stops = [
    stop('A', { skids: 6, timeConstraint: 'STRICT', timeWindow: { startSec: 0, endSec: 100 } }),
    stop('B', { skids: 6 }),
    stop('C', { skids: 6, equipmentReqs: ['liftgate_required'] }),
    stop('D', { skids: 6 }),
  ];
  const noLiftTruck = truck({ id: 'NOLIFT', maxSkids: 12, capabilities: { liftgate: false, tractor: false, lengthClassFt: 26 } });
  const n = 5;
  const d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Math.abs(i - j) * 40));
  const input = { stops, trucks: [noLiftTruck], depot: { lat: 0, lng: 0 }, matrix: { durationSec: d, distanceMeters: d }, strategy: 'MIN_DISTANCE', objectiveWeights: { distance: 1, time: 1, balance: 0 }, departEpochSec: 0 };
  const out = repair(input, solveRouting(input));
  out.routes.forEach((r) => assertRouteValid(r, input));
  // C needs a liftgate the only truck lacks → must be spilled with that reason.
  const c = out.unassigned.find((u) => u.stopId === 'C');
  assert.ok(c && c.reasons.some((r) => /liftgate/.test(r)), 'C spilled for liftgate');
});
