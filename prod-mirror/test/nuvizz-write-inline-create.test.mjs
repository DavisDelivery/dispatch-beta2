// test/nuvizz-write-inline-create.test.mjs — the TWO-LEVER import engine (Jul 2 correction).
//
// The Jul 2 incident refuted the old §10.1 reference contract. Real semantics (UAT-proven,
// stopId evidence in dispatch-beta2 docs/NUVIZZ_API.md §10.1):
//   rule 1  an import entry matches ONLY a stop already ON the target load;
//   rule 2  a match is a FULL REPLACE — unsent fields are blanked (to-only refs wipe freight);
//   rule 3  any other number is CLONED as a new record.
// So runCommitBoardImport is asserted here ON THE WIRE to:
//   • plan existing stops (arrivals) with ONE bulk insertStops by stopId — never an import entry;
//   • re-read the load after planning and build import entries as FULL ECHOES (freight incl.);
//   • create brand-new orders inline ONLY behind per-number existence reads (404 = absent);
//   • refuse structurally when an entry's number is not on the just-read load.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runCommitBoardImport } from '../netlify/functions/lib/nuvizz-write.mts';
import { importEchoFromRaw } from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { priorShortCircuits } from '../netlify/functions/lib/write-registries.mts';

// The engine is DEFAULT-OFF (v0.36.3 gate); these tests exercise the engine itself.
const PREV_GATE = process.env.NUVIZZ_LOAD_IMPORT;
test.before(() => { process.env.NUVIZZ_LOAD_IMPORT = 'on'; });
test.after(() => { if (PREV_GATE === undefined) delete process.env.NUVIZZ_LOAD_IMPORT; else process.env.NUVIZZ_LOAD_IMPORT = PREV_GATE; });

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const noSleep = async () => {};
const PACING = { pollMs: 1, phaseWaitMs: 1, quick: true, sleep: noSleep };

function stub(scripts) {
  const calls = [];
  let i = 0;
  return {
    calls,
    requester: {
      async request(url, opts) {
        calls.push({ url, method: (opts.method || 'GET').toUpperCase(), body: opts.body ? JSON.parse(opts.body) : null });
        const s = scripts[Math.min(i, scripts.length - 1)]; i++;
        return new Response(JSON.stringify(s.json ?? {}), { status: s.status ?? 200 });
      },
    },
  };
}

const SETTINGS = { origin: { name: 'ULINE BUFORD', addr1: '943 Gainesville Hwy', city: 'Buford', state: 'GA', zip: '30518' }, serviceDate: '2026-07-02', timeZone: 'America/New_York' };
const row = (nbr, name) => ({ name, addr1: `${nbr} Main St`, city: 'Buford', state: 'GA', zip: '30518', stopNbr: nbr, pallets: '2' });

const ACK = { json: { status: 'Request for LOAD Async import is SUCCESS. Find more info in AppMessageLog with Id- abc-123' } };
const NOT_FOUND = { status: 404, json: {} };
const INSERT_OK = { json: { status: 'SUCCESS' } };
// A raw ON-LOAD stop carrying FREIGHT — what importEchoFromRaw must echo in full (rule 2).
const rawStop = (nbr, id, seq, freight = {}) => ({ stop: {
  stopId: id, stopNbr: nbr, stopType: 'DO', shipmentType: 'REG', stopExecution: 'APP', sourceType: 'INTG',
  proNumber: `PRO${nbr}`, shipmentNbr: `PRO${nbr}`, reference1: `PRO PRO${nbr}`, reference2: 'CHAIRS x2',
  totalPallets: freight.pallets ?? 2, totalCartons: freight.cartons ?? 4, weight: freight.weight ?? 645, weightUOM: 'LBS',
  from: { address: { addressType: 'COM', name: 'ULINE BUFORD', addr1: '943 Gainesville Hwy', city: 'Buford', state: 'GA', zip: '30518', country: 'USA' },
          schedule: { timeFrom: '2026-07-02T08:00:00', timeTo: '2026-07-02T12:00:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' } },
  to: { seq, address: { addressType: 'COM', name: `C${nbr}`, addr1: `${nbr} A St`, city: 'Buford', state: 'GA', zip: '30518', country: 'USA' },
        schedule: { timeFrom: '2026-07-02T12:00:00', timeTo: '2026-07-02T17:00:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' } },
} });
const loadDoc = (loadNbr, loadId, raws) => ({ json: { Load: {
  loadHeader: { loadId, loadNbr, earliestStartDttm: '2026-07-02T06:00:00', latestStartDttm: '2026-07-02T18:00:00', originName: 'ULINE', originAddr1: '943 Gainesville Hwy', originCity: 'Buford', originState: 'GA', originZip: '30518', origin: 'WHSE' },
  versionId: 'v1', loadExecutionInfo: { loadStatus: 'Draft' }, stops: raws,
} } });
// A minimal converged read (ids + seq only) for the post-import confirm poll.
const seatedDoc = (loadNbr, loadId, nbrs) => ({ json: { Load: {
  loadHeader: { loadId, loadNbr }, versionId: 'v1', loadExecutionInfo: { loadStatus: 'Draft' },
  stops: nbrs.map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: n, stopType: 'DO', to: { seq: i + 2 } } })),
} } });
// An existing UNPLANNED stop as getStop returns it (found ⇒ inline creation must refuse).
const unplannedStop = (nbr, id) => ({ json: { Stop: { stop: rawStop(nbr, id, undefined).stop, load: {} } } });

