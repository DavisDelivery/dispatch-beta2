// M2.1 — Pattern scanner for NuVizz stop signals.
//
// Walks two signal sources on each stop and returns every flag/source/text hit.
// Source-locked: each source maps to its own flag, because the two sources have
// different confidence levels:
//
//   addressLine2     — Davis dispatchers curate this manually; treat as gospel.
//                      Hits produce `no_tractor_trailer` (red marker).
//   orderInstructions — Uline sends SPL-INSTR-TEXT on every order; sometimes
//                      wrong/over-broad. Treat as advisory only.
//                      Hits produce `uline_straight_truck` (amber marker).
//
// Why source-locked rather than text-locked: the same phrase "STRAIGHT TRUCK
// ONLY" can appear in either source, but the *trust level* is determined by
// who wrote it, not what they wrote. Keeping the source as the trust signal
// means the markers / filters / notes stay honest.

export type SignalSource = 'addressLine2' | 'orderInstructions';
export type FlagValue = 'no_tractor_trailer' | 'uline_straight_truck';
export type DayCode = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface ScanResult {
  flagValue: FlagValue;
  matchedSource: SignalSource;
  matchedText: string;
  matchedPattern: string;
}

// M4.4 — Separate from equipment-restriction ScanResult because the writer
// applies these to different fields (receiving_hours, closed_days). Same
// source-locked trust model: addressLine2 is curated, orderInstructions is
// advisory; the writer respects the matching manual_overrides flags.
export interface HoursScanResult {
  open: string;  // "HH:MM" 24-hour
  close: string; // "HH:MM" 24-hour
  matchedSource: SignalSource;
  matchedText: string;
}

export interface ClosedDayScanResult {
  day: DayCode;
  matchedSource: SignalSource;
  matchedText: string;
}

export interface FullScanResult {
  restrictions: ScanResult[];
  hours: HoursScanResult | null;
  closedDays: ClosedDayScanResult[];
}

// Hardcoded for v1. Refactor to Firestore config when the rule set grows past
// what a code review can comfortably scan.
const ADDR2_PATTERNS: RegExp[] = [
  // Phrasings dispatchers actually type into addr2. We accept Uline-style
  // phrasing here too (Davis sometimes copies it) — the source itself is what
  // confers Davis-trusted status, not the wording.
  /\bNO\s*TT\b/i,
  /\bNO\s+TRACTOR\s+TRL?\b/i,
  /\bNO\s+TRACTOR\s+TRAILER\b/i,
  /\bSTRAIGHT\s+TRUCK\s+ONLY\b/i,
  /\bST\s+ONLY\b/i,
  /\bSTRAIGHT\s+ONLY\b/i,
  /\bBOX\s+TRUCK\s+ONLY\b/i,
  /\b26\s*['']\s*MAX\b/i,
  /\b26\s*FT\s*MAX\b/i,
  /\bSMALL\s+TRUCK\s+ONLY\b/i,
  /\bNO\s+53\s*['']?\b/i,
  /\bNO\s+53\s*FT\b/i,
];

const ORDER_INSTR_PATTERNS: RegExp[] = [
  // What Uline puts in SPL-INSTR-TEXT.
  /\bSTRAIGHT\s+TRUCK\s+ONLY\b/i,
  /\bSTRAIGHT\s+TRUCK\b/i,
  /\bBOX\s+TRUCK\s+ONLY\b/i,
  /\b26\s*FT\s*MAX\b/i,
  /\b26\s*['']\s*MAX\b/i,
  /\bSMALL\s+TRUCK\s+ONLY\b/i,
  /\bNO\s+TRACTOR\s+TRAILER\b/i,
  /\bNO\s+TRACTOR\s+TRL?\b/i,
  /\bNO\s+53\s*['']?\b/i,
  /\bNO\s+53\s*FT\b/i,
];

const SOURCE_RULES: { source: SignalSource; flagValue: FlagValue; patterns: RegExp[] }[] = [
  { source: 'addressLine2',      flagValue: 'no_tractor_trailer',  patterns: ADDR2_PATTERNS },
  { source: 'orderInstructions', flagValue: 'uline_straight_truck', patterns: ORDER_INSTR_PATTERNS },
];

interface ScannableStop {
  signalSources?: {
    addressLine2?: string | null;
    orderInstructions?: string | null;
  };
  // Back-compat: older callers may still pass top-level addr2.
  addr2?: string | null;
}

function firstHit(text: string | null | undefined, patterns: RegExp[]): { text: string; pattern: string } | null {
  if (!text) return null;
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return { text: m[0], pattern: p.source };
  }
  return null;
}

export function scanStop(stop: ScannableStop): ScanResult[] {
  const ss = stop.signalSources || {};
  const sourceTexts: Record<SignalSource, string | null | undefined> = {
    addressLine2: ss.addressLine2 ?? stop.addr2 ?? null,
    orderInstructions: ss.orderInstructions ?? null,
  };
  const out: ScanResult[] = [];
  for (const rule of SOURCE_RULES) {
    const hit = firstHit(sourceTexts[rule.source], rule.patterns);
    if (hit) {
      out.push({
        flagValue: rule.flagValue,
        matchedSource: rule.source,
        matchedText: hit.text,
        matchedPattern: hit.pattern,
      });
    }
  }
  return out;
}

