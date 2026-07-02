// test/nuvizz-write-ops.test.mjs — PURE write-op builders + parsers (no network).
// Locks the exact v7 request shapes (handoff doc §3–§6) and the response parsing.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SINGLE_OPS, WRITE_OPS, MUTATING_OPS,
  buildOpRequest, parseOpResponse, buildStopPayload, toEditHeader,
  summarize, assignOk, normalizeStop, normalizeLoad, parseRoster, ROSTER_BODY,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const bodyOf = (r) => JSON.parse(r.body);

// ── allowlists ───────────────────────────────────────────────────────────────
test('op allowlists: WRITE_OPS = single ops + commitLoad; mutating set excludes the two GET reads', () => {
  assert.ok(WRITE_OPS.includes('commitLoad'));
  for (const o of SINGLE_OPS) assert.ok(WRITE_OPS.includes(o));
  assert.equal(MUTATING_OPS.has('getStop'), false);
  assert.equal(MUTATING_OPS.has('getLoad'), false);
  assert.equal(MUTATING_OPS.has('roster'), false);
  for (const o of ['createStop', 'insertStops', 'removeStops', 'assignDriver', 'dispatchLoad', 'commitLoad']) {
    assert.equal(MUTATING_OPS.has(o), true, `${o} must be gated as mutating`);
  }
});

// ── builders ─────────────────────────────────────────────────────────────────
test('roster: POST user/list/{cc} with the documented searchCriteria body', () => {
  const r = buildOpRequest('roster', {}, CREDS);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/user/list/DAVIS');
  assert.deepEqual(bodyOf(r), ROSTER_BODY);
  assert.equal(r.meta.route, '/user/list');
  assert.equal(r.meta.tenant, 'DAVIS');
});

