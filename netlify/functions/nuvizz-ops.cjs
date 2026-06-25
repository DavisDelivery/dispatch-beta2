'use strict'

// Read-only telemetry endpoint: today's NuVizz API call counter.
// Reads ONLY from Netlify Blobs — it never calls NuVizz, so polling it is free
// and does not move the counter it reports.

const counter = require('./lib/callCounter.cjs')

exports.handler = async () => {
  let ops
  try {
    ops = await counter.readOps()
  } catch (e) {
    ops = { dayCount: 0, ceiling: 0, mode: 'monitor', breaker: false, error: (e && e.message) || String(e) }
  }
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(ops),
  }
}
