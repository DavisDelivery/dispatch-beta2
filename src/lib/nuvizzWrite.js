// Client access for the NuVizz WRITE proxy (netlify/functions/nuvizz-write.cjs).
//
// Credentials are supplied per call (held only in the Builder page's state /
// sessionStorage), never bundled or stored server-side. Every call posts to the
// single gated function, which forwards to the UAT v7 API.
//
// Endpoints exercised (all UAT, Basic auth, server-to-server):
//   createStop   -> POST /stop/sync/update/{cc}   (create/upsert an order)
//   insertStops  -> POST /load/insertstops/{cc}   (attach existing stops to a load)
//   removeStops  -> POST /load/edit/{cc}          (unplan stops; full-header echo)
//   importLoads  -> POST /load/update/default/{cc} (§10.1 batch sequencing import)
//   cancelLoad   -> POST /load/cancel/{cc}        (retire/empty a load cleanly)
//   getStop/getLoad -> GET reads for live readback + import convergence

const WRITE_FN = '/.netlify/functions/nuvizz-write'

async function call(op, creds, args = {}) {
  const res = await fetch(WRITE_FN, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, ...creds, ...args }),
  })
  const data = await res.json().catch(() => ({}))
  // Each call is ≥1 upstream NuVizz round-trip (the server counted it) — nudge the
  // call-counter pill to refetch.
  try {
    window.dispatchEvent(new Event('dd-api-call'))
  } catch {
    /* non-browser */
  }
  if (!res.ok) {
    throw new Error(data?.error ? data.error : `Write request failed (${res.status})`)
  }
  return data // { status, data } from the upstream NuVizz call (or a read body)
}

