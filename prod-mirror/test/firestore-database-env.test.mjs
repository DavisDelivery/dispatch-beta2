// test/firestore-database-env.test.mjs — FIRESTORE_DATABASE selection + the UAT safety
// invariant (prod-mirror isolation, Jul 2 2026): a deploy pointed at UAT NuVizz must never
// write the production (default) Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';

import { firestoreDatabase, uatMisconfigured, isFirestoreEnabled } from '../netlify/functions/lib/firestore.mts';

const ENV_KEYS = ['FIRESTORE_DATABASE', 'NUVIZZ_BASE_URL', 'FIREBASE_SA'];
const saved = {};
test.before(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
test.afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

test('firestoreDatabase: unset/blank → (default); set → the named database', () => {
  delete process.env.FIRESTORE_DATABASE;
  assert.equal(firestoreDatabase(), '(default)');
  process.env.FIRESTORE_DATABASE = '  ';
  assert.equal(firestoreDatabase(), '(default)');
  process.env.FIRESTORE_DATABASE = 'uat-mirror';
  assert.equal(firestoreDatabase(), 'uat-mirror');
});

test('SAFETY: UAT NuVizz base + (default) database = Firestore OFF (never corrupt prod data)', () => {
  process.env.FIREBASE_SA = '{"project_id":"x"}';
  process.env.NUVIZZ_BASE_URL = 'https://uat.nuvizz.com/deliverit/openapi/v7';
  delete process.env.FIRESTORE_DATABASE;
  assert.equal(uatMisconfigured(), true);
  assert.equal(isFirestoreEnabled(), false, 'refuses rather than mixing UAT rows into prod');
  // Naming a database clears the invariant — the mirror runs fully isolated.
  process.env.FIRESTORE_DATABASE = 'uat-mirror';
  assert.equal(uatMisconfigured(), false);
  assert.equal(isFirestoreEnabled(), true);
});

test('prod shape unchanged: portal base + (default) database stays enabled', () => {
  process.env.FIREBASE_SA = '{"project_id":"x"}';
  process.env.NUVIZZ_BASE_URL = 'https://portal.nuvizz.com/deliverit/openapi/v7';
  delete process.env.FIRESTORE_DATABASE;
  assert.equal(uatMisconfigured(), false);
  assert.equal(isFirestoreEnabled(), true);
});
