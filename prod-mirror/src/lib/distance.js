// Pure geo helpers used by the M4.1 day-snapshot sidebar.
// haversine returns miles between two lat/lng points.
// naiveEtaMinutes assumes a 30 mph effective speed — intentionally crude;
// upgrade to Google Distance Matrix later (see HANDOFF.md).

const EARTH_RADIUS_MILES = 3958.8;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function haversineMiles(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) {
    return null;
  }
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

export function naiveEtaMinutes(from, to, effectiveMph = 30) {
  const miles = haversineMiles(from, to);
  if (miles == null) return null;
  return (miles / effectiveMph) * 60;
}

export function formatEtaClockTime(etaMinutes, now = new Date()) {
  if (etaMinutes == null) return null;
  const target = new Date(now.getTime() + etaMinutes * 60 * 1000);
  return target.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
