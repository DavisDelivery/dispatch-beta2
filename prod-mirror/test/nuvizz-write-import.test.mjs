// test/nuvizz-write-import.test.mjs — the NEW async LOAD-IMPORT path (§I).
//
// PURE half (nuvizz-write-ops.mts): buildImportBody hard-validates the silent-failure
// trap (earliest/latest + flat origin fields), refuses an empty stops[] / bare stopNbr
// references / forbidden names; importOk parses the async ack; deliveryOrder is the
// convergence comparator (to.seq order, pickups excluded).
//
// IMPURE half (nuvizz-write.mts): runImportLoad fires ONE import per load and drives it
// to convergence (poll load/info → resend → reverse-then-forward), fully fake-clock
// testable via injected sleep; runCommitImport applies loads sources-before-destinations.
// Both are DOUBLE-GATED: the handler's NUVIZZ_WRITE_ENABLED plus NUVIZZ_LOAD_IMPORT here.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOpRequest, parseOpResponse, buildImportBody, buildImportStopRef, importOk, deliveryOrder, normalizeLoad,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runOp, runImportLoad, runCommitImport, loadImportBlocked, _resetStaticInfoMemo } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const HEXID = '6a438e9d52ef82bd1ed4516b';

// ── fixtures ──────────────────────────────────────────────────────────────────

const HDR = {
  loadNbr: 'DAVIS000000123', routeName: 'TEST ROUTE 7',
  earliestStartDttm: '2026-07-02T06:00:00', latestStartDttm: '2026-07-02T18:00:00',
  origin: 'WHSE', originName: 'DAVIS WAREHOUSE', originAddr1: '1 Depot Rd',
  originCity: 'Atlanta', originState: 'GA', originZip: '30303',
};

// A reference-shaped stop (existing order planned by stopNbr + "to" block).
const stopRef = (n) => ({
  stopNbr: String(n), stopType: 'DO',
  to: {
    address: { name: `CONSIGNEE ${n}`, addr1: '2 Main St', city: 'Macon', state: 'GA', zip: '31201', country: 'USA' },
    schedule: { timeFrom: '2026-07-02T12:00:00', timeTo: '2026-07-02T17:00:00', timeZone: 'America/New_York' },
  },
});

// A scripted requester (same pattern as nuvizz-write-exec.test.mjs).
function stub(scripts) {
  const calls = [];
  let i = 0;
  return {
    calls,
    requester: {
      async request(url, opts, meta) {
        calls.push({ url, method: (opts.method || 'GET').toUpperCase(), body: opts.body ? JSON.parse(opts.body) : null, meta });
        const s = scripts[Math.min(i, scripts.length - 1)]; i++;
        return new Response(JSON.stringify(s.json ?? {}), { status: s.status ?? 200 });
      },
    },
  };
}

// The async ack NuVizz returns for an ACCEPTED import (it does NOT mean it landed).
const ACK = { json: { status: 'SUCCESS', message: 'Async import is SUCCESS with AppMessageLog Id-9314159' } };

// A load/info doc whose deliveries read back in the given stopNbr order (to.seq 2..N; seq 1 = origin).
const loadDoc = (nbrs) => ({
  json: { Load: {
    loadHeader: { loadId: HEXID, loadNbr: HDR.loadNbr, routeName: HDR.routeName },
    versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
    stops: nbrs.map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 } } })),
  } },
});

const FAST = { pollMs: 5000, phaseWaitMs: 5000, sleep: async () => {} };  // 1 poll per phase, no real clock

async function withGate(fn) {
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  process.env.NUVIZZ_LOAD_IMPORT = 'on';
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.NUVIZZ_LOAD_IMPORT; else process.env.NUVIZZ_LOAD_IMPORT = prev; }
}

// ── PURE: buildImportBody / buildOpRequest('importLoad') ─────────────────────

