'use strict'

/**
 * Warm fleet cache — a thin, GRACEFUL wrapper over Netlify Blobs.
 *
 * In deployed Netlify Functions, Blobs is auto-provisioned (no env/keys). In
 * local/dev it is often unavailable. EVERY call here is wrapped so that any
 * failure degrades cleanly: reads return null (a miss -> live scan), writes are
 * swallowed. A missing/broken cache must NEVER crash a request.
 *
 * The last failure is recorded (not thrown) so the read-only `__cacheDiag`
 * endpoint can surface WHY Blobs is unavailable in production.
 *
 * Keys are per-date: "fleet:" + date and "stops:" + date.
 */

let cacheDisabled = false
let lastError = null

// TOP-LEVEL import so Netlify's build statically detects Blobs usage and
// auto-provisions the runtime context. A lazy require() buried inside a function
// can evade that detection, leaving NETLIFY_BLOBS_CONTEXT un-injected
// (MissingBlobsEnvironmentError). @netlify/blobs is a declared dependency, so
// this resolves at runtime.
const { getStore } = require('@netlify/blobs')

function record(scope, e) {
  lastError = `${scope}: ${e && e.name ? e.name + ' — ' : ''}${e && e.message ? e.message : String(e)}`
}

function store() {
  try {
    // Automatic configuration (works when the runtime injects NETLIFY_BLOBS_CONTEXT).
    return getStore('fleet')
  } catch (e) {
    // Fallback to explicit config if the runtime still didn't inject the context
    // and a site ID + token are present; otherwise re-throw so callers degrade
    // gracefully to a live scan.
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN
    if (siteID && token) {
      return getStore({ name: 'fleet', siteID, token })
    }
    throw e
  }
}

// false if Blobs can't be reached at all (callers may use this to decide).
function isCacheEnabled() {
  if (cacheDisabled) return false
  try {
    store()
    return true
  } catch (e) {
    record('getStore', e)
    cacheDisabled = true
    return false
  }
}

async function readFleet(date) {
  try {
    return await store().get('fleet:' + date, { type: 'json' })
  } catch (e) {
    record('readFleet', e)
    return null
  }
}

async function writeFleet(date, payload) {
  try {
    await store().setJSON('fleet:' + date, { at: Date.now(), ...payload })
  } catch (e) {
    record('writeFleet', e)
  }
}

async function readStops(date) {
  try {
    return await store().get('stops:' + date, { type: 'json' })
  } catch (e) {
    record('readStops', e)
    return null
  }
}

async function writeStops(date, payload) {
  try {
    await store().setJSON('stops:' + date, { at: Date.now(), ...payload })
  } catch (e) {
    record('writeStops', e)
  }
}

/**
 * Read-only diagnostic: attempts a real Blobs round-trip (write a probe key,
 * read it back) and reports exactly where/why it fails. Surfaced via
 * `?path=__cacheDiag`. The probe key is a harmless cache write (never NuVizz).
 */
async function diagnose(date) {
  const result = {
    pkgResolved: false,
    storeCreated: false,
    wrote: false,
    readBack: false,
    roundTrip: false,
    nodeVersion: process.version,
    hasBlobsContextEnv: !!process.env.NETLIFY_BLOBS_CONTEXT,
    error: null,
  }
  try {
    require.resolve('@netlify/blobs')
    result.pkgResolved = true
  } catch (e) {
    result.error = `require.resolve: ${e.message}`
    return result
  }
  let s
  try {
    s = store()
    result.storeCreated = true
  } catch (e) {
    result.error = `getStore: ${e.name} — ${e.message}`
    return result
  }
  const key = `__diag:${date}`
  try {
    await s.setJSON(key, { at: Date.now(), probe: true })
    result.wrote = true
  } catch (e) {
    result.error = `setJSON: ${e.name} — ${e.message}`
    return result
  }
  try {
    const v = await s.get(key, { type: 'json' })
    result.readBack = v != null
    result.roundTrip = !!(v && v.probe === true)
  } catch (e) {
    result.error = `get: ${e.name} — ${e.message}`
    return result
  }
  return result
}

function getLastError() {
  return lastError
}

module.exports = {
  isCacheEnabled,
  readFleet,
  writeFleet,
  readStops,
  writeStops,
  diagnose,
  getLastError,
}
