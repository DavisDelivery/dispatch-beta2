import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pointInPolygon, latLngInBounds, boxFromCorners, stopKey } from './routingSelect.js'

// ---------------------------------------------------------------------------
// latLngInBounds + boxFromCorners
// ---------------------------------------------------------------------------

test('boxFromCorners normalizes either corner order into N/S/E/W', () => {
  const a = { lat: 35.6, lng: -80.9 }
  const b = { lat: 35.1, lng: -80.2 }
  assert.deepEqual(boxFromCorners(a, b), { north: 35.6, south: 35.1, east: -80.2, west: -80.9 })
  // swapping corners yields the same box
  assert.deepEqual(boxFromCorners(b, a), boxFromCorners(a, b))
})

test('latLngInBounds includes interior + edges, excludes outside', () => {
  const box = { north: 35.6, south: 35.1, east: -80.2, west: -80.9 }
  assert.equal(latLngInBounds(35.4, -80.5, box), true) // interior
  assert.equal(latLngInBounds(35.6, -80.2, box), true) // corner (inclusive)
  assert.equal(latLngInBounds(35.05, -80.5, box), false) // south of box
  assert.equal(latLngInBounds(35.4, -80.1, box), false) // east of box
})

test('latLngInBounds is null-safe', () => {
  const box = { north: 1, south: 0, east: 1, west: 0 }
  assert.equal(latLngInBounds(null, 0.5, box), false)
  assert.equal(latLngInBounds(0.5, undefined, box), false)
  assert.equal(latLngInBounds(0.5, 0.5, null), false)
})

// ---------------------------------------------------------------------------
// pointInPolygon
// ---------------------------------------------------------------------------

test('pointInPolygon: inside vs outside a simple square', () => {
  const square = [
    [0, 0],
    [0, 4],
    [4, 4],
    [4, 0],
  ]
  assert.equal(pointInPolygon(2, 2, square), true) // center
  assert.equal(pointInPolygon(5, 5, square), false) // outside
  assert.equal(pointInPolygon(-1, 2, square), false) // below
})

test('pointInPolygon: concave (L-shape) excludes the notch', () => {
  // An L-shaped polygon; the notch at (3,3) must read as outside.
  const L = [
    [0, 0],
    [0, 4],
    [2, 4],
    [2, 2],
    [4, 2],
    [4, 0],
  ]
  assert.equal(pointInPolygon(1, 1, L), true) // in the stem
  assert.equal(pointInPolygon(3, 3, L), false) // in the notch (cut-out)
})

test('pointInPolygon: degenerate paths are false', () => {
  assert.equal(pointInPolygon(1, 1, [[0, 0], [1, 1]]), false) // < 3 vertices
  assert.equal(pointInPolygon(1, 1, null as unknown as number[][]), false)
})

// ---------------------------------------------------------------------------
// stopKey
// ---------------------------------------------------------------------------

test('stopKey combines loadNbr + stopNbr and tolerates missing fields', () => {
  assert.equal(stopKey({ loadNbr: 'L1', stopNbr: '3' }), 'L1|3')
  assert.equal(stopKey({ stopNbr: '3' }), '|3')
  assert.equal(stopKey({}), '|')
})
