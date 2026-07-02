// LOAD IMPORT engine (§10.1) — the ASYNC half of the batch sequencing path: fire
// ONE declarative import per touched load, then drive it to CONVERGENCE. ok:true
// comes ONLY from a read-back whose delivery order matches the request — never from
// the async 200 ack (which can "succeed" while the background worker lands nothing).
//
// CONVERGENCE RECIPE (verified live, docs/NUVIZZ_API.md §10.1):
//   import → poll load/info on a backoff ladder (~6s then 10/15/25s, ≤5 polls),
//   comparing the read-back delivery order (sorted by stop.to.seq, stopNbr
//   normalized both sides) to the requested stops[] array order.
//   Not converged → re-send the SAME import once (also the reorder pass that seats
//   a newly-added stop, which APPENDS on its first import). Still stuck → send the
//   array REVERSED, one beat, then the desired order (verified to unstick the async
//   worker's stale-state window). A 404 while a new load is being created is
//   not-yet-converged, never a failure.
//
// All NuVizz access goes through an injectable `deps` object so the whole engine is
// unit-testable with stubbed requesters and a fake clock (see loadImportEngine.test.ts).

import {
  normStopNbr,
  sameOrder,
  parseLoadInfo,
  parseStopInfo,
  deliveryOrderFromInfo,
  importRefFromRaw,
  buildImportHeader,
  buildImportLoad,
  importAckOk,
} from './loadImport.js'
import { getLoad, getStop, importLoads, cancelLoad } from './nuvizzWrite.js'

// The poll backoff ladder (ms). ~6s then 10/15/25s, capped at 5 polls per phase —
// the async worker typically seats an import in 5–15s; the tail covers slow days.
export const BACKOFF_MS = [6000, 10000, 15000, 25000, 25000]

// Default deps hit the gated write function (server env creds; UAT-only base).
export function makeDefaultDeps() {
  return {
    getLoad: (loadNbr) => getLoad({}, loadNbr),
    getStop: (stopNbr) => getStop({}, stopNbr),
    importLoads: (loads) => importLoads({}, loads),
    cancelLoad: (args) => cancelLoad({}, args),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  }
}

// One poll phase: read load/info up to backoff.length times, until the load's
// delivery order equals `want` (array equality = order AND membership). found:false
// (404 / no header yet) simply reads as not-yet-converged.
async function pollUntilConverged(loadNbr, want, deps, backoff, counters) {
  let seen = null
  for (const ms of backoff) {
    await deps.sleep(ms)
    const info = parseLoadInfo(await deps.getLoad(loadNbr))
    counters.calls++
    if (!info.found) continue
    const d = deliveryOrderFromInfo(info)
    seen = d.order
    if (d.seqsComplete && sameOrder(d.order, want)) return { converged: true, seen }
  }
  return { converged: false, seen }
}

/**
 * importAndConverge — fire ONE load's import and drive it to convergence.
 * `load` = the validated { loadHeader, stops } (buildImportLoad); `want` = the
 * requested delivery stopNbrs (= the stops[] array order).
 * Returns { ok, order, message, calls } — ok ONLY from a matching read-back.
 */
export async function importAndConverge({ loadNbr, load, want, deps, backoff = BACKOFF_MS, counters = { calls: 0 } }) {
  const fire = async (stops) => {
    counters.calls++
    return importAckOk(await deps.importLoads([{ loadHeader: load.loadHeader, stops }]))
  }
  const fail = (message, seen) => ({ ok: false, order: seen ?? null, message, calls: counters.calls })
  const done = (seen) => ({ ok: true, order: seen, message: `Converged (${counters.calls} calls).`, calls: counters.calls })

  // Phase 1 — the import, then poll.
  let ack = await fire(load.stops)
  if (!ack.ok) return fail(`import rejected: ${ack.message}`)
  let c = await pollUntilConverged(loadNbr, want, deps, backoff, counters)
  if (c.converged) return done(c.seen)

  // Phase 2 — re-send the SAME import once (the recipe's first unstick; also the
  // reorder pass that seats a newly-added stop, which appends on its first import).
  ack = await fire(load.stops)
  if (ack.ok) {
    c = await pollUntilConverged(loadNbr, want, deps, backoff, counters)
    if (c.converged) return done(c.seen)
  }

  // Phase 3 — REVERSED then desired (verified to unstick the async worker's
  // stale-state window), one beat apart, then a final poll.
  await fire([...load.stops].reverse())
  await deps.sleep(backoff[0])
  await fire(load.stops)
  c = await pollUntilConverged(loadNbr, want, deps, backoff, counters)
  if (c.converged) return done(c.seen)
  return fail(`order did not converge after re-send + reverse-unstick — verify load ${loadNbr} in the portal before retrying`, c.seen)
}

