'use strict'

// WRITE proxy for the NuVizz v7 API — the separately-authorized write-back phase.
//
// Design for a PUBLIC site:
//   - Stores NO NuVizz credentials. The caller (the Builder UI) supplies Basic
//     auth creds per request; this function only forwards them. So an anonymous
//     visitor with no creds cannot mutate anything.
//   - UAT host only (hard-coded base) — it can never reach production NuVizz.
//   - Op allowlist — it is not an open forward proxy; only the five write/read
//     ops below are permitted.
//   - Gated by NUVIZZ_WRITE_ENABLED. When that env var is not exactly 'true',
//     every call returns 403. Flip it off to fully disable writes site-wide.
//
// This is intentionally separate from the read function (netlify/functions/nuvizz.cjs)
// and does not touch the read paths or the warm cache.

const UAT_BASE = 'https://uat.nuvizz.com/deliverit/openapi/v7'

const counter = require('./lib/callCounter.cjs')

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  }
}

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
}

// GET/POST helper against the UAT v7 surface with the caller-supplied Basic auth.
// Every call here is one real upstream NuVizz round-trip → count it (best-effort,
// never blocks the write) before the fetch so even a thrown fetch is reflected.
async function nuvizz(method, path, auth, body) {
  try {
    await counter.recordCall(path)
  } catch {
    /* counter is best-effort */
  }
  const res = await fetch(`${UAT_BASE}/${path}`, {
    method,
    headers: {
      authorization: auth,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

// Map a /load/info loadHeader into the /load/edit header shape. load/edit is a
// FULL replace — echo every field back or it gets blanked (depot/volume etc.).
function toEditHeader(h) {
  if (!h) return {}
  return {
    loadId: h.loadId,
    routeName: h.routeName,
    routeDesc: h.routeDesc || '',
    scheduleStartDttm: h.earliestStartDttm,
    scheduleEndDttm: h.latestStartDttm,
    signatureRequired: !!h.signatureRequired,
    rtOrigin: h.rtOrigin,
    depot: h.depot,
    facility: h.facility,
    masterBol: h.masterBol || '',
    pronbr: h.pronbr || '',
    reference: h.reference || '',
    reference2: h.reference2 || '',
    reference3: h.reference3 || '',
    sealNbr: h.sealNbr || '',
    totalCartons: h.totalCartons,
    totalPallets: h.totalPallets,
    vehicleType: h.vehicleType,
    volume: h.volume,
    volumeUOM: h.volumeUOM,
    weight: h.weight,
    weightUOM: h.weightUOM,
    cusAccNbr: h.cusAccNbr || '',
    returnToDepot: h.returnToDepot,
    congestionFactor: h.congestionFactor,
    sourceType: h.sourceType,
    customAttributes: h.customAttributes || [],
    maxRouteTime: h.maxRouteTime,
    shiftType: h.shiftType,
    maxDistMiles: h.maxDistMiles,
    cutOffTime: h.cutOffTime,
    seqMode: 'None',
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' })

  // Site-wide kill switch — writes are OFF unless explicitly enabled.
  if (process.env.NUVIZZ_WRITE_ENABLED !== 'true') {
    return json(403, { error: 'Write mode is disabled (set NUVIZZ_WRITE_ENABLED=true).' })
  }

  let req
  try {
    req = JSON.parse(event.body || '{}')
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  const { op, companyCode, username, password } = req
  if (!op) return json(400, { error: 'Missing op' })
  if (!companyCode || !username || !password) {
    return json(400, { error: 'Missing credentials (companyCode, username, password)' })
  }
  // Defensive: this surface is UAT-only by base URL; also reject obvious prod tenants.
  if (String(companyCode).toUpperCase() === 'DAVIS') {
    return json(400, { error: 'This tool is UAT-only; the production tenant is not allowed.' })
  }

  const auth = basicAuth(username, password)
  const cc = encodeURIComponent(companyCode)

  try {
    switch (op) {
      case 'getStop': {
        const { stopNbr } = req
        if (!stopNbr) return json(400, { error: 'getStop needs stopNbr' })
        const r = await nuvizz('GET', `stop/info/${encodeURIComponent(stopNbr)}/${cc}`, auth)
        return json(200, r)
      }
      case 'getLoad': {
        const { loadNbr } = req
        if (!loadNbr) return json(400, { error: 'getLoad needs loadNbr' })
        const r = await nuvizz('GET', `load/info/${encodeURIComponent(loadNbr)}/${cc}`, auth)
        return json(200, r)
      }
      case 'createStop': {
        const { stop } = req
        if (!stop || !stop.stopNbr) return json(400, { error: 'createStop needs stop.stopNbr' })
        const r = await nuvizz('POST', `stop/sync/update/${cc}`, auth, { companyCode, stop })
        return json(200, r)
      }
      case 'insertStops': {
        const { loadId, insertStopIds } = req
        if (!loadId || !Array.isArray(insertStopIds) || !insertStopIds.length) {
          return json(400, { error: 'insertStops needs loadId and insertStopIds[]' })
        }
        const r = await nuvizz('POST', `load/insertstops/${cc}`, auth, { insertStopIds, loadId })
        return json(200, r)
      }
      case 'removeStops': {
        // Read the load, echo its full header back, attach removeStopIds.
        const { loadNbr, removeStopIds } = req
        if (!loadNbr || !Array.isArray(removeStopIds) || !removeStopIds.length) {
          return json(400, { error: 'removeStops needs loadNbr and removeStopIds[]' })
        }
        const info = await nuvizz('GET', `load/info/${encodeURIComponent(loadNbr)}/${cc}`, auth)
        const L = (info.data && (info.data.Load || info.data.load)) || info.data || {}
        const header = L.loadHeader
        if (!header) return json(400, { error: `Load ${loadNbr} not found`, detail: info.data })
        const payload = {
          loadHeader: toEditHeader(header),
          removeStopIds,
          routeSeq: [],
          versionId: String(L.versionId || ''),
        }
        const r = await nuvizz('POST', `load/edit/${cc}`, auth, payload)
        return json(200, r)
      }
      default:
        return json(400, { error: `Unknown op "${op}"` })
    }
  } catch (err) {
    return json(502, { error: (err && err.message) || 'Upstream error' })
  }
}
