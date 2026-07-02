// test/sms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, validUsPhone } from '../netlify/functions/lib/sms.mts';

test('normalizePhone: strips formatting to 10 digits', () => {
  assert.equal(normalizePhone('(305) 123-4567'), '3051234567');
  assert.equal(normalizePhone('305.123.4567'), '3051234567');
  assert.equal(normalizePhone('+1 305 123 4567'), '3051234567'); // drops leading 1
  assert.equal(normalizePhone('13051234567'), '3051234567');
  assert.equal(normalizePhone('3051234567'), '3051234567');
  assert.equal(normalizePhone(null), '');
});

test('validUsPhone: exactly 10 digits', () => {
  assert.ok(validUsPhone('3051234567'));
  assert.ok(!validUsPhone('305123456'));   // 9
  assert.ok(!validUsPhone('13051234567')); // 11 (pre-normalize)
  assert.ok(!validUsPhone(''));
});
