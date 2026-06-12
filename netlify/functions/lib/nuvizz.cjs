'use strict'

/**
 * NuVizz DeliverIT v7 read client — READ-ONLY.
 *
 * Built from the VERIFIED read contract (extracted from Davis's real, deployed
 * NuVizz client). Key facts that drive the design:
 *
 *   - AUTH is stateless HTTP Basic on EVERY request. There is NO login / JWT /
 *     session step.
 *   - There is NO "list loads" or "list stops" endpoint. You DISCOVER a day's
 *     loads by scanning a contiguous range of load numbers in parallel and
 *     keeping the ones whose earliestStartDttm date matches the target date.
 *   - beta2 is STANDALONE: live-scan only, NO Firestore. A short in-memory cache
 *     per warm function instance is the only caching (loads 60s; per-date scan
 *     calibration ~10 min).
 *
 * v0.2.1: CACHE-FIRST. The ~600-load scan moves off the request path. Reads go
 * L1 (60s in-memory) -> L2 (Netlify Blobs warm cache) -> L3 (live scan), and a
 * scheduled background function keeps the Blobs cache warm.
 *
 * READ-ONLY: no write / assign / dispatch / tender paths exist here.
 */

const cache = require('./fleetCache.cjs')

const REQUIRED_VARS = ['NUVIZZ_DAVIS_USER', 'NUVIZZ_DAVIS_PASS']

const DEFAULT_BASE_URL = 'https://portal.nuvizz.com/deliverit/openapi/v7'
const DEFAULT_TIMEOUT_MS = 12000
// Gentler now that scans are off the hot path (background-warmed).
// Higher concurrency because the Blobs warm cache is unavailable on this site,
// so the scan currently runs ON the request path and must finish under the
// function timeout. (Drop back toward ~25 once the warm cache is active.)
const SCAN_CONCURRENCY = 50
const SCAN_HALF_WINDOW = 300 // center-300 .. center+300
const LOAD_CACHE_TTL_MS = 60 * 1000
const CALIBRATION_TTL_MS = 10 * 60 * 1000

// Anchor calibration: the real 2026-06-05 range was 196094..196192 (center
// ~196143). Davis dispatches ~100 loads per business day, zero on weekends.
const ANCHOR_DATE = '2026-06-05'
const ANCHOR_CENTER = 196143
const LOADS_PER_BUSINESS_DAY = 100

class NuvizzError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'NuvizzError'
    this.code = code // 'CONFIG' | 'UPSTREAM'
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
  const companyCode = (env.NUVIZZ_DAVIS_COMPANY_CODE || 'DAVIS').toUpperCase()
  const auth = Buffer.from(
    `${env.NUVIZZ_DAVIS_USER}:${env.NUVIZZ_DAVIS_PASS}`,
  ).toString('base64')
  return {
    companyCode,
    baseUrl: (env.NUVIZZ_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    authHeader: `Basic ${auth}`,
  }
}

// ---------------------------------------------------------------------------
// Date math — business days drive the scan center.
// ---------------------------------------------------------------------------
function resolveDate(date) {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  return new Date().toISOString().slice(0, 10)
}

function businessDaysBetween(startISO, endISO) {
  const start = new Date(`${startISO}T00:00:00Z`)
  const end = new Date(`${endISO}T00:00:00Z`)
  if (start.getTime() === end.getTime()) return 0
  const sign = end > start ? 1 : -1
  let count = 0
  const cur = new Date(start)
  while (cur.getTime() !== end.getTime()) {
    cur.setUTCDate(cur.getUTCDate() + sign)
    const dow = cur.getUTCDay() // 0 Sun .. 6 Sat
    if (dow !== 0 && dow !== 6) count += sign
  }
  return count
}

function estimateCenter(targetDate) {
  return ANCHOR_CENTER + businessDaysBetween(ANCHOR_DATE, targetDate) * LOADS_PER_BUSINESS_DAY
}

