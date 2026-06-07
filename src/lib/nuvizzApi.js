// Client-side data access for the NuVizz read endpoints.
//
// MOCK MODE (VITE_USE_MOCK_NUVIZZ=true): derive every shape from the bundled
// loads fixture, with NO credentials (first deploy preview + `npm run dev`).
// LIVE MODE: hit the single Netlify Function, which does the server-side v7 read
// (stateless HTTP Basic, live range-scan, read-only).
//
// All three shapes mirror the server payloads:
//   fetchFleet      -> { date, count, loads: [summary...] }
//   fetchFleetStops -> { date, count, stops: [flattened...] }
//   fetchDriver     -> { date, userName, loads, stops }

export const IS_MOCK = import.meta.env.VITE_USE_MOCK_NUVIZZ === 'true'

const FN_URL = '/.netlify/functions/nuvizz'
const MOCK_URL = '/test-fixtures/nuvizz-today-loads.json'

let mockCache = null
async function mockLoads() {
  if (!mockCache) {
    const res = await fetch(MOCK_URL, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Fixture load failed (${res.status})`)
    const data = await res.json()
    mockCache = Array.isArray(data) ? data : data.loads ?? []
  }
  return mockCache
}

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

function byPlannedEta(a, b) {
  const av = a.plannedEta
  const bv = b.plannedEta
  if (!av && !bv) return 0
  if (!av) return 1
  if (!bv) return -1
  return new Date(av).getTime() - new Date(bv).getTime()
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
  if (IS_MOCK) {
    const loads = await mockLoads()
    const summaries = loads.map(summarizeLoad)
    return { date, count: summaries.length, loads: summaries, mock: true }
  }
  return getJson(`${FN_URL}?path=__fleet&date=${encodeURIComponent(date)}`)
}

export async function fetchFleetStops({ date = 'today' } = {}) {
  if (IS_MOCK) {
    const loads = await mockLoads()
    const stops = loads.flatMap((l) => l.stops ?? []).slice().sort(byPlannedEta)
    return { date, count: stops.length, stops, mock: true }
  }
  return getJson(`${FN_URL}?path=__fleetstops&date=${encodeURIComponent(date)}`)
}

export async function fetchDriver({ date = 'today', userName } = {}) {
  if (IS_MOCK) {
    const loads = await mockLoads()
    const mine = loads.filter((l) => l.driverUserName === userName)
    const stops = mine.flatMap((l) => l.stops ?? []).slice().sort(byPlannedEta)
    return {
      date,
      userName,
      count: mine.length,
      loads: mine.map(summarizeLoad),
      stops,
      mock: true,
    }
  }
  return getJson(
    `${FN_URL}?path=__driver&date=${encodeURIComponent(date)}&userName=${encodeURIComponent(userName)}`,
  )
}

// Full load (summary + stops) for the Loads detail drawer.
export async function fetchLoadDetail({ loadNbr } = {}) {
  if (IS_MOCK) {
    const loads = await mockLoads()
    const load = loads.find((l) => l.loadNbr === loadNbr) ?? null
    if (!load) return { loadNbr, load: null }
    return { loadNbr, load: { ...summarizeLoad(load), stops: load.stops ?? [] } }
  }
  return getJson(`${FN_URL}?path=__refreshLoad&loadNbr=${encodeURIComponent(loadNbr)}`)
}
