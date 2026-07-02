// lib/history-derive.mts
//
// PURE derivation logic for the immutable daily history warehouse (Phase 1).
//
// Everything here is a deterministic, side-effect-free transform of one
// scanDate() output (an array of NormalizedStop) into the warehouse records:
// per-stop docs, per-load (route) docs, per-driver docs, and a content checksum.
// No network, no Firestore, no clock reads beyond what callers pass in — so the
// whole derivation is unit-testable against a committed fixture (test/history-derive.test.mjs).
//
// Invariants this module upholds:
//   • FOUR-LAYER PRESERVATION — buildStopRecord spreads the full normalized stop
//     (which already embeds `.raw`, including stopExecutionInfo) and never drops it.
//   • Routes derive ONLY from planned stops grouped by loadNbr; unplanned stops
//     (no loadNbr) are never routes.
//   • Ordering, sums, and completion counts are computed the same way every run,
//     so re-capturing a date is idempotent at the value level.

import crypto from 'node:crypto';
import { normalizeMatchKey } from '../../../src/lib/matchKey.js';

// Depot / route origin default (ORCHESTRATION.md §3 / brief §6).
export const DEPOT = Object.freeze({
  name: 'Buford Terminal',
  address: '943 Gainesville Hwy',
  lat: 34.14838,
  lng: -83.95948,
});

// ── shared shapes ────────────────────────────────────────────────────────────
export interface CaptureMeta {
  capture_version: number;
  captured_at: string;        // ISO — when THIS capture ran
  source_scanned_at: string;  // ISO — scanDate().scannedAt
  app_version: string;
}

export interface DeriveCtx {
  tenant: string;
  date: string;               // YYYY-MM-DD (storage key; internal, not user-facing)
  capture: CaptureMeta;
}

// A NormalizedStop (lib/nuvizz-scan.mts) plus the warehouse-only fields. We keep
// this loose (any) on purpose — buildStopRecord must survive scan-shape drift and
// only reads fields that are present on main today.
type Stop = any;

// ── helpers ──────────────────────────────────────────────────────────────────

// customerMatchKey makes history queryable by customer (same algorithm the
// dispatch map + customer_notes use, so a key here joins to a customer note).
export function stopMatchKey(s: Stop): string {
  return normalizeMatchKey(s?.businessName, s?.addr1, s?.city, s?.zip);
}

function isDelivered(s: Stop): boolean {
  return s?.normalizedStatus === 'DELIVERED';
}