test('importLoad: builds POST load/update/default with header + stops in exact array order', () => {
  const br = buildOpRequest('importLoad', { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS);
  assert.equal(br.method, 'POST');
  assert.match(br.url, /\/load\/update\/default\/DAVIS$/);
  assert.equal(br.meta.route, '/load/update/default');
  const body = JSON.parse(br.body);
  assert.equal(body.companyCode, 'DAVIS');
  assert.equal(body.loads.length, 1);
  const h = body.loads[0].loadHeader;
  assert.equal(h.loadNbr, HDR.loadNbr);
  assert.equal(h.earliestStartDttm, HDR.earliestStartDttm);
  assert.equal(h.latestStartDttm, HDR.latestStartDttm);
  // The silent-failure trap fields, with defaults applied.
  for (const k of ['origin', 'originName', 'originAddr1', 'originCity', 'originState', 'originZip']) assert.equal(h[k], HDR[k]);
  assert.equal(h.originCountry, 'USA');
  assert.equal(h.loadTimeZone, 'EST');
  // stops[] array order IS the visit order — preserved verbatim.
  assert.deepEqual(body.loads[0].stops.map((s) => s.stopNbr), ['A', 'B', 'C']);
});

test('importLoad: refuses a header missing ANY silent-failure-trap field', () => {
  for (const missing of ['earliestStartDttm', 'latestStartDttm', 'origin', 'originName', 'originAddr1', 'originCity', 'originState', 'originZip']) {
    const h = { ...HDR }; delete h[missing];
    assert.throws(() => buildImportBody({ loadHeader: h, stops: [stopRef('A')] }, 'DAVIS'), new RegExp(missing));
  }
});

test('importLoad: refuses scheduleStartDttm in place of earliest/latest (async no-create trap)', () => {
  const h = { loadNbr: HDR.loadNbr, scheduleStartDttm: '2026-07-02T06:00:00', scheduleEndDttm: '2026-07-02T18:00:00' };
  assert.throws(() => buildImportBody({ loadHeader: h, stops: [stopRef('A')] }, 'DAVIS'), /earliestStartDttm \+ latestStartDttm/);
});

test('importLoad: refuses an EMPTY stops[] (emptying a load is load/cancel, never an import)', () => {
  assert.throws(() => buildImportBody({ loadHeader: HDR, stops: [] }, 'DAVIS'), /load\/cancel/);
});

test('importLoad: refuses a bare stopNbr reference (NuVizz rejects it) and defaults stopType', () => {
  assert.throws(() => buildImportBody({ loadHeader: HDR, stops: [{ stopNbr: 'A' }] }, 'DAVIS'), /"to" block/);
  const s = stopRef('B'); delete s.stopType;
  const body = buildImportBody({ loadHeader: HDR, stops: [s] }, 'DAVIS');
  assert.equal(body.loads[0].stops[0].stopType, 'DO');
});

test('importLoad: refuses forbidden names in loadNbr/routeName', () => {
  assert.throws(() => buildImportBody({ loadHeader: { ...HDR, routeName: 'Claude test route' }, stops: [stopRef('A')] }, 'DAVIS'), /never contain/);
  assert.throws(() => buildImportBody({ loadHeader: { ...HDR, loadNbr: 'ANTHROPIC-1' }, stops: [stopRef('A')] }, 'DAVIS'), /never contain/);
});

test('buildImportStopRef: stopNbr + DO + "to" address/schedule (the valid reference shape)', () => {
  const s = buildImportStopRef(
    { stopNbr: '0019385866', name: 'AVRT', addr1: '9 Elm', city: 'Macon', state: 'GA', zip: '31201' },
    { origin: { name: 'W', addr1: '1', city: 'A', state: 'GA', zip: '30303' }, serviceDate: '2026-07-02' },
  );
  assert.equal(s.stopNbr, '0019385866');
  assert.equal(s.stopType, 'DO');
  assert.equal(s.to.address.name, 'AVRT');
  assert.equal(s.to.schedule.timeFrom, '2026-07-02T12:00:00');
  assert.equal(s.from, undefined); // a reference plans an EXISTING stop; no from block needed
});

// ── PURE: importOk / deliveryOrder ────────────────────────────────────────────

test('importOk: parses the async ack — ok + AppMessageLog id, and ok NEVER implies landed', () => {
  const r = importOk(true, ACK.json);
  assert.equal(r.ok, true);
  assert.equal(r.async, true);
  assert.equal(r.appMessageLogId, '9314159');
  assert.equal(r.error, null); // the success message must NOT be misread as an error
});

test('importOk: a non-success body or non-2xx is a failure with a readable error', () => {
  const bad = importOk(true, { status: 'FAILURE', reasons: [{ description: 'Either From or To information should be present' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /From or To/);
  const http = importOk(false, {});
  assert.equal(http.ok, false);
});

// REGRESSION (journaled live, prod DAVIS Jul 2 2026 — load DAVIS000198070): prod puts the whole
// SENTENCE in `status` ("…is SUCCESS. Find more info in AppMessageLog with Id- …"), where UAT
// sends the bare token. The strict `status === 'SUCCESS'` equality read this SUCCESS ack as a
// rejection and aborted the Save before convergence ("re-optimize failed" with a success ack).
test('importOk: PROD sentence-status SUCCESS ack is ACCEPTED, id extracted despite "with"', () => {
  const r = importOk(true, { status: 'Request for LOAD Async import is SUCCESS. Find more info in AppMessageLog with Id- ef689668-7f11-47f9-9c36-ab7242432f53' });
  assert.equal(r.ok, true);
  assert.equal(r.appMessageLogId, 'ef689668-7f11-47f9-9c36-ab7242432f53');
  assert.equal(r.error, null);
});

test('importOk: sentence-status guards still reject PARTIALSUCCESS / failure wording', () => {
  assert.equal(importOk(true, { status: 'PARTIALSUCCESS' }).ok, false);
  assert.equal(importOk(true, { status: 'Request for LOAD Async import is FAILED. See AppMessageLog with Id- abc' }).ok, false);
  assert.equal(importOk(true, { status: 'SUCCESS with errors — 2 records rejected' }).ok, false);
});

test("parseOpResponse('importLoad') routes to importOk", () => {
  const r = parseOpResponse('importLoad', true, ACK.json);
  assert.equal(r.ok, true);
  assert.equal(r.appMessageLogId, '9314159');
});

test('deliveryOrder: sorts by to.seq (never array order) and excludes the pickup', () => {
  const j = {
    Load: { loadHeader: { loadId: HEXID, loadNbr: 'L' }, stops: [
      { stop: { stopId: 'i3', stopNbr: 'C', stopType: 'DO', to: { seq: 4 } } },
      { stop: { stopId: 'i0', stopNbr: 'WH', stopType: 'PU', to: { seq: 1 } } },
      { stop: { stopId: 'i1', stopNbr: 'A', stopType: 'DO', to: { seq: 2 } } },
      { stop: { stopId: 'i2', stopNbr: 'B', stopType: 'DO', to: { seq: 3 } } },
    ] },
  };
  assert.deepEqual(deliveryOrder(normalizeLoad(j)), ['A', 'B', 'C']);
});

// ── IMPURE: the emergency brake (the ONLY server-side switch, off by default) ──

test('emergency brake: NUVIZZ_LOAD_IMPORT=off hard-disables the import ops with zero NuVizz calls', async () => {
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  process.env.NUVIZZ_LOAD_IMPORT = 'off';
  try {
    assert.equal(loadImportBlocked(), true);
    const { requester, calls } = stub([ACK]);
    const r1 = await runOp(requester, 'importLoad', { load: { loadHeader: HDR, stops: [stopRef('A')] } }, CREDS);
    const r2 = await runOp(requester, 'commitImport', { loads: [{ loadHeader: HDR, stops: [stopRef('A')] }] }, CREDS);
    assert.equal(r1.ok, false); assert.equal(r1.gated, true); assert.match(r1.error, /emergency brake/);
    assert.equal(r2.ok, false); assert.equal(r2.gated, true);
    assert.equal(calls.length, 0);
    // …and a Save that asked for the import engine falls back to the CLASSIC engine, never a dead end.
    const b = stub([
      { json: { Load: { loadHeader: { loadId: HEXID, loadNbr: HDR.loadNbr }, versionId: 'v1', loadExecutionInfo: {}, stops: [
        { stop: { stopId: 'id-A', stopNbr: 'A', stopType: 'DO', to: { seq: 2 } } },
        { stop: { stopId: 'id-B', stopNbr: 'B', stopType: 'DO', to: { seq: 3 } } },
      ] } } },
      { json: { status: 'SUCCESS' } }, { json: { status: 'SUCCESS' } },
    ]);
    const r3 = await runOp(b.requester, 'commitBoard', { useImport: true, loads: [{ loadNbr: HDR.loadNbr, loadId: HEXID, orderedStopNbrs: ['B', 'A'] }] }, CREDS);
    assert.equal(r3.ok, true);
    assert.ok(b.calls.some((c) => /load\/edit/.test(c.url)));
    assert.ok(!b.calls.some((c) => /load\/update\/default/.test(c.url)));
  } finally { if (prev === undefined) delete process.env.NUVIZZ_LOAD_IMPORT; else process.env.NUVIZZ_LOAD_IMPORT = prev; }
});

test('default env (unset): imports are BLOCKED — the server must explicitly re-enable (Jul 2 incident)', async () => {
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  delete process.env.NUVIZZ_LOAD_IMPORT;
  try {
    assert.equal(loadImportBlocked(), true);
    const { requester, calls } = stub([ACK, loadDoc(['A'])]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A')] } }, CREDS, FAST);
    assert.equal(r.ok, false);
    assert.equal(r.gated, true);
    assert.equal(calls.length, 0);   // ZERO NuVizz calls fire while the gate is shut
  } finally { if (prev !== undefined) process.env.NUVIZZ_LOAD_IMPORT = prev; }
});

test('explicit enable (NUVIZZ_LOAD_IMPORT=1): the import ops run again', async () => {
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  process.env.NUVIZZ_LOAD_IMPORT = '1';
  try {
    assert.equal(loadImportBlocked(), false);
    const { requester, calls } = stub([ACK, loadDoc(['A'])]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A')] } }, CREDS, FAST);
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
  } finally { if (prev === undefined) delete process.env.NUVIZZ_LOAD_IMPORT; else process.env.NUVIZZ_LOAD_IMPORT = prev; }
});

// ── IMPURE: convergence recipe (fake clock — injected sleep, no real waiting) ──

test('runImportLoad: import → first poll converges (1 POST + 1 GET), ok only from the read-back', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([ACK, loadDoc(['A', 'B', 'C'])]);
    const slept = [];
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS,
      { ...FAST, sleep: async (ms) => { slept.push(ms); } });
    assert.equal(r.ok, true);
    assert.equal(r.converged, true);
    assert.equal(r.loadId, HEXID);
    assert.deepEqual(r.requestedOrder, ['A', 'B', 'C']);
    assert.deepEqual(r.seenOrder, ['A', 'B', 'C']);
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET']);
    assert.match(calls[1].url, /\/load\/info\/DAVIS000000123\/DAVIS$/);
    assert.deepEqual(slept, [5000]);   // paced by the injected clock, not a real timer
  });
});

test('runImportLoad: not converged → re-sends the SAME import, then converges', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      ACK, loadDoc(['C', 'B', 'A']),   // phase 1: wrong order read back
      ACK, loadDoc(['A', 'B', 'C']),   // phase 2 (resend): converged
    ]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS, FAST);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET', 'POST', 'GET']);
    // The resend is byte-identical in intent: same stops, same order.
    assert.deepEqual(calls[2].body.loads[0].stops.map((s) => s.stopNbr), ['A', 'B', 'C']);
    assert.deepEqual(r.steps.filter((s) => s.op === 'importLoad').map((s) => s.label), ['import', 'resend']);
  });
});

