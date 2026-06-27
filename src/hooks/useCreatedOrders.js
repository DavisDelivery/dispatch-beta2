// Live view of the created-orders registry. The registry is server-backed
// (Netlify Blobs) so it syncs across devices: we sync on mount, then refresh on
// window focus and on a slow interval to pick up changes made on another device.
// Re-renders on every local mutation (same-tab custom event) too.

import { useEffect, useState } from 'react'
import {
  getCreatedOrders,
  addCreatedOrder,
  removeCreatedOrder,
  setPlannedFor,
  clearCreatedOrders,
  refreshCreatedOrders,
  syncCreatedOrders,
  CREATED_ORDERS_EVENT,
} from '../lib/createdOrders.js'

export function useCreatedOrders() {
  const [orders, setOrders] = useState(getCreatedOrders)

  useEffect(() => {
    const sync = () => setOrders(getCreatedOrders())
    window.addEventListener(CREATED_ORDERS_EVENT, sync)
    window.addEventListener('storage', sync)

    syncCreatedOrders()
    const onFocus = () => refreshCreatedOrders()
    window.addEventListener('focus', onFocus)
    const id = setInterval(refreshCreatedOrders, 20000)

    return () => {
      window.removeEventListener(CREATED_ORDERS_EVENT, sync)
      window.removeEventListener('storage', sync)
      window.removeEventListener('focus', onFocus)
      clearInterval(id)
    }
  }, [])

  return {
    orders,
    add: addCreatedOrder,
    remove: removeCreatedOrder,
    setPlanned: setPlannedFor,
    clear: clearCreatedOrders,
  }
}
