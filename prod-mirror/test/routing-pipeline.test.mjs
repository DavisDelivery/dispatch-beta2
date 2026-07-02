// test/routing-pipeline.test.mjs — five-stage pipeline end-to-end with mocks.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';

// Mock matrix dep: euclidean (meters≈deg, durations≈meters). depot first.
function mockMatrix() {
  return async (depot, pts) => {
    const nodes = [depot, ...pts];
    const n = nodes.length;
    const dist = (a, b) => Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 1000);
    const distanceMeters = nodes.map((a) => nodes.map((b) => dist(a, b)));
    return { distanceMeters, durationSec: distanceMeters };
  };
}

const truck = (over = {}) => ({
  id: 'BOX', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312,
  capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 }, ...over,
});

const stops = [
  { stopNbr: 'S1', lat: 0, lng: 1, cartons: 2, weight: 1000, weightUOM: 'LB', stopDetails: [] },
  { stopNbr: 'S2', lat: 0, lng: 2, cartons: 2, weight: 1000, weightUOM: 'LB', stopDetails: [] },
  { stopNbr: 'S3', lat: 0, lng: 3, cartons: 2, weight: 1000, weightUOM: 'LB', stopDetails: [] },
];

test('deterministic-only (no model deps): produces valid routes + deterministic rationale', async () => {
  const plan = await runPipeline(
    { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' },
    { buildMatrix: mockMatrix() }, // no parseIntent/geometryAssist/explain
  );
  assert.equal(plan.routes.length, 1);
  assert.deepEqual(plan.routes[0].orderedStopIds, ['S1', 'S2', 'S3']);
  assert.equal(plan.aiAssist.intent, false);
  assert.equal(plan.aiAssist.explain, false);
  assert.match(plan.rationale, /MIN DISTANCE|min distance/i);
  assert.equal(plan.intent.source, 'fallback');
  // ETAs strictly increase along the route.
  const e = plan.routes[0].etas;
  assert.ok(e[0] < e[1] && e[1] < e[2]);
});

test('intent model output flips the strategy and is reflected in sequencing', async () => {
  const parseIntent = async () => '{"strategy":"FARTHEST_FIRST"}';
  const plan = await runPipeline(
    { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', intentText: 'go to the far ones first', date: '2026-06-10' },
    { buildMatrix: mockMatrix(), parseIntent },
  );
  assert.equal(plan.intent.strategy, 'FARTHEST_FIRST');
  assert.deepEqual(plan.routes[0].orderedStopIds, ['S3', 'S2', 'S1']);
  assert.equal(plan.aiAssist.intent, true);
});

test('explain model output replaces the deterministic rationale + risk flags', async () => {
  const explain = async () => ({ rationale: 'AI says: tight day.', riskFlags: ['Confirm S2 dock hours'] });
  const plan = await runPipeline(
    { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' },
    { buildMatrix: mockMatrix(), explain },
  );
  assert.equal(plan.rationale, 'AI says: tight day.');
  assert.deepEqual(plan.riskFlags, ['Confirm S2 dock hours']);
  assert.equal(plan.aiAssist.explain, true);
});

test('a broken explain model falls back to deterministic summary (no crash)', async () => {
  const explain = async () => { throw new Error('model down'); };
  const plan = await runPipeline(
    { stops, trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' },
    { buildMatrix: mockMatrix(), explain },
  );
  assert.equal(plan.aiAssist.explain, false);
  assert.ok(plan.rationale.length > 0);
});

test('capacity overflow spills with reasons; shown route stays within capacity', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ stopNbr: `S${i}`, lat: 0, lng: i + 1, cartons: 3, weight: 1000, weightUOM: 'LB', stopDetails: [] }));
  const plan = await runPipeline(
    { stops: many, trucks: [truck({ maxSkids: 9 })], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' },
    { buildMatrix: mockMatrix() },
  );
  const route = plan.routes[0];
  assert.ok(route.load.skids <= route.capacity.skids);
  assert.ok(plan.unassigned.length > 0);
  assert.ok(plan.unassigned.every((u) => u.reasons.length > 0));
});

const windowStops = () => [
  { stopNbr: 'NEAR', lat: 0, lng: 1, cartons: 1, weight: 100, weightUOM: 'LB', stopDetails: [] },
  { stopNbr: 'FAR', lat: 0, lng: 500, cartons: 1, weight: 100, weightUOM: 'LB', stopDetails: [], scheduledFrom: '08:00', scheduledTo: '08:05', timeConstraint: 'STRICT' },
];

test('STRICT mode: an unreachable appointment is spilled, route valid', async () => {
  const plan = await runPipeline(
    { stops: windowStops(), trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10', departHHMM: '08:00', windowMode: 'strict' },
    { buildMatrix: mockMatrix() },
  );
  assert.ok(plan.unassigned.some((u) => u.stopId === 'FAR' && u.reasons.some((r) => /window/.test(r))));
  assert.ok(plan.routes.some((r) => r.orderedStopIds.includes('NEAR')));
});

test('ADVISORY (default): an unreachable appointment is KEPT + flagged, zero window spills', async () => {
  const plan = await runPipeline(
    { stops: windowStops(), trucks: [truck()], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10', departHHMM: '08:00' /* default advisory */ },
    { buildMatrix: mockMatrix() },
  );
  // No stop spilled for a window reason.
  assert.ok(!plan.unassigned.some((u) => u.reasons.some((r) => /window/.test(r))), 'no window spills');
  // FAR is kept on a route and flagged via windowViolatedIds.
  const served = plan.routes.flatMap((r) => r.orderedStopIds);
  assert.ok(served.includes('FAR') && served.includes('NEAR'));
  const flagged = new Set(plan.routes.flatMap((r) => r.windowViolatedIds || []));
  assert.ok(flagged.has('FAR'), 'FAR flagged out-of-window');
  // Risk flags name the out-of-window stop, not every STRICT stop.
  assert.ok(plan.riskFlags.some((f) => /FAR/.test(f) && /window/i.test(f)));
});

// ── Chunk A: real-window detection + un-clobbered ordering ──
import { sequence } from '../netlify/functions/lib/routing-solver.mts';

// Same euclidean matrix the mock produces (depot first), to predict sequence().
function euclMatrix(depot, pts) {
  const nodes = [depot, ...pts];
  const dist = (a, b) => Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 1000);
  const distanceMeters = nodes.map((a) => nodes.map((b) => dist(a, b)));
  return { distanceMeters, durationSec: distanceMeters };
}
const bigTruck = () => truck({ maxSkids: 999, maxWeightLbs: 1e7, deckLengthIn: 1e7 });
const PLACEHOLDER = { scheduledFrom: '00:00', scheduledTo: '00:00', timeConstraint: 'STRICT' };
// Input order A,B,C is NOT the optimal path from depot(0,0): A is farthest.
const skewStops = () => [
  { stopNbr: 'A', lat: 0, lng: 3, cartons: 1, weight: 100, weightUOM: 'LB', stopDetails: [], ...PLACEHOLDER },
  { stopNbr: 'B', lat: 0, lng: 1, cartons: 1, weight: 100, weightUOM: 'LB', stopDetails: [], ...PLACEHOLDER },
  { stopNbr: 'C', lat: 0, lng: 2, cartons: 1, weight: 100, weightUOM: 'LB', stopDetails: [], ...PLACEHOLDER },
];
const depot0 = { lat: 0, lng: 0 };

test('placeholder 00:00/00:00 windows are NOT strict and never window-flag/spill', async () => {
  const plan = await runPipeline(
    { stops: skewStops(), trucks: [bigTruck()], depot: depot0, strategy: 'MIN_DISTANCE', date: '2026-06-10', departHHMM: '08:00' },
    { buildMatrix: mockMatrix() },
  );
  assert.equal(plan.unassigned.length, 0, 'no spills');
  const flagged = plan.routes.flatMap((r) => r.windowViolatedIds || []);
  assert.deepEqual(flagged, [], 'placeholder windows never flagged');
});

test('ORDERING: a placeholder-window build ships the strategy order, not input order', async () => {
  const reqStops = skewStops();
  const plan = await runPipeline(
    { stops: reqStops, trucks: [bigTruck()], depot: depot0, strategy: 'MIN_DISTANCE', date: '2026-06-10', departHHMM: '08:00' },
    { buildMatrix: mockMatrix() },
  );
  const route = plan.routes.find((r) => r.orderedStopIds.length === 3);
  assert.ok(route, 'all three on one truck');
  // Predict sequence() on the same matrix/nodes the pipeline used.
  const matrix = euclMatrix(depot0, reqStops.map((s) => ({ lat: s.lat, lng: s.lng })));
  const expected = sequence([1, 2, 3], 'MIN_DISTANCE', matrix).map((n) => reqStops[n - 1].stopNbr);
  assert.deepEqual(route.orderedStopIds, expected, 'route equals MIN_DISTANCE sequence');
  assert.notDeepEqual(route.orderedStopIds, ['A', 'B', 'C'], 'NOT the raw input order (optimizer not clobbered)');
});

test('ORDERING: CLOSEST_FIRST puts the depot-nearest stop first', async () => {
  const plan = await runPipeline(
    { stops: skewStops(), trucks: [bigTruck()], depot: depot0, strategy: 'CLOSEST_FIRST', date: '2026-06-10', departHHMM: '08:00' },
    { buildMatrix: mockMatrix() },
  );
  const route = plan.routes.find((r) => r.orderedStopIds.length === 3);
  // depot-distance asc: B(lng1) < C(lng2) < A(lng3)
  assert.deepEqual(route.orderedStopIds, ['B', 'C', 'A']);
});

test('a genuine wide window stays served + unflagged (real window honored)', async () => {
  const reqStops = [
    { stopNbr: 'N', lat: 0, lng: 1, cartons: 1, weight: 100, weightUOM: 'LB', stopDetails: [] },
    { stopNbr: 'W', lat: 0, lng: 2, cartons: 1, weight: 100, weightUOM: 'LB', stopDetails: [], scheduledFrom: '06:00', scheduledTo: '23:00', timeConstraint: 'STRICT' },
  ];
  const plan = await runPipeline(
    { stops: reqStops, trucks: [bigTruck()], depot: depot0, strategy: 'MIN_DISTANCE', date: '2026-06-10', departHHMM: '08:00' },
    { buildMatrix: mockMatrix() },
  );
  const served = plan.routes.flatMap((r) => r.orderedStopIds);
  assert.ok(served.includes('W') && served.includes('N'));
  const flagged = new Set(plan.routes.flatMap((r) => r.windowViolatedIds || []));
  assert.ok(!flagged.has('W'), 'a reachable real window is not flagged');
});
