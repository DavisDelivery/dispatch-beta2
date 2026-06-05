'use strict'

/**
 * NuVizz DeliverIT v7 read client — READ-ONLY.
 *
 * ===========================================================================
 *  ⚠️  RECONSTRUCTED CLIENT — READ THIS BEFORE THE FIRST LIVE TEST (P5)
 * ===========================================================================
 *  This file was authored for dispatch-beta2 from the env-var contract in the
 *  v0.1.0 brief. The original `netlify/functions/nuvizz.cjs` in the
 *  DavisDelivery/davis-nuvizz repo was NOT reachable from this session
 *  (out of repo scope), so the exact NuVizz v7 HTTP shape (login endpoint,
 *  stops query endpoint, response envelope) is reconstructed and must be
 *  reconciled with the real client before relying on the live path.
 *
 *  What IS authoritative here (matches the brief exactly):
 *    - Required env vars: NUVIZZ_DAVIS_COMPANY_CODE, NUVIZZ_DAVIS_USER,
 *      NUVIZZ_DAVIS_PASS, NUVIZZ_BASE_URL.
 *    - READ-ONLY: no dispatch/assign/tender/write paths are ported.
 *    - STANDALONE: a DIRECT LIVE read of NuVizz. No Firestore cache
 *      (nuvizz_stop_index) and no dispatch-map cron coupling.
 *
 *  What to VERIFY against davis-nuvizz/nuvizz.cjs (search for "VERIFY:"):
 *    - the login path + request/response field names,
 *    - the stops query path + how "today"/horizon is expressed,
 *    - the response envelope and the raw per-stop field names in normalizeStop.
 *
 *  Endpoint paths can be corrected WITHOUT code changes via the optional
 *  NUVIZZ_LOGIN_PATH / NUVIZZ_STOPS_PATH env vars (see getConfig).
 * ===========================================================================
 */

const REQUIRED_VARS = [
  'NUVIZZ_DAVIS_COMPANY_CODE',
  'NUVIZZ_DAVIS_USER',
  'NUVIZZ_DAVIS_PASS',
  'NUVIZZ_BASE_URL',
]

const DEFAULT_TIMEOUT_MS = 15000

class NuvizzError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'NuvizzError'
    this.code = code // 'CONFIG' | 'AUTH' | 'UPSTREAM'
  }
}

function getConfig(env = process.env) {
  const missing = REQUIRED_VARS.filter((k) => !env[k])
  if (missing.length) {
    throw new NuvizzError(
      `Missing required NuVizz env var(s): ${missing.join(', ')}`,
      'CONFIG',
    )
  }
  return {
    companyCode: env.NUVIZZ_DAVIS_COMPANY_CODE,
    user: env.NUVIZZ_DAVIS_USER,
    pass: env.NUVIZZ_DAVIS_PASS,
    baseUrl: env.NUVIZZ_BASE_URL,
    // Optional overrides for reconciliation (see header note).
    loginPath: env.NUVIZZ_LOGIN_PATH || '/login',
    stopsPath: env.NUVIZZ_STOPS_PATH || '/stops',
  }
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
}

async function httpJson(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    const text = await res.text()
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { raw: text }
    }
    if (!res.ok) {
      const msg = body?.message || body?.error || `HTTP ${res.status}`
      throw new NuvizzError(`NuVizz upstream error: ${msg}`, 'UPSTREAM')
    }
    return body
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new NuvizzError('NuVizz request timed out', 'UPSTREAM')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// VERIFY: login path, request body field names, and where the token lives in
// the response. NuVizz DeliverIT typically returns a bearer/session token.
async function login(cfg) {
  const body = await httpJson(joinUrl(cfg.baseUrl, cfg.loginPath), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      companyCode: cfg.companyCode,
      userName: cfg.user,
      password: cfg.pass,
    }),
  })
  const token =
    body.token ||
    body.access_token ||
    body.accessToken ||
    body.sessionId ||
    body?.data?.token
  if (!token) {
    throw new NuvizzError('NuVizz login returned no token', 'AUTH')
  }
  return token
}

// VERIFY: stops query path + how the date horizon is passed.
async function fetchStopsRaw(cfg, token, { horizon }) {
  const url = new URL(joinUrl(cfg.baseUrl, cfg.stopsPath))
  url.searchParams.set('companyCode', cfg.companyCode)
  // "today" -> a yyyy-mm-dd date the API can filter on (wire format only;
  // the UI never renders ISO — see src/lib/format.js).
  url.searchParams.set('date', resolveHorizonDate(horizon))

  const body = await httpJson(url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
  })
  // Accept the common NuVizz envelopes plus a bare array.
  if (Array.isArray(body)) return body
  return body.stops || body.data || body.result?.stops || body.items || []
}

// horizon: 'today' (default) or a yyyy-mm-dd string. Returns a wire date.
function resolveHorizonDate(horizon) {
  if (horizon && /^\d{4}-\d{2}-\d{2}$/.test(horizon)) return horizon
  return new Date().toISOString().slice(0, 10)
}

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}
const pick = (...vals) => vals.find((v) => v != null && v !== '') ?? ''

// Map a raw NuVizz stop to the normalized record the UI/fixture share.
// VERIFY: the raw source field names below against a real NuVizz payload.
function normalizeStop(raw = {}) {
  return {
    stopNumber: pick(raw.stopNumber, raw.stopNo, raw.stop_number, raw.stopSeq),
    stopCreated: pick(raw.stopCreated, raw.createdDate, raw.createdOn, raw.creationDate),
    shipmentNumber: pick(raw.shipmentNumber, raw.shipmentNo, raw.shipmentId),
    driverName: pick(raw.driverName, raw.driver, raw.driverFullName),
    loadName: pick(raw.loadName, raw.routeName, raw.manifestName, raw.loadNo),
    shipToName: pick(raw.shipToName, raw.consigneeName, raw.customerName),
    address1: pick(raw.address1, raw.addressLine1, raw.addr1),
    address2: pick(raw.address2, raw.addressLine2, raw.addr2),
    city: pick(raw.city, raw.cityName),
    zip: pick(raw.zip, raw.zipCode, raw.postalCode),
    totalCartons: num(pick(raw.totalCartons, raw.cartons, raw.pieceCount, raw.qty)),
    volume: num(pick(raw.volume, raw.totalVolume, raw.cube)),
    weight: num(pick(raw.weight, raw.totalWeight)),
    status: pick(raw.status, raw.stopStatus, raw.statusDescription),
    sealNbr: pick(raw.sealNbr, raw.sealNumber, raw.seal),
    comments: pick(raw.comments, raw.notes, raw.comment, raw.specialInstructions),
  }
}

/**
 * Live, read-only fetch of today's (or a horizon's) normalized stops.
 * @param {{ horizon?: string, env?: object }} opts
 * @returns {Promise<object[]>}
 */
async function getStops({ horizon = 'today', env } = {}) {
  const cfg = getConfig(env)
  const token = await login(cfg)
  const raw = await fetchStopsRaw(cfg, token, { horizon })
  return raw.map(normalizeStop)
}

module.exports = { getStops, normalizeStop, getConfig, NuvizzError }
