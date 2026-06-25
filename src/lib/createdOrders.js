// Registry of orders we've created in UAT — the bridge between the Builder
// (which creates them) and the Routing screen (which plans/unplans them).
//
// Persisted in localStorage so it survives reloads and is shared across the
// app's pages/tabs. Each entry carries the stopId (needed for insert/remove),
// so planning needs no extra read. A 'dd-created-orders' window event fires on
// every mutation so same-tab listeners re-render live.

const KEY = 'dd_created_orders'
const EVENT = 'dd-created-orders'

export function getCreatedOrders() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* ignore quota / disabled storage */
  }
}

// Add (or refresh) an order by stopNbr. Newest first; de-duped on stopNbr.
export function addCreatedOrder(order) {
  if (!order?.stopNbr) return
  const list = getCreatedOrders().filter((o) => o.stopNbr !== order.stopNbr)
  list.unshift({ plannedLoadNbr: null, createdAt: Date.now(), ...order })
  write(list)
}

export function removeCreatedOrder(stopNbr) {
  write(getCreatedOrders().filter((o) => o.stopNbr !== stopNbr))
}

// Mark planned (loadNbr set) or unplanned (loadNbr null) for the given stopNbrs.
export function setPlannedFor(stopNbrs, loadNbr) {
  const set = new Set(stopNbrs)
  write(getCreatedOrders().map((o) => (set.has(o.stopNbr) ? { ...o, plannedLoadNbr: loadNbr || null } : o)))
}

export function clearCreatedOrders() {
  write([])
}

export const CREATED_ORDERS_EVENT = EVENT
