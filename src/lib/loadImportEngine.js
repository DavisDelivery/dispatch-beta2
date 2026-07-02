// LOAD IMPORT engine (§10.1) — the ASYNC half of the batch sequencing path, on the
// TWO-LEVER design (real semantics UAT-reproduced Jul 2 2026, after the same-day
// prod incident — see loadImport.js header + docs/NUVIZZ_API.md §10.1):
//
//   LEVER 1 — MEMBERSHIP (never via import): a stop joins a load ONLY through
//   insertStops (by stopId — it plans the REAL record; an import entry for an
//   off-load stopNbr CLONES a new record instead). A stop leaves a load by being
//   OMITTED from that load's own order import (the omitted on-load record
//   survives, unplanned — that part of the old contract held) or by removeStops.
//
//   LEVER 2 — ORDER (the import): ONE declarative POST load/update/default per
//   load whose every stops[] entry is a FULL ECHO of the just-read on-load record
//   (a matched stop is FULL-REPLACED — a to-only entry blanks freight/PRO/refs).
//   buildImportLoad's mandatory guard makes an off-load entry unrepresentable.
//
// ok:true comes ONLY from a read-back whose delivery order matches the request —
// never from the async 200 ack (which can "succeed" while the worker lands nothing).
//
// CONVERGENCE RECIPE (unchanged — this part of §10.1 held):
//   import → poll load/info on a backoff ladder (~6s then 10/15/25s, ≤5 polls),
//   comparing the read-back delivery order (sorted by stop.to.seq, stopNbr
//   normalized both sides) to the requested stops[] array order.
//   Not converged → re-send the SAME import once (also the reorder pass that seats
//   a freshly-inserted stop, which APPENDS on insert). Still stuck → send the
//   array REVERSED, one beat, then the desired order (verified unstick). A 404
//   while a new load is being created is not-yet-converged, never a failure.
//
// All NuVizz access goes through an injectable `deps` object so the whole engine is
// unit-testable with stubbed requesters and a fake clock (see loadImportEngine.test.ts).

import {
  normStopNbr,
  sameOrder,
  parseLoadInfo,
  parseStopInfo,
  parseStopLoadNbr,
  deliveryOrderFromInfo,
  buildFullEchoStop,
  buildImportHeader,
  buildImportLoad,
  importAckOk,
} from './loadImport.js'
import { getLoad, getStop, importLoads, cancelLoad, insertStops } from './nuvizzWrite.js'

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
    insertStops: (loadId, stopIds) => insertStops({}, loadId, stopIds),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  }
}

// A plain 2xx-with-no-reasons success check for the sync ops (insertStops/cancel).
const syncOk = (resp) => {
  const s = resp?.status ?? 0
  const d = resp?.data
  const body = d && typeof d === 'object' ? d : {}
  return s >= 200 && s < 300 && !(Array.isArray(body.reasons) && body.reasons.length) && !body.error
}
const syncErr = (resp) =>
  resp?.data?.reasons?.[0]?.description || resp?.data?.error || resp?.data?.message || `HTTP ${resp?.status}`

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
  // reorder pass that seats a freshly-inserted stop, which appends on insert).
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
 * applyLoadOrder — realize a load's desired stop set + order via the two levers:
 *
 *   MEMBERSHIP first — desired stops NOT on the load (arrivals) are planned with
 *   ONE bulk insertStops (their real stopIds resolved via getStop; the real
 *   records get planned — never an import entry, which would clone). An arrival
 *   still planned on ANOTHER load is refused unless that load is listed in
 *   `allowFromLoads` (the commit engine passes its already-converged sources,
 *   whose read-backs proved the stop left — covering a stale stop/info pointer).
 *   dropStopNbrs are unplanned DECLARATIVELY: omitted from the order import (the
 *   omitted on-load record survives, unplanned).
 *
 *   ORDER second — one import whose every entry is a FULL ECHO of the on-load
 *   record from the load read (re-read after any inserts, so freshly-planned
 *   records echo their own real fields). Any on-load stop that is neither desired
 *   nor dropped is PRESERVED (appended in its current relative order) — a reorder
 *   must never silently unplan a stop the board doesn't manage. The delivery
 *   window (driver-visible appointment ONLY) is the one rewritten field: the
 *   sequence-aligned 30-min slot.
 *
 *   Emptying: if the final list would be EMPTY, the import is NEVER sent — the
 *   load is retired via load/cancel instead.
 *
 * Returns { ok, message, calls, order?, cancelled?, unchanged? }.
 */
