// test/bulk-orders.test.mjs — pure bulk-import parsing + column mapping.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDelimited, detectDelimiter, looksLikeHeader, autoMapColumns,
  mappedRowsToOrders, bulkRowMissing, bulkRowIsBlank, headerSignature,
} from '../src/lib/bulk-orders.js';

test('detectDelimiter: tab for Excel/Sheets copy, comma for CSV', () => {
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
});

test('parseDelimited: TSV paste → rows of cells', () => {
  const rows = parseDelimited('Name\tCity\nACME\tBuford\nBeta\tAtlanta');
  assert.deepEqual(rows, [['Name', 'City'], ['ACME', 'Buford'], ['Beta', 'Atlanta']]);
});

test('parseDelimited: quoted CSV keeps embedded commas + escaped quotes; drops blank trailing lines', () => {
  const rows = parseDelimited('name,addr\n"ACME, Inc.","500 Main St, Ste 200"\n"He said ""hi""",x\n\n', ',');
  assert.deepEqual(rows, [['name', 'addr'], ['ACME, Inc.', '500 Main St, Ste 200'], ['He said "hi"', 'x']]);
});

test('looksLikeHeader: true for a label row, false for data', () => {
  assert.equal(looksLikeHeader(['Consignee', 'Address', 'City', 'State', 'Zip']), true);
  assert.equal(looksLikeHeader(['ACME Distribution', '500 Main St', 'Lawrenceville', 'GA', '30046']), false);
});

test('autoMapColumns: maps common headers to field keys (exact beats substring; no double-assign)', () => {
  const m = autoMapColumns(['Consignee', 'Ship To Address', 'City', 'ST', 'Zip Code', 'Item Description', 'Pallets']);
  assert.equal(m[0], 'name');
  assert.equal(m[1], 'addr1');
  assert.equal(m[2], 'city');
  assert.equal(m[3], 'state');
  assert.equal(m[4], 'zip');
  assert.equal(m[5], 'itemDesc');
  assert.equal(m[6], 'pallets');
  // Each field assigned once.
  assert.equal(new Set(Object.values(m)).size, Object.values(m).length);
});

test('autoMapColumns: unknown columns are left unmapped', () => {
  const m = autoMapColumns(['Consignee', 'Mystery Column', 'City']);
  assert.equal(m[0], 'name');
  assert.equal(m[1], undefined);
  assert.equal(m[2], 'city');
});

test('mappedRowsToOrders: applies mapping, trims cells, ignores unmapped columns', () => {
  const data = [['  ACME  ', '500 Main St', 'ignored', 'Buford', 'GA', '30518']];
  const mapping = { 0: 'name', 1: 'addr1', 3: 'city', 4: 'state', 5: 'zip' };
  assert.deepEqual(mappedRowsToOrders(data, mapping), [{ name: 'ACME', addr1: '500 Main St', city: 'Buford', state: 'GA', zip: '30518' }]);
});

test('bulkRowMissing: flags absent required fields; empty when complete', () => {
  assert.deepEqual(bulkRowMissing({ name: 'A', addr1: '1', city: 'B', state: 'GA', zip: '30518' }), []);
  assert.deepEqual(bulkRowMissing({ name: 'A', addr1: '', city: 'B', state: '', zip: '30518' }), ['addr1', 'state']);
});

test('bulkRowIsBlank: true only when every field is empty', () => {
  assert.equal(bulkRowIsBlank({}), true);
  assert.equal(bulkRowIsBlank({ name: '', city: '   ' }), true);
  assert.equal(bulkRowIsBlank({ name: 'A' }), false);
});

test('headerSignature: stable, normalized; null without a usable header', () => {
  assert.equal(headerSignature(['Consignee', 'City']), 'consignee|city');
  assert.equal(headerSignature(['  Consignee  ', 'CITY']), 'consignee|city');
  assert.equal(headerSignature([]), null);
});

test('end-to-end: pasted TSV with header → mapped, validated orders', () => {
  const text = 'Consignee\tAddress\tCity\tState\tZip\tItem\n'
    + 'ACME\t500 Main St\tLawrenceville\tGA\t30046\tappliances\n'
    + 'Beta Co\t9 Hub Rd\tAtlanta\tGA\t30301\tpallets';
  const rows = parseDelimited(text);
  const header = rows[0];
  assert.equal(looksLikeHeader(header), true);
  const mapping = autoMapColumns(header);
  const orders = mappedRowsToOrders(rows.slice(1), mapping);
  assert.equal(orders.length, 2);
  assert.deepEqual(orders[0], { name: 'ACME', addr1: '500 Main St', city: 'Lawrenceville', state: 'GA', zip: '30046', itemDesc: 'appliances' });
  assert.deepEqual(bulkRowMissing(orders[1]), []);
});
