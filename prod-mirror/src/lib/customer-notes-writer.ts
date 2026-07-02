// M2.1 — Auto-populate customer_notes from scanner results.
//
// Reads each stop's scan results, merges with the existing customer_notes doc
// (if any), and writes back via a Firestore batch. Respects the manual-override
// guard: if a dispatcher has set `manual_overrides.equipment_restrictions = true`,
// we never touch equipment_restrictions on that doc — but we still update the
// audit fields (auto_sources, auto_matches, auto_detected_at) so the UI can
// disclose what *would have* been detected.
//
// Source-locked flags (v0.3.0):
//   addressLine2     → no_tractor_trailer   (Davis-curated, trusted)
//   orderInstructions → uline_straight_truck (Uline-supplied, advisory)
//
// Migration: if a doc currently carries `no_tractor_trailer` but its only
// auto-detection source was `orderInstructions` (legacy v0.2.0 behavior where
// SPL-INSTR-TEXT mapped to no_tractor_trailer), we swap it to
// `uline_straight_truck`. Manual overrides are respected as always.
//
// Schema additions for M2.1:
//   manual_overrides: { equipment_restrictions: boolean }   // dispatcher acknowledged
//   auto_sources:     { [flag]: SignalSource[] }            // which sources detected each flag
//   auto_matches:     { [flag]: { source, text, pattern }[] } // exact text that matched
//   auto_detected_at: Timestamp                             // last auto-scan write
//   auto_detected_by: string                                // 'auto-scanner v0.3.0'

import { doc, writeBatch, serverTimestamp, deleteField, Firestore } from 'firebase/firestore';
import type {
  ScanResult, SignalSource, FlagValue, DayCode,
  HoursScanResult, ClosedDayScanResult,
} from './signal-scanner';

const MAX_BATCH = 450;       // Firestore caps at 500; leave headroom
const SCANNER_TAG = 'auto-scanner v0.7.0';

