import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  planCommitOrder,
} from './loadImport.js'

// ---------------------------------------------------------------------------
// Fixture builders (UAT-shaped; naming rule: no vendor/agent names anywhere)
// ---------------------------------------------------------------------------

const rawStop = (stopNbr: string, seq: number | null, over: any = {}) => ({
  stop: {
    stopId: `sid-${stopNbr}`,
    stopNbr,
    stopType: over.stopType || 'DO',
    from: {
      address: { addressType: 'COM', name: 'ULINEUAT', addr1: '943 GAINESVILLE HWY', city: 'BUFORD', state: 'GA', zip: '30518', country: 'USA' },
      schedule: { timeFrom: '2026-07-15T06:00:00', timeTo: '2026-07-15T07:00:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' },
    },
    to: {
      seq,
      address: { addressType: 'COM', name: `CONSIGNEE ${stopNbr}`, addr1: `${seq ?? 1} MAIN ST`, city: 'ATLANTA', state: 'GEORGIA', zip: '30303', country: 'UNITED STATES', latitude: 33.7, longitude: -84.4 },
      schedule: { timeFrom: '2026-07-15T09:00:00', timeTo: '2026-07-15T09:30:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' },
      ...over.to,
    },
  },
})

const HEADER = {
  loadId: 'id-SQT1', loadNbr: 'SQTLOAD1', routeName: 'SQT ROUTE 1',
  earliestStartDttm: '2026-07-15T06:00:00', latestStartDttm: '2026-07-15T18:00:00',
  origin: 'WHSE', originName: 'ULINEUAT', originAddr1: '943 GAINESVILLE HWY',
  originCity: 'BUFORD', originState: 'GA', originZip: '30518', originCountry: 'USA', loadTimeZone: 'EST',
}

const loadInfoResp = (stops: any[], header: any = HEADER) => ({
  status: 200,
  data: { Load: { loadHeader: header, versionId: 3, stops } },
})

// ---------------------------------------------------------------------------
// normStopNbr + sameOrder — the convergence comparator normalization
// ---------------------------------------------------------------------------

test('normStopNbr: strips leading zeros, trims, uppercases', () => {
  assert.equal(normStopNbr('007141643'), '7141643')
  assert.equal(normStopNbr(' 007141643 '), '7141643')
  assert.equal(normStopNbr(7141643), '7141643')
  assert.equal(normStopNbr('ord-12'), 'ORD-12')
  assert.equal(normStopNbr('0'), '0') // never strips to empty
  assert.equal(normStopNbr('000'), '0')
})

test('sameOrder: padding/case/typing mismatches never read as not-converged', () => {
  assert.ok(sameOrder(['007141643', 'ab1'], [7141643 as any, ' AB1 ']))
  assert.ok(!sameOrder(['A', 'B'], ['B', 'A'])) // real order difference
  assert.ok(!sameOrder(['A', 'B'], ['A'])) // membership difference
  assert.ok(!sameOrder(['A'], ['A', 'B']))
})

// ---------------------------------------------------------------------------
// parseLoadInfo / deliveryOrderFromInfo — read-back side of the comparator
// ---------------------------------------------------------------------------

test('parseLoadInfo: 404 / missing header reads as not-found (pending), never a throw', () => {
  assert.equal(parseLoadInfo({ status: 404, data: { error: 'Not Found' } }).found, false)
  assert.equal(parseLoadInfo({ status: 200, data: {} }).found, false)
  assert.equal(parseLoadInfo(loadInfoResp([rawStop('A', 2)])).found, true)
})

test('deliveryOrderFromInfo: sorts by to.seq and excludes pickups', () => {
  const info = parseLoadInfo(loadInfoResp([
    rawStop('B', 3),
    { stop: { stopNbr: 'PU1', stopType: 'PU', to: { seq: 1, address: { addr1: 'X' } } } },
    rawStop('A', 2),
    rawStop('C', 4),
  ]))
  const d = deliveryOrderFromInfo(info)
  assert.deepEqual(d.order, ['A', 'B', 'C'])
  assert.ok(d.seqsComplete)
})

test('deliveryOrderFromInfo: a missing to.seq flags seqsComplete=false (mid-rebuild guard)', () => {
  const info = parseLoadInfo(loadInfoResp([rawStop('A', 2), rawStop('B', null)]))
  assert.equal(deliveryOrderFromInfo(info).seqsComplete, false)
})

// ---------------------------------------------------------------------------
// importRefFromRaw — echo the "to" block, stamp the slot window by position
// ---------------------------------------------------------------------------