const urlsOf = (calls, frag) => calls.filter((c) => c.url.includes(frag));

// ── importEchoFromRaw: the full-echo builder (rule 2) ────────────────────────

test('importEchoFromRaw: echoes freight (NUMBERS), references, PRO and the from block — never a bare ref', () => {
  const e = importEchoFromRaw(rawStop('2001', 'a1', 2), '2026-07-02');
  assert.equal(e.stopNbr, '2001');
  assert.equal(e.totalPallets, 2);
  assert.equal(e.totalCartons, 4);
  assert.equal(e.weight, 645);
  assert.equal(e.weightUOM, 'LBS');
  assert.equal(e.proNumber, 'PRO2001');
  assert.equal(e.shipmentNbr, 'PRO2001');
  assert.equal(e.reference1, 'PRO PRO2001');
  assert.equal(e.reference2, 'CHAIRS x2');
  assert.equal(e.shipmentType, 'REG');
  assert.equal(e.from.address.addr1, '943 Gainesville Hwy');
  assert.equal(e.from.schedule.timeFrom, '2026-07-02T08:00:00');
  assert.equal(e.to.address.addr1, '2001 A St');
});

test('importEchoFromRaw: numeric strings coerce, objects are refused, junk fields never ride', () => {
  const raw = rawStop('2002', 'b1', 3);
  raw.stop.totalPallets = '3';                 // numeric string → number
  raw.stop.weight = { nested: true };          // object → dropped, never echoed
  raw.stop.reference3 = 7;                     // number in a string slot → stringified
  const e = importEchoFromRaw(raw, '2026-07-02');
  assert.equal(e.totalPallets, 3);
  assert.equal(e.weight, undefined);
  assert.equal(e.reference3, '7');
  assert.equal(e.seq, undefined, 'raw seq/exec junk never rides the entry');
});

// ── CREATE MODE (lever 2, creation) — existence-gated full payloads ──────────

test('CREATE MODE: brand-new load — per-number 404 gates, then ONE import of full payloads, stopIds harvested', async () => {
  const { requester, calls } = stub([
    NOT_FOUND,                                    // load/info miss → create mode
    NOT_FOUND, NOT_FOUND, NOT_FOUND,              // existence gates: all three absent
    ACK,
    seatedDoc('SQTLOADI', 'li1', ['1001', '1002', '1003']),
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADI', routeName: 'SUW 3', createNew: true, orderedStopNbrs: ['1001', '1002', '1003'], newStops: [row('1001', 'A'), row('1002', 'B'), row('1003', 'C')] }],
    settings: SETTINGS,
  }, CREDS, PACING);

  assert.equal(urlsOf(calls, '/stop/sync/update').length, 0, 'NO per-stop pre-creates');
  assert.equal(urlsOf(calls, '/stop/info').length, 3, 'one existence read per inline number — the anti-clone gate');
  assert.equal(urlsOf(calls, '/load/insertstops').length, 0, 'nothing to plan — all inline');
  const updates = urlsOf(calls, '/load/update/');
  assert.equal(updates.length, 1, 'exactly ONE import');
  const body = updates[0].body.loads[0];
  assert.equal(body.loadHeader.loadNbr, 'SQTLOADI');
  assert.equal(body.loadHeader.earliestStartDttm, '2026-07-02T06:00:00');
  assert.deepEqual(body.stops.map((s) => s.stopNbr), ['1001', '1002', '1003']);
  for (const s of body.stops) {
    assert.ok(s.from?.address?.addr1, 'full payload carries the warehouse from block');
    assert.equal(s.totalPallets, 2, 'freight rides the inline payload');
  }
  assert.equal(r.ok, true);
  assert.deepEqual(r.loads[0].stopIds, { 1001: 'id-1001', 1002: 'id-1002', 1003: 'id-1003' });
  assert.deepEqual(r.loads[0].calls, { updates: 1, infos: 2, stopInfos: 3, inserts: 0 });
});

