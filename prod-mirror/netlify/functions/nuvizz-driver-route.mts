// nuvizz-driver-route.mts
//
// Returns a driver day-snapshot: route assignment + per-stop status + Motive
// HOS + daily miles, all bundled. Called by the M4.1 right-sidebar when the
// dispatcher clicks a driver marker.
//
// Data source: the pre-scanned Firestore stop index
// (nuvizz_stop_index/{tenant}__{date}) that nuvizz-refresh-stops-background
// already populates — the SAME index nuvizz-pull-today-stops serves to the map.
// We read it and filter to the loads assigned to this driver. This costs ZERO
// NuVizz calls per click.
//
// History: this function used to scan ~501 live /load/info numbers on EVERY
// click, via a raw fetch() that bypassed getNuvizzRequester() — so that traffic
// was invisible to the shared daily call counter AND not subject to the circuit
// breaker. A single dispatcher opening a dozen driver panels could fire ~6,000
// uncounted NuVizz calls. Reading the index removes that entirely: every NuVizz
// call the app makes now goes through the metered requester, so the counter is
// complete. (Regression-guarded by test/no-direct-nuvizz-fetch.test.mjs.)
//
// Matching prefers loadAssignment.driverUserName (a stable short code like
// "VINCENT") over loadAssignment.driverName (a full name like "VINCENT  BONZO"
// that NuVizz returns with inconsistent internal whitespace), mirroring the
// proven pattern in the parent app's nuvizz.cjs:__driver.
//
// Query params:
//   driver=<name>     driver full name from Motive (passed by client)
//   truck=<number>    Motive vehicle number (passed by client)
//   userName=<code>   optional stable driver code (e.g. "VINCENT") — preferred
//                     match field. Resolved from `driver` via DAVIS_DRIVERS
//                     when omitted.
//   date=YYYY-MM-DD   optional, defaults to today UTC
//
// Response shape (consumed by App.jsx's useDriverSnapshot + DriverSnapshotSidebar):
// {
//   ok: true,
//   route: { id, totalStops, completed, remaining } | null,
//   stops: [{ pro, pros, primaryPro, proCount, businessName, addr1, city, state,
//             lat, lng, scheduledTime, actualArrival, actualCompletion, status,
//             lateMinutes, loadNbr }, ...],
//   hos: { loggedInAt, onDutySeconds } | null,
//   dailyMiles: number | null,
//   matchedBy: 'userName' | 'driverName' | null,   // diagnostic
//   raw: { ... }     // preserve at every layer per standing rules
// }

import { isFirestoreEnabled, readStops } from './lib/firestore.mts';

const MOTIVE_BASE = process.env.MOTIVE_BASE_URL || 'https://api.gomotive.com/v1';
const TENANT = 'davis'; // index tenant key — matches nuvizz-pull-today-stops.mts

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// DAVIS_DRIVERS — full registry mirrored from the parent app
// (src/lib/api.js:99-134). Used to resolve a Motive full name into a NuVizz
// userName, which is the stable matching key. Keep in sync with parent.
const DAVIS_DRIVERS: Array<{ userName: string; name: string }> = [
  { userName: 'AARON',   name: 'Aaron Mitchell' },
  { userName: 'ALLEN',   name: 'Allen Council' },
  { userName: 'BEN',     name: 'Ben Paintsil' },
  { userName: 'BILL',    name: 'Bill Tillery' },
  { userName: 'BRAD',    name: 'Brad Goodroe' },
  { userName: 'BRETT',   name: 'Brett Spradley' },
  { userName: 'BRIAN',   name: 'Brian Worley' },
  { userName: 'CHAD',    name: 'Chad Davis' },
  { userName: 'COLIN',   name: 'Colin Calhoun' },
  { userName: 'FRANK',   name: 'Frank Okine' },
  { userName: 'GARRY',   name: 'Garry Pitts' },
  { userName: 'GEORGE',  name: 'George Leonard' },
  { userName: 'JACK',    name: 'Jack Johnson' },
  { userName: 'JEAN',    name: 'Jean Delsoin' },
  { userName: 'JERALD',  name: 'Jerald Buckley' },
  { userName: 'JIM',     name: 'Jim Pallette' },
  { userName: 'JOE',     name: 'Joe Gibbs' },
  { userName: 'JOHN',    name: 'John Thompson' },
  { userName: 'KEN',     name: 'Ken Watkins' },
  { userName: 'LEROY',   name: 'Leroy Smith' },
  { userName: 'MARCUS',  name: 'Marcus Young' },
  { userName: 'MARTIN',  name: 'Martin Wyatt' },
  { userName: 'MIKE',    name: 'Mike Kirkeby' },
  { userName: 'NELSON',  name: 'Oyieke Nelson' },
  { userName: 'RICHARD', name: 'Richard Mawuenyega' },
  { userName: 'ROBERT',  name: 'Robert Best' },
  { userName: 'RONALD',  name: 'Ronald Gates' },
  { userName: 'RYAN',    name: 'Ryan Freeland' },
  { userName: 'SAMUEL',  name: 'Samuel Osei' },
  { userName: 'SCOTT',   name: 'Scott Hart' },
  { userName: 'STEVEN',  name: 'Steven Adjetey' },
  { userName: 'TERRY',   name: 'Terry Gambrell' },
  { userName: 'VICTOR',  name: 'Victor Fernandez' },
  { userName: 'VINCENT', name: 'Vincent Bonzo' },
  { userName: 'WILLIAM', name: 'William Kidd' },
];

