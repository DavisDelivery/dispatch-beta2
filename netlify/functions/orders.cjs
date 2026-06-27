'use strict'

// Shared created-orders registry — server-side so the dispatch board follows the
// user across devices (localStorage was per-browser). Backed by Netlify Blobs
// (single shared key; this is a single-tenant beta). Every op is a read-modify-
// write returning the full canonical list. Graceful: Blobs failure -> 500, and
// the client keeps its local cache.
//
// GET                      -> { orders: [...] }   (seeds on first ever read)
// POST { op, ... }         -> { orders: [...] }
//   add        { order }
//   remove     { stopNbr }
//   setPlanned { stopNbrs, loadNbr }   (loadNbr null = unplan)
//   merge      { orders }              (upsert; prefers a non-null plannedLoadNbr)
//   clear

const { getStore } = require('@netlify/blobs')

const KEY = 'orders:registry'

// Starter orders (real UAT stops) — seeded once so a fresh device isn't empty.
const SEED = [
  { stopNbr: '007138869', stopId: '6a3f11c53e328714d44a523d', name: 'TOTAL WIRELESS', addr1: '7184 ROCKBRIDGE RD', addr2: 'STE 1102A', city: 'STONE MOUNTAIN', state: 'GA', zip: '30087', pallets: 1, plannedLoadNbr: null },
  { stopNbr: '007139395', stopId: '6a3f11c63e328714d44a523f', name: 'UNITED WAY OF GREATER ATLANTA', addr1: '40 COURTLAND ST NE', addr2: '', city: 'ATLANTA', state: 'GA', zip: '30303', pallets: 1, plannedLoadNbr: null },
  { stopNbr: '007139396', stopId: '6a3f11c73e328714d44a5241', name: 'AMAZON.COM SERVICES LLC HAT2', addr1: '7520 FACTORY SHOALS RD', addr2: '', city: 'AUSTELL', state: 'GA', zip: '30168', pallets: 1, plannedLoadNbr: null },
  { stopNbr: '007139397', stopId: '6a3f11c8a369e5089e6c020f', name: 'SOCIETAL CDMO GAINESVILLE LLC', addr1: '1300 GOULD DR', addr2: '', city: 'GAINESVILLE', state: 'GA', zip: '30504', pallets: 2, plannedLoadNbr: null },
  { stopNbr: '007139398', stopId: '6a3f11c9a369e5089e6c0211', name: 'NON INV GUARDSHACK AMAZON ATL2', addr1: '2257 W PARK PLACE BLVD', addr2: '', city: 'STONE MOUNTAIN', state: 'GA', zip: '30087', pallets: 1, plannedLoadNbr: null },
  { stopNbr: '007139399', stopId: '6a3f11ca3e328714d44a5243', name: 'SIENHUA GROUP INC', addr1: '1055 BIG SHANTY RD NW', addr2: '# 300', city: 'KENNESAW', state: 'GA', zip: '30144', pallets: 1, plannedLoadNbr: null },
  { stopNbr: '007139400', stopId: '6a3f11cba369e5089e6c0213', name: 'GA POWER TRANSMISSION SERVICES', addr1: '62 LAKE MIRROR ROAD', addr2: '', city: 'FOREST PARK', state: 'GA', zip: '30297', pallets: 2, plannedLoadNbr: null },
  { stopNbr: '007139401', stopId: '6a3f11cda369e5089e6c0215', name: 'BROWN OX VENTURES INC', addr1: '1415 CLEVELAND HWY', addr2: '', city: 'DALTON', state: 'GA', zip: '30721', pallets: 1, plannedLoadNbr: null },
  { stopNbr: '007139402', stopId: '6a3f11d93e328714d44a5245', name: 'CATALYST NUTRACEUTICALS', addr1: '1720 PEACHTREE IND BLVD', addr2: 'STE A', city: 'BUFORD', state: 'GA', zip: '30518', pallets: 1, plannedLoadNbr: null },
]

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
  return v && Array.isArray(v.orders) ? v.orders : null
}
async function write(orders) {
  await store().setJSON(KEY, { orders, updatedAt: Date.now() })
  return orders
}

function applyMerge(cur, incoming) {
  const byNbr = new Map(cur.map((o) => [o.stopNbr, o]))
  for (const o of incoming) {
    if (!o || !o.stopNbr) continue
    const existing = byNbr.get(o.stopNbr)
    if (!existing) byNbr.set(o.stopNbr, { plannedLoadNbr: null, ...o })
    else byNbr.set(o.stopNbr, { ...existing, ...o, plannedLoadNbr: o.plannedLoadNbr || existing.plannedLoadNbr || null })
  }
  return [...byNbr.values()]
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      let orders = await read()
      if (!orders) orders = await write(SEED)
      return json(200, { orders })
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' })

    const req = JSON.parse(event.body || '{}')
    const op = req.op
    let cur = (await read()) || SEED.slice()

    switch (op) {
      case 'add': {
        if (!req.order || !req.order.stopNbr) return json(400, { error: 'add needs order.stopNbr' })
        cur = [{ plannedLoadNbr: null, createdAt: Date.now(), ...req.order }, ...cur.filter((o) => o.stopNbr !== req.order.stopNbr)]
        break
      }
      case 'remove': {
        cur = cur.filter((o) => o.stopNbr !== req.stopNbr)
        break
      }
      case 'setPlanned': {
        const set = new Set(req.stopNbrs || [])
        cur = cur.map((o) => (set.has(o.stopNbr) ? { ...o, plannedLoadNbr: req.loadNbr || null } : o))
        break
      }
      case 'merge': {
        cur = applyMerge(cur, req.orders || [])
        break
      }
      case 'clear': {
        cur = []
        break
      }
      default:
        return json(400, { error: `Unknown op "${op}"` })
    }
    await write(cur)
    return json(200, { orders: cur })
  } catch (e) {
    return json(500, { error: (e && e.message) || 'orders store error' })
  }
}