test('runImportLoad: still stuck → REVERSED then desired order (the verified unstick), then converges', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      ACK, loadDoc(['C', 'B', 'A']),   // phase 1
      ACK, loadDoc(['C', 'B', 'A']),   // phase 2 (resend) — still stuck
      ACK,                             // phase 3a: reversed import
      ACK, loadDoc(['A', 'B', 'C']),   // phase 3b: forward import → converged
    ]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS, FAST);
    assert.equal(r.ok, true);
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 4);
    assert.deepEqual(posts[2].body.loads[0].stops.map((s) => s.stopNbr), ['C', 'B', 'A']); // reversed
    assert.deepEqual(posts[3].body.loads[0].stops.map((s) => s.stopNbr), ['A', 'B', 'C']); // desired
    assert.deepEqual(r.steps.filter((s) => s.op === 'importLoad').map((s) => s.label),
      ['import', 'resend', 'reverse-unstick', 'forward-after-reverse']);
  });
});

test('runImportLoad: never trusts the 200 alone — unconverged after all phases is ok:false', async () => {
  await withGate(async () => {
    const { requester } = stub([ACK, loadDoc(['C', 'B', 'A'])]); // every read stays wrong
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B'), stopRef('C')] } }, CREDS, FAST);
    assert.equal(r.ok, false);
    assert.equal(r.converged, false);
    assert.deepEqual(r.seenOrder, ['C', 'B', 'A']);
    assert.match(r.error, /did not converge/);
  });
});

test('runImportLoad: a load/info 404 while the async worker creates the load reads as not-yet-converged', async () => {
  await withGate(async () => {
    const { requester } = stub([
      ACK, { status: 404, json: {} },  // phase 1: brand-new load not visible yet
      ACK, loadDoc(['A', 'B']),        // phase 2: created + converged
    ]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('B')] } }, CREDS, FAST);
    assert.equal(r.ok, true);
  });
});

test('runImportLoad: a REJECTED import stops immediately (no polls) with the NuVizz reason', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([{ json: { status: 'FAILURE', reasons: [{ description: 'Either From or To information should be present' }] } }]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A')] } }, CREDS, FAST);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1);
    assert.match(r.error, /From or To/);
  });
});

test('runImportLoad: membership must match too — an omitted stop still on the load is NOT converged', async () => {
  await withGate(async () => {
    // Unplan B by omission: request [A, C]; the load still reads [A, B, C] every poll.
    const { requester } = stub([ACK, loadDoc(['A', 'B', 'C'])]);
    const r = await runImportLoad(requester, { load: { loadHeader: HDR, stops: [stopRef('A'), stopRef('C')] } }, CREDS, FAST);
    assert.equal(r.ok, false);
    assert.deepEqual(r.requestedOrder, ['A', 'C']);
  });
});

