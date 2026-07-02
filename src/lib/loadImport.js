// LOAD IMPORT (§10.1) — PURE builders, comparators and the commit planner for the
// batch sequencing engine. One POST load/update/default/{cc} per touched load sets
// that load's COMPLETE stop list in exact stops[] array order (verified live on UAT
// DAVISV5, Jul 1 2026 — contract in docs/NUVIZZ_API.md §10.1). Everything in this
// file is a pure function so it is fully unit-testable with no network.
//
// The async half (fire the import, poll load/info until the read-back order matches,
// resend / reverse-unstick) lives in loadImportEngine.js.
//
// THE SILENT-FAILURE TRAP (why the header builder is so strict): the import is async.
// A 200 "Async import is SUCCESS … AppMessageLog Id-…" does NOT mean it landed — on
// worker failure NOTHING is created and the reason is unreachable (no AppMessageLog
// endpoint on the open API). The loadHeader MUST carry earliestStartDttm +
// latestStartDttm (NOT scheduleStartDttm — that's load/edit naming) AND the flat
// origin fields (origin, originName, originAddr1/2, originCity, originState,
// originZip, originCountry, loadTimeZone). Omit the origin fields = "SUCCESS" ack +
// nothing created, forever. buildImportHeader/buildImportLoad therefore HARD-VALIDATE
// and refuse to build a payload that would vanish.

import { deliverySlot, abbrState, DEFAULT_ORIGIN } from './nuvizzWrite.js'

// ── stopNbr normalization + the ONE convergence comparator ────────────────────

// Canonical stopNbr for ORDER COMPARISON ONLY (display/registry keep the raw form):
// trim, uppercase, strip leading zeros ("007141643" ≡ "7141643" ≡ 7141643). NuVizz
// is not consistent about zero-padding/typing across endpoints; a padding mismatch
// must never read as "order not converged".
export function normStopNbr(v) {
  const s = String(v ?? '').trim().toUpperCase()
  const stripped = s.replace(/^0+(?=.)/, '')
  return stripped || s
}

// Element-wise equality (order AND membership), both sides normalized. This is the
// only comparator the convergence loop trusts — an omitted stop still on the load
// reads as not-converged, as does a converged set in the wrong order.
export function sameOrder(seen, want) {
  if (!Array.isArray(seen) || !Array.isArray(want) || seen.length !== want.length) return false
  return seen.every((n, i) => normStopNbr(n) === normStopNbr(want[i]))
}

// ── raw load/info + stop/info parsing (echo sources) ─────────────────────────

// Parse a raw {status,data} getLoad response. found:false covers both a 404 and a
// body without a loadHeader — during convergence on a brand-new load that simply
// means "not created yet", never a hard failure.
export function parseLoadInfo(resp) {
  const d = resp?.data ?? resp
  const L = (d && (d.Load || d.load)) || {}
  const header = L.loadHeader
  if (!header || resp?.status === 404) return { found: false }
  return {
    found: true,
    header,
    loadId: header.loadId ?? null,
    versionId: L.versionId ?? null,
    rawStops: Array.isArray(L.stops) ? L.stops : [],
  }
}

// Parse a raw {status,data} getStop response down to the raw stop object (the echo
// source for an arrival's "to" block). Null when the stop doesn't exist.
export function parseStopInfo(resp) {
  const d = resp?.data ?? resp
  const st = d?.Stop?.stop || null
  return st && st.stopNbr != null ? st : null
}

// The load's DELIVERY stopNbrs in visit order (sorted by stop.to.seq; pickups
// excluded). seqsComplete guards a mid-rebuild read: the worker can list all stops
// before assigning their to.seq, and a missing seq degrades the sort to raw array
// order — which could read as a FALSE convergence. Require a real numeric seq on
// every delivery before trusting the comparison.
export function deliveryOrderFromInfo(info) {
  const raws = (info?.rawStops || []).map((rs) => rs?.stop || rs).filter((st) => st && st.stopNbr != null)
  const deliveries = raws.filter((st) => String(st.stopType ?? 'DO').toUpperCase() !== 'PU')
  const seqOf = (st) => st?.to?.seq ?? st?.from?.seq ?? st?.stopSeq ?? null
  const seqsComplete = deliveries.every((st) => seqOf(st) != null && Number.isFinite(Number(seqOf(st))))
  const order = deliveries
    .slice()
    .sort((a, b) => Number(seqOf(a) ?? Number.MAX_SAFE_INTEGER) - Number(seqOf(b) ?? Number.MAX_SAFE_INTEGER))
    .map((st) => String(st.stopNbr))
  return { order, seqsComplete }
}