export async function applyLoadOrder({
  loadNbr,
  desiredStopNbrs = [],
  dropStopNbrs = [],
  allowFromLoads = [],
  deps = makeDefaultDeps(),
  backoff = BACKOFF_MS,
}) {
  const counters = { calls: 0 }
  const normLoad = (v) => String(v ?? '').trim().toUpperCase()
  try {
    counters.calls++
    let info = parseLoadInfo(await deps.getLoad(loadNbr))
    if (!info.found) return { ok: false, message: `Load ${loadNbr} not found`, calls: counters.calls }

    // Index the load's current delivery stops by normalized stopNbr (echo sources).
    const indexStops = (inf) => {
      const m = new Map()
      for (const rs of inf.rawStops) {
        const st = rs?.stop || rs
        if (st?.stopNbr != null && String(st.stopType ?? 'DO').toUpperCase() !== 'PU') m.set(normStopNbr(st.stopNbr), rs)
      }
      return m
    }
    let onLoad = indexStops(info)
    const drops = new Set(dropStopNbrs.map(normStopNbr))
    const wantedKeys = []
    const seenKeys = new Set()
    for (const sn of desiredStopNbrs) {
      const key = normStopNbr(sn)
      if (!key || seenKeys.has(key)) continue
      seenKeys.add(key)
      wantedKeys.push({ key, sn: String(sn) })
    }

    // ── LEVER 1: MEMBERSHIP — plan arrivals via insertStops (real records only) ──
    const arrivals = wantedKeys.filter(({ key }) => !onLoad.has(key))
    if (arrivals.length) {
      const allow = new Set(allowFromLoads.map(normLoad))
      const ids = []
      for (const { sn } of arrivals) {
        counters.calls++
        const resp = await deps.getStop(sn)
        const st = parseStopInfo(resp)
        if (!st) return { ok: false, message: `Stop ${sn} not found — cannot plan it onto ${loadNbr}`, calls: counters.calls }
        const curLoad = parseStopLoadNbr(resp)
        if (curLoad && normLoad(curLoad) !== normLoad(loadNbr) && !allow.has(normLoad(curLoad))) {
          return {
            ok: false,
            message: `Stop ${sn} is still planned on ${curLoad} — release the source first (sources before destinations; planning it here now would rely on a steal)`,
            calls: counters.calls,
          }
        }
        if (!st.stopId) return { ok: false, message: `Stop ${sn} has no stopId — cannot insertStops`, calls: counters.calls }
        ids.push(String(st.stopId))
      }
      counters.calls++
      const ins = await deps.insertStops(info.loadId, ids)
      if (!syncOk(ins)) return { ok: false, message: `insertStops onto ${loadNbr} failed: ${syncErr(ins)}`, calls: counters.calls }
      // Re-read: the arrivals' REAL on-load records are the echo sources for the
      // order import (their freight/references ride the echo, nothing is invented).
      counters.calls++
      info = parseLoadInfo(await deps.getLoad(loadNbr))
      if (!info.found) return { ok: false, message: `Load ${loadNbr} unreadable after insertStops`, calls: counters.calls }
      onLoad = indexStops(info)
      for (const { key, sn } of arrivals) {
        if (!onLoad.has(key)) return { ok: false, message: `Stop ${sn} did not land on ${loadNbr} after insertStops — aborting before any import`, calls: counters.calls }
      }
    }

    const current = deliveryOrderFromInfo(info)
    const fallbackDate = (info.header?.earliestStartDttm || '').slice(0, 10)

    // Final ordered list: desired first, then preserved on-load stops (not desired,
    // not dropped) in their current relative order. Drops are simply OMITTED.
    const stops = []
    const want = []
    const listed = new Set()
    const push = (raw, sn) => {
      const echo = buildFullEchoStop(raw, stops.length, fallbackDate)
      if (!echo) throw new Error(`Stop ${sn} has no safely echoable record (missing to/from address or date) — refusing a partial entry that would blank fields`)
      stops.push(echo)
      want.push(echo.stopNbr)
    }
    for (const { key, sn } of wantedKeys) {
      listed.add(key)
      push(onLoad.get(key), sn)
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
      return syncOk(r)
        ? { ok: true, cancelled: true, message: `${loadNbr} emptied — route cancelled via load/cancel.`, calls: counters.calls }
        : { ok: false, message: `cancel ${loadNbr}: ${syncErr(r)}`, calls: counters.calls }
    }

    // Already converged (order AND membership match) → zero imports.
    if (current.seqsComplete && sameOrder(current.order, want)) {
      return { ok: true, unchanged: true, order: current.order, message: `${loadNbr} already in the requested order.`, calls: counters.calls }
    }

    // ── LEVER 2: ORDER — one full-echo import, structurally clone-proof ──────────
    const header = buildImportHeader(info.header, info.rawStops)
    const load = buildImportLoad(header, stops, { onLoad: new Set(onLoad.keys()) })
    return await importAndConverge({ loadNbr, load, want, deps, backoff, counters })
  } catch (e) {
    return { ok: false, message: e.message, calls: counters.calls }
  }
}

