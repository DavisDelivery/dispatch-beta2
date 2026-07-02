// LOAD IMPORT (§10.1) — PURE builders, comparators and the commit planner for the
// batch sequencing engine. One POST load/update/default/{cc} per touched load sets
// that load's stop ORDER in exact stops[] array order. Everything in this file is a
// pure function so it is fully unit-testable with no network.
//
// ⚠️ THE REAL MATCHING SEMANTICS (UAT-reproduced Jul 2 2026, after the same-day prod
// incident — freight wipe + duplicate stops; full contract in docs/NUVIZZ_API.md §10.1):
//   1. A stops[] entry MATCHES an existing stop ONLY when that stopNbr is already ON
//      THE TARGET LOAD. Matched = same stopId; the array order applies (reorders work).
//   2. A MATCHED stop is FULL-REPLACED by its entry — any field not sent is BLANKED
//      (a to-only "reference" wipes totalPallets/totalCartons/weight/proNumber/refs).
//   3. An entry whose stopNbr is NOT on the target load — unplanned OR planned on
//      another load — NEVER matches: NuVizz CREATES A NEW STOP RECORD (a CLONE) and
//      plans the clone; the original is untouched. Data completeness does not change
//      identity: a FULL payload for an off-load number still clones.
// Therefore the import is the ORDER lever only. MEMBERSHIP never rides an import:
// plan a real record onto a load with insertStops (by stopId); unplan by omission
// (an omitted ON-LOAD stop survives, unplanned — that part held) or removeStops.
// Every order-import entry must be a FULL ECHO of the just-read on-load record, and
// buildImportLoad makes the clone case UNREPRESENTABLE (a membership guard is
// mandatory; entries must sit in the just-read on-load set, or — create mode — in a
// verified-absent set). The only stops[] entries that may be non-echo are CREATE
// mode's full payloads for stopNbrs proven to exist nowhere.
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

// Parse a raw {status,data} getStop response down to the raw stop object — used to
// resolve an arrival's stopId for insertStops (membership NEVER rides an import)
// and as the existence gate for create mode. Null when the stop doesn't exist.
export function parseStopInfo(resp) {
  const d = resp?.data ?? resp
  const st = d?.Stop?.stop || null
  return st && st.stopNbr != null ? st : null
}

// The load a stop is CURRENTLY planned on, from the same getStop response
// (Stop.load.loadNbr; null/absent = unplanned). Used to enforce
// sources-before-destinations before an insertStops.
export function parseStopLoadNbr(resp) {
  const d = resp?.data ?? resp
  const nbr = d?.Stop?.load?.loadNbr
  return nbr != null && String(nbr).trim() !== '' ? String(nbr) : null
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

// ── per-stop FULL ECHO (a matched stop is FULL-REPLACED — echo everything) ────

// Field whitelists for echoing a stop record back as an import entry. Echo only
// what the import format knows — never raw junk like seq/lat/exec fields.
const IMPORT_ADDR_FIELDS = ['addressType', 'name', 'addr1', 'addr2', 'city', 'state', 'zip', 'country']
// Scalar stop fields that MUST ride every echo — a matched stop is replaced whole,
// so anything omitted here is BLANKED on the live record (the Jul 2 freight wipe).
const ECHO_STR_FIELDS = ['shipmentType', 'stopExecution', 'sourceType', 'shipmentNbr', 'proNumber', 'reference1', 'reference2', 'reference3', 'weightUOM']
// Freight fields are NUMBERS on the record — the echo must carry them as numbers.
const ECHO_NUM_FIELDS = ['totalPallets', 'totalCartons', 'weight']

// PRIMITIVES ONLY: load/info can nest objects under scalar-looking keys; echoing an
// object where the import expects a scalar is a hard NuVizz 400. Strings AND numbers
// pass (zip/freight can be numeric); objects/arrays never do.
const pickFields = (src, keys) => {
  const out = {}
  for (const k of keys) if (src?.[k] != null && src[k] !== '' && typeof src[k] !== 'object') out[k] = src[k]
  return out
}
// Echo a scalar: strings and finite numbers only — null/''/objects are omitted
// (they're already blank on the record, so omitting reproduces the record).
const echoScalar = (v) =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? v : undefined

const strField = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const countryCode = (v) => {
  const s = strField(v).toUpperCase()
  return !s || s === 'USA' || s === 'US' || s === 'UNITED STATES' || s === 'UNITED STATES OF AMERICA' ? 'USA' : s
}
// The import format needs "yyyy-MM-ddTHH:mm:ss" strings; a millis/offset suffix is
// truncated to the proven 19-char shape, anything non-ISO (epoch millis!) is refused.
const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? v.slice(0, 19) : null)

