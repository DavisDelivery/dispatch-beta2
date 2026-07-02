// test/driver-route.test.mjs — the driver day-snapshot is built from the
// pre-scanned Firestore stop index (ZERO NuVizz calls), not a live ~501-load
// fan-out. Covers driver matching, field mapping, status buckets, sort order.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDriverRouteFromStops } from '../netlify/functions/nuvizz-driver-route.mts';

function stop(over = {}) {
  return {
    stopNbr: '1001',
    loadNbr: 'DAVIS000196900',
    isPlanned: true,
    driverUserName: 'VINCENT',
    driverName: 'VINCENT  BONZO', // NuVizz double-space, on purpose
    normalizedStatus: 'SCHEDULED',
    businessName: 'ACME',
    addr1: '1 Main',
    city: 'Atlanta',
    state: 'GA',
    lat: 33.7,
    lng: -84.3,
    scheduledFrom: '10:00',
    arrivalDTTM: null,
    deliveredDTTM: null,
    ...over,
  };
}

test('matches a driver by stable userName and maps fields from the index', () => {
  const indexed = [
    stop({ stopNbr: 'A', scheduledFrom: '12:00', normalizedStatus: 'DELIVERED', deliveredDTTM: '2026-06-22T17:00:00Z' }),
    stop({ stopNbr: 'B', scheduledFrom: '09:00', normalizedStatus: 'OUT_FOR_DEL' }),
    // a different driver — excluded
    stop({ stopNbr: 'C', driverUserName: 'JIM', driverName: 'Jim Pallette' }),
    // unplanned — excluded (belongs to no driver)
    { stopNbr: 'D', loadNbr: null, isPlanned: false, driverUserName: null, driverName: null, normalizedStatus: 'UNPLANNED' },
  ];
  const r = buildDriverRouteFromStops(indexed, 'Vincent Bonzo', 'VINCENT');
  assert.equal(r.matchedBy, 'userName');
  assert.equal(r.stops.length, 2, 'only the two VINCENT planned stops');
  // sorted by scheduledTime → B (09:00) before A (12:00)
  assert.deepEqual(r.stops.map((s) => s.stopNbr), ['B', 'A']);
  assert.equal(r.stops[0].status, 'en_route');   // OUT_FOR_DEL
  assert.equal(r.stops[1].status, 'completed');  // DELIVERED
  assert.equal(r.stops[1].actualCompletion, '2026-06-22T17:00:00Z');
  assert.equal(r.stops[1].businessName, 'ACME');
  assert.equal(r.route.totalStops, 2);
  assert.equal(r.route.completed, 1);
  assert.equal(r.route.remaining, 1);
  assert.equal(r.route.id, 'DAVIS000196900');
});

test('falls back to whitespace-normalized driverName when userName is unknown', () => {
  const indexed = [stop({ driverUserName: '', driverName: 'VINCENT  BONZO' })];
  const r = buildDriverRouteFromStops(indexed, 'Vincent Bonzo', null);
  assert.equal(r.matchedBy, 'driverName');
  assert.equal(r.stops.length, 1);
});

test('returns an empty route when the driver has no stops in the index', () => {
  const r = buildDriverRouteFromStops([stop({ driverUserName: 'JIM', driverName: 'Jim Pallette' })], 'Vincent Bonzo', 'VINCENT');
  assert.equal(r.route, null);
  assert.deepEqual(r.stops, []);
  assert.equal(r.matchedBy, null);
});

test('status buckets: SCHEDULED/EXCEPTION → pending, ARRIVED → current', () => {
  const indexed = [
    stop({ stopNbr: 'S', normalizedStatus: 'SCHEDULED' }),
    stop({ stopNbr: 'E', normalizedStatus: 'EXCEPTION' }),
    stop({ stopNbr: 'R', normalizedStatus: 'ARRIVED' }),
  ];
  const r = buildDriverRouteFromStops(indexed, 'Vincent Bonzo', 'VINCENT');
  const byNbr = Object.fromEntries(r.stops.map((s) => [s.stopNbr, s.status]));
  assert.equal(byNbr.S, 'pending');
  assert.equal(byNbr.E, 'pending');
  assert.equal(byNbr.R, 'current');
  assert.equal(r.route.completed, 0);
  assert.equal(r.route.remaining, 3);
});

test('tolerates empty / nullish input without throwing', () => {
  assert.deepEqual(buildDriverRouteFromStops([], 'Vincent Bonzo', 'VINCENT'), { route: null, stops: [], matchedBy: null });
  assert.deepEqual(buildDriverRouteFromStops(null, 'Vincent Bonzo', 'VINCENT'), { route: null, stops: [], matchedBy: null });
});
