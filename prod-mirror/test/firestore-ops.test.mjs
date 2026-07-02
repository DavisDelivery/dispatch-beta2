// test/firestore-ops.test.mjs — regression guards for the two I/O behaviors the
// audit flagged as untested: the call-counter merge SHAPE (the runaway "stuck at 1"
// bug) and the day-scoped circuit-breaker expiry. Both are exercised via the pure
// helpers buildCounterCommitBody / routeFieldKey / circuitFromDoc.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCounterCommitBody, routeFieldKey, hourFieldKey, attrFieldKey, etHourString, circuitFromDoc } from '../netlify/functions/lib/firestore.mts';

const DOC = 'projects/p/databases/(default)/documents/nuvizz_ops/calls__2026-06-18';

test('counter body MERGES via updateMask:[date] and never overwrites count (the stuck-at-1 fix)', () => {
  const body = buildCounterCommitBody(DOC, '2026-06-18', 1);
  const w = body.writes[0];
  // The update must carry ONLY `date` and an updateMask scoped to it — otherwise the
  // commit replaces the whole doc and wipes the accumulated count.
  assert.deepEqual(w.updateMask, { fieldPaths: ['date'] });
  assert.deepEqual(Object.keys(w.update.fields), ['date']);
  assert.equal(w.update.fields.date.stringValue, '2026-06-18');
  // count must NOT be a plain field (that would overwrite); it rides as a transform.
  assert.ok(!('count' in w.update.fields));
});

test('counter body: count is transform[0] and increments by n', () => {
  const body = buildCounterCommitBody(DOC, '2026-06-18', 5);
  const t = body.writes[0].updateTransforms;
  assert.equal(t[0].fieldPath, 'count');
  assert.equal(t[0].increment.integerValue, '5');
  assert.equal(t.length, 1, 'no per-route transform when route omitted');
});

test('counter body: a route adds a count__<route> transform without disturbing count', () => {
  const body = buildCounterCommitBody(DOC, '2026-06-18', 1, '/load/info');
  const t = body.writes[0].updateTransforms;
  assert.equal(t[0].fieldPath, 'count', 'total stays transform[0] (authoritative readback)');
  assert.equal(t[1].fieldPath, 'count__load_info');
  assert.equal(t[1].increment.integerValue, '1');
});

test('counter body: an hour bucket rides AFTER count/route so count stays transform[0]', () => {
  // route + hour together: count[0], count__route[1], hour__HH[2].
  const withRoute = buildCounterCommitBody(DOC, '2026-06-18', 1, '/load/info', '10');
  const t = withRoute.writes[0].updateTransforms;
  assert.equal(t[0].fieldPath, 'count', 'total stays transform[0]');
  assert.equal(t[1].fieldPath, 'count__load_info');
  assert.equal(t[2].fieldPath, 'hour__10', 'hour bucket appended last');
  assert.equal(t[2].increment.integerValue, '1');
  // hour with NO route: count[0], hour__HH[1] (no per-route transform).
  const noRoute = buildCounterCommitBody(DOC, '2026-06-18', 3, undefined, '14');
  const t2 = noRoute.writes[0].updateTransforms;
  assert.equal(t2.length, 2);
  assert.equal(t2[1].fieldPath, 'hour__14');
  assert.equal(t2[1].increment.integerValue, '3');
});

test('hourFieldKey: only a valid 00–23 hour becomes hour__HH (no field-path injection)', () => {
  assert.equal(hourFieldKey('00'), 'hour__00');
  assert.equal(hourFieldKey('10'), 'hour__10');
  assert.equal(hourFieldKey('23'), 'hour__23');
  assert.equal(hourFieldKey('24'), null, 'out of 0–23 range rejected');
  assert.equal(hourFieldKey('9'), null, 'must be two digits');
  assert.equal(hourFieldKey('1a'), null);
  assert.equal(hourFieldKey(''), null);
  assert.equal(hourFieldKey(null), null);
});

test('etHourString: emits a zero-padded ET hour (EDT offset, deterministic)', () => {
  // 2026-06-23 17:30 UTC → 13:30 America/New_York (EDT, UTC-4).
  assert.equal(etHourString(new Date('2026-06-23T17:30:00Z')), '13');
  // Just after ET midnight: 2026-06-23 04:30 UTC → 00:30 EDT.
  assert.equal(etHourString(new Date('2026-06-23T04:30:00Z')), '00');
});

