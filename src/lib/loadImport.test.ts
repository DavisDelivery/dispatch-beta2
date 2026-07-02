import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  planCommitOrder,
} from './loadImport.js'
import { buildStopPayload } from './nuvizzWrite.js'

// ---------------------------------------------------------------------------
// Fixture builders (UAT-shaped; naming rule: no vendor/agent names anywhere)
// ---------------------------------------------------------------------------

// A raw on-load stop record as load/info returns it — WITH freight + references,
// because the wipe class this module guards against is exactly those fields.
const rawStop = (stopNbr: string, seq: number | null, over: any = {}) => ({
  stop: {
    stopId: `sid-${stopNbr}`,
    stopNbr,
    stopType: over.stopType || 'DO',
    shipmentType: 'REG',
    stopExecution: 'APP',
    sourceType: 'INTG',
    shipmentNbr: `PRO-${stopNbr}`,
    proNumber: `PRO-${stopNbr}`,
    reference1: `PRO PRO-${stopNbr}`,
    reference2: 'CHAIRS AND DESKS x6',
    totalPallets: over.pallets ?? 3,
    totalCartons: over.cartons ?? 7,
    weight: over.weight ?? 812,
    weightUOM: 'LBS',
    from: {
      address: { addressType: 'COM', name: 'ULINEUAT', addr1: '943 GAINESVILLE HWY', city: 'BUFORD', state: 'GA', zip: '30518', country: 'USA', latitude: 34.1, longitude: -83.9 },
      schedule: { timeFrom: '2026-07-15T06:00:00', timeTo: '2026-07-15T07:00:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' },
    },
    to: {
      seq,
      address: { addressType: 'COM', name: `CONSIGNEE ${stopNbr}`, addr1: `${seq ?? 1} MAIN ST`, city: 'ATLANTA', state: 'GEORGIA', zip: '30303', country: 'UNITED STATES', latitude: 33.7, longitude: -84.4 },
      schedule: { timeFrom: '2026-07-15T09:00:00', timeTo: '2026-07-15T09:30:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' },
      ...over.to,
    },
    ...over.stop,
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

// Convenience guards for buildImportLoad (the guard is MANDATORY).
const onLoadGuard = (...nbrs: string[]) => ({ onLoad: new Set(nbrs.map(normStopNbr)) })
const createGuard = (...nbrs: string[]) => ({ create: true, verifiedAbsent: new Set(nbrs.map(normStopNbr)) })

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
// parseLoadInfo / parseStopInfo / deliveryOrderFromInfo — read-back side
// ---------------------------------------------------------------------------

test('parseLoadInfo: 404 / missing header reads as not-found (pending), never a throw', () => {
  assert.equal(parseLoadInfo({ status: 404, data: { error: 'Not Found' } }).found, false)
  assert.equal(parseLoadInfo({ status: 200, data: {} }).found, false)
  assert.equal(parseLoadInfo(loadInfoResp([rawStop('A', 2)])).found, true)
})

test('parseStopInfo + parseStopLoadNbr: the stop record and its current load', () => {
  const resp = { status: 200, data: { Stop: { stop: rawStop('Z', 5).stop, load: { loadNbr: 'SQTLOAD9', routeName: 'R9' } } } }
  assert.equal(parseStopInfo(resp)!.stopNbr, 'Z')
  assert.equal(parseStopLoadNbr(resp), 'SQTLOAD9')
  assert.equal(parseStopInfo({ status: 404, data: {} }), null)
  assert.equal(parseStopLoadNbr({ status: 200, data: { Stop: { stop: rawStop('Z', 5).stop } } }), null) // unplanned
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
// buildFullEchoStop — a matched stop is FULL-REPLACED, so echo EVERYTHING
// ---------------------------------------------------------------------------

test('full echo: carries freight + references + PRO (the fields the wipe blanked), numbers as numbers', () => {
  const e = buildFullEchoStop(rawStop('007139395', 2), 0)
  assert.equal(e.stopNbr, '007139395')
  assert.equal(e.stopType, 'DO')
  assert.equal(e.shipmentType, 'REG')
  assert.equal(e.stopExecution, 'APP')
  assert.equal(e.sourceType, 'INTG')
  assert.equal(e.shipmentNbr, 'PRO-007139395')
  assert.equal(e.proNumber, 'PRO-007139395')
  assert.equal(e.reference1, 'PRO PRO-007139395')
  assert.equal(e.reference2, 'CHAIRS AND DESKS x6')
  assert.equal(e.totalPallets, 3) // NUMBER, not string
  assert.equal(e.totalCartons, 7)
  assert.equal(e.weight, 812)
  assert.equal(e.weightUOM, 'LBS')
  assert.equal(typeof e.totalPallets, 'number')
  assert.equal(typeof e.weight, 'number')
})

test('full echo: numeric-string freight is coerced to numbers; objects are refused (never echoed)', () => {
  const e = buildFullEchoStop(rawStop('A', 2, { stop: { totalPallets: '4', weight: { v: 9 }, totalCartons: null } }), 0)
  assert.equal(e.totalPallets, 4)
  assert.equal(typeof e.totalPallets, 'number')
  assert.equal(e.weight, undefined) // object refused
  assert.equal(e.totalCartons, undefined) // null omitted (already blank on the record)
})

test('full echo: carries BOTH from and to blocks (addresses whitelisted + normalized, junk dropped)', () => {
  const e = buildFullEchoStop(rawStop('A', 2), 0)
  assert.equal(e.from.address.name, 'ULINEUAT')
  assert.equal(e.from.address.addr1, '943 GAINESVILLE HWY')
  assert.equal(e.from.schedule.timeFrom, '2026-07-15T06:00:00') // pickup schedule echoed verbatim
  assert.equal(e.to.address.name, 'CONSIGNEE A')
  assert.equal(e.to.address.state, 'GA') // GEORGIA normalized
  assert.equal(e.to.address.country, 'USA') // UNITED STATES normalized
  assert.equal(e.to.address.latitude, undefined) // junk fields never echoed
  assert.equal((e.from.address as any).latitude, undefined)
})

test('full echo: to.schedule is the ONE rewritten field — the slot for the visit index', () => {
  const e0 = buildFullEchoStop(rawStop('A', 2), 0)
  const e3 = buildFullEchoStop(rawStop('B', 3), 3)
  assert.equal(e0.to.schedule.timeFrom, '2026-07-15T08:00:00')
  assert.equal(e0.to.schedule.timeTo, '2026-07-15T08:30:00')
  assert.equal(e3.to.schedule.timeFrom, '2026-07-15T09:30:00')
})

test('full echo: refuses a record it cannot echo safely (missing from/to address)', () => {
  assert.equal(buildFullEchoStop({ stop: { stopNbr: 'A', to: { address: { addr1: '1 St' } } } }, 0), null) // no from
  assert.equal(buildFullEchoStop({ stop: { stopNbr: 'A', from: { address: { addr1: 'W' } }, to: { address: {} } } }, 0), null) // no to.addr1
  assert.equal(buildFullEchoStop({ stop: { to: { address: { addr1: '1 St' } } } }, 0), null) // no stopNbr
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

test('buildImportHeader: falls back to a stop’s from-address (the live UAT header has NO flat origin)', () => {
  // Real load/info headers carry origin:'WHSE' (string) + rtOrigin (an OBJECT) and
  // no flat originName/originAddr1 — the ladder must echo the stop's from side.
  const bare = { loadNbr: 'SQTLOAD2', earliestStartDttm: '2026-07-15T06:00:00', latestStartDttm: '2026-07-15T18:00:00', origin: 'WHSE', rtOrigin: { address: { addr1: 'X' } } }
  const h = buildImportHeader(bare, [rawStop('A', 2)])
  assert.equal(h.origin, 'WHSE') // the string code, never the rtOrigin object
  assert.equal(h.originName, 'ULINEUAT')
  assert.equal(h.originAddr1, '943 GAINESVILLE HWY')
  assert.equal(h.originZip, '30518')
})

test('buildImportHeader: refuses epoch/millis dates (echo only ISO), derives the 06:00-18:00 fallback', () => {
  const h = buildImportHeader({ loadNbr: 'SQTLOAD3', earliestStartDttm: 1752555600000 as any, latestStartDttm: null }, [rawStop('A', 2)])
  assert.equal(h.earliestStartDttm, '2026-07-15T06:00:00') // derived from the stop schedule date
  assert.equal(h.latestStartDttm, '2026-07-15T18:00:00')
})

test('buildImportHeader: throws when no date is derivable anywhere', () => {
  assert.throws(() => buildImportHeader({ loadNbr: 'SQTLOAD4' }, []), /no earliest\/latest/)
})

// ---------------------------------------------------------------------------
// buildImportLoad — the STRUCTURAL clone/wipe guard (mandatory)
// ---------------------------------------------------------------------------

const okStops = () => [buildFullEchoStop(rawStop('A', 2), 0), buildFullEchoStop(rawStop('B', 3), 1)]

test('order mode: on-load full echoes assemble; the guard is satisfied', () => {
  const L = buildImportLoad(buildImportHeader(HEADER, []), okStops(), onLoadGuard('A', 'B'))
  assert.deepEqual(L.stops.map((s: any) => s.stopNbr), ['A', 'B'])
})

test('guard is MANDATORY: an unguarded import cannot be built at all', () => {
  assert.throws(() => (buildImportLoad as any)(buildImportHeader(HEADER, []), okStops()), /membership guard is required/)
})

test('order mode: an OFF-LOAD entry is unrepresentable (it would CLONE a new stop record)', () => {
  assert.throws(
    () => buildImportLoad(buildImportHeader(HEADER, []), okStops(), onLoadGuard('A')), // B not on the load
    /CLONE/,
  )
})

test('a to-only entry (no from block) is impossible to emit — it would FULL-REPLACE and blank freight', () => {
  const toOnly = { stopNbr: 'A', stopType: 'DO', to: { address: { addr1: '1 MAIN ST' }, schedule: {} } }
  assert.throws(() => buildImportLoad(buildImportHeader(HEADER, []), [toOnly], onLoadGuard('A')), /no "from" block/)
})

test('create mode: full payloads for verified-absent numbers assemble; a collision is refused', () => {
  const p = buildStopPayload({ name: 'C1', addr1: '1 St', city: 'ATLANTA', state: 'GA', zip: '30303', stopNbr: 'SQTNEW1', pallets: '2', _index: 0 }, { serviceDate: '2026-07-15' })
  const L = buildImportLoad(buildImportHeader({ ...HEADER, loadNbr: 'SQTLOADNEW' }, []), [p], createGuard('SQTNEW1'))
  assert.equal(L.stops[0].stopNbr, 'SQTNEW1')
  assert.throws(
    () => buildImportLoad(buildImportHeader({ ...HEADER, loadNbr: 'SQTLOADNEW' }, []), [p], createGuard('SQTOTHER')),
    /not verified absent/,
  )
})

test('refuses an EMPTY stops[] (use load/cancel to retire a load)', () => {
  assert.throws(() => buildImportLoad(buildImportHeader(HEADER, []), [], onLoadGuard('A')), /load\/cancel/)
})

test('refuses missing trap fields', () => {
  const h: any = { ...buildImportHeader(HEADER, []) }
  delete h.originZip
  assert.throws(() => buildImportLoad(h, okStops(), onLoadGuard('A', 'B')), /originZip/)
  const h2: any = { ...buildImportHeader(HEADER, []) }
  delete h2.earliestStartDttm
  h2.scheduleStartDttm = '2026-07-15T06:00:00'
  assert.throws(() => buildImportLoad(h2, okStops(), onLoadGuard('A', 'B')), /scheduleStartDttm/)
})

test('refuses forbidden vendor/agent names in load/route names', () => {
  const h: any = { ...buildImportHeader(HEADER, []), routeName: 'CLAUDE TEST ROUTE' }
  assert.throws(() => buildImportLoad(h, okStops(), onLoadGuard('A', 'B')), /never contain/)
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

test('planCommitOrder: a cross-load move releases the SOURCE before the DESTINATION plans it', () => {
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
