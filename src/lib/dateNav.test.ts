import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isWeekend,
  addDays,
  prevBusinessDay,
  nextBusinessDay,
  isValidISO,
} from './dateNav.js'

// --- isWeekend ---------------------------------------------------------------

test('isWeekend: Sat 2026-06-06 is a weekend', () => {
  assert.equal(isWeekend('2026-06-06'), true)
})

test('isWeekend: Sun 2026-06-07 is a weekend', () => {
  assert.equal(isWeekend('2026-06-07'), true)
})

test('isWeekend: Mon 2026-06-08 is not a weekend', () => {
  assert.equal(isWeekend('2026-06-08'), false)
})

test('isWeekend: Fri 2026-06-05 is not a weekend', () => {
  assert.equal(isWeekend('2026-06-05'), false)
})

test('isWeekend: Wed 2026-06-10 is not a weekend', () => {
  assert.equal(isWeekend('2026-06-10'), false)
})

// --- addDays -----------------------------------------------------------------

test('addDays: adds positive days', () => {
  assert.equal(addDays('2026-06-10', 1), '2026-06-11')
})

test('addDays: adds across month boundary', () => {
  assert.equal(addDays('2026-01-30', 3), '2026-02-02')
})

test('addDays: subtracts (negative n) across month boundary', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
})

test('addDays: handles year boundary', () => {
  assert.equal(addDays('2025-12-31', 1), '2026-01-01')
})

test('addDays: zero n returns same date', () => {
  assert.equal(addDays('2026-06-11', 0), '2026-06-11')
})

// --- nextBusinessDay ---------------------------------------------------------

test('nextBusinessDay: Fri -> Mon (skip weekend)', () => {
  // 2026-06-05 is Friday
  assert.equal(nextBusinessDay('2026-06-05'), '2026-06-08')
})

test('nextBusinessDay: Thu -> Fri (no skip)', () => {
  // 2026-06-04 is Thursday
  assert.equal(nextBusinessDay('2026-06-04'), '2026-06-05')
})

test('nextBusinessDay: Sat -> Mon (skip rest of weekend)', () => {
  assert.equal(nextBusinessDay('2026-06-06'), '2026-06-08')
})

test('nextBusinessDay: Sun -> Mon', () => {
  assert.equal(nextBusinessDay('2026-06-07'), '2026-06-08')
})

// --- prevBusinessDay ---------------------------------------------------------

test('prevBusinessDay: Mon -> Fri (skip weekend)', () => {
  // 2026-06-08 is Monday
  assert.equal(prevBusinessDay('2026-06-08'), '2026-06-05')
})

test('prevBusinessDay: Fri -> Thu (no skip)', () => {
  // 2026-06-05 is Friday
  assert.equal(prevBusinessDay('2026-06-05'), '2026-06-04')
})

test('prevBusinessDay: Sun -> Fri (skip rest of weekend)', () => {
  assert.equal(prevBusinessDay('2026-06-07'), '2026-06-05')
})

test('prevBusinessDay: Sat -> Fri', () => {
  assert.equal(prevBusinessDay('2026-06-06'), '2026-06-05')
})

// --- isValidISO --------------------------------------------------------------

test('isValidISO: valid date returns true', () => {
  assert.equal(isValidISO('2026-06-11'), true)
})

test('isValidISO: invalid month returns false', () => {
  assert.equal(isValidISO('2026-13-01'), false)
})

test('isValidISO: wrong format returns false', () => {
  assert.equal(isValidISO('06/11/2026'), false)
})

test('isValidISO: empty string returns false', () => {
  assert.equal(isValidISO(''), false)
})

test('isValidISO: non-string returns false', () => {
  // @ts-expect-error intentional bad input
  assert.equal(isValidISO(null), false)
})