test('runCommitImport: one import per load, in payload order; a stuck SOURCE halts later loads', async () => {
  await withGate(async () => {
    // Move a stop from load 1 (source, imported WITHOUT it) to load 2 (destination, WITH it).
    const HDR2 = { ...HDR, loadNbr: 'DAVIS000000124', routeName: 'TEST ROUTE 8' };
    const ok2 = {
      json: { Load: { loadHeader: { loadId: 'a1b2c3d4e5f60718293a4b5c', loadNbr: HDR2.loadNbr }, versionId: 'v1', loadExecutionInfo: {}, stops: [
        { stop: { stopId: 'id-B', stopNbr: 'B', stopType: 'DO', to: { seq: 2 } } },
        { stop: { stopId: 'id-X', stopNbr: 'X', stopType: 'DO', to: { seq: 3 } } },
      ] } },
    };
    const { requester, calls } = stub([ACK, loadDoc(['A']), ACK, ok2]);
    const r = await runCommitImport(requester, { loads: [
      { loadHeader: HDR, stops: [stopRef('A')] },                 // source: X omitted → unplanned
      { loadHeader: HDR2, stops: [stopRef('B'), stopRef('X')] },  // destination: X seated last
    ] }, CREDS, FAST);
    assert.equal(r.ok, true);
    assert.equal(r.loads.length, 2);
    assert.equal(r.skipped, 0);
    // Source fired before destination (order preserved).
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts[0].body.loads[0].loadHeader.loadNbr, HDR.loadNbr);
    assert.equal(posts[1].body.loads[0].loadHeader.loadNbr, HDR2.loadNbr);

    // And a source that never converges halts the batch — the destination must not "steal".
    const stuck = stub([ACK, loadDoc(['A', 'X'])]); // X never leaves the source
    const r2 = await runCommitImport(stuck.requester, { loads: [
      { loadHeader: HDR, stops: [stopRef('A')] },
      { loadHeader: HDR2, stops: [stopRef('B'), stopRef('X')] },
    ] }, CREDS, FAST);
    assert.equal(r2.ok, false);
    assert.equal(r2.loads.length, 1);
    assert.equal(r2.skipped, 1);
    assert.ok(!stuck.calls.some((c) => c.method === 'POST' && c.body?.loads?.[0]?.loadHeader?.loadNbr === HDR2.loadNbr));
  });
});

// ── the Compare-panel Save through the import engine (runCommitBoardImport) ──
//
// Same commitBoard payload + result shape as the legacy engine — the Routing tab's
// Beta/LIVE Save flips onto the import path purely via the NUVIZZ_LOAD_IMPORT switch.

import { runCommitBoardImport } from '../netlify/functions/lib/nuvizz-write.mts';
import { importRefFromRaw, assembleImportHeader } from '../netlify/functions/lib/nuvizz-write-ops.mts';

const FROM_ADDR = { name: 'DAVIS WAREHOUSE', addr1: '1 Depot Rd', city: 'Atlanta', state: 'GA', zip: '30303', country: 'USA' };
const toBlock = (n) => ({
  address: { name: `CONSIGNEE ${n}`, addr1: `${n} Main St`, city: 'Macon', state: 'GA', zip: '31201', country: 'USA' },
  schedule: { timeFrom: '2026-07-02T12:00:00', timeTo: '2026-07-02T17:00:00', timeZone: 'America/New_York' },
});
// A raw load/info doc: header WITHOUT flat origin fields (like a real load), stops carrying
// full from/to blocks — what the import engine echoes back as references.
const rawLoadDoc = (loadNbr, loadId, nbrs) => ({
  json: { Load: {
    loadHeader: { loadId, loadNbr, routeName: `RT ${loadNbr}`, earliestStartDttm: '2026-07-02T06:00:00', latestStartDttm: '2026-07-02T18:00:00' },
    versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
    stops: nbrs.map((n, i) => ({ stop: {
      stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO',
      from: { address: FROM_ADDR },
      to: { seq: i + 2, ...toBlock(n) },
    } })),
  } },
});
const stopDoc = (n, onLoadNbr, withFrom = false) => ({
  json: { Stop: {
    stop: {
      stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: toBlock(n),
      ...(withFrom ? { from: { address: FROM_ADDR } } : {}),
    },
    stopExecutionInfo: { stopStatus: 'OP' },
    ...(onLoadNbr ? { load: { loadNbr: onLoadNbr } } : {}),
  } },
});
const NOSLEEP = { pollMs: 5000, phaseWaitMs: 5000, sleep: async () => {} };
const L1 = 'DAVIS000000201', L1ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const L2 = 'DAVIS000000202', L2ID = 'aaaaaaaaaaaaaaaaaaaaaaa2';

test('importRefFromRaw: whitelisted echo of the raw "to" block; null without an address', () => {
  const raw = { stop: { stopNbr: 'A', stopType: 'DO', to: { seq: 5, ...toBlock('A') } } };
  const ref = importRefFromRaw(raw);
  assert.equal(ref.stopNbr, 'A');
  assert.equal(ref.to.address.addr1, 'A Main St');
  assert.equal(ref.to.address.seq, undefined);          // junk fields never echoed
  assert.equal(ref.to.schedule.timeFrom, '2026-07-02T12:00:00');
  assert.equal(importRefFromRaw({ stop: { stopNbr: 'A' } }), null);   // bare reference = invalid
});

test('assembleImportHeader: origin trust order — flat header > stop from-address > client ship-from', () => {
  const base = { loadNbr: L1, routeName: 'RT', earliestStartDttm: '2026-07-02T06:00:00', latestStartDttm: '2026-07-02T18:00:00' };
  const rawStops = [{ stop: { from: { address: FROM_ADDR } } }];
  const client = { name: 'CLIENT WHSE', addr1: '9 Client Way', city: 'Buford', state: 'GA', zip: '30518' };

  const flat = assembleImportHeader({ ...base, origin: 'WHSE', originName: 'FLAT', originAddr1: 'F1', originCity: 'FC', originState: 'GA', originZip: '1' }, rawStops, client, null);
  assert.equal(flat.originName, 'FLAT');
  const fromStops = assembleImportHeader(base, rawStops, client, null);
  assert.equal(fromStops.originName, 'DAVIS WAREHOUSE');
  const fromClient = assembleImportHeader(base, [], client, null);
  assert.equal(fromClient.originName, 'CLIENT WHSE');
  assert.equal(fromClient.loadTimeZone, 'EST');
  assert.throws(() => assembleImportHeader(base, [], null, null), /origin block/);
  // Dates: header wins; else derived from the fallback service date; else refuse.
  const derived = assembleImportHeader({ loadNbr: L1 }, rawStops, null, '2026-07-03');
  assert.equal(derived.earliestStartDttm, '2026-07-03T06:00:00');
  assert.throws(() => assembleImportHeader({ loadNbr: L1 }, rawStops, null, null), /earliest\/latest/);
});

