import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLoadOrder, createLoadWithStops, BACKOFF_MS } from './loadImportEngine.js'
import { buildStopPayload } from './nuvizzWrite.js'

// ---------------------------------------------------------------------------
// Stub harness — every NuVizz-touching dep records the request it would put on
// the wire and answers from a script. NO live calls anywhere (sleep is a fake
// clock that just records the requested delay).
// ---------------------------------------------------------------------------

// A raw on-load record WITH freight — the fields the Jul 2 wipe blanked.
const rawStop = (stopNbr: string, seq: number | null, over: any = {}) => ({
  stop: {
    stopId: over.stopId || `sid-${stopNbr}`,
    stopNbr,
    stopType: 'DO',
    shipmentType: 'REG',
    stopExecution: 'APP',
    sourceType: 'INTG',
    proNumber: `PRO-${stopNbr}`,
    shipmentNbr: `PRO-${stopNbr}`,
    reference1: `PRO PRO-${stopNbr}`,
    totalPallets: over.pallets ?? 2,
    totalCartons: over.cartons ?? 4,
    weight: over.weight ?? 645,
    weightUOM: 'LBS',
    from: {
      address: { addressType: 'COM', name: 'ULINEUAT', addr1: '943 GAINESVILLE HWY', city: 'BUFORD', state: 'GA', zip: '30518', country: 'USA' },
      schedule: { timeFrom: '2026-07-15T06:00:00', timeTo: '2026-07-15T07:00:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' },
    },
    to: {
      seq,
      address: { addressType: 'COM', name: `CONSIGNEE ${stopNbr}`, addr1: '1 MAIN ST', city: 'ATLANTA', state: 'GA', zip: '30303', country: 'USA' },
      schedule: { timeFrom: '2026-07-15T09:00:00', timeTo: '2026-07-15T09:30:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' },
    },
  },
})

const HEADER = {
  loadId: 'id-SQT1', loadNbr: 'SQTLOAD1', routeName: 'SQT ROUTE 1',
  earliestStartDttm: '2026-07-15T06:00:00', latestStartDttm: '2026-07-15T18:00:00',
  origin: 'WHSE', originName: 'ULINEUAT', originAddr1: '943 GAINESVILLE HWY',
  originCity: 'BUFORD', originState: 'GA', originZip: '30518', originCountry: 'USA', loadTimeZone: 'EST',
}

// A load/info body whose stops sit in the given order (to.seq 2..N; seq 1 = origin).
const loadBody = (stopNbrs: Array<string | [string, number | null]>) => ({
  status: 200,
  data: {
    Load: {
      loadHeader: HEADER,
      versionId: 3,
      stops: stopNbrs.map((s, i) => (Array.isArray(s) ? rawStop(s[0], s[1]) : rawStop(s, i + 2))),
    },
  },
})

// getLoad answers by CALL NUMBER (1-based): script(n) → a {status,data} response.
// stopInfos: stopNbr → { stop?, loadNbr? } for getStop answers (absent = 404).
function makeDeps(script: (n: number) => any, stopInfos: Record<string, any> = {}, ackFor?: (n: number) => any) {
  const requests: any[] = []
  const sleeps: number[] = []
  let loadCalls = 0
  let importCalls = 0
  const deps = {
    getLoad: async (loadNbr: string) => {
      loadCalls++
      requests.push({ op: 'getLoad', loadNbr })
      return script(loadCalls)
    },
    getStop: async (stopNbr: string) => {
      requests.push({ op: 'getStop', stopNbr })
      const rec = stopInfos[stopNbr]
      if (!rec) return { status: 404, data: {} }
      return { status: 200, data: { Stop: { stop: rec.stop, ...(rec.loadNbr ? { load: { loadNbr: rec.loadNbr } } : {}) } } }
    },
    insertStops: async (loadId: string, stopIds: string[]) => {
      requests.push({ op: 'insertStops', loadId, stopIds })
      return { status: 200, data: { status: 'SUCCESS' } }
    },
    importLoads: async (loads: any[]) => {
      importCalls++
      requests.push({ op: 'loadImport', header: loads[0].loadHeader, stopNbrs: loads[0].stops.map((s: any) => s.stopNbr), stops: loads[0].stops })
      return ackFor
        ? ackFor(importCalls)
        : { status: 200, data: { status: 'SUCCESS', message: 'Async import is SUCCESS. Find more info in AppMessageLog with Id- 1' } }
    },
    cancelLoad: async (args: any) => {
      requests.push({ op: 'cancelLoad', ...args })
      return { status: 200, data: { status: 'SUCCESS' } }
    },
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
  }
  return { deps, requests, sleeps }
}

