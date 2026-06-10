'use strict'

/**
 * Warm fleet cache — a thin, GRACEFUL wrapper over Netlify Blobs.
 *
 * In deployed Netlify Functions, Blobs is auto-provisioned (no env/keys). In
 * local/dev it is often unavailable. EVERY call here is wrapped so that any
 * failure degrades cleanly: reads return null (a miss -> live scan), writes are
 * swallowed. A missing/broken cache must NEVER crash a request.
 *
 * Keys are per-date: "fleet:" + date and "stops:" + date.
 */

let cacheDisabled = false

function store() {
  // Lazy require so a missing package / non-Netlify runtime degrades gracefully.
  const { getStore } = require('@netlify/blobs')
  return getStore('fleet')
}

// false if Blobs can't be reached at all (callers may use this to decide).
function isCacheEnabled() {
  if (cacheDisabled) return false
  try {
    store()
    return true
  } catch {
    cacheDisabled = true
    return false
  }
}

async function readFleet(date) {
  try {
    return await store().get('fleet:' + date, { type: 'json' })
  } catch {
    return null
  }
}

async function writeFleet(date, payload) {
  try {
    await store().setJSON('fleet:' + date, { at: Date.now(), ...payload })
  } catch {
    /* swallow — cache is best-effort */
  }
}

async function readStops(date) {
  try {
    return await store().get('stops:' + date, { type: 'json' })
  } catch {
    return null
  }
}

async function writeStops(date, payload) {
  try {
    await store().setJSON('stops:' + date, { at: Date.now(), ...payload })
  } catch {
    /* swallow — cache is best-effort */
  }
}

module.exports = { isCacheEnabled, readFleet, writeFleet, readStops, writeStops }
