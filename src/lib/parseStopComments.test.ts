import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECEIVING_HOURS_HARD,
  STOP_CHIPS,
  parseStopComments,
  commentsToString,
  activeChips,
  isPlaceholderWindow,
  fmt12h,
  fmtReceivingHours,
} from './parseStopComments.ts'

// --- the single advisory switch -------------------------------------------
test('RECEIVING_HOURS_HARD is false (receiving hours are advisory, never a gate)', () => {
  assert.equal(RECEIVING_HOURS_HARD, false)
})

// --- commentsToString -------------------------------------------------------
test('commentsToString handles string, string[], Comment objects, and arrays', () => {
  assert.equal(commentsToString('LIFTGATE'), 'LIFTGATE')
  assert.equal(commentsToString(['LIFTGATE', 'INSIDE DELIVERY']), 'LIFTGATE; INSIDE DELIVERY')
  assert.equal(commentsToString({ commentDescription: 'GRAVEL LOT' }), 'GRAVEL LOT')
  assert.equal(
    commentsToString([{ commentDescription: 'LIFTGATE' }, { commentDescription: 'INSIDE DELIVERY' }]),
    'LIFTGATE; INSIDE DELIVERY',
  )
  // drops empties / nullish entries
  assert.equal(
    commentsToString(['LIFTGATE', '', null, { commentDescription: '' }, { commentDescription: 'CALL AHEAD' }]),
    'LIFTGATE; CALL AHEAD',
  )
})

test('commentsToString over [{commentDescription}] arrays joins with "; "', () => {
  const input = [
    { commentDescription: 'SPL-INSTR-TEXT: LIFTGATE' },
    { commentDescription: 'TOTAL-AMOUNT : 45.00' },
  ]
  assert.equal(commentsToString(input), 'SPL-INSTR-TEXT: LIFTGATE; TOTAL-AMOUNT : 45.00')
})

// --- empty / null / undefined ----------------------------------------------
test('empty, null, and undefined input parse to an all-false result with hasAny false', () => {
  for (const input of ['', null, undefined, [], '   ']) {
    const p = parseStopComments(input as never)
    assert.equal(p.hasAny, false)
    assert.equal(p.liftgate, false)
    assert.equal(p.receivingHours, null)
    assert.equal(p.totalAmount, null)
    assert.deepEqual(p.other, [])
  }
})

// --- individual flags + tolerance ------------------------------------------
test('each flag matches with case/whitespace/hyphen tolerance', () => {
  assert.equal(parseStopComments('lift-gate required').liftgate, true)
  assert.equal(parseStopComments('LIFTGATE').liftgate, true)
  assert.equal(parseStopComments('Inside   Delivery to 3rd floor').insideDelivery, true)
  assert.equal(parseStopComments('Do Not Break-Down the Skid').doNotBreakdownSkid, true)
  assert.equal(parseStopComments('do not breakdown skid').doNotBreakdownSkid, true)
  assert.equal(parseStopComments('NO DOUBLE-STACK').doNotDoubleStack, true)
  assert.equal(parseStopComments("don't double stack pallets").doNotDoubleStack, true)
  assert.equal(parseStopComments('Call upon approach').callUponApproach, true)
  assert.equal(parseStopComments('CALL AHEAD before delivery').callUponApproach, true)
  assert.equal(parseStopComments('call prior to approach').callUponApproach, true)
})

test('gravel / new-construction flag', () => {
  assert.equal(parseStopComments('Gravel lot, watch clearance').gravelOrNewConstruction, true)
  assert.equal(parseStopComments('site is new construction').gravelOrNewConstruction, true)
  assert.equal(parseStopComments('unpaved access road').gravelOrNewConstruction, true)
  assert.equal(parseStopComments('dirt road to dock').gravelOrNewConstruction, true)
})

// --- unrecognized preservation ---------------------------------------------
test('an unrecognized segment is preserved verbatim and hasAny stays false', () => {
  const p = parseStopComments('Ring bell twice and wait')
  assert.equal(p.hasAny, false)
  assert.deepEqual(p.other, ['Ring bell twice and wait'])
  assert.equal(p.raw, 'Ring bell twice and wait')
})

test('SPL-INSTR-TEXT label is stripped per segment; raw keeps the original', () => {
  const p = parseStopComments('SPL-INSTR-TEXT: LIFTGATE; SPL-INSTR-TEXT: leave at side door')
  assert.equal(p.liftgate, true)
  assert.deepEqual(p.other, ['leave at side door'])
  assert.equal(p.raw, 'SPL-INSTR-TEXT: LIFTGATE; SPL-INSTR-TEXT: leave at side door')
})

// --- total amount -----------------------------------------------------------
test('TOTAL-AMOUNT parses to a number and does not leak into other[]', () => {
  const p = parseStopComments('LIFTGATE; TOTAL-AMOUNT : 45.00')
  assert.equal(p.totalAmount, 45)
  assert.equal(p.liftgate, true)
  assert.deepEqual(p.other, [])
})