test('importRefFromRaw: echoes the address from the read (whitelisted, normalized), never invents', () => {
  const ref = importRefFromRaw(rawStop('007139395', 2), 0)
  assert.equal(ref.stopNbr, '007139395') // raw form kept for the wire
  assert.equal(ref.stopType, 'DO')
  assert.equal(ref.to.address.name, 'CONSIGNEE 007139395')
  assert.equal(ref.to.address.addr1, '2 MAIN ST')
  assert.equal(ref.to.address.state, 'GA') // GEORGIA normalized
  assert.equal(ref.to.address.country, 'USA') // UNITED STATES normalized
  assert.equal(ref.to.address.latitude, undefined) // junk fields never echoed
  assert.equal((ref.to.address as any).seq, undefined)
})

test('importRefFromRaw: delivery window = the 30-min slot for the visit index, on the stop’s own date', () => {
  const r0 = importRefFromRaw(rawStop('A', 2), 0)
  const r3 = importRefFromRaw(rawStop('B', 3), 3)
  assert.equal(r0.to.schedule.timeFrom, '2026-07-15T08:00:00')
  assert.equal(r0.to.schedule.timeTo, '2026-07-15T08:30:00')
  assert.equal(r3.to.schedule.timeFrom, '2026-07-15T09:30:00')
  assert.equal(r3.to.schedule.timeConstraint, 'PREFERRED')
})

test('importRefFromRaw: refuses a record without an echoable address (bare refs are rejected upstream)', () => {
  assert.equal(importRefFromRaw({ stop: { stopNbr: 'A', to: { address: {} } } }, 0), null)
  assert.equal(importRefFromRaw({ stop: { to: { address: { addr1: '1 St' } } } }, 0), null)
})

// ---------------------------------------------------------------------------
// buildImportHeader — the silent-failure trap fields
// ---------------------------------------------------------------------------

test('buildImportHeader: carries earliest/latest + ALL flat origin fields', () => {
  const h = buildImportHeader(HEADER, [])
  assert.equal(h.loadNbr, 'SQTLOAD1')
  assert.equal(h.earliestStartDttm, '2026-07-15T06:00:00')
  assert.equal(h.latestStartDttm, '2026-07-15T18:00:00')
  for (const k of ['origin', 'originName', 'originAddr1', 'originCity', 'originState', 'originZip', 'originCountry', 'loadTimeZone']) {
    assert.ok((h as any)[k], `missing ${k}`)
  }
  assert.equal((h as any).scheduleStartDttm, undefined) // load/edit naming never leaks in
})

test('buildImportHeader: falls back to a stop’s from-address when the header has no flat origin', () => {
  const bare = { loadNbr: 'SQTLOAD2', earliestStartDttm: '2026-07-15T06:00:00', latestStartDttm: '2026-07-15T18:00:00', rtOrigin: 'WHSE' }
  const h = buildImportHeader(bare, [rawStop('A', 2)])
  assert.equal(h.originName, 'ULINEUAT')
  assert.equal(h.originAddr1, '943 GAINESVILLE HWY')
  assert.equal(h.originZip, '30518')
})

test('buildImportHeader: refuses epoch/millis dates (echo only ISO), derives the 06:00-18:00 fallback', () => {
  const h = buildImportHeader({ loadNbr: 'SQTLOAD3', earliestStartDttm: 1752555600000 as any, latestStartDttm: null }, [rawStop('A', 2)])
  assert.equal(h.earliestStartDttm, '2026-07-15T06:00:00') // derived from the stop schedule date
  assert.equal(h.latestStartDttm, '2026-07-15T18:00:00')
})

test('buildImportHeader: an OBJECT under origin is never echoed (string coercion guard)', () => {
  const messy = { ...HEADER, origin: { addr1: 'X' } as any, rtOrigin: 'DEPOT7' }
  const h = buildImportHeader(messy, [])
  assert.equal(h.origin, 'DEPOT7') // fell through to rtOrigin, not the object
})

test('buildImportHeader: throws when no date is derivable anywhere', () => {
  assert.throws(() => buildImportHeader({ loadNbr: 'SQTLOAD4' }, []), /no earliest\/latest/)
})

// ---------------------------------------------------------------------------
// buildImportLoad — payload validation (the trap + safety rails)
// ---------------------------------------------------------------------------

const okStops = [importRefFromRaw(rawStop('A', 2), 0), importRefFromRaw(rawStop('B', 3), 1)]

test('buildImportLoad: a valid header + refs assembles the load', () => {
  const L = buildImportLoad(buildImportHeader(HEADER, []), okStops.slice())
  assert.equal(L.loadHeader.loadNbr, 'SQTLOAD1')
  assert.deepEqual(L.stops.map((s: any) => s.stopNbr), ['A', 'B'])
})

test('buildImportLoad: refuses an EMPTY stops[] (use load/cancel to retire a load)', () => {
  assert.throws(() => buildImportLoad(buildImportHeader(HEADER, []), []), /load\/cancel/)
})