const DAY_CODES: DayCode[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface ScannedStop {
  matchKey: string | null;
  pro: string | null;
  businessName: string | null;
  addr1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  scanResults: ScanResult[];
  // M4.4 — receiving hours + closed-day detections. Optional so the equipment
  // scanner can remain usable on its own.
  hoursResult?: HoursScanResult | null;
  closedDaysResult?: ClosedDayScanResult[];
}

export interface ExistingNote {
  equipment_restrictions?: string[];
  manual_overrides?: {
    equipment_restrictions?: boolean;
    receiving_hours?: boolean; // M4.4
    closed_days?: boolean;     // M4.4
  };
  auto_sources?: Record<string, SignalSource[]>;
  auto_matches?: Record<string, { source: SignalSource; text: string; pattern: string }[]>;
  pro_history?: { pro: string; date: string }[];
  // Flags the user explicitly dismissed via the sidebar — the scanner must
  // not re-add these even if it keeps detecting them on every scan.
  auto_scan_dismissed?: string[];
  // M4.4 schema. Old M2.x format was `Record<string, string>` (e.g. "6AM-2PM");
  // new format is `Record<string, { open, close }>`. Type union lets the
  // writer accept either when reading existing docs.
  receiving_hours?: Record<string, { open: string; close: string }> | Record<string, string>;
  closed_days?: DayCode[];
}

interface WriteDecision {
  matchKey: string;
  payload: Record<string, any>;
  detectedFlags: FlagValue[];
  removedLegacyFlags: FlagValue[];
  skippedDueToOverride: FlagValue[];
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

// Build the payload for one stop. Returns null if nothing to write.
// Visible for testing.
export function decideWrite(
  stop: ScannedStop,
  existing: ExistingNote | undefined,
): WriteDecision | null {
  if (!stop.matchKey) return null;
  // Need at least one signal class to write — equipment restriction, hours, or closed day.
  const hasAnySignal =
    stop.scanResults.length > 0 ||
    !!stop.hoursResult ||
    (stop.closedDaysResult && stop.closedDaysResult.length > 0);
  if (!hasAnySignal) return null;

  // Merge new scan with the doc's previously persisted auto trail. Per-flag
  // sources accumulate across days; matches reflect only the latest scan.
  const existingSources = existing?.auto_sources || {};
  const dismissed = new Set<string>(existing?.auto_scan_dismissed || []);
  const sourcesByFlag: Record<string, SignalSource[]> = {};
  const matchesByFlag: Record<string, { source: SignalSource; text: string; pattern: string }[]> = {};
  const detectedFlagsThisScan = new Set<FlagValue>();

  for (const r of stop.scanResults) {
    // Honor the user's explicit "dismiss this advisory" choice — we still
    // record nothing for that flag (no audit trail update either, since the
    // user said the signal is wrong for this customer).
    if (dismissed.has(r.flagValue)) continue;
    detectedFlagsThisScan.add(r.flagValue);
    const sources = sourcesByFlag[r.flagValue] || (sourcesByFlag[r.flagValue] = [...(existingSources[r.flagValue] || [])]);
    if (!sources.includes(r.matchedSource)) sources.push(r.matchedSource);
    const matches = matchesByFlag[r.flagValue] || (matchesByFlag[r.flagValue] = []);
    matches.push({ source: r.matchedSource, text: r.matchedText, pattern: r.matchedPattern });
  }


  const overrideOnRestrictions = existing?.manual_overrides?.equipment_restrictions === true;

  // Compute the new equipment_restrictions explicitly so we can both add new
  // detections AND clean up legacy v0.2.0 writes where orderInstructions hits
  // were mis-tagged as no_tractor_trailer.
  const detectedFlags: FlagValue[] = [...detectedFlagsThisScan];
  const removedLegacyFlags: FlagValue[] = [];
  const skippedDueToOverride: FlagValue[] = [];

  // Migration: if no_tractor_trailer is on the doc but its only auto-source
  // (across history) was orderInstructions, that's a legacy v0.2.0 write —
  // swap it to uline_straight_truck. We only migrate values the scanner
  // touched (not human-set ones); the manual_overrides flag is the canonical
  // signal of human touch.
  const ntSources = (existing?.auto_sources?.no_tractor_trailer || []) as SignalSource[];
  const ntFromAddr2 = ntSources.includes('addressLine2') || detectedFlagsThisScan.has('no_tractor_trailer');
  const existingArr: string[] = Array.isArray(existing?.equipment_restrictions) ? existing!.equipment_restrictions! : [];
  const shouldMigrate =
    !overrideOnRestrictions &&
    existingArr.includes('no_tractor_trailer') &&
    !ntFromAddr2 &&
    ntSources.includes('orderInstructions') &&
    !dismissed.has('uline_straight_truck'); // user explicitly said this customer isn't ST-only

  // If everything detected this scan was dismissed AND no migration is needed,
  // there's nothing meaningful to write — skip to avoid churning audit fields.
  if (!detectedFlags.length && !shouldMigrate) return null;

  if (shouldMigrate) {
    // Carry the legacy audit trail forward under the new flag so the UI keeps
    // showing the matched text (just under uline_straight_truck now).
    const legacyMatches = existing?.auto_matches?.no_tractor_trailer || [];
    if (legacyMatches.length) {
      matchesByFlag.uline_straight_truck = [...(matchesByFlag.uline_straight_truck || []), ...legacyMatches];
    }
    sourcesByFlag.uline_straight_truck = [
      ...new Set([...(sourcesByFlag.uline_straight_truck || []), ...ntSources]),
    ];
  }

  const payload: Record<string, any> = {
    match_key: stop.matchKey,
    raw_name: stop.businessName || '',
    raw_address: [stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', '),
    // Merge persisted auto trail so flags detected on earlier scans aren't lost.
    auto_sources: { ...existingSources, ...sourcesByFlag },
    auto_matches: matchesByFlag,
    auto_detected_at: serverTimestamp(),
    auto_detected_by: SCANNER_TAG,
  };
  if (shouldMigrate) {
    // Drop the stale audit entry for the migrated-away flag so the UI doesn't
    // keep listing it under its old name. Nested deleteField in a setDoc-merge
    // call removes just that sub-key, leaving the rest of the map intact.
    payload.auto_sources = { ...payload.auto_sources, no_tractor_trailer: deleteField() };
    payload.auto_matches = { ...payload.auto_matches, no_tractor_trailer: deleteField() };
  }

  if (overrideOnRestrictions) {
    // Dispatcher locked the field — only update the audit trail, never touch
    // the array itself.
    skippedDueToOverride.push(...detectedFlags);
  } else {
    const next = new Set<string>(existingArr);
    for (const f of detectedFlags) next.add(f);
    if (shouldMigrate) {
      next.delete('no_tractor_trailer');
      next.add('uline_straight_truck');
      removedLegacyFlags.push('no_tractor_trailer');
    }
    payload.equipment_restrictions = [...next];
  }

  // Append today's PRO to history (FIFO 20).
  if (stop.pro) {
    const arr = Array.isArray(existing?.pro_history) ? existing!.pro_history! : [];
    const today = todayYmd();
    const last = arr[arr.length - 1];
    if (!last || last.pro !== stop.pro || last.date !== today) {
      const next = [...arr, { pro: stop.pro, date: today }];
      payload.pro_history = next.slice(-20);
    }
  }

  // ---------- M4.4: receiving hours + closed days ----------

  // Receiving hours: if the scanner found a range and the dispatcher hasn't
  // locked the field, populate all 7 days with that range. The audit trail
  // (auto_sources.receiving_hours + auto_matches.receiving_hours) records the
  // exact matched text and source so the dispatcher can review.
  if (stop.hoursResult) {
    const overrideHours = existing?.manual_overrides?.receiving_hours === true;
    if (!overrideHours) {
      const { open, close } = stop.hoursResult;
      const filled: Record<string, { open: string; close: string }> = {};
      // Don't overwrite days the dispatcher has set per-day (we have no
      // per-day override flag — only the whole field — so this is all-or-nothing
      // until the editor lands).
      for (const d of DAY_CODES) filled[d] = { open, close };
      payload.receiving_hours = filled;
    }
    // Audit trail regardless of override.
    payload.auto_sources = {
      ...payload.auto_sources,
      receiving_hours: [stop.hoursResult.matchedSource],
    };
    payload.auto_matches = {
      ...payload.auto_matches,
      receiving_hours: [{
        source: stop.hoursResult.matchedSource,
        text: stop.hoursResult.matchedText,
        pattern: 'hours_range',
      }],
    };
  }

  // Closed days: union with anything previously detected (don't drop days
  // the scanner found yesterday but missed today — text may have rotated).
  if (stop.closedDaysResult && stop.closedDaysResult.length) {
    const overrideClosed = existing?.manual_overrides?.closed_days === true;
    if (!overrideClosed) {
      const next = new Set<DayCode>((existing?.closed_days || []) as DayCode[]);
      for (const r of stop.closedDaysResult) next.add(r.day);
      payload.closed_days = [...next];
    }
    payload.auto_sources = {
      ...payload.auto_sources,
      closed_days: [...new Set(stop.closedDaysResult.map((r) => r.matchedSource))],
    };
    payload.auto_matches = {
      ...payload.auto_matches,
      closed_days: stop.closedDaysResult.map((r) => ({
        source: r.matchedSource,
        text: r.matchedText,
        pattern: `closed_${r.day}`,
      })),
    };
  }

  return { matchKey: stop.matchKey, payload, detectedFlags, removedLegacyFlags, skippedDueToOverride };
}

export interface ApplyResult {
  attempted: number;
  written: number;
  overrideSkips: number;
  legacyMigrations: number;
  errors: { matchKey: string; message: string }[];
}

export async function applyScannerResults(
  db: Firestore,
  stops: ScannedStop[],
  existingNotes: Map<string, ExistingNote>,
): Promise<ApplyResult> {
  const result: ApplyResult = { attempted: 0, written: 0, overrideSkips: 0, legacyMigrations: 0, errors: [] };
  if (!db) return result;

  // Dedupe by match_key — two stops at the same customer merge into one write.
  // M4.4 — also dedupe hours (first wins) and closed_days (union across stops).
  const merged = new Map<string, {
    stop: ScannedStop;
    results: ScanResult[];
    hours: HoursScanResult | null;
    closedDays: ClosedDayScanResult[];
  }>();
  for (const s of stops) {
    if (!s.matchKey) continue;
    const hasAny = s.scanResults.length || s.hoursResult || (s.closedDaysResult && s.closedDaysResult.length);
    if (!hasAny) continue;
    const prev = merged.get(s.matchKey);
    if (prev) {
      prev.results.push(...s.scanResults);
      if (!prev.hours && s.hoursResult) prev.hours = s.hoursResult;
      if (s.closedDaysResult) {
        const seen = new Set(prev.closedDays.map((c) => c.day));
        for (const c of s.closedDaysResult) if (!seen.has(c.day)) prev.closedDays.push(c);
      }
    } else {
      merged.set(s.matchKey, {
        stop: s,
        results: [...s.scanResults],
        hours: s.hoursResult ?? null,
        closedDays: s.closedDaysResult ? [...s.closedDaysResult] : [],
      });
    }
  }
  result.attempted = merged.size;

  const decisions: WriteDecision[] = [];
  for (const { stop, results, hours, closedDays } of merged.values()) {
    const d = decideWrite(
      { ...stop, scanResults: results, hoursResult: hours, closedDaysResult: closedDays },
      existingNotes.get(stop.matchKey),
    );
    if (!d) continue;
    decisions.push(d);
    if (d.skippedDueToOverride.length) result.overrideSkips++;
    if (d.removedLegacyFlags.length) result.legacyMigrations++;
  }

  for (let i = 0; i < decisions.length; i += MAX_BATCH) {
    const slice = decisions.slice(i, i + MAX_BATCH);
    const batch = writeBatch(db);
    for (const d of slice) {
      batch.set(doc(db, 'customer_notes', d.matchKey), d.payload, { merge: true });
    }
    try {
      await batch.commit();
      result.written += slice.length;
    } catch (e: any) {
      for (const d of slice) result.errors.push({ matchKey: d.matchKey, message: e.message });
    }
  }

  return result;
}
