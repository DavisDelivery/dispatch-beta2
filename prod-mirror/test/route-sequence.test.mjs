import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStop, normalizeStopEvents } from '../netlify/functions/lib/nuvizz-scan.mts';

// A delivery (DO) stop as it arrives from /load/info: NuVizz's authoritative route
// sequence lives in stop.to.seq (the Route Workbench order). loadStopSeq is only the
// raw array index and must NOT be used for ordering.
function doStop({ stopNbr, toSeq, loadStopSeq, eta }) {
  return {
    stop: {
      stopNbr,
      stopType: 'DO',
      to: { seq: toSeq, address: { name: 'ACME', addr1: '1 MAIN ST', city: 'BUFORD', state: 'GA', zip: '30518' } },
      from: { seq: toSeq != null ? toSeq - 1 : null },
    },
    load: { loadNbr: 'DAVIS000197116', stopSeq: loadStopSeq, driverUserName: 'DENIS', driverName: 'DENIS S' },
    stopExecutionInfo: { stopStatus: '20', to: eta ? { plannedEtaDTTM: eta } : {} },
  };
}

test('normalizeStop surfaces NuVizz route sequence as routeSeq (stop.to.seq)', () => {
  const n = normalizeStop(doStop({ stopNbr: '007135631', toSeq: 7, loadStopSeq: 12, eta: '2026-06-19T12:22:36' }));
  assert.equal(n.routeSeq, 7);          // the Workbench order
  assert.equal(n.loadStopSeq, 12);      // raw array order — preserved but not used for sequencing
});

test('routeSeq is present even when no ETA has been computed (not-yet-started route)', () => {
  const n = normalizeStop(doStop({ stopNbr: '007135631', toSeq: 3, loadStopSeq: 0, eta: null }));
  assert.equal(n.routeSeq, 3);
  assert.equal(n.plannedEtaDTTM, null);
});

test('routeSeq is null when NuVizz provides no sequence', () => {
  const raw = doStop({ stopNbr: '007135631', toSeq: null, loadStopSeq: 4, eta: null });
  raw.stop.to.seq = undefined;
  raw.stop.from.seq = undefined;
  const n = normalizeStop(raw);
  assert.equal(n.routeSeq, null);
});

// Sorting check: ordering by routeSeq must match the Route Workbench, even when the
// raw loadStopSeq array order is scrambled relative to the true sequence.
test('ordering by routeSeq matches NuVizz, not the scrambled array order', () => {
  const stops = [
    normalizeStop(doStop({ stopNbr: 'C', toSeq: 3, loadStopSeq: 0, eta: '2026-06-19T11:00:00' })),
    normalizeStop(doStop({ stopNbr: 'A', toSeq: 1, loadStopSeq: 2, eta: '2026-06-19T09:00:00' })),
    normalizeStop(doStop({ stopNbr: 'B', toSeq: 2, loadStopSeq: 1, eta: '2026-06-19T10:00:00' })),
  ];
  const byRouteSeq = [...stops].sort((a, b) => a.routeSeq - b.routeSeq).map((s) => s.stopNbr);
  assert.deepEqual(byRouteSeq, ['A', 'B', 'C']);
  // The raw array order (loadStopSeq) would have produced C, B, A — i.e. wrong.
  const byArray = [...stops].sort((a, b) => a.loadStopSeq - b.loadStopSeq).map((s) => s.stopNbr);
  assert.deepEqual(byArray, ['C', 'B', 'A']);
});