test('"TOTAL-AMOUNT :" with no number -> null and no crash', () => {
  const p = parseStopComments('TOTAL-AMOUNT :')
  assert.equal(p.totalAmount, null)
  assert.equal(p.hasAny, false)
  assert.deepEqual(p.other, [])
})

test('total amount tolerates a $ and decimals: "$1234.50" -> 1234.5', () => {
  const p = parseStopComments('TOTAL-AMOUNT : $1234.50')
  assert.equal(p.totalAmount, 1234.5)
})

// --- receiving hours --------------------------------------------------------
test('receiving windows: explicit ends are high confidence', () => {
  const a = parseStopComments('RECV 7AM-12PM').receivingHours
  assert.deepEqual([a?.start, a?.end, a?.confidence], ['07:00', '12:00', 'high'])

  const b = parseStopComments('RECEIVING HOURS 07:00-15:00').receivingHours
  assert.deepEqual([b?.start, b?.end, b?.confidence], ['07:00', '15:00', 'high'])

  const c = parseStopComments('Receiving hours 9 AM to 5 PM').receivingHours
  assert.deepEqual([c?.start, c?.end, c?.confidence], ['09:00', '17:00', 'high'])
})

test('bare daytime window "RECV 8-3" -> 08:00-15:00 low confidence', () => {
  const r = parseStopComments('RECV 8-3').receivingHours
  assert.deepEqual([r?.start, r?.end, r?.confidence], ['08:00', '15:00', 'low'])
})

test('"RECEIVING HOURS CALL STORE" -> null window, text kept in other[]', () => {
  const p = parseStopComments('RECEIVING HOURS CALL STORE')
  assert.equal(p.receivingHours, null)
  assert.deepEqual(p.other, ['RECEIVING HOURS CALL STORE'])
})

// --- multi-segment blob -----------------------------------------------------
test('multi-segment blob with flags + window + amount', () => {
  const blob =
    'SPL-INSTR-TEXT: LIFTGATE; SPL-INSTR-TEXT: INSIDE DELIVERY; ' +
    'SPL-INSTR-TEXT: NO DOUBLE STACK; RECV 9AM-1PM; ' +
    'leave pallet by roll door; TOTAL-AMOUNT : 312.75'
  const p = parseStopComments(blob)
  assert.equal(p.liftgate, true)
  assert.equal(p.insideDelivery, true)
  assert.equal(p.doNotDoubleStack, true)
  assert.equal(p.totalAmount, 312.75)
  assert.deepEqual(
    [p.receivingHours?.start, p.receivingHours?.end, p.receivingHours?.confidence],
    ['09:00', '13:00', 'high'],
  )
  assert.deepEqual(p.other, ['leave pallet by roll door'])
  assert.equal(p.hasAny, true)
  // three true flags -> three active chips, in catalog order
  const chips = activeChips(p)
  assert.equal(chips.length, 3)
  assert.deepEqual(chips.map((c) => c.key), ['liftgate', 'insideDelivery', 'doNotDoubleStack'])
})

// --- activeChips ordering ---------------------------------------------------
test('activeChips returns chips in catalog order regardless of input order', () => {
  const p = parseStopComments('CALL AHEAD; LIFTGATE')
  const chips = activeChips(p)
  assert.deepEqual(chips.map((c) => c.key), ['liftgate', 'callUponApproach'])
  assert.equal(STOP_CHIPS.length, 6)
})

// --- isPlaceholderWindow ----------------------------------------------------
test('isPlaceholderWindow — TRUE cases', () => {
  assert.equal(isPlaceholderWindow(null, null), true) // no window
  assert.equal(isPlaceholderWindow('', ''), true)
  assert.equal(isPlaceholderWindow('09:00', null), true) // half window
  assert.equal(isPlaceholderWindow('00:00', '00:00'), true) // both midnight
  assert.equal(isPlaceholderWindow('00:00', '23:59'), true) // midnight + sentinel
  assert.equal(isPlaceholderWindow('00:00', '24:00'), true)
  assert.equal(isPlaceholderWindow('13:00', '13:00'), true) // zero width
})

test('isPlaceholderWindow — FALSE cases (real windows)', () => {
  assert.equal(isPlaceholderWindow('09:00', '13:00'), false)
  assert.equal(isPlaceholderWindow('07:00', '15:00'), false)
})

// --- display helpers --------------------------------------------------------
test('fmt12h renders 12h short form', () => {
  assert.equal(fmt12h('07:00'), '7:00a')
  assert.equal(fmt12h('15:30'), '3:30p')
  assert.equal(fmt12h('12:00'), '12:00p')
  assert.equal(fmt12h('00:00'), '12:00a')
})

test('fmtReceivingHours renders "Recv 7:00a-12:00p" or "" for null', () => {
  assert.equal(fmtReceivingHours({ start: '07:00', end: '12:00', raw: '', confidence: 'high' }), 'Recv 7:00a-12:00p')
  assert.equal(fmtReceivingHours(null), '')
})