const echoAddress = (a) => {
  const address = pickFields(a || {}, IMPORT_ADDR_FIELDS)
  if (address.state != null) address.state = abbrState(address.state)
  address.country = countryCode(address.country)
  return address
}

/**
 * buildFullEchoStop — an ON-LOAD raw stop record (from the load/info just read) →
 * the FULL-ECHO import entry that reorders it without regressing it. Because a
 * matched stop is FULL-REPLACED by its entry (proven: a to-only entry wiped
 * pallets/cartons/weight/PRO off the live record), the echo carries EVERYTHING the
 * import format knows about the stop:
 *   stopNbr, stopType, shipmentType, stopExecution, sourceType, shipmentNbr,
 *   proNumber, reference1/2/3, totalPallets, totalCartons, weight (numbers pass
 *   the scalar guard; objects never do), weightUOM, the full FROM block
 *   (address + schedule, echoed verbatim) and the TO block.
 * The ONE deliberately rewritten field is to.schedule's window: the sequence-aligned
 * 30-minute delivery slot for the stop's visit position (`index`) — the
 * driver-visible appointment, kept aligned to the order (it never sets order).
 * Null when the record can't yield a safe echo (no stopNbr / no to-address /
 * no from-address / no derivable date) — the caller must surface that, never send
 * a partial entry.
 */
export function buildFullEchoStop(rawStop, index = 0, fallbackDate = null) {
  const st = rawStop?.stop || rawStop || {}
  if (st.stopNbr == null || String(st.stopNbr).trim() === '') return null
  const toAddress = echoAddress(st.to?.address)
  const fromAddress = echoAddress(st.from?.address)
  // A full echo REQUIRES both sides — an entry without its from block is the
  // to-only shape that wiped freight; refuse to build it at all.
  if (!toAddress.addr1 || !fromAddress.addr1) return null

  // Service date from the stop's own schedule (delivery first, then pickup), else
  // the caller's fallback (usually the load's start date). No date → no safe echo.
  const date =
    (iso(st.to?.schedule?.timeFrom) || iso(st.from?.schedule?.timeFrom) || '').slice(0, 10) ||
    (fallbackDate ? String(fallbackDate).slice(0, 10) : '')
  if (!date) return null

  const slot = deliverySlot(index)
  const entry = {
    stopNbr: String(st.stopNbr),
    stopType: st.stopType || 'DO',
    from: {
      address: fromAddress,
      // The pickup schedule is echoed verbatim (ISO-truncated); when the record
      // lacks one, pin the proven early-morning window before every delivery slot.
      schedule: {
        timeFrom: iso(st.from?.schedule?.timeFrom) || `${date}T06:00:00`,
        timeTo: iso(st.from?.schedule?.timeTo) || `${date}T07:00:00`,
        timeZone: strField(st.from?.schedule?.timeZone) || 'America/New_York',
        timeConstraint: strField(st.from?.schedule?.timeConstraint) || 'PREFERRED',
      },
    },
    to: {
      address: toAddress,
      schedule: {
        timeFrom: `${date}T${slot.from}`,
        timeTo: `${date}T${slot.to}`,
        timeZone: strField(st.to?.schedule?.timeZone) || 'America/New_York',
        timeConstraint: 'PREFERRED',
      },
    },
  }
  for (const k of ECHO_STR_FIELDS) {
    const v = echoScalar(st[k])
    if (v !== undefined) entry[k] = typeof v === 'number' ? String(v) : v
  }
  for (const k of ECHO_NUM_FIELDS) {
    // Freight rides as NUMBERS (numeric strings are coerced; objects are refused
    // by echoScalar upstream).
    const v = echoScalar(st[k])
    if (v !== undefined) {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n)) entry[k] = n
    }
  }
  return entry
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
          // Live load/info hands back `origin` as the plain CODE string ('WHSE')
          // while `rtOrigin` is an address OBJECT — prefer the string, refuse objects.
          origin: strField(h.origin) || strField(h.rtOrigin) || 'WHSE',
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
 * buildImportLoad — validate + assemble ONE load for the loadImport op. The
 * membership GUARD is mandatory — it makes the clone/wipe cases structurally
 * unrepresentable, not just avoided:
 *   • ORDER mode — `guard.onLoad` = the Set of normalized stopNbrs read off the
 *     target load MOMENTS AGO. Every entry must be in it (an off-load entry —
 *     unplanned or on another load — never matches: NuVizz CLONES a new stop
 *     record; membership belongs to insertStops/removeStops, never the import).
 *   • CREATE mode — `guard.create` + `guard.verifiedAbsent` = the Set of
 *     normalized stopNbrs each proven to exist NOWHERE (a getStop 404 per number).
 *     Entries must be FULL payloads; a colliding number is refused (it would
 *     clone the existing record instead of creating a fresh one).
 * Also throws on anything that would trip the silent-failure trap or an unsafe
 * import:
 *   • missing loadNbr / earliestStartDttm / latestStartDttm (or scheduleStartDttm
 *     passed in their place) / any required flat origin field;
 *   • an EMPTY stops[] — never import an empty list to empty a load (the analogous
 *     remove-all path CANCELS the route; use load/cancel instead);
 *   • an entry without stopNbr, or without BOTH a "to" and a "from" block — a
 *     matched stop is FULL-REPLACED, so a to-only entry (the old "reference")
 *     blanks freight/PRO/references off the live record and is refused outright;
 *   • "claude"/"anthropic" anywhere in loadNbr/routeName (naming rule — never in
 *     live data or fixtures).
 */
