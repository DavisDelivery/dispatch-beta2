import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLoadOrder, BACKOFF_MS } from './loadImportEngine.js'

// ---------------------------------------------------------------------------
// Stub harness — every NuVizz-touching dep records the request it would put on
// the wire and answers from a script. NO live calls anywhere (sleep is a fake
// clock that just records the requested delay).
// ---------------------------------------------------------------------------

const rawStop = (stopNbr: string, seq: number | null) => ({
  stop: {
    stopId: `sid-${stopNbr}`,
    stopNbr,
    stopType: 'DO',
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
      const st = stopInfos[stopNbr]
      return st ? { status: 200, data: { Stop: { stop: st } } } : { status: 404, data: {} }
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

// ---------------------------------------------------------------------------
// Declarative reorder — one import, array order = visit order, convergence read
// ---------------------------------------------------------------------------

test('reorder: one declarative import in array order; ok only after the read-back matches', async () => {
  const { deps, requests, sleeps } = makeDeps((n) => (n === 1 ? loadBody(['A', 'B', 'C']) : loadBody(['C', 'A', 'B'])))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['C', 'A', 'B'], deps })
  assert.ok(r.ok)
  const imports = importsOf(requests)
  assert.equal(imports.length, 1)
  assert.deepEqual(imports[0].stopNbrs, ['C', 'A', 'B']) // stops[] ARRAY ORDER is the visit order
  assert.deepEqual(r.order, ['C', 'A', 'B']) // read-back truth, not the ack
  assert.equal(sleeps[0], BACKOFF_MS[0]) // first poll waits the ~6s beat
})

test('payload shape: the wire import carries the trap header fields + echoed to-blocks + slot windows', async () => {
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
  // Stops are REFERENCES: stopNbr + stopType + a "to" block echoed from the read.
  for (const s of sent.stops) {
    assert.ok(s.stopNbr && s.stopType && s.to?.address?.addr1, 'bare reference would be rejected')
  }
  // The delivery windows ride INSIDE the import: sequence-aligned 30-min slots.
  assert.equal(sent.stops[0].to.schedule.timeFrom, '2026-07-15T08:00:00')
  assert.equal(sent.stops[1].to.schedule.timeFrom, '2026-07-15T08:30:00')
  // …and there is NO separate per-stop window write anywhere on the wire.
  assert.ok(requests.every((q) => q.op === 'getLoad' || q.op === 'loadImport'))
})

// ---------------------------------------------------------------------------
// Declarative unplan — omitted stops leave the load; unlisted strangers stay
// ---------------------------------------------------------------------------

test('unplan: a dropped stop is OMITTED from the import (declarative), and the read-back proves it left', async () => {
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
// Convergence comparator normalization at the engine level
// ---------------------------------------------------------------------------

test('convergence: zero-padding/case differences in the read-back still converge', async () => {
  const { deps } = makeDeps((n) => (n === 1 ? loadBody(['007139395', '007139396']) : loadBody(['007139396', '007139395'])))
  // Desired uses the UNPADDED form — the comparator must normalize both sides.
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

// ---------------------------------------------------------------------------
// The escalation ladder — resend once, then REVERSED + desired (unstick)
// ---------------------------------------------------------------------------

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
  const { deps, requests } = makeDeps((n) => (n === 1 ? loadBody(['A', 'B']) : loadBody(['A', 'B'])))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['B', 'A'], deps })
  assert.ok(!r.ok)
  assert.match(r.message, /did not converge/)
  assert.deepEqual(r.order, ['A', 'B']) // last read-back, for the operator
  assert.equal(importsOf(requests).length, 4)
  assert.equal(requests.filter((q) => q.op === 'getLoad').length, 16) // 1 read + 3 ladders × 5 polls
})

test('a hard-rejected import (4xx ack) fails immediately — no polling a doomed import', async () => {
  const { deps, requests } = makeDeps(
    (n) => loadBody(['A', 'B']),
    {},
    () => ({ status: 400, data: { error: 'Bad Request', message: 'JSON parse error' } }),
  )
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['B', 'A'], deps })
  assert.ok(!r.ok)
  assert.match(r.message, /import rejected/)
  assert.equal(requests.filter((q) => q.op === 'getLoad').length, 1) // only the initial read
})

// ---------------------------------------------------------------------------
// Arrivals — planned BY REFERENCE from stop/info; first import appends, resend seats
// ---------------------------------------------------------------------------

test('arrival: an off-load stop is echoed from stop/info; the appended add is seated by the resend', async () => {
  const { deps, requests } = makeDeps(
    (n) => {
      if (n === 1) return loadBody(['A', 'B'])
      if (n <= 6) return loadBody(['A', 'B', 'X']) // the add APPENDED on the first import
      return loadBody(['X', 'A', 'B']) // the resend seats it
    },
    { X: rawStop('X', null).stop },
  )
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['X', 'A', 'B'], deps })
  assert.ok(r.ok)
  assert.deepEqual(requests.filter((q) => q.op === 'getStop').map((q) => q.stopNbr), ['X']) // echo, never invent
  const imports = importsOf(requests)
  assert.equal(imports.length, 2) // import + the seating resend — no reverse needed
  assert.deepEqual(imports[0].stopNbrs, ['X', 'A', 'B'])
  assert.ok(imports[0].stops[0].to.address.addr1) // the reference carries the echoed to-block
})

test('arrival: an unknown stop fails fast with no import fired', async () => {
  const { deps, requests } = makeDeps((n) => loadBody(['A']))
  const r = await applyLoadOrder({ loadNbr: 'SQTLOAD1', desiredStopNbrs: ['NOPE', 'A'], deps })
  assert.ok(!r.ok)
  assert.match(r.message, /not found/)
  assert.equal(importsOf(requests).length, 0)
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