function padLoadNbr(companyCode, n) {
  return `${companyCode}${String(n).padStart(9, '0')}`
}

// ---------------------------------------------------------------------------
// Caches (per warm instance).
// ---------------------------------------------------------------------------
const loadCache = new Map() // loadNbr -> { at, load }
const calibration = new Map() // date -> { at, min, max }
// L1 response memo (in front of Blobs L2, live L3). date -> { at, payload }.
const fleetMem = new Map()
const stopsMem = new Map()

function cacheGetLoad(loadNbr) {
  const hit = loadCache.get(loadNbr)
  if (hit && Date.now() - hit.at < LOAD_CACHE_TTL_MS) return hit.load
  return undefined
}
function cacheSetLoad(loadNbr, load) {
  loadCache.set(loadNbr, { at: Date.now(), load })
}

function memGet(map, date) {
  const hit = map.get(date)
  if (hit && Date.now() - hit.at < LOAD_CACHE_TTL_MS) return hit.payload
  return undefined
}
function memSet(map, date, payload) {
  map.set(date, { at: Date.now(), payload })
}

// ---------------------------------------------------------------------------
// HTTP — single load fetch.
// ---------------------------------------------------------------------------
async function httpJson(url, cfg) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: cfg.authHeader },
      signal: controller.signal,
    })
    // Bad credentials must surface LOUDLY so they are obvious to fix.
    if (res.status === 401 || res.status === 403) {
      throw new NuvizzError(
        `NuVizz auth failed (HTTP ${res.status}) — check NUVIZZ_DAVIS_USER / NUVIZZ_DAVIS_PASS`,
        'CONFIG',
      )
    }
    // Everything else (404, 429, any 5xx, etc.) is a SOFT MISS so one transient
    // or rate-limited probe never aborts the whole scan.
    if (!res.ok) return null
    const text = await res.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  } catch (err) {
    if (err instanceof NuvizzError) throw err
    return null // AbortError / timeout / network blip -> miss
  } finally {
    clearTimeout(timer)
  }
}

// GET {BASE}/load/info/{loadNbr}/{companyCode} -> raw { Load: {...} } or null.
async function fetchLoadRaw(cfg, loadNbr) {
  const cached = cacheGetLoad(loadNbr)
  if (cached !== undefined) return cached
  const url = `${cfg.baseUrl}/load/info/${loadNbr}/${cfg.companyCode}`
  const body = await httpJson(url, cfg)
  const load = body && body.Load ? body.Load : null
  cacheSetLoad(loadNbr, load)
  return load
}

// ---------------------------------------------------------------------------
// Normalizers — VERIFIED field map.
// ---------------------------------------------------------------------------
const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}
const str = (v) => (v == null ? '' : String(v))

function loadDate(load) {
  const d = load?.loadHeader?.earliestStartDttm
  return d ? String(d).slice(0, 10) : ''
}

// Flatten the verbatim SPL-INSTR-TEXT comment strings off a stop entry.
function flattenComments(entry) {
  const out = []
  const pull = (arr) => {
    if (!Array.isArray(arr)) return
    for (const c of arr) {
      const text = c && c.commentDescription
      if (text != null && String(text).trim() !== '') out.push(String(text))
    }
  }
  const stop = entry?.stop || {}
  pull(stop.comments)
  pull(stop.to && stop.to.comments)
  pull(stop.from && stop.from.comments)
  return out
}

const STATUS_LABELS = {
  10: 'Pending',
  30: 'Scheduled',
  40: 'En Route',
  50: 'Exception',
  90: 'Delivered',
}

