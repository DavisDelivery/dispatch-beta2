// test/nuvizz-write-board.test.mjs — the panel-level Save (runCommitBoard), §10 two-phase.
// No network: the requester is a stub recording calls + returning scripted bodies in order.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runCommitBoard, runOp } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
// A realistic INTERNAL loadId (24-hex loadHeader.loadId) — the only kind the executor trusts as the
// assign/dispatch routeId without re-resolving it via getLoad.
const HEXID = '6a438e9d52ef82bd1ed4516b';

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
const loadDoc = (loadId, versionId, deliveries) => ({ json: { Load: {
  loadHeader: { loadId, routeName: loadId }, versionId, loadExecutionInfo: { loadStatus: 'PLANNED' },
  stops: deliveries.map((id, k) => ({ stop: { stopId: id, stopNbr: id, stopSeq: k + 1, stopType: 'DO' } })),
} } });
const ok = () => ({ json: { status: 'SUCCESS' } });
// load/static/info(routeId) response — resolves a load's HUMAN loadNbr (+ loadId echo) from its id.
const staticInfo = (loadNbr, loadId) => ({ json: { Load: { loadHeader: { loadNbr, loadId: loadId ?? null } } } });
// stop/info response — a stop's own load membership carries the load's real number (assignedLoadNbr).
const stopInfo = (loadNbr) => ({ json: { Stop: { stop: {}, stopExecutionInfo: { stopStatus: '20' }, load: { loadNbr: loadNbr ?? null } } } });