test('routeFieldKey: never aliases onto count, never injects a field path', () => {
  // A route literally named "count" cannot collide with the authoritative total.
  assert.equal(routeFieldKey('count'), 'count__count');
  // Slashes / dots / spaces collapse to _ so no nested-path injection is possible.
  assert.equal(routeFieldKey('/stop/info'), 'count__stop_info');
  assert.equal(routeFieldKey('a.b c'), 'count__a_b_c');
  assert.equal(routeFieldKey(''), null);
  assert.equal(routeFieldKey(null), null);
});

test('attrFieldKey: prefixes per dimension + sanitizes (no field-path injection, no count alias)', () => {
  assert.equal(attrFieldKey('app', 'dispatch-map'), 'app__dispatch_map');
  assert.equal(attrFieldKey('trig', 'scheduled-scan'), 'trig__scheduled_scan');
  assert.equal(attrFieldKey('src', 'board-list'), 'src__board_list');
  assert.equal(attrFieldKey('ten', 'DAVIS'), 'ten__davis');
  // slashes/dots/spaces collapse so no nested-path injection
  assert.equal(attrFieldKey('trig', 'a.b/c d'), 'trig__a_b_c_d');
  assert.equal(attrFieldKey('app', ''), null);
  assert.equal(attrFieldKey('app', null), null);
});

test('counter body: attribution buckets ride AFTER count/route/hour (count stays transform[0])', () => {
  const body = buildCounterCommitBody(DOC, '2026-06-18', 1, '/stop/info', '10', {
    app: 'dispatch-map', trigger: 'enrichment', source: 'board-list', tenant: 'DAVIS',
  });
  const t = body.writes[0].updateTransforms;
  assert.equal(t[0].fieldPath, 'count', 'total stays transform[0] (authoritative readback)');
  assert.equal(t[1].fieldPath, 'count__stop_info');
  assert.equal(t[2].fieldPath, 'hour__10');
  const after = t.slice(3).map((x) => x.fieldPath);
  assert.deepEqual(after, ['app__dispatch_map', 'trig__enrichment', 'src__board_list', 'ten__davis']);
  for (const x of t.slice(3)) assert.equal(x.increment.integerValue, '1');
});

test('counter body: no attribution → no extra transforms (backward compatible)', () => {
  const body = buildCounterCommitBody(DOC, '2026-06-18', 1, '/stop/info', '10');
  const t = body.writes[0].updateTransforms;
  assert.equal(t.length, 3, 'count + route + hour only when attr omitted');
  // partial attribution: only the present dimensions add transforms
  const partial = buildCounterCommitBody(DOC, '2026-06-18', 1, undefined, undefined, { app: 'parent' });
  const pt = partial.writes[0].updateTransforms;
  assert.equal(pt[0].fieldPath, 'count');
  assert.deepEqual(pt.slice(1).map((x) => x.fieldPath), ['app__parent']);
});

test('circuitFromDoc: a flag tripped YESTERDAY reads CLOSED today (day-scoped expiry)', () => {
  const doc = { open: true, reason: 'ceiling', at: '2026-06-17T23:59:00Z', day: '2026-06-17' };
  assert.equal(circuitFromDoc(doc, '2026-06-18').open, false, 'stale prior-day trip must not halt today');
  // metadata is still surfaced for visibility.
  assert.equal(circuitFromDoc(doc, '2026-06-18').reason, 'ceiling');
});

test("circuitFromDoc: today's trip stays OPEN; missing/closed docs read CLOSED", () => {
  assert.equal(circuitFromDoc({ open: true, day: '2026-06-18' }, '2026-06-18').open, true);
  assert.equal(circuitFromDoc({ open: false, day: '2026-06-18' }, '2026-06-18').open, false);
  assert.equal(circuitFromDoc(null, '2026-06-18').open, false);
  assert.equal(circuitFromDoc({ open: true }, '2026-06-18').open, false, 'no day stamp → not today → closed');
});