// ---------- M4.4: receiving hours + closed-day pattern matchers ----------

// Match either "6AM-2PM" / "8-4" / "6:30 AM to 2:30 PM" style ranges. The
// outer wrappers (`HOURS:`, `OPEN`, `RECEIVING:`, `RH` (Uline shorthand for
// Receiving Hours, e.g. "RH 7-11AM"), `DELIVER BETWEEN`, `DELIVER BY`) precede
// the actual time range; we capture both pieces in separate regexes so the
// wrapper is just a gate and the inner time parser can be reused. matchedText
// returns the full wrapper+range slice so the audit trail shows what triggered
// detection.
const HOURS_WRAPPERS: RegExp[] = [
  /\bHOURS?\s*[:\-]?\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?\s*(?:-|TO|—)\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i,
  /\bOPEN\s*[:\-]?\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?\s*(?:-|TO|—)\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i,
  // "RECEIVING" optionally followed by "HOURS" — Uline often splits the label
  // ("RECEIVING HOURS") and the range ("8AM-12PM") across separate SPL-INSTR-TEXT
  // segments that join with whitespace/newline.
  /\bRECEIVING(?:\s+HOURS?)?\s*[:\-]?\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?\s*(?:-|TO|—)\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i,
  // Uline "RH" = Receiving Hours, e.g. "RH 7-11AM" / "RH 8-3" / "RH7-11AM".
  /\bRH\s*[:\-]?\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?\s*(?:-|TO|—)\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i,
  /\bDELIVER(?:Y)?\s+BETWEEN\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?\s*(?:-|TO|AND|—)\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i,
  /\bDELIVER(?:Y)?\s+BY\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i,
];

// Parse a captured range like "6AM-2PM" or "8-4" or "6:30 AM to 2:30 PM" into
// {open, close} 24-hour strings. Returns null if the range can't be parsed
// confidently — callers persist the raw matched text under auto_sources so
// dispatchers can review.
function parseTimeRange(rangeText: string): { open: string; close: string } | null {
  const cleaned = rangeText.replace(/[—–]/g, '-').replace(/\s+TO\s+/i, '-').replace(/\s+AND\s+/i, '-').trim();
  const parts = cleaned.split('-').map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const open = parseTimePiece(parts[0], parts[1]);
  const close = parseTimePiece(parts[1], parts[0]);
  if (!open || !close) return null;
  return { open, close };
}