/**
 * createLoadWithStops — build a BRAND-NEW load from stop numbers that exist
 * NOWHERE, via one full-payload import (the create path is safe: the import
 * creates complete records in array order). The existence gate is per number:
 * getStop must come back not-found for EVERY payload stopNbr — a collision is
 * refused (importing an existing number would CLONE it under a new stopId, not
 * reuse it), and an existing load with the same loadNbr is refused (a re-import
 * would rebuild it under order semantics, not create).
 *
 * `header` — { loadNbr, routeName?, serviceDate? } (+ optional origin override);
 * `stopPayloads` — FULL stop payloads (buildStopPayload shape: from + to +
 * freight), in the desired visit order.
 */
export async function createLoadWithStops({ header = {}, stopPayloads = [], deps = makeDefaultDeps(), backoff = BACKOFF_MS }) {
  const counters = { calls: 0 }
  const loadNbr = String(header.loadNbr ?? '').trim()
  try {
    if (!loadNbr) return { ok: false, message: 'createLoadWithStops needs header.loadNbr', calls: 0 }
    if (!stopPayloads.length) return { ok: false, message: 'createLoadWithStops needs at least one full stop payload', calls: 0 }

    // The load number must be free (an existing load would be REBUILT, not created).
    counters.calls++
    const existing = parseLoadInfo(await deps.getLoad(loadNbr))
    if (existing.found) return { ok: false, message: `Load ${loadNbr} already exists — use applyLoadOrder to change it`, calls: counters.calls }

    // Existence gate per stop number: every payload number must 404 (a collision
    // would clone the existing record under a new stopId instead of creating).
    const verifiedAbsent = new Set()
    for (const p of stopPayloads) {
      const sn = String(p?.stopNbr ?? '').trim()
      if (!sn) return { ok: false, message: 'every create payload needs a stopNbr', calls: counters.calls }
      counters.calls++
      const st = parseStopInfo(await deps.getStop(sn))
      if (st) return { ok: false, message: `Stop ${sn} already exists (stopId ${st.stopId}) — a create-import would CLONE it; plan it with insertStops instead`, calls: counters.calls }
      verifiedAbsent.add(normStopNbr(sn))
    }

    const importHeader = buildImportHeader(
      {
        loadNbr,
        routeName: header.routeName,
        earliestStartDttm: header.earliestStartDttm || (header.serviceDate ? `${header.serviceDate}T06:00:00` : undefined),
        latestStartDttm: header.latestStartDttm || (header.serviceDate ? `${header.serviceDate}T18:00:00` : undefined),
      },
      stopPayloads.map((p) => ({ stop: p })),
      header.origin,
    )
    const load = buildImportLoad(importHeader, stopPayloads, { create: true, verifiedAbsent })
    const want = stopPayloads.filter((p) => String(p?.stopType ?? 'DO').toUpperCase() !== 'PU').map((p) => String(p.stopNbr))
    return await importAndConverge({ loadNbr, load, want, deps, backoff, counters })
  } catch (e) {
    return { ok: false, message: e.message, calls: counters.calls }
  }
}