// ── per-stop import REFERENCE (echo, never invent) ────────────────────────────

// Field whitelists for echoing a stop's "to" block back as an import reference.
// Echo only what the import format knows — never raw junk like seq/lat/exec fields.
const IMPORT_ADDR_FIELDS = ['addressType', 'name', 'addr1', 'addr2', 'city', 'state', 'zip', 'country']

// PRIMITIVES ONLY: load/info can nest objects under scalar-looking keys; echoing an
// object where the import expects a string is a hard NuVizz 400.
const pickFields = (src, keys) => {
  const out = {}
  for (const k of keys) if (src?.[k] != null && src[k] !== '' && typeof src[k] !== 'object') out[k] = src[k]
  return out
}

const strField = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const countryCode = (v) => {
  const s = strField(v).toUpperCase()
  return !s || s === 'USA' || s === 'US' || s === 'UNITED STATES' || s === 'UNITED STATES OF AMERICA' ? 'USA' : s
}
// The import format needs "yyyy-MM-ddTHH:mm:ss" strings; a millis/offset suffix is
// truncated to the proven 19-char shape, anything non-ISO (epoch millis!) is refused.
const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? v.slice(0, 19) : null)

/**
 * importRefFromRaw — a RAW stop object (from load/info stops[] or stop/info) → the
 * reference shape that plans that EXISTING stop on an import: stopNbr + stopType +
 * a "to" block. The ADDRESS is echoed from NuVizz's own record (whitelisted fields,
 * state/country normalized to the proven 2-letter/'USA' shape) — never invented.
 * The SCHEDULE is the driver-visible appointment ONLY (it never sets order): we
 * stamp the sequence-aligned 30-minute delivery slot for the stop's visit position
 * (`index`), on the stop's own service date — this replaces the old separate
 * per-stop setStopWindow writes (whose full-upsert blanked freight fields; the
 * reference upsert here leaves the stop's other fields intact per the §10.1
 * contract). Null when the raw record can't yield a valid reference — the caller
 * must surface that; a bare stopNbr is rejected by NuVizz.
 */
export function importRefFromRaw(rawStop, index = 0, fallbackDate = null) {
  const st = rawStop?.stop || rawStop || {}
  const to = st?.to || {}
  const address = pickFields(to.address || {}, IMPORT_ADDR_FIELDS)
  if (st.stopNbr == null || String(st.stopNbr).trim() === '' || !address.addr1) return null
  if (address.state != null) address.state = abbrState(address.state)
  address.country = countryCode(address.country)

  // Service date from the stop's own schedule (delivery first, then pickup), else the
  // caller's fallback (usually the load's start date). No date → no valid reference.
  const date =
    (iso(to.schedule?.timeFrom) || iso(st.from?.schedule?.timeFrom) || '').slice(0, 10) ||
    (fallbackDate ? String(fallbackDate).slice(0, 10) : '')
  if (!date) return null
  const slot = deliverySlot(index)
  return {
    stopNbr: String(st.stopNbr),
    stopType: st.stopType || 'DO',
    to: {
      address,
      schedule: {
        timeFrom: `${date}T${slot.from}`,
        timeTo: `${date}T${slot.to}`,
        timeZone: strField(to.schedule?.timeZone) || 'America/New_York',
        timeConstraint: 'PREFERRED',
      },
    },
  }
}

// ── the import loadHeader (the trap fields) ───────────────────────────────────

/**
 * buildImportHeader — build the import loadHeader for an EXISTING load from what we
 * can ECHO, in trust order, throwing when the silent-failure trap can't be satisfied:
 *   • loadNbr/routeName + earliestStartDttm/latestStartDttm from the raw load/info
 *     header (ISO strings only — an epoch echo IS the trap; fall back to a
 *     06:00–18:00 window on the derivable service date);
 *   • the flat origin block from (1) flat origin fields already on the raw header,
 *     else (2) a raw stop's "from" address (our creates write the warehouse there),
 *     else (3) the app's DEFAULT_ORIGIN (the Davis warehouse) — every field
 *     string-coerced and state/country-normalized, never echoed raw.
 */
