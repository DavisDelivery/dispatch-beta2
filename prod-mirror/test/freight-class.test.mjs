// test/freight-class.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { toInches, toLbs, cubicFeet, densityToClass, deriveShipmentFreight } from '../netlify/functions/lib/freight-class.mts';

test('unit conversions', () => {
  assert.equal(toInches(2, 'FT'), 24);
  assert.equal(toInches(100, 'CM'), 100 / 2.54);
  assert.equal(toInches(50, null), 50);
  assert.equal(toLbs(1, 'KG'), 2.20462);
  assert.equal(toLbs(16, 'OZ'), 1);
  assert.equal(toLbs(500, null), 500);
});

test('cubicFeet: a 48x40x48 pallet is ~53.3 ft³', () => {
  assert.ok(Math.abs(cubicFeet(48, 40, 48) - 53.33) < 0.05);
});

test('densityToClass: standard density breakpoints', () => {
  assert.equal(densityToClass(0.5), 500);   // <1 → bottom class
  assert.equal(densityToClass(1), 400);     // 1–2
  assert.equal(densityToClass(5), 175);
  assert.equal(densityToClass(8), 110);
  assert.equal(densityToClass(12), 85);
  assert.equal(densityToClass(30), 60);
  assert.equal(densityToClass(50), 50);
  assert.equal(densityToClass(0), 500);      // no/zero density → bottom class
});

test('deriveShipmentFreight: full L×W×H → real density + class', () => {
  // One pallet-sized line, 48x40x48 in (~53.33 ft³), 800 lb → ~15 pcf → class 70.
  const stop = {
    pallets: 1, weight: 800, weightUOM: 'LB',
    stopDetails: [{ quantity: 1, sku: 'SKU-1', product: 'Widget', length: 48, lengthUOM: 'IN', width: 40, widthUOM: 'IN', height: 48, heightUOM: 'IN', weight: 800, weightUOM: 'LB' }],
  };
  const f = deriveShipmentFreight(stop);
  assert.equal(f.dimsCoverage, 'full');
  assert.equal(f.cubeSource, 'dims');
  assert.ok(Math.abs(f.cubeFt3Used - 53.33) < 0.1);
  assert.ok(Math.abs(f.densityPcf - 15.0) < 0.2);
  assert.equal(f.freightClass, 70);
  assert.equal(f.lbPerPallet, 800);
  assert.deepEqual(f.skus, ['SKU-1']);
  assert.deepEqual(f.products, ['Widget']);
});

test('deriveShipmentFreight: no dims → pallet-cube fallback, coverage flagged', () => {
  // 2 pallets, 1200 lb, no line dims. Fallback cube = 2 × (48×40×60)/1728 = 133.33 ft³.
  const stop = { pallets: 2, weight: 1200, weightUOM: 'LB', stopDetails: [{ quantity: 1, weight: 1200, weightUOM: 'LB' }] };
  const f = deriveShipmentFreight(stop, { stackHeightIn: 60 });
  assert.equal(f.dimsCoverage, 'none');
  assert.equal(f.cubeSource, 'pallet_est');
  assert.ok(Math.abs(f.cubeFt3Used - 133.33) < 0.1);
  assert.equal(f.freightClass, densityToClass(1200 / 133.33)); // ~9 pcf → 100
});

test('deriveShipmentFreight: criticalDimension-only is flagged "critical"', () => {
  const stop = { pallets: 1, weight: 500, stopDetails: [{ quantity: 1, criticalDimension: 96, criticalDimensionUOM: 'IN' }] };
  const f = deriveShipmentFreight(stop);
  assert.equal(f.dimsCoverage, 'critical');
  assert.equal(f.cubeSource, 'pallet_est'); // no full L×W×H → estimate
});