/**
 * applyLoadOrder — realize a load's desired stop set + order via ONE declarative
 * import (+ convergence). The heart of both sequenceLoad and the commit engine.
 *
 *   • desiredStopNbrs — the stops we want on the load, in visit order. Stops not
 *     currently on the load (arrivals) are planned BY REFERENCE (their "to" block
 *     echoed from stop/info — never invented).
 *   • dropStopNbrs — stops explicitly allowed to be UNPLANNED (declaratively
 *     omitted from the import; the stop record survives). Any on-load stop that is
 *     neither desired nor dropped is PRESERVED (appended after the desired order in
 *     its current relative order) — a reorder must never silently unplan a stop the
 *     board doesn't manage.
 *   • Emptying: if the final list would be EMPTY, the import is NEVER sent — the
 *     load is retired via load/cancel instead (an empty stops[] import is unsafe,
 *     and the old remove-all path CANCELLED the route implicitly; this makes the
 *     cancel explicit).
 *   • Windows: each stop's delivery window (the driver-visible appointment ONLY)
 *     rides inside the import as the sequence-aligned 30-min slot — there are no
 *     separate per-stop window writes on this path (the old full-upsert blanked
 *     freight fields).
 *
 * Returns { ok, message, calls, order?, cancelled?, unchanged? }.
 */
export async function applyLoadOrder({ loadNbr, desiredStopNbrs = [], dropStopNbrs = [], deps = makeDefaultDeps(), backoff = BACKOFF_MS }) {
  const counters = { calls: 0 }
  try {
    counters.calls++
    const info = parseLoadInfo(await deps.getLoad(loadNbr))
    if (!info.found) return { ok: false, message: `Load ${loadNbr} not found`, calls: counters.calls }

    // Index the load's current delivery stops by normalized stopNbr (echo sources).
    const onLoad = new Map()
    for (const rs of info.rawStops) {
      const st = rs?.stop || rs
      if (st?.stopNbr != null && String(st.stopType ?? 'DO').toUpperCase() !== 'PU') onLoad.set(normStopNbr(st.stopNbr), rs)
    }
    const current = deliveryOrderFromInfo(info)
    const drops = new Set(dropStopNbrs.map(normStopNbr))

    // Build the final ordered stop list: desired first (arrivals echoed via
    // stop/info), then any preserved on-load stops (not desired, not dropped).
    const stops = []
    const want = []
    const listed = new Set()
    const push = (raw, sn) => {
      const ref = importRefFromRaw(raw, stops.length, (info.header?.earliestStartDttm || '').slice(0, 10))
      if (!ref) throw new Error(`Stop ${sn} has no echoable "to" block — cannot build a safe import reference`)
      stops.push(ref)
      want.push(ref.stopNbr)
    }
    for (const sn of desiredStopNbrs) {
      const key = normStopNbr(sn)
      if (!key || listed.has(key)) continue
      listed.add(key)
      let raw = onLoad.get(key)
      if (!raw) {
        counters.calls++
        raw = parseStopInfo(await deps.getStop(sn))
        if (!raw) return { ok: false, message: `Stop ${sn} not found — cannot plan it by reference`, calls: counters.calls }
      }
      push(raw, sn)
    }
    for (const sn of current.order) {
      const key = normStopNbr(sn)
      if (listed.has(key) || drops.has(key)) continue
      listed.add(key)
      push(onLoad.get(key), sn)
    }

    // EMPTY result → explicit load/cancel; NEVER an empty import.
    if (!stops.length) {
      counters.calls++
      const r = await deps.cancelLoad({ loadNbr, loadId: info.loadId || undefined, reasonCode: 'OTH', reasonComments: 'emptied from dispatch board' })
      const ok = (r?.status ?? 0) >= 200 && (r?.status ?? 0) < 300 && !r?.data?.reasons?.length && !r?.data?.error
      return ok
        ? { ok: true, cancelled: true, message: `${loadNbr} emptied — route cancelled via load/cancel.`, calls: counters.calls }
        : { ok: false, message: `cancel ${loadNbr}: ${r?.data?.reasons?.[0]?.description || r?.data?.error || `HTTP ${r?.status}`}`, calls: counters.calls }
    }

    // Already converged (order AND membership match) → zero writes.
    if (current.seqsComplete && sameOrder(current.order, want)) {
      return { ok: true, unchanged: true, order: current.order, message: `${loadNbr} already in the requested order.`, calls: counters.calls }
    }

    const header = buildImportHeader(info.header, info.rawStops)
    const load = buildImportLoad(header, stops)
    return await importAndConverge({ loadNbr, load, want, deps, backoff, counters })
  } catch (e) {
    return { ok: false, message: e.message, calls: counters.calls }
  }
}
