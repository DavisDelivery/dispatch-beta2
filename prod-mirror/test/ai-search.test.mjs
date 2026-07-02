// M6 — unit tests for the AI Order Search pure helpers. These import the SAME
// functions App.jsx ships (no copies), proving the parse-spec evaluation, the
// TrimmedStop projection, and the summary text the chip renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKeyFromToken, restrictionsForStop, closedDayLabels, hoursSummary, to12h,
  buildTrimmedStop, buildTrimmedStops, applyFilterSpec, summarizeSpec,
} from '../src/lib/ai-search.js';

// ── fixtures ──
const stops = [
  { stopNbr: '001', matchKey: 'k1', businessName: 'Acme Marietta', addr1: '1 A St', city: 'Marietta', state: 'GA', zip: '30060', lat: 1, lng: 2 },
  { stopNbr: '002', matchKey: 'k2', businessName: 'Bolt Atlanta', addr1: '2 B St', city: 'Atlanta', state: 'GA', zip: '30303', lat: 3, lng: 4 },
  { stopNbr: '003', matchKey: 'k3', businessName: 'Crane Marietta', addr1: '3 C St', city: 'Marietta', state: 'GA', zip: '30062', lat: 5, lng: 6 },
];
const notes = new Map([
  ['k1', {
    closed_days: ['fri'],
    receiving_hours: { mon: { open: '08:00', close: '16:00' }, fri: { open: '07:00', close: '11:00' } },
    equipment_restrictions: ['no_tractor_trailer'], liftgate_required: true,
    priority_flag: 'red', dock_notes: 'Tight dock, call ahead',
  }],
  ['k2', {
    closed_days: [],
    receiving_hours: { mon: { open: '10:00', close: '18:00' } },
    equipment_restrictions: ['straight_truck_only'], appointment_required: true,
    priority_flag: null, dock_notes: 'Liftgate at rear',
  }],
  // k3 intentionally absent → exercises the no-note path.
]);

test('dayKeyFromToken normalizes weekday words', () => {
  assert.equal(dayKeyFromToken('Friday'), 'fri');
  assert.equal(dayKeyFromToken('Fri'), 'fri');
  assert.equal(dayKeyFromToken('MON'), 'mon');
  assert.equal(dayKeyFromToken('nope'), null);
});

test('restrictionsForStop expands flags and aliases', () => {
  assert.deepEqual(restrictionsForStop(notes.get('k1')), ['no_tractor_trailer', 'liftgate']);
  // straight_truck_only → box_truck_only alias; appointment flag surfaced
  assert.deepEqual(restrictionsForStop(notes.get('k2')), ['box_truck_only', 'appointment_required']);
  assert.deepEqual(restrictionsForStop(undefined), []);
});

test('closedDayLabels + hoursSummary render human strings (AM/PM)', () => {
  assert.deepEqual(closedDayLabels(notes.get('k1')), ['Fri']);
  assert.equal(hoursSummary(notes.get('k1')), 'Mon 8:00 AM–4:00 PM · Fri 7:00 AM–11:00 AM');
  assert.equal(hoursSummary(notes.get('k3')), '');
});

test('to12h formats 24h clock as AM/PM', () => {
  assert.equal(to12h('08:00'), '8:00 AM');
  assert.equal(to12h('15:30'), '3:30 PM');
  assert.equal(to12h('00:00'), '12:00 AM');
  assert.equal(to12h('12:00'), '12:00 PM');
  assert.equal(to12h(''), '');
});

test('buildTrimmedStop projects the compact shape incl. free-text notes', () => {
  const t = buildTrimmedStop(stops[0], notes.get('k1'));
  assert.equal(t.pro, '001');
  assert.equal(t.business, 'Acme Marietta');
  assert.equal(t.zip5, '30060');
  assert.deepEqual(t.closed_days, ['Fri']);
  assert.deepEqual(t.restrictions, ['no_tractor_trailer', 'liftgate']);
  assert.equal(t.priority_flag, 'red');
  assert.equal(t.dock_notes, 'Tight dock, call ahead');
  assert.equal(t.appointment_notes, ''); // present in shape even when empty
  assert.equal(t.instructions, '');      // no raw instructions on this fixture
});

test('buildTrimmedStop surfaces raw NuVizz instructions (any-format hours)', () => {
  const stop = {
    stopNbr: '7133391', matchKey: 'z', businessName: 'Uline Dock', city: 'Suwanee',
    signalSources: { orderInstructions: 'RECEIVING HOURS 8AM-12PM, DO NOT BREAKDOWN SKID' },
    addr2: 'liftgate',
  };
  const t = buildTrimmedStop(stop, undefined);
  assert.ok(t.instructions.includes('RECEIVING HOURS 8AM-12PM'));
  assert.ok(t.instructions.includes('liftgate'));
});

