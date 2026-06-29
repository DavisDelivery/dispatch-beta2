'use strict'

// Load → driver assignments, server-side (Netlify Blobs) so they sync across
// devices like the orders registry. This is a BOARD-LEVEL association (which
// driver is responsible for which load) — it is NOT yet pushed to NuVizz as a
// dispatch/tender (that's a separate authorized write; the captured roster is
// also the prod DAVIS tenant while we write to UAT). Map shape: { [loadNbr]: userName }.
//
// GET                              -> { assignments: {...} }
// POST { loadNbr, driverUserName } -> set (empty/null clears) -> { assignments }

const { getStore } = require('@netlify/blobs')

const KEY = 'loads:drivers'

function store() {
  try {
    return getStore('data')
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN
    if (siteID && token) return getStore({ name: 'data', siteID, token })
    throw e
  }
}

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) }
}

async function read() {
  const v = await store().get(KEY, { type: 'json' })
  return v && v.assignments && typeof v.assignments === 'object' ? v.assignments : {}
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      return json(200, { assignments: await read() })
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' })

    const { loadNbr, driverUserName } = JSON.parse(event.body || '{}')
    if (!loadNbr) return json(400, { error: 'needs loadNbr' })
    const cur = await read()
    if (driverUserName) cur[loadNbr] = driverUserName
    else delete cur[loadNbr]
    await store().setJSON(KEY, { assignments: cur, updatedAt: Date.now() })
    return json(200, { assignments: cur })
  } catch (e) {
    return json(500, { error: (e && e.message) || 'assignments store error' })
  }
}
