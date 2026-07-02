// test/nuvizz-request.test.mjs — shared NuVizz request wrapper (Phase 4).
// Pure logic + the requester orchestration, exercised with stubbed deps so no
// network or Firestore is touched.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryableStatus,
  computeBackoffMs,
  dedupeKey,
  scanIntervalElapsed,
  createNuvizzRequester,
  NuvizzCircuitOpenError,
} from '../netlify/functions/lib/nuvizz-request.mts';

const META = { route: '/load/info', tenant: 'DAVIS' };

// Build a requester with in-memory counter/breaker and a scripted fetch.
function makeHarness({ responses = [], ceiling = 100_000, fetchImpl, breakerMode = 'enforce' } = {}) {
  let dayTotal = 0;
  let tripped = null;
  let calls = 0;
  const logs = [];
  let i = 0;
  const deps = {
    fetchImpl: fetchImpl || (async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return new Response('{}', { status: typeof r === 'number' ? r : 200 });
    }),
    recordCall: async (_m, n) => { dayTotal += n; calls++; return dayTotal; },
    isCircuitOpen: async () => tripped != null,
    tripCircuit: async (reason) => { tripped = reason; },
    log: (e) => logs.push(e),
    now: () => 1_000_000, // frozen clock
    sleep: async () => {}, // no real waiting
  };
  const r = createNuvizzRequester(deps, { dailyCeiling: ceiling, breakerMode, maxRetries: 3, backoffTotalCapMs: 1_000_000 });
  return { r, get dayTotal() { return dayTotal; }, get tripped() { return tripped; }, get calls() { return calls; }, logs };
}

test('isRetryableStatus: 429 and 5xx retry; 200/404 do not', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(401), false);
});

test('computeBackoffMs: grows by factor and is capped at backoffMaxMs', () => {
  const cfg = { backoffBaseMs: 500, backoffFactor: 2, backoffMaxMs: 8000 };
  const d0 = computeBackoffMs(0, cfg);
  const d1 = computeBackoffMs(1, cfg);
  const d2 = computeBackoffMs(2, cfg);
  assert.ok(d1 > d0, 'attempt 1 waits longer than attempt 0');
  assert.ok(d2 > d1, 'attempt 2 waits longer than attempt 1');
  // attempt 10 would be 500*2^10 = 512000 -> capped near 8000 (+/-10% jitter)
  assert.ok(computeBackoffMs(10, cfg) <= 8000 * 1.1 + 1, 'capped at backoffMaxMs + jitter');
});

test('dedupeKey is method+url', () => {
  assert.equal(dedupeKey('get', 'https://x/load/info/1'), 'GET https://x/load/info/1');
});

test('scanIntervalElapsed: floor honored, null = always scan', () => {
  const now = 1_000_000_000;
  assert.equal(scanIntervalElapsed(null, now, 600_000), true);
  assert.equal(scanIntervalElapsed(new Date(now).toISOString(), now, 600_000), false, 'just scanned -> too soon');
  assert.equal(scanIntervalElapsed(new Date(now - 700_000).toISOString(), now, 600_000), true, 'past floor -> ok');
});

test('counts every round-trip against the shared daily counter', async () => {
  const h = makeHarness({ responses: [200] });
  await h.r.request('https://x/load/info/1/DAVIS', {}, META);
  await h.r.request('https://x/load/info/2/DAVIS', {}, META);
  assert.equal(h.dayTotal, 2, 'two distinct calls counted');
});

test('in-flight dedupe: concurrent identical GETs hit the network once', async () => {
  let fetches = 0;
  const h = makeHarness({
    fetchImpl: async () => { fetches++; await new Promise((r) => setTimeout(r, 5)); return new Response('{}', { status: 200 }); },
  });
  const url = 'https://x/load/info/42/DAVIS';
  const [a, b] = await Promise.all([h.r.request(url, {}, META), h.r.request(url, {}, META)]);
  assert.equal(fetches, 1, 'only one real fetch for two concurrent identical GETs');
  assert.equal(h.dayTotal, 1, 'only one counted');
  // both callers get a usable (cloned) response
  assert.equal(a.status, 200); assert.equal(b.status, 200);
});

test('POSTs are never deduped', async () => {
  let fetches = 0;
  const h = makeHarness({
    fetchImpl: async () => { fetches++; await new Promise((r) => setTimeout(r, 5)); return new Response('{}', { status: 200 }); },
  });
  const url = 'https://x/load/insertstops';
  await Promise.all([
    h.r.request(url, { method: 'POST', body: '{}' }, META),
    h.r.request(url, { method: 'POST', body: '{}' }, META),
  ]);
  assert.equal(fetches, 2, 'two POSTs => two fetches');
});

test('retries on 503 then succeeds, counting each attempt', async () => {
  let i = 0;
  const h = makeHarness({
    fetchImpl: async () => { i++; return new Response('{}', { status: i < 3 ? 503 : 200 }); },
  });
  const resp = await h.r.request('https://x/load/info/7/DAVIS', {}, META);
  assert.equal(resp.status, 200, 'eventually succeeds');
  assert.equal(i, 3, 'two 503s then a 200');
  assert.equal(h.dayTotal, 3, 'all three round-trips counted');
});

test('gives up after maxRetries and returns the last 5xx', async () => {
  const h = makeHarness({ fetchImpl: async () => new Response('{}', { status: 500 }) });
  const resp = await h.r.request('https://x/load/info/8/DAVIS', {}, META);
  assert.equal(resp.status, 500);
  assert.equal(h.dayTotal, 4, 'attempt + 3 retries = 4 counted round-trips');
});

test('trips the circuit breaker at the daily ceiling and then refuses', async () => {
  const h = makeHarness({ responses: [200], ceiling: 3 });
  await h.r.request('https://x/load/info/1/DAVIS', {}, META);
  await h.r.request('https://x/load/info/2/DAVIS', {}, META);
  assert.equal(h.tripped, null, 'not yet at ceiling');
  await h.r.request('https://x/load/info/3/DAVIS', {}, META); // count hits 3 == ceiling -> trip
  assert.ok(h.tripped && /ceiling/.test(h.tripped), 'breaker tripped at ceiling');
  // next request is refused outright
  await assert.rejects(
    () => h.r.request('https://x/load/info/4/DAVIS', {}, META),
    (e) => e instanceof NuvizzCircuitOpenError,
  );
});

test('monitor mode: crosses the ceiling but never trips or blocks (logs would-trip)', async () => {
  const h = makeHarness({ responses: [200], ceiling: 2, breakerMode: 'monitor' });
  await h.r.request('https://x/load/info/1/DAVIS', {}, META);
  await h.r.request('https://x/load/info/2/DAVIS', {}, META); // hits ceiling=2
  await h.r.request('https://x/load/info/3/DAVIS', {}, META); // over ceiling
  assert.equal(h.tripped, null, 'monitor never opens the breaker');
  assert.equal(h.dayTotal, 3, 'all calls still counted past the ceiling');
  // not refused — the scan keeps running
  const resp = await h.r.request('https://x/load/info/4/DAVIS', {}, META);
  assert.equal(resp.status, 200, 'monitor never blocks a request');
  const wouldTrip = h.logs.filter((e) => e.event === 'circuit-would-trip');
  assert.equal(wouldTrip.length, 1, 'logs a single would-trip warning at the ceiling');
  assert.equal(wouldTrip[0].mode, 'monitor');
});