test('createStop: POST stop/sync/update/{cc} with {companyCode, stop}', () => {
  const r = buildOpRequest('createStop', { stop: { stopNbr: '7', foo: 1 } }, CREDS);
  assert.equal(r.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/stop/sync/update/DAVIS');
  const b = bodyOf(r);
  assert.equal(b.companyCode, 'DAVIS');
  assert.deepEqual(b.stop, { stopNbr: '7', foo: 1 });
  assert.equal(r.meta.route, '/stop/sync/update');
});

test('createStop: builds the stop from {row, settings} when no stop is supplied', () => {
  const r = buildOpRequest('createStop', {
    row: { name: 'ACME', addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518' },
    settings: { origin: { name: 'DEPOT', addr1: '9 Hub', city: 'Atlanta', state: 'GA', zip: '30301' }, serviceDate: '2026-06-29' },
  }, CREDS);
  const stop = bodyOf(r).stop;
  assert.equal(stop.to.address.name, 'ACME');
  assert.equal(stop.to.address.zip, '30518');
  assert.equal(stop.from.address.name, 'DEPOT');
});

test('createStop: throws when neither stop nor row is provided', () => {
  assert.throws(() => buildOpRequest('createStop', {}, CREDS), /missing stop/);
});

test('getStop / getLoad: GET info routes with the id in the path and no body', () => {
  const s = buildOpRequest('getStop', { stopNbr: '007139395' }, CREDS);
  assert.equal(s.method, 'GET');
  assert.equal(s.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/stop/info/007139395/DAVIS');
  assert.equal(s.body, undefined);
  const l = buildOpRequest('getLoad', { loadNbr: 'BEN 2' }, CREDS);
  assert.equal(l.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/load/info/BEN%202/DAVIS');
  assert.equal(l.meta.route, '/load/info');
});

test('getLoadByRouteId: GET load/static/info/{cc}?routeId=<loadId>, parses loadHeader.loadNbr', () => {
  const r = buildOpRequest('getLoadByRouteId', { routeId: '6a3d49dabc0011223344' }, CREDS);
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/load/static/info/DAVIS?routeId=6a3d49dabc0011223344');
  assert.equal(r.meta.route, '/load/static/info');
  const parsed = parseOpResponse('getLoadByRouteId', true, { Load: { loadHeader: { loadId: '6a3d49dabc0011223344', loadNbr: 'DAVIS000197184' } } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.load.loadNbr, 'DAVIS000197184');
  assert.equal(MUTATING_OPS.has('getLoadByRouteId'), false, 'it is a READ, not a mutating op');
});

test('removeStops: versionId is echoed as a STRING even when load/info returned a number', () => {
  const r = buildOpRequest('removeStops', { removeStopIds: ['x'], editHeader: { loadId: 'L1', seqMode: 'None' }, versionId: 12345 }, CREDS);
  assert.strictEqual(bodyOf(r).versionId, '12345', 'coerced to the string form load/edit expects');
});

test('getStop: throws without stopNbr', () => {
  assert.throws(() => buildOpRequest('getStop', {}, CREDS), /stopNbr/);
});

test('insertStops: POST load/insertstops/{cc} with {insertStopIds, loadId}', () => {
  const r = buildOpRequest('insertStops', { insertStopIds: ['a', 'b'], loadId: 'L1' }, CREDS);
  assert.equal(r.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/load/insertstops/DAVIS');
  assert.deepEqual(bodyOf(r), { insertStopIds: ['a', 'b'], loadId: 'L1' });
});

test('insertStops: throws on empty ids or missing loadId', () => {
  assert.throws(() => buildOpRequest('insertStops', { insertStopIds: [], loadId: 'L1' }, CREDS), /insertStopIds/);
  assert.throws(() => buildOpRequest('insertStops', { insertStopIds: ['a'] }, CREDS), /loadId/);
});

test('removeStops: POST load/edit/{cc} with echoed header + routeSeq:[] + versionId', () => {
  const r = buildOpRequest('removeStops', { removeStopIds: ['x'], editHeader: { loadId: 'L1', seqMode: 'None' }, versionId: 'v9' }, CREDS);
  assert.equal(r.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/load/edit/DAVIS');
  const b = bodyOf(r);
  assert.deepEqual(b.removeStopIds, ['x']);
  assert.deepEqual(b.routeSeq, []);
  assert.equal(b.versionId, 'v9');
  assert.equal(b.loadHeader.loadId, 'L1');
  assert.equal(r.meta.route, '/load/edit');
});

test('assignDriver: POST load/assignanddispatch ASSIGN_DISPATCH with routeId=loadId + driverId', () => {
  const r = buildOpRequest('assignDriver', { loadId: 'L1', driverId: 4242 }, CREDS);
  assert.equal(r.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/load/assignanddispatch/DAVIS');
  assert.deepEqual(bodyOf(r), { action: 'ASSIGN_DISPATCH', dispatchRoute: [{ routeId: 'L1', assignDtls: { driverId: 4242 } }] });
  assert.match(r.meta.route, /assignanddispatch/);
});

test('dispatchLoad: POST load/assignanddispatch DISPATCH with just routeId', () => {
  const r = buildOpRequest('dispatchLoad', { loadId: 'L1' }, CREDS);
  assert.deepEqual(bodyOf(r), { action: 'DISPATCH', dispatchRoute: [{ routeId: 'L1' }] });
});

test('assignDriver: throws without driverId or routeId/loadId', () => {
  assert.throws(() => buildOpRequest('assignDriver', { loadId: 'L1' }, CREDS), /driverId/);
  assert.throws(() => buildOpRequest('assignDriver', { driverId: 1 }, CREDS), /routeId/);
});

// ── §4 stop payload gotchas ──────────────────────────────────────────────────
test('buildStopPayload: never emits shipForBP/profile; carries zip; defaults pallets to 1', () => {
  const p = buildStopPayload({ name: 'ACME', addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518' },
    { origin: { name: 'D', addr1: '9 Hub', city: 'Atlanta', state: 'GA', zip: '30301' }, serviceDate: '2026-06-29' });
  const json = JSON.stringify(p);
  assert.equal(/shipForBP/i.test(json), false, 'must not send shipForBP');
  assert.equal(/"profile"/i.test(json), false, 'must not send profile');
  assert.equal(p.to.address.zip, '30518');
  assert.equal(p.totalPallets, 1);
  assert.equal(p.stopType, 'DO');
  assert.equal(p.to.schedule.timeZone, 'America/New_York');
});

test('buildStopPayload: blank weight/cartons → null, not 0', () => {
  const p = buildStopPayload({ name: 'A', addr1: '1', city: 'B', state: 'GA', zip: '30518', weight: '', cartons: '  ' },
    { origin: { name: 'D', addr1: '9', city: 'A', state: 'GA', zip: '30301' }, serviceDate: '2026-06-29' });
  assert.equal(p.weight, null);
  assert.equal(p.totalCartons, null);
});

test('buildStopPayload: item description → reference2 (trimmed); absent when blank', () => {
  const origin = { name: 'D', addr1: '9', city: 'A', state: 'GA', zip: '30301' };
  const withDesc = buildStopPayload({ name: 'A', addr1: '1', city: 'B', state: 'GA', zip: '30518', itemDesc: '  2 pallets appliances  ' },
    { origin, serviceDate: '2026-06-29' });
  assert.equal(withDesc.reference2, '2 pallets appliances');
  const blank = buildStopPayload({ name: 'A', addr1: '1', city: 'B', state: 'GA', zip: '30518', itemDesc: '   ' },
    { origin, serviceDate: '2026-06-29' });
  assert.equal(blank.reference2, undefined, 'blank description must not emit reference2');
  assert.equal('reference2' in JSON.parse(JSON.stringify(blank)), false, 'undefined reference2 is omitted from the wire payload');
});

test('normalizeStop: surfaces reference2 as itemDesc for read-back verification', () => {
  const norm = normalizeStop({ Stop: { stop: { stopId: 's1', stopNbr: '007', reference2: '2 pallets appliances', to: { address: { name: 'ACME' } } }, stopExecutionInfo: {}, load: {} } });
  assert.equal(norm.itemDesc, '2 pallets appliances');
  assert.equal(normalizeStop({ Stop: { stop: { stopId: 's2' }, stopExecutionInfo: {}, load: {} } }).itemDesc, null);
});

// ── §5 edit header ───────────────────────────────────────────────────────────
test('toEditHeader: forces seqMode None, passes through known fields, maps schedule from start dttms', () => {
  const h = toEditHeader({ loadId: 'L1', routeName: 'BEN 2', earliestStartDttm: '2026-06-29T08:00:00', latestStartDttm: '2026-06-29T12:00:00', junk: 'drop?' });
  assert.equal(h.seqMode, 'None');
  assert.equal(h.loadId, 'L1');
  assert.equal(h.routeName, 'BEN 2');
  assert.equal(h.scheduleStartDttm, '2026-06-29T08:00:00');
  assert.equal(h.scheduleEndDttm, '2026-06-29T12:00:00');
  assert.equal('junk' in h, false, 'unknown fields are not echoed');
});

test('toEditHeader: a present-but-null field is echoed AS null (not dropped) for the full-replace', () => {
  const h = toEditHeader({ loadId: 'L1', routeName: 'BEN 2', masterBol: null, sealNbr: undefined });
  assert.equal(h.loadId, 'L1');
  assert.equal('masterBol' in h, true, 'present-but-null field is echoed');
  assert.equal(h.masterBol, null);
  assert.equal('sealNbr' in h, false, 'truly-absent field stays absent');
});

test('assignDriver: a numeric-STRING driverId (from an HTML select) is coerced to a number', () => {
  const r = buildOpRequest('assignDriver', { loadId: 'L1', driverId: '4242' }, CREDS);
  const did = bodyOf(r).dispatchRoute[0].assignDtls.driverId;
  assert.equal(did, 4242);
  assert.equal(typeof did, 'number', 'NuVizz wants a number, not a quoted string');
  // a non-numeric id passes through untouched (defensive)
  assert.equal(buildOpRequest('assignDriver', { loadId: 'L1', driverId: 'abc' }, CREDS) && bodyOf(buildOpRequest('assignDriver', { loadId: 'L1', driverId: 'abc' }, CREDS)).dispatchRoute[0].assignDtls.driverId, 'abc');
});

// ── §6 parsers ───────────────────────────────────────────────────────────────
test('summarize: created+entityInfoList → ok with ids', () => {
  const s = summarize(true, { apiResult: { created: 1 }, entityInfoList: [{ entityId: '6a3f', entityNbr: '007139395' }] });
  assert.equal(s.ok, true);
  assert.equal(s.entityId, '6a3f');
  assert.equal(s.entityNbr, '007139395');
});

test('summarize: status SUCCESS → ok; reasons present → not ok with description', () => {
  assert.equal(summarize(true, { status: 'SUCCESS' }).ok, true);
  const bad = summarize(true, { reasons: [{ description: 'ShipForBP is Invalid' }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'ShipForBP is Invalid');
});

test('summarize: 2xx with empty body → ok; non-2xx → not ok', () => {
  assert.equal(summarize(true, {}).ok, true);
  assert.equal(summarize(false, {}).ok, false);
});

test('summarize: apiResult.errors[0].msgs surfaces as error', () => {
  const s = summarize(true, { apiResult: { errors: [{ msgs: ['profile X does not exist'] }] } });
  assert.equal(s.ok, false);
  assert.match(s.error, /profile X does not exist/);
});

test('assignOk: capital-S Success and lowercase both pass; Failed does not', () => {
  assert.equal(assignOk({ status: 'Success', reasons: [] }).ok, true);
  assert.equal(assignOk({ status: 'success' }).ok, true);
  const f = assignOk({ status: 'Failed', reasons: [{ description: 'driver busy' }] });
  assert.equal(f.ok, false);
  assert.equal(f.error, 'driver busy');
});

test('normalizeStop: pulls status + the load it is on now; absent load ⇒ unplanned (null)', () => {
  const planned = normalizeStop({ Stop: { stop: { stopId: 's1', stopNbr: '7', to: { address: { name: 'ACME', city: 'Buford', state: 'GA', latitude: 1, longitude: 2 } } }, stopExecutionInfo: { stopStatus: 'PLANNED' }, load: { loadNbr: 'BEN 2', routeName: 'BEN 2' } } });
  assert.equal(planned.stopId, 's1');
  assert.equal(planned.assignedLoadNbr, 'BEN 2');
  assert.equal(planned.status, 'PLANNED');
  assert.equal(planned.toName, 'ACME');
  const unplanned = normalizeStop({ Stop: { stop: { stopId: 's2' }, stopExecutionInfo: {}, load: {} } });
  assert.equal(unplanned.assignedLoadNbr, null);
});

test('normalizeStop: surfaces freight + audit fields (incident forensics) — absent ⇒ null, never throws', () => {
  const n = normalizeStop({ Stop: { stop: {
    stopId: 's1', stopNbr: '007141834',
    totalPallets: 1, totalCartons: 1, weight: 389, volume: 0, pronbr: 'PRO-834',
    sourceType: 'CSV_IMPORT', insertedBy: 'davisadmin', insertedDttm: '2026-07-01 06:12:00', updatedDttm: '2026-07-02 10:33:00',
  }, stopExecutionInfo: {}, load: {} } });
  assert.equal(n.totalPallets, 1);
  assert.equal(n.totalCartons, 1);     // Davis semantics: totalCartons = SKIDS
  assert.equal(n.weight, 389);
  assert.equal(n.volume, 0);           // Davis semantics: volume = LOOSE pieces
  assert.equal(n.proNbr, 'PRO-834');
  assert.equal(n.sourceType, 'CSV_IMPORT');
  assert.equal(n.createdBy, 'davisadmin');
  assert.equal(n.createdDttm, '2026-07-01 06:12:00');
  assert.equal(n.updatedDttm, '2026-07-02 10:33:00');
  const bare = normalizeStop({ Stop: { stop: { stopId: 's2' }, stopExecutionInfo: {}, load: {} } });
  assert.equal(bare.totalCartons, null);
  assert.equal(bare.weight, null);
  assert.equal(bare.createdBy, null);
  assert.equal(bare.sourceType, null);
});

test('normalizeLoad: loadId/versionId/stops + raw header retained for the edit echo', () => {
  const l = normalizeLoad({ Load: { loadHeader: { loadId: 'L1', loadNbr: 'BEN 2', routeName: 'BEN 2' }, loadExecutionInfo: { loadStatus: 'PLANNED' }, versionId: 'v9', stops: [{ stop: { stopId: 's1', stopNbr: '7', stopSeq: 1, stopType: 'DO' } }] } });
  assert.equal(l.loadId, 'L1');
  assert.equal(l.versionId, 'v9');
  assert.equal(l.loadHeader.loadId, 'L1');
  assert.equal(l.stops.length, 1);
  assert.equal(l.stops[0].stopNbr, '7');
});

test('normalizeLoad: missing stops → [] and null ids (never throws)', () => {
  const l = normalizeLoad({ Load: { loadHeader: {}, loadExecutionInfo: {} } });
  assert.deepEqual(l.stops, []);
  assert.equal(l.loadId, null);
  assert.equal(l.versionId, null);
});

test('summarize/assignOk: surface a non-JSON NuVizz error body (_text) instead of dropping it', () => {
  // safeJson wraps a non-JSON body as { _text }. The dispatcher must see the real message.
  assert.match(summarize(false, { _text: 'Internal Server Error: bad load' }).error, /bad load/);
  assert.match(assignOk({ _text: 'driver not on duty' }).error, /driver not on duty/);
});

test('parseRoster: keeps ENABLED DI_Driver, drops disabled + non-drivers; driverId = userId', () => {
  const j = { users: [
    { userId: 11, userName: 'denis', firstName: 'Denis', lastName: 'R', accountStatus: 'ENABLED', userRoles: [{ role: 'DI_Driver' }], mobileNumber: '555' },
    { userId: 22, userName: 'dispatcher', accountStatus: 'ENABLED', userRoles: [{ role: 'DI_Dispatcher' }] },
    { userId: 33, userName: 'olddriver', accountStatus: 'DISABLED', userRoles: [{ role: 'DI_Driver' }] },
  ] };
  const drivers = parseRoster(j);
  assert.equal(drivers.length, 1);
  assert.equal(drivers[0].driverId, 11);
  assert.equal(drivers[0].name, 'Denis R');
  assert.equal(drivers[0].mobile, '555');
});

test('parseRoster: a mixed driver+office account still surfaces as a driver; name falls back to userName; missing userId → null', () => {
  const j = { users: [
    { userId: 44, userName: 'jdoe', accountStatus: 'ENABLED', userRoles: [{ role: 'DI_Dispatcher' }, { role: 'DI_Driver' }] }, // mixed → driver wins, name falls back
    { userName: 'noid', accountStatus: 'ENABLED', userRoles: [{ role: 'DI_Driver' }] },                                          // missing userId
    { userId: 55, userName: 'blankstatus', userRoles: [{ role: 'DI_Driver' }] },                                                  // missing accountStatus → dropped
  ] };
  const drivers = parseRoster(j);
  assert.equal(drivers.length, 2, 'mixed account + missing-id driver kept; blank-status dropped');
  assert.equal(drivers[0].name, 'jdoe', 'name falls back to userName when no first/last');
  assert.equal(drivers[1].driverId, null, 'missing userId surfaces as null driverId');
});

test('parseRoster: drivers come back sorted A→Z by display name (every picker reads it sorted)', () => {
  const j = { users: [
    { userId: 1, userName: 'tyrese', firstName: 'Tyrese', lastName: 'Griffin', accountStatus: 'ENABLED', userRoles: [{ role: 'DI_Driver' }] },
    { userId: 2, userName: 'alfred', firstName: 'Alfred', lastName: 'Morgan', accountStatus: 'ENABLED', userRoles: [{ role: 'DI_Driver' }] },
    { userId: 3, userName: 'ken', firstName: 'Ken', lastName: 'Watkins', accountStatus: 'ENABLED', userRoles: [{ role: 'DI_Driver' }] },
  ] };
  const names = parseRoster(j).map((d) => d.name);
  assert.deepEqual(names, ['Alfred Morgan', 'Ken Watkins', 'Tyrese Griffin'], 'roster is alphabetical regardless of NuVizz order');
});

// ── parseOpResponse dispatch ─────────────────────────────────────────────────
test('parseOpResponse: routes each op to the right parser', () => {
  assert.equal(parseOpResponse('assignDriver', true, { status: 'Success' }).ok, true);
  assert.equal(parseOpResponse('roster', true, { users: [] }).ok, true);
  assert.ok(Array.isArray(parseOpResponse('roster', true, { users: [] }).drivers));
  assert.equal(parseOpResponse('insertStops', true, { status: 'SUCCESS' }).ok, true);
  assert.ok('stop' in parseOpResponse('getStop', true, { Stop: { stop: {} } }));
});