export function buildImportHeader(rawHeader, rawStops = [], fallbackOrigin = DEFAULT_ORIGIN) {
  const h = rawHeader || {}
  const loadNbr = String(h.loadNbr ?? '').trim()
  if (!loadNbr) throw new Error('import header: loadNbr is required')

  // Service date fallback: the header's own dates, else the first stop schedule found.
  let fallbackDate = (iso(h.earliestStartDttm) || '').slice(0, 10)
  if (!fallbackDate) {
    for (const rs of rawStops || []) {
      const st = rs?.stop || rs || {}
      fallbackDate = (iso(st?.to?.schedule?.timeFrom) || iso(st?.from?.schedule?.timeFrom) || '').slice(0, 10)
      if (fallbackDate) break
    }
  }
  const earliest = iso(h.earliestStartDttm) || (fallbackDate ? `${fallbackDate}T06:00:00` : null)
  const latest = iso(h.latestStartDttm) || (fallbackDate ? `${fallbackDate}T18:00:00` : null)
  if (!earliest || !latest) {
    throw new Error(`import header: load ${loadNbr} has no earliest/latest start and no service date to derive one — cannot import safely`)
  }

  // Origin trust ladder — see the docstring. `origin` (the CODE) is never the raw
  // header's value when that value is an object.
  let origin = null
  if (strField(h.originName) && strField(h.originAddr1) && strField(h.originCity) && strField(h.originZip)) {
    origin = {
      origin: strField(h.origin) || strField(h.rtOrigin) || 'WHSE',
      originName: strField(h.originName),
      originAddr1: strField(h.originAddr1),
      originAddr2: strField(h.originAddr2) || undefined,
      originCity: strField(h.originCity),
      originState: abbrState(strField(h.originState)),
      originZip: strField(h.originZip),
      originCountry: countryCode(h.originCountry),
    }
  }
  if (!origin) {
    for (const rs of rawStops || []) {
      const from = (rs?.stop || rs || {})?.from?.address
      if (strField(from?.name) && strField(from?.addr1) && strField(from?.city) && strField(from?.zip)) {
        origin = {
          origin: strField(h.rtOrigin) || 'WHSE',
          originName: strField(from.name),
          originAddr1: strField(from.addr1),
          originAddr2: strField(from.addr2) || undefined,
          originCity: strField(from.city),
          originState: abbrState(strField(from.state)),
          originZip: strField(from.zip),
          originCountry: countryCode(from.country),
        }
        break
      }
    }
  }
  if (!origin && strField(fallbackOrigin?.name) && strField(fallbackOrigin?.addr1) && strField(fallbackOrigin?.city) && strField(fallbackOrigin?.zip)) {
    origin = {
      origin: 'WHSE',
      originName: strField(fallbackOrigin.name),
      originAddr1: strField(fallbackOrigin.addr1),
      originAddr2: strField(fallbackOrigin.addr2) || undefined,
      originCity: strField(fallbackOrigin.city),
      originState: abbrState(strField(fallbackOrigin.state)),
      originZip: strField(fallbackOrigin.zip),
      originCountry: 'USA',
    }
  }
  if (!origin) throw new Error(`import header: load ${loadNbr} — no origin block available (not on the header, no stops to echo it from, no default origin)`)

  const header = {
    loadNbr,
    routeName: h.routeName != null ? String(h.routeName) : undefined,
    earliestStartDttm: earliest,
    latestStartDttm: latest,
    ...origin,
    loadTimeZone: strField(h.loadTimeZone) || 'EST',
  }
  // HARD TYPE GUARD: every header scalar must be a plain string — live load/info has
  // handed back objects under scalar keys, which NuVizz 400s.
  for (const [k, v] of Object.entries(header)) {
    if (v !== undefined && typeof v !== 'string') {
      throw new Error(`import header: ${k} must be a string (got ${Array.isArray(v) ? 'array' : typeof v})`)
    }
  }
  return header
}

/**
 * buildImportLoad — validate + assemble ONE load for the loadImport op. Throws on
 * anything that would trip the silent-failure trap or an unsafe import:
 *   • missing loadNbr / earliestStartDttm / latestStartDttm (or scheduleStartDttm
 *     passed in their place) / any required flat origin field;
 *   • an EMPTY stops[] — never import an empty list to empty a load (the analogous
 *     remove-all path CANCELS the route; use load/cancel instead);
 *   • a stop without stopNbr or without a "to" block (bare references are rejected);
 *   • "claude"/"anthropic" anywhere in loadNbr/routeName (naming rule — never in
 *     live data or fixtures).
 */
