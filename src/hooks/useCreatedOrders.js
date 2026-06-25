// Live view of the created-orders registry (localStorage). Re-renders on every
// mutation (same-tab custom event) and on cross-tab 'storage' events.

import { useEffect, useState } from 'react'
import {
  getCreatedOrders,
  addCreatedOrder,
  removeCreatedOrder,
  setPlannedFor,
  clearCreatedOrders,
  CREATED_ORDERS_EVENT,
} from '../lib/createdOrders.js'

export function useCreatedOrders() {
  const [orders, setOrders] = useState(getCreatedOrders)

  useEffect(() => {
    const sync = () => setOrders(getCreatedOrders())
    window.addEventListener(CREATED_ORDERS_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CREATED_ORDERS_EVENT, sync)
      window.removeEventListener('storage', sync)
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
