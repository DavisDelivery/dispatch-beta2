// motive-drivers.mts
//
// Returns the FULL driver roster from Motive (the fleet-management app) — every
// driver in the account, not just those with a live position right now. Used by
// the dispatch map's DNS "Drivers not allowed" picker so a dispatcher can bar
// ANY driver from a customer, regardless of whether that driver is currently
// signed into a truck or on today's board.
//
// Contrast with motive-driver-positions.mts, which returns only drivers that
// have a current lat/lng (live "Show drivers" map layer).
//
//   GET /v1/users   — paginated account users. We keep role === 'driver' and
//                     drop deactivated/suspended accounts.
//
// Auth: X-API-KEY header (env: MOTIVE_API_KEY).
// Caching: per-function-instance, 1 hour — a roster changes rarely, and this is
// only read when the DNS editor is open.

const MOTIVE_BASE = process.env.MOTIVE_BASE_URL || 'https://api.gomotive.com/v1';

interface RosterDriver {
  id: number | string | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  status: string | null;
}

interface CacheEntry { storedAt: number; data: RosterDriver[]; }
const __cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const PER_PAGE = 100;
const MAX_PAGES = 25; // safety cap (≤ 2500 drivers)

function composeName(u: any): string | null {
  if (u.full_name) return String(u.full_name).trim() || null;
  const parts = [u.first_name, u.last_name].filter(Boolean);
  return parts.length ? parts.join(' ').trim() : null;
}

// A user counts as an active driver. Motive tags role as 'driver' (some accounts
// also expose 'fleet_user'/'admin'); status is 'active' unless deactivated.
function isActiveDriver(u: any): boolean {
  const role = String(u.role || '').toLowerCase();
  const status = String(u.status || 'active').toLowerCase();
  const roleOk = role === 'driver' || role.includes('driver');
  const statusOk = status === 'active' || status === '' || status === 'enabled';
  return roleOk && statusOk;
}

async function fetchDriverPage(key: string, pageNo: number): Promise<{ users: any[]; total: number | null }> {
  const url = `${MOTIVE_BASE}/users?per_page=${PER_PAGE}&page_no=${pageNo}`;
  const resp = await fetch(url, { headers: { 'X-API-KEY': key, Accept: 'application/json' } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw Object.assign(new Error(`Motive HTTP ${resp.status}`), { status: resp.status, body: text.slice(0, 400) });
  }
  const data: any = await resp.json();
  const list = data?.users || data?.data || [];
  const users = list.map((entry: any) => entry.user || entry);
  const total = data?.pagination?.total ?? null;
  return { users, total };
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const key = process.env.MOTIVE_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: 'MOTIVE_API_KEY not set' }), { status: 500, headers: cors });
  }

  const url = new URL(req.url);
  const bypassCache = url.searchParams.get('nocache') === '1';
  const cacheKey = 'roster';

  if (!bypassCache) {
    const hit = __cache.get(cacheKey);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
      return new Response(JSON.stringify({
        ok: true, cached: true, generated: new Date(hit.storedAt).toISOString(),
        count: hit.data.length, drivers: hit.data,
      }), { status: 200, headers: cors });
    }
  }

  try {
    const all: any[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { users, total } = await fetchDriverPage(key, page);
      all.push(...users);
      if (users.length < PER_PAGE) break;                 // last page
      if (total != null && all.length >= total) break;    // collected everything
    }
    const drivers: RosterDriver[] = all
      .filter(isActiveDriver)
      .map((u: any) => ({
        id: u.id ?? null,
        name: composeName(u),
        firstName: u.first_name ?? null,
        lastName: u.last_name ?? null,
        status: u.status ?? null,
      }))
      .filter((d) => d.name)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    __cache.set(cacheKey, { storedAt: Date.now(), data: drivers });

    return new Response(JSON.stringify({
      ok: true, cached: false, generated: new Date().toISOString(),
      count: drivers.length, drivers,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message, status: e.status || 500, body: e.body }), {
      status: e.status || 500, headers: cors,
    });
  }
};
