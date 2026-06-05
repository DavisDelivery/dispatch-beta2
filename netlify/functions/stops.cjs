'use strict'

// GET /.netlify/functions/stops?horizon=today
// Returns normalized, READ-ONLY NuVizz stop records for the requested horizon.
// This is the ONLY HTTP surface exposed by the function dir; nuvizz.cjs lives in
// ./lib and is shared code (not a deployed endpoint).

const { getStops, NuvizzError } = require('./lib/nuvizz.cjs')

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  }
}

exports.handler = async (event) => {
  const horizon =
    (event.queryStringParameters && event.queryStringParameters.horizon) || 'today'

  try {
    const stops = await getStops({ horizon })
    return json(200, {
      stops,
      meta: {
        horizon,
        count: stops.length,
        source: 'nuvizz-v7-live',
        generatedAt: new Date().toISOString(),
      },
    })
  } catch (err) {
    // CONFIG (missing env) -> 500 so Chad sees exactly what's unset before
    // secrets are wired. Upstream/auth issues -> 502.
    const isConfig = err instanceof NuvizzError && err.code === 'CONFIG'
    return json(isConfig ? 500 : 502, {
      error: err.message,
      stops: [],
      meta: { horizon, source: 'nuvizz-v7-live', count: 0 },
    })
  }
}
