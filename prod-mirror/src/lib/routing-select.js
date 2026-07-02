// P2 (PR3) — pure selection-geometry + display helpers for the Routing tab.
// Extracted from App.jsx so the touch-selection math and the per-stop detail
// formatting can be unit-tested without the React / Google-Maps shell. App.jsx
// imports these; the on-map controls (Add-in-view, Box, Lasso) feed plain
// numbers/objects through here, so what the tests exercise is what ships.

// Day key order, Mon→Sun. Mirrors App.jsx's DAYS for receiving-hours grouping.
export const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Ray-casting point-in-polygon. path = [[lat,lng], …]. Free; no geometry lib.
// Used by the Lasso tool (tap-to-place vertices → enclosed stops).
export function pointInPolygon(lat, lng, path) {
  if (lat == null || lng == null || !Array.isArray(path) || path.length < 3) return false;
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const [yi, xi] = path[i], [yj, xj] = path[j];
    const intersect = ((xi > lng) !== (xj > lng)) && (lat < ((yj - yi) * (lng - xi)) / ((xj - xi) || 1e-12) + yi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Axis-aligned bounding-box containment. box = { north, south, east, west }.
// Used by Add-stops-in-view (from the map's getBounds) and Box (from the two
// tapped corners) — both reduce to a lat/lng range test, no Google object.
export function latLngInBounds(lat, lng, box) {
  if (lat == null || lng == null || !box) return false;
  return lat <= box.north && lat >= box.south && lng <= box.east && lng >= box.west;
}

// Normalize two corner points {lat,lng} into a { north, south, east, west } box.
export function boxFromCorners(a, b) {
  return {
    north: Math.max(a.lat, b.lat),
    south: Math.min(a.lat, b.lat),
    east: Math.max(a.lng, b.lng),
    west: Math.min(a.lng, b.lng),
  };
}

// "08:00" → "8:00a"; "14:30" → "2:30p". Already-formatted (am/pm) or unparseable
// strings pass through untouched so legacy free-text hours still render readably.
export function fmtTime12(t) {
  if (!t) return '';
  const s = String(t).trim();
  if (/[ap]\.?m/i.test(s)) return s.replace(/\s*([ap])\.?m\.?/i, (_, p) => p.toLowerCase());
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  let h = Number(m[1]);
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m[2]}${ap}`;
}

// Render a note's receiving hours as one compact human line, collapsing runs of
// consecutive days with identical hours into ranges, e.g.
// "Mon–Fri 8:00a–3:00p · Sat Closed". Returns null when nothing is set. Handles
// legacy string days and the M4.4 {open,close} shape, same as the notes popup.
export function formatReceivingHours(note) {
  if (!note) return null;
  const closed = new Set(Array.isArray(note.closed_days) ? note.closed_days : []);
  const hrs = note.receiving_hours || {};
  const label = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const dayVal = (d) => {
    if (closed.has(d)) return 'Closed';
    const v = hrs[d];
    if (!v) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (v.open && v.close) return `${fmtTime12(v.open)}–${fmtTime12(v.close)}`;
    return fmtTime12(v.open || v.close) || null;
  };
  const segs = [];
  let i = 0;
  while (i < DAY_ORDER.length) {
    const val = dayVal(DAY_ORDER[i]);
    if (val == null) { i++; continue; }
    let j = i;
    while (j + 1 < DAY_ORDER.length && dayVal(DAY_ORDER[j + 1]) === val) j++;
    const range = i === j ? label[DAY_ORDER[i]] : `${label[DAY_ORDER[i]]}–${label[DAY_ORDER[j]]}`;
    segs.push(`${range} ${val}`);
    i = j + 1;
  }
  return segs.length ? segs.join(' · ') : null;
}

// One line item's dimensions as a short string ("96×48×40 in"), falling back to
// the single critical dimension when L/W/H aren't all present. "" when none.
export function lineItemDims(d) {
  if (d == null) return '';
  if (d.length != null || d.width != null || d.height != null) {
    const uom = d.lengthUOM || d.widthUOM || d.heightUOM || 'in';
    const n = (v) => (v == null ? '–' : v);
    return `${n(d.length)}×${n(d.width)}×${n(d.height)} ${uom}`;
  }
  if (d.criticalDimension != null) return `${d.criticalDimension} ${d.criticalDimensionUOM || 'in'}`;
  return '';
}

// ── Manual route reorder (PR: drag-and-drop) ──────────────────────────────────
// Pure helpers so the reorder + client-side recompute are unit-testable without
// the React/Maps shell. The recompute mirrors the engine's FREE haversine matrix
// convention (1.3× road factor over crow-flies, ~30 mph effective) so a manually
// reordered route's legs/ETAs are consistent with a free build.

export const ROUTE_ROAD_FACTOR = 1.3;     // mirror of google-route-matrix haversine
export const ROUTE_AVG_SPEED_MPS = 13.4;  // ~30 mph effective
export const DEFAULT_SERVICE_SEC = 20 * 60;

export function haversineMeters(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Pure array move: returns a NEW array with the item at `from` moved to `to`.
// Out-of-range / no-op moves return a shallow copy unchanged.
export function moveItem(arr, from, to) {
  const out = [...arr];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

// Recompute legs + cumulative arrival ETAs for an ordered list of stops, starting
// from the depot at departSec, with serviceSec dwell after each stop. Returns
// straight-line (haversine) estimates — used after a MANUAL reorder, where any
// Google road legs no longer apply. orderedStops: [{ id, lat, lng }].
export function recomputeRoute(orderedStops, depot, departSec = 0, serviceSec = DEFAULT_SERVICE_SEC) {
  const legs = [];
  const etas = [];
  let totalDistanceMeters = 0;
  let totalDurationSec = 0;
  let prev = { id: 'depot', lat: depot.lat, lng: depot.lng };
  let clock = departSec;
  for (const s of orderedStops) {
    const dist = haversineMeters(prev, s) * ROUTE_ROAD_FACTOR;
    const dur = Math.round(dist / ROUTE_AVG_SPEED_MPS);
    clock += dur;
    legs.push({ fromId: prev.id, toId: s.id, distanceMeters: Math.round(dist), durationSec: dur });
    etas.push(clock);                 // arrival at this stop
    totalDistanceMeters += dist;
    totalDurationSec += dur;
    clock += serviceSec;              // dwell before departing to the next
    prev = s;
  }
  return { legs, etas, totalDistanceMeters: Math.round(totalDistanceMeters), totalDurationSec };
}


// ── Per-load client-side re-sequencing (PR: routing UX) ───────────────────────
// Mirrors the engine's sequencing strategies CLIENT-SIDE on haversine distance —
// same convention as the manual reorder recompute. `stops` are { id, lat, lng } in
// the route's CURRENT order; each returns a NEW array (a permutation of `stops`).
// The caller maps the result to ids and recomputes legs/ETAs via recomputeRoute.

function routeTotalMeters(orderedStops, depot) {
  let total = 0;
  let prev = depot;
  for (const s of orderedStops) { total += haversineMeters(prev, s); prev = s; }
  return total;
}

// Sort by crow-flies distance from the depot (Closest first / Farthest first).
export function depotSort(stops, depot, dir = 'asc') {
  const withD = stops.map((s) => ({ s, d: haversineMeters(depot, s) }));
  withD.sort((a, b) => (dir === 'asc' ? a.d - b.d : b.d - a.d));
  return withD.map((x) => x.s);
}

// Greedy nearest-neighbour tour starting from the depot.
export function nearestNeighbor(stops, depot) {
  const remaining = [...stops];
  const out = [];
  let cur = depot;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMeters(cur, remaining[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    cur = remaining.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}

// Bounded 2-opt improvement over the depot-anchored path (segment reversals while
// they shorten the total). Capped passes so it's cheap for a single route.
export function twoOpt(stops, depot, maxPasses = 6) {
  let best = [...stops];
  let bestLen = routeTotalMeters(best, depot);
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const len = routeTotalMeters(cand, depot);
        if (len + 1e-6 < bestLen) { best = cand; bestLen = len; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

// Closed-LOOP length: depot → s1 → … → sn → back to depot. The return leg is what
// makes 2-opt produce the "down one side, up the other" U-shape — an open path has
// no reason to come back, so it can leave the route crossing itself; closing the
// loop forces the optimizer to run out along one side of the corridor and return
// along the other.
function loopTotalMeters(orderedStops, depot) {
  if (!orderedStops.length) return 0;
  let total = 0;
  let prev = depot;
  for (const s of orderedStops) { total += haversineMeters(prev, s); prev = s; }
  total += haversineMeters(prev, depot);   // close the loop back to the terminal
  return total;
}

// 2-opt over the CLOSED loop (depot anchored at both ends). Same segment-reversal
// move as twoOpt(), but scored on the round-trip so crossings get un-crossed into a
// clean out-and-back loop. Returned in visiting order (depot start is implied).
export function twoOptLoop(stops, depot, maxPasses = 8) {
  let best = [...stops];
  let bestLen = loopTotalMeters(best, depot);
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const len = loopTotalMeters(cand, depot);
        if (len + 1e-6 < bestLen) { best = cand; bestLen = len; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

// Re-sequence one route's stops by strategy. 'reverse' flips the current order;
// the others are computed fresh from depot + positions.
//   loop     — nearest-neighbour seed + closed-loop 2-opt → U-shape (down one side,
//              back the other), the no-crisscross order for a highway corridor.
//   min      — nearest-neighbour seed + open-path 2-opt → shortest one-way distance.
export function resequence(stops, depot, strategy) {
  const arr = Array.isArray(stops) ? stops : [];
  if (arr.length < 2) return [...arr];
  switch (strategy) {
    case 'reverse': return [...arr].reverse();
    case 'closest': return depotSort(arr, depot, 'asc');
    case 'farthest': return depotSort(arr, depot, 'desc');
    case 'loop': return twoOptLoop(nearestNeighbor(arr, depot), depot);
    case 'min': return twoOpt(nearestNeighbor(arr, depot), depot);
    default: return [...arr];
  }
}
