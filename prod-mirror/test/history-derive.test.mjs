// test/history-derive.test.mjs
//
// Unit tests for the PURE history-warehouse derivation logic (lib/history-derive.mts).
// Run with: npm test   (node --test — Node ≥ 22 strips the .mts types natively).
//
// Fixture (test/fixtures/history-normalized-stops.json) is a small set of
// NormalizedStop objects covering planned, unplanned, multi-stop-per-load, and
// executed (with raw stopExecutionInfo) examples — exactly the shapes scanDate()
// emits — so we exercise grouping, ordering, sums, completion counts, the driver
// fallback key, on-time metrics, four-layer preservation, and the checksum.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildStopRecord, deriveRoutes, deriveDrivers, computeStopChecksum,
  manifestCountsFromReadback, stopMatchKey, driverKeyFor, DEPOT,
} from '../netlify/functions/lib/history-derive.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STOPS = JSON.parse(readFileSync(join(__dirname, 'fixtures/history-normalized-stops.json'), 'utf8'));

const CTX = {
  tenant: 'davis',
  date: '2026-05-30',
  capture: { capture_version: 1, captured_at: '2026-05-31T06:00:00.000Z', source_scanned_at: '2026-05-31T05:59:00.000Z', app_version: '0.12.0' },
};

const routeById = (routes, loadNbr) => routes.find((r) => r.loadNbr === loadNbr);
const driverByKey = (drivers, key) => drivers.find((d) => d.driverKey === key);

test('deriveRoutes: only planned stops become routes (unplanned excluded)', () => {
  const routes = deriveRoutes(STOPS, CTX);
  assert.equal(routes.length, 3, 'three loads → three routes');
  const loadNbrs = routes.map((r) => r.loadNbr).sort();
  assert.deepEqual(loadNbrs, ['DAVIS000200001', 'DAVIS000200002', 'DAVIS000200003']);
  // No route should contain an unplanned stopNbr.
  const allRouteStops = routes.flatMap((r) => r.stops.map((s) => s.stopNbr));
  assert.ok(!allRouteStops.includes('007100030'));
  assert.ok(!allRouteStops.includes('007100031'));
});

test('deriveRoutes: stops are ordered by loadStopSeq; sums + completion correct', () => {
  const a = routeById(deriveRoutes(STOPS, CTX), 'DAVIS000200001');
  assert.deepEqual(a.stops.map((s) => s.stopNbr), ['007100001', '007100002', '007100003']);
  assert.equal(a.stopCount, 3);
  assert.equal(a.completedCount, 2, 'two DELIVERED of three');
  assert.equal(a.totalPallets, 10);
  assert.equal(a.totalWeight, 2000);
  assert.equal(a.routeName, 'DULUTH');
  assert.equal(a.driverUserName, 'VINCENT');
  assert.deepEqual(a.origin, DEPOT);
});

test('deriveRoutes: ordering is stable even when input is shuffled', () => {
  const shuffled = [...STOPS].reverse();
  const a = routeById(deriveRoutes(shuffled, CTX), 'DAVIS000200001');
  assert.deepEqual(a.stops.map((s) => s.stopNbr), ['007100001', '007100002', '007100003']);
});

test('deriveRoutes: plannedDistance/Duration sum where present, null where absent', () => {
  const routes = deriveRoutes(STOPS, CTX);
  const a = routeById(routes, 'DAVIS000200001');
  assert.equal(a.plannedDistance, 20.5, '12.5 + 8 (last stop has none)');
  assert.equal(a.plannedDuration, 35, '20 + 15');
  const b = routeById(routes, 'DAVIS000200002');
  assert.equal(b.plannedDistance, 5);
  assert.equal(b.plannedDuration, 10);
  const c = routeById(routes, 'DAVIS000200003');
  assert.equal(c.plannedDistance, null, 'no legs present → null, not 0');
  assert.equal(c.plannedDuration, null);
});

test('deriveDrivers: groups by driverUserName with stable fallback key', () => {
  const drivers = deriveDrivers(STOPS, CTX);
  assert.equal(drivers.length, 3);
  const vincent = driverByKey(drivers, 'VINCENT');
  assert.deepEqual(vincent.loadNbrs, ['DAVIS000200001']);
  assert.equal(vincent.routeCount, 1);
  assert.equal(vincent.stopCount, 3);
  assert.equal(vincent.completedCount, 2);
  // PETE SOLO has no driverUserName → fallback slug key.
  const pete = driverByKey(drivers, 'name_pete_solo');
  assert.ok(pete, 'fallback key present');
  assert.equal(pete.driverUserName, null);
  assert.equal(pete.driverName, 'PETE SOLO');
  assert.equal(pete.completedCount, 0);
});

