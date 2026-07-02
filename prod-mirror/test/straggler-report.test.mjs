// test/straggler-report.test.mjs — Phase 5 undelivered/late/aged report + 91-vs-90.
import test from 'node:test';
import assert from 'node:assert/strict';

import { completionKind, summarizeCompletions, buildUndeliveredReport } from '../netlify/functions/lib/straggler-report.mts';

const stop = (stopNbr, status, date, extra = {}) => ({ stopNbr, status, date, isPlanned: true, routeName: extra.route ?? 'R1', driverName: extra.driver ?? 'D1', loadNbr: extra.loadNbr ?? 'L1', businessName: extra.name ?? 'Cust', ...extra });

test('completionKind: 91=manual, 90=system, else null (also reads executed.stopStatus)', () => {
  assert.equal(completionKind({ status: '91' }), '91');
  assert.equal(completionKind({ status: '90' }), '90');
  assert.equal(completionKind({ status: '10' }), null);
  assert.equal(completionKind({ executed: { stopStatus: '91' } }), '91');
  assert.equal(completionKind({}), null);
});

test('completionKind: a code-less delivery (deliveredDTTM / normalizedStatus) counts as system 90', () => {
  // status code lags but a real delivery timestamp is present → delivered (system).
  assert.equal(completionKind({ status: '40', deliveredDTTM: '2026-07-10T18:00:00Z' }), '90');
  assert.equal(completionKind({ executed: { deliveredDTTM: '2026-07-10T18:00:00Z' } }), '90');
  assert.equal(completionKind({ status: '50', normalizedStatus: 'DELIVERED' }), '90');
  // an explicit 91 still wins over a bare timestamp.
  assert.equal(completionKind({ status: '91', deliveredDTTM: '2026-07-10T18:00:00Z' }), '91');
  // padded codes are trimmed, to parity with classifyStopStatus.
  assert.equal(completionKind({ status: ' 91 ' }), '91');
  assert.equal(completionKind({ status: '90 ' }), '90');
  // genuinely open: no code, no timestamp, not normalized delivered.
  assert.equal(completionKind({ status: '10', normalizedStatus: 'EN_ROUTE' }), null);
});

test('report: same-day delivery on the window OLDEST edge is indeterminate, not on-time', () => {
  // PRO 950 first/only appears on the oldest read day and is delivered same-day — its
  // open origin could predate the window, so it can't be confirmed on-time.
  const days = {
    '2026-07-06': [stop('950', '90', '2026-07-06')],            // oldest edge, same-day delivered
    '2026-07-08': [stop('951', '10', '2026-07-08'), stop('951', '90', '2026-07-08')], // mid-window same-day
  };
  const r = buildUndeliveredReport(days, { today: '2026-07-13', windowDays: 7 });
  assert.deepEqual(r.indeterminate.map((x) => x.stopNbr), ['950']);
  assert.equal(r.indeterminate[0].kind, 'system');
  assert.equal(r.indeterminate[0].deliveredDate, '2026-07-06');
  // 951 delivered same-day strictly inside the window (we saw it open first) → on-time, excluded everywhere.
  assert.equal(r.deliveredLate.length, 0);
  assert.equal(r.open.length, 0);
  assert.ok(!r.indeterminate.some((x) => x.stopNbr === '951'));
});

test('report: a genuinely-late delivery is NOT downgraded to indeterminate even at the edge', () => {
  const days = {
    '2026-07-06': [stop('960', '10', '2026-07-06')],            // open on the oldest edge
    '2026-07-09': [stop('960', '91', '2026-07-09')],            // delivered 3 days later
  };
  const r = buildUndeliveredReport(days, { today: '2026-07-13', windowDays: 7 });
  assert.equal(r.deliveredLate.length, 1);
  assert.equal(r.deliveredLate[0].daysLate, 3);
  assert.equal(r.indeterminate.length, 0);
});

test('summarizeCompletions: overall + per-route 91-rate', () => {
  const s = summarizeCompletions([
    stop('1', '90', 'd', { route: 'A' }), stop('2', '91', 'd', { route: 'A' }),
    stop('3', '91', 'd', { route: 'B' }), stop('4', '10', 'd', { route: 'B' }), // open, ignored
  ]);
  assert.equal(s.delivered, 3);
  assert.equal(s.system90, 1);
  assert.equal(s.manual91, 2);
  assert.ok(Math.abs(s.manualRate - 2 / 3) < 1e-9);
  const a = s.byRoute.find((r) => r.route === 'A'); const b = s.byRoute.find((r) => r.route === 'B');
  assert.equal(a.delivered, 2); assert.ok(Math.abs(a.manualRate - 0.5) < 1e-9);
  assert.equal(b.manual91, 1); assert.ok(Math.abs(b.manualRate - 1) < 1e-9, 'route B 100% manual');
});

test('report: delivered-late = terminal on a LATER day than scheduled (rolled PRO)', () => {
  const days = {
    '2026-07-10': [stop('700', '10', '2026-07-10')],            // open on its day
    '2026-07-12': [stop('700', '91', '2026-07-12')],            // delivered (manual) 2 days later
  };
  const r = buildUndeliveredReport(days, { today: '2026-07-13', windowDays: 7 });
  assert.equal(r.deliveredLate.length, 1);
  assert.equal(r.deliveredLate[0].stopNbr, '700');
  assert.equal(r.deliveredLate[0].daysLate, 2);
  assert.equal(r.deliveredLate[0].kind, 'manual');
  assert.equal(r.open.length, 0);
  assert.equal(r.agedOut.length, 0);
});

test('report: same-day delivery is on-time (excluded from late)', () => {
  const r = buildUndeliveredReport({ '2026-07-10': [stop('1', '90', '2026-07-10')] }, { today: '2026-07-11' });
  assert.equal(r.deliveredLate.length, 0);
  assert.equal(r.open.length, 0);
});

test('report: open (within window) vs aged-out (>= windowDays, never terminal)', () => {
  const days = {
    '2026-07-12': [stop('800', '10', '2026-07-12')], // 1 day ago → open
    '2026-07-02': [stop('801', '10', '2026-07-02')], // 11 days ago, never terminal → aged-out
  };
  const r = buildUndeliveredReport(days, { today: '2026-07-13', windowDays: 7 });
  assert.deepEqual(r.open.map((o) => o.stopNbr), ['800']);
  assert.equal(r.open[0].openDays, 1);
  assert.deepEqual(r.agedOut.map((o) => o.stopNbr), ['801']);
  assert.equal(r.agedOut[0].ageDays, 11);
});

test('report: a PRO appearing terminal across days is counted once; completions span all days', () => {
  const days = {
    '2026-07-10': [stop('900', '10', '2026-07-10', { route: 'X' }), stop('901', '90', '2026-07-10', { route: 'X' })],
    '2026-07-11': [stop('900', '91', '2026-07-11', { route: 'X' })],
  };
  const r = buildUndeliveredReport(days, { today: '2026-07-12', windowDays: 7 });
  assert.equal(r.deliveredLate.length, 1, '900 delivered late once');
  assert.equal(r.completions.delivered, 2, '901 (90) + 900 (91)');
  assert.equal(r.completions.manual91, 1);
  assert.equal(r.completions.system90, 1);
});