test('board Save (import mode): reorder = ONE import echoing the load\'s own records + convergence + assign', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A', 'B', 'C']),   // fetchLoad (raw to blocks)
      ACK,                                      // the ONE import
      rawLoadDoc(L1, L1ID, ['C', 'A', 'B']),   // poll: converged to the requested order
      { json: { status: 'Success' } },          // assignDriver
    ]);
    const r = await runCommitBoardImport(requester, { loads: [
      { loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['C', 'A', 'B'], driverId: 77 },
    ] }, CREDS, NOSLEEP);
    assert.equal(r.ok, true);
    assert.equal(r.loads.length, 1);
    assert.equal(r.loads[0].ok, true);
    // The import body: stops[] in the DESIRED order, each a reference echoed from load/info,
    // header origin echoed from the stops' from-address (no flat fields on the header).
    const imp = calls.find((c) => /load\/update\/default/.test(c.url));
    assert.deepEqual(imp.body.loads[0].stops.map((s) => s.stopNbr), ['C', 'A', 'B']);
    assert.equal(imp.body.loads[0].stops[0].to.address.addr1, 'C Main St');
    assert.equal(imp.body.loads[0].loadHeader.originName, 'DAVIS WAREHOUSE');
    assert.equal(imp.body.loads[0].loadHeader.earliestStartDttm, '2026-07-02T06:00:00');
    // Steps carry the import + converge trail, then the assign (client "fired" logic keys on ok steps).
    assert.deepEqual(r.loads[0].steps.map((s) => s.op), ['importLoad', 'converge', 'assignDriver']);
    // No anchor-engine calls anywhere: no load/edit, no insertstops.
    assert.ok(!calls.some((c) => /load\/edit|insertstops/.test(c.url)));
  });
});

test('board Save (import mode): planning UNPLANNED orders — LEVER 1 bulk-inserts the REAL records, LEVER 2 orders full echoes', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, []),                 // fetchLoad: an EMPTY load
      stopDoc('X'),                             // arrival resolution: X unplanned (stopId id-X)
      stopDoc('Y'),                             // arrival resolution: Y unplanned (stopId id-Y)
      { json: { status: 'SUCCESS' } },          // LEVER 1: ONE bulk insertStops — the REAL records
      rawLoadDoc(L1, L1ID, ['X', 'Y']),         // re-read: the arrivals' actual on-load records
      ACK,                                      // LEVER 2: the ordering import (full echoes)
      rawLoadDoc(L1, L1ID, ['X', 'Y']),         // poll: converged
    ]);
    const r = await runCommitBoardImport(requester, {
      loads: [{ loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['X', 'Y'] }],
      origin: { name: 'CLIENT WHSE', addr1: '9 Client Way', city: 'Buford', state: 'GA', zip: '30518' },
    }, CREDS, NOSLEEP);
    assert.equal(r.ok, true);
    // Membership went through insertStops with the arrivals' stopIds — NEVER the import.
    const ins = calls.find((c) => /insertstops/.test(c.url));
    assert.deepEqual(ins.body.insertStopIds, ['id-X', 'id-Y']);
    assert.equal(ins.body.loadId, L1ID);
    assert.ok(calls.findIndex((c) => /insertstops/.test(c.url)) < calls.findIndex((c) => /load\/update\/default/.test(c.url)), 'insert BEFORE the ordering import');
    const imp = calls.find((c) => /load\/update\/default/.test(c.url));
    assert.deepEqual(imp.body.loads[0].stops.map((s) => s.stopNbr), ['X', 'Y']);
    assert.equal(imp.body.loads[0].stops[0].to.address.name, 'CONSIGNEE X');
    // Entries are echoed off the POST-INSERT re-read — from-block included (full echo).
    assert.equal(imp.body.loads[0].stops[0].from.address.name, 'DAVIS WAREHOUSE');
    // With the real records on the load, the header origin echoes their from-address.
    assert.equal(imp.body.loads[0].loadHeader.originName, 'DAVIS WAREHOUSE');
  });
});

test('board Save (import mode): steal guard — a stop still planned on a load OUTSIDE the Save is refused', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A']),
      stopDoc('X', 'DAVIS000000999'),           // X is planned on a load not in this Save
    ]);
    const r = await runCommitBoardImport(requester, { loads: [
      { loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['A', 'X'] },
    ] }, CREDS, NOSLEEP);
    assert.equal(r.ok, false);
    assert.match(r.loads[0].error, /not part of this Save/);
    assert.ok(!calls.some((c) => /load\/update\/default/.test(c.url)));   // nothing imported
  });
});

test('board Save (import mode): cross-load move — SOURCE fires first; the destination NEVER fires until the source CONFIRMS (no steal)', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      // The resolve pass reads loads in PAYLOAD order (destination listed first below):
      rawLoadDoc(L2, L2ID, ['B']),               // fetchLoad L2 (destination)
      stopDoc('X', L1),                          // getStop X for L2's add (source IS in the batch)
      rawLoadDoc(L1, L1ID, ['A', 'X']),          // fetchLoad L1 (source, holds X)
      ACK,                                        // L1 import fires (multi-load ⇒ no in-band confirm)
    ]);
    const r = await runCommitBoardImport(requester, { loads: [
      // Destination listed FIRST on purpose — the engine must still run the source first.
      { loadNbr: L2, loadId: L2ID, orderedStopNbrs: ['B', 'X'] },
      { loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['A'] },
    ] }, CREDS, NOSLEEP);
    // Multi-load Saves return the source as PENDING immediately (the client verifier drives
    // convergence); the destination is GATED — importing it now would be the untested cross-load
    // steal (the stop is still planned on the source until the source's rebuild lands).
    assert.equal(r.ok, false);
    const imports = calls.filter((c) => /load\/update\/default/.test(c.url)).map((c) => c.body.loads[0].loadHeader.loadNbr);
    assert.deepEqual(imports, [L1]);                                   // ONLY the source fired
    const src = r.loads.find((l) => l.loadNbr === L1);
    const dst = r.loads.find((l) => l.loadNbr === L2);
    assert.equal(src.pending, true);
    assert.equal(dst.ok, false);
    assert.match(dst.error, /depends on has not confirmed/);
  });
});

