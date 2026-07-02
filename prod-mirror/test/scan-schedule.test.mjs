// test/scan-schedule.test.mjs — elapsed-time scan cadence + feed windows.
// Regression for DEFECT 1 (wall-clock-minute gate no-op'd jittered */15 fires)
// and DEFECT 2 (tomorrow's orders were never descended).
import test from 'node:test';
import assert from 'node:assert/strict';

import { scanDecision, intervalForHour, nowET, isInRoutingWindow, isWeekendBlackout } from '../netlify/functions/lib/scan-schedule.mts';

test('isInRoutingWindow: overnight 20:00–07:00 ET wraps midnight', () => {
  for (const h of [20, 21, 23, 0, 3, 6]) assert.equal(isInRoutingWindow(h), true, `hour ${h} should be IN window`);
  for (const h of [7, 9, 12, 15, 19]) assert.equal(isInRoutingWindow(h), false, `hour ${h} should be OUT of window`);
});

// 2026-06-17 is EDT (UTC-4). Build a Date at a given ET hour/min.
const at = (etHour, etMin = 0) => new Date(Date.UTC(2026, 5, 17, etHour + 4, etMin, 0));
const ago = (now, min) => new Date(now.getTime() - min * 60000).toISOString();

test('test harness maps ET hours correctly (EDT UTC-4)', () => {
  assert.equal(nowET(at(14, 3)).hour, 14);
  assert.equal(nowET(at(21)).hour, 21);
  assert.equal(nowET(at(0)).hour, 0);
});

test('intervalForHour: 30 for 4am-1pm, 60 otherwise', () => {
  assert.equal(intervalForHour(5), 30);  // 4-7am lowered from 15 → 30
  assert.equal(intervalForHour(9), 30);
  assert.equal(intervalForHour(14), 60);
  assert.equal(intervalForHour(2), 60);  // overnight
  assert.equal(intervalForHour(0), 60);
});

test('DEFECT 1 fixed: a jittered :03 fire scans when the interval has elapsed', () => {
  const now = at(14, 3);                         // 2:03pm ET — old minute===0 gate would no-op
  const d = scanDecision(now, false, ago(now, 58)); // 58 min since last load scan
  assert.equal(d.act, true);
  assert.equal(d.intervalMin, 60);
  assert.equal(d.skip, 'none');
});

test('cadence skip when not enough elapsed; floor skip when too soon', () => {
  const now = at(14, 3);
  assert.equal(scanDecision(now, false, ago(now, 20)).skip, 'cadence'); // 20 < 60-7
  const f = scanDecision(now, false, ago(now, 5));                      // 5 < 10 floor
  assert.equal(f.act, false);
  assert.equal(f.skip, 'floor');
});

test('never-scanned (null) always acts (elapsed=Infinity)', () => {
  const now = at(14, 3);
  const d = scanDecision(now, false, null);
  assert.equal(d.act, true);
  assert.equal(d.elapsedMin, Infinity);
});

test('cadence by window: 30-min across 4am-1pm (4-7am lowered from 15m)', () => {
  const m = at(9, 7);
  assert.equal(scanDecision(m, false, ago(m, 24)).act, true);   // 24 >= 30-7
  assert.equal(scanDecision(m, false, ago(m, 20)).act, false);  // 20 < 23
  const e = at(5, 2);                                            // 5am ET — now 30m, not 15m
  assert.equal(scanDecision(e, false, ago(e, 30)).act, true);   // 30 >= 30-7
  assert.equal(scanDecision(e, false, ago(e, 20)).skip, 'cadence'); // 20 < 23 (acted under old 15m)
  assert.equal(scanDecision(e, false, ago(e, 9)).skip, 'floor');    // 9 < 10 floor
});

test('DEFECT 2 fixed: tomorrow orders descend 10am-midnight; loads only 8pm-midnight', () => {
  const two = scanDecision(at(14), false, ago(at(14), 90));   // 2pm
  assert.equal(two.scanTodayUnplanned, true);
  assert.equal(two.scanTomorrowUnplanned, true, 'tomorrow orders scan at 2pm');
  assert.equal(two.scanTomorrowLoads, false, 'tomorrow loads not yet (pre-8pm)');

  const nine = scanDecision(at(21), false, ago(at(21), 90));  // 9pm
  assert.equal(nine.scanTomorrowLoads, true);
  assert.equal(nine.scanTomorrowUnplanned, true);
});

test('before 10am: acts on loads but no order descent for either day', () => {
  const d = scanDecision(at(9), false, ago(at(9), 90));
  assert.equal(d.act, true);
  assert.equal(d.scanTodayUnplanned, false);
  assert.equal(d.scanTomorrowUnplanned, false);
  assert.equal(d.scanTomorrowLoads, false);
});