function num(v: any): number | null {
  const n = typeof v === 'number' ? v : v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Driver doc id / pointer key. Prefer the stable driverUserName (e.g. "VINCENT");
// fall back to a slug of the human name when NuVizz omits the username, and to
// 'unknown' as a last resort. Uppercased + whitespace→_ so it is a safe Firestore
// document id (no slashes, no spaces).
export function driverKeyFor(s: Stop): string {
  const u = String(s?.driverUserName ?? '').trim();
  if (u) return u.toUpperCase().replace(/\s+/g, '_');
  const n = String(s?.driverName ?? '').trim();
  if (n) return 'name_' + n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return 'unknown';
}

// Planned-stop ordering for a route: loadStopSeq first (the load's own sequence),
// then plannedEtaDTTM, then stopNbr — so the polyline order is stable even when
// seq is missing. Mirrors the M5.2 reasoning in nuvizz-scan.mts.
function cmpRouteStops(a: Stop, b: Stop): number {
  const sa = typeof a?.loadStopSeq === 'number' ? a.loadStopSeq : null;
  const sb = typeof b?.loadStopSeq === 'number' ? b.loadStopSeq : null;
  if (sa != null && sb != null && sa !== sb) return sa - sb;
  if (sa != null && sb == null) return -1;
  if (sa == null && sb != null) return 1;
  const ea = a?.plannedEtaDTTM || '';
  const eb = b?.plannedEtaDTTM || '';
  if (ea !== eb) return ea < eb ? -1 : 1;
  return String(a?.stopNbr ?? '').localeCompare(String(b?.stopNbr ?? ''));
}

// NuVizz planned distance/duration to the next stop can live in a few places
// depending on the payload; probe tolerantly and only sum what is actually present.
function plannedLegOf(s: Stop): { dist: number | null; dur: number | null } {
  const raw = s?.raw ?? {};
  const stop = raw?.stop ?? {};
  const load = raw?.load ?? {};
  const dist = num(stop.plannedDistanceToNextStop) ?? num(raw.plannedDistanceToNextStop) ?? num(load.plannedDistanceToNextStop);
  const dur = num(stop.plannedDurationToNextStop) ?? num(raw.plannedDurationToNextStop) ?? num(load.plannedDurationToNextStop);
  return { dist, dur };
}

function sumPlannedLegs(stops: Stop[]): { plannedDistance: number | null; plannedDuration: number | null } {
  let dist = 0, dur = 0, anyDist = false, anyDur = false;
  for (const s of stops) {
    const leg = plannedLegOf(s);
    if (leg.dist != null) { dist += leg.dist; anyDist = true; }
    if (leg.dur != null) { dur += leg.dur; anyDur = true; }
  }
  return { plannedDistance: anyDist ? dist : null, plannedDuration: anyDur ? dur : null };
}

// ── stop records ─────────────────────────────────────────────────────────────

// Full normalized stop (incl. .raw) + the queryable derivations + capture lineage.
// FOUR-LAYER PRESERVATION: `...s` carries `.raw` through untouched.
export function buildStopRecord(s: Stop, ctx: DeriveCtx): any {
  const exec = (s?.raw && s.raw.stopExecutionInfo) || {};
  return {
    ...s,
    tenant: ctx.tenant,
    date: ctx.date,
    customerMatchKey: stopMatchKey(s),
    // Executed/actual timestamps surfaced for queryability. arrivalDTTM /
    // deliveredDTTM are already on the normalized stop; confirmedDTTM /
    // receiveDTTM are pulled straight from raw.stopExecutionInfo (the dwell signal).
    executed: {
      arrivalDTTM: s?.arrivalDTTM ?? null,
      deliveredDTTM: s?.deliveredDTTM ?? null,
      confirmedDTTM: exec?.to?.confirmedDTTM ?? null,
      receiveDTTM: exec?.receiveDTTM ?? null,
      stopStatus: exec?.stopStatus ?? s?.status ?? null,
    },
    capture_version: ctx.capture.capture_version,
    captured_at: ctx.capture.captured_at,
  };
}

// ── route (load) records ─────────────────────────────────────────────────────

export function deriveRoutes(stops: Stop[], ctx: DeriveCtx): any[] {
  const planned = stops.filter((s) => s && s.isPlanned && s.loadNbr);
  const byLoad = new Map<string, Stop[]>();
  for (const s of planned) {
    const k = String(s.loadNbr);
    (byLoad.get(k) ?? byLoad.set(k, []).get(k)!).push(s);
  }

  const routes: any[] = [];
  for (const [loadNbr, group] of byLoad) {
    const ordered = [...group].sort(cmpRouteStops);
    const firstWith = (f: (s: Stop) => any) => { for (const s of ordered) { const v = f(s); if (v != null && v !== '') return v; } return null; };
    const legs = sumPlannedLegs(ordered);
    routes.push({
      tenant: ctx.tenant,
      date: ctx.date,
      loadNbr,
      routeName: firstWith((s) => s.routeName),
      driverName: firstWith((s) => s.driverName),
      driverUserName: firstWith((s) => s.driverUserName),
      driverKey: driverKeyFor(ordered.find((s) => s.driverUserName || s.driverName) ?? ordered[0]),
      origin: DEPOT,
      stops: ordered.map((s) => ({
        stopNbr: s.stopNbr ?? null,
        customerMatchKey: stopMatchKey(s),
        lat: s.lat ?? null,
        lng: s.lng ?? null,
        pallets: s.pallets ?? null,
        weight: s.weight ?? null,
        normalizedStatus: s.normalizedStatus ?? null,
        plannedEtaDTTM: s.plannedEtaDTTM ?? null,
        loadStopSeq: typeof s.loadStopSeq === 'number' ? s.loadStopSeq : null,
      })),
      stopCount: ordered.length,
      completedCount: ordered.filter(isDelivered).length,
      totalPallets: ordered.reduce((a, s) => a + (num(s.pallets) ?? 0), 0),
      totalWeight: ordered.reduce((a, s) => a + (num(s.weight) ?? 0), 0),
      plannedDistance: legs.plannedDistance,
      plannedDuration: legs.plannedDuration,
      capture_version: ctx.capture.capture_version,
      captured_at: ctx.capture.captured_at,
    });
  }
  // Stable doc order (does not affect storage, but keeps test output deterministic).
  routes.sort((a, b) => a.loadNbr.localeCompare(b.loadNbr));
  return routes;
}

// ── driver records ───────────────────────────────────────────────────────────

export function deriveDrivers(stops: Stop[], ctx: DeriveCtx): any[] {
  const planned = stops.filter((s) => s && s.isPlanned && (s.driverUserName || s.driverName));
  const byDriver = new Map<string, Stop[]>();
  for (const s of planned) {
    const k = driverKeyFor(s);
    (byDriver.get(k) ?? byDriver.set(k, []).get(k)!).push(s);
  }

  const drivers: any[] = [];
  for (const [driverKey, group] of byDriver) {
    const firstWith = (f: (s: Stop) => any) => { for (const s of group) { const v = f(s); if (v != null && v !== '') return v; } return null; };
    const loadNbrs = [...new Set(group.map((s) => String(s.loadNbr)).filter(Boolean))].sort();

    // On-time metrics — only where we have BOTH the planned ETA and an actual
    // delivery time, so the number is clean (not inferred from missing data).
    let measured = 0, onTime = 0, late = 0;
    for (const s of group) {
      const eta = s.plannedEtaDTTM, del = s.deliveredDTTM;
      if (eta && del) { measured++; if (String(del) <= String(eta)) onTime++; else late++; }
    }

    drivers.push({
      tenant: ctx.tenant,
      date: ctx.date,
      driverKey,
      driverUserName: firstWith((s) => s.driverUserName),
      driverName: firstWith((s) => s.driverName),
      loadNbrs,
      routeCount: loadNbrs.length,
      stopCount: group.length,
      completedCount: group.filter(isDelivered).length,
      onTimeDeliveries: onTime,
      lateDeliveries: late,
      measuredDeliveries: measured,
      // v1.1 hook — populate actual miles / HOS from Motive for this date.
      // Intentionally null in v1; do NOT call Motive here (brief §7 / §15).
      motiveActuals: null,
      capture_version: ctx.capture.capture_version,
      captured_at: ctx.capture.captured_at,
    });
  }
  drivers.sort((a, b) => a.driverKey.localeCompare(b.driverKey));
  return drivers;
}

// ── checksum ─────────────────────────────────────────────────────────────────

// Order-independent content hash of the day's stop set. Sorted by stopNbr so the
// same set produces the same hash regardless of scan order; includes status so a
// re-capture that changed an outcome produces a NEW checksum (visible in the
// captures audit). This is the lineage fingerprint, not a uniqueness key.
export function computeStopChecksum(stops: Stop[]): string {
  const canon = stops
    .filter((s) => s && s.stopNbr)
    .map((s) => ({ n: String(s.stopNbr), st: s.normalizedStatus ?? null, ld: s.loadNbr ?? null, pl: !!s.isPlanned }))
    .sort((a, b) => a.n.localeCompare(b.n));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// ── manifest counts (computed from a readback, never from in-memory counters) ──
export function manifestCountsFromReadback(stopDocs: any[], routeDocs: any[], driverDocs: any[]) {
  const planned = stopDocs.filter((d) => d && d.isPlanned).length;
  return {
    stops: stopDocs.length,
    planned,
    unplanned: stopDocs.length - planned,
    routes: routeDocs.length,
    drivers: driverDocs.length,
  };
}