const importsOf = (requests: any[]) => requests.filter((r) => r.op === 'loadImport')
const insertsOf = (requests: any[]) => requests.filter((r) => r.op === 'insertStops')

// ---------------------------------------------------------------------------
// (d) Reorder-only — exactly ONE import, no membership ops, full-echo entries
// ---------------------------------------------------------------------------

test('reorder-only: one full-echo import in array order; NO insertStops; ok only from the read-back', async () => {
  const { deps, requests, sleeps } = makeDeps((n) => (n === 1 ? loadBody(['A', 'B', 'C']) : loadBody(['C', 'A', 'B'])))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['C', 'A', 'B'], deps })
  assert.ok(r.ok)
  assert.equal(insertsOf(requests).length, 0) // membership untouched
  const imports = importsOf(requests)
  assert.equal(imports.length, 1) // reorder stays 1 import
  assert.deepEqual(imports[0].stopNbrs, ['C', 'A', 'B']) // stops[] ARRAY ORDER is the visit order
  assert.deepEqual(r.order, ['C', 'A', 'B']) // read-back truth, not the ack
  assert.equal(sleeps[0], BACKOFF_MS[0]) // first poll waits the ~6s beat
})

// ---------------------------------------------------------------------------
// (b)+(c) Wire payload shape — trap header + FULL ECHOES (freight rides; a
// to-only entry cannot reach the wire)
// ---------------------------------------------------------------------------

test('payload shape: every wire entry is a FULL ECHO — freight/PRO/references + from block + slot window', async () => {
  const { deps, requests } = makeDeps((n) => (n === 1 ? loadBody(['A', 'B']) : loadBody(['B', 'A'])))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['B', 'A'], deps })
  assert.ok(r.ok)
  const sent = importsOf(requests)[0]
  // Header trap fields (silent-failure contract): earliest/latest + flat origin.
  assert.equal(sent.header.earliestStartDttm, '2026-07-15T06:00:00')
  assert.equal(sent.header.latestStartDttm, '2026-07-15T18:00:00')
  for (const k of ['origin', 'originName', 'originAddr1', 'originCity', 'originState', 'originZip', 'originCountry', 'loadTimeZone']) {
    assert.ok(sent.header[k], `header missing ${k}`)
  }
  assert.equal(sent.header.scheduleStartDttm, undefined) // the load/edit name never leaks in
  // FULL ECHO per entry: a matched stop is FULL-REPLACED, so every unsent field
  // would be blanked — freight/PRO/refs + BOTH blocks must be on the wire.
  for (const s of sent.stops) {
    assert.ok(s.stopNbr && s.stopType, 'identity fields')
    assert.ok(s.from?.address?.addr1, 'from block must ride (a to-only entry wipes the record)')
    assert.ok(s.to?.address?.addr1, 'to block must ride')
    assert.equal(typeof s.totalPallets, 'number') // freight rides as NUMBERS
    assert.equal(typeof s.weight, 'number')
    assert.ok(s.proNumber && s.reference1, 'PRO/references ride the echo')
  }
  // The delivery windows ride INSIDE the entries: sequence-aligned 30-min slots.
  assert.equal(sent.stops[0].to.schedule.timeFrom, '2026-07-15T08:00:00')
  assert.equal(sent.stops[1].to.schedule.timeFrom, '2026-07-15T08:30:00')
  // …and there is NO separate per-stop write anywhere on the wire.
  assert.ok(requests.every((q) => q.op === 'getLoad' || q.op === 'loadImport'))
})

// ---------------------------------------------------------------------------
// Declarative unplan (still valid) + preserve-unlisted
// ---------------------------------------------------------------------------

