'use strict'

/**
 * NuVizz API call counter — modeled on davis-nuvizz's `nuvizz_ops` design.
 *
 * Counts EVERY upstream NuVizz HTTP round-trip (success or failure) at the single
 * write-function chokepoint. Persisted per ET day in Netlify Blobs so the displayed
 * "calls today" follows a midnight-to-midnight America/New_York day (a new ET day =
 * a new blob key, so reset is implicit — no reset job).
 *
 * Blobs has no atomic increment, so this is a graceful read-modify-write. Our write
 * volume is tiny (a handful of calls per action), so a lost concurrent race just
 * under-counts by one — acceptable for a budget gauge. Every Blobs op is wrapped:
 * a missing/broken cache must NEVER fail or block a write.
 *
 * Shape (blob key `calls:<YYYY-MM-DD>`): { date, count, byRoute:{}, byHour:{} }
 * Mode/ceiling mirror davis: monitor (default) just shows; enforce is reserved.
 */

const { getStore } = require('@netlify/blobs')

const DEFAULT_CEILING = 1000

function store() {
  try {
    return getStore('ops')
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN
    if (siteID && token) return getStore({ name: 'ops', siteID, token })
    throw e
  }
}

// America/New_York calendar day "YYYY-MM-DD" — keep the counter on an ET day so
// post-UTC-midnight calls don't inflate tomorrow.
function etDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
function etHour(d = new Date()) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(d)
  return String(Number(h) % 24).padStart(2, '0')
}

// Coarse route label for the per-route breakdown (e.g. "load/insertstops").
function routeOf(path) {
  const segs = String(path || '').split('/').filter(Boolean)
  return segs.slice(0, 2).join('/') || 'other'
}

function ceiling() {
  const n = Number(process.env.NUVIZZ_DAILY_CEILING)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CEILING
}
function mode() {
  return (process.env.NUVIZZ_BREAKER_MODE || '').toLowerCase() === 'enforce' ? 'enforce' : 'monitor'
}

const empty = (date) => ({ date, count: 0, byRoute: {}, byHour: {} })

// Increment the counter for one upstream call. Best-effort; returns new total or null.
async function recordCall(path) {
  const date = etDay()
  const route = routeOf(path)
  const hour = etHour()
  try {
    const s = store()
    const cur = (await s.get('calls:' + date, { type: 'json' })) || empty(date)
    cur.date = date
    cur.count = (cur.count || 0) + 1
    cur.byRoute = cur.byRoute || {}
    cur.byHour = cur.byHour || {}
    cur.byRoute[route] = (cur.byRoute[route] || 0) + 1
    cur.byHour[hour] = (cur.byHour[hour] || 0) + 1
    await s.setJSON('calls:' + date, cur)
    return cur.count
  } catch {
    return null
  }
}

// Read today's counter as an `ops` object for the UI. Best-effort.
async function readOps() {
  const date = etDay()
  let cur = empty(date)
  try {
    cur = (await store().get('calls:' + date, { type: 'json' })) || empty(date)
  } catch {
    /* blobs unavailable -> zeros */
  }
  return {
    date,
    dayCount: cur.count || 0,
    byRoute: cur.byRoute || {},
    byHour: cur.byHour || {},
    ceiling: ceiling(),
    mode: mode(),
    breaker: false,
  }
}

module.exports = { recordCall, readOps, etDay }
