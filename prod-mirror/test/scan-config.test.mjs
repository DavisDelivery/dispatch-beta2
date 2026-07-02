// test/scan-config.test.mjs — the live-editable scan schedule (Diagnostics UI).
// Guards the SAFETY-critical pure helpers: untrusted input is clamped to bounds,
// an empty/missing config reproduces the proven defaults, and overrides actually
// change the cadence/window decisions the scanner makes.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampScanConfig, scanConfigDefaults, effectiveScanConfig, SCAN_CONFIG_BOUNDS,
  intervalForHour, isInRoutingWindow, isWeekendBlackout, scanDecision,
} from '../netlify/functions/lib/scan-schedule.mts';

test('clampScanConfig: clamps to safe bounds and drops junk (no vendor-hammering edits)', () => {
  const c = clampScanConfig({
    intervalDayMin: 1,        // below min 10 → clamp up
    intervalNightMin: 9999,   // above max 360 → clamp down
    dailyCeiling: 5,          // below min 100 → clamp up
    deepSweepHour: 30,        // above 23 → clamp to 23
    bogusKey: 'x',            // unknown → dropped
    routingWindowStart: '20', // numeric string → coerced
  });
  assert.equal(c.intervalDayMin, SCAN_CONFIG_BOUNDS.intervalDayMin[0]); // 10
  assert.equal(c.intervalNightMin, SCAN_CONFIG_BOUNDS.intervalNightMin[1]); // 360
  assert.equal(c.dailyCeiling, SCAN_CONFIG_BOUNDS.dailyCeiling[0]); // 100
  assert.equal(c.deepSweepHour, 23);
  assert.equal(c.routingWindowStart, 20);
  assert.ok(!('bogusKey' in c));
});

test('clampScanConfig: blanks/NaN are ignored; scansEnabled only when boolean', () => {
  const c = clampScanConfig({ intervalDayMin: '', deepSweepHours: 'abc', scansEnabled: 'false' });
  assert.deepEqual(c, {}, 'empty string, NaN, and non-boolean toggle all dropped');
  assert.equal(clampScanConfig({ scansEnabled: false }).scansEnabled, false);
  assert.equal(clampScanConfig({ scansEnabled: true }).scansEnabled, true);
});

test('clampScanConfig: a non-forward day band is rejected (falls back to default band)', () => {
  const c = clampScanConfig({ dayBandStartHour: 14, dayBandEndHour: 9 });
  assert.ok(!('dayBandStartHour' in c) && !('dayBandEndHour' in c), 'start>=end → both dropped');
});

test('scanConfigDefaults: reads env overrides (else the documented baseline)', () => {
  const d = scanConfigDefaults({ NUVIZZ_DEEP_SWEEP_HOURS: '24', NUVIZZ_DAILY_CEILING: '35000' });
  assert.equal(d.deepSweepHours, 24);
  assert.equal(d.dailyCeiling, 35000);
  assert.equal(d.intervalDayMin, 30);
  assert.equal(d.deepSweepHour, 13);
  assert.equal(d.scansEnabled, true);
  // Kill switch off via env.
  assert.equal(scanConfigDefaults({ NUVIZZ_SCANS_ENABLED: 'false' }).scansEnabled, false);
});

test('effectiveScanConfig: defaults overlaid with clamped stored overrides', () => {
  const eff = effectiveScanConfig({ intervalDayMin: 60, dailyCeiling: 1 /* clamps to 100 */ }, {});
  assert.equal(eff.intervalDayMin, 60, 'override wins');
  assert.equal(eff.intervalNightMin, 60, 'untouched field keeps default');
  assert.equal(eff.dailyCeiling, 100, 'stored value is clamped before overlay');
  // Empty/missing stored doc → exactly the defaults (proven behavior preserved).
  assert.deepEqual(effectiveScanConfig(null, {}), { ...scanConfigDefaults({}) });
});

test('intervalForHour: config bands override the hardcoded 30/60 (and default unchanged)', () => {
  // Default: 30m in 04–12:59, else 60m.
  assert.equal(intervalForHour(9), 30);
  assert.equal(intervalForHour(15), 60);
  // Override: day band 06–10 at 45m, nights at 120m.
  const cfg = { intervalDayMin: 45, intervalNightMin: 120, dayBandStartHour: 6, dayBandEndHour: 10 };
  assert.equal(intervalForHour(7, cfg), 45);
  assert.equal(intervalForHour(5, cfg), 120, 'before the configured day band → night cadence');
  assert.equal(intervalForHour(11, cfg), 120, 'after the configured day band → night cadence');
});

test('isInRoutingWindow / isWeekendBlackout: respect overrides, default when absent', () => {
  // Default wrapping window 20→7.
  assert.equal(isInRoutingWindow(22), true);
  assert.equal(isInRoutingWindow(12), false);
  // Override to a daytime window 8→17.
  assert.equal(isInRoutingWindow(12, { routingWindowStart: 8, routingWindowEnd: 17 }), true);
  assert.equal(isInRoutingWindow(22, { routingWindowStart: 8, routingWindowEnd: 17 }), false);
  // Blackout: Friday(5) from start hour; override start to 18.
  assert.equal(isWeekendBlackout(5, 22), false, 'default Fri start is 23 — 22:00 still scans');
  assert.equal(isWeekendBlackout(5, 22, { weekendBlackoutStart: 18 }), true);
});

test('scanDecision: a longer configured interval defers an otherwise-due fire', () => {
  const now = new Date('2026-06-23T15:00:00Z'); // 11:00 ET, weekday — default day band → 30m
  const last = '2026-06-23T14:20:00Z'; // 40 min earlier
  // Default 30m interval: 40min elapsed ≥ 30 → acts.
  assert.equal(scanDecision(now, false, last).act, true);
  // Configured 60m day interval: 40min < 60 → cadence skip.
  const d = scanDecision(now, false, last, { intervalDayMin: 60 });
  assert.equal(d.act, false);
  assert.equal(d.skip, 'cadence');
  assert.equal(d.intervalMin, 60);
});
