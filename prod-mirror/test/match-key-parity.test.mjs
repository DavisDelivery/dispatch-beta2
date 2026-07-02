// test/match-key-parity.test.mjs
// The scan's server-side match-key MUST equal the client's, or notify-CS would
// look up the wrong customer_notes doc. Assert both implementations agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMatchKey as client } from '../src/lib/matchKey.js';
import { normalizeMatchKey as server } from '../netlify/functions/lib/match-key.mts';

const samples = [
  ['IES COMMUNICATIONS', '6515 McDonough Dr', 'Norcross', '30093'],
  ['Luxury Box ATL, LLC', '3073 Peachtree Rd NE STE 200', 'Atlanta', '30305-1234'],
  ['SOLID LOCKSMITH INC.', '1850 Beaver Ridge Cir Ste C', 'Norcross', '30071'],
  ['', '', '', ''],
  ['Acme Co', '123 North Main Street', 'Duluth', '30096'],
  [null, undefined, null, undefined],
];

test('server match-key equals client match-key', () => {
  for (const [n, a, c, z] of samples) {
    assert.equal(server(n, a, c, z), client(n, a, c, z), `mismatch for ${JSON.stringify([n, a, c, z])}`);
  }
});
