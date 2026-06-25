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
//   getStop/getLoad -> GET reads for live readback

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

// Build a NuVizz stop (order) payload from a flat form row + shared settings.
// NOTE: intentionally NO shipForBP and NO profile — the open import rejects the
// internal values ("ShipForBP is Invalid" / "profile … does not exist").
export function buildStopPayload(row, s) {
  const stopNbr = clean(row.stopNbr) || clean(row.pro) || `ORD-${row._seq ?? ''}`
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
      address: {
        addressType: 'COM',
        name: s.originName,
        addr1: s.originAddr1,
        city: s.originCity,
        state: s.originState,
        zip: s.originZip,
        country: 'USA',
      },
      schedule: sched(s.serviceDate, '08:00:00', '12:00:00', s.timeZone),
    },
    to: {
      address: {
        addressType: 'COM',
        name: clean(row.name),
        addr1: clean(row.addr1),
        addr2: clean(row.addr2),
        city: clean(row.city),
        state: clean(row.state),
        zip: clean(row.zip),
        country: 'USA',
      },
      schedule: sched(s.serviceDate, '12:00:00', '17:00:00', s.timeZone),
    },
  }
}

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

// Normalize a /load/info body into { loadId, loadNbr, routeName, status, versionId, stops:[{stopId,stopNbr,...}] }
export function normalizeLoad(resp) {
  const d = resp?.data ?? resp
  const L = (d && (d.Load || d.load)) || d || {}
  const h = L.loadHeader || {}
  const stops = (L.stops || []).map((s) => {
    const st = s.stop || s
    return { stopId: st.stopId, stopNbr: st.stopNbr, stopSeq: st.stopSeq, stopType: st.stopType }
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
