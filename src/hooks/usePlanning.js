// Shared plan/unplan logic against the gated NuVizz write function. The API is
// touched ONLY here, and only on an explicit plan/unplan — no discovery reads.
// Credentials come from server env (the write fn), so we send none.
//
// loadId resolution: from KNOWN_LOADS, else a cached one-time getLoad per load
// number (localStorage dd_loadid_cache) so a load is read at most once, ever.

import { useCallback } from 'react'
import { getLoad, insertStops, removeStops, normalizeLoad, summarize } from '../lib/nuvizzWrite.js'
import { useCreatedOrders } from './useCreatedOrders.js'
import { KNOWN_LOADS } from '../lib/loads.js'

const LOADID_KEY = 'dd_loadid_cache'
const cache = {
  get(nbr) {
    try {
      return JSON.parse(localStorage.getItem(LOADID_KEY) || '{}')[nbr] || null
    } catch {
      return null
    }
  },
  set(nbr, id) {
    try {
      const m = JSON.parse(localStorage.getItem(LOADID_KEY) || '{}')
      m[nbr] = id
      localStorage.setItem(LOADID_KEY, JSON.stringify(m))
    } catch {
      /* ignore */
    }
  },
}

export function usePlanning() {
  const { orders, setPlanned } = useCreatedOrders()

  const resolveLoadId = useCallback(async (loadNbr) => {
    const known = KNOWN_LOADS.find((l) => l.loadNbr === loadNbr)
    if (known?.loadId) return known.loadId
    const cached = cache.get(loadNbr)
    if (cached) return cached
    const norm = normalizeLoad(await getLoad({}, loadNbr))
    if (!norm.loadId) throw new Error(`Load ${loadNbr} not found`)
    cache.set(loadNbr, norm.loadId)
    return norm.loadId
  }, [])

  // Plan a list of created orders (each needs .stopNbr + .stopId) onto a load.
  const plan = useCallback(
    async (loadNbr, list) => {
      const nbr = String(loadNbr || '').trim().toUpperCase()
      if (!nbr) return { ok: false, message: 'Pick a target load first.' }
      const ids = list.map((o) => o.stopId).filter(Boolean)
      if (!ids.length) return { ok: false, message: 'No orders with a stop id to plan.' }
      try {
        const loadId = await resolveLoadId(nbr)
        const r = summarize(await insertStops({}, loadId, ids))
        if (!r.ok) return { ok: false, message: r.message }
        setPlanned(list.map((o) => o.stopNbr), nbr)
        return { ok: true, message: `Planned ${ids.length} onto ${nbr}.`, count: ids.length }
      } catch (e) {
        return { ok: false, message: e.message }
      }
    },
    [resolveLoadId, setPlanned],
  )

  // Unplan a list of planned orders (grouped by their current load).
  const unplan = useCallback(
    async (list) => {
      const byLoad = new Map()
      for (const o of list) {
        if (!o.plannedLoadNbr || !o.stopId) continue
        if (!byLoad.has(o.plannedLoadNbr)) byLoad.set(o.plannedLoadNbr, [])
        byLoad.get(o.plannedLoadNbr).push(o)
      }
      if (!byLoad.size) return { ok: false, message: 'Nothing planned to remove.' }
      let total = 0
      const failures = []
      for (const [loadNbr, group] of byLoad) {
        const r = summarize(await removeStops({}, loadNbr, group.map((o) => o.stopId)))
        if (r.ok) {
          total += group.length
          setPlanned(group.map((o) => o.stopNbr), null)
        } else failures.push(`${loadNbr}: ${r.message}`)
      }
      return failures.length
        ? { ok: false, message: `Removed ${total}; errors — ${failures.join(' · ')}`, count: total }
        : { ok: true, message: `Unplanned ${total}.`, count: total }
    },
    [setPlanned],
  )

  // Reconcile the registry's planned state against NuVizz reality. Reads each
  // relevant load (KNOWN_LOADS + any load an order claims) ONCE — a scoped, cheap
  // "scan" (no number-probing) — builds the true stopNbr -> loadNbr membership,
  // and fixes any order whose planned flag drifted (planned-shows-unplanned, or
  // vice-versa). Cost = number of loads read, independent of order count.
  const reconcile = useCallback(async () => {
    const loadNbrs = [...new Set([...KNOWN_LOADS.map((l) => l.loadNbr), ...orders.map((o) => o.plannedLoadNbr).filter(Boolean)])]
    const stopToLoad = {}
    let calls = 0
    for (const nbr of loadNbrs) {
      try {
        const L = normalizeLoad(await getLoad({}, nbr))
        calls++
        for (const s of L.stops || []) if (s.stopNbr) stopToLoad[s.stopNbr] = L.loadNbr || nbr
      } catch {
        /* a missing/cancelled load just isn't a source of truth */
      }
    }
    // Group the orders whose planned state changed, by their true load.
    const groups = new Map()
    for (const o of orders) {
      const truth = stopToLoad[o.stopNbr] || null
      if ((o.plannedLoadNbr || null) !== truth) {
        const key = truth || ''
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(o.stopNbr)
      }
    }
    let changed = 0
    for (const [loadNbr, stopNbrs] of groups) {
      setPlanned(stopNbrs, loadNbr || null)
      changed += stopNbrs.length
    }
    return { calls, changed, loads: loadNbrs.length }
  }, [orders, setPlanned])

  return { orders, plan, unplan, reconcile }
}
