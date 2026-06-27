// Created-orders registry — now SERVER-BACKED so the board follows you across
// devices. Netlify Blobs is the source of truth (via /.netlify/functions/orders);
// localStorage is a local mirror for instant render + offline. Mutations update
// the mirror optimistically, then POST the op and reconcile to the canonical list
// the server returns. A 'dd-created-orders' window event fires on every change.

const KEY = 'dd_created_orders'
const EVENT = 'dd-created-orders'
const SYNCED_FLAG = 'dd_orders_synced'
const URL = '/.netlify/functions/orders'

function readLocal() {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

let cache = readLocal()

function setCache(list) {
  cache = Array.isArray(list) ? list : []
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVENT))
}

export function getCreatedOrders() {
  return cache
}

async function serverOp(body) {
  try {
    const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) {
      const d = await res.json()
      if (Array.isArray(d.orders)) setCache(d.orders)
    }
  } catch {
    /* offline — keep the optimistic local mirror; a later sync reconciles */
  }
}

// Pull the canonical list from the server.
export async function refreshCreatedOrders() {
  try {
    const res = await fetch(URL)
    if (res.ok) {
      const d = await res.json()
      if (Array.isArray(d.orders)) setCache(d.orders)
    }
  } catch {
    /* offline */
  }
}

// On first load per device: push any pre-existing local orders up once (so work
// done before sync isn't stranded), then trust the server. Afterwards: refresh.
export async function syncCreatedOrders() {
  try {
    const synced = localStorage.getItem(SYNCED_FLAG) === '1'
    if (!synced && cache.length) await serverOp({ op: 'merge', orders: cache })
    else await refreshCreatedOrders()
    localStorage.setItem(SYNCED_FLAG, '1')
  } catch {
    /* ignore */
  }
}

export function addCreatedOrder(order) {
  if (!order?.stopNbr) return
  setCache([{ plannedLoadNbr: null, createdAt: Date.now(), ...order }, ...cache.filter((o) => o.stopNbr !== order.stopNbr)])
  serverOp({ op: 'add', order })
}

export function removeCreatedOrder(stopNbr) {
  setCache(cache.filter((o) => o.stopNbr !== stopNbr))
  serverOp({ op: 'remove', stopNbr })
}

export function setPlannedFor(stopNbrs, loadNbr) {
  const set = new Set(stopNbrs)
  setCache(cache.map((o) => (set.has(o.stopNbr) ? { ...o, plannedLoadNbr: loadNbr || null } : o)))
  serverOp({ op: 'setPlanned', stopNbrs, loadNbr })
}

export function clearCreatedOrders() {
  setCache([])
  serverOp({ op: 'clear' })
}

export const CREATED_ORDERS_EVENT = EVENT
