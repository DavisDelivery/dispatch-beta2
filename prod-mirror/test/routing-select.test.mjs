// P2 (PR3) — unit tests for the Routing tab's selection geometry + per-stop
// display helpers. These import the SAME functions App.jsx ships (no copies),
// so they prove the core of Add-in-view (latLngInBounds), Box (boxFromCorners +
// latLngInBounds), Lasso (pointInPolygon), and the stop-detail formatting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInPolygon, latLngInBounds, boxFromCorners,
  fmtTime12, formatReceivingHours, lineItemDims,
  moveItem, recomputeRoute, haversineMeters,
} from '../src/lib/routing-select.js';

// ── Lasso: ray-casting point-in-polygon ──
test('pointInPolygon: inside vs outside a square', () => {
  const square = [[0, 0], [0, 10], [10, 10], [10, 0]]; // [lat,lng]
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(pointInPolygon(5, 15, square), false);
});

test('pointInPolygon: degenerate paths never select', () => {
  assert.equal(pointInPolygon(5, 5, [[0, 0], [0, 10]]), false); // <3 vertices
  assert.equal(pointInPolygon(null, 5, [[0, 0], [0, 10], [10, 10]]), false);
});

test('pointInPolygon: concave (lasso) polygon excludes the notch', () => {
  // A "C" shape: point in the notch must be excluded.
  const c = [[0, 0], [0, 10], [4, 10], [4, 4], [8, 4], [8, 10], [12, 10], [12, 0]];
  assert.equal(pointInPolygon(6, 8, c), false); // in the notch
  assert.equal(pointInPolygon(2, 5, c), true);  // in the solid part
});

// ── Add-in-view / Box: bounding-box containment ──
test('latLngInBounds: inclusive of edges, excludes outside', () => {
  const box = { north: 10, south: 0, east: 10, west: 0 };
  assert.equal(latLngInBounds(5, 5, box), true);
  assert.equal(latLngInBounds(10, 0, box), true);   // corner
  assert.equal(latLngInBounds(11, 5, box), false);  // north of
  assert.equal(latLngInBounds(5, -1, box), false);  // west of
  assert.equal(latLngInBounds(null, 5, box), false);
});

test('boxFromCorners normalizes any two tapped corners', () => {
  // Corners tapped in any order produce the same normalized box.
  const a = boxFromCorners({ lat: 10, lng: 2 }, { lat: 1, lng: 9 });
  assert.deepEqual(a, { north: 10, south: 1, east: 9, west: 2 });
  const b = boxFromCorners({ lat: 1, lng: 9 }, { lat: 10, lng: 2 });
  assert.deepEqual(a, b);
});

test('Box end-to-end: corners → box → enclosed stops', () => {
  const stops = [
    { stopNbr: 'A', lat: 34.1, lng: -84.0 },  // inside
    { stopNbr: 'B', lat: 34.9, lng: -83.1 },  // inside
    { stopNbr: 'C', lat: 33.0, lng: -84.0 },  // south, out
    { stopNbr: 'D', lat: 34.5, lng: -82.0 },  // east, out
  ];
  const box = boxFromCorners({ lat: 34.0, lng: -84.5 }, { lat: 35.0, lng: -83.0 });
  const inside = stops.filter((s) => latLngInBounds(s.lat, s.lng, box)).map((s) => s.stopNbr);
  assert.deepEqual(inside, ['A', 'B']);
});

test('Desktop drag-box selects the same set regardless of drag direction', () => {
  // The desktop rubber-band drag can start from any corner; the two LatLng
  // corners it produces must normalize to one box and select the same stops.
  const stops = [
    { stopNbr: 'A', lat: 34.1, lng: -84.0 },  // inside
    { stopNbr: 'B', lat: 34.9, lng: -83.1 },  // inside
    { stopNbr: 'C', lat: 33.0, lng: -84.0 },  // out
  ];
  const tl = { lat: 35.0, lng: -84.5 }, br = { lat: 34.0, lng: -83.0 };
  const tr = { lat: 35.0, lng: -83.0 }, bl = { lat: 34.0, lng: -84.5 };
  const sel = (a, b) => stops.filter((s) => latLngInBounds(s.lat, s.lng, boxFromCorners(a, b))).map((s) => s.stopNbr);
  const expected = ['A', 'B'];
  assert.deepEqual(sel(tl, br), expected); // drag ↘
  assert.deepEqual(sel(br, tl), expected); // drag ↖
  assert.deepEqual(sel(tr, bl), expected); // drag ↙
  assert.deepEqual(sel(bl, tr), expected); // drag ↗
});