test('unplan: a dropped ON-LOAD stop is OMITTED from the import (declarative; the record survives)', async () => {
  const { deps, requests } = makeDeps((n) => (n === 1 ? loadBody(['A', 'B', 'C']) : loadBody(['A', 'C'])))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['A', 'C'], dropStopNbrs: ['B'], deps })
  assert.ok(r.ok)
  assert.deepEqual(importsOf(requests)[0].stopNbrs, ['A', 'C']) // B omitted, never a remove call
  assert.deepEqual(r.order, ['A', 'C'])
})

test('reorder preserves unlisted on-load stops (a reorder never silently unplans)', async () => {
  const { deps, requests } = makeDeps((n) => (n === 1 ? loadBody(['A', 'B', 'C']) : loadBody(['C', 'A', 'B'])))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['C', 'A'], deps })
  assert.ok(r.ok)
  assert.deepEqual(importsOf(requests)[0].stopNbrs, ['C', 'A', 'B']) // B appended, not dropped
})

test('unchanged order short-circuits: no import fired at all', async () => {
  const { deps, requests } = makeDeps(() => loadBody(['A', 'B']))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['A', 'B'], deps })
  assert.ok(r.ok)
  assert.ok(r.unchanged)
  assert.equal(importsOf(requests).length, 0)
  assert.equal(requests.length, 1) // the single read
})

// ---------------------------------------------------------------------------
// (a) Arrivals — membership via insertStops FIRST; the import only ever carries
// on-load numbers; an off-load number NEVER appears in an import entry
// ---------------------------------------------------------------------------

test('arrival: insertStops (real stopId) THEN one all-on-load full-echo import — never an import entry while off-load', async () => {
  const { deps, requests } = makeDeps(
    (n) => {
      if (n === 1) return loadBody(['A', 'B']) // initial read: X not on the load
      if (n === 2) return loadBody(['A', 'B', 'X']) // re-read after insertStops: X appended
      if (n <= 7) return loadBody(['A', 'B', 'X']) // first import polls: not seated yet
      return loadBody(['X', 'A', 'B']) // the resend seats it
    },
    { X: { stop: rawStop('X', null, { stopId: 'sid-X-real', pallets: 9, weight: 999 }).stop } }, // unplanned real record
  )
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['X', 'A', 'B'], deps })
  assert.ok(r.ok)
  // Wire order: getStop(X) → insertStops([sid-X-real]) → re-read → import(s).
  const kinds = requests.map((q) => q.op)
  const insertAt = kinds.indexOf('insertStops')
  const firstImportAt = kinds.indexOf('loadImport')
  assert.ok(insertAt !== -1 && firstImportAt !== -1 && insertAt < firstImportAt, 'insertStops must precede any import')
  assert.deepEqual(insertsOf(requests)[0].stopIds, ['sid-X-real']) // the REAL record is planned
  assert.deepEqual(requests.filter((q) => q.op === 'getStop').map((q) => q.stopNbr), ['X'])
  // Every import fired carries X only AFTER it is on the load, as a full echo of
  // the ON-LOAD record (freight from the re-read rides the entry).
  for (const imp of importsOf(requests)) {
    assert.deepEqual([...imp.stopNbrs].sort(), ['A', 'B', 'X'])
    const x = imp.stops.find((s: any) => s.stopNbr === 'X')
    assert.equal(typeof x.totalPallets, 'number')
    assert.ok(x.from?.address?.addr1, 'the arrival echoes as a full entry too')
  }
  assert.equal(importsOf(requests).length, 2) // import + the seating resend — no reverse needed
})

test('arrival still planned on ANOTHER load is refused (sources before destinations) — nothing fired', async () => {
  const { deps, requests } = makeDeps(
    (n) => loadBody(['A']),
    { X: { stop: rawStop('X', 2).stop, loadNbr: 'SQTLOAD7' } }, // planned elsewhere
  )
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['X', 'A'], deps })
  assert.ok(!r.ok)
  assert.match(r.message, /still planned on SQTLOAD7/)
  assert.equal(insertsOf(requests).length, 0)
  assert.equal(importsOf(requests).length, 0)
})