test('CREATE MODE: a COLLIDING order number refuses the whole load (rule 3 — a create would clone it)', async () => {
  const { requester, calls } = stub([
    NOT_FOUND,                                    // load/info miss
    unplannedStop('1001', 'EXISTING-1'),          // existence gate FINDS the number
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADI', createNew: true, orderedStopNbrs: ['1001'], newStops: [row('1001', 'A')] }],
    settings: SETTINGS,
  }, CREDS, PACING);
  assert.equal(urlsOf(calls, '/load/update/').length, 0, 'no import fires');
  assert.equal(r.ok, false);
  assert.match(r.loads[0].error, /already exists in NuVizz \(stop id EXISTING-1\).*CLONE/);
});

test('CREATE MODE: an UNVERIFIABLE existence read (non-404 failure) refuses — never assume absent', async () => {
  const { requester, calls } = stub([
    NOT_FOUND,
    { status: 500, json: { error: 'Something Went Wrong' } },
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADI', createNew: true, orderedStopNbrs: ['1001'], newStops: [row('1001', 'A')] }],
    settings: SETTINGS,
  }, CREDS, PACING);
  assert.equal(urlsOf(calls, '/load/update/').length, 0);
  assert.equal(r.ok, false);
  assert.match(r.loads[0].error, /could not verify order # 1001 is new/);
});

test('createNew at a load already carrying stops is refused (declarative import would rebuild it)', async () => {
  const { requester, calls } = stub([
    loadDoc('SQTLOADI', 'li1', [rawStop('9001', 'x1', 2)]),
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADI', createNew: true, orderedStopNbrs: ['1001'], newStops: [row('1001', 'A')] }],
    settings: SETTINGS,
  }, CREDS, PACING);
  assert.equal(urlsOf(calls, '/load/update/').length, 0);
  assert.equal(r.ok, false);
  assert.match(r.loads[0].error, /already carries 1 stop/);
});

// ── TWO-LEVER: membership via insertStops, order via full echoes ─────────────

test('MIXED: arrival → ONE bulk insertStops + re-read; on-load stops FULL-ECHOED; inline gated; exact order', async () => {
  const { requester, calls } = stub([
    loadDoc('SQTLOADJ', 'lj1', [rawStop('2001', 'a1', 2)]),          // pre-read: 2001 on load
    unplannedStop('2003', 'c1'),                                     // arrival resolution (missing)
    NOT_FOUND,                                                       // existence gate for inline 7777
    INSERT_OK,                                                       // LEVER 1: bulk insert [c1]
    loadDoc('SQTLOADJ', 'lj1', [rawStop('2001', 'a1', 2), rawStop('2003', 'c1', 3, { pallets: 5, weight: 900 })]),  // re-read
    ACK,                                                             // LEVER 2: the ordering import
    seatedDoc('SQTLOADJ', 'lj1', ['2001', '7777', '2003']),          // converged
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADJ', orderedStopNbrs: ['2001', '7777', '2003'], newStops: [row('7777', 'NEW GUY')] }],
    settings: SETTINGS,
  }, CREDS, PACING);

  const inserts = urlsOf(calls, '/load/insertstops');
  assert.equal(inserts.length, 1, 'ONE bulk insert plans the REAL record');
  assert.deepEqual(inserts[0].body.insertStopIds, ['c1']);
  assert.equal(urlsOf(calls, '/stop/info').length, 2, 'arrival read + inline existence gate only');
  assert.equal(urlsOf(calls, '/stop/sync/update').length, 0);

  const body = urlsOf(calls, '/load/update/')[0].body.loads[0];
  assert.deepEqual(body.stops.map((s) => s.stopNbr), ['2001', '7777', '2003'], 'array order = staged order');
  assert.equal(body.stops[0].totalPallets, 2, 'on-load stop is a FULL ECHO — freight rides (rule 2)');
  assert.equal(body.stops[0].proNumber, 'PRO2001');
  assert.ok(body.stops[1].from?.address, 'inline row is a full payload');
  assert.equal(body.stops[2].totalPallets, 5, 'the ARRIVAL is echoed off the POST-INSERT re-read, freight intact');
  assert.equal(body.stops[2].weight, 900);

  assert.equal(r.loads[0].ok, true);
  assert.deepEqual(r.loads[0].calls, { updates: 1, infos: 3, stopInfos: 2, inserts: 1 });
});

test('pure REORDER: zero inserts, zero stop reads — one import of full echoes + confirm', async () => {
  const { requester, calls } = stub([
    loadDoc('SQTLOADJ', 'lj1', [rawStop('2001', 'a1', 2), rawStop('2002', 'b1', 3)]),
    ACK,
    seatedDoc('SQTLOADJ', 'lj1', ['2002', '2001']),
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADJ', orderedStopNbrs: ['2002', '2001'] }],
  }, CREDS, PACING);
  assert.equal(urlsOf(calls, '/load/insertstops').length, 0);
  assert.equal(urlsOf(calls, '/stop/info').length, 0);
  const body = urlsOf(calls, '/load/update/')[0].body.loads[0];
  assert.deepEqual(body.stops.map((s) => s.stopNbr), ['2002', '2001']);
  assert.equal(body.stops[0].weight, 645, 'reorder entries are full echoes, never to-only refs');
  assert.equal(r.loads[0].ok, true);
  assert.deepEqual(r.loads[0].calls, { updates: 1, infos: 2, stopInfos: 0, inserts: 0 });
});

test('STRUCTURAL GUARD: an entry number missing from the just-read load refuses the import (no clone possible)', async () => {
  const { requester, calls } = stub([
    loadDoc('SQTLOADJ', 'lj1', [rawStop('2001', 'a1', 2)]),
    unplannedStop('2003', 'c1'),
    INSERT_OK,
    loadDoc('SQTLOADJ', 'lj1', [rawStop('2001', 'a1', 2)]),   // re-read: insert did NOT take
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADJ', orderedStopNbrs: ['2001', '2003'] }],
  }, CREDS, PACING);
  assert.equal(urlsOf(calls, '/load/update/').length, 0, 'the import NEVER fires with an off-load number');
  assert.equal(r.ok, false);
  assert.match(r.loads[0].error, /not on load SQTLOADJ after planning.*CLONED/);
});

test('steal guard unchanged: an arrival still planned on a load OUTSIDE this Save refuses', async () => {
  const onOtherLoad = { json: { Stop: { stop: rawStop('2003', 'c1', 2).stop, load: { loadNbr: 'DAVIS000000999' } } } };
  const { requester, calls } = stub([
    loadDoc('SQTLOADJ', 'lj1', [rawStop('2001', 'a1', 2)]),
    onOtherLoad,
  ]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADJ', orderedStopNbrs: ['2001', '2003'] }],
  }, CREDS, PACING);
  assert.equal(urlsOf(calls, '/load/insertstops').length, 0);
  assert.equal(urlsOf(calls, '/load/update/').length, 0);
  assert.match(r.loads[0].error, /still planned on load DAVIS000000999/);
});

test('newStops without payload.settings → refused before ANY NuVizz call', async () => {
  const { requester, calls } = stub([ACK]);
  const r = await runCommitBoardImport(requester, {
    loads: [{ loadNbr: 'SQTLOADI', createNew: true, orderedStopNbrs: ['1001'], newStops: [row('1001', 'A')] }],
  }, CREDS, PACING);
  assert.equal(calls.length, 0, 'zero NuVizz calls');
  assert.equal(r.ok, false);
  assert.match(r.loads[0].error, /settings/);
});

test('idempotency ledger semantics (convergence directive): only a prior SUCCESS short-circuits', () => {
  assert.equal(priorShortCircuits(null), false, 'no record → fire');
  assert.equal(priorShortCircuits({ status: 'failed' }), false, 'failed prior → the re-send MUST reach the wire');
  assert.equal(priorShortCircuits({ status: 'pending' }), false, 'pending prior (client-verifier Save) → re-send reaches the wire');
  assert.equal(priorShortCircuits({ status: 'succeeded' }), true, 'succeeded prior → deduped (the intended protection)');
});
