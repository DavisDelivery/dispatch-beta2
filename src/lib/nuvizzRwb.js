// Route Workbench (RWB) client — the portal-session 2-call reorder, cracked + proven
// (byte-for-byte data integrity, UAT Jul 2026). Talks to netlify/functions/nuvizz-rwb.cjs.
//
// The clean openapi API cannot control stop order without a heavy per-stop import that
// risks blanking freight fields. RWB's saveComparedRouteData sets the whole sequence in
// ONE call and references stops by id (it never rewrites the stop record, so skids / item
// descriptions / addresses cannot be lost). Cost: 2 upstream calls per reorder
// (fetchUpdatedJson + saveComparedRouteData), flat regardless of stop count.
//
// MODE: gated behind an explicit "RWB mode" toggle so it's obvious when the 2-call path
// is live vs the legacy two-lever import engine. State in localStorage `dd_rwb_mode`.

const RWB_FN = '/.netlify/functions/nuvizz-rwb'

// UAT portal config. The DAVIS prod switch is a single object swap
// (loginBase→login.nuvizz.com, companyCode→davis, company→DAVIS, portalBase→portal.nuvizz.com).
export const RWB_CFG = {
  loginBase: 'https://loginqa.nuvizz.com',
  companyCode: 'davisv5',
  company: 'DAVISV5',
  portalBase: 'https://uat.nuvizz.com',
}

// The Davis Buford depot — every route shares this origin (matches rtOrigin in UAT), so
// we never need an extra getLoad just to learn the route's start point.
export const RWB_ORIGIN = { lat: 34.04446, lng: -83.71669 }

const MODE_KEY = 'dd_rwb_mode'
export function rwbEnabled() {
  try {
    return localStorage.getItem(MODE_KEY) === 'on'
  } catch {
    return false
  }
}
export function setRwbEnabled(on) {
  try {
    localStorage.setItem(MODE_KEY, on ? 'on' : 'off')
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new Event('dd-rwb-mode'))
  } catch {
    /* ignore */
  }
}

async function rwbCall(extra) {
  const res = await fetch(RWB_FN, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...RWB_CFG, ...extra }),
  })
  const body = await res.json().catch(() => ({}))
  // Every RWB round-trip is counted server-side; nudge the topbar pill to refresh.
  try {
    window.dispatchEvent(new Event('dd-api-call'))
  } catch {
    /* ignore */
  }
  return body
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }
// Turn fetchUpdatedJson's schStartTime.dttm ("Jun 30, 2026, 8:00:00 AM") into the
// portal's route-window format ("06/30/2026 08:00:00 am GMT-04:00"). Summer ET = -04:00
// (the beta operates in EDT); a start/end pair is echoed so the save isn't a partial write.
function routeWindow(dttm) {
  const m = String(dttm || '').match(/^(\w{3})\s+(\d{1,2}),\s+(\d{4})/)
  if (!m) return null
  const mm = MONTHS[m[1]]
  if (!mm) return null
  const dd = String(m[2]).padStart(2, '0')
  const yyyy = m[3]
  const date = `${mm}/${dd}/${yyyy}`
  return { start: `${date} 08:00:00 am GMT-04:00`, end: `${date} 11:59:00 pm GMT-04:00` }
}

// Sequence a load's stops to EXACTLY `orderedStopIds` (delivery-from-depot model: all
// pickups happen at the depot, then dropoffs in the given order). Two upstream calls.
// Returns { ok, message, calls, order? }.
export async function rwbSequenceStops({ routePlanId, orderedStopIds, origin = RWB_ORIGIN }) {
  const ids = [...new Set((orderedStopIds || []).map((x) => String(x)).filter(Boolean))]
  if (!routePlanId) return { ok: false, message: 'RWB reorder needs the load id (routePlanId).', calls: 0 }
  if (ids.length < 2) return { ok: false, message: 'Need 2+ stops to sequence.', calls: 0 }
  const stoplist = [...ids.map((id) => id + '_PU'), ...ids.map((id) => id + '_DO')].join(',')

  // 1) fetchUpdatedJson — recompute the route in the desired order (read-only preview).
  const fujForm = { originLat: String(origin.lat), originLng: String(origin.lng), originOption: '02', stoplist, routePlanId, returnToDepot: 'NEVER', computeLatestEta: 'true' }
  const fr = await rwbCall({ op: 'rwb', method: 'POST', path: 'dirouteworkbench/routePlan/fetchUpdatedJson', form: fujForm })
  if (fr && fr.ok === false && fr.error) return { ok: false, message: `RWB login failed: ${fr.error}`, calls: 1 }
  let d = fr && fr.body
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d)
    } catch {
      /* keep */
    }
  }
  const o = Array.isArray(d) ? d[0] : d
  if (!o || !Array.isArray(o.etaStopVOList)) return { ok: false, message: `fetchUpdatedJson failed (status ${fr && fr.status}).`, calls: 1 }

  // 2) saveComparedRouteData — PERSIST the new order. FULL payload echo: the fields whose
  // omission cancelled a load in an early test (tripDataJsonArray / list / totalData /
  // totalTrips / route window) are all present. The save references stops by id only —
  // stop records (freight, addresses, item lines) are never rewritten.
  const win = routeWindow(o.schStartTime && o.schStartTime.dttm)
  const routeJson = [{
    routePlanId,
    originLat: origin.lat,
    originLong: origin.lng,
    routeEndTime: win ? win.end : '',
    routeStartTime: win ? win.start : '',
    routeDistance: o.distance,
    transitTime: o.duration,
    totalTrips: ids.length,
    totalData: { totalP: 0, totalC: 0, totalW: 0, totalV: 0, weightUOM: 'Lbs', volumeUOM: 'Loose' },
    IdleTime: o.idleTime || 0,
    buildType: '02',
    isStandingRoute: false,
    seqMode: 'Manual',
    deadHeadMins: o.deadHeadMins,
    deadHeadMiles: o.deadHeadMiles,
    tripDataJsonArray: ids,
    list: 'list1',
    stopDataJsonArray: [...ids, ...ids].map((id, i) => ({
      stopId: id + (i < ids.length ? '_PU' : '_DO'),
      plannedETA: '',
      routePlanId,
      etaCode: '',
      timeLapse: '',
      tripId: id,
      timeZone: (o.etaStopVOList[0] && o.etaStopVOList[0].timeZone) || 'America/New_York',
    })),
  }]
  const sr = await rwbCall({ op: 'rwb', method: 'POST', path: 'dirouteworkbench/routePlan/saveComparedRouteData', form: { routeJsonData: JSON.stringify(routeJson), planningMode: 'true' } })
  const okSave = sr && (sr.ok === true || (sr.body && sr.body.responseCode === 200) || sr.status === 200)
  if (!okSave) return { ok: false, message: `saveComparedRouteData failed (status ${sr && sr.status}).`, calls: 2 }
  return { ok: true, message: `Sequenced ${ids.length} stop(s) via RWB (2 calls).`, calls: 2, order: ids }
}

// Probe the portal login (no mutation) — used by the mode toggle to confirm the session
// works before Chad relies on it. 1 upstream call after login.
export async function rwbProbe() {
  const r = await rwbCall({ op: 'probe' })
  return { ok: !!(r && r.ok), getFilter: r && r.getFilter, steps: (r && r.steps) || [], error: r && r.error }
}
