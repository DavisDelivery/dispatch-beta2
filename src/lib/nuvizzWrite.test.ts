import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliverySlot, abbrState, buildStopPayload, DEFAULT_ORIGIN } from './nuvizzWrite.js'

// ---------------------------------------------------------------------------
// deliverySlot — 30-minute slots staggered by visit index
// ---------------------------------------------------------------------------

test('deliverySlot: index 0 is the 08:00–08:30 slot', () => {
  assert.deepEqual(deliverySlot(0), { from: '08:00:00', to: '08:30:00' })
})

test('deliverySlot: each index advances by 30 minutes', () => {
  assert.deepEqual(deliverySlot(1), { from: '08:30:00', to: '09:00:00' })
  assert.deepEqual(deliverySlot(2), { from: '09:00:00', to: '09:30:00' })
  assert.deepEqual(deliverySlot(4), { from: '10:00:00', to: '10:30:00' })
})

test('deliverySlot: windows are strictly increasing (encode a unique order)', () => {
  const froms = Array.from({ length: 10 }, (_, i) => deliverySlot(i).from)
  for (let i = 1; i < froms.length; i++) assert.ok(froms[i] > froms[i - 1], `${froms[i]} > ${froms[i - 1]}`)
})

test('deliverySlot: clamps inside the day for very long routes', () => {
  const s = deliverySlot(100)
  assert.ok(s.from <= '23:30:00')
  assert.ok(s.to <= '23:30:00')
})

// ---------------------------------------------------------------------------
// abbrState — full state name -> 2-letter
// ---------------------------------------------------------------------------

test('abbrState: maps full names and passes through abbreviations', () => {
  assert.equal(abbrState('GEORGIA'), 'GA')
  assert.equal(abbrState('georgia'), 'GA')
  assert.equal(abbrState('GA'), 'GA')
  assert.equal(abbrState('North Carolina'), 'NC')
  assert.equal(abbrState(''), '')
})

// ---------------------------------------------------------------------------
// buildStopPayload — bakes the order-encoding window + default origin
// ---------------------------------------------------------------------------

const SETTINGS = { serviceDate: '2026-07-15', weightUOM: 'LBS' }

test('buildStopPayload: delivery window encodes the row index', () => {
  const a = buildStopPayload({ name: 'A', addr1: '1 St', city: 'ATLANTA', state: 'GA', zip: '30303', stopNbr: 'A1', _index: 0 }, SETTINGS)
  const b = buildStopPayload({ name: 'B', addr1: '2 St', city: 'ATLANTA', state: 'GA', zip: '30303', stopNbr: 'B1', _index: 1 }, SETTINGS)
  assert.equal(a.to.schedule.timeFrom, '2026-07-15T08:00:00')
  assert.equal(b.to.schedule.timeFrom, '2026-07-15T08:30:00')
  assert.ok(b.to.schedule.timeFrom > a.to.schedule.timeFrom)
})

test('buildStopPayload: pickup window sits before the delivery window', () => {
  const p = buildStopPayload({ name: 'A', addr1: '1 St', city: 'ATLANTA', state: 'GA', zip: '30303', stopNbr: 'A1', _index: 0 }, SETTINGS)
  assert.ok(p.from.schedule.timeFrom < p.to.schedule.timeFrom)
  assert.ok(p.from.schedule.timeTo <= p.to.schedule.timeFrom)
})

test('buildStopPayload: falls back to the default origin when settings omit it', () => {
  const p = buildStopPayload({ name: 'A', addr1: '1 St', city: 'ATLANTA', state: 'GA', zip: '30303', stopNbr: 'A1', _index: 0 }, SETTINGS)
  assert.equal(p.from.address.addr1, DEFAULT_ORIGIN.addr1)
  assert.equal(p.from.address.addr2, DEFAULT_ORIGIN.addr2)
  assert.equal(p.from.address.zip, '30518')
})