// NuVizz returns driverName with inconsistent spacing ("VINCENT  BONZO" with
// two spaces). Normalize: lowercase, collapse all whitespace runs to single
// space, trim. Use everywhere a name comparison is done.
function normName(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Resolve a Motive-supplied driver full name to the NuVizz userName via the
// DAVIS_DRIVERS registry. Returns null if no match — caller should fall back
// to normalized-name matching.
function resolveUserName(driverFullName: string): string | null {
  const target = normName(driverFullName);
  if (!target) return null;
  const exact = DAVIS_DRIVERS.find((d) => normName(d.name) === target);
  if (exact) return exact.userName;
  // Loose fallback: first token (first name) match. Helps when Motive sends
  // "Vincent" but registry has "Vincent Bonzo".
  const firstToken = target.split(' ')[0];
  const byFirst = DAVIS_DRIVERS.filter((d) => normName(d.name).split(' ')[0] === firstToken);
  if (byFirst.length === 1) return byFirst[0].userName;
  return null;
}

// In-memory per-driver cache, 30s TTL. Matches the client cache; redundant
// but cheap insurance against repeated Firestore reads on rapid re-clicks.
const __cache = new Map<string, { storedAt: number; data: any }>();
const CACHE_TTL_MS = 30 * 1000;

// Map the index's execution-lifecycle bucket (StopStatusKind) to the coarse
// status the driver sidebar renders. Anything not in-flight or delivered counts
// as 'pending' (incl. SCHEDULED / EXCEPTION / UNPLANNED) so the route's
// completed/remaining split matches the fleet summary.
function driverStatusFromNormalized(n: string | null | undefined): string {
  switch (n) {
    case 'DELIVERED': return 'completed';
    case 'OUT_FOR_DEL': return 'en_route';
    case 'ARRIVED': return 'current';
    default: return 'pending';
  }
}

// PURE: given the pre-scanned stop index for a date, return the driver's route +
// stops in the snapshot shape. No I/O — unit-testable. Sources every field from
// the Firestore index that the map already uses, so it costs ZERO NuVizz calls.
export function buildDriverRouteFromStops(
  indexed: any[],
  driverFullName: string,
  userName: string | null,
): { route: any; stops: any[]; matchedBy: 'userName' | 'driverName' | null } {
  const targetName = normName(driverFullName);
  const targetUser = (userName || '').toUpperCase().trim();

  const mine: any[] = [];
  let matchedBy: 'userName' | 'driverName' | null = null;
  for (const s of indexed || []) {
    if (!s || !s.isPlanned) continue; // only routed/planned stops belong to a driver
    const loadUser = String(s.driverUserName || '').toUpperCase().trim();
    const loadDriver = normName(s.driverName);
    if (!loadUser && !loadDriver) continue;
    // Prefer stable userName match; fall back to whitespace-normalized name.
    if (targetUser && loadUser === targetUser) {
      mine.push(s);
      matchedBy = matchedBy || 'userName';
    } else if (targetName && loadDriver === targetName) {
      mine.push(s);
      matchedBy = matchedBy || 'driverName';
    }
  }

  const stops = mine.map((s) => {
    const stopNbr: string | null = s.stopNbr ?? null;
    const pros: string[] = Array.isArray(s.pros) && s.pros.length ? s.pros : (stopNbr ? [stopNbr] : []);
    return {
      pro: s.pro ?? stopNbr,
      pros,
      primaryPro: s.primaryPro ?? pros[0] ?? null,
      proCount: typeof s.proCount === 'number' ? s.proCount : pros.length,
      stopNbr,
      businessName: s.businessName ?? null,
      addr1: s.addr1 ?? null,
      city: s.city ?? null,
      state: s.state ?? null,
      lat: s.lat ?? null,
      lng: s.lng ?? null,
      scheduledTime: s.scheduledFrom ?? null,
      actualArrival: s.arrivalDTTM ?? null,
      actualCompletion: s.deliveredDTTM ?? null,
      status: driverStatusFromNormalized(s.normalizedStatus),
      loadNbr: s.loadNbr ?? null,
    };
  });
  // Sort by scheduled time so the sidebar shows the route in delivery order.
  stops.sort((a, b) => (a.scheduledTime || '').localeCompare(b.scheduledTime || ''));

  if (!stops.length) return { route: null, stops: [], matchedBy: null };

  const completed = stops.filter((s) => s.status === 'completed').length;
  // Use the first matched load's loadNbr as a stand-in "route id".
  const routeId = mine[0]?.loadNbr || null;
  return {
    route: {
      id: routeId,
      totalStops: stops.length,
      completed,
      remaining: stops.length - completed,
    },
    stops,
    matchedBy,
  };
}

// Read the pre-scanned index for the date and build the driver's route from it.
// Degrades safely (empty route) when Firestore is not configured.
async function buildRouteFromIndex(
  date: string,
  driverFullName: string,
  userName: string | null,
): Promise<{ route: any; stops: any[]; matchedBy: 'userName' | 'driverName' | null }> {
  if (!isFirestoreEnabled()) return { route: null, stops: [], matchedBy: null };
  const { stops: indexed } = await readStops(TENANT, date);
  return buildDriverRouteFromStops(indexed, driverFullName, userName);
}

// Motive HOS — best-effort. Returns null if not exposed for this tier.
async function fetchHos(driverName: string): Promise<{ loggedInAt: string | null; onDutySeconds: number | null } | null> {
  const key = process.env.MOTIVE_API_KEY;
  if (!key || !driverName) return null;
  try {
    // No documented endpoint that takes a driver name directly; the standard
    // shape is /users/{id}/duty_status. We don't know the user id at this
    // layer. Try the bulk endpoint and filter — many Motive tiers expose it.
    const url = `${MOTIVE_BASE}/users/duty_status_logs`;
    const resp = await fetch(url, { headers: { 'X-API-KEY': key, Accept: 'application/json' } });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const list = data?.duty_status_logs || data?.logs || [];
    // Pick the most recent log matching the driver name; sum on-duty seconds today.
    const matching = list.filter((entry: any) => {
      const e = entry.duty_status_log || entry;
      const u = e.user || e.driver || {};
      const name = u.full_name || (u.first_name && u.last_name ? `${u.first_name} ${u.last_name}` : '');
      return name && name.toLowerCase().trim() === driverName.toLowerCase().trim();
    });
    if (!matching.length) return null;
    // Heuristic: the earliest "on_duty" or "driving" today is loggedInAt.
    const today = todayUTC();
    const onDutyLogs = matching
      .map((entry: any) => entry.duty_status_log || entry)
      .filter((e: any) => (e.start_time || '').slice(0, 10) === today)
      .filter((e: any) => ['on_duty', 'driving', 'on_duty_nd', 'on'].includes(String(e.duty_status || '').toLowerCase()));
    if (!onDutyLogs.length) return null;
    onDutyLogs.sort((a: any, b: any) => (a.start_time || '').localeCompare(b.start_time || ''));
    const loggedInAt = onDutyLogs[0].start_time || null;
    let onDutySeconds = 0;
    for (const log of onDutyLogs) {
      const start = new Date(log.start_time).getTime();
      const end = log.end_time ? new Date(log.end_time).getTime() : Date.now();
      if (!Number.isNaN(start) && !Number.isNaN(end)) onDutySeconds += Math.max(0, Math.round((end - start) / 1000));
    }
    return { loggedInAt, onDutySeconds };
  } catch {
    return null;
  }
}

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const url = new URL(req.url);
  const driver = url.searchParams.get('driver') || '';
  const truck = url.searchParams.get('truck') || '';
  const userNameParam = url.searchParams.get('userName') || '';
  const date = url.searchParams.get('date') || todayUTC();
  const bypassCache = url.searchParams.get('nocache') === '1';

  // Resolve userName: explicit param wins; otherwise look up by name in the
  // DAVIS_DRIVERS registry. Registry hit dramatically improves match rate
  // because NuVizz returns driverName with inconsistent whitespace.
  const userName = userNameParam || resolveUserName(driver);

  const cacheKey = `${truck}|${userName || driver}|${date}`;
  if (!bypassCache) {
    const hit = __cache.get(cacheKey);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ ...hit.data, cached: true }), { status: 200, headers: cors });
    }
  }

  try {
    let route: any = null;
    let stops: any[] = [];
    let matchedBy: 'userName' | 'driverName' | null = null;
    if (driver || userName) {
      try {
        const r = await buildRouteFromIndex(date, driver, userName);
        route = r.route;
        stops = r.stops;
        matchedBy = r.matchedBy;
      } catch (e: any) {
        // Index read failed (e.g. Firestore hiccup) — fall through with route=null.
        console.warn('driver-route index read failed', e.message);
      }
    }

    const hos = driver ? await fetchHos(driver) : null;
    // Daily miles is not yet wired — Motive exposes it on a vehicle daily-
    // summary endpoint we'd need to discover. Returning null per brief
    // (document the gap rather than fabricating).
    const dailyMiles: number | null = null;

    const out = {
      ok: true,
      truck,
      driver,
      userName,
      date,
      route,
      stops,
      hos,
      dailyMiles,
      matchedBy,
      cached: false,
      generated: new Date().toISOString(),
    };
    __cache.set(cacheKey, { storedAt: Date.now(), data: out });
    return new Response(JSON.stringify(out), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      truck,
      driver,
      userName,
      route: null,
      stops: [],
      hos: null,
      dailyMiles: null,
      matchedBy: null,
    }), { status: 500, headers: cors });
  }
};
