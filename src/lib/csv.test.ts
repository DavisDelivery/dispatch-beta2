import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeCsvField, toCsv } from './csv.js'

// ---------------------------------------------------------------------------
// escapeCsvField
// ---------------------------------------------------------------------------

test('escapeCsvField: plain string passes through unchanged', () => {
  assert.equal(escapeCsvField('hello'), 'hello')
  assert.equal(escapeCsvField('Acme Corp'), 'Acme Corp')
  assert.equal(escapeCsvField('123'), '123')
})

test('escapeCsvField: value containing a comma is wrapped in double quotes', () => {
  assert.equal(escapeCsvField('Smith, John'), '"Smith, John"')
})

test('escapeCsvField: embedded double-quote is escaped by doubling and wrapped', () => {
  assert.equal(escapeCsvField('say "hello"'), '"say ""hello"""')
})

test('escapeCsvField: newline triggers quoting', () => {
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"')
})

test('escapeCsvField: carriage return triggers quoting', () => {
  assert.equal(escapeCsvField('line1\rline2'), '"line1\rline2"')
})

test('escapeCsvField: null returns empty string', () => {
  assert.equal(escapeCsvField(null), '')
})

test('escapeCsvField: undefined returns empty string', () => {
  assert.equal(escapeCsvField(undefined), '')
})

test('escapeCsvField: number is stringified', () => {
  assert.equal(escapeCsvField(42), '42')
})

// ---------------------------------------------------------------------------
// toCsv
// ---------------------------------------------------------------------------

test('toCsv: produces correct header row', () => {
  const csv = toCsv([], [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }])
  const lines = csv.split('\r\n')
  assert.equal(lines[0], 'Alpha,Beta')
})

test('toCsv: empty rows -> header only (plus trailing CRLF)', () => {
  const columns = [{ key: 'x', label: 'X' }]
  const csv = toCsv([], columns)
  // Should be "X\r\n" — one header line + trailing CRLF
  assert.equal(csv, 'X\r\n')
})

test('toCsv: CRLF line endings on every row', () => {
  const columns = [{ key: 'n', label: 'Name' }]
  const rows = [{ n: 'Alice' }, { n: 'Bob' }]
  const csv = toCsv(rows, columns)
  assert.equal(csv, 'Name\r\nAlice\r\nBob\r\n')
})

test('toCsv: columns in the correct order', () => {
  const columns = [{ key: 'b', label: 'B' }, { key: 'a', label: 'A' }]
  const rows = [{ a: '1', b: '2' }]
  const csv = toCsv(rows, columns)
  const dataLine = csv.split('\r\n')[1]
  assert.equal(dataLine, '2,1')
})

test('toCsv: missing key on row is treated as empty string', () => {
  const columns = [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }]
  const rows = [{ x: 'hello' }]  // y is missing
  const csv = toCsv(rows, columns)
  const dataLine = csv.split('\r\n')[1]
  assert.equal(dataLine, 'hello,')
})

test('toCsv: value with comma and quote round-trips correctly', () => {
  const columns = [{ key: 'v', label: 'Value' }]
  const tricky = 'Smith, "J"'
  const rows = [{ v: tricky }]
  const csv = toCsv(rows, columns)
  // header + tricky escaped + trailing CRLF
  assert.equal(csv, 'Value\r\n"Smith, ""J"""\r\n')
})

test('toCsv: trailing CRLF is always present', () => {
  const columns = [{ key: 'a', label: 'A' }]
  const csv = toCsv([{ a: 'z' }], columns)
  assert.ok(csv.endsWith('\r\n'), 'CSV should end with CRLF')
})