function normalizeStop(load, entry) {
  const stop = entry?.stop || {}
  const addr = (stop.to && stop.to.address) || {}
  const sched = (stop.to && stop.to.schedule) || {}
  const exec = entry?.stopExecutionInfo || {}
  const execTo = exec.to || {}
  const code = num(exec.stopStatus)
  const exceptions = Array.isArray(exec.exceptions) ? exec.exceptions : []
  const exceptionPresent = exec.exceptionPresent === true
  const trueException = exceptionPresent || exceptions.length > 0

  return {
    loadNbr: str(load?.loadHeader?.loadNbr),
    loadId: str(load?.loadHeader?.loadId),
    routeName: str(load?.loadHeader?.routeName),
    driverName: str(load?.loadAssignment?.driverName),
    driverUserName: str(load?.loadAssignment?.driverUserName),

    stopNbr: str(stop.stopNbr),
    stopType: str(stop.stopType),
    bol: str(stop.bol),
    totalPallets: num(stop.totalPallets),
    totalCartons: num(stop.totalCartons),
    weight: num(stop.weight),
    sealNbr: stop.sealNbr || null,

    name: str(addr.name),
    addr1: str(addr.addr1),
    city: str(addr.city),
    state: str(addr.state),
    zip: str(addr.zip),
    latitude: num(addr.latitude),
    longitude: num(addr.longitude),

    apptFrom: sched.timeFrom || null,
    apptTo: sched.timeTo || null,
    comments: flattenComments(entry),

    stopStatus: code,
    statusLabel: STATUS_LABELS[code] || 'Unknown',
    exceptionPresent,
    exceptionCount: exceptions.length,
    trueException,

    plannedEta: execTo.plannedEtaDTTM || null,
    eta: execTo.etaDttm || null,
    arrival: execTo.arrivalDTTM || null,
    confirmed: execTo.confirmedDTTM || null,
    etaCode: execTo.etaCode != null ? str(execTo.etaCode) : null,
    duration: execTo.duration != null ? num(execTo.duration) : null,
  }
}

// stopSeq is ALWAYS 1 and useless — sort by plannedEta, empties last.
function byPlannedEta(a, b) {
  const av = a.plannedEta
  const bv = b.plannedEta
  if (!av && !bv) return 0
  if (!av) return 1
  if (!bv) return -1
  return new Date(av).getTime() - new Date(bv).getTime()
}

function normalizeStops(load) {
  const entries = Array.isArray(load?.stops) ? load.stops : []
  return entries.map((e) => normalizeStop(load, e)).sort(byPlannedEta)
}

function normalizeLoadSummary(load) {
  const h = load?.loadHeader || {}
  const a = load?.loadAssignment || {}
  const x = load?.loadExecutionInfo || {}
  const stops = normalizeStops(load)
  const stopsDelivered = stops.filter((s) => s.stopStatus === 90).length
  const stopsExceptions = stops.filter((s) => s.trueException).length

  return {
    loadId: str(h.loadId),
    loadNbr: str(h.loadNbr),
    routeName: str(h.routeName),
    vehicleType: str(h.vehicleType),
    totalPallets: num(h.totalPallets),
    totalCartons: num(h.totalCartons),
    weight: num(h.weight),
    weightUOM: str(h.weightUOM),
    volume: num(h.volume),
    volumeUOM: str(h.volumeUOM),
    pronbr: str(h.pronbr),
    reference: str(h.reference),
    earliestStart: h.earliestStartDttm || null,
    latestStart: h.latestStartDttm || null,
    originName: str(h.originName),
    originCity: str(h.originCity),
    originState: str(h.originState),
    originZip: str(h.originZip),
    driverName: str(a.driverName),
    driverUserName: str(a.driverUserName),
    driverEmail: str(a.driverEmail),
    loadStatus: str(x.loadStatus),
    stopCount: stops.length,
    stopsDelivered,
    stopsExceptions,
  }
}

