// test/messaging-roster.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { employeeGroup } from '../netlify/functions/lib/marginiq.mts';

test('employeeGroup: drivers bucket into "driver"', () => {
  assert.equal(employeeGroup('driver'), 'driver');
  assert.equal(employeeGroup('Driver'), 'driver');
  assert.equal(employeeGroup('lead driver'), 'driver');
});

test('employeeGroup: owner-operators / contractors / carriers bucket into "contractor"', () => {
  assert.equal(employeeGroup('owner'), 'contractor');
  assert.equal(employeeGroup('owner-operator'), 'contractor');
  assert.equal(employeeGroup('contractor'), 'contractor');
  assert.equal(employeeGroup('carrier'), 'contractor');
  assert.equal(employeeGroup('vendor'), 'contractor');
});

test('employeeGroup: everyone else (and empty/unknown) is "team"', () => {
  assert.equal(employeeGroup('dispatcher'), 'team');
  assert.equal(employeeGroup('admin'), 'team');
  assert.equal(employeeGroup(''), 'team');
  assert.equal(employeeGroup(null), 'team');
  assert.equal(employeeGroup(undefined), 'team');
});