test('manual: always acts, full scan, floor bypassed', () => {
  const now = at(2);                              // 2am overnight
  const d = scanDecision(now, true, ago(now, 1)); // 1 min ago → would floor-skip if scheduled
  assert.equal(d.act, true);
  assert.equal(d.scanTodayUnplanned, true);
  assert.equal(d.scanTomorrowLoads, true);
  assert.equal(d.scanTomorrowUnplanned, true);
  assert.equal(d.reason, 'manual');
});

// ── Weekend blackout: Fri 23:00 ET → Sun 19:00 ET, no scheduled scans ──
// June 2026 ET dates: 19=Fri, 20=Sat, 21=Sun, 22=Mon. Build a Date at an ET
// hour on a chosen day-of-month (EDT, UTC-4).
const dayAt = (dom, etHour, etMin = 0) => new Date(Date.UTC(2026, 5, dom, etHour + 4, etMin, 0));

test('nowET reports the ET weekday (0=Sun..6=Sat)', () => {
  assert.equal(nowET(dayAt(19, 12)).weekday, 5, 'Jun 19 2026 = Friday');
  assert.equal(nowET(dayAt(20, 12)).weekday, 6, 'Jun 20 2026 = Saturday');
  assert.equal(nowET(dayAt(21, 12)).weekday, 0, 'Jun 21 2026 = Sunday');
  assert.equal(nowET(dayAt(22, 12)).weekday, 1, 'Jun 22 2026 = Monday');
  // A late-Friday-night UTC instant is still Friday in ET (the weekday must be ET-local).
  assert.equal(nowET(dayAt(19, 23)).weekday, 5);
});

test('isWeekendBlackout: Fri 23:00 → Sun 19:00 ET', () => {
  // Friday: open until 22:59, blacked out from 23:00 (extended an hour later).
  assert.equal(isWeekendBlackout(5, 21), false);
  assert.equal(isWeekendBlackout(5, 22), false);
  assert.equal(isWeekendBlackout(5, 23), true);
  // Saturday: all day.
  for (const h of [0, 8, 12, 20, 23]) assert.equal(isWeekendBlackout(6, h), true, `Sat ${h}`);
  // Sunday: blacked out until 18:59, open from 19:00 (Monday prep starts an hour earlier).
  assert.equal(isWeekendBlackout(0, 0), true);
  assert.equal(isWeekendBlackout(0, 18), true);
  assert.equal(isWeekendBlackout(0, 19), false);
  // Weekdays: never blacked out.
  for (const wd of [1, 2, 3, 4]) for (const h of [0, 10, 22]) assert.equal(isWeekendBlackout(wd, h), false, `wd${wd} ${h}`);
});

test('scheduled scans are skipped during the weekend blackout', () => {
  const sat = dayAt(20, 12);                       // Saturday noon
  const d = scanDecision(sat, false, ago(sat, 600)); // plenty of elapsed time
  assert.equal(d.act, false);
  assert.equal(d.skip, 'weekend');
  // Fri 23:00 and Sun 18:00 are blacked out; Fri 22:00 and Sun 19:00 are not.
  assert.equal(scanDecision(dayAt(19, 23), false, ago(dayAt(19, 23), 600)).act, false);
  assert.equal(scanDecision(dayAt(21, 18), false, ago(dayAt(21, 18), 600)).act, false);
  assert.equal(scanDecision(dayAt(19, 22), false, ago(dayAt(19, 22), 600)).act, true, 'Fri 22:00 still scans');
  assert.equal(scanDecision(dayAt(21, 19), false, ago(dayAt(21, 19), 600)).act, true, 'Sun 19:00 resumes');
});

test('a MANUAL scan bypasses the weekend blackout', () => {
  const sat = dayAt(20, 12);
  const d = scanDecision(sat, true, ago(sat, 1));
  assert.equal(d.act, true);
  assert.equal(d.reason, 'manual');
});

test('blackout keys off ET weekday, not UTC: Fri 23:00 ET (= Sat UTC) still blacks out', () => {
  // Fri 23:00 EDT is Sat 03:00 UTC — must be treated as Friday-night blackout.
  const d = scanDecision(dayAt(19, 23), false, ago(dayAt(19, 23), 600));
  assert.equal(d.act, false);
  assert.equal(d.skip, 'weekend');
  assert.equal(d.etHour, 23);
});

test('Sunday 20:00 resume selects the Monday-prep feeds', () => {
  const d = scanDecision(dayAt(21, 20), false, ago(dayAt(21, 20), 600));
  assert.equal(d.act, true);
  assert.equal(d.skip, 'none');
  assert.equal(d.scanTodayUnplanned, true);     // Sunday's incoming orders
  assert.equal(d.scanTomorrowLoads, true);       // Monday's loads (exist after 8pm)
  assert.equal(d.scanTomorrowUnplanned, true);   // Monday's incoming orders
});