test('commitBoard: single-load reorder → getLoad, then anchor-remove, then ordered one-at-a-time inserts', async () => {
  const { requester, calls } = stub([
    loadDoc('L1', 'v1', ['A', 'B', 'C']),   // Phase 0 getLoad
    ok(),                                     // Phase 1 load/edit (remove A,B)
    ok(),                                     // Phase 2 insert B
    ok(),                                     // Phase 2 insert A
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['C', 'B', 'A'] }] }, CREDS);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'POST', 'POST']);
  assert.match(calls[0].url, /\/load\/info\//);
  assert.match(calls[1].url, /\/load\/edit\//);
  assert.deepEqual(calls[1].body.removeStopIds, ['A', 'B'], 'remove every delivery except the anchor C');
  assert.match(calls[2].url, /\/load\/insertstops\//);
  assert.deepEqual(calls[2].body.insertStopIds, ['B']);
  assert.deepEqual(calls[3].body.insertStopIds, ['A'], 'one-at-a-time, in order → [C,B,A]');
});

test('commitBoard: a load that does not resolve → self-describing "load not found" (loadNbr + HTTP status)', async () => {
  // The whole point of the field diagnostic: a dispatcher can read the toast back to us and we
  // know immediately whether the load number is wrong (404) or the response shape is off.
  const { requester } = stub([{ status: 404, json: {} }]);   // getLoad 404
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000197184', routeName: 'LVILLE', orderedStopIds: ['A', 'B'] }] }, CREDS);
  assert.equal(r.loads[0].ok, false);
  assert.match(r.loads[0].error, /load not found/);
  assert.match(r.loads[0].error, /loadNbr="DAVIS000197184"/, 'names the exact load number queried');
  assert.match(r.loads[0].error, /HTTP 404/, 'surfaces NuVizz response status');
});

test('commitBoard: load/info 200 but no loadId → diagnostic distinguishes it from a 404', async () => {
  const { requester } = stub([{ status: 200, json: { Load: { loadHeader: {} } } }]);  // 200, no loadId
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', routeName: 'BEN 1', orderedStopIds: ['A'] }] }, CREDS);
  assert.equal(r.loads[0].ok, false);
  assert.match(r.loads[0].error, /200 but no loadId/, 'a resolved-but-unparseable load reads differently than a 404');
});

// A load whose stops carry DISTINCT stopNbr vs stopId (real NuVizz), with the order in stop.to.seq.
const loadDocNbr = (loadId, versionId, deliveries) => ({ json: { Load: {
  loadHeader: { loadId, routeName: loadId }, versionId, loadExecutionInfo: { loadStatus: 'PLANNED' },
  stops: deliveries.map(([nbr, id], k) => ({ stop: { stopId: id, stopNbr: nbr, to: { seq: k + 2 }, stopType: 'DO' } })),
} } });

test('commitBoard: resolves orderedStopNbrs → stopIds via the load — unplan works without client enrichment', async () => {
  // Client only knows stop NUMBERS (board rows have no stopId). Keep A2, unplan A1 + A3.
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1'], ['A2', 'idA2'], ['A3', 'idA3']]);
  const { requester, calls } = stub([gl, ok()]);   // getLoad + one load/edit remove
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000000002', loadId: HEXID, orderedStopNbrs: ['A2'] }] }, CREDS);
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /\/load\/info\//);
  assert.match(calls[1].url, /\/load\/edit\//);
  assert.deepEqual([...calls[1].body.removeStopIds].sort(), ['idA1', 'idA3'], 'removed the non-anchor deliveries, resolved by stopNbr');
});

test('commitBoard: orderedStopNbrs that resolve to NOTHING (not on load, getStop 404) → refused (stale board)', async () => {
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1']]);
  const { requester, calls } = stub([gl, { status: 404, json: {} }]);   // getLoad + getStop(GHOST) not found
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000000009', loadId: HEXID, orderedStopNbrs: ['GHOST'] }] }, CREDS);
  assert.equal(r.loads[0].ok, false);
  assert.match(r.loads[0].error, /stale board/);
  assert.equal(calls.every((c) => !/load\/edit/.test(c.url)), true, 'no edit fired on a stale order');
});

test('commitBoard: re-adding a stop NOT on the load → getStop resolves its id, then it is INSERTED (not a silent no-op)', async () => {
  // Load is currently [A1]; desired [A1, W] where W was unplanned and is being planned back. W isn't
  // on the load, so it must be resolved via getStop and inserted — the "nothing to send" re-add bug.
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1']]);
  const wStop = { json: { Stop: { stop: { stopId: 'idW', stopNbr: 'W' }, stopExecutionInfo: { stopStatus: '10' }, load: {} } } };
  const { requester, calls } = stub([gl, wStop, ok()]);   // getLoad + getStop(W) + insertStops
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000000002', loadId: HEXID, orderedStopNbrs: ['A1', 'W'] }] }, CREDS);
  assert.equal(r.ok, true);
  const ops = calls.map((c) => c.url.match(/\/(load\/info|stop\/info|load\/edit|load\/insertstops)/)[1]);
  assert.deepEqual(ops, ['load/info', 'stop/info', 'load/insertstops']);
  assert.match(calls[1].url, /\/stop\/info\/W\//, 'resolves the added stop via getStop');
  assert.deepEqual(calls[2].body.insertStopIds, ['idW'], 'the re-added stop is actually inserted');
});

test('commitBoard: emptyLoad removes ALL deliveries (cancel route) — not a false-success no-op', async () => {
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1'], ['A2', 'idA2']]);
  const { requester, calls } = stub([gl, ok()]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000000002', loadId: HEXID, orderedStopNbrs: [], emptyLoad: true }] }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2, 'getLoad + load/edit — the empty-load actually fires (no shortcut no-op)');
  assert.match(calls[1].url, /\/load\/edit\//);
  assert.deepEqual([...calls[1].body.removeStopIds].sort(), ['idA1', 'idA2'], 'removes EVERY delivery');
  assert.ok(r.loads[0].steps.some((s) => s.op === 'removeStops' && s.ok), 'a real remove step is recorded');
});

test('commitBoard: a "Cancelled route" response on an empty-load is treated as success', async () => {
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1']]);
  const cancelResp = { json: { reasons: [{ description: 'Load has been Cancelled' }] } };
  const { requester } = stub([gl, cancelResp]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000000002', loadId: HEXID, emptyLoad: true }] }, CREDS);
  assert.equal(r.loads[0].ok, true, 'the cancellation IS the intended outcome for an empty-load');
  assert.ok(r.loads[0].steps.some((s) => s.cancelledRoute), 'flagged as a route cancel');
});

test('commitBoard: a "Cancelled" response is NOT swallowed for a normal (non-empty) reorder', async () => {
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1'], ['A2', 'idA2']]);
  const cancelResp = { json: { reasons: [{ description: 'Load has been Cancelled' }] } };
  const { requester } = stub([gl, cancelResp]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000000002', loadId: HEXID, orderedStopNbrs: ['A2'] }] }, CREDS);
  assert.equal(r.loads[0].ok, false, 'a reorder is not a cancel — the failure is real');
});

test('commitBoard: REORDER a load known only by loadId → resolve loadNbr from a stop on it (getStop), then remove', async () => {
  // A grid-opened load has only its internal id. Bridge it to its human loadNbr by reading a stop
  // that's ON it (stop/info → assignedLoadNbr) — the reliable source on the live tenant — then run
  // the REAL unplan(load/edit)→re-insert path. Keep A2, unplan A1 + A3.
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1'], ['A2', 'idA2'], ['A3', 'idA3']]);
  const { requester, calls } = stub([stopInfo('DAVIS000000002'), gl, ok()]);
  const r = await runCommitBoard(requester, { loads: [{ loadId: HEXID, orderedStopNbrs: ['A2'] }] }, CREDS);
  assert.equal(r.ok, true);
  const ops = calls.map((c) => c.url.match(/\/(stop\/info|load\/static\/info|load\/info|load\/edit)/)[1]);
  assert.deepEqual(ops, ['stop/info', 'load/info', 'load/edit']);
  assert.match(calls[0].url, /\/stop\/info\/A2\//, 'probes the anchor stop it says is on the load');
  assert.deepEqual([...calls[2].body.removeStopIds].sort(), ['idA1', 'idA3'], 'unplanned via the resolved number');
});

test('commitBoard: reorder loadId-only, getStop returns no membership → falls back to static/info', async () => {
  // If the probe stop isn't on a load yet (assignedLoadNbr null), fall through to load/static/info.
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1'], ['A2', 'idA2'], ['A3', 'idA3']]);
  const { requester, calls } = stub([stopInfo(null), staticInfo('DAVIS000000002', HEXID), gl, ok()]);
  const r = await runCommitBoard(requester, { loads: [{ loadId: HEXID, orderedStopNbrs: ['A2'] }] }, CREDS);
  assert.equal(r.ok, true);
  const ops = calls.map((c) => c.url.match(/\/(stop\/info|load\/static\/info|load\/info|load\/edit)/)[1]);
  assert.deepEqual(ops, ['stop/info', 'load/static/info', 'load/info', 'load/edit']);
});

test('commitBoard: reorder loadId-only + nothing resolves → SEEDING is attempted, then a clear error, no doomed getLoad', async () => {
  // getStop: unplanned AND carries no stopId → seeding can't run either; the error says exactly
  // that (the old bare "needs a load number" refusal only remains for the truly unseedable cases).
  const { requester, calls } = stub([stopInfo(null) /* not on a load */, ok() /* static/info: no loadNbr */, stopInfo(null) /* seeding read: still no stopId */]);
  const r = await runCommitBoard(requester, { loads: [{ loadId: HEXID, orderedStopNbrs: ['A2'] }] }, CREDS);
  assert.equal(r.loads[0].ok, false);
  assert.match(r.loads[0].error, /no internal id to seed/);
  assert.equal(calls.every((c) => !/load\/info\//.test(c.url) && !/load\/edit/.test(c.url) && !/insertstops/.test(c.url)), true, 'no doomed getLoad/edit and no blind insert');
});

test('commitBoard: cross-load move A→B removes from the SOURCE before inserting to the TARGET', async () => {
  // Load1 [A,B] → [A] (B departs). Load2 [C] → [C,B] (B joins).
  const { requester, calls } = stub([
    loadDoc('L1', 'v1', ['A', 'B']),  // Phase 0 getLoad BEN1
    loadDoc('L2', 'v2', ['C']),       // Phase 0 getLoad BEN2
    ok(),                              // Phase 1 load/edit BEN1 (remove B)
    ok(),                              // Phase 2 insertstops BEN2 (B)
  ]);
  const r = await runCommitBoard(requester, { loads: [
    { loadNbr: 'BEN 1', orderedStopIds: ['A'] },
    { loadNbr: 'BEN 2', orderedStopIds: ['C', 'B'] },
  ] }, CREDS);
  assert.equal(r.ok, true);
  // Phase ordering: both getLoads, THEN the remove (frees B), THEN the insert (B onto L2).
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET', 'POST', 'POST']);
  assert.match(calls[2].url, /\/load\/edit\//);
  assert.deepEqual(calls[2].body.removeStopIds, ['B']);
  assert.match(calls[3].url, /\/load\/insertstops\//);
  assert.deepEqual(calls[3].body.insertStopIds, ['B']);
  assert.equal(calls[3].body.loadId, 'L2', 'B is inserted onto the target load');
});

test('runOp assignDriver: resolves the internal loadId via load/info before assigning (a roster id would silently no-op)', async () => {
  // The Routes-panel dropdown can hand a roster KeyColumn id that ISN'T the internal loadHeader.loadId.
  // NuVizz answers "Success" but persists nothing. Resolve the real id from the load number first.
  const gl = loadDocNbr('6a3realinternalid0000000', 'v1', [['A1', 'idA1']]);
  const { requester, calls } = stub([gl, ok()]);   // getLoad + assignanddispatch
  const r = await runOp(requester, 'assignDriver', { routeId: '6a3rosterkeycolumn000000', loadNbr: 'DAVIS000197968', driverId: 5 }, CREDS);
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /\/load\/info\//, 'resolves the internal id first');
  assert.match(calls[1].url, /assignanddispatch/);
  assert.equal(calls[1].body.dispatchRoute[0].routeId, '6a3realinternalid0000000', 'assigns against the RESOLVED internal loadId, not the roster id');
});

test('commitBoard: emptyLoad with a staged driver/dispatch → cancels the route, does NOT assign/dispatch the dead route', async () => {
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1']]);
  const { requester, calls } = stub([gl, ok()]);   // getLoad + load/edit (cancel). NO assign/dispatch.
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000000002', loadId: HEXID, emptyLoad: true, driverId: 5, dispatch: true }] }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(calls.some((c) => /assignanddispatch/.test(c.url)), false, 'no assign/dispatch against the cancelled route');
  assert.equal(calls.length, 2, 'getLoad + load/edit only');
});

test('commitBoard: assign/dispatch-only load with a known loadId skips getLoad entirely', async () => {
  const { requester, calls } = stub([ok(), ok()]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 3', loadId: HEXID, driverId: 5, dispatch: true }] }, CREDS);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'POST'], 'no getLoad');
  assert.match(calls[0].url, /assignanddispatch/);
  assert.equal(calls[0].body.action, 'ASSIGN_DISPATCH');
  assert.equal(calls[0].body.dispatchRoute[0].assignDtls.driverId, 5);
  assert.equal(calls[1].body.action, 'DISPATCH');
});

test('commitBoard: add NEW stops to a loadId-only load, static/info can\'t resolve → insert-only', async () => {
  // A brand-new/Draft load with no resolvable number: adding new (unplanned) stopIds inserts them
  // straight onto the loadId (no reorder path). static/info is TRIED first (returns no number here).
  const { requester, calls } = stub([ok() /* static/info: no loadNbr */, ok(), ok()]);
  const r = await runCommitBoard(requester, { loads: [{ loadId: HEXID, orderedStopIds: ['s1', 's2'] }] }, CREDS);
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /static\/info/);
  assert.equal(calls.every((c) => !/load\/info\//.test(c.url) && !/load\/edit/.test(c.url)), true, 'no load/info or remove — nothing to reorder');
  assert.deepEqual(calls.slice(1).map((c) => c.body.insertStopIds), [['s1'], ['s2']]);
  assert.equal(calls[1].body.loadId, HEXID, 'inserts against the loadId');
});

test('commitBoard: a hash-like loadId leaked into loadNbr is NOT used for load/info', async () => {
  // Defense in depth — even if the client sends the hex as loadNbr, the server must not GET load/info
  // with it (it would 404); it resolves via static/info (fails here) then insert-only off the loadId.
  const { requester, calls } = stub([ok() /* static/info: no loadNbr */, ok()]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: HEXID, loadId: HEXID, orderedStopIds: ['s1'] }] }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(calls.every((c) => !/load\/info\//.test(c.url)), true, 'no load/info on a hex loadNbr');
  assert.match(calls[1].url, /insertstops/);
});

test('commitBoard: assign-only with a NON-internal (roster) loadId → resolves the real loadId via getLoad first', async () => {
  // An empty/Draft load has no stops to carry its internal loadHeader.loadId, so the board can hand
  // us the PkgRoute roster id ("6a3560cb_ALPHA"). That is NOT the internal id NuVizz assigns against —
  // it answers "Success" yet never persists. The executor must getLoad to resolve the real id first.
  const { requester, calls } = stub([
    loadDoc(HEXID, 'v1', []),   // Phase 0 getLoad resolves the internal id (empty load → no stops)
    ok(),                       // assign
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'ALPHA', loadId: '6a3560cb_ALPHA', driverId: 53037 }] }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/load\/info\//, 'resolves the load before assigning');
  assert.match(calls[1].url, /assignanddispatch/);
  assert.equal(calls[1].body.action, 'ASSIGN_DISPATCH');
  assert.equal(calls[1].body.dispatchRoute[0].routeId, HEXID, 'assigns against the INTERNAL loadId, not the roster id');
  assert.equal(calls[1].body.dispatchRoute[0].assignDtls.driverId, 53037);
  assert.equal(r.loads[0].loadId, HEXID);
});

test('commitBoard: a refused load (not found) is reported but does NOT block other loads', async () => {
  const { requester, calls } = stub([
    { status: 404, json: {} },        // getLoad for the bad load → not found
    loadDoc('L2', 'v2', ['C']),       // getLoad for the good load
    ok(),                              // good load insert (D)
  ]);
  const r = await runCommitBoard(requester, { loads: [
    { loadNbr: 'BAD', orderedStopIds: ['A', 'B'] },   // load not found → refuse
    { loadNbr: 'GOOD', orderedStopIds: ['C', 'D'] },  // add D
  ] }, CREDS);
  assert.equal(r.ok, false, 'overall not ok because one load failed');
  const bad = r.loads.find((l) => l.loadNbr === 'BAD');
  const good = r.loads.find((l) => l.loadNbr === 'GOOD');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /load not found/);
  assert.equal(good.ok, true, 'the good load still committed');
  assert.deepEqual(good.steps.map((s) => s.op), ['insertStops']);
});

test('commitBoard: empty payload → ok with no loads, zero calls', async () => {
  const { requester, calls } = stub([ok()]);
  const r = await runCommitBoard(requester, { loads: [] }, CREDS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.loads, []);
  assert.equal(calls.length, 0);
});

test('commitBoard: a Phase-1 remove failure aborts THAT load before any insert', async () => {
  const { requester, calls } = stub([
    loadDoc('L1', 'v1', ['A', 'B', 'C']),                 // getLoad
    { json: { reasons: [{ description: 'version conflict' }] } }, // load/edit FAILS
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['C', 'A', 'B'] }] }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 2, 'getLoad + failed load/edit only — no inserts after a failed remove');
  assert.equal(r.loads[0].steps[0].op, 'removeStops');
  assert.equal(r.loads[0].steps[0].ok, false);
});

// Custom Load doc with explicit [stopId, seq, type] stops.
const loadDocStops = (loadId, versionId, stops) => ({ json: { Load: {
  loadHeader: { loadId, routeName: loadId }, versionId, loadExecutionInfo: { loadStatus: 'PLANNED' },
  stops: stops.map(([id, seq, type]) => ({ stop: { stopId: id, stopNbr: id, stopSeq: seq, stopType: type || 'DO' } })),
} } });

test('commitBoard: cross-load move where the SOURCE load fails Phase 1 → target does NOT insert the un-freed stop', async () => {
  // BAD is meant to free B (drop it), but its remove FAILS → B is never freed. GOOD wants B from BAD.
  const { requester, calls } = stub([
    loadDocStops('LBAD', 'v1', [['A', 1], ['B', 2]]),   // getLoad BAD (desired [A] → remove B)
    loadDocStops('LGOOD', 'v2', [['C', 1]]),            // getLoad GOOD (desired [C,B]; B is a cross-load arrival)
    { json: { reasons: [{ description: 'version conflict' }] } }, // Phase 1 remove B from BAD FAILS
  ]);
  const r = await runCommitBoard(requester, { loads: [
    { loadNbr: 'BAD', orderedStopIds: ['A'] },          // drop B — but the remove fails
    { loadNbr: 'GOOD', orderedStopIds: ['C', 'B'] },    // B was supposed to be freed by BAD
  ] }, CREDS);
  assert.equal(r.ok, false);
  const good = r.loads.find((l) => l.loadNbr === 'GOOD');
  // GOOD must NOT have fired an insertStops for B (its source BAD never freed it).
  assert.equal(calls.some((c) => /insertstops/.test(c.url)), false, 'no insert of an un-freed cross-load stop');
  assert.equal(good.ok, false);
  assert.ok(good.steps.some((s) => s.op === 'insertStops' && !s.ok && /not freed/.test(s.error)));
});

test('commitBoard: source remove succeeds but target insert FAILS → stop reported as orphaned (UNPLANNED)', async () => {
  // BEN1 [A,B]→[A] frees B. BEN2 [C]→[C,B] inserts B but the insert FAILS → B is now on neither load.
  const { requester } = stub([
    loadDocStops('L1', 'v1', [['A', 1], ['B', 2]]),  // getLoad BEN1
    loadDocStops('L2', 'v2', [['C', 1]]),            // getLoad BEN2
    ok(),                                             // Phase 1 remove B from BEN1 (succeeds → B freed)
    { json: { reasons: [{ description: 'load locked' }] } }, // Phase 2 insert B into BEN2 FAILS
  ]);
  const r = await runCommitBoard(requester, { loads: [
    { loadNbr: 'BEN 1', orderedStopIds: ['A'] },
    { loadNbr: 'BEN 2', orderedStopIds: ['C', 'B'] },
  ] }, CREDS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.orphaned, ['B'], 'B was freed from BEN1 but never landed on BEN2 → orphaned');
});

test('commitBoard: a non-DO stop in a delivery slot (seq>1) → reorder REFUSED, no calls fired for that load', async () => {
  const { requester, calls } = stub([
    loadDocStops('L1', 'v1', [['P', 1, 'PU'], ['A', 2, 'DO'], ['Q', 3, 'XX']]),  // Q is non-DO at seq 3
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['A'] }] }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.loads[0].error, /non-DO stop in a delivery slot/);
  assert.equal(calls.filter((c) => /load\/edit|insertstops/.test(c.url)).length, 0, 'no mutation fired');
});

test('commitBoard: currentDeliveryStopIds excludes the pickup (PU, seq 1) and sorts by stopSeq', async () => {
  // Pickup P at seq 1 (excluded); deliveries given OUT of seq order in the doc.
  const { requester, calls } = stub([
    loadDocStops('L1', 'v1', [['B', 3, 'DO'], ['P', 1, 'PU'], ['A', 2, 'DO']]),  // current deliveries by seq: A(2),B(3)
    ok(), ok(),  // remove + 1 insert
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['B', 'A'] }] }, CREDS);
  assert.equal(r.ok, true);
  const edit = calls.find((c) => /load\/edit/.test(c.url));
  assert.deepEqual(edit.body.removeStopIds, ['A'], 'anchor B kept; only the other DO delivery A removed; pickup P never touched');
});

test('commitBoard: loadId mismatch (name resolved a different instance) → REFUSED', async () => {
  const { requester, calls } = stub([loadDocStops('LWRONGDAY', 'v1', [['A', 1, 'DO'], ['B', 2, 'DO']])]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', loadId: 'LTODAY', orderedStopIds: ['B', 'A'] }] }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.loads[0].error, /load identity mismatch/);
  assert.equal(calls.filter((c) => /load\/edit|insertstops/.test(c.url)).length, 0);
});

test('commitBoard: a Phase-2 INSERT failure aborts that load — no assign/dispatch after', async () => {
  const { requester, calls } = stub([
    loadDocStops('L1', 'v1', [['A', 1, 'DO'], ['B', 2, 'DO'], ['C', 3, 'DO']]),  // getLoad
    ok(),                                              // remove A,B (keep anchor C)
    { json: { reasons: [{ description: 'stop locked' }] } }, // first insert FAILS
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['C', 'B', 'A'], driverId: 7, dispatch: true }] }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(calls.some((c) => /assignanddispatch/.test(c.url)), false, 'no assign/dispatch after a failed insert');
});

test('commitBoard: combined reorder + driver + dispatch on one load fires in order', async () => {
  const { requester, calls } = stub([
    loadDocStops('L1', 'v1', [['A', 1, 'DO'], ['B', 2, 'DO'], ['C', 3, 'DO']]),
    ok(), ok(), ok(), ok(), ok(),  // remove + insert B + insert A + assign + dispatch
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['C', 'B', 'A'], driverId: 5, dispatch: true }] }, CREDS);
  assert.equal(r.ok, true);
  const ops = calls.map((c) => c.url.match(/\/(load\/info|load\/edit|load\/insertstops|load\/assignanddispatch)/)[1]);
  assert.deepEqual(ops, ['load/info', 'load/edit', 'load/insertstops', 'load/insertstops', 'load/assignanddispatch', 'load/assignanddispatch']);
});

test('commitBoard: driverId 0 on a board load fires NO assign', async () => {
  const { requester, calls } = stub([ok()]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', loadId: HEXID, driverId: 0, dispatch: true }] }, CREDS);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.url.match(/(assignanddispatch)/)?.[1]).filter(Boolean), ['assignanddispatch']);
  assert.equal(calls[0].body.action, 'DISPATCH', 'only dispatch, no assign');
});

test('commitBoard: a load with neither loadNbr nor loadId → ok:false, no calls, siblings still commit', async () => {
  const { requester, calls } = stub([ok()]);
  const r = await runCommitBoard(requester, { loads: [
    { orderedStopIds: ['A'] },                       // invalid
    { loadNbr: 'BEN 2', loadId: HEXID, driverId: 5 },  // valid assign-only
  ] }, CREDS);
  const bad = r.loads[0], good = r.loads[1];
  assert.equal(bad.ok, false);
  assert.match(bad.error, /loadNbr or loadId required/);
  assert.equal(good.ok, true);
  assert.equal(calls.length, 1, 'only the valid assign fired');
});

test('commitBoard: a NEW stop as the first delivery → insert it BEFORE removing the rest (no cancel)', async () => {
  const { requester, calls } = stub([
    loadDocStops('L1', 'v1', [['A', 1, 'DO'], ['B', 2, 'DO']]),  // getLoad — load has A,B
    ok(),   // Phase 0.5 insert X (the new first delivery) — anchors the load
    loadDocStops('L1', 'v2', [['X', 0, 'DO'], ['A', 1, 'DO'], ['B', 2, 'DO']]),  // Phase 0.5 re-fetch → fresh versionId
    ok(),   // Phase 1 remove A,B
    ok(),   // Phase 2 insert A
    ok(),   // Phase 2 insert B
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['X', 'A', 'B'] }] }, CREDS);
  assert.equal(r.ok, true);
  const ops = calls.map((c) => c.url.match(/\/(load\/info|load\/edit|load\/insertstops)/)[1]);
  assert.deepEqual(ops, ['load/info', 'load/insertstops', 'load/info', 'load/edit', 'load/insertstops', 'load/insertstops'],
    'insert X, re-fetch version, THEN remove, THEN re-insert — X is on the load before anything is stripped');
  assert.equal(calls[3].body.versionId, 'v2', 'the remove echoes the REFRESHED versionId, not the stale pre-insert one');
  const xIdx = calls.findIndex((c) => /insertstops/.test(c.url));
  const editIdx = calls.findIndex((c) => /load\/edit/.test(c.url));
  assert.ok(xIdx < editIdx, 'X is inserted before the remove so the load never drops to zero stops');
  assert.deepEqual(calls[xIdx].body.insertStopIds, ['X'], 'the pre-insert is the new first delivery X');
  assert.deepEqual(calls[editIdx].body.removeStopIds, ['A', 'B']);
});

test('commitBoard: anchor pre-insert FAILS → the remove is NOT fired (load never emptied)', async () => {
  const { requester, calls } = stub([
    loadDocStops('L1', 'v1', [['A', 1, 'DO'], ['B', 2, 'DO']]),   // getLoad
    { json: { reasons: [{ description: 'stop locked' }] } },       // insert X FAILS
  ]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'BEN 1', orderedStopIds: ['X', 'A', 'B'] }] }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(calls.some((c) => /load\/edit/.test(c.url)), false, 'no remove after a failed anchor pre-insert');
});

// stop/info for a stop that IS currently planned on a load — carries its load membership.
const stopOnLoad = (stopId, stopNbr, loadNbr) => ({ json: { Stop: { stop: { stopId, stopNbr }, stopExecutionInfo: { stopStatus: '20' }, load: { loadNbr } } } });

test('commitBoard: adding a stop still planned on a load NOT in this Save → refused (no silent grab)', async () => {
  // Load DAVIS…002 currently [A1]; desired [A1, W] where W is planned on DAVIS…777 — a load that is
  // NOT part of this Save. Nothing would free W (holderOf can't see un-fetched loads), so inserting
  // it would double-plan. Must refuse with a message naming the holder.
  const gl = loadDocNbr(HEXID, 'v1', [['A1', 'idA1']]);
  const { requester, calls } = stub([gl, stopOnLoad('idW', 'W', 'DAVIS000000777')]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000000002', loadId: HEXID, orderedStopNbrs: ['A1', 'W'] }] }, CREDS);
  assert.equal(r.loads[0].ok, false);
  assert.match(r.loads[0].error, /still planned on load DAVIS000000777/);
  assert.equal(calls.some((c) => /insertstops|load\/edit/.test(c.url)), false, 'nothing fired');
});

test('commitBoard: adding a stop whose source load IS in this Save → allowed (staged move)', async () => {
  // Load 1 (DAVIS…001) [A1, X] → [A1] (X departs). Load 2 (DAVIS…002) [B1] → [B1, X] (X joins).
  // getStop(X) shows it planned on DAVIS…001 — which IS in the batch, so the move is staged and allowed.
  const HEX2 = '6a438e9d52ef82bd1ed45170';
  const gl1 = loadDocNbr(HEXID, 'v1', [['A1', 'idA1'], ['X', 'idX']]);
  const gl2 = loadDocNbr(HEX2, 'v2', [['B1', 'idB1']]);
  const { requester, calls } = stub([gl1, gl2, stopOnLoad('idX', 'X', 'DAVIS000000001'), ok(), ok()]);
  const r = await runCommitBoard(requester, { loads: [
    { loadNbr: 'DAVIS000000001', loadId: HEXID, orderedStopNbrs: ['A1'] },
    { loadNbr: 'DAVIS000000002', loadId: HEX2, orderedStopNbrs: ['B1', 'X'] },
  ] }, CREDS);
  assert.equal(r.ok, true);
  const edit = calls.find((c) => /load\/edit/.test(c.url));
  assert.deepEqual(edit.body.removeStopIds, ['idX'], 'X removed from its source load first');
  const ins = calls.find((c) => /insertstops/.test(c.url));
  assert.deepEqual(ins.body.insertStopIds, ['idX'], 'then inserted onto the target');
  assert.equal(ins.body.loadId, HEX2);
});

test('commitBoard: emptyLoad whose NAME resolved a DIFFERENT loadId → identity mismatch refusal (never cancel the wrong route)', async () => {
  const gl = loadDocNbr('6a999999999999999999beef', 'v1', [['A1', 'idA1'], ['A2', 'idA2']]);   // name resolves another instance
  const { requester, calls } = stub([gl]);
  const r = await runCommitBoard(requester, { loads: [{ loadNbr: 'DAVIS000000002', loadId: HEXID, emptyLoad: true }] }, CREDS);
  assert.equal(r.loads[0].ok, false);
  assert.match(r.loads[0].error, /identity mismatch/);
  assert.equal(calls.some((c) => /load\/edit/.test(c.url)), false, 'no remove fired at the wrong instance');
});