// stopId (entityId for the activity timeline) + the FULL comment list for the notes panel.
test('normalizeStop surfaces stopId and the full comment list (all types, author + time)', () => {
  const raw = doStop({ stopNbr: '007137372', toSeq: 1, loadStopSeq: 0, eta: null });
  raw.stop.stopId = 'ST-SYS-123';
  raw.stop.comments = [
    { commentDescription: 'MISSLOADED', cmtType: 'PRE_VISIT', commentTypeDescription: 'Pre-Visit', addedByName: 'FREDDY PEREZ', addedOn: '2026-06-23T15:35:26', accessLevels: ['DISPATCHER'], source: 'ULINE' },
    { commentDescription: 'SPL-INSTR-TEXT: INSIDE DELIVERY', cmtType: 'ORD_IN', commentTypeDescription: 'Order Instructions', addedByName: 'FREDDY PEREZ', addedOn: '2026-06-23T15:35:26', accessLevels: ['DRIVER'], source: 'ULINE' },
    { commentDescription: '   ' }, // blank → dropped
  ];
  const n = normalizeStop(raw);
  assert.equal(n.stopId, 'ST-SYS-123');
  assert.equal(n.allComments.length, 2, 'both non-blank comments kept (billing/pre-visit NOT filtered out)');
  assert.equal(n.allComments[0].text, 'MISSLOADED');
  assert.equal(n.allComments[0].type, 'PRE_VISIT');
  assert.equal(n.allComments[0].addedBy, 'FREDDY PEREZ');
  assert.equal(n.allComments[0].source, 'ULINE');
  // orderInstructions still only carries the filtered delivery instruction.
  assert.equal(n.signalSources.orderInstructions, 'SPL-INSTR-TEXT: INSIDE DELIVERY');
});

test('normalizeStopEvents: maps both wrapper shapes, newest-first, with By/From when present', () => {
  // Rich /event/eventinfo shape ({ events }) — carries userName + companyName.
  const rich = normalizeStopEvents({ events: [
    { eventCode: '7000', eventName: 'Stop Planned', eventDTTM: '2026-06-23T04:36:00', userName: 'Zach Johnston', companyName: 'DAVIS DELIVERY', routeName: 'MITCHELL' },
    { eventCode: '7008', eventName: 'Stop Departure', eventDTTM: '2026-06-24T10:01:00', userName: 'Aaron Mitchell', companyName: 'DAVIS DELIVERY' },
  ] });
  assert.equal(rich.length, 2);
  assert.equal(rich[0].name, 'Stop Departure', 'newest event first');
  assert.equal(rich[0].user, 'Aaron Mitchell');
  assert.equal(rich[1].company, 'DAVIS DELIVERY');
  // Lean /stop/eventinfo shape ({ stopEvents }) — no user/company.
  const lean = normalizeStopEvents({ stopEvents: [
    { eventCode: '7000', eventName: 'Stop Planned', eventDTTM: '2026-06-23T04:36:00' },
  ] });
  assert.equal(lean.length, 1);
  assert.equal(lean[0].user, null);
  assert.equal(lean[0].name, 'Stop Planned');
  // Junk → empty.
  assert.deepEqual(normalizeStopEvents({}), []);
  assert.deepEqual(normalizeStopEvents(null), []);
});

// POD docs: NuVizz hangs proof-of-delivery doc metadata off stopExecutionInfo.to.podDoc[]
// (a delivery's docs are on `to`). normalizeStop surfaces it as podDocs[].
test('normalizeStop surfaces POD document metadata from exec.to.podDoc (delivered stop)', () => {
  const raw = doStop({ stopNbr: '007137806', toSeq: 1, loadStopSeq: 0, eta: '2026-06-24T14:00:00' });
  raw.stopExecutionInfo.stopStatus = '90';
  raw.stopExecutionInfo.to.podDoc = [
    { documentName: 'Cumberland Mall Delivery', documentGuid: 'guid-1', documentPath: '/documents/pod-1.pdf', extension: 'pdf', createdTime: '2026-06-24T14:41:00' },
    { documentName: 'Signature', documentGuid: 'guid-2', documentPath: 'https://cdn.nuvizz.com/pod-2.jpg', extension: 'jpg', createdTime: '2026-06-24T14:42:00' },
  ];
  const n = normalizeStop(raw);
  assert.equal(n.podDocs.length, 2);
  assert.equal(n.podDocs[0].documentGuid, 'guid-1');
  assert.equal(n.podDocs[0].extension, 'pdf');
  assert.equal(n.podDocs[1].documentPath, 'https://cdn.nuvizz.com/pod-2.jpg');
});

test('normalizeStop: podDocs is an empty array when no POD captured yet (pre-delivery)', () => {
  const n = normalizeStop(doStop({ stopNbr: '007137806', toSeq: 1, loadStopSeq: 0, eta: null }));
  assert.deepEqual(n.podDocs, []);
});