test('buildTrimmedStops caps and reports truncation', () => {
  const r = buildTrimmedStops(stops, notes, 2);
  assert.equal(r.sent, 2);
  assert.equal(r.total, 3);
  assert.equal(r.truncated, true);
  const r2 = buildTrimmedStops(stops, notes, 400);
  assert.equal(r2.truncated, false);
});

test('applyFilterSpec: closed_days includes Fri', () => {
  const set = applyFilterSpec(stops, notes, { predicates: [{ field: 'closed_days', op: 'includes', value: 'Fri' }], logic: 'AND' });
  assert.deepEqual([...set], ['001']);
});

test('applyFilterSpec: receiving_open <= 09:00 matches early openers on any day', () => {
  const set = applyFilterSpec(stops, notes, { predicates: [{ field: 'receiving_open', op: '<=', value: '09:00' }], logic: 'AND' });
  assert.deepEqual([...set], ['001']); // k1 opens 07:00 Fri / 08:00 Mon; k2 opens 10:00
});

test('applyFilterSpec: restriction alias + AND logic', () => {
  // straight_truck_only query resolves to box_truck_only → matches k2
  const set = applyFilterSpec(stops, notes, { predicates: [{ field: 'restrictions', op: 'includes', value: 'straight_truck_only' }], logic: 'AND' });
  assert.deepEqual([...set], ['002']);
});

test('applyFilterSpec: city + restriction AND narrows correctly', () => {
  const set = applyFilterSpec(stops, notes, {
    predicates: [
      { field: 'city', op: 'includes', value: 'Marietta' },
      { field: 'restrictions', op: 'includes', value: 'liftgate' },
    ],
    logic: 'AND',
  });
  assert.deepEqual([...set], ['001']); // Crane Marietta has no liftgate
});

test('applyFilterSpec: text_match over business + dock_notes', () => {
  const set = applyFilterSpec(stops, notes, { predicates: [], text_match: 'liftgate', logic: 'AND' });
  assert.deepEqual([...set], ['002']); // k2 dock_notes mentions liftgate
});

test('applyFilterSpec: OR logic unions predicate and text', () => {
  const set = applyFilterSpec(stops, notes, {
    predicates: [{ field: 'priority_flag', op: '==', value: 'red' }],
    text_match: 'Bolt',
    logic: 'OR',
  });
  assert.deepEqual([...set].sort(), ['001', '002']);
});

test('applyFilterSpec: empty spec matches nothing (caller falls back)', () => {
  assert.equal(applyFilterSpec(stops, notes, { predicates: [], text_match: '', logic: 'AND' }).size, 0);
  assert.equal(applyFilterSpec(stops, notes, null).size, 0);
});

test('tractor_trailer_friendly: aliases resolve in restrictionsForStop', () => {
  assert.deepEqual(restrictionsForStop({ equipment_restrictions: ['tt_friendly'] }), ['tractor_trailer_friendly']);
  assert.deepEqual(restrictionsForStop({ equipment_restrictions: ['semi_friendly'] }), ['tractor_trailer_friendly']);
  assert.deepEqual(restrictionsForStop({ equipment_restrictions: ['tractor_trailer_ok'] }), ['tractor_trailer_friendly']);
});

test('tractor_trailer_friendly: AI parse predicate matches via alias (M6 tie-in)', () => {
  const ttStops = [
    { stopNbr: 'A', matchKey: 'a', businessName: 'Big Dock', city: 'Acworth' },
    { stopNbr: 'B', matchKey: 'b', businessName: 'Small Dock', city: 'Acworth' },
  ];
  const ttNotes = new Map([
    ['a', { equipment_restrictions: ['tractor_trailer_friendly'] }],
    ['b', { equipment_restrictions: ['no_tractor_trailer'] }],
  ]);
  // model may emit the canonical kind or an alias; both resolve
  const canon = applyFilterSpec(ttStops, ttNotes, { predicates: [{ field: 'restrictions', op: 'includes', value: 'tractor_trailer_friendly' }], logic: 'AND' });
  assert.deepEqual([...canon], ['A']);
  const alias = applyFilterSpec(ttStops, ttNotes, { predicates: [{ field: 'restrictions', op: 'includes', value: 'semi_friendly' }], logic: 'AND' });
  assert.deepEqual([...alias], ['A']);
});

test('summarizeSpec composes a one-line chip', () => {
  const s = summarizeSpec({ predicates: [
    { field: 'closed_days', value: 'Fri' },
    { field: 'restrictions', value: 'liftgate' },
  ], text_match: '' }, 12);
  assert.equal(s, '12 stops · closed Fri · liftgate');
  assert.equal(summarizeSpec({ predicates: [], text_match: 'acme' }, 1), '1 stop · "acme"');
});
