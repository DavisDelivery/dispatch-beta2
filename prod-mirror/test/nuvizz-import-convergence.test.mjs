// test/nuvizz-import-convergence.test.mjs — save-cost investigation (Jul 2 2026 directive):
// 1. the convergence comparator normalizes stopNbr (trim/case/zero-padding) on BOTH sides and
//    compares only deliveries sorted by to.seq;
// 2. the re-send / reverse-unstick REACH THE WIRE (asserted on recorded requests, not return
//    values — the requester stub records every POST);
// 3. quick mode fires ONE import + ONE confirm poll (the backoff wait lives client-side);
// 4. every result self-reports its call anatomy { updates, infos }.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { runImportLoad } from '../netlify/functions/lib/nuvizz-write.mts';

// Since the Jul 2 incident the import engine needs the server's EXPLICIT enable —
// these tests exercise the convergence machinery, so open the gate for the file.
let prevGate;
before(() => { prevGate = process.env.NUVIZZ_LOAD_IMPORT; process.env.NUVIZZ_LOAD_IMPORT = 'on'; });
after(() => { if (prevGate === undefined) delete process.env.NUVIZZ_LOAD_IMPORT; else process.env.NUVIZZ_LOAD_IMPORT = prevGate; });
import { normStopNbr, sameOrder } from '../netlify/functions/lib/nuvizz-write-ops.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const noSleep = async () => {};

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

