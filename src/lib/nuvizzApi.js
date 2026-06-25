// Client-side data access for the NuVizz read endpoints.
//
// LIVE ONLY: hit the single Netlify Function, which does the server-side v7 read
// (stateless HTTP Basic, live range-scan, read-only). The environment (production
// vs UAT) is chosen entirely by the function's server env vars.
//
// All three shapes mirror the server payloads:
//   fetchFleet      -> { date, count, loads: [summary...] }
//   fetchFleetStops -> { date, count, stops: [flattened...] }
//   fetchDriver     -> { date, userName, loads, stops }

const FN_URL = '/.netlify/functions/nuvizz'

// Strip per-load stops and attach the derived progress counts — exactly what the
// live __fleet endpoint returns.
export function summarizeLoad(load) {
  const stops = Array.isArray(load.stops) ? load.stops : []
  const { stops: _omit, ...rest } = load
  return {
    ...rest,
    stopCount: stops.length,
    stopsDelivered: stops.filter((s) => s.stopStatus === 90).length,
    stopsExceptions: stops.filter((s) => s.trueException).length,
  }
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.error ? data.error : `Request failed (${res.status})`)
  }
  return data
}

export async function fetchFleet({ date = 'today' } = {}) {
  return getJson(`${FN_URL}?path=__fleet&date=${encodeURIComponent(date)}`)
}

export async function fetchFleetStops({ date = 'today' } = {}) {
  return getJson(`${FN_URL}?path=__fleetstops&date=${encodeURIComponent(date)}`)
}

export async function fetchDriver({ date = 'today', userName } = {}) {
  return getJson(
    `${FN_URL}?path=__driver&date=${encodeURIComponent(date)}&userName=${encodeURIComponent(userName)}`,
  )
}

// Full load (summary + stops) for the Loads detail drawer.
export async function fetchLoadDetail({ loadNbr } = {}) {
  return getJson(`${FN_URL}?path=__refreshLoad&loadNbr=${encodeURIComponent(loadNbr)}`)
}
