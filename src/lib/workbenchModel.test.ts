import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDriverGroups, buildDriverGroup, matchesGroupSearch } from './workbenchModel.js'

// --- minimal stop factory ---------------------------------------------------
function makeStop(overrides: Record<string, unknown> = {}) {
  return {
    loadNbr: 'DAVIS000001',
    loadId: 'LD-001',
    routeName: 'Test Route',
    driverName: 'Test Driver',
    driverUserName: 'tdriver',
    stopNbr: '1',
    name: 'Test Stop',
    addr1: '123 Main St',
    city: 'Greensboro',
    state: 'NC',
    zip: '27401',
    sealNbr: null,
    comments: [],
    apptFrom: null,
    apptTo: null,
    plannedEta: null,
    stopStatus: 10,
    statusLabel: 'Pending',
    trueException: false,
    totalPallets: 2,
    totalCartons: 10,
    weight: 500,
    ...overrides,
  }
}

// --- buildDriverGroups: grouping -----------------------------------------------

test('buildDriverGroups returns empty array for empty input', () => {
  assert.deepEqual(buildDriverGroups([]), [])
})

test('buildDriverGroups returns empty array for null/undefined input', () => {
  assert.deepEqual(buildDriverGroups(null as never), [])
  assert.deepEqual(buildDriverGroups(undefined as never), [])
})

test('buildDriverGroups groups stops by driverUserName', () => {
  const stops = [
    makeStop({ driverUserName: 'alice', driverName: 'Alice', loadNbr: 'L1' }),
    makeStop({ driverUserName: 'bob', driverName: 'Bob', loadNbr: 'L2' }),
    makeStop({ driverUserName: 'alice', driverName: 'Alice', loadNbr: 'L1', stopNbr: '2' }),
  ]
  const groups = buildDriverGroups(stops)
  assert.equal(groups.length, 2)

  const alice = groups.find((g) => g.driverUserName === 'alice')
  assert.ok(alice, 'alice group exists')
  assert.equal(alice!.stopCount, 2)

  const bob = groups.find((g) => g.driverUserName === 'bob')
  assert.ok(bob, 'bob group exists')
  assert.equal(bob!.stopCount, 1)
})

test('buildDriverGroups puts empty driverUserName into Unassigned group', () => {
  const stops = [
    makeStop({ driverUserName: 'mhale', driverName: 'Marcus' }),
    makeStop({ driverUserName: '', driverName: '', loadNbr: 'L-UNASSIGNED' }),
    makeStop({ driverUserName: '', driverName: '', loadNbr: 'L-UNASSIGNED', stopNbr: '2' }),
  ]
  const groups = buildDriverGroups(stops)

  // Unassigned should be last
  const last = groups[groups.length - 1]
  assert.equal(last.isUnassigned, true, 'last group is unassigned')
  assert.equal(last.stopCount, 2)

  // Named driver is first
  assert.equal(groups[0].driverUserName, 'mhale')
})

test('buildDriverGroups sorts named drivers alphabetically (case-insensitive)', () => {
  const stops = [
    makeStop({ driverUserName: 'ztesla', driverName: 'Zelda Tesla' }),
    makeStop({ driverUserName: 'aalvarez', driverName: 'Ana Alvarez' }),
    makeStop({ driverUserName: 'mbrown', driverName: 'Marcus Brown' }),
  ]
  const groups = buildDriverGroups(stops)
  const names = groups.map((g) => g.driverName)
  assert.deepEqual(names, ['Ana Alvarez', 'Marcus Brown', 'Zelda Tesla'])
})

// --- buildDriverGroup: summary sums ------------------------------------------

test('buildDriverGroup counts delivered stops (stopStatus === 90)', () => {
  const stops = [
    makeStop({ stopStatus: 90 }),
    makeStop({ stopStatus: 40, stopNbr: '2' }),
    makeStop({ stopStatus: 90, stopNbr: '3' }),
  ]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  assert.equal(group.delivered, 2)
  assert.equal(group.stopCount, 3)
})

test('buildDriverGroup counts trueException stops', () => {
  const stops = [
    makeStop({ trueException: true, stopStatus: 50 }),
    makeStop({ trueException: false, stopStatus: 50, stopNbr: '2' }),
  ]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  assert.equal(group.exceptions, 1)
})

