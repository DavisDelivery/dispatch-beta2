// Stop comment parser — PURE, zero-dependency, side-effect-free.
//
// NuVizz delivers special instructions as free text tagged "SPL-INSTR-TEXT:",
// usually joined by ";", sometimes with a trailing "TOTAL-AMOUNT : NN.NN".
// This module turns that mess into structured flags + an advisory receiving
// window + a non-Uline revenue amount, WITHOUT ever dropping the operator's
// verbatim words (four-layer preservation: raw -> recognized flags -> other[]).
//
// Receiving hours are ADVISORY ONLY — never a hard gate. The single switch below
// makes that explicit and is asserted in the tests.

export const RECEIVING_HOURS_HARD = false

export interface ReceivingHours {
  start: string // "HH:MM" 24h
  end: string // "HH:MM" 24h
  raw: string // the segment the window was read from
  confidence: 'high' | 'low'
}

export interface ParsedStopComments {
  liftgate: boolean
  insideDelivery: boolean
  doNotBreakdownSkid: boolean
  doNotDoubleStack: boolean
  callUponApproach: boolean
  gravelOrNewConstruction: boolean
  receivingHours: ReceivingHours | null
  totalAmount: number | null
  other: string[]
  raw: string
  hasAny: boolean
}

export interface StopChip {
  key:
    | 'liftgate'
    | 'insideDelivery'
    | 'doNotBreakdownSkid'
    | 'doNotDoubleStack'
    | 'callUponApproach'
    | 'gravelOrNewConstruction'
  label: string
  color: string
}

// A NuVizz comment object (the only shape we care about).
interface CommentObject {
  commentDescription?: string | null
}

type CommentInput =
  | string
  | CommentObject
  | null
  | undefined
  | Array<string | CommentObject | null | undefined>

// Catalog order is authoritative — chips and the legend always render in THIS
// order, and activeChips() preserves it.
export const STOP_CHIPS: StopChip[] = [
  { key: 'liftgate', label: 'LIFTGATE', color: '#7c3aed' },
  { key: 'insideDelivery', label: 'INSIDE', color: '#0891b2' },
  { key: 'doNotBreakdownSkid', label: 'NO-BREAKDOWN', color: '#b45309' },
  { key: 'doNotDoubleStack', label: 'NO-DBL-STACK', color: '#be123c' },
  { key: 'callUponApproach', label: 'CALL', color: '#2563eb' },
  { key: 'gravelOrNewConstruction', label: 'GRAVEL', color: '#65a30d' },
]