export function buildImportLoad(loadHeader, stops, guard) {
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
  const onLoad = guard?.onLoad instanceof Set ? guard.onLoad : null
  const verifiedAbsent = guard?.create === true && guard?.verifiedAbsent instanceof Set ? guard.verifiedAbsent : null
  if (!onLoad && !verifiedAbsent) {
    throw new Error('import: a membership guard is required — order mode needs {onLoad: Set(just-read stopNbrs)}, create mode {create:true, verifiedAbsent: Set} (an unguarded entry can CLONE a stop record)')
  }
  if (!Array.isArray(stops) || !stops.length) {
    throw new Error('import: never import an empty stops[] — use load/cancel to retire a load')
  }
  for (const [i, s] of stops.entries()) {
    if (s?.stopNbr == null || String(s.stopNbr).trim() === '') throw new Error(`import: stops[${i}].stopNbr is required`)
    if (!s?.to || !s.to.address) throw new Error(`import: stops[${i}] needs a "to" block (address+schedule)`)
    if (!s?.from || !s.from.address) {
      throw new Error(`import: stops[${i}] (${s.stopNbr}) has no "from" block — a to-only entry FULL-REPLACES a matched stop and blanks its freight/PRO/references; send the full echo`)
    }
    if (!s.stopType) s.stopType = 'DO'
    const key = normStopNbr(s.stopNbr)
    if (onLoad && !onLoad.has(key)) {
      throw new Error(`import: stops[${i}] (${s.stopNbr}) is NOT on ${h.loadNbr} — an off-load entry would CLONE a new stop record (plan membership with insertStops first, then reorder)`)
    }
    if (verifiedAbsent && !verifiedAbsent.has(key)) {
      throw new Error(`import: stops[${i}] (${s.stopNbr}) was not verified absent — creating over an existing number would CLONE it (getStop must 404 first)`)
    }
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
 * move releases its SOURCE (without the stop) before its DESTINATION plans it —
 * a "steal" is not merely untested: an import entry for a stop still planned on
 * another load is PROVEN to CLONE a new record (Jul 2 2026), and even insertStops
 * on a still-planned stop is not relied on. Entries:
 * [{ loadNbr, arrivalsFrom?: [loadNbr,…] }] where arrivalsFrom lists the loads
 * this entry receives stops FROM. Pure Kahn's topological sort; loads that only
 * release (or cancel) have no arrivals and sort first naturally. A genuine cycle
 * (a two-load swap) is refused — save it as two steps.
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
