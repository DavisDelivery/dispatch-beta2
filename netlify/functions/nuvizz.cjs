'use strict'

// GET /.netlify/functions/nuvizz?path=__fleet&date=YYYY-MM-DD
//   path=__fleet                          -> per-load summaries for the date (Loads)
//   path=__fleetstops                     -> flat array of ALL stops for the date (Stops)
//   path=__driver&userName=X              -> one driver's loads + stops for the date
//   path=__refreshLoad&loadNbr=DAVIS00... -> single live /load/info refresh
//   path=__refreshFleet                   -> warm the Blobs cache (scan + write)
//
// This is the ONLY HTTP surface. The NuVizz read client lives in ./lib and is
// shared code (read-only; stateless HTTP Basic; live range-scan, no Firestore).
// MOCK mode (VITE_USE_MOCK_NUVIZZ=true) is served entirely client-side from the
// bundled fixture, so this function is never called without credentials.

const {
  getFleet,
  getFleetStops,
  getDriver,
  refreshLoad,
  refreshFleetCache,
  cacheDiagnose,
  NuvizzError,
} = require('./lib/nuvizz.cjs')

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  }
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {}
  const path = q.path || '__fleetstops'
  const date = q.date || 'today'

  try {
    let payload
    switch (path) {
      case '__fleet':
        payload = await getFleet({ date })
        break
      case '__fleetstops':
        payload = await getFleetStops({ date })
        break
      case '__driver':
        payload = await getDriver({ date, userName: q.userName })
        break
      case '__refreshLoad':
        payload = await refreshLoad({ loadNbr: q.loadNbr })
        break
      case '__refreshFleet':
        // Manual warm / debug: scans + writes the Blobs cache (never NuVizz).
        payload = await refreshFleetCache({ date })
        break
      case '__cacheDiag':
        // Read-only Blobs round-trip diagnostic (never calls NuVizz).
        payload = await cacheDiagnose({ date })
        break
      default:
        return json(400, { error: `Unknown path "${path}"` })
    }
    return json(200, {
      ...payload,
      meta: { path, source: 'nuvizz-v7-live', generatedAt: new Date().toISOString() },
    })
  } catch (err) {
    // CONFIG (missing env) -> 500 so Chad sees exactly what's unset before
    // secrets are wired. Upstream issues -> 502.
    const isConfig = err instanceof NuvizzError && err.code === 'CONFIG'
    return json(isConfig ? 500 : 502, {
      error: err.message,
      meta: { path, source: 'nuvizz-v7-live' },
    })
  }
}
