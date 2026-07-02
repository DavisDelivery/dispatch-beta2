// scan-schedule.mts
//
// Single source of truth for WHEN the NuVizz scan fires and WHICH feeds it scans.
// Used by both the scheduled background writer and the manual-scan endpoint so the
// cadence/gates can never drift between them. The cron stays */15 * * * *; all the
// scheduling intelligence is here, computed from ET local time (DST-robust).
//
// Lifecycle this encodes (all ET):
//   - Orders for a day arrive ~10am the DAY BEFORE (status-10 unplanned).
//   - They get planned onto loads starting ~8pm the day before.
//   - They're executed the NEXT day ~5am-7pm.
// So: today's board = TODAY load scan; incoming orders = UNPLANNED descent
// (10am-midnight); tomorrow's loads exist only after 8pm = TOMORROW load scan.
//
// Cadence (ET), by TIME ELAPSED since the last successful load scan — NOT the
// wall-clock minute. Netlify */15 fires are best-effort and rarely land on
// :00/:15/:30/:45; a minute-gate (minute===0) silently no-ops a fire that lands
// at :01, so the board only refreshed on the 4-7am window or manual scans. Gating
// on elapsed time makes the on-cadence fire scan even when it lands a few minutes
// late.
//   target interval: 4am-1pm → 30m · 1pm-4am (incl. overnight) → 60m
//   act = elapsed >= interval - TOLERANCE   (tolerance absorbs cron jitter)
// Feeds when a fire ACTS: TODAY loads ALWAYS · TODAY unplanned 10:00-24:00 ·
// TOMORROW loads 20:00-24:00 · TOMORROW unplanned 10:00-24:00 (orders for tomorrow
// arrive from ~10am the day before, so they must be descended through the day).

import { MIN_SCAN_INTERVAL_MS } from './nuvizz-request.mts';

// Live-editable scan configuration (Diagnostics UI → Firestore nuvizz_ops/scan_config).
// EVERY field is optional: an absent field falls back to the env/hardcoded default,
// so an empty or missing doc reproduces today's proven behavior exactly. The scanner
// reads this each invocation and overlays it on the defaults (see effectiveScanConfig).
export interface ScanConfig {
  // Cadence — minutes between scans in the day band vs the night/overnight band.
  intervalDayMin?: number;
  intervalNightMin?: number;
  dayBandStartHour?: number;   // ET hour the day (faster) band starts (default 4)
  dayBandEndHour?: number;     // ET hour the day band ends, exclusive (default 13)
  // Discovery windows.
  routingWindowStart?: number; // ET hour the overnight routing window opens (default 20)
  routingWindowEnd?: number;   // ET hour it closes, wraps midnight (default 7)
  weekendBlackoutStart?: number; // Fri ET hour scans stop (default 22)
  weekendBlackoutEnd?: number;   // Sun ET hour scans resume (default 20)
  // Deep sweep (the daily full-floor reconciliation) + spend cap + master switch.
  deepSweepHours?: number;     // min hours between deep sweeps (default 8)
  deepSweepHour?: number;      // earliest ET hour a deep sweep may run (default 13)
  dailyCeiling?: number;       // hard daily NuVizz call cap / breaker threshold
  scansEnabled?: boolean;      // master on/off (false = same as the kill switch)
  // Metadata (set by the write endpoint).
  updatedAt?: string;
  updatedBy?: string;
}

// Safe edit bounds per numeric field — the write endpoint clamps to these so a
// fat-fingered value can never, say, hammer the vendor every minute or lift the
// ceiling into the millions. [min, max] inclusive.
export const SCAN_CONFIG_BOUNDS: Record<string, [number, number]> = {
  intervalDayMin: [10, 240],
  intervalNightMin: [10, 360],
  dayBandStartHour: [0, 23],
  dayBandEndHour: [1, 24],
  routingWindowStart: [0, 23],
  routingWindowEnd: [0, 23],
  weekendBlackoutStart: [0, 23],
  weekendBlackoutEnd: [0, 23],
  deepSweepHours: [1, 168],
  deepSweepHour: [0, 23],
  dailyCeiling: [100, 200_000],
};

// The default schedule, computed from env (so the UI shows the SITE's real current
// values, e.g. the prod deep-sweep=24 / ceiling=35000 overrides). Pure: env injected.
export function scanConfigDefaults(env: Record<string, any> = process.env): Required<Omit<ScanConfig, 'updatedAt' | 'updatedBy'>> {
  return {
    intervalDayMin: 30,
    intervalNightMin: 60,
    dayBandStartHour: 4,
    dayBandEndHour: 13,
    routingWindowStart: Number(env.NUVIZZ_ROUTING_WINDOW_START_ET) || 20,
    routingWindowEnd: Number(env.NUVIZZ_ROUTING_WINDOW_END_ET) || 7,
    weekendBlackoutStart: Number(env.NUVIZZ_WEEKEND_BLACKOUT_START_ET) || 23,
    weekendBlackoutEnd: Number(env.NUVIZZ_WEEKEND_BLACKOUT_END_ET) || 19,
    deepSweepHours: Number(env.NUVIZZ_DEEP_SWEEP_HOURS) || 8,
    deepSweepHour: Number(env.NUVIZZ_DEEP_SWEEP_HOUR) || 13,
    dailyCeiling: Number(env.NUVIZZ_DAILY_CEILING) || 12_000,
    scansEnabled: String(env.NUVIZZ_SCANS_ENABLED ?? '').toLowerCase() !== 'false',
  };
}

