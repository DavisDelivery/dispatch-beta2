// Scheduled background refresh — keeps the warm fleet cache (Netlify Blobs) hot
// so __fleet / __fleetstops / __driver read in <1s off the request path.
//
// The "-background" suffix gives this the long (15-min) execution budget; the
// `config.schedule` makes it a cron. Mirrors the dispatch-map approach, but
// writes Netlify Blobs instead of Firestore so beta2 stays standalone.
//
// READ-ONLY against NuVizz: it only scans loads and writes the Blobs cache.

import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const nuvizz = require('./lib/nuvizz.cjs')

export const config = { schedule: '*/5 * * * *' } // every 5 minutes

export default async function handler() {
  const now = new Date()

  // Kill switch: when the app is in mock/disabled mode, make NO NuVizz calls.
  if (process.env.VITE_USE_MOCK_NUVIZZ === 'true') {
    console.log('fleet-refresh skipped (mock/disabled)', now.toISOString())
    return new Response(JSON.stringify({ skipped: 'disabled', at: now.toISOString() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const dow = now.getUTCDay() // 0 Sun .. 6 Sat

  // Davis dispatches zero loads on weekends; skip the scan entirely.
  if (dow === 0 || dow === 6) {
    console.log('fleet-refresh skipped (weekend UTC)', now.toISOString())
    return new Response(JSON.stringify({ skipped: 'weekend', at: now.toISOString() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const today = now.toISOString().slice(0, 10)
  try {
    const stats = await nuvizz.refreshFleetCache({ date: today })
    console.log('fleet-refresh', JSON.stringify(stats))
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch (err) {
    // A failed tick must not crash the scheduler — log and return 200.
    console.error('fleet-refresh failed', err && err.message)
    return new Response(JSON.stringify({ error: err && err.message, date: today }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}