const clean = (v) => (v == null ? undefined : String(v).trim() || undefined)
// NuVizz caps the consignee name at 50 chars; trim so a long name doesn't 400.
const clip = (v, n) => (v == null ? v : String(v).slice(0, n))
const num = (v) => {
  if (v == null || v === '') return undefined
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

const sched = (date, from, to, tz) => ({
  timeFrom: `${date}T${from}`,
  timeTo: `${date}T${to}`,
  timeZone: tz || 'America/New_York',
  timeConstraint: 'PREFERRED',
})

// --- Delivery (ETA) windows -------------------------------------------------
// Each stop gets a 30-minute delivery slot, staggered by its visit position
// (index 0 -> 08:00–08:30, 1 -> 08:30–09:00, …). This is the APPOINTMENT/ETA the
// driver sees — it is NOT the ordering lever. Rigorous live testing showed NuVizz
// re-optimizes a bulk insert GEOGRAPHICALLY and ignores delivery windows entirely;
// visit order is set only by one-at-a-time insertion (see usePlanning). We keep the
// slots aligned to the chosen sequence so the ETA matches the route position. The
// origin/pickup window must sit before every delivery slot (NuVizz rejects
// from > to), so it's pinned to early morning.
const FIRST_DELIVERY = '08:00' // first delivery slot start (local)
const SLOT_MIN = 30 // minutes per stop
const ORIGIN_WINDOW = { from: '06:00:00', to: '07:00:00' } // before all delivery slots

// Default pickup/origin — the Davis warehouse. Used when a settings origin or a
// read-back origin is unavailable.
export const DEFAULT_ORIGIN = {
  name: 'ULINEUAT',
  addr1: '943 GAINESVILLE HWY',
  addr2: '200-400',
  city: 'BUFORD',
  state: 'GA',
  zip: '30518',
}

const pad2 = (n) => String(n).padStart(2, '0')
const hhmmToMin = (s) => {
  const [h, m] = String(s).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
const minToHms = (t) => {
  const c = Math.max(0, Math.min(t, 23 * 60 + 30)) // clamp inside the day
  return `${pad2(Math.floor(c / 60))}:${pad2(c % 60)}:00`
}

// 30-minute delivery slot for a 0-based visit index (the order's position).
export function deliverySlot(index, { first = FIRST_DELIVERY, minutes = SLOT_MIN } = {}) {
  const start = hhmmToMin(first) + (index | 0) * minutes
  return { from: minToHms(start), to: minToHms(start + minutes) }
}

// NuVizz returns some states as full names ("GEORGIA"); the create wants the
// 2-letter abbreviation. Pass-through anything already ≤2 chars.
const US_STATES = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS',
  KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT',
  NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX',
  UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI', WYOMING: 'WY',
}
export const abbrState = (s) => {
  if (!s) return s
  const u = String(s).trim().toUpperCase()
  return u.length <= 2 ? u : US_STATES[u] || u.slice(0, 2)
}

const addrPayload = (a) => ({
  addressType: 'COM',
  name: clip(clean(a.name), 50),
  addr1: clean(a.addr1),
  addr2: clean(a.addr2),
  city: clean(a.city),
  state: abbrState(clean(a.state)),
  zip: clean(a.zip),
  country: 'USA',
})

// Build a NuVizz stop (order) payload from a flat form row + shared settings.
// NOTE: intentionally NO shipForBP and NO profile — the open import rejects the
// internal values ("ShipForBP is Invalid" / "profile … does not exist").
export function buildStopPayload(row, s) {
  const stopNbr = clean(row.stopNbr) || clean(row.pro) || `ORD-${row._seq ?? ''}`
  // Each stop gets a 30-minute delivery window staggered by its row position — the
  // appointment/ETA shown to the driver (NOT the ordering lever; see §10). The
  // pickup window is pinned to early morning (before every delivery slot).
  const slot = deliverySlot(row._index ?? 0)
  return {
    stopNbr,
    stopType: 'DO',
    shipmentType: 'REG',
    stopExecution: 'APP',
    sourceType: 'INTG',
    shipmentNbr: clean(row.pro),
    proNumber: clean(row.pro),
    reference1: clean(row.pro) ? `PRO ${clean(row.pro)}` : undefined,
    totalPallets: num(row.pallets),
    totalCartons: num(row.cartons),
    weight: num(row.weight),
    weightUOM: s.weightUOM || 'LBS',
    from: {
      address: addrPayload({
        name: clean(s.originName) || DEFAULT_ORIGIN.name,
        addr1: clean(s.originAddr1) || DEFAULT_ORIGIN.addr1,
        addr2: clean(s.originAddr2) || DEFAULT_ORIGIN.addr2,
        city: clean(s.originCity) || DEFAULT_ORIGIN.city,
        state: clean(s.originState) || DEFAULT_ORIGIN.state,
        zip: clean(s.originZip) || DEFAULT_ORIGIN.zip,
      }),
      schedule: sched(s.serviceDate, ORIGIN_WINDOW.from, ORIGIN_WINDOW.to, s.timeZone),
    },
    to: {
      address: addrPayload({
        name: clean(row.name),
        addr1: clean(row.addr1),
        addr2: clean(row.addr2),
        city: clean(row.city),
        state: clean(row.state),
        zip: clean(row.zip),
      }),
      schedule: sched(s.serviceDate, slot.from, slot.to, s.timeZone),
    },
  }
}

// NOTE: the old `setStopWindow` helper (a full stop/sync/update upsert that
// re-stamped a stop's delivery slot) was REMOVED with the §10.1 import migration:
// delivery windows now ride INSIDE the load-import payload (see lib/loadImport.js
// importRefFromRaw), so the sequencing path makes no separate per-stop window
// writes. That also retires the field-blanking hazard — the upsert replaced the
// whole stop, so omitting proNumber/pallets/weight BLANKED them; an import
// reference leaves the stop's other fields intact.

// Pull a friendly success/error summary out of the upstream NuVizz response.
export function summarize(resp) {
  const d = resp?.data ?? resp
  if (d == null) return { ok: false, message: 'No response' }
  if (typeof d === 'string') return { ok: resp.status >= 200 && resp.status < 300, message: d }
  const created = d.apiResult && (d.apiResult.created || d.apiResult.updated)
  const ent = d.entityInfoList && d.entityInfoList[0]
  if (created && ent) return { ok: true, message: d.status || 'OK', entityId: ent.entityId, entityNbr: ent.entityNbr }
  if (d.status === 'SUCCESS' || (resp.status >= 200 && resp.status < 300 && !d.reasons && !d.error)) {
    return { ok: true, message: d.status || 'OK' }
  }
  const msg =
    d?.reasons?.[0]?.description ||
    d?.apiResult?.errors?.[0]?.msgs?.join('; ') ||
    d?.error ||
    d?.message ||
    JSON.stringify(d).slice(0, 200)
  return { ok: false, message: msg }
}

export const createOrder = (creds, stop) => call('createStop', creds, { stop })
export const getStop = (creds, stopNbr) => call('getStop', creds, { stopNbr })
export const getLoad = (creds, loadNbr) => call('getLoad', creds, { loadNbr })
export const insertStops = (creds, loadId, insertStopIds) =>
  call('insertStops', creds, { loadId, insertStopIds })
export const removeStops = (creds, loadNbr, removeStopIds) =>
  call('removeStops', creds, { loadNbr, removeStopIds })
export const assignDriver = (creds, loadId, driverId) =>
  call('assignDriver', creds, { loadId, driverId })
export const dispatchLoad = (creds, loadId) => call('dispatchLoad', creds, { loadId })
// The async LOAD IMPORT (§10.1) — one POST load/update/default/{cc} per touched
// load sets its complete stop list in exact stops[] array order. The 200 ack is
// async ("Async import is SUCCESS") and does NOT mean it landed — callers MUST run
// the convergence read-back (see src/lib/loadImportEngine.js).
export const importLoads = (creds, loads, serviceName) =>
  call('loadImport', creds, { loads, ...(serviceName ? { serviceName } : {}) })
// Cancel (retire) a load cleanly — the ONLY sanctioned way to empty one (an empty
// stops[] import is never sent; the old remove-all path cancelled implicitly).
export const cancelLoad = (creds, { loadNbr, loadId, reasonCode, reasonComments } = {}) =>
  call('cancelLoad', creds, { loadNbr, loadId, reasonCode, reasonComments })

// assignanddispatch returns { status: 'Success', reasons: [] } — summarize()
// keys on 'SUCCESS', so check this shape directly.
export function assignOk(resp) {
  const d = resp?.data ?? resp
  if (d == null) return { ok: false, message: 'No response' }
  if ((d.status || '').toLowerCase() === 'success') return { ok: true, message: 'Dispatched' }
  const msg = d?.reasons?.[0]?.description || d?.error || d?.message || JSON.stringify(d).slice(0, 200)
  return { ok: false, message: msg }
}

// Normalize a /load/info body into { loadId, loadNbr, routeName, status, versionId, stops:[{stopId,stopNbr,...}] }
export function normalizeLoad(resp) {
  const d = resp?.data ?? resp
  const L = (d && (d.Load || d.load)) || d || {}
  const h = L.loadHeader || {}
  const stops = (L.stops || []).map((s) => {
    const st = s.stop || s
    // seq = the authoritative route stop sequence (stop.to.seq); array order is unreliable.
    return { stopId: st.stopId, stopNbr: st.stopNbr, stopSeq: st.stopSeq, seq: st.to?.seq ?? null, stopType: st.stopType }
  })
  return {
    loadId: h.loadId,
    loadNbr: h.loadNbr,
    routeName: h.routeName,
    status: L.loadExecutionInfo?.loadStatus,
    versionId: L.versionId,
    stops,
  }
}

// Normalize a /stop/info body into a compact view.
export function normalizeStop(resp) {
  const d = resp?.data ?? resp
  const S = (d && d.Stop) || d || {}
  const st = S.stop || {}
  const exec = S.stopExecutionInfo || {}
  const addr = st.to?.address || {}
  const num = (v) => (v == null || v === '' ? null : Number(v))
  return {
    stopId: st.stopId,
    stopNbr: st.stopNbr,
    stopType: st.stopType,
    status: exec.stopStatus,
    assignedLoadNbr: S.load?.loadNbr,
    assignedRouteName: S.load?.routeName,
    toName: addr.name,
    toCity: addr.city,
    toState: addr.state,
    latitude: num(addr.latitude ?? addr.lat),
    longitude: num(addr.longitude ?? addr.lng ?? addr.lon),
    products: Array.isArray(st.stopDetails) ? st.stopDetails.length : 0,
  }
}