test('buildDriverGroup sums pallets and cartons', () => {
  const stops = [
    makeStop({ totalPallets: 3, totalCartons: 12 }),
    makeStop({ totalPallets: 5, totalCartons: 24, stopNbr: '2' }),
  ]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  assert.equal(group.palletTotal, 8)
  assert.equal(group.cartonTotal, 36)
})

test('buildDriverGroup revenue is null when no stop has revenue', () => {
  const stops = [makeStop({ sealNbr: 'SL-9999', comments: [] })]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  assert.equal(group.revenue, null)
})

test('buildDriverGroup sums revenue from TOTAL-AMOUNT comments', () => {
  const stops = [
    makeStop({ sealNbr: null, comments: ['TOTAL-AMOUNT : 100.00'] }),
    makeStop({ sealNbr: null, comments: ['TOTAL-AMOUNT : 50.50'], stopNbr: '2' }),
  ]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  // Allow small floating-point tolerance
  assert.ok(group.revenue !== null)
  assert.ok(Math.abs(group.revenue! - 150.5) < 0.01)
})

test('buildDriverGroup distinct loadCount from loadNbr', () => {
  const stops = [
    makeStop({ loadNbr: 'L1' }),
    makeStop({ loadNbr: 'L1', stopNbr: '2' }),
    makeStop({ loadNbr: 'L2', stopNbr: '3' }),
  ]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  assert.equal(group.loadCount, 2)
})

test('buildDriverGroup sorts stops by plannedEta (empties last)', () => {
  const stops = [
    makeStop({ plannedEta: '2026-06-05T12:00:00', stopNbr: '3' }),
    makeStop({ plannedEta: null, stopNbr: '4' }),
    makeStop({ plannedEta: '2026-06-05T08:00:00', stopNbr: '1' }),
    makeStop({ plannedEta: '2026-06-05T10:00:00', stopNbr: '2' }),
  ]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  const etas = group.rawStops.map((s: { plannedEta: string | null }) => s.plannedEta)
  assert.equal(etas[0], '2026-06-05T08:00:00')
  assert.equal(etas[1], '2026-06-05T10:00:00')
  assert.equal(etas[2], '2026-06-05T12:00:00')
  assert.equal(etas[3], null) // empties last
})

test('buildDriverGroup firstEta/lastEta are earliest and latest non-null ETA', () => {
  const stops = [
    makeStop({ plannedEta: '2026-06-05T08:00:00', stopNbr: '1' }),
    makeStop({ plannedEta: '2026-06-05T14:00:00', stopNbr: '2' }),
    makeStop({ plannedEta: null, stopNbr: '3' }),
  ]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  assert.equal(group.firstEta, '2026-06-05T08:00:00')
  assert.equal(group.lastEta, '2026-06-05T14:00:00')
})

// --- matchesGroupSearch -------------------------------------------------------

test('matchesGroupSearch returns true for empty query', () => {
  const group = buildDriverGroup('tdriver', 'Test Driver', [makeStop()])
  assert.equal(matchesGroupSearch(group, ''), true)
  assert.equal(matchesGroupSearch(group, null as never), true)
})

test('matchesGroupSearch matches driver name (case-insensitive)', () => {
  const group = buildDriverGroup('mhale', 'Marcus Hale', [makeStop()])
  assert.equal(matchesGroupSearch(group, 'marcus'), true)
  assert.equal(matchesGroupSearch(group, 'HALE'), true)
  assert.equal(matchesGroupSearch(group, 'nobody'), false)
})

test('matchesGroupSearch matches stop customer name', () => {
  const stops = [makeStop({ name: 'Riverside Grocery #12' })]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  assert.equal(matchesGroupSearch(group, 'riverside'), true)
  assert.equal(matchesGroupSearch(group, 'grocery'), true)
})

test('matchesGroupSearch matches routeName and loadNbr', () => {
  const stops = [makeStop({ routeName: 'Greensboro AM', loadNbr: 'DAVIS000196101' })]
  const group = buildDriverGroup('tdriver', 'Test Driver', stops)
  assert.equal(matchesGroupSearch(group, 'greensboro'), true)
  assert.equal(matchesGroupSearch(group, 'DAVIS000196101'), true)
  assert.equal(matchesGroupSearch(group, 'winston'), false)
})