test('buildImportLoad: refuses a bare stopNbr reference (no "to" block)', () => {
  assert.throws(() => buildImportLoad(buildImportHeader(HEADER, []), [{ stopNbr: 'A' }]), /"to" block/)
})

test('buildImportLoad: refuses missing trap fields', () => {
  const h: any = { ...buildImportHeader(HEADER, []) }
  delete h.originZip
  assert.throws(() => buildImportLoad(h, okStops.slice()), /originZip/)
  const h2: any = { ...buildImportHeader(HEADER, []) }
  delete h2.earliestStartDttm
  h2.scheduleStartDttm = '2026-07-15T06:00:00'
  assert.throws(() => buildImportLoad(h2, okStops.slice()), /scheduleStartDttm/)
})

test('buildImportLoad: refuses forbidden vendor/agent names in load/route names', () => {
  const h: any = { ...buildImportHeader(HEADER, []), routeName: 'CLAUDE TEST ROUTE' }
  assert.throws(() => buildImportLoad(h, okStops.slice()), /never contain/)
})

// ---------------------------------------------------------------------------
// importAckOk — the async ack is an ACCEPTANCE, and non-success never passes
// ---------------------------------------------------------------------------

test('importAckOk: accepts the async SUCCESS ack (sentence or bare token)', () => {
  assert.ok(importAckOk({ status: 200, data: { status: 'SUCCESS', message: 'Async import is SUCCESS. Find more info in AppMessageLog with Id- 123' } }).ok)
  assert.ok(importAckOk({ status: 200, data: { status: 'Request for LOAD Async import is SUCCESS. Find more info in AppMessageLog with Id- 9' } }).ok)
})

test('importAckOk: rejects failure-flavored or reasoned bodies even on HTTP 200', () => {
  assert.ok(!importAckOk({ status: 200, data: { status: 'PARTIALSUCCESS' } }).ok)
  assert.ok(!importAckOk({ status: 200, data: { status: 'SUCCESS', reasons: [{ description: 'bad stop' }] } }).ok)
  assert.ok(!importAckOk({ status: 400, data: { error: 'Bad Request' } }).ok)
})

// ---------------------------------------------------------------------------
// planCommitOrder — sources before destinations; cycles refused
// ---------------------------------------------------------------------------

test('planCommitOrder: a cross-load move imports the SOURCE before the DESTINATION', () => {
  const ordered = planCommitOrder([
    { loadNbr: 'LOADB', desiredStopNbrs: ['S1', 'X'], dropStopNbrs: [], arrivalsFrom: ['LOADA'] },
    { loadNbr: 'LOADA', desiredStopNbrs: ['Y'], dropStopNbrs: ['S1'], arrivalsFrom: [] },
  ])
  assert.deepEqual(ordered.map((e: any) => e.loadNbr), ['LOADA', 'LOADB'])
})

test('planCommitOrder: an emptied (cancel) load releases before its stops’ destinations', () => {
  const ordered = planCommitOrder([
    { loadNbr: 'LOADB', desiredStopNbrs: ['S1'], dropStopNbrs: [], arrivalsFrom: ['LOADA'] },
    { loadNbr: 'LOADA', desiredStopNbrs: [], dropStopNbrs: ['S1'], arrivalsFrom: [] },
  ])
  assert.deepEqual(ordered.map((e: any) => e.loadNbr), ['LOADA', 'LOADB'])
})

test('planCommitOrder: arrivals from OUTSIDE the batch impose no ordering', () => {
  const ordered = planCommitOrder([
    { loadNbr: 'LOADB', desiredStopNbrs: ['S1'], dropStopNbrs: [], arrivalsFrom: ['SOMEWHERE_ELSE'] },
  ])
  assert.deepEqual(ordered.map((e: any) => e.loadNbr), ['LOADB'])
})

test('planCommitOrder: a two-load swap is a cycle and is refused', () => {
  assert.throws(
    () =>
      planCommitOrder([
        { loadNbr: 'LOADA', desiredStopNbrs: ['S2'], dropStopNbrs: ['S1'], arrivalsFrom: ['LOADB'] },
        { loadNbr: 'LOADB', desiredStopNbrs: ['S1'], dropStopNbrs: ['S2'], arrivalsFrom: ['LOADA'] },
      ]),
    /cycle/,
  )
})

// ---------------------------------------------------------------------------
// parseStopInfo — arrival echo source
// ---------------------------------------------------------------------------

test('parseStopInfo: unwraps Stop.stop and rejects a missing stop', () => {
  const st = parseStopInfo({ status: 200, data: { Stop: { stop: rawStop('Z', 5).stop } } })
  assert.equal(st.stopNbr, 'Z')
  assert.equal(parseStopInfo({ status: 404, data: {} }), null)
})