// ---------------------------------------------------------------------------
// Range scan — discover a date's loads.
// ---------------------------------------------------------------------------
async function scanRange(cfg, lo, hi, targetDate) {
  const numbers = []
  for (let n = lo; n <= hi; n++) numbers.push(n)

  const found = []
  let cursor = 0
  async function worker() {
    while (cursor < numbers.length) {
      const n = numbers[cursor++]
      const loadNbr = padLoadNbr(cfg.companyCode, n)
      const load = await fetchLoadRaw(cfg, loadNbr)
      if (load && loadDate(load) === targetDate) {
        found.push({ n, load })
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(SCAN_CONCURRENCY, numbers.length) },
    worker,
  )
  await Promise.all(workers)
  return found
}

async function discoverLoads(cfg, targetDate) {
  let lo
  let hi
  const cal = calibration.get(targetDate)
  if (cal && Date.now() - cal.at < CALIBRATION_TTL_MS) {
    lo = cal.min
    hi = cal.max
  } else {
    const center = estimateCenter(targetDate)
    lo = center - SCAN_HALF_WINDOW
    hi = center + SCAN_HALF_WINDOW
  }

  const found = await scanRange(cfg, lo, hi, targetDate)

  // Calibrate for fast re-scans, but only narrow on a confident (>=50) result —
  // an early-morning partial scan must not clamp the range.
  if (found.length >= 50) {
    const ns = found.map((f) => f.n)
    calibration.set(targetDate, {
      at: Date.now(),
      min: Math.min(...ns) - 20,
      max: Math.max(...ns) + 100,
    })
  }

  return found.map((f) => f.load)
}

// ---------------------------------------------------------------------------
// Cache builders — turn a live scan into the cached payloads.
// ---------------------------------------------------------------------------
function buildSummaries(loads) {
  return loads
    .map(normalizeLoadSummary)
    .sort((a, b) => a.loadNbr.localeCompare(b.loadNbr))
}
function buildStops(loads) {
  return loads.flatMap(normalizeStops).sort(byPlannedEta)
}

/**
 * Run the FULL discovery scan once and write both warm-cache payloads. This is
 * what the scheduled background function (and the manual __refreshFleet trigger)
 * call so the hot read path never has to scan.
 */
async function refreshFleetCache({ date, env } = {}) {
  const t0 = Date.now()
  const cfg = getConfig(env)
  const targetDate = resolveDate(date)
  const loads = await discoverLoads(cfg, targetDate)
  const summaries = buildSummaries(loads)
  const stops = buildStops(loads)
  await cache.writeFleet(targetDate, { loads: summaries })
  await cache.writeStops(targetDate, { stops })
  // Freshly warmed — drop any stale L1 memo for this date.
  fleetMem.delete(targetDate)
  stopsMem.delete(targetDate)
  return {
    date: targetDate,
    totalLoads: summaries.length,
    totalStops: stops.length,
    totalDelivered: summaries.reduce((n, l) => n + (l.stopsDelivered || 0), 0),
    totalExceptions: summaries.reduce((n, l) => n + (l.stopsExceptions || 0), 0),
    uniqueDrivers: new Set(summaries.map((l) => l.driverUserName).filter(Boolean)).size,
    ms: Date.now() - t0,
  }
}

// ---------------------------------------------------------------------------
// Public read API — CACHE-FIRST: L1 memo -> L2 Blobs -> L3 live scan.
// ---------------------------------------------------------------------------
async function getFleet({ date, env } = {}) {
  const targetDate = resolveDate(date)
  const l1 = memGet(fleetMem, targetDate)
  if (l1) return l1

  const hit = await cache.readFleet(targetDate)
  if (hit && Array.isArray(hit.loads)) {
    const res = {
      date: targetDate,
      count: hit.loads.length,
      loads: hit.loads,
      source: 'cache',
      cachedAt: hit.at ?? null,
    }
    memSet(fleetMem, targetDate, res)
    return res
  }

  const cfg = getConfig(env)
  const loads = await discoverLoads(cfg, targetDate)
  const summaries = buildSummaries(loads)
  await cache.writeFleet(targetDate, { loads: summaries })
  return {
    date: targetDate,
    count: summaries.length,
    loads: summaries,
    source: 'live',
    cachedAt: null,
  }
}

async function getFleetStops({ date, env } = {}) {
  const targetDate = resolveDate(date)
  const l1 = memGet(stopsMem, targetDate)
  if (l1) return l1

  const hit = await cache.readStops(targetDate)
  if (hit && Array.isArray(hit.stops)) {
    const res = {
      date: targetDate,
      count: hit.stops.length,
      stops: hit.stops,
      source: 'cache',
      cachedAt: hit.at ?? null,
    }
    memSet(stopsMem, targetDate, res)
    return res
  }

  const cfg = getConfig(env)
  const loads = await discoverLoads(cfg, targetDate)
  const stops = buildStops(loads)
  await cache.writeStops(targetDate, { stops })
  return {
    date: targetDate,
    count: stops.length,
    stops,
    source: 'live',
    cachedAt: null,
  }
}

async function getDriver({ date, userName, env } = {}) {
  const targetDate = resolveDate(date)
  const wanted = String(userName || '').toLowerCase()

  // Cache-first: filter the warm fleet + stops in-memory, no re-scan.
  const cachedStops = await cache.readStops(targetDate)
  const cachedFleet = await cache.readFleet(targetDate)
  if (
    cachedStops &&
    Array.isArray(cachedStops.stops) &&
    cachedFleet &&
    Array.isArray(cachedFleet.loads)
  ) {
    const loads = cachedFleet.loads.filter(
      (l) => str(l.driverUserName).toLowerCase() === wanted,
    )
    const stops = cachedStops.stops
      .filter((s) => str(s.driverUserName).toLowerCase() === wanted)
      .sort(byPlannedEta)
    return {
      date: targetDate,
      userName,
      count: loads.length,
      loads,
      stops,
      source: 'cache',
      cachedAt: cachedStops.at ?? cachedFleet.at ?? null,
    }
  }

  // MISS -> live path: scan, then re-fetch each matched load live for freshness.
  const cfg = getConfig(env)
  const loads = await discoverLoads(cfg, targetDate)
  const mine = loads.filter(
    (l) => str(l?.loadAssignment?.driverUserName).toLowerCase() === wanted,
  )
  const fresh = []
  for (const l of mine) {
    const loadNbr = str(l?.loadHeader?.loadNbr)
    const refreshed = (await fetchLoadRaw(cfg, loadNbr)) || l
    fresh.push(refreshed)
  }
  const summaries = fresh.map(normalizeLoadSummary)
  const stops = fresh.flatMap(normalizeStops).sort(byPlannedEta)
  return {
    date: targetDate,
    userName,
    count: summaries.length,
    loads: summaries,
    stops,
    source: 'live',
    cachedAt: null,
  }
}

async function refreshLoad({ loadNbr, env } = {}) {
  const cfg = getConfig(env)
  loadCache.delete(loadNbr)
  const load = await fetchLoadRaw(cfg, loadNbr)
  if (!load) return { loadNbr, load: null }
  return {
    loadNbr,
    load: { ...normalizeLoadSummary(load), stops: normalizeStops(load) },
  }
}

// Read-only Blobs diagnostic (no NuVizz call). Surfaces why the warm cache is or
// isn't working in production via ?path=__cacheDiag.
async function cacheDiagnose({ date } = {}) {
  const targetDate = resolveDate(date)
  const diag = await cache.diagnose(targetDate)
  return { date: targetDate, ...diag, lastError: cache.getLastError() }
}

module.exports = {
  getConfig,
  getFleet,
  getFleetStops,
  getDriver,
  refreshLoad,
  refreshFleetCache,
  cacheDiagnose,
  NuvizzError,
  // exported for unit reasoning / reuse
  businessDaysBetween,
  estimateCenter,
  padLoadNbr,
  normalizeLoadSummary,
  normalizeStops,
}