const HDR = {
  loadNbr: 'DAVIS000198070', routeName: 'SUW',
  earliestStartDttm: '2026-07-02T06:00:00', latestStartDttm: '2026-07-02T18:00:00',
  origin: 'WHSE', originName: 'Buford Terminal', originAddr1: '943 Gainesville Hwy',
  originCity: 'Buford', originState: 'GA', originZip: '30518',
};
const ref = (nbr) => ({ stopNbr: nbr, stopType: 'DO', to: { address: { name: `C${nbr}`, addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518', country: 'USA' } } });
const PAYLOAD = { load: { loadHeader: HDR, stops: [ref('007141643'), ref('007141903'), ref('007141946')] } };

const ACK = { json: { status: 'Request for LOAD Async import is SUCCESS. Find more info in AppMessageLog with Id- abc-123' } };
// A getLoad body whose stopNbrs come back UNPADDED NUMBERS (NuVizz typing drift) in the sent order.
const LOAD_MATCH_UNPADDED = { json: { Load: {
  loadHeader: { loadId: '6a438e9d52ef82bd1ed4516b', loadNbr: 'DAVIS000198070' }, versionId: 'v1',
  loadExecutionInfo: { loadStatus: 'Draft' },
  stops: [
    { stop: { stopId: 'i1', stopNbr: 7141643, stopType: 'DO', to: { seq: 2 } } },
    { stop: { stopId: 'i2', stopNbr: 7141903, stopType: 'DO', to: { seq: 3 } } },
    { stop: { stopId: 'i3', stopNbr: 7141946, stopType: 'DO', to: { seq: 4 } } },
  ],
} } };
// Wrong order (the Jul 2 stuck-append shape: last stop pulled to the tail is 643).
const LOAD_WRONG = { json: { Load: {
  loadHeader: { loadId: '6a438e9d52ef82bd1ed4516b', loadNbr: 'DAVIS000198070' }, versionId: 'v1',
  loadExecutionInfo: { loadStatus: 'Draft' },
  stops: [
    { stop: { stopId: 'i2', stopNbr: '007141903', stopType: 'DO', to: { seq: 2 } } },
    { stop: { stopId: 'i3', stopNbr: '007141946', stopType: 'DO', to: { seq: 3 } } },
    { stop: { stopId: 'i1', stopNbr: '007141643', stopType: 'DO', to: { seq: 4 } } },
  ],
} } };

test('normStopNbr / sameOrder: padding, typing, case and trim never read as a mismatch', () => {
  assert.equal(normStopNbr(' 007141643 '), '7141643');
  assert.equal(normStopNbr(7141643), '7141643');
  assert.equal(normStopNbr('abc'), 'ABC');
  assert.equal(normStopNbr('0'), '0');
  assert.equal(sameOrder([7141643, '007141903'], ['007141643', 7141903]), true);
  assert.equal(sameOrder(['007141643'], ['007141643', '1']), false, 'membership still strict');
  assert.equal(sameOrder(['007141903', '007141643'], ['007141643', '007141903']), false, 'order still strict');
});

test('quick mode: 1 update + 1 confirm poll; converges through unpadded read-back; anatomy reported', async () => {
  const { requester, calls } = stub([ACK, LOAD_MATCH_UNPADDED]);
  const r = await runImportLoad(requester, { ...PAYLOAD, convergence: { quick: true, pollMs: 1, phaseWaitMs: 1, sleep: noSleep } }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(r.converged, true);
  const updates = calls.filter((c) => c.url.includes('/load/update/'));
  const infos = calls.filter((c) => c.url.includes('/load/info/'));
  assert.equal(updates.length, 1, 'exactly one import POST');
  assert.equal(infos.length, 1, 'exactly one confirm read');
  assert.deepEqual(r.calls, { updates: 1, infos: 1 });
});

test('WIRE: full recipe fires import + resend + reverse + forward as four real POSTs', async () => {
  // Never-converging reads → the executor must escalate all the way; assert on recorded wire
  // calls (directive #2: the idempotency layer must not swallow the re-send — it cannot, the
  // executor calls the requester directly, and this proves it).
  const { requester, calls } = stub([
    ACK, LOAD_WRONG,          // import + poll (1 poll: pollMs==phaseWaitMs)
    ACK, LOAD_WRONG,          // resend + poll
    ACK,                      // reverse
    ACK, LOAD_WRONG,          // forward + poll
  ]);
  const r = await runImportLoad(requester, { ...PAYLOAD, convergence: { pollMs: 1, phaseWaitMs: 1, sleep: noSleep } }, CREDS);
  assert.equal(r.ok, false);
  const updates = calls.filter((c) => c.url.includes('/load/update/'));
  assert.equal(updates.length, 4, 'import, resend, reverse-unstick, forward-after-reverse all reach the wire');
  // The reverse POST really is reversed on the wire.
  const sent = updates.map((c) => c.body.loads[0].stops.map((s) => s.stopNbr));
  assert.deepEqual(sent[0], ['007141643', '007141903', '007141946']);
  assert.deepEqual(sent[1], sent[0], 'resend = same order');
  assert.deepEqual(sent[2], ['007141946', '007141903', '007141643'], 'reverse-unstick = reversed on the wire');
  assert.deepEqual(sent[3], sent[0], 'forward = desired order again');
  assert.equal(r.calls.updates, 4);
});

test('unstick mode (client escalation): exactly reverse + forward, then one poll — no initial import', async () => {
  const { requester, calls } = stub([ACK, ACK, LOAD_MATCH_UNPADDED]);
  const r = await runImportLoad(requester, { ...PAYLOAD, convergence: { quick: true, unstick: true, pollMs: 1, phaseWaitMs: 1, sleep: noSleep } }, CREDS);
  assert.equal(r.ok, true);
  const updates = calls.filter((c) => c.url.includes('/load/update/'));
  assert.equal(updates.length, 2, 'reverse + forward only');
  assert.deepEqual(updates[0].body.loads[0].stops.map((s) => s.stopNbr), ['007141946', '007141903', '007141643']);
  assert.deepEqual(updates[1].body.loads[0].stops.map((s) => s.stopNbr), ['007141643', '007141903', '007141946']);
  assert.deepEqual(r.calls, { updates: 2, infos: 1 });
});

test('convergence journal keeps EVERY poll read-back (seenHistory), not just the last', async () => {
  const { requester } = stub([ACK, LOAD_WRONG, LOAD_MATCH_UNPADDED]);
  // pollMs floors at 250ms in the executor; phaseWaitMs 500 → exactly 2 polls (sleep is a no-op).
  const r = await runImportLoad(requester, { ...PAYLOAD, convergence: { quick: true, pollMs: 250, phaseWaitMs: 500, sleep: noSleep } }, CREDS);
  assert.equal(r.ok, true, 'second poll converges');
  const conv = r.steps.find((s) => s.op === 'converge');
  assert.equal(conv.seenHistory.length, 2, 'both polls journaled');
  assert.deepEqual(conv.seenHistory[0], ['007141903', '007141946', '007141643']);
});