// Tolerant flag matchers (case-insensitive; whitespace/hyphen forgiving).
const FLAG_PATTERNS: Array<{ key: StopChip['key']; re: RegExp }> = [
  { key: 'liftgate', re: /lift\s*-?\s*gate/i },
  { key: 'insideDelivery', re: /inside\s+deliver/i },
  {
    key: 'doNotBreakdownSkid',
    re: /do\s*not\s*break\s*-?\s*down\s+(the\s+)?skid/i,
  },
  {
    key: 'doNotDoubleStack',
    re: /(?:do\s*not|no|don'?t)\b[^;]*?double\s*-?\s*stack/i,
  },
  {
    key: 'callUponApproach',
    re: /call\s+(upon|on|when|prior\s+to)\s+approach|call\s+upon\s+arrival|call\s+ahead/i,
  },
  {
    key: 'gravelOrNewConstruction',
    re: /\bgravel\b|new\s+construction|unpaved|dirt\s+(lot|road)/i,
  },
]

const TOTAL_AMOUNT_RE =
  /total\s*-?\s*amount\s*:?\s*\$?\s*([0-9]+(\.[0-9]+)?)/i
// A segment that is NOTHING but a total-amount label (with or without a value).
const PURE_AMOUNT_RE =
  /^\s*total\s*-?\s*amount\s*:?\s*\$?\s*([0-9]+(\.[0-9]+)?)?\s*$/i

const RECV_MENTION_RE = /recv|receiv|rcv|hours/i
const SPL_LABEL_RE = /^\s*SPL[-\s]?INSTR[-\s]?TEXT\s*:?\s*/i

// ---------------------------------------------------------------------------
// commentsToString — normalize any accepted shape into a single "; "-joined
// string. Accepts a string, a string[], a Comment object {commentDescription},
// or arrays of those (nested arrays tolerated).
// ---------------------------------------------------------------------------
function segText(item: string | CommentObject | null | undefined): string {
  if (item == null) return ''
  if (typeof item === 'string') return item
  if (Array.isArray(item)) {
    return (item as Array<string | CommentObject | null | undefined>)
      .map(segText)
      .map((s) => s.trim())
      .filter(Boolean)
      .join('; ')
  }
  if (typeof item === 'object' && 'commentDescription' in item) {
    return String(item.commentDescription ?? '')
  }
  return ''
}

export function commentsToString(input: CommentInput): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (Array.isArray(input)) {
    return input
      .map(segText)
      .map((s) => s.trim())
      .filter(Boolean)
      .join('; ')
  }
  return segText(input)
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

interface TimeToken {
  h: number
  m: number
  meridiem: 'am' | 'pm' | null
  hasColon: boolean
  explicit: boolean
}

function parseTimeToken(tokRaw: string): TimeToken | null {
  const tok = tokRaw.trim()
  const m = tok.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m?\.?|p\.?m?\.?)?$/i)
  if (!m) return null
  const h = Number(m[1])
  if (h > 24) return null
  const min = m[2] != null ? Number(m[2]) : 0
  if (min > 59) return null
  const hasColon = m[2] != null
  let meridiem: 'am' | 'pm' | null = null
  if (m[3]) meridiem = m[3].toLowerCase().startsWith('p') ? 'pm' : 'am'
  // A colon'd time OR an am/pm reading counts as explicit.
  const explicit = hasColon || meridiem != null
  return { h, m: min, meridiem, hasColon, explicit }
}

function to24Minutes(h: number, m: number, meridiem: 'am' | 'pm' | null): number {
  let hh = h
  if (meridiem === 'pm') hh = (h % 12) + 12
  else if (meridiem === 'am') hh = h % 12
  // 24:00 -> treat as end-of-day midnight marker; callers normalize separately.
  return hh * 60 + m
}

function minutesToHHMM(mins: number): string {
  const total = ((mins % 1440) + 1440) % 1440
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
}

// Try to read a receiving window out of a single segment. Returns null when no
// A-B time range is present (the segment text is preserved by the caller).
function parseReceivingWindow(seg: string): ReceivingHours | null {
  // Strip the receiving label words so a bare range remains. The range regex
  // below keys off digit:digit times, so a stray label colon is harmless.
  const stripped = seg.replace(/receiv(?:ing)?|recv|rcv|hours?/gi, ' ').trim()

  const range = stripped.match(
    /(\d{1,2}(?::\d{2})?\s*(?:a\.?m?\.?|p\.?m?\.?)?)\s*(?:-|–|—|to|until|thru|through)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m?\.?|p\.?m?\.?)?)/i,
  )
  if (!range) return null

  const s = parseTimeToken(range[1])
  const e = parseTimeToken(range[2])
  if (!s || !e) return null

  let sMer = s.meridiem
  let eMer = e.meridiem
  const sBare = !s.hasColon && !s.meridiem
  const eBare = !e.hasColon && !e.meridiem

  // Infer a bare end's meridiem from a marked start (and vice versa).
  if (sMer && !eMer && !e.hasColon) {
    if (sMer === 'am') eMer = e.h !== 12 && e.h < s.h ? 'pm' : 'am'
    else eMer = 'pm'
  } else if (!sMer && eMer && !s.hasColon) {
    if (eMer === 'pm') sMer = s.h !== 12 && s.h > e.h ? 'am' : 'pm'
    else sMer = 'am'
  }

  let sMin = to24Minutes(s.h, s.m, sMer)
  let eMin = to24Minutes(e.h, e.m, eMer)

  // Bare daytime window, neither end marked ("8-3"): read start as AM; if the
  // end hour is earlier than the start, bump it to PM.
  if (sBare && eBare && eMin < sMin) {
    eMin += 12 * 60
  }

  // Confidence is high only when BOTH ends were explicitly marked.
  const confidence: 'high' | 'low' = s.explicit && e.explicit ? 'high' : 'low'

  return {
    start: minutesToHHMM(sMin),
    end: minutesToHHMM(eMin),
    raw: seg.trim(),
    confidence,
  }
}

