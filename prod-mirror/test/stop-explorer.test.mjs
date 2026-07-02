// test/stop-explorer.test.mjs — the read-only NuVizz stop-list proxy that backs the
// bottom-grid's "pull from NuVizz" filters. Guards the pure request-builder + the
// row normalizer (column-key mapping) and the period sanitizer, using a fixture that
// mirrors the live VizzonStop filterdata response shape.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBody, normalize, cleanPeriod } from '../netlify/functions/nuvizz-stop-explorer.mts';

test('cleanPeriod: passes NuVizz period grammar, rejects junk', () => {
  assert.equal(cleanPeriod('0d'), '0d');
  assert.equal(cleanPeriod('+/-7d'), '+/-7d');
  assert.equal(cleanPeriod(undefined), '0d', 'default today');
  assert.equal(cleanPeriod("'; DROP"), '0d', 'injection-ish → default');
  assert.equal(cleanPeriod('aaaaaaaaaaaa'), '0d', 'over-long/invalid → default');
});

test('buildBody: status CSV rides seq 2, arrival period seq 10, and required flags present', () => {
  const b = buildBody('+/-7d', '10,20', 1, 200);
  const seq = Object.fromEntries(b.filterList.map((f) => [f.sequence, f.value]));
  assert.equal(seq[2], '10,20', 'status codes on seq 2');
  assert.equal(seq[10], JSON.stringify({ period: '+/-7d' }), 'arrival window on seq 10');
  // NuVizz rejects the request with 1401 unless these are non-null booleans.
  assert.equal(b.canDelete, false);
  assert.equal(b.canEdit, false);
  assert.equal(b.canShow, false);
  assert.equal(b.canSelect, true);
  assert.equal(b.maxResult, 200);
  assert.equal(b.page, 1);
});

test('buildBody: empty status → seq 2 is "-1" (all)', () => {
  const seq = Object.fromEntries(buildBody('0d', '-1', 1, 50).filterList.map((f) => [f.sequence, f.value]));
  assert.equal(seq[2], '-1');
});

test('normalize: maps values rows by column KEY into the grid shape', () => {
  // Mirror the live response: filterData[0] = column defs (ordered), values = row arrays.
  const colOrder = [
    'KeyColumn',
    'default_vizzonInfo.shipmentInfo.status',
    'vizzonInfo.shipmentInfo.stopNbr',
    'vizzonInfo.createdTime',
    'vizzonInfo.shipmentInfo.shipmentNbr',
    'route.driver.driverId',
    'route.name',
    'vizzonInfo.destination.address.name',
    'vizzonInfo.destination.address.line1',
    'vizzonInfo.destination.address.line2',
    'vizzonInfo.destination.address.city',
    'vizzonInfo.destination.address.zipCode',
    'vizzonInfo.shipmentInfo.cartons',
    'vizzonInfo.shipmentInfo.weight',
    'vizzonInfo.shipmentInfo.status',
    'vizzonInfo.shipmentInfo.proNbr',
    'vizzonInfo.destination.earliestSchTime',
    'comments.commentList.commentText',
  ];
  const filterData = [Object.fromEntries(colOrder.map((k) => [k, { columnName: k }]))];
  const row = [
    '6a3b1bbf9974fe314dcdf9f2',
    '10',
    '{"colmnLinkId":"x","columnValue":"007137806","columnLink":"stopdetails/{itemId}"}', // link-object string
    '6/23/26 07:50 PM',
    '007137806',
    'DENIS SALKIC',
    'TRAILER 1',
    'HELLO ATLANTA 45 CIRCLE K',
    '160 TED TURNER DR NW STE C',
    '',
    'ATLANTA',
    '30303',
    '1',
    '427',
    'Un-Planned',
    'G6',
    '6/24/26 08:00 AM',
    'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID',
  ];
  const [r] = normalize({ filterData, values: [row] });
  assert.equal(r.stopNbr, '007137806', 'stopNbr pulled from the link-object columnValue');
  assert.equal(r.statusCode, '10');
  assert.equal(r.statusText, 'Un-Planned');
  assert.equal(r.businessName, 'HELLO ATLANTA 45 CIRCLE K');
  assert.equal(r.city, 'ATLANTA');
  assert.equal(r.zip, '30303');
  assert.equal(r.routeName, 'TRAILER 1', 'load name (blank would mean unplanned)');
  assert.equal(r.driverName, 'DENIS SALKIC');
  assert.equal(r.cartons, 1);
  assert.equal(r.weight, 427);
  assert.equal(r.proNbr, 'G6');
  assert.equal(r.scheduledArrival, '6/24/26 08:00 AM');
  assert.match(r.comments, /DO NOT BREAKDOWN SKID/);
});

test('normalize: empty / malformed response yields no rows (never throws)', () => {
  assert.deepEqual(normalize({}), []);
  assert.deepEqual(normalize({ filterData: [{}], values: [] }), []);
});