// Validate + clamp an incoming (untrusted) partial config to the safe bounds,
// dropping unknown keys, blanks, and NaN. PURE → unit-tested. Used by the write
// endpoint before persisting and by the scanner before applying.
export function clampScanConfig(input: any): ScanConfig {
  const out: ScanConfig = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of Object.keys(SCAN_CONFIG_BOUNDS)) {
    const v = (input as any)[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) continue;
    const [lo, hi] = SCAN_CONFIG_BOUNDS[k];
    (out as any)[k] = Math.min(hi, Math.max(lo, n));
  }
  if (typeof input.scansEnabled === 'boolean') out.scansEnabled = input.scansEnabled;
  // Cross-field sanity: the day band must be a real forward interval, else drop
  // both edits so we fall back to the proven 4→13 default rather than a band that
  // never matches (which would silently force the slow night cadence all day).
  if (out.dayBandStartHour != null && out.dayBandEndHour != null && out.dayBandStartHour >= out.dayBandEndHour) {
    delete out.dayBandStartHour;
    delete out.dayBandEndHour;
  }
  return out;
}

// Effective config = env defaults overlaid with the (clamped) stored overrides.
// What the scanner actually runs and what the UI displays as the live schedule.
export function effectiveScanConfig(stored: ScanConfig | null | undefined, env: Record<string, any> = process.env): Required<Omit<ScanConfig, 'updatedAt' | 'updatedBy'>> & Pick<ScanConfig, 'updatedAt' | 'updatedBy'> {
  const merged: any = { ...scanConfigDefaults(env), ...clampScanConfig(stored || {}) };
  if (stored?.updatedAt) merged.updatedAt = stored.updatedAt;
  if (stored?.updatedBy) merged.updatedBy = stored.updatedBy;
  return merged;
}

// ~half the */15 cron period: lets an on-cadence fire that lands a minute or two
// late still scan, without letting an off-cadence fire scan early.
const TOLERANCE_MIN = 7;
// Hard floor (skip if a scan ran more recently than this) — bypassed only by manual.
const FLOOR_MIN = MIN_SCAN_INTERVAL_MS / 60000;

export interface ScanDecision {
  act: boolean;
  scanTodayUnplanned: boolean;
  scanTomorrowLoads: boolean;
  scanTomorrowUnplanned: boolean;
  // Diagnostics (surfaced in the [scan] log line):
  etHour: number;
  etMin: number;
  intervalMin: number;
  elapsedMin: number;            // Infinity when no prior load scan
  skip: 'none' | 'cadence' | 'floor' | 'weekend';
  reason: string;
}

// Weekend blackout (ET) — Davis doesn't work weekends, so no orders are created
// and no routing happens. Skip ALL scheduled scans from Fri night until Sun
// evening (when Monday prep begins), generating zero NuVizz traffic for ~46h.
// Defaults: Fri 23:00 ET → Sun 19:00 ET (Davis runs Friday loads later + starts Sunday
// Monday-prep earlier). Both edges env-tunable. A MANUAL scan always bypasses this (a
// dispatcher who explicitly scans on a weekend wants it).
export const WEEKEND_BLACKOUT_START_HOUR = Number(process.env.NUVIZZ_WEEKEND_BLACKOUT_START_ET) || 23; // Fri from this ET hour
export const WEEKEND_BLACKOUT_END_HOUR = Number(process.env.NUVIZZ_WEEKEND_BLACKOUT_END_ET) || 19;     // Sun until this ET hour
// weekday: 0=Sun … 5=Fri … 6=Sat.
export function isWeekendBlackout(weekday: number, etHour: number, cfg: ScanConfig = {}): boolean {
  const start = cfg.weekendBlackoutStart ?? WEEKEND_BLACKOUT_START_HOUR;
  const end = cfg.weekendBlackoutEnd ?? WEEKEND_BLACKOUT_END_HOUR;
  if (weekday === 5) return etHour >= start; // Friday from the blackout start hour
  if (weekday === 6) return true;            // all of Saturday
  if (weekday === 0) return etHour < end;    // Sunday before the resume hour
  return false;
}

