// test/routing-cost.test.mjs — 5b: cheap-by-default matrix mode + cost readout.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matrixElementCount, estimateMatrixCostUsd, DEFAULT_MATRIX_MODE,
} from '../netlify/functions/lib/routing-types.mts';
import { resolveMatrix } from '../netlify/functions/google-route-matrix.mts';
import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';

test('default matrix mode is haversine (free)', () => {
  assert.equal(DEFAULT_MATRIX_MODE, 'haversine');
});

test('matrixElementCount = (stops+1)^2 ; cost only when google', () => {
  assert.equal(matrixElementCount(3), 16);   // depot + 3 = 4 nodes → 16 elements
  assert.equal(matrixElementCount(9), 100);
  assert.equal(estimateMatrixCostUsd(100, 'haversine'), 0);
  assert.equal(estimateMatrixCostUsd(100, 'google'), 0.5);   // 100/1000 * $5
  assert.equal(estimateMatrixCostUsd(2000, 'google'), 10);
});

test('resolveMatrix uses haversine by default EVEN WHEN the key is present (no Google call)', async () => {
  const prev = process.env.GOOGLE_ROUTES_API_KEY;
  process.env.GOOGLE_ROUTES_API_KEY = 'test-key-present';
  try {
    const { source } = await resolveMatrix({ lat: 34, lng: -83 }, [{ lat: 34.1, lng: -83.1 }]); // default mode
    assert.equal(source, 'haversine', 'must not bill Google unless mode=google');
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_ROUTES_API_KEY; else process.env.GOOGLE_ROUTES_API_KEY = prev;
  }
});

test('resolveMatrix mode=google with NO key gracefully falls back to haversine', async () => {
  const prev = process.env.GOOGLE_ROUTES_API_KEY;
  delete process.env.GOOGLE_ROUTES_API_KEY;
  try {
    const { source } = await resolveMatrix({ lat: 34, lng: -83 }, [{ lat: 34.1, lng: -83.1 }], 'google');
    assert.equal(source, 'haversine');
  } finally {
    if (prev !== undefined) process.env.GOOGLE_ROUTES_API_KEY = prev;
  }
});

const stops = [
  { stopNbr: 'S1', lat: 0, lng: 1, pallets: 1, weight: 100, weightUOM: 'LB', stopDetails: [] },
  { stopNbr: 'S2', lat: 0, lng: 2, pallets: 1, weight: 100, weightUOM: 'LB', stopDetails: [] },
  { stopNbr: 'S3', lat: 0, lng: 3, pallets: 1, weight: 100, weightUOM: 'LB', stopDetails: [] },
];
const truck = { id: 'BOX', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 } };
const matrixDep = (source) => async (depot, pts) => {
  const nodes = [depot, ...pts];
  const d = nodes.map((a) => nodes.map((b) => Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 1000)));
  return source ? { matrix: { distanceMeters: d, durationSec: d }, source } : { distanceMeters: d, durationSec: d };
};

test('pipeline meta: haversine build reports $0 and the would-be element count', async () => {
  const plan = await runPipeline(
    { stops, trucks: [truck], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' }, // no matrixMode → default
    { buildMatrix: matrixDep('haversine') },
  );
  assert.equal(plan.meta.matrixSource, 'haversine');
  assert.equal(plan.meta.googleElementCount, 16); // 3 stops + depot
  assert.equal(plan.meta.estimatedCostUsd, 0);
});

test('pipeline meta: google build reports the element count and estimated cost', async () => {
  const plan = await runPipeline(
    { stops, trucks: [truck], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10', matrixMode: 'google' },
    { buildMatrix: matrixDep('google') },
  );
  assert.equal(plan.meta.matrixSource, 'google');
  assert.equal(plan.meta.googleElementCount, 16);
  assert.equal(plan.meta.estimatedCostUsd, estimateMatrixCostUsd(16, 'google')); // 16/1000*5 = 0.08
});

test('legacy bare-matrix dep still works (back-compat); source defaults to requested mode', async () => {
  const plan = await runPipeline(
    { stops, trucks: [truck], depot: { lat: 0, lng: 0 }, strategy: 'MIN_DISTANCE', date: '2026-06-10' },
    { buildMatrix: matrixDep(null) }, // returns a bare matrix, no {source}
  );
  assert.equal(plan.routes.length, 1);
  assert.equal(plan.meta.matrixSource, 'haversine');
});
