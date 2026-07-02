// test/routing-geometry.test.mjs — PURE freight-geometry derivation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  deriveGeometryDeterministic, applyAssist, palletLinearInches,
  deriveGeometryForStops, geometryCacheKey,
} from '../netlify/functions/lib/freight-geometry.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STOPS = JSON.parse(readFileSync(join(__dirname, 'fixtures/routing-geometry-stops.json'), 'utf8'));
const byNbr = (n) => STOPS.find((s) => s.stopNbr === n);

test('palletLinearInches: 2-across loading rounds up rows', () => {
  assert.equal(palletLinearInches(0), 0);
  assert.equal(palletLinearInches(1), 48);   // 1 row
  assert.equal(palletLinearInches(2), 48);   // still 1 row (2 across)
  assert.equal(palletLinearInches(3), 96);   // 2 rows
  assert.equal(palletLinearInches(4), 96);
});

test('plain pallets: skids/weight/linear, not oversize', () => {
  const g = deriveGeometryDeterministic(byNbr('G-001'));
  assert.equal(g.skids, 4);
  assert.equal(g.weightLbs, 1450);
  assert.equal(g.linearFeetIn, 96);
  assert.equal(g.oversize, false);
  assert.equal(g.ambiguous, false);
});

test('productCategory L + 144in length → oversize, length added to deck inches', () => {
  const g = deriveGeometryDeterministic(byNbr('G-002'));
  assert.equal(g.oversize, true);
  // 2 pallets = 48in floor + 3 × 144in racking = 432 → 480.
  assert.equal(g.linearFeetIn, 48 + 432);
  assert.equal(g.ambiguous, false);
});

test('weight UOM kg converts to lbs', () => {
  const g = deriveGeometryDeterministic(byNbr('G-003'));
  assert.equal(g.weightLbs, Math.round(100 * 2.20462)); // 220
  assert.equal(g.skids, 1);
});

test('ambiguous free-text (racking, no structured length) is flagged', () => {
  const g = deriveGeometryDeterministic(byNbr('G-004'));
  assert.equal(g.ambiguous, true);
  assert.equal(g.oversize, false);
});

test('applyAssist merges model length onto deterministic pallet floor', () => {
  const base = deriveGeometryDeterministic(byNbr('G-004'));
  const merged = applyAssist(base, { linearFeetIn: 120, oversize: true });
  assert.equal(merged.parsedBy, 'assist');
  assert.equal(merged.oversize, true);
  assert.equal(merged.ambiguous, false);
  assert.equal(merged.linearFeetIn, palletLinearInches(base.skids) + 120); // 48 + 120
});

test('skids summed from pallet-UOM lines when totalPallets missing', () => {
  const g = deriveGeometryDeterministic(byNbr('G-005'));
  assert.equal(g.skids, 3);
  assert.equal(g.weightLbs, 800);
});

test('deriveGeometryForStops: assist called ONCE per ambiguous stop, cached, never for clear stops', async () => {
  let assistCalls = 0;
  const cache = new Map();
  const assist = async () => { assistCalls++; return { linearFeetIn: 120, oversize: true }; };
  const map = await deriveGeometryForStops(STOPS, { assist, cache });
  // Only G-004 is ambiguous → exactly one assist call.
  assert.equal(assistCalls, 1);
  assert.equal(map.get('G-004').parsedBy, 'assist');
  assert.equal(map.get('G-001').parsedBy, 'deterministic');
  // Re-run with same cache → no new model calls.
  await deriveGeometryForStops(STOPS, { assist, cache });
  assert.equal(assistCalls, 1);
});

test('deriveGeometryForStops: with NO assist, ambiguous stop keeps deterministic estimate', async () => {
  const map = await deriveGeometryForStops(STOPS, {});
  assert.equal(map.get('G-004').parsedBy, 'deterministic');
});

test('geometryCacheKey prefers SKU set', () => {
  assert.match(geometryCacheKey(byNbr('G-002')), /^sku:/);
  assert.match(geometryCacheKey({ stopNbr: 'X', stopDetails: [] }), /^stop:X/);
});