// ── Receiving-hours formatting ──
test('fmtTime12 converts 24h to compact 12h, passes through am/pm', () => {
  assert.equal(fmtTime12('08:00'), '8:00a');
  assert.equal(fmtTime12('14:30'), '2:30p');
  assert.equal(fmtTime12('00:15'), '12:15a');
  assert.equal(fmtTime12('12:00'), '12:00p');
  assert.equal(fmtTime12('8AM'), '8a');       // already meridiem → normalized
  assert.equal(fmtTime12(''), '');
});

test('formatReceivingHours groups consecutive identical days into ranges', () => {
  const note = {
    receiving_hours: {
      mon: { open: '08:00', close: '15:00' },
      tue: { open: '08:00', close: '15:00' },
      wed: { open: '08:00', close: '15:00' },
      thu: { open: '08:00', close: '15:00' },
      fri: { open: '08:00', close: '15:00' },
      sat: { open: '', close: '' },
      sun: { open: '', close: '' },
    },
    closed_days: ['sat'],
  };
  assert.equal(formatReceivingHours(note), 'Mon–Fri 8:00a–3:00p · Sat Closed');
});

test('formatReceivingHours handles legacy strings and empty notes', () => {
  assert.equal(formatReceivingHours({ receiving_hours: { mon: '6AM-2PM' } }), 'Mon 6AM-2PM');
  assert.equal(formatReceivingHours(null), null);
  assert.equal(formatReceivingHours({}), null);
  assert.equal(formatReceivingHours({ receiving_hours: {} }), null);
});

// ── Line-item dimensions ──
test('lineItemDims renders L×W×H, falls back to critical dimension, else empty', () => {
  assert.equal(lineItemDims({ length: 96, width: 48, height: 40, lengthUOM: 'in' }), '96×48×40 in');
  assert.equal(lineItemDims({ length: 144, lengthUOM: 'IN' }), '144×–×– IN');
  assert.equal(lineItemDims({ criticalDimension: 144, criticalDimensionUOM: 'IN' }), '144 IN');
  assert.equal(lineItemDims({ criticalDimension: 120 }), '120 in');
  assert.equal(lineItemDims({}), '');
  assert.equal(lineItemDims(null), '');
});

// ── Manual route reorder helpers ──
test('moveItem reorders within the array and renumbers implicitly by position', () => {
  assert.deepEqual(moveItem(['A', 'B', 'C', 'D'], 0, 2), ['B', 'C', 'A', 'D']); // A down to index 2
  assert.deepEqual(moveItem(['A', 'B', 'C', 'D'], 3, 0), ['D', 'A', 'B', 'C']); // D to front
  assert.deepEqual(moveItem(['A', 'B', 'C'], 1, 1), ['A', 'B', 'C']);           // no-op
  assert.deepEqual(moveItem(['A', 'B', 'C'], 0, 9), ['A', 'B', 'C']);           // out of range → unchanged copy
});

test('recomputeRoute: order-dependent legs/ETAs, depot-anchored, service dwell applied', () => {
  const depot = { lat: 0, lng: 0 };
  const stops = [{ id: 'S1', lat: 0, lng: 1 }, { id: 'S2', lat: 0, lng: 2 }];
  const r = recomputeRoute(stops, depot, 0, 600); // depart at 0, 10min service
  assert.equal(r.legs.length, 2);
  assert.equal(r.etas.length, 2);
  assert.equal(r.legs[0].fromId, 'depot');
  assert.equal(r.legs[1].fromId, 'S1');
  // ETA(S2) = drive(depot->S1) + service + drive(S1->S2)
  assert.equal(r.etas[1], r.legs[0].durationSec + 600 + r.legs[1].durationSec);
  assert.ok(r.totalDistanceMeters > 0 && r.totalDurationSec > 0);
});

test('recomputeRoute: reversing the order changes the total distance', () => {
  const depot = { lat: 0, lng: 0 };
  const fwd = recomputeRoute([{ id: 'A', lat: 0, lng: 1 }, { id: 'B', lat: 0, lng: 5 }], depot, 0, 0);
  const rev = recomputeRoute([{ id: 'B', lat: 0, lng: 5 }, { id: 'A', lat: 0, lng: 1 }], depot, 0, 0);
  assert.notEqual(fwd.totalDistanceMeters, rev.totalDistanceMeters);
});