// ---------------------------------------------------------------------------
// parseStopComments — main entry.
// ---------------------------------------------------------------------------
export function parseStopComments(input: CommentInput): ParsedStopComments {
  const raw = commentsToString(input)

  const parsed: ParsedStopComments = {
    liftgate: false,
    insideDelivery: false,
    doNotBreakdownSkid: false,
    doNotDoubleStack: false,
    callUponApproach: false,
    gravelOrNewConstruction: false,
    receivingHours: null,
    totalAmount: null,
    other: [],
    raw,
    hasAny: false,
  }

  const segments = raw
    .split(/[;\n\r]+/)
    .map((s) => s.replace(SPL_LABEL_RE, '').trim())
    .filter((s) => s.length > 0)

  for (const seg of segments) {
    let recognized = false

    // Flags.
    for (const { key, re } of FLAG_PATTERNS) {
      if (re.test(seg)) {
        parsed[key] = true
        recognized = true
      }
    }

    // Total amount (only treat a PURE amount segment as recognized so other
    // text never gets swallowed, and a pure amount never leaks into other[]).
    const pure = seg.match(PURE_AMOUNT_RE)
    if (pure) {
      recognized = true
      if (pure[1] != null) parsed.totalAmount = Number(pure[1])
    } else {
      const amt = seg.match(TOTAL_AMOUNT_RE)
      if (amt) parsed.totalAmount = Number(amt[1])
    }

    // Receiving hours (advisory). Only attempt when the segment mentions it.
    if (parsed.receivingHours == null && RECV_MENTION_RE.test(seg)) {
      const rh = parseReceivingWindow(seg)
      if (rh) {
        parsed.receivingHours = rh
        recognized = true
      }
    }

    // Four-layer preservation: anything we did not recognize is kept verbatim.
    if (!recognized) parsed.other.push(seg)
  }

  parsed.hasAny =
    FLAG_PATTERNS.some(({ key }) => parsed[key]) ||
    parsed.receivingHours != null ||
    parsed.totalAmount != null

  return parsed
}

// ---------------------------------------------------------------------------
// activeChips — STOP_CHIPS filtered to the flags that are true, in catalog order.
// ---------------------------------------------------------------------------
export function activeChips(parsed: ParsedStopComments): StopChip[] {
  return STOP_CHIPS.filter((chip) => parsed[chip.key])
}

// ---------------------------------------------------------------------------
// Appointment reality. A "placeholder" window is one NuVizz fills in when there
// is no real appointment, so the UI can show "no appt" instead of a fake range.
// ---------------------------------------------------------------------------
function normWindow(v: string | null | undefined): string | null {
  if (v == null) return null
  const str = String(v).trim()
  if (str === '') return null
  if (str === '24:00' || str === '2400') return '24:00'
  const m = str.match(/(\d{1,2}):?(\d{2})/)
  if (!m) return null
  return `${pad2(Number(m[1]))}:${m[2]}`
}

export function isPlaceholderWindow(
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  const f = normWindow(from)
  const t = normWindow(to)
  // No window at all (or only half a window present) -> placeholder.
  if (!f && !t) return true
  if (!f || !t) return true
  // Zero-width window.
  if (f === t) return true
  // Both midnight, or midnight paired with an end-of-day sentinel.
  if (f === '00:00' && t === '00:00') return true
  if (f === '00:00' && (t === '23:59' || t === '24:00')) return true
  return false
}

// ---------------------------------------------------------------------------
// Display helpers.
// ---------------------------------------------------------------------------
export function fmt12h(hhmm: string): string {
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return String(hhmm)
  const h24 = Number(m[1])
  const min = m[2]
  const suffix = h24 < 12 || h24 === 24 ? 'a' : 'p'
  let h12 = h24 % 12
  if (h12 === 0) h12 = 12
  return `${h12}:${min}${suffix}`
}

export function fmtReceivingHours(rh: ReceivingHours | null): string {
  if (!rh) return ''
  return `Recv ${fmt12h(rh.start)}-${fmt12h(rh.end)}`
}
