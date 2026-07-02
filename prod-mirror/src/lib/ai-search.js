// src/lib/ai-search.js
//
// M6 — AI Order Search client helpers. Two responsibilities, both kept pure and
// dependency-free so they can be unit-tested with node:test:
//
//   1. Projection — buildTrimmedStops() turns the app's stop + customer_notes
//      objects into the compact TrimmedStop[] the chat endpoint reasons over
//      (small token footprint; capped at 400 by the caller per the brief).
//
//   2. Filter application — applyFilterSpec() takes the STRICT JSON filter spec
//      the parse endpoint returns and evaluates it locally over the currently-
//      loaded stops, returning a Set of matching stopNbr. This is the same set
//      the literal keyword search produces, so it flows through the existing
//      map-dim / list-filter pipeline unchanged.
//
// The fetch wrappers (aiParse / aiChat) live here too but use the global fetch;
// the pure helpers above never touch the network or the DOM.

// customer_notes uses 'mon'..'sun'; the model speaks 'Mon'..'Sun'. Map both ways.
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

// Normalize a weekday token (Mon/Monday/MONDAY/mon) to a 'mon'..'sun' key.
export function dayKeyFromToken(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase().slice(0, 3);
  return DAY_KEYS.includes(t) ? t : null;
}

// Recognized restriction aliases — mirrors RESTRICTION_ALIASES in App.jsx so the
// model's canonical kinds resolve to the keys customer_notes actually stores.
const RESTRICTION_ALIASES = {
  straight_truck_only: 'box_truck_only',
  tt_friendly: 'tractor_trailer_friendly',
  tractor_trailer_ok: 'tractor_trailer_friendly',
  semi_friendly: 'tractor_trailer_friendly',
};
function canonRestriction(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return RESTRICTION_ALIASES[k] || k;
}

// The full restriction vocabulary a stop carries: equipment_restrictions plus the
// two boolean flags surfaced as their own canonical kinds.
export function restrictionsForStop(note) {
  if (!note) return [];
  const out = [];
  for (const r of note.equipment_restrictions || []) out.push(canonRestriction(r));
  if (note.liftgate_required) out.push('liftgate');
  if (note.appointment_required) out.push('appointment_required');
  return out;
}

// Closed days as 3-letter labels (['Fri']) for the trimmed projection.
export function closedDayLabels(note) {
  const days = Array.isArray(note?.closed_days) ? note.closed_days : [];
  return days.map((d) => DAY_LABEL[dayKeyFromToken(d)] || d).filter(Boolean);
}

