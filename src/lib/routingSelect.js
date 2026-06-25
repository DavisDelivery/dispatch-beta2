// Pure selection geometry for the map's Plan mode (box / lasso / add-in-view).
// Ported from the davis-nuvizz dispatch-map routing tool (routing-select.js) so
// the touch/drag selection math is unit-testable without the Google-Maps shell.
// The only map-provider-specific step (screen-pixel -> LatLng) lives in Map.jsx
// via OverlayView.getProjection(); everything here is plain numbers.

// Ray-casting point-in-polygon. path = [[lat,lng], …]. No geometry lib.
// Used by the Lasso tool (drawn vertices -> enclosed stops).
export function pointInPolygon(lat, lng, path) {
  if (lat == null || lng == null || !Array.isArray(path) || path.length < 3) return false
  let inside = false
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const [yi, xi] = path[i]
    const [yj, xj] = path[j]
    const intersect =
      ((xi > lng) !== (xj > lng)) &&
      lat < ((yj - yi) * (lng - xi)) / ((xj - xi) || 1e-12) + yi
    if (intersect) inside = !inside
  }
  return inside
}

// Axis-aligned bounding-box containment. box = { north, south, east, west }.
// Used by Add-stops-in-view (from the map's getBounds) and Box (two corners).
export function latLngInBounds(lat, lng, box) {
  if (lat == null || lng == null || !box) return false
  return lat <= box.north && lat >= box.south && lng <= box.east && lng >= box.west
}

// Normalize two corner points {lat,lng} into a { north, south, east, west } box.
export function boxFromCorners(a, b) {
  return {
    north: Math.max(a.lat, b.lat),
    south: Math.min(a.lat, b.lat),
    east: Math.max(a.lng, b.lng),
    west: Math.min(a.lng, b.lng),
  }
}

// Stable selection key for a flattened read-stop. Coordinates aren't unique and
// stopId may be absent on the read shape, so key on the load + stop number pair.
export function stopKey(stop) {
  return `${stop.loadNbr ?? ''}|${stop.stopNbr ?? ''}`
}
