// Shared plan/unplan logic against the gated NuVizz write function. The API is
// touched ONLY here, and only on an explicit plan/unplan — no discovery reads.
// Credentials come from server env (the write fn), so we send none.
//
// loadId resolution: from KNOWN_LOADS, else a cached one-time getLoad per load
// number (localStorage dd_loadid_cache) so a load is read at most once, ever.

import { useCallback, useState } from 'react'
import { getLoad, insertStops, removeStops, assignDriver, dispatchLoad as apiDispatchLoad, assignOk, normalizeLoad, summarize, setStopWindow } from '../lib/nuvizzWrite.js'
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

  // Set a load's stop order in NuVizz to exactly `orderedStopNbrs`.
  // ORDER MECHANISM (verified live): a BULK insertStops gets re-optimized by NuVizz
  // geographically (it ignores both array order AND delivery windows). The only
  // reliable control is a ONE-AT-A-TIME insert, which APPENDS each stop — so the
  // final order is exactly the insertion order. We also stamp each stop with a
  // 30-minute delivery slot in that same order, so the driver's ETA matches the
  // route position (the window is the displayed appointment, NOT the ordering lever).
  const sequenceLoad = useCallback(
    async (loadNbr, orderedStopNbrs) => {
      const byNbr = new Map(orders.map((o) => [o.stopNbr, o]))
      const items = orderedStopNbrs.map((sn) => byNbr.get(sn)).filter((o) => o && o.stopId)
      if (items.length < 2) return { ok: false, message: 'Need 2+ stops to sequence.' }
      try {
        const loadId = await resolveLoadId(loadNbr)
        let calls = 0
        // 1) Stamp sequence-aligned 30-min ETA windows (cosmetic; does not set order).
        for (let i = 0; i < items.length; i++) {
          const r = await setStopWindow({}, items[i], i)
          calls++
          if (!r.ok) return { ok: false, message: `Window ${items[i].stopNbr}: ${r.message}` }
        }
        // 2) Rebuild: keep the first stop as anchor (removing ALL stops cancels the
        //    route), remove the rest, then re-insert one-at-a-time in order (a single
        //    insert appends, so the final order is exactly [first, …rest]).
        const [first, ...rest] = items
        const rem = summarize(await removeStops({}, loadNbr, rest.map((o) => o.stopId)))
        calls++
        if (!rem.ok) return { ok: false, message: `Couldn’t reorder: ${rem.message}` }
        for (const o of rest) {
          const r = summarize(await insertStops({}, loadId, [o.stopId]))
          calls++
          if (!r.ok) return { ok: false, message: `Re-inserting ${o.stopNbr} failed: ${r.message}` }
        }
        void first
        // optimistic local order so the board reflects it before the next reconcile
        setSequenceByLoad((m) => ({ ...m, [loadNbr]: items.map((o) => o.stopNbr) }))
        return { ok: true, message: `Sequenced ${items.length} stop(s) on ${loadNbr}.`, calls }
      } catch (e) {
        return { ok: false, message: e.message }
      }
    },
    [orders, resolveLoadId],
  )

  // Commit a whole desired board arrangement to NuVizz in one pass (draft → Save).
  // `desiredByLoad` is an array of [loadNbr, orderedOrders[]] (orders carry stopId);
  // any planned order not present in it is treated as moved to Unassigned.
  // Phase 1 unplans every departure (current load ≠ desired). Phase 2 stamps each
  // load's stops with sequence-aligned 30-min ETA windows (cosmetic) then rebuilds it
  // to the exact desired order via keep-first-anchor + remove-rest + insert
  // ONE-AT-A-TIME (a bulk insert gets geo-reoptimized; a single insert appends, so
  // insertion order IS the final order). Cost is bounded by loads touched + their stops.
  const commit = useCallback(
    async (desiredByLoad) => {
      const byNbr = new Map(orders.map((o) => [o.stopNbr, o]))
      const desiredLoadOf = new Map()
      for (const [loadNbr, list] of desiredByLoad) for (const o of list) desiredLoadOf.set(o.stopNbr, loadNbr)

      const onLoad = new Map() // loadNbr -> Set(stopNbr) currently on the load
      for (const o of orders)
        if (o.plannedLoadNbr) {
          if (!onLoad.has(o.plannedLoadNbr)) onLoad.set(o.plannedLoadNbr, new Set())
          onLoad.get(o.plannedLoadNbr).add(o.stopNbr)
        }

      const errors = []
      let calls = 0

      // Phase 1 — unplan departures (incl. moves to Unassigned).
      const departByLoad = new Map()
      for (const o of orders) {
        const base = o.plannedLoadNbr || null
        const want = desiredLoadOf.get(o.stopNbr) || null
        if (base && base !== want && o.stopId) {
          if (!departByLoad.has(base)) departByLoad.set(base, [])
          departByLoad.get(base).push(o)
        }
      }
      for (const [loadNbr, list] of departByLoad) {
        const r = summarize(await removeStops({}, loadNbr, list.map((o) => o.stopId)))
        calls++
        if (r.ok) {
          setPlanned(list.map((o) => o.stopNbr), null)
          list.forEach((o) => onLoad.get(loadNbr)?.delete(o.stopNbr))
        } else errors.push(`unplan ${loadNbr}: ${r.message}`)
      }

      // Phase 2 — rebuild each load to its exact desired order, window-encoded.
      for (const [loadNbr, ordered] of desiredByLoad) {
        if (!ordered.length) continue
        try {
          const loadId = await resolveLoadId(loadNbr)
          // Stamp sequence-aligned 30-min ETA windows (cosmetic; does not set order).
          let windowFailed = false
          for (let i = 0; i < ordered.length; i++) {
            const r = await setStopWindow({}, ordered[i], i)
            calls++
            if (!r.ok) {
              errors.push(`${loadNbr} window ${ordered[i].stopNbr}: ${r.message}`)
              windowFailed = true
              break
            }
          }
          if (windowFailed) continue
          const cur = onLoad.get(loadNbr) || new Set()
          const first = ordered[0]
          if (!cur.has(first.stopNbr)) {
            const r = summarize(await insertStops({}, loadId, [first.stopId]))
            calls++
            if (!r.ok) {
              errors.push(`${loadNbr} add ${first.stopNbr}: ${r.message}`)
              continue
            }
            cur.add(first.stopNbr)
          }
          const removeNbrs = [...cur].filter((n) => n !== first.stopNbr)
          if (removeNbrs.length) {
            const r = summarize(await removeStops({}, loadNbr, removeNbrs.map((n) => byNbr.get(n)?.stopId).filter(Boolean)))
            calls++
            if (!r.ok) {
              errors.push(`${loadNbr} reorder: ${r.message}`)
              continue
            }
            removeNbrs.forEach((n) => cur.delete(n))
          }
          // Re-insert the rest ONE-AT-A-TIME, in order — a single insert appends, so
          // the final sequence is exactly `ordered` (a bulk insert would be geo-
          // reoptimized and lose the dispatcher's order).
          let insertFailed = false
          for (const o of ordered.slice(1)) {
            const r = summarize(await insertStops({}, loadId, [o.stopId]))
            calls++
            if (!r.ok) {
              errors.push(`${loadNbr} insert ${o.stopNbr}: ${r.message}`)
              insertFailed = true
              break
            }
            cur.add(o.stopNbr)
          }
          if (insertFailed) continue
          setSequenceByLoad((m) => ({ ...m, [loadNbr]: ordered.map((o) => o.stopNbr) }))
          setPlanned(ordered.map((o) => o.stopNbr), loadNbr)
        } catch (e) {
          errors.push(`${loadNbr}: ${e.message}`)
        }
      }
      return { ok: !errors.length, message: errors.length ? errors.join(' · ') : `Committed to NuVizz (${calls} call${calls === 1 ? '' : 's'}).`, calls }
    },
    [orders, resolveLoadId, setPlanned],
  )

  return { orders, plan, unplan, reconcile, dispatchDriver, dispatchLoad, sequenceByLoad, sequenceLoad, commit }
}
