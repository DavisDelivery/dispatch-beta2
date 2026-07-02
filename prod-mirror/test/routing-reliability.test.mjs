// test/routing-reliability.test.mjs — PR 5A: prove the build path can't hang and
// that a default build is deterministic with ZERO model calls. Imports the REAL
// shipping functions (no copies).

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchWithTimeout, withDeadline } from '../netlify/functions/lib/async-util.mts';
import { resolveMatrix } from '../netlify/functions/google-route-matrix.mts';
import { runPipeline } from '../netlify/functions/lib/routing-pipeline.mts';

// ── withDeadline (the job watchdog mechanism) ──
test('withDeadline resolves when the work settles first', async () => {
  const v = await withDeadline(Promise.resolve(42), 1000, 'too slow');
  assert.equal(v, 42);
});

test('withDeadline rejects with its message when the work overruns', async () => {
  const never = new Promise(() => {}); // never settles
  await assert.rejects(withDeadline(never, 20, 'build timed out — try fewer stops'),
    (e) => e.message === 'build timed out — try fewer stops');
});

// ── fetchWithTimeout (per-call abort) ──
test('fetchWithTimeout aborts a hanging request at the deadline', async () => {
  const orig = global.fetch;
  // A fetch that never resolves on its own and only rejects when aborted.
  global.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  try {
    await assert.rejects(fetchWithTimeout('https://example.test', {}, 20));
  } finally {
    global.fetch = orig;
  }
});

// ── resolveMatrix fallback (a failed/stalled Google call must not break the build) ──
test('resolveMatrix falls back to haversine when the Google call fails', async () => {
  const orig = global.fetch;
  process.env.GOOGLE_ROUTES_API_KEY = 'test-key';
  global.fetch = () => Promise.reject(new Error('boom')); // models an aborted/failed call
  try {
    const { source, matrix } = await resolveMatrix({ lat: 34, lng: -84 }, [{ lat: 34.1, lng: -84.1 }, { lat: 34.2, lng: -84.2 }], 'google');
    assert.equal(source, 'haversine');             // degraded, not broken
    assert.equal(matrix.durationSec.length, 3);    // depot + 2 stops
  } finally {
    global.fetch = orig;
    delete process.env.GOOGLE_ROUTES_API_KEY;
  }
});

test('resolveMatrix default mode makes no network call at all', async () => {
  const orig = global.fetch;
  global.fetch = () => { throw new Error('network must not be touched on a free build'); };
  try {
    const { source } = await resolveMatrix({ lat: 34, lng: -84 }, [{ lat: 34.1, lng: -84.1 }], 'haversine');
    assert.equal(source, 'haversine');
  } finally {
    global.fetch = orig;
  }
});

// ── default build = deterministic, zero model calls ──
const mockMatrix = () => async (depot, pts) => {
  const nodes = [depot, ...pts];
  const dist = (a, b) => Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 1000);
  const distanceMeters = nodes.map((a) => nodes.map((b) => dist(a, b)));
  return { distanceMeters, durationSec: distanceMeters };
};
const truck = (over = {}) => ({
  id: 'BOX', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312,
  capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 }, ...over,
});
const stopsNear = (n) => Array.from({ length: n }, (_, i) => ({
  stopNbr: `S${i}`, lat: 34.1 + i * 0.01, lng: -84.0 - i * 0.01,
  pallets: 1, weight: 200, weightUOM: 'LB', stopDetails: [],
}));

test('default build (no model deps) yields a valid plan and reports aiAssist all-false', async () => {
  // Deps WITHOUT parseIntent/geometryAssist/explain → it is impossible to make a
  // model call; the pipeline must run fully deterministically.
  const plan = await runPipeline(
    { stops: stopsNear(25), trucks: [truck()], date: '2026-06-04', intentText: 'tight first', matrixMode: 'haversine' },
    { buildMatrix: mockMatrix() },
  );
  const placed = plan.routes.reduce((a, r) => a + r.orderedStopIds.length, 0);
  assert.ok(placed + plan.unassigned.length === 25, 'every stop is placed or spilled');
  assert.deepEqual(plan.aiAssist, { intent: false, geometry: false, explain: false });
  assert.equal(plan.meta.matrixSource, 'haversine');
  assert.ok(typeof plan.rationale === 'string' && plan.rationale.length > 0); // deterministic summary
});

test('a deterministic build is fast (<1s) for 25 and 100 stops', async () => {
  for (const n of [25, 100]) {
    const t0 = Date.now();
    const plan = await runPipeline(
      { stops: stopsNear(n), trucks: [truck({ maxSkids: 999, maxWeightLbs: 1e7 })], date: '2026-06-04', matrixMode: 'haversine' },
      { buildMatrix: mockMatrix() },
    );
    const ms = Date.now() - t0;
    const placed = plan.routes.reduce((a, r) => a + r.orderedStopIds.length, 0);
    assert.ok(placed + plan.unassigned.length === n);
    assert.ok(ms < 1000, `deterministic build for ${n} stops took ${ms}ms (expected <1000)`);
  }
});