test('board Save (import mode): driver-only and emptyLoad loads still ride the legacy engine', async () => {
  await withGate(async () => {
    // Driver-only (no order change, trustable loadId): legacy assign — ONE call, no getLoad/import.
    const a = stub([{ json: { status: 'Success' } }]);
    const r1 = await runCommitBoardImport(a.requester, { loads: [{ loadNbr: L1, loadId: L1ID, driverId: 9 }] }, CREDS, NOSLEEP);
    assert.equal(r1.ok, true);
    assert.equal(a.calls.length, 1);
    assert.match(a.calls[0].url, /assignanddispatch/);

    // emptyLoad: the legacy cancel path (getLoad + removeStops), NEVER an empty import.
    const b = stub([
      rawLoadDoc(L1, L1ID, ['A']),
      { json: { status: 'SUCCESS' } },           // load/edit removing the last delivery (cancels)
    ]);
    const r2 = await runCommitBoardImport(b.requester, { loads: [{ loadNbr: L1, loadId: L1ID, emptyLoad: true, orderedStopNbrs: [] }] }, CREDS, NOSLEEP);
    assert.equal(r2.ok, true);
    assert.ok(b.calls.some((c) => /load\/edit/.test(c.url)));
    assert.ok(!b.calls.some((c) => /load\/update\/default/.test(c.url)));
  });
});

test('runOp(commitBoard): useImport:true + server enable routes the import engine', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A', 'B']),          // fetchLoad
      ACK,                                        // the ONE import
      rawLoadDoc(L1, L1ID, ['B', 'A']),           // poll: converged
    ]);
    const r = await runOp(requester, 'commitBoard', {
      useImport: true,
      loads: [{ loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['B', 'A'] }],
      convergence: { pollMs: 250, phaseWaitMs: 250 },
    }, CREDS);
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => /load\/update\/default/.test(c.url)));            // import engine ran
    assert.ok(!calls.some((c) => /load\/edit|insertstops/.test(c.url)));          // anchor engine never fired
  });
});

test('runOp(commitBoard): useImport:true with the env UNSET falls back to the CLASSIC engine (Jul 2 gate)', async () => {
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  delete process.env.NUVIZZ_LOAD_IMPORT;   // server has not re-enabled imports
  try {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A', 'B']),
      { json: { status: 'SUCCESS' } },   // classic remove
      { json: { status: 'SUCCESS' } },   // classic insert
    ]);
    const r = await runOp(requester, 'commitBoard', {
      useImport: true,
      loads: [{ loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['B', 'A'] }],
    }, CREDS);
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => /load\/edit/.test(c.url)));                       // anchor engine ran
    assert.ok(!calls.some((c) => /load\/update\/default/.test(c.url)));           // import never fired
  } finally { if (prev !== undefined) process.env.NUVIZZ_LOAD_IMPORT = prev; }
});

test('runOp(commitBoard): no useImport flag = the classic engine, byte-identical to before', async () => {
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  delete process.env.NUVIZZ_LOAD_IMPORT;
  try {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A', 'B']),
      { json: { status: 'SUCCESS' } },   // classic remove
      { json: { status: 'SUCCESS' } },   // classic insert
    ]);
    const r = await runOp(requester, 'commitBoard', { loads: [{ loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['B', 'A'] }] }, CREDS);
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => /load\/edit/.test(c.url)));                       // anchor engine ran
    assert.ok(!calls.some((c) => /load\/update\/default/.test(c.url)));           // import never fired
  } finally { if (prev !== undefined) process.env.NUVIZZ_LOAD_IMPORT = prev; }
});

// ── quick mode + pending (the board Save's budget-safe convergence handoff) ──

test('board Save (import mode): unconfirmed import returns PENDING — no resend/reverse/assign in-band', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A', 'B']),      // fetchLoad
      ACK,                                    // the import
      rawLoadDoc(L1, L1ID, ['A', 'B']),      // quick confirm poll: still the OLD order → pending
    ]);
    const r = await runCommitBoardImport(requester, { loads: [
      { loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['B', 'A'], driverId: 77, dispatch: true },
    ] }, CREDS, NOSLEEP);
    assert.equal(r.ok, false);
    assert.equal(r.loads[0].pending, true);
    assert.deepEqual(r.loads[0].requestedOrder, ['B', 'A']);
    assert.equal(r.loads[0].error, null);                       // pending is NOT a failure
    // Exactly fetchLoad + import + one confirm poll — the client drives the rest. And the
    // driver/dispatch never fire against an unconfirmed order.
    assert.equal(calls.length, 3);
    assert.ok(!calls.some((c) => /assignanddispatch/.test(c.url)));
    const imports = calls.filter((c) => /load\/update\/default/.test(c.url));
    assert.equal(imports.length, 1);
  });
});

test('board Save (import mode): the added stops\' FROM address still donates the header origin when the re-read lacks from blocks', async () => {
  await withGate(async () => {
    // A re-read whose raw stops carry NO from block (some tenants omit it) — the origin must
    // then come from the arrival stopDocs' fromAddress donors captured at resolution time.
    const reReadNoFrom = rawLoadDoc(L1, L1ID, ['X', 'Y']);
    for (const s of reReadNoFrom.json.Load.stops) delete s.stop.from;
    const convergedNoFrom = rawLoadDoc(L1, L1ID, ['X', 'Y']);
    for (const s of convergedNoFrom.json.Load.stops) delete s.stop.from;
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, []),               // empty Draft load — nothing to echo origin from
      stopDoc('X', null, true),               // getStop X — carries the warehouse "from" address
      stopDoc('Y', null, true),               // getStop Y
      { json: { status: 'SUCCESS' } },        // LEVER 1: bulk insert
      reReadNoFrom,                           // re-read (no from blocks anywhere)
      ACK,
      convergedNoFrom,                        // converged
    ]);
    // NO payload.origin — the donor must cover it.
    const r = await runCommitBoardImport(requester, { loads: [{ loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['X', 'Y'] }] }, CREDS, NOSLEEP);
    assert.equal(r.ok, true);
    const imp = calls.find((c) => /load\/update\/default/.test(c.url));
    assert.equal(imp.body.loads[0].loadHeader.originName, 'DAVIS WAREHOUSE');
  });
});