// Routing window (ET hours) — when routes are built/edited at Davis: OVERNIGHT,
// 8 PM–7 AM ET. In-window = volatile (loads created, routes edited, stops added) →
// thorough planned discovery. Out-of-window (daytime) = stable (trucks delivering,
// loads only progressing to terminal) → lean discovery. The window WRAPS midnight,
// so the test is `hour >= start OR hour < end` when start > end. Env-tunable.
export const ROUTING_WINDOW_START = Number(process.env.NUVIZZ_ROUTING_WINDOW_START_ET) || 20;
export const ROUTING_WINDOW_END = Number(process.env.NUVIZZ_ROUTING_WINDOW_END_ET) || 7;
export function isInRoutingWindow(etHour: number, cfg: ScanConfig = {}): boolean {
  const start = cfg.routingWindowStart ?? ROUTING_WINDOW_START;
  const end = cfg.routingWindowEnd ?? ROUTING_WINDOW_END;
  // Wrapping window (start > end, e.g. 20→7): in window late evening OR early morning.
  if (start > end) return etHour >= start || etHour < end;
  // Non-wrapping (start < end): the simple between-check.
  return etHour >= start && etHour < end;
}

// Target interval (minutes) between scans for the given ET hour: the faster day-band
// cadence inside [dayBandStart, dayBandEnd), else the night/overnight cadence. Both
// bands + edges are config-overridable (defaults: 30m in 04:00–12:59, else 60m).
export function intervalForHour(hour: number, cfg: ScanConfig = {}): number {
  const dayStart = cfg.dayBandStartHour ?? 4;
  const dayEnd = cfg.dayBandEndHour ?? 13;
  const dayMin = cfg.intervalDayMin ?? 30;
  const nightMin = cfg.intervalNightMin ?? 60;
  return (hour >= dayStart && hour < dayEnd) ? dayMin : nightMin;
}

// ET wall-clock hour (0-23) + minute. ET is a whole-hour UTC offset, so the
// minute is identical to UTC's — the cron's :00/:15/:30/:45 align with ET.
export function nowET(d: Date = new Date()): { hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const hour = Number(get('hour')) % 24; // guards Intl's "24" at midnight
  const minute = Number(get('minute'));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { hour, minute, weekday };
}

export function scanDecision(
  d: Date = new Date(),
  isManual = false,
  lastLoadScanAt: string | null = null,
  cfg: ScanConfig = {},
): ScanDecision {
  const { hour, minute, weekday } = nowET(d);
  const intervalMin = intervalForHour(hour, cfg);
  const lastMs = lastLoadScanAt ? new Date(lastLoadScanAt).getTime() : NaN;
  const elapsedMin = Number.isFinite(lastMs) ? (d.getTime() - lastMs) / 60000 : Infinity;

  // Manual: always a full scan of today + tomorrow (loads + orders), floor +
  // weekend blackout bypassed.
  if (isManual) {
    return {
      act: true, scanTodayUnplanned: true, scanTomorrowLoads: true, scanTomorrowUnplanned: true,
      etHour: hour, etMin: minute, intervalMin, elapsedMin, skip: 'none', reason: 'manual',
    };
  }

  const base = { scanTodayUnplanned: false, scanTomorrowLoads: false, scanTomorrowUnplanned: false, etHour: hour, etMin: minute, intervalMin, elapsedMin };

  // Weekend blackout — no work Fri 22:00 ET → Sun 20:00 ET, so no scheduled scans.
  if (isWeekendBlackout(weekday, hour, cfg)) {
    return { act: false, ...base, skip: 'weekend', reason: `weekend blackout wd=${weekday} h=${hour}` };
  }

  // Hard floor — a scan ran very recently (e.g. a manual a moment ago); skip.
  if (elapsedMin < FLOOR_MIN) {
    return { act: false, ...base, skip: 'floor', reason: `floor elapsed=${Math.round(elapsedMin)}<${FLOOR_MIN}` };
  }
  // Cadence — not enough time elapsed for this hour's interval (minus tolerance).
  if (elapsedMin < intervalMin - TOLERANCE_MIN) {
    return { act: false, ...base, skip: 'cadence', reason: `cadence elapsed=${Math.round(elapsedMin)}<${intervalMin}-${TOLERANCE_MIN}` };
  }

  // Acting fire — which feeds run depends on the ET hour.
  return {
    act: true,
    scanTodayUnplanned: hour >= 10 && hour < 24,
    scanTomorrowLoads: hour >= 20 && hour < 24,
    scanTomorrowUnplanned: hour >= 10 && hour < 24,
    etHour: hour, etMin: minute, intervalMin, elapsedMin, skip: 'none',
    reason: `act h=${hour} elapsed=${elapsedMin === Infinity ? 'inf' : Math.round(elapsedMin)}>=${intervalMin}-${TOLERANCE_MIN}`,
  };
}