test('deriveDrivers: on-time metrics only counted where eta AND delivery exist', () => {
  const drivers = deriveDrivers(STOPS, CTX);
  const vincent = driverByKey(drivers, 'VINCENT');
  // A1 delivered 13:50 ≤ eta 14:00 (on time); A3 delivered 16:30 > eta 16:00 (late);
  // A2 has no delivery → not measured.
  assert.equal(vincent.measuredDeliveries, 2);
  assert.equal(vincent.onTimeDeliveries, 1);
  assert.equal(vincent.lateDeliveries, 1);
  const trevor = driverByKey(drivers, 'TREVOR');
  assert.equal(trevor.measuredDeliveries, 2);
  assert.equal(trevor.onTimeDeliveries, 2);
  assert.equal(trevor.lateDeliveries, 0);
});

test('deriveDrivers: motiveActuals is a null v1.1 hook', () => {
  for (const d of deriveDrivers(STOPS, CTX)) assert.equal(d.motiveActuals, null);
});

test('driverKeyFor: prefers userName, else name slug, else unknown', () => {
  assert.equal(driverKeyFor({ driverUserName: 'VINCENT' }), 'VINCENT');
  assert.equal(driverKeyFor({ driverUserName: '  multi word ' }), 'MULTI_WORD');
  assert.equal(driverKeyFor({ driverUserName: null, driverName: 'PETE SOLO' }), 'name_pete_solo');
  assert.equal(driverKeyFor({}), 'unknown');
});

test('buildStopRecord: FOUR-LAYER preservation + surfaced executed timestamps + matchKey', () => {
  const a1 = STOPS.find((s) => s.stopNbr === '007100001');
  const rec = buildStopRecord(a1, CTX);
  // Raw is preserved untouched (the dwell-learning signal lives here).
  assert.ok(rec.raw && rec.raw.stopExecutionInfo, 'raw + stopExecutionInfo retained');
  assert.equal(rec.raw.stopExecutionInfo.to.confirmedDTTM, '2026-05-30T13:50:00');
  // Executed timestamps surfaced for queryability.
  assert.equal(rec.executed.confirmedDTTM, '2026-05-30T13:50:00');
  assert.equal(rec.executed.receiveDTTM, '2026-05-30T13:50:00');
  assert.equal(rec.executed.arrivalDTTM, '2026-05-30T13:40:00');
  assert.equal(rec.executed.stopStatus, '90');
  // Queryable derivations + capture lineage.
  assert.equal(rec.customerMatchKey, stopMatchKey(a1));
  assert.equal(rec.isPlanned, true);
  assert.equal(rec.tenant, 'davis');
  assert.equal(rec.date, '2026-05-30');
  assert.equal(rec.capture_version, 1);
});

test('computeStopChecksum: order-independent, changes when an outcome changes', () => {
  const base = computeStopChecksum(STOPS);
  const shuffled = computeStopChecksum([...STOPS].reverse());
  assert.equal(base, shuffled, 'same set → same checksum regardless of order');

  const mutated = STOPS.map((s) => s.stopNbr === '007100002' ? { ...s, normalizedStatus: 'DELIVERED' } : s);
  assert.notEqual(computeStopChecksum(mutated), base, 'status change → new checksum');
});

test('manifestCountsFromReadback: planned/unplanned split from readback docs', () => {
  // Simulate a readback of the persisted stop docs.
  const stopDocs = STOPS.map((s) => ({ _id: s.stopNbr, isPlanned: s.isPlanned }));
  const routeDocs = deriveRoutes(STOPS, CTX).map((r) => ({ _id: r.loadNbr }));
  const driverDocs = deriveDrivers(STOPS, CTX).map((d) => ({ _id: d.driverKey }));
  const counts = manifestCountsFromReadback(stopDocs, routeDocs, driverDocs);
  assert.deepEqual(counts, { stops: 8, planned: 6, unplanned: 2, routes: 3, drivers: 3 });
});
