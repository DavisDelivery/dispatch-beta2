// test/terminal-skip.test.mjs — Phase 6: terminal-stop (/stop/info) skip cache.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isTerminalStatus, buildTerminalSkipPlan } from '../netlify/functions/lib/nuvizz-scan.mts';
import { pruneTerminalMap } from '../netlify/functions/lib/firestore.mts';

test('isTerminalStatus: only 90/91 are terminal (trimmed); 10/blank/null are not', () => {
  assert.equal(isTerminalStatus('90'), true);
  assert.equal(isTerminalStatus('91'), true);
  assert.equal(isTerminalStatus(' 90 '), true);
  assert.equal(isTerminalStatus(90), true);
  assert.equal(isTerminalStatus('10'), false);
  assert.equal(isTerminalStatus('20'), false);
  assert.equal(isTerminalStatus(''), false);
  assert.equal(isTerminalStatus(null), false);
  assert.equal(isTerminalStatus(undefined), false);
});

test('buildTerminalSkipPlan: cached numbers are synthesized (no probe), unknowns are probed', () => {
  const cache = new Map([[100, '2026-06-18'], [102, '2026-06-17']]);
  const { toProbe, synthesized } = buildTerminalSkipPlan([103, 102, 101, 100], cache);
  // Only uncached numbers are queued for a /stop/info call.
  assert.deepEqual(toProbe, [103, 101]);
  // Synthesized entries mirror a real delivered-stop probe exactly.
  assert.deepEqual(synthesized.map((s) => s.n).sort((a, b) => a - b), [100, 102]);
  for (const s of synthesized) {
    assert.equal(s.exists, true);
    assert.equal(s.terminal, true);
    assert.equal(s.record, null, 'a terminal stop is never a status-10 target');
    assert.equal(typeof s.expected, 'string');
  }
  // The synthesized expected dates come straight from the cache (feed the heuristics).
  const byN = Object.fromEntries(synthesized.map((s) => [s.n, s.expected]));
  assert.equal(byN[100], '2026-06-18');
  assert.equal(byN[102], '2026-06-17');
});

test('buildTerminalSkipPlan: empty cache probes everything', () => {
  const { toProbe, synthesized } = buildTerminalSkipPlan([5, 4, 3], new Map());
  assert.deepEqual(toProbe, [5, 4, 3]);
  assert.equal(synthesized.length, 0);
});

test('pruneTerminalMap: keeps numbers >= retainFloor, drops below the live band', () => {
  const map = { '000001000': '2026-06-10', '000002000': '2026-06-15', '000003000': '2026-06-18' };
  const pruned = pruneTerminalMap(map, 2000);
  assert.deepEqual(Object.keys(pruned).sort(), ['000002000', '000003000']);
  assert.equal(pruned['000002000'], '2026-06-15');
  // boundary is inclusive; an empty map stays empty.
  assert.deepEqual(pruneTerminalMap({}, 100), {});
  assert.deepEqual(pruneTerminalMap(map, 5000), {}, 'floor above all → drop everything');
});
