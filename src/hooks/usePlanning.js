// Shared plan/unplan logic against the gated NuVizz write function. The API is
// touched ONLY here, and only on an explicit plan/unplan — no discovery reads.
// Credentials come from server env (the write fn), so we send none.
//
// loadId resolution: from KNOWN_LOADS, else a cached one-time getLoad per load
// number (localStorage dd_loadid_cache) so a load is read at most once, ever.

import { useCallback, useState } from 'react'
import { getLoad, insertStops, removeStops, assignDriver, dispatchLoad as apiDispatchLoad, assignOk, normalizeLoad, summarize } from '../lib/nuvizzWrite.js'
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
  // loadNbr -> [stopNbr] in NuVizz's real visit order (to.seq), captured on reconcile.
  const [sequenceByLoad, setSequenceByLoad] = useState({})

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
    const orderMap = {}
    let calls = 0
    for (const nbr of loadNbrs) {
      try {
        const L = normalizeLoad(await getLoad({}, nbr))
        calls++
        const key = L.loadNbr || nbr
        for (const s of L.stops || []) if (s.stopNbr) stopToLoad[s.stopNbr] = key
        // capture the real visit order (by to.seq)
        orderMap[key] = (L.stops || [])
          .filter((s) => s.stopNbr)
          .sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9))
          .map((s) => s.stopNbr)
      } catch {
        /* a missing/cancelled load just isn't a source of truth */
      }
    }
    setSequenceByLoad(orderMap)
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

  // Assign + dispatch a driver to a load in NuVizz (real write). Resolves the
  // load's loadId (cached) and calls assignanddispatch with the driver's driverId.
  const dispatchDriver = useCallback(
    async (loadNbr, driver) => {
      if (!driver?.driverId) return { ok: false, message: 'That driver has no driverId.' }
      try {
        const loadId = await resolveLoadId(loadNbr)
        const r = assignOk(await assignDriver({}, loadId, driver.driverId))
        return r.ok ? { ok: true, message: `Dispatched ${driver.name} to ${loadNbr}.` } : r
      } catch (e) {
        return { ok: false, message: e.message }
      }
    },
    [resolveLoadId],
  )

  // Dispatch (release) a load to its assigned driver in NuVizz.
  const dispatchLoad = useCallback(async (loadNbr) => {
    try {
      const loadId = await resolveLoadId(loadNbr)
      const r = assignOk(await apiDispatchLoad({}, loadId))
      return r.ok ? { ok: true, message: `Dispatched ${loadNbr}.` } : r
    } catch (e) {
      return { ok: false, message: e.message }
    }
  }, [resolveLoadId])

  // Set a load's stop order in NuVizz to exactly `orderedStopNbrs`. NuVizz auto-
  // optimizes a bulk insert but APPENDS a single insert, so we remove the stops
  // and re-insert them ONE AT A TIME in order — the sequence then sticks. Cost =
  // ~2 (remove) + N (one insert per stop) NuVizz calls.
  const sequenceLoad = useCallback(
    async (loadNbr, orderedStopNbrs) => {
      const byNbr = new Map(orders.map((o) => [o.stopNbr, o]))
      const items = orderedStopNbrs.map((sn) => byNbr.get(sn)).filter((o) => o && o.stopId)
      if (items.length < 2) return { ok: false, message: 'Need 2+ stops to sequence.' }
      try {
        const loadId = await resolveLoadId(loadNbr)
        // Keep the first desired stop as an anchor (removing ALL stops cancels the
        // route), remove the rest, then re-insert them one-at-a-time in order — a
        // single insert appends, so the final order is exactly [first, …rest].
        const [first, ...rest] = items
        const rem = summarize(await removeStops({}, loadNbr, rest.map((o) => o.stopId)))
        if (!rem.ok) return { ok: false, message: `Couldn’t reorder: ${rem.message}` }
        let n = 1
        for (const o of rest) {
          const r = summarize(await insertStops({}, loadId, [o.stopId]))
          if (!r.ok) return { ok: false, message: `Re-inserting ${o.stopNbr} failed: ${r.message}` }
          n++
        }
        void first
        // optimistic local order so the board reflects it before the next reconcile
        setSequenceByLoad((m) => ({ ...m, [loadNbr]: items.map((o) => o.stopNbr) }))
        return { ok: true, message: `Sequenced ${n} stop(s) on ${loadNbr}.`, calls: 2 + n }
      } catch (e) {
        return { ok: false, message: e.message }
      }
    },
    [orders, resolveLoadId],
  )

  return { orders, plan, unplan, reconcile, dispatchDriver, dispatchLoad, sequenceByLoad, sequenceLoad }
}