test('recomputeRoute: single-stop and empty routes are clean', () => {
  const depot = { lat: 34, lng: -84 };
  const one = recomputeRoute([{ id: 'X', lat: 34.1, lng: -84.1 }], depot, 1000, 600);
  assert.equal(one.legs.length, 1);
  assert.equal(one.etas.length, 1);
  assert.equal(one.etas[0], 1000 + one.legs[0].durationSec);
  const none = recomputeRoute([], depot, 0, 600);
  assert.deepEqual(none.legs, []);
  assert.deepEqual(none.etas, []);
  assert.equal(none.totalDistanceMeters, 0);
});

test('haversineMeters is ~0 for identical points and positive otherwise', () => {
  assert.equal(Math.round(haversineMeters({ lat: 34, lng: -84 }, { lat: 34, lng: -84 })), 0);
  assert.ok(haversineMeters({ lat: 34, lng: -84 }, { lat: 34.1, lng: -84 }) > 1000);
});

// ── Per-load re-sequence strategies ──
import { resequence, depotSort, nearestNeighbor, twoOpt } from '../src/lib/routing-select.js';

const depot0 = { lat: 0, lng: 0 };
// Stops at increasing distance east of the depot.
const pts = [
  { id: 'C', lat: 0, lng: 3 },
  { id: 'A', lat: 0, lng: 1 },
  { id: 'D', lat: 0, lng: 5 },
  { id: 'B', lat: 0, lng: 2 },
];
const ids = (arr) => arr.map((s) => s.id);

test('resequence reverse flips the current order', () => {
  assert.deepEqual(ids(resequence(pts, depot0, 'reverse')), ['B', 'D', 'A', 'C']);
});

test('resequence closest/farthest sort by depot distance', () => {
  assert.deepEqual(ids(resequence(pts, depot0, 'closest')), ['A', 'B', 'C', 'D']);
  assert.deepEqual(ids(resequence(pts, depot0, 'farthest')), ['D', 'C', 'B', 'A']);
});

test('resequence min returns a full permutation and is no worse than the input order', () => {
  const out = resequence(pts, depot0, 'min');
  assert.deepEqual([...ids(out)].sort(), ['A', 'B', 'C', 'D']); // permutation, all present
  // for these colinear points the optimal tour is A,B,C,D (nearest-neighbour + 2opt finds it)
  assert.deepEqual(ids(out), ['A', 'B', 'C', 'D']);
});

test('resequence is a no-op for <2 stops and unknown strategy', () => {
  assert.deepEqual(ids(resequence([pts[0]], depot0, 'min')), ['C']);
  assert.deepEqual(ids(resequence(pts, depot0, 'bogus')), ['C', 'A', 'D', 'B']);
});

test("resequence 'loop' makes a U-shape — down one side of the corridor and back the other", () => {
  const depot = { lat: 0, lng: 0 };
  // Highway runs east-west; stops sit on the south (lat -1) and north (lat +1) sides,
  // fed in a criss-crossing zigzag order (S,N,S,N,…) like the "Farthest first" complaint.
  const corridor = [
    { id: 'S1', lat: -1, lng: 1 }, { id: 'N1', lat: 1, lng: 1 },
    { id: 'S2', lat: -1, lng: 2 }, { id: 'N2', lat: 1, lng: 2 },
    { id: 'S3', lat: -1, lng: 3 }, { id: 'N3', lat: 1, lng: 3 },
  ];
  const out = resequence(corridor, depot, 'loop');
  assert.deepEqual([...ids(out)].sort(), ['N1', 'N2', 'N3', 'S1', 'S2', 'S3']); // permutation
  // U-shape signature: the order runs all the way out along one side, then back along the
  // other — exactly ONE switch between the south and north sides (no zigzag crossings).
  const sides = out.map((s) => (s.lat < 0 ? 'S' : 'N'));
  const switches = sides.filter((v, i) => i > 0 && v !== sides[i - 1]).length;
  assert.equal(switches, 1, `expected one side-switch (U-shape), got ${switches}: ${ids(out).join(',')}`);
});