// Format a 24h "HH:MM" string as 12-hour AM/PM, e.g. "08:00" -> "8:00 AM",
// "15:00" -> "3:00 PM", "00:00" -> "12:00 AM". Non-time strings pass through.
export function to12h(hhmm) {
  if (typeof hhmm !== 'string') return hhmm || '';
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return hhmm;
  let h = Number(m[1]);
  const min = m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ap}`;
}

// A compact human-readable hours line, e.g. "Mon 8:00 AM–4:00 PM · Fri 7:00 AM–12:00 PM".
// Days with no open/close are skipped. Returns '' when nothing is set.
export function hoursSummary(note) {
  const hrs = note?.receiving_hours;
  if (!hrs || typeof hrs !== 'object') return '';
  const parts = [];
  for (const k of DAY_KEYS) {
    const v = hrs[k];
    if (v && typeof v === 'object' && (v.open || v.close)) {
      parts.push(`${DAY_LABEL[k]} ${v.open ? to12h(v.open) : '?'}–${v.close ? to12h(v.close) : '?'}`);
    } else if (typeof v === 'string' && v.trim()) {
      parts.push(`${DAY_LABEL[k]} ${v.trim()}`);
    }
  }
  return parts.join(' · ');
}

function zip5(stop) {
  return String(stop?.zip || '').trim().slice(0, 5);
}

// Raw NuVizz instruction text for a stop (order instructions + addr2). Receiving
// hours, restrictions, etc. often live here verbatim in arbitrary phrasing
// ("RH 7-11AM", "RECEIVING HOURS 8AM-12PM", "DELIVER BEFORE NOON"). Feeding it to
// the chat lets the model read them no matter the format. Truncated for tokens.
function rawInstructions(stop) {
  const parts = [stop?.signalSources?.orderInstructions, stop?.addr2].filter(Boolean);
  return parts.join(' | ').slice(0, 280);
}

// TrimmedStop projection — small, token-cheap shape for the chat endpoint.
// dock_notes + appointment_notes + instructions are included raw (truncated)
// because receiving hours are often written there as free text rather than the
// structured receiving_hours field; the chat prompt tells the model to look in all.
export function buildTrimmedStop(stop, note) {
  return {
    id: stop.stopNbr,
    pro: String(stop.stopNbr ?? ''),
    business: stop.businessName || '',
    address: stop.addr1 || '',
    city: stop.city || '',
    zip5: zip5(stop),
    lat: stop.lat ?? null,
    lng: stop.lng ?? null,
    hours_summary: hoursSummary(note),
    closed_days: closedDayLabels(note),
    restrictions: restrictionsForStop(note),
    dock_notes: String(note?.dock_notes || '').slice(0, 240),
    appointment_notes: String(note?.appointment_notes || '').slice(0, 240),
    instructions: rawInstructions(stop),
    priority_flag: note?.priority_flag || null,
  };
}

// Build the capped TrimmedStop[] for the chat context. Caps at `limit` (400 per
// the brief) in the given (route) order so token cost stays bounded; reports the
// truncation so the UI can tell the dispatcher the answer covers a subset.
export function buildTrimmedStops(stops, notesByKey, limit = 400) {
  const total = stops.length;
  const slice = stops.slice(0, limit);
  const trimmed = slice.map((s) => buildTrimmedStop(s, notesByKey.get(s.matchKey)));
  return { stops: trimmed, total, truncated: total > limit, sent: trimmed.length };
}

// ── filter-spec evaluation ──

function timeCompare(have, op, want) {
  // 'HH:MM' zero-padded 24h compares correctly as strings.
  if (!have) return false;
  if (op === '<=') return have <= want;
  if (op === '>=') return have >= want;
  if (op === '==' || op === '=') return have === want;
  if (op === '<') return have < want;
  if (op === '>') return have > want;
  return false;
}

// Earliest open / latest close across the week — lets "opens before 9am" match a
// stop that opens early on any single day.
function openTimes(note) {
  const hrs = note?.receiving_hours || {};
  const out = [];
  for (const k of DAY_KEYS) {
    const v = hrs[k];
    if (v && typeof v === 'object' && v.open) out.push(v.open);
  }
  return out;
}
function closeTimes(note) {
  const hrs = note?.receiving_hours || {};
  const out = [];
  for (const k of DAY_KEYS) {
    const v = hrs[k];
    if (v && typeof v === 'object' && v.close) out.push(v.close);
  }
  return out;
}

function contains(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

// Evaluate one predicate against a stop + its note. Unknown fields/ops are false
// (so a malformed predicate never silently matches everything).
function evalPredicate(stop, note, pred) {
  if (!pred || !pred.field) return false;
  const op = pred.op || 'includes';
  const value = pred.value;
  switch (pred.field) {
    case 'closed_days': {
      const key = dayKeyFromToken(value);
      const days = (Array.isArray(note?.closed_days) ? note.closed_days : []).map(dayKeyFromToken);
      return !!key && days.includes(key);
    }
    case 'receiving_open':
      return openTimes(note).some((t) => timeCompare(t, op, value));
    case 'receiving_close':
      return closeTimes(note).some((t) => timeCompare(t, op, value));
    case 'restrictions': {
      const want = canonRestriction(value);
      return restrictionsForStop(note).includes(want);
    }
    case 'business':
      return contains(stop.businessName, value);
    case 'city':
      return contains(stop.city, value);
    case 'zip5': {
      const z = zip5(stop);
      return op === '==' || op === '=' ? z === String(value).slice(0, 5) : contains(z, value);
    }
    case 'priority_flag': {
      const f = note?.priority_flag || null;
      if (String(value).toLowerCase() === 'any') return !!f;
      return f === value;
    }
    case 'dock_notes':
      return contains(note?.dock_notes, value);
    default:
      return false;
  }
}

// text_match: case-insensitive contains over business name + dock notes.
function matchesText(stop, note, text) {
  if (!text) return null; // null = "no text constraint"
  return contains(stop.businessName, text) || contains(note?.dock_notes, text);
}

// Apply a filter spec over stops, returning a Set of matching stopNbr. notesByKey
// is the Map<match_key, note>. Pure — no side effects.
export function applyFilterSpec(stops, notesByKey, spec) {
  const set = new Set();
  if (!spec) return set;
  const preds = Array.isArray(spec.predicates) ? spec.predicates : [];
  const logic = spec.logic === 'OR' ? 'OR' : 'AND';
  const text = typeof spec.text_match === 'string' ? spec.text_match.trim() : '';
  // A spec with neither predicates nor text matches nothing (caller falls back).
  if (preds.length === 0 && !text) return set;

  for (const s of stops) {
    const note = notesByKey.get(s.matchKey);
    const predResults = preds.map((p) => evalPredicate(s, note, p));
    const textResult = matchesText(s, note, text); // true | false | null

    let ok;
    if (logic === 'OR') {
      ok = predResults.some(Boolean) || textResult === true;
    } else {
      const predsOk = predResults.length === 0 ? true : predResults.every(Boolean);
      const textOk = textResult === null ? true : textResult === true;
      ok = predsOk && textOk;
    }
    if (ok) set.add(s.stopNbr);
  }
  return set;
}

// One-line summary chip text for an applied spec, e.g.
// "12 stops · closed Fri · liftgate".
export function summarizeSpec(spec, count) {
  const bits = [];
  for (const p of spec?.predicates || []) {
    if (p.field === 'closed_days') bits.push(`closed ${DAY_LABEL[dayKeyFromToken(p.value)] || p.value}`);
    else if (p.field === 'receiving_open') bits.push(`opens ${p.op} ${to12h(p.value)}`);
    else if (p.field === 'receiving_close') bits.push(`closes ${p.op} ${to12h(p.value)}`);
    else if (p.field === 'restrictions') bits.push(String(p.value).replace(/_/g, ' '));
    else if (p.field === 'priority_flag') bits.push(`${p.value} flag`);
    else if (p.field === 'city') bits.push(`in ${p.value}`);
    else if (p.field === 'zip5') bits.push(`zip ${p.value}`);
    else if (p.field === 'business') bits.push(`"${p.value}"`);
    else if (p.field === 'dock_notes') bits.push(`notes "${p.value}"`);
  }
  if (spec?.text_match) bits.push(`"${spec.text_match}"`);
  const label = `${count} stop${count === 1 ? '' : 's'}`;
  return bits.length ? `${label} · ${bits.join(' · ')}` : label;
}

// ── network wrappers (browser only) ──

const ENDPOINT = '/.netlify/functions/ai-search';

// Throws { code } on failure so the caller can show a friendly message:
//   'ai_key_missing' → ANTHROPIC_API_KEY not set on the site
//   'ai_unavailable' → network / server error
async function postAi(payload) {
  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    const e = new Error('ai_unavailable'); e.code = 'ai_unavailable'; throw e;
  }
  let data = null;
  try { data = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok || (data && data.error)) {
    const code = data?.error === 'ai_key_missing' ? 'ai_key_missing' : 'ai_unavailable';
    const e = new Error(code); e.code = code; throw e;
  }
  return data;
}

export function aiParse(query) {
  return postAi({ mode: 'parse', query });
}

export function aiChat(query, context) {
  return postAi({ mode: 'chat', query, context });
}