export function buildImportLoad(loadHeader, stops) {
  const h = loadHeader || {}
  if ((h.scheduleStartDttm || h.scheduleEndDttm) && !(h.earliestStartDttm && h.latestStartDttm)) {
    throw new Error('import: use earliestStartDttm + latestStartDttm — scheduleStartDttm does NOT work on the import path (silent no-create)')
  }
  const required = ['loadNbr', 'earliestStartDttm', 'latestStartDttm', 'origin', 'originName', 'originAddr1', 'originCity', 'originState', 'originZip']
  for (const k of required) {
    if (h[k] == null || String(h[k]).trim() === '') throw new Error(`import: loadHeader.${k} is required (silent-failure trap)`)
  }
  if (/claude|anthropic/i.test(`${h.loadNbr} ${h.routeName || ''}`)) {
    throw new Error('import: load/route names must never contain "claude" or "anthropic"')
  }
  if (!Array.isArray(stops) || !stops.length) {
    throw new Error('import: never import an empty stops[] — use load/cancel to retire a load')
  }
  for (const [i, s] of stops.entries()) {
    if (s?.stopNbr == null || String(s.stopNbr).trim() === '') throw new Error(`import: stops[${i}].stopNbr is required`)
    if (!s?.to || !s.to.address) throw new Error(`import: stops[${i}] needs a "to" block (address+schedule) — a bare stopNbr reference is rejected by NuVizz`)
    if (!s.stopType) s.stopType = 'DO'
  }
  return { loadHeader: h, stops }
}

// ── async-ack parsing ─────────────────────────────────────────────────────────

// Parse the ASYNC import acknowledgement. ok=true means the request was ACCEPTED
// ("Async import is SUCCESS … AppMessageLog Id-…"), NOT that it landed — the caller
// MUST run the convergence read-back before trusting it. The status field is not
// always the bare token (the whole ack sentence can ride in `status`), so accept a
// standalone "success" with no failure word anywhere.
export function importAckOk(resp) {
  const httpOk = (resp?.status ?? 0) >= 200 && (resp?.status ?? 0) < 300
  const d = resp?.data ?? {}
  const body = typeof d === 'string' ? { message: d } : d
  const text = [body.status, body.message].filter((x) => x != null).map(String).join(' ')
  const badWord = /\b(partial|fail|failure|error|reject|invalid|denied)/i
  const accepted = /\bsuccess\b/i.test(text) && !badWord.test(text)
  const hasReasons = Array.isArray(body.reasons) && body.reasons.length > 0
  const ok = httpOk && !hasReasons && (accepted || (text.trim() === '' && !body.error))
  const err = body?.reasons?.[0]?.description || body?.error || body?.message || (httpOk ? null : `HTTP ${resp?.status}`)
  return { ok, message: ok ? text.trim().slice(0, 200) || 'accepted' : String(err || 'import rejected').slice(0, 300) }
}

// ── the commit planner (sources before destinations) ─────────────────────────

/**
 * planCommitOrder — order a batch of per-load commit entries so every cross-load
 * move imports its SOURCE (without the stop) before its DESTINATION (with it) —
 * a declarative "steal" while the stop is still planned elsewhere is untested and
 * never relied on. Entries: [{ loadNbr, arrivalsFrom?: [loadNbr,…] }] where
 * arrivalsFrom lists the loads this entry receives stops FROM. Pure Kahn's
 * topological sort; loads that only release (or cancel) have no arrivals and sort
 * first naturally. A genuine cycle (a two-load swap) is refused — save it as two
 * steps.
 */
export function planCommitOrder(entries) {
  const byNbr = new Map(entries.map((e) => [e.loadNbr, e]))
  const indeg = new Map(entries.map((e) => [e.loadNbr, 0]))
  const out = new Map(entries.map((e) => [e.loadNbr, []]))
  for (const e of entries) {
    for (const src of e.arrivalsFrom || []) {
      if (!byNbr.has(src) || src === e.loadNbr) continue // source outside this batch: nothing to order against
      out.get(src).push(e.loadNbr)
      indeg.set(e.loadNbr, indeg.get(e.loadNbr) + 1)
    }
  }
  const queue = entries.filter((e) => indeg.get(e.loadNbr) === 0).map((e) => e.loadNbr)
  const ordered = []
  while (queue.length) {
    const n = queue.shift()
    ordered.push(byNbr.get(n))
    for (const m of out.get(n)) {
      indeg.set(m, indeg.get(m) - 1)
      if (indeg.get(m) === 0) queue.push(m)
    }
  }
  if (ordered.length !== entries.length) {
    throw new Error('commit: cross-load moves form a cycle (a swap) — save it as two steps')
  }
  return ordered
}
