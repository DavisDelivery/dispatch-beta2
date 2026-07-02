// Shared plan/unplan logic against the gated NuVizz write function. The API is
// touched ONLY here, and only on an explicit plan/unplan — no discovery reads.
// Credentials come from server env (the write fn), so we send none.
//
// loadId resolution: from KNOWN_LOADS, else a cached one-time getLoad per load
// number (localStorage dd_loadid_cache) so a load is read at most once, ever.
//
// SEQUENCING + Draft→Save run the LOAD IMPORT path (docs/NUVIZZ_API.md §10.1):
// one declarative POST load/update per touched load + a mandatory convergence
// read-back (src/lib/loadImportEngine.js). insertStops/removeStops remain for the
// incremental plan/unplan actions (a SINGLE insert appends — the one-at-a-time
// append is the fallback ordering control; a BULK insert gets geo-reoptimized).

import { useCallback, useState } from 'react'
import { getLoad, insertStops, removeStops, assignDriver, dispatchLoad as apiDispatchLoad, assignOk, normalizeLoad, summarize } from '../lib/nuvizzWrite.js'
import { applyLoadOrder } from '../lib/loadImportEngine.js'
import { planCommitOrder } from '../lib/loadImport.js'
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

  // Set a load's stop order in NuVizz to exactly `orderedStopNbrs` — the LOAD
  // IMPORT path (docs/NUVIZZ_API.md §10.1): ONE declarative POST load/update sets
  // the load's complete stop list in exact stops[] array order, then the engine
  // polls load/info until the read-back order matches (never trust the async 200
  // ack). The sequence-aligned 30-min delivery slots (the driver-visible
  // appointment, NOT the ordering lever) ride INSIDE the import payload — no
  // separate per-stop window writes. On-load stops omitted from `orderedStopNbrs`
  // are PRESERVED (appended in their current order): a reorder never unplans.
  // (The old anchor method — keep-first + removeStops + one-at-a-time re-insert —
  // is retired from this path; single-insert append remains available via
  // insertStops for incremental adds. See §10.1 for the history.)
  const sequenceLoad = useCallback(
    async (loadNbr, orderedStopNbrs) => {
      const wanted = [...new Set((orderedStopNbrs || []).map((sn) => String(sn)).filter(Boolean))]
      if (wanted.length < 2) return { ok: false, message: 'Need 2+ stops to sequence.' }
      const r = await applyLoadOrder({ loadNbr, desiredStopNbrs: wanted })
      if (r.ok) {
        // read-back order (converged truth) so the board reflects NuVizz reality
        setSequenceByLoad((m) => ({ ...m, [loadNbr]: r.order || wanted }))
        return { ok: true, message: r.unchanged ? r.message : `Sequenced ${wanted.length} stop(s) on ${loadNbr}.`, calls: r.calls }
      }
      return { ok: false, message: r.message, calls: r.calls }
    },
    [],
  )

  // Commit a whole desired board arrangement to NuVizz in one pass (draft → Save) —
  // the LOAD IMPORT path (docs/NUVIZZ_API.md §10.1). `desiredByLoad` is an array of
  // [loadNbr, orderedOrders[]]; any planned order not present in it is treated as
  // moved to Unassigned.
  //
  // ONE declarative import per touched load: stop set + order become exactly the
  // stops[] array; departures are simply OMITTED (declarative unplan — the stop
  // record survives). Cross-load moves run SOURCES BEFORE DESTINATIONS (import A
  // without the stop first, then B with it — never rely on a declarative steal);
  // planCommitOrder topologically sorts the batch and refuses a genuine cycle
  // (a two-load swap — save it as two steps). A load the draft EMPTIES is retired
  // via load/cancel, explicitly — an empty stops[] import is never sent, and the
  // old remove-all path (which cancelled the route as a side effect) is gone.
  // Convergence is mandatory per load: ok comes only from a read-back whose order
  // matches; a stuck source stops the batch (later loads may depend on its unplans).
  const commit = useCallback(
    async (desiredByLoad) => {
      // Departures: every order whose current load ≠ its desired load.
      const desiredLoadOf = new Map()
      for (const [loadNbr, list] of desiredByLoad) for (const o of list) desiredLoadOf.set(o.stopNbr, loadNbr)
      const departByLoad = new Map() // loadNbr -> [stopNbr]
      for (const o of orders) {
        const base = o.plannedLoadNbr || null
        const want = desiredLoadOf.get(o.stopNbr) || null
        if (base && base !== want) {
          if (!departByLoad.has(base)) departByLoad.set(base, [])
          departByLoad.get(base).push(o.stopNbr)
        }
      }

      // One commit entry per touched load. arrivalsFrom = the loads this one gains
      // stops from (orders the entry's list whose current load is another load).
      const entries = []
      const touched = new Set()
      for (const [loadNbr, list] of desiredByLoad) {
        touched.add(loadNbr)
        entries.push({
          loadNbr,
          desiredStopNbrs: list.map((o) => o.stopNbr),
          dropStopNbrs: departByLoad.get(loadNbr) || [],
          arrivalsFrom: [...new Set(list.map((o) => o.plannedLoadNbr).filter((l) => l && l !== loadNbr))],
        })
      }
      // Loads that only LOSE stops (all their orders departed / draft emptied them).
      for (const [loadNbr, stopNbrs] of departByLoad) {
        if (touched.has(loadNbr)) continue
        entries.push({ loadNbr, desiredStopNbrs: [], dropStopNbrs: stopNbrs, arrivalsFrom: [] })
      }
      if (!entries.length) return { ok: true, message: 'Nothing to commit.', calls: 0 }

      let ordered
      try {
        ordered = planCommitOrder(entries)
      } catch (e) {
        return { ok: false, message: e.message, calls: 0 }
      }

      const errors = []
      let calls = 0
      for (const entry of ordered) {
        const r = await applyLoadOrder({ loadNbr: entry.loadNbr, desiredStopNbrs: entry.desiredStopNbrs, dropStopNbrs: entry.dropStopNbrs })
        calls += r.calls || 0
        if (!r.ok) {
          // Sources before destinations: a stuck source must not let a destination
          // "steal" a still-planned stop — stop the batch here.
          errors.push(`${entry.loadNbr}: ${r.message}`)
          break
        }
        if (entry.dropStopNbrs.length) setPlanned(entry.dropStopNbrs, null)
        if (entry.desiredStopNbrs.length) {
          setPlanned(entry.desiredStopNbrs, entry.loadNbr)
          setSequenceByLoad((m) => ({ ...m, [entry.loadNbr]: r.order || entry.desiredStopNbrs }))
        }
      }
      return {
        ok: !errors.length,
        message: errors.length ? errors.join(' · ') : `Committed to NuVizz (${calls} call${calls === 1 ? '' : 's'}).`,
        calls,
      }
    },
    [orders, setPlanned],
  )

  return { orders, plan, unplan, reconcile, dispatchDriver, dispatchLoad, sequenceByLoad, sequenceLoad, commit }
}
