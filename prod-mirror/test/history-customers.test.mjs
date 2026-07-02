// test/history-customers.test.mjs
//
// Unit tests for the PURE per-customer history rollup logic
// (lib/history-customers.mts): mergeProEntries + buildRollupsFromStops.
// Run with: npm test  (node --test strips .mts types natively on Node ≥ 22).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeProEntries, buildRollupsFromStops, MAX_PROS,
  nameSearchTokens, queryWords, matchesAllWords,
} from '../netlify/functions/lib/history-customers.mts';

test('nameSearchTokens: prefix-grams of every word find a word anywhere in the name', () => {
  const t = nameSearchTokens('SOLID LOCKSMITH');
  assert.ok(t.includes('so') && t.includes('solid'));
  assert.ok(t.includes('lo') && t.includes('lock') && t.includes('locksmith'));
  assert.ok(!t.includes('l')); // single chars excluded
});

test('nameSearchTokens: strips punctuation, lowercases', () => {
  const t = nameSearchTokens("A&M Supply, Inc.");
  assert.ok(t.includes('supply'));
  assert.ok(t.includes('su'));
});

test('queryWords: keeps words length >= 2', () => {
  assert.deepEqual(queryWords('  Solid  A lock '), ['solid', 'lock']);
  assert.deepEqual(queryWords('locksmith'), ['locksmith']);
});

test('matchesAllWords: ANDs every query word against stored tokens', () => {
  const tokens = nameSearchTokens('SOLID LOCKSMITH');
  assert.equal(matchesAllWords(tokens, ['locksmith']), true);   // mid-name word
  assert.equal(matchesAllWords(tokens, ['lock']), true);        // partial mid-name word
  assert.equal(matchesAllWords(tokens, ['solid', 'lock']), true); // both words
  assert.equal(matchesAllWords(tokens, ['solid', 'steel']), false); // steel not present
  assert.equal(matchesAllWords(tokens, []), false);
});

test('mergeProEntries: de-dupes by pro keeping the latest date, newest first', () => {
  const out = mergeProEntries(
    [{ pro: 'A', date: '2026-06-01' }, { pro: 'B', date: '2026-06-03' }],
    [{ pro: 'A', date: '2026-06-10' }, { pro: 'C', date: '2026-06-05' }],
  );
  assert.deepEqual(out.map((p) => p.pro), ['A', 'C', 'B']); // A bumped to 06-10
  assert.equal(out.find((p) => p.pro === 'A').date, '2026-06-10');
});

test('mergeProEntries: caps at max (newest kept)', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ pro: `P${i}`, date: `2026-06-${String(i + 1).padStart(2, '0')}` }));
  const out = mergeProEntries([], many, MAX_PROS);
  assert.equal(out.length, MAX_PROS);
  assert.equal(out[0].pro, 'P29'); // newest first
  assert.equal(out[out.length - 1].pro, 'P10'); // oldest of the kept 20
});

test('mergeProEntries: ignores empty/malformed entries', () => {
  const out = mergeProEntries([{ pro: '', date: 'x' }, null], [{ pro: 'A' }]);
  assert.deepEqual(out, [{ pro: 'A', date: '' }]);
});

test('buildRollupsFromStops: groups by customerMatchKey and collects pros', () => {
  const stops = [
    { customerMatchKey: 'k1', businessName: 'SOLID LOCKSMITH', addr1: '1 A St', city: 'Atlanta', state: 'GA', zip: '30301', pro: '007135610', date: '2026-06-19' },
    { customerMatchKey: 'k1', businessName: 'SOLID LOCKSMITH', addr1: '1 A St', city: 'Atlanta', state: 'GA', zip: '30301', pro: '007135611', date: '2026-06-19' },
    { customerMatchKey: 'k2', businessName: 'KINETICO', addr1: '9 B Rd', city: 'Marietta', state: 'GA', zip: '30060', pro: 'AVRT-1', date: '2026-06-19' },
  ];
  const map = buildRollupsFromStops(stops);
  assert.equal(map.size, 2);
  const k1 = map.get('k1');
  assert.equal(k1.name, 'SOLID LOCKSMITH');
  assert.equal(k1.city, 'Atlanta');
  assert.deepEqual(k1.pros.map((p) => p.pro).sort(), ['007135610', '007135611']);
  assert.equal(map.get('k2').pros[0].pro, 'AVRT-1');
});

test('buildRollupsFromStops: latest date wins for identity', () => {
  const stops = [
    { customerMatchKey: 'k', businessName: 'OLD NAME', addr1: 'old', pro: 'P1', date: '2026-06-01' },
    { customerMatchKey: 'k', businessName: 'NEW NAME', addr1: 'new', pro: 'P2', date: '2026-06-10' },
  ];
  const cur = buildRollupsFromStops(stops).get('k');
  assert.equal(cur.name, 'NEW NAME');
  assert.equal(cur.addr1, 'new');
  assert.equal(cur.last_date, '2026-06-10');
  assert.equal(cur.pros[0].pro, 'P2'); // newest first
});

test('buildRollupsFromStops: skips stops with no matchKey and no pro', () => {
  const stops = [
    { businessName: 'NO KEY', pro: 'X', date: '2026-06-01' }, // no customerMatchKey → skipped
    { customerMatchKey: 'k', businessName: 'HAS KEY', date: '2026-06-02' }, // no pro → kept as customer, empty pros
  ];
  const map = buildRollupsFromStops(stops);
  assert.equal(map.size, 1);
  assert.equal(map.get('k').name, 'HAS KEY');
  assert.deepEqual(map.get('k').pros, []);
});
