// Closed-day detection from NuVizz order instructions — the Uline "CLOSED ON
// FRIDAYS" format (optional "ON", optional plural "S") plus the legacy forms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanStopFull } from '../src/lib/signal-scanner.ts';

const days = (instr) => scanStopFull({ signalSources: { orderInstructions: instr } }).closedDays.map((c) => c.day).sort();

test('Uline format "CLOSED ON FRIDAYS" → fri', () => {
  assert.deepEqual(days('CLOSED ON FRIDAYS'), ['fri']);
});

test('Uline format with trailing total line (the real screenshot text) → fri', () => {
  assert.deepEqual(days('CLOSED ON FRIDAYS\nTOTAL-AMOUNT : 129.79'), ['fri']);
});

test('"CLOSED ON MONDAYS" → mon', () => {
  assert.deepEqual(days('CLOSED ON MONDAYS'), ['mon']);
});

test('both Mondays and Fridays in one note', () => {
  assert.deepEqual(days('STORE CLOSED ON MONDAYS AND CLOSED ON FRIDAYS'), ['fri', 'mon']);
});

test('legacy forms still match: "CLOSED FRIDAY", "NO FRIDAY", "FRIDAY CLOSED"', () => {
  assert.deepEqual(days('CLOSED FRIDAY'), ['fri']);
  assert.deepEqual(days('NO FRIDAY DELIVERIES'), ['fri']);
  assert.deepEqual(days('FRIDAY CLOSED'), ['fri']);
});

test('singular + ON: "CLOSED ON FRIDAY"; plural without ON: "CLOSED FRIDAYS"', () => {
  assert.deepEqual(days('CLOSED ON FRIDAY'), ['fri']);
  assert.deepEqual(days('CLOSED FRIDAYS'), ['fri']);
});

test('all seven days resolve from the "CLOSED ON <day>S" form', () => {
  assert.deepEqual(days('CLOSED ON MONDAYS'), ['mon']);
  assert.deepEqual(days('CLOSED ON TUESDAYS'), ['tue']);
  assert.deepEqual(days('CLOSED ON WEDNESDAYS'), ['wed']);
  assert.deepEqual(days('CLOSED ON THURSDAYS'), ['thu']);
  assert.deepEqual(days('CLOSED ON SATURDAYS'), ['sat']);
  assert.deepEqual(days('CLOSED ON SUNDAYS'), ['sun']);
});

test('no false positives: a plain total/instruction line flags nothing', () => {
  assert.deepEqual(days('TOTAL-AMOUNT : 129.79'), []);
  assert.deepEqual(days('LIFTGATE REQUIRED'), []);
  assert.deepEqual(days(''), []);
});

test('addressLine2 source also detected (curated field)', () => {
  const r = scanStopFull({ signalSources: { addressLine2: 'STE 5 — CLOSED ON FRIDAYS' } });
  assert.deepEqual(r.closedDays.map((c) => c.day), ['fri']);
});
