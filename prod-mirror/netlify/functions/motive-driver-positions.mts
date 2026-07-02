// motive-driver-positions.mts
//
// Returns live driver positions from Motive, enriched with the driver who is
// currently signed into each truck. Used by the dispatch map's "Show live
// drivers" toggle (60s client poll) and by the M4.1 driver day-snapshot
// sidebar (initial label render).
//
// Motive APIs we touch (key candidates per the brief — see HANDOFF.md for
// the confirmed working combination once tested against live creds):
//
//   GET /v1/vehicle_locations       — most recent position per vehicle. In
//                                     practice each entry already nests a
//                                     `current_driver` sub-object on this
//                                     account's tier, so this single call
//                                     covers truck #, driver, and lat/lng.
//   GET /v2/driver_vehicle_assignments — used as a fallback enrichment if a
//                                     vehicle entry has no current_driver
//                                     attached. Keyed by vehicle id.
//
// Auth: X-API-KEY header (env: MOTIVE_API_KEY).
//
// Caching: per-function-instance, 60s. The client polls every 60s anyway, but
// the in-memory cache protects against rapid re-renders (e.g. when the day-
// snapshot sidebar opens) hammering Motive.

const MOTIVE_BASE = process.env.MOTIVE_BASE_URL || 'https://api.gomotive.com/v1';

interface DriverPosition {
  vehicleId: number | string | null;
  vehicleNumber: string | null;
  driverId: number | string | null;
  driverName: string | null;
  driverFirstName: string | null;
  driverLastInitial: string | null;
  lat: number | null;
  lng: number | null;
  speedMph: number | null;
  heading: number | null;
  locatedAt: string | null;
  address: string | null;
  // M4.1 placeholders — populated by the day-snapshot sidebar's per-driver
  // call to nuvizz-driver-route, not by this endpoint. Included in the shape
  // for documentation / forward-compatibility.
  routeAssigned: boolean;
  routeId: string | null;
  routeTotalStops: number | null;
  routeProgress: { completed: number; total: number } | null;
  stoppedMinutes: number | null;
}

interface CacheEntry { storedAt: number; data: DriverPosition[]; }
const __cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000;

function firstNameOf(name: string | null): string | null {
  if (!name) return null;
  return name.split(/\s+/)[0] || null;
}

function lastInitialOf(name: string | null): string | null {
  if (!name) return null;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1].charAt(0).toUpperCase();
}

async function fetchVehicleLocations(key: string): Promise<any[]> {
  const url = `${MOTIVE_BASE}/vehicle_locations`;
  const resp = await fetch(url, {
    headers: { 'X-API-KEY': key, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw Object.assign(new Error(`Motive HTTP ${resp.status}`), { status: resp.status, body: text.slice(0, 400) });
  }
  const data: any = await resp.json();
  return data?.vehicles || data?.data || [];
}

// Fallback: pull current driver-vehicle assignments to fill in any vehicles
// that don't have current_driver embedded in /vehicle_locations. Best-effort.
async function fetchAssignments(key: string): Promise<Map<string | number, any>> {
  const map = new Map<string | number, any>();
  try {
    const url = `${MOTIVE_BASE.replace(/\/v1$/, '/v2')}/driver_vehicle_assignments`;
    const resp = await fetch(url, {
      headers: { 'X-API-KEY': key, Accept: 'application/json' },
    });
    if (!resp.ok) return map;
    const data: any = await resp.json();
    const list = data?.driver_vehicle_assignments || data?.assignments || data?.data || [];
    for (const entry of list) {
      const a = entry.driver_vehicle_assignment || entry;
      const vid = a.vehicle?.id ?? a.vehicle_id;
      const driver = a.driver || {};
      if (vid != null) {
        map.set(vid, {
          id: driver.id,
          full_name: driver.full_name || (driver.first_name && driver.last_name ? `${driver.first_name} ${driver.last_name}` : null),
          first_name: driver.first_name,
          last_name: driver.last_name,
        });
      }
    }
  } catch {
    // Swallow — assignments are a nicety, not a requirement.
  }
  return map;
}

function normalizeEntry(entry: any, assignmentLookup: Map<string | number, any>): DriverPosition {
  const v = entry.vehicle || entry;
  const loc = v.current_location || entry.current_location || {};
  let driver = v.current_driver || v.driver || entry.current_driver || null;
  if (!driver && v.id != null && assignmentLookup.has(v.id)) {
    driver = assignmentLookup.get(v.id);
  }
  const driverName: string | null = driver
    ? (driver.full_name || (driver.first_name && driver.last_name ? `${driver.first_name} ${driver.last_name}` : null))
    : null;
  return {
    vehicleId: v.id ?? null,
    vehicleNumber: v.number || v.name || null,
    driverId: driver?.id ?? null,
    driverName,
    driverFirstName: driver?.first_name || firstNameOf(driverName),
    driverLastInitial: driver?.last_name ? driver.last_name.charAt(0).toUpperCase() : lastInitialOf(driverName),
    lat: loc.lat != null ? Number(loc.lat) : null,
    lng: loc.lon != null ? Number(loc.lon) : (loc.lng != null ? Number(loc.lng) : null),
    speedMph: loc.speed != null ? Number(loc.speed) : null,
    heading: loc.bearing != null ? Number(loc.bearing) : null,
    locatedAt: loc.located_at || null,
    address: loc.description || null,
    routeAssigned: false,
    routeId: null,
    routeTotalStops: null,
    routeProgress: null,
    stoppedMinutes: null,
  };
}

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const key = process.env.MOTIVE_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: 'MOTIVE_API_KEY not set' }), {
      status: 500, headers: cors,
    });
  }

  const url = new URL(req.url);
  const bypassCache = url.searchParams.get('nocache') === '1';
  const cacheKey = 'default';

  if (!bypassCache) {
    const hit = __cache.get(cacheKey);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
      return new Response(JSON.stringify({
        ok: true,
        cached: true,
        generated: new Date(hit.storedAt).toISOString(),
        count: hit.data.length,
        drivers: hit.data,
      }), { status: 200, headers: cors });
    }
  }

  try {
    const rawVehicles = await fetchVehicleLocations(key);
    // Decide whether we even need the assignment fallback — only if any entry
    // is missing current_driver.
    const needsAssignments = rawVehicles.some((entry: any) => {
      const v = entry.vehicle || entry;
      return !(v.current_driver || v.driver || entry.current_driver);
    });
    const assignments = needsAssignments ? await fetchAssignments(key) : new Map();

    const drivers = rawVehicles
      .map((entry: any) => normalizeEntry(entry, assignments))
      .filter((d: DriverPosition) => d.lat != null && d.lng != null);

    __cache.set(cacheKey, { storedAt: Date.now(), data: drivers });

    return new Response(JSON.stringify({
      ok: true,
      cached: false,
      generated: new Date().toISOString(),
      count: drivers.length,
      drivers,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      status: e.status || 500,
      body: e.body,
    }), { status: e.status || 500, headers: cors });
  }
};