test('assembleImportHeader: a non-ISO (epoch) header date is never echoed — derived from the service date', () => {
  const h = { loadNbr: L1, earliestStartDttm: 1782813600000, latestStartDttm: 1782856800000 };
  const out = assembleImportHeader(h, [{ stop: { from: { address: FROM_ADDR } } }], null, '2026-07-03');
  assert.equal(out.earliestStartDttm, '2026-07-03T06:00:00');
  assert.equal(out.latestStartDttm, '2026-07-03T18:00:00');
});

// ── seeding: EMPTY Draft load known only by its internal loadId (the live-tenant
//    state that refused every build-from-unplanned Save with "needs a load number") ──

const NOT_FOUND_501 = { status: 501, json: {} };   // load/static/info on the live tenant

test('board Save (import mode): loadId-only EMPTY load — seed via insertstops, learn the number, then two-lever plan+order', async () => {
  _resetStaticInfoMemo();
  await withGate(async () => {
    const { requester, calls } = stub([
      stopDoc('X'),                            // resolveLoadNbrByStopNbr: X is unplanned
      NOT_FOUND_501,                           // resolveLoadNbrById: static/info 501
      stopDoc('X'),                            // seeding read: unplanned, has stopId
      { json: { status: 'SUCCESS' } },         // SEED: insertstops(loadId, [id-X])
      stopDoc('X', L1),                        // read-back: X now on DAVIS…201 → the number!
      rawLoadDoc(L1, L1ID, ['X']),             // fetchLoad by the learned number (identity matches)
      stopDoc('Y', null, true),                // arrival resolution for the second unplanned order
      { json: { status: 'SUCCESS' } },         // LEVER 1: insertStops [id-Y] (the REAL record)
      rawLoadDoc(L1, L1ID, ['X', 'Y']),        // re-read: both on the load
      ACK,                                     // LEVER 2: the ordering import (full echoes)
      rawLoadDoc(L1, L1ID, ['X', 'Y']),        // converged
    ]);
    const r = await runCommitBoardImport(requester, { loads: [
      { loadId: L1ID, routeName: 'SUW 5', orderedStopNbrs: ['X', 'Y'] },   // NO loadNbr — like the real card
    ] }, CREDS, NOSLEEP);
    assert.equal(r.ok, true);
    assert.equal(r.loads[0].loadNbr, L1);
    const inserts = calls.filter((c) => /insertstops/.test(c.url));
    assert.equal(inserts.length, 2, 'the seed + the arrival plan — both real-record inserts');
    assert.deepEqual(inserts[0].body.insertStopIds, ['id-X']);
    assert.equal(inserts[0].body.loadId, L1ID);
    assert.deepEqual(inserts[1].body.insertStopIds, ['id-Y']);
    const imp = calls.find((c) => /load\/update\/default/.test(c.url));
    assert.deepEqual(imp.body.loads[0].stops.map((s) => s.stopNbr), ['X', 'Y']);
    assert.ok(r.loads[0].steps.some((s) => s.op === 'seedLoad' && s.ok && s.loadNbr === L1));
  });
});

test('board Save (classic engine): loadId-only EMPTY load — seed resolves the number, anchor plan proceeds', async () => {
  _resetStaticInfoMemo();
  const prev = process.env.NUVIZZ_LOAD_IMPORT;
  delete process.env.NUVIZZ_LOAD_IMPORT;
  try {
    const { requester, calls } = stub([
      stopDoc('X'),                            // probe: X unplanned
      NOT_FOUND_501,                           // static/info 501
      stopDoc('X'),                            // seeding read
      { json: { status: 'SUCCESS' } },         // SEED insert
      stopDoc('X', L1),                        // read-back: the number
      rawLoadDoc(L1, L1ID, ['X']),             // getLoad: X is on the load (the anchor)
      stopDoc('Y'),                            // resolve Y's stopId (an add)
      { json: { status: 'SUCCESS' } },         // Phase 2: insert Y
    ]);
    const r = await runOp(requester, 'commitBoard', { loads: [
      { loadId: L1ID, routeName: 'SUW 5', orderedStopNbrs: ['X', 'Y'] },
    ] }, CREDS);
    assert.equal(r.ok, true);
    // Two inserts total (the seed + Y), and never a load/edit — X anchors the load.
    assert.equal(calls.filter((c) => /insertstops/.test(c.url)).length, 2);
    assert.ok(!calls.some((c) => /load\/edit/.test(c.url)));
  } finally { if (prev !== undefined) process.env.NUVIZZ_LOAD_IMPORT = prev; }
});

test('seeding never fires for a load with NO ordered stops (nothing to seed with)', async () => {
  await withGate(async () => {
    const { requester, calls } = stub([{ json: {} }]);
    const r = await runCommitBoardImport(requester, { loads: [
      { loadId: L1ID, routeName: 'SUW 5', emptyLoad: true, orderedStopNbrs: [] },   // cancel intent
    ] }, CREDS, NOSLEEP);
    // Goes to the legacy engine (which refuses an id-only cancel) — but never inserts anything.
    assert.ok(!calls.some((c) => /insertstops/.test(c.url)));
    assert.equal(r.ok, false);
  });
});

// ── the live-tenant header shapes that produced NuVizz's 400 (from the write journal) ──

