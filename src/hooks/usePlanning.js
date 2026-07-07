// Shared plan/unplan logic against the gated NuVizz write function. The API is
// touched ONLY here, and only on an explicit plan/unplan — no discovery reads.
// Credentials come from server env (the write fn), so we send none.
//
// loadId resolution: from KNOWN_LOADS, else a cached one-time getLoad per load
// number (localStorage dd_loadid_cache) so a load is read at most once, ever.
//
// SEQUENCING + Draft→Save run the TWO-LEVER engine (docs/NUVIZZ_API.md §10.1):
// MEMBERSHIP via insertStops/removeStops (an import entry for an off-load stopNbr
// CLONES a new stop record — proven Jul 2 2026), ORDER via one full-echo
// load/update import per touched load + a mandatory convergence read-back
// (src/lib/loadImportEngine.js). insertStops also remains the incremental
// plan action (a SINGLE insert appends; a BULK insert gets geo-reoptimized —
// the follow-up order import seats the sequence either way).

import { useCallback, useState } from 'react'
import { getLoad, insertStops, removeStops, assignDriver, dispatchLoad as apiDispatchLoad, assignOk, normalizeLoad, summarize } from '../lib/nuvizzWrite.js'
import { applyLoadOrder } from '../lib/loadImportEngine.js'
import { planCommitOrder } from '../lib/loadImport.js'
import { rwbSequenceStops } from '../lib/nuvizzRwb.js'
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

  // Set a load's stop order in NuVizz to exactly `orderedStopNbrs` — the TWO-LEVER
  // engine (docs/NUVIZZ_API.md §10.1, real matching semantics UAT-proven Jul 2 2026):
  // MEMBERSHIP via insertStops (an off-load stopNbr in an import CLONES a new stop
  // record — never matches), ORDER via ONE import whose every entry is a FULL ECHO
  // of the just-read on-load record (a matched stop is FULL-REPLACED; a partial
  // entry blanks freight/PRO/references). The engine polls load/info until the
  // read-back order matches (never trust the async 200 ack). The sequence-aligned
  // 30-min delivery slots (the driver-visible appointment, NOT the ordering lever)
  // ride inside the echo — no separate per-stop window writes. On-load stops
  // omitted from `orderedStopNbrs` are PRESERVED (appended in their current
  // order): a reorder never unplans. (The old anchor method — keep-first +
  // removeStops + one-at-a-time re-insert — is retired from this path; see §10.1.)
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
  // the TWO-LEVER engine (docs/NUVIZZ_API.md §10.1). `desiredByLoad` is an array of
  // [loadNbr, orderedOrders[]]; any planned order not present in it is treated as
  // moved to Unassigned.
  //
  // Per touched load: MEMBERSHIP first (arrivals planned by insertStops on their
  // real stopIds — an import entry for an off-load stopNbr would CLONE a new stop
  // record, proven Jul 2 2026), then ONE full-echo ORDER import; departures are
  // OMITTED from their source's own import (the record survives, unplanned).
  // Cross-load moves run SOURCES BEFORE DESTINATIONS: planCommitOrder topologically
  // sorts the batch (a two-load swap cycle is refused — save it as two steps), and
  // each converged source is passed to later loads via allowFromLoads so a stale
  // stop/info pointer never blocks the destination's insert. A load the draft
  // EMPTIES is retired via load/cancel, explicitly — an empty stops[] import is
  // never sent, and the old remove-all path (which cancelled the route as a side
  // effect) is gone. Convergence is mandatory per load: ok comes only from a
  // read-back whose order matches; a stuck source stops the batch.
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
      const releasedSources = [] // converged loads whose read-backs proved their departures left
      for (const entry of ordered) {
        const r = await applyLoadOrder({
          loadNbr: entry.loadNbr,
          desiredStopNbrs: entry.desiredStopNbrs,
          dropStopNbrs: entry.dropStopNbrs,
          allowFromLoads: releasedSources,
        })
        calls += r.calls || 0
        if (!r.ok) {
          // Sources before destinations: a stuck source must not let a destination
          // plan a still-planned stop — stop the batch here.
          errors.push(`${entry.loadNbr}: ${r.message}`)
          break
        }
        releasedSources.push(entry.loadNbr)
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

  // RWB-mode commit — the same board arrangement, but ORDER is set through the proven
  // 2-call Route Workbench path (docs/NUVIZZ_API.md §10.2) instead of the full-echo
  // import engine. Membership still rides openapi insertStops/removeStops (1 call each,
  // already minimal). Phases run sources-before-destinations so a stop is never inserted
  // onto its new load while still on the old one:
  //   1. RELEASE  — removeStops for every departure (order left its load)
  //   2. PLAN     — insertStops arrivals onto each destination (must precede sequence:
  //                 RWB sequences stops already ON the route)
  //   3. SEQUENCE — one rwbSequenceStops per load whose order changed (2 calls; skipped
  //                 when the desired order already matches, so a pure move costs 0 here)
  // Data integrity: saveComparedRouteData references stops by id and never rewrites the
  // stop record — freight/addresses/item lines are untouched (byte-verified, Jul 2026).
  const commitRwb = useCallback(
    async (desiredByLoad) => {
      const desiredLoadOf = new Map()
      for (const [loadNbr, list] of desiredByLoad) for (const o of list) desiredLoadOf.set(o.stopNbr, loadNbr)

      // Departures grouped by the load they leave.
      const departByLoad = new Map()
      for (const o of orders) {
        const base = o.plannedLoadNbr || null
        const want = desiredLoadOf.get(o.stopNbr) || null
        if (base && base !== want) {
          if (!departByLoad.has(base)) departByLoad.set(base, [])
          departByLoad.get(base).push(o)
        }
      }

      let calls = 0
      const errors = []

      // 1) RELEASE
      for (const [loadNbr, group] of departByLoad) {
        const ids = group.map((o) => o.stopId).filter(Boolean)
        if (!ids.length) continue
        const r = summarize(await removeStops({}, loadNbr, ids))
        calls++
        if (r.ok) setPlanned(group.map((o) => o.stopNbr), null)
        else errors.push(`unplan ${loadNbr}: ${r.message}`)
      }

      // 2) PLAN arrivals onto each destination
      for (const [loadNbr, list] of desiredByLoad) {
        const arrivals = list.filter((o) => (o.plannedLoadNbr || null) !== loadNbr && o.stopId)
        if (!arrivals.length) continue
        try {
          const loadId = await resolveLoadId(loadNbr)
          const r = summarize(await insertStops({}, loadId, arrivals.map((o) => o.stopId)))
          calls++
          if (!r.ok) errors.push(`plan ${loadNbr}: ${r.message}`)
        } catch (e) {
          errors.push(`plan ${loadNbr}: ${e.message}`)
        }
      }

      // 3) SEQUENCE each destination whose order changed
      for (const [loadNbr, list] of desiredByLoad) {
        const orderedStopNbrs = list.map((o) => o.stopNbr)
        const orderedStopIds = list.map((o) => o.stopId).filter(Boolean)
        const cur = sequenceByLoad[loadNbr] || []
        const sameOrder = cur.length === orderedStopNbrs.length && cur.every((sn, i) => sn === orderedStopNbrs[i])
        if (orderedStopIds.length >= 2 && !sameOrder) {
          try {
            const loadId = await resolveLoadId(loadNbr)
            const r = await rwbSequenceStops({ routePlanId: loadId, orderedStopIds })
            calls += r.calls || 0
            if (!r.ok) errors.push(`sequence ${loadNbr}: ${r.message}`)
          } catch (e) {
            errors.push(`sequence ${loadNbr}: ${e.message}`)
          }
        }
        setPlanned(orderedStopNbrs, loadNbr)
        setSequenceByLoad((m) => ({ ...m, [loadNbr]: orderedStopNbrs }))
      }

      return {
        ok: !errors.length,
        message: errors.length ? errors.join(' · ') : `Committed via RWB (${calls} call${calls === 1 ? '' : 's'}).`,
        calls,
      }
    },
    [orders, sequenceByLoad, resolveLoadId, setPlanned],
  )

  return { orders, plan, unplan, reconcile, dispatchDriver, dispatchLoad, sequenceByLoad, sequenceLoad, commit, commitRwb }
}