// Parse one half of a range. The other half (peer) is used to infer AM/PM
// when the first half omits a meridiem: e.g. "8-4" → 8AM-4PM (close is PM
// because business hours straddle noon ~95% of the time and 4-hour evening
// receiving windows are vanishingly rare).
function parseTimePiece(piece: string, peer: string): string | null {
  const m = /^([0-9]{1,2})(?::([0-9]{2}))?\s*(AM|PM)?$/i.exec(piece);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  let meridiem = m[3] ? m[3].toUpperCase() : null;
  if (hour < 0 || hour > 24) return null;
  if (minute < 0 || minute > 59) return null;
  if (!meridiem) {
    // Peer-based inference. If peer has a meridiem, use the opposite for the
    // earlier hour and same for the later hour. If neither has one, assume
    // morning-open + afternoon-close.
    const peerM = /(AM|PM)$/i.exec(peer);
    const peerMeridiem = peerM ? peerM[1].toUpperCase() : null;
    if (peerMeridiem) {
      // We're the half without meridiem. If we're "lower" numerically, mirror;
      // if higher, take opposite of peer.
      const peerHour = parseInt(/^[0-9]{1,2}/.exec(peer)?.[0] || '0', 10);
      if (hour <= peerHour) {
        meridiem = peerMeridiem === 'PM' ? 'AM' : peerMeridiem;
      } else {
        meridiem = peerMeridiem;
      }
    } else {
      meridiem = hour < 12 ? 'AM' : 'PM';
    }
  }
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// NuVizz joins each comment as its own "SPL-INSTR-TEXT: ..." line, so a label
// and its time range often land on adjacent lines ("SPL-INSTR-TEXT: RECEIVING
// HOURS" then "SPL-INSTR-TEXT: 8AM-12PM"). Strip those prefixes so the wrapper
// regexes see "RECEIVING HOURS 8AM-12PM" contiguously.
function stripCommentPrefixes(text: string): string {
  return text.replace(/SPL-INSTR-TEXT\s*:?\s*/gi, ' ').replace(/[ \t]+/g, ' ');
}

function scanHours(text: string | null | undefined, source: SignalSource): HoursScanResult | null {
  if (!text) return null;
  const normalized = stripCommentPrefixes(text);
  for (const w of HOURS_WRAPPERS) {
    const m = w.exec(normalized);
    if (m) {
      const range = m[1];
      const parsed = parseTimeRange(range);
      if (parsed) {
        return {
          open: parsed.open,
          close: parsed.close,
          matchedSource: source,
          matchedText: m[0],
        };
      }
      // Single-time "DELIVER BY 2PM" — treat as close-by with 06:00 default open.
      const single = /^([0-9]{1,2})(?::([0-9]{2}))?\s*(AM|PM)?$/i.exec(range.trim());
      if (single) {
        const close = parseTimePiece(range.trim(), '6AM');
        if (close) {
          return {
            open: '06:00',
            close,
            matchedSource: source,
            matchedText: m[0],
          };
        }
      }
    }
  }
  return null;
}

// Closed-day patterns. Per brief: every day, in case Uline ever sends
// "CLOSED SUNDAY" etc. The map between matched text and day code is encoded
// in the pattern entry so callers don't need to interpret the regex.
// Each pattern allows an optional "ON" ("CLOSED ON FRIDAY") and an optional
// trailing "S" plural ("CLOSED ON FRIDAYS" — the exact Uline instruction format),
// in addition to the bare "CLOSED FRIDAY" / "NO FRIDAY" / "FRIDAY CLOSED" forms.
const CLOSED_DAY_PATTERNS: { day: DayCode; patterns: RegExp[] }[] = [
  { day: 'mon', patterns: [/\bCLOSED\s+(?:ON\s+)?MON(?:DAY)?S?\b/i, /\bNO\s+MONDAYS?\b/i, /\bMONDAYS?\s+CLOSED\b/i] },
  { day: 'tue', patterns: [/\bCLOSED\s+(?:ON\s+)?TUE(?:S|SDAY)?S?\b/i, /\bNO\s+TUESDAYS?\b/i, /\bTUESDAYS?\s+CLOSED\b/i] },
  { day: 'wed', patterns: [/\bCLOSED\s+(?:ON\s+)?WED(?:NESDAY)?S?\b/i, /\bNO\s+WEDNESDAYS?\b/i, /\bWEDNESDAYS?\s+CLOSED\b/i] },
  { day: 'thu', patterns: [/\bCLOSED\s+(?:ON\s+)?THU(?:RS|RSDAY)?S?\b/i, /\bNO\s+THURSDAYS?\b/i, /\bTHURSDAYS?\s+CLOSED\b/i] },
  { day: 'fri', patterns: [/\bCLOSED\s+(?:ON\s+)?FRI(?:DAY)?S?\b/i, /\bNO\s+FRIDAYS?\b/i, /\bNOT\s+OPEN\s+FRIDAYS?\b/i, /\bFRIDAYS?\s+CLOSED\b/i] },
  { day: 'sat', patterns: [/\bCLOSED\s+(?:ON\s+)?SAT(?:URDAY)?S?\b/i, /\bNO\s+SATURDAYS?\b/i, /\bSATURDAYS?\s+CLOSED\b/i] },
  { day: 'sun', patterns: [/\bCLOSED\s+(?:ON\s+)?SUN(?:DAY)?S?\b/i, /\bNO\s+SUNDAYS?\b/i, /\bSUNDAYS?\s+CLOSED\b/i] },
];

function scanClosedDays(text: string | null | undefined, source: SignalSource): ClosedDayScanResult[] {
  if (!text) return [];
  const out: ClosedDayScanResult[] = [];
  for (const entry of CLOSED_DAY_PATTERNS) {
    for (const p of entry.patterns) {
      const m = p.exec(text);
      if (m) {
        out.push({ day: entry.day, matchedSource: source, matchedText: m[0] });
        break; // one hit per day is enough
      }
    }
  }
  return out;
}

// Run all detectors against a stop. Equipment restrictions remain source-locked
// (red/amber). Hours + closed days check both sources and dedupe by source
// preference (addressLine2 wins over orderInstructions when both fire).
export function scanStopFull(stop: ScannableStop): FullScanResult {
  const ss = stop.signalSources || {};
  const addr2Text = ss.addressLine2 ?? stop.addr2 ?? null;
  const orderText = ss.orderInstructions ?? null;

  const restrictions = scanStop(stop);

  // Hours: prefer addr2 (curated) over orderInstructions (advisory).
  const hours = scanHours(addr2Text, 'addressLine2') ?? scanHours(orderText, 'orderInstructions');

  // Closed days: union across both sources, addr2 wins on conflict (same day).
  const closedFromAddr2 = scanClosedDays(addr2Text, 'addressLine2');
  const closedFromOrder = scanClosedDays(orderText, 'orderInstructions');
  const seenDays = new Set<DayCode>();
  const closedDays: ClosedDayScanResult[] = [];
  for (const r of [...closedFromAddr2, ...closedFromOrder]) {
    if (seenDays.has(r.day)) continue;
    seenDays.add(r.day);
    closedDays.push(r);
  }

  return { restrictions, hours, closedDays };
}

// Convenience: tally hits across many stops, grouped by flag.
export function summarizeHits(allHits: ScanResult[][]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const stopHits of allHits) {
    const seen = new Set<string>();
    for (const h of stopHits) {
      if (seen.has(h.flagValue)) continue;
      seen.add(h.flagValue);
      counts[h.flagValue] = (counts[h.flagValue] || 0) + 1;
    }
  }
  return counts;
}