test('arrival from an already-released source is allowed via allowFromLoads (stale stop/info pointer)', async () => {
  const { deps, requests } = makeDeps(
    (n) => {
      if (n === 1) return loadBody(['A'])
      if (n === 2) return loadBody(['A', 'X'])
      return loadBody(['X', 'A'])
    },
    { X: { stop: rawStop('X', null, { stopId: 'sid-X-real' }).stop, loadNbr: 'SQTLOAD7' } }, // stale pointer to the released source
  )
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['X', 'A'], allowFromLoads: ['SQTLOAD7'], deps })
  assert.ok(r.ok)
  assert.equal(insertsOf(requests).length, 1)
})

test('arrival: an unknown stop fails fast with no insert and no import', async () => {
  const { deps, requests } = makeDeps((n) => loadBody(['A']))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['NOPE', 'A'], deps })
  assert.ok(!r.ok)
  assert.match(r.message, /not found/)
  assert.equal(insertsOf(requests).length, 0)
  assert.equal(importsOf(requests).length, 0)
})

// ---------------------------------------------------------------------------
// Convergence comparator + escalation (unchanged semantics — still §10.1)
// ---------------------------------------------------------------------------

test('convergence: zero-padding/case differences in the read-back still converge', async () => {
  const { deps } = makeDeps((n) => (n === 1 ? loadBody(['007139395', '007139396']) : loadBody(['007139396', '007139395'])))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['7139396', '7139395'], deps })
  assert.ok(r.ok)
})

test('convergence: a read-back with an incomplete to.seq never counts as converged (mid-rebuild guard)', async () => {
  const { deps } = makeDeps((n) => {
    if (n === 1) return loadBody(['A', 'B'])
    if (n === 2) return loadBody([['B', null], ['A', 2]]) // right membership, seq not seated yet
    return loadBody(['B', 'A'])
  })
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['B', 'A'], deps })
  assert.ok(r.ok)
  assert.equal(r.calls, 4) // read + import + the guarded poll + the converging poll
})

test('convergence: a 404 mid-poll is not-yet-converged, never a failure', async () => {
  const { deps } = makeDeps((n) => {
    if (n === 1) return loadBody(['A', 'B'])
    if (n === 2) return { status: 404, data: { error: 'Not Found' } }
    return loadBody(['B', 'A'])
  })
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['B', 'A'], deps })
  assert.ok(r.ok)
})

test('escalation: resend + reverse-unstick all reach the wire, in order, and ok comes from the final read-back', async () => {
  // Stays wrong through phase 1 (5 polls) and phase 2 (5 polls); converges on the
  // first poll after the reverse+forward pair. getLoad call #1 is the initial read.
  const { deps, requests, sleeps } = makeDeps((n) => (n <= 11 ? loadBody(['A', 'B', 'C']) : loadBody(['C', 'A', 'B'])))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['C', 'A', 'B'], deps })
  assert.ok(r.ok)
  const imports = importsOf(requests)
  assert.equal(imports.length, 4)
  assert.deepEqual(imports[0].stopNbrs, ['C', 'A', 'B']) // the import
  assert.deepEqual(imports[1].stopNbrs, ['C', 'A', 'B']) // re-send the SAME import once
  assert.deepEqual(imports[2].stopNbrs, ['B', 'A', 'C']) // then the array REVERSED…
  assert.deepEqual(imports[3].stopNbrs, ['C', 'A', 'B']) // …then the desired order
  // Backoff ladder honored per phase (~6s then 10/15/25s, capped at 5 polls).
  assert.deepEqual(sleeps.slice(0, 5), BACKOFF_MS)
})

test('escalation: still stuck after the full recipe → ok:false with the stuck order surfaced', async () => {
  const { deps, requests } = makeDeps(() => loadBody(['A', 'B']))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['B', 'A'], deps })
  assert.ok(!r.ok)
  assert.match(r.message, /did not converge/)
  assert.deepEqual(r.order, ['A', 'B']) // last read-back, for the operator
  assert.equal(importsOf(requests).length, 4)
  assert.equal(requests.filter((q) => q.op === 'getLoad').length, 16) // 1 read + 3 ladders × 5 polls
})

test('a hard-rejected import (4xx ack) fails immediately — no polling a doomed import', async () => {
  const { deps, requests } = makeDeps(
    () => loadBody(['A', 'B']),
    {},
    () => ({ status: 400, data: { error: 'Bad Request', message: 'JSON parse error' } }),
  )
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['B', 'A'], deps })
  assert.ok(!r.ok)
  assert.match(r.message, /import rejected/)
  assert.equal(requests.filter((q) => q.op === 'getLoad').length, 1) // only the initial read
})