test('assembleImportHeader: live load/info header — origin OBJECT never echoed; GEORGIA/UNITED STATES normalized; concatenated addr1 stripped', () => {
  // TRULY verbatim shape from the journaled failing Save (SUW 5 / DAVIS000198073) — note the
  // flat originAddr1 is NuVizz's whole one-line geocoder address, not a clean street line.
  const liveHeader = {
    loadNbr: 'DAVIS000198073', routeName: 'SUW 5', loadTimeZone: 'EST',
    earliestStartDttm: '2026-07-02T12:00:00', latestStartDttm: '2026-07-02T23:59:00',
    origin: { address: { city: 'BUFORD', addr1: '943 GAINESVILLE HWY, BUFORD, GA 30518, USA', addressType: 'COM', name: 'Not Available', state: 'GEORGIA', country: 'UNITED STATES', longitude: -83.95948, zip: '30518', latitude: 34.14838 } },
    originName: 'ULINE', originAddr1: '943 GAINESVILLE HWY, BUFORD, GA 30518, USA', originCity: 'BUFORD',
    originState: 'GEORGIA', originZip: '30518', originCountry: 'UNITED STATES',
  };
  const out = assembleImportHeader(liveHeader, [], null, null);
  assert.equal(out.origin, 'WHSE');                    // the address OBJECT is never echoed as the code
  assert.equal(typeof out.origin, 'string');
  assert.equal(out.originName, 'ULINE');
  assert.equal(out.originAddr1, '943 GAINESVILLE HWY'); // ", CITY, ST ZIP, COUNTRY" tail stripped
  assert.equal(out.originState, 'GA');                 // GEORGIA → GA (the proven contract shape)
  assert.equal(out.originCountry, 'USA');              // UNITED STATES → USA
  for (const [k, v] of Object.entries(out)) if (v !== undefined) assert.equal(typeof v, 'string', `${k} must be a string`);
});

test('assembleImportHeader: a millis/offset date is truncated to the proven 19-char shape', () => {
  const out = assembleImportHeader({ loadNbr: L1, earliestStartDttm: '2026-07-02T12:00:00.000+0000', latestStartDttm: '2026-07-02T23:59:00Z', originName: 'W', originAddr1: '1 Depot Rd', originCity: 'A', originState: 'GA', originZip: '1' }, [], null, null);
  assert.equal(out.earliestStartDttm, '2026-07-02T12:00:00');
  assert.equal(out.latestStartDttm, '2026-07-02T23:59:00');
});

test('importOk: PARTIALSUCCESS (or any present non-SUCCESS status) is NEVER an accepted ack', () => {
  assert.equal(importOk(true, { status: 'PARTIALSUCCESS', message: 'Async import is SUCCESS with AppMessageLog Id-1' }).ok, false);
  assert.equal(importOk(true, { status: 'FAILURE', message: 'import was not successful' }).ok, false);
  assert.equal(importOk(true, { message: 'Async import is SUCCESS with AppMessageLog Id-2' }).ok, true); // no status field → text match
});

test('firstError (via importOk): a bare "Bad Request" never buries the Spring message detail', () => {
  const r = importOk(true, { status: 'ERROR', error: 'Bad Request', message: 'JSON parse error: Cannot deserialize value' });
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON parse error/);
});

test('importRefFromRaw: long-form state/country normalized; epoch schedule dropped and synthesized from the service date', () => {
  const raw = { stop: { stopNbr: 'A', stopType: 'DO', to: {
    address: { name: 'C', addr1: '1 Elm', city: 'Macon', state: 'GEORGIA', zip: '31201', country: 'UNITED STATES' },
    schedule: { timeFrom: 1782813600000, timeTo: 1782856800000, timeZone: 'America/New_York', estimatedDuration: 15 },
  } } };
  const ref = importRefFromRaw(raw, '2026-07-03');
  assert.equal(ref.to.address.state, 'GA');
  assert.equal(ref.to.address.country, 'USA');
  assert.equal(ref.to.schedule.timeFrom, '2026-07-03T12:00:00');   // epoch dropped → synthesized window
  assert.equal(ref.to.schedule.estimatedDuration, undefined);       // unproven field never echoed
});

test('buildImportBody: refuses a non-string header field (the exact Jackson-400 shape) with zero NuVizz calls', () => {
  const h = { ...HDR, origin: { address: { city: 'BUFORD' } } };
  assert.throws(() => buildImportBody({ loadHeader: h, stops: [stopRef('A')] }, 'DAVIS'), /must be a string/);
});

test('importRefFromRaw: an OBJECT nested under a scalar address key is dropped, never echoed', () => {
  const raw = { stop: { stopNbr: 'A', stopType: 'DO', to: { address: { ...toBlock('A').address, addressType: { code: 'COM' } }, schedule: toBlock('A').schedule } } };
  const ref = importRefFromRaw(raw);
  assert.equal(ref.to.address.addressType, undefined);   // object dropped by the primitives-only echo
  assert.equal(ref.to.address.addr1, 'A Main St');
});

test('multi-load Save: every import fires with NO in-band confirm poll — all pending for the client verifier', async () => {
  await withGate(async () => {
    const L3 = 'DAVIS000000203', L3ID = 'aaaaaaaaaaaaaaaaaaaaaaa3';
    const { requester, calls } = stub([
      rawLoadDoc(L1, L1ID, ['A', 'B']),          // fetchLoad L1
      rawLoadDoc(L3, L3ID, ['C', 'D']),          // fetchLoad L3 (independent loads, no cross-dep)
      ACK,                                        // L1 import
      ACK,                                        // L3 import
    ]);
    const r = await runCommitBoardImport(requester, { loads: [
      { loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['B', 'A'] },
      { loadNbr: L3, loadId: L3ID, orderedStopNbrs: ['D', 'C'] },
    ] }, CREDS, NOSLEEP);
    assert.equal(r.loads.filter((l) => l.pending).length, 2);
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2);   // ONLY the two fetchLoads — zero confirm polls
    assert.equal(calls.filter((c) => /load\/update\/default/.test(c.url)).length, 2);
  });
});

test('convergence is STRICT: a read-back with a missing to.seq never converges, even in the right array order', async () => {
  await withGate(async () => {
    const noSeqDoc = { json: { Load: {
      loadHeader: { loadId: L1ID, loadNbr: L1 }, versionId: 'v1', loadExecutionInfo: {},
      stops: [
        { stop: { stopId: 'id-B', stopNbr: 'B', stopType: 'DO', to: { seq: 2 } } },
        { stop: { stopId: 'id-A', stopNbr: 'A', stopType: 'DO', to: {} } },   // seq not assigned yet
      ],
    } } };
    const { requester } = stub([rawLoadDoc(L1, L1ID, ['A', 'B']), ACK, noSeqDoc]);
    const r = await runCommitBoardImport(requester, { loads: [{ loadNbr: L1, loadId: L1ID, orderedStopNbrs: ['B', 'A'] }] }, CREDS, NOSLEEP);
    assert.equal(r.loads[0].pending, true);   // NOT converged — the seq isn't real yet
  });
});