// ---------------------------------------------------------------------------
// Emptying a load — load/cancel, NEVER an empty stops[] import
// ---------------------------------------------------------------------------

test('empty result routes to load/cancel — an empty import is never sent', async () => {
  const { deps, requests } = makeDeps(() => loadBody(['A', 'B']))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: [], dropStopNbrs: ['A', 'B'], deps })
  assert.ok(r.ok)
  assert.ok(r.cancelled)
  assert.equal(importsOf(requests).length, 0)
  const cancels = requests.filter((q) => q.op === 'cancelLoad')
  assert.equal(cancels.length, 1)
  assert.equal(cancels[0].loadNbr, 'SQTLOAD1')
})

test('a missing load fails cleanly (nothing fired)', async () => {
  const { deps, requests } = makeDeps(() => ({ status: 404, data: {} }))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOADX', desiredStopNbrs: ['A'], deps })
  assert.ok(!r.ok)
  assert.match(r.message, /not found/)
  assert.equal(requests.length, 1)
})

// ---------------------------------------------------------------------------
// (e) CREATE path — full payloads, existence-gated, refuses collisions
// ---------------------------------------------------------------------------

const SETTINGS = { serviceDate: '2026-07-15' }
const newPayload = (stopNbr: string, i: number) =>
  buildStopPayload({ name: `C ${stopNbr}`, addr1: `${i + 1} New Way`, city: 'ATLANTA', state: 'GA', zip: '30303', stopNbr, pallets: String(i + 1), weight: '100', _index: i }, SETTINGS)

test('create: full payloads for absent numbers import in order; getStop gates every number; 404-while-creating is pending', async () => {
  const { deps, requests } = makeDeps((n) => {
    if (n === 1) return { status: 404, data: {} } // the load must not exist yet
    if (n === 2) return { status: 404, data: {} } // first poll: worker still creating
    return loadBody(['N1', 'N2'])
  })
  const r = await createLoadWithStops({
    header: { loadNbr: 'SQTLOADNEW', routeName: 'SQT NEW', serviceDate: '2026-07-15' },
    stopPayloads: [newPayload('N1', 0), newPayload('N2', 1)],
    deps,
  })
  assert.ok(r.ok)
  assert.deepEqual(requests.filter((q) => q.op === 'getStop').map((q) => q.stopNbr), ['N1', 'N2']) // per-number existence gate
  const imp = importsOf(requests)[0]
  assert.deepEqual(imp.stopNbrs, ['N1', 'N2'])
  for (const s of imp.stops) {
    assert.ok(s.from?.address?.addr1 && s.to?.address?.addr1, 'create entries are FULL payloads')
    assert.equal(typeof s.totalPallets, 'number')
  }
  for (const k of ['origin', 'originName', 'originAddr1', 'originCity', 'originState', 'originZip']) {
    assert.ok(imp.header[k], `create header missing ${k}`)
  }
})

test('create: a COLLIDING stop number is refused before any import (it would clone the existing record)', async () => {
  const { deps, requests } = makeDeps(
    () => ({ status: 404, data: {} }),
    { N1: { stop: rawStop('N1', 2).stop } }, // N1 already exists somewhere
  )
  const r = await createLoadWithStops({
    header: { loadNbr: 'SQTLOADNEW', serviceDate: '2026-07-15' },
    stopPayloads: [newPayload('N1', 0)],
    deps,
  })
  assert.ok(!r.ok)
  assert.match(r.message, /already exists/)
  assert.equal(importsOf(requests).length, 0)
})

test('create: an existing loadNbr is refused (that would be a rebuild, not a create)', async () => {
  const { deps, requests } = makeDeps(() => loadBody(['A']))
  const r = await createLoadWithStops({
    header: { loadNbr: 'SQTLOAD1', serviceDate: '2026-07-15' },
    stopPayloads: [newPayload('N1', 0)],
    deps,
  })
  assert.ok(!r.ok)
  assert.match(r.message, /already exists/)
  assert.equal(importsOf(requests).length, 0)
})
