// nuvizz-driver-roster.mts
//
// Driver roster for the routing workbench's right-panel "Drivers" view.
//
// SOURCE PREFERENCE:
//   1. The shared roster doc (nuvizzRoster/{tenant}) that EITHER app persists.
//      Instant, zero NuVizz calls. This is the everyday read.
//   2. ?refresh=1 (or POST) forces a live pull of NuVizz's /user/list — the cheap
//      LIST-DISCOVERY path, ~1 call — then writes the shared roster so the mobile
//      app and this app both see the update.
//
// The roster changes rarely (hires / terminations), so the refresh is MANUAL ONLY —
// it is deliberately wired to no cron. A single /user/list returns the whole roster
// when maxResult exceeds the user count (the portal proved maxResult:200 works); the
// deduped pagination here is bounded to 10 calls worst case and can NEVER fan out to
// a load-number probe.
//
//   GET  ?tenant=davis                 → { ok, source:'cache', drivers, counts, updatedAt }
//   GET/POST ?tenant=davis&refresh=1   → { ok, source:'live',  drivers, counts, apiCalls, refreshedAt }
import { getCreds, basicAuthHeader } from './lib/nuvizz-scan.mts';
import { getNuvizzRequester, setCallTrigger } from './lib/nuvizz-request.mts';
import { isFirestoreEnabled, readDriverRoster, writeDriverRoster } from './lib/firestore.mts';

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
const TENANT = 'davis';

// Runaway-scan kill switch (parity with the parent app + the scheduled scanners):
// NUVIZZ_SCANS_ENABLED=false blocks any new NuVizz traffic, roster refresh included.
function scansEnabled(): boolean {
  return String(process.env.NUVIZZ_SCANS_ENABLED || '').trim().toLowerCase() !== 'false';
}

// Office/admin accounts carry one of these IN ADDITION to DI_Driver. Every Davis user
// has DI_Driver, so a "real driver" is one whose ONLY role family is driving.
// Keep in sync with the parent app's STAFF_ROLES (davis-nuvizz/netlify/functions/nuvizz.cjs).
const STAFF_ROLES = new Set([
  'MemberAdmin', 'GroupAdmin', 'Account_CSR', 'ROUTE_ANALYST',
  'DI_Integration', 'DI_Dispatcher', 'DI_Inquiry', 'DI_User', 'User',
]);

function normalizeRosterUser(u: any): any {
  const roles: string[] = (u.userRoles || []).map((r: any) => r && r.role).filter(Boolean);
  const isDriver = roles.includes('DI_Driver') && !roles.some((r) => STAFF_ROLES.has(r));
  const name = `${(u.firstName || '').trim()} ${(u.lastName || '').trim()}`.trim() || u.userName;
  const status = u.accountStatus || null;   // ENABLED / DISABLED
  return {
    userName: u.userName,
    userId: u.userId,
    id: u.id,
    name,
    firstName: (u.firstName || '').trim(),
    lastName: (u.lastName || '').trim(),
    email: u.email || null,
    mobileNumber: u.mobileNumber || null,
    cdlNumber: u.cdlNumber || null,
    licenseState: u.licenseState || null,
    licenseExpirationDttm: u.licenseExpirationDttm || null,
    status,
    isEnabled: status === 'ENABLED',
    userType: u.userType || null,
    roles,
    isDriver,
    startDate: u.startDate || null,
    city: u.city || null,
    state: u.state || null,
    lastUpdateDTTM: u.lastUpdateDTTM || null,
  };
}

// Pull the whole user list (~1 call). Deduped by userName so a server that ignores the
// `page` param can never inflate the roster; hard 10-page ceiling = 10 calls worst case.
async function fetchDriverRoster(pageSize = 500): Promise<{ users: any[]; totalUsers: number; totalRecords: number | null; pagesFetched: number }> {
  const reqr = getNuvizzRequester();
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), 'Content-Type': 'application/json', Accept: 'application/json' };
  const url = `${NUVIZZ_BASE}/user/list/${encodeURIComponent(companyCode)}`;
  const byUserName = new Map<string, any>();
  let totalRecords: number | null = null;
  let pagesFetched = 0;
  for (let page = 1; page <= 10; page++) {
    const body = JSON.stringify({
      pageInfo: { pageSize: 0, page, maxResult: pageSize },
      searchCriteria: { name: '', groupNames: ['-1'], vendorId: ['-1'], email: '', userRoles: ['-1'], status: '-1', companyId: '' },
    });
    const resp = await reqr.request(url, { method: 'POST', headers: hdr, body }, { route: '/user/list', tenant: companyCode, source: 'driver-roster', trigger: 'manual' });
    pagesFetched++;
    if (!resp.ok) throw new Error(`/user/list ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data: any = await resp.json();
    const batch: any[] = Array.isArray(data && data.users) ? data.users : [];
    if (typeof (data && data.totalRecords) === 'number') totalRecords = data.totalRecords;
    let added = 0;
    for (const u of batch) {
      const key = u && (u.userName || u.id || u.userId);
      if (key == null || byUserName.has(key)) continue;
      byUserName.set(key, u);
      added++;
    }
    if (added === 0) break;                                  // page repeated / exhausted
    if (batch.length < pageSize) break;                      // short page → last page
    if (totalRecords != null && byUserName.size >= totalRecords) break;
  }
  const users = Array.from(byUserName.values()).map(normalizeRosterUser);
  return { users, totalUsers: users.length, totalRecords, pagesFetched };
}

function summarize(users: any[]) {
  const drivers = users.filter((u) => u && u.isDriver);
  const enabled = drivers.filter((d) => d.isEnabled);
  return {
    drivers,
    driverCount: drivers.length,
    enabledDriverCount: enabled.length,
    disabledDriverCount: drivers.length - enabled.length,
    totalUsers: users.length,
  };
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  const url = new URL(req.url);
  const tenant = (url.searchParams.get('tenant') || TENANT).toLowerCase();
  const refresh = req.method === 'POST' || url.searchParams.get('refresh') === '1';

  try {
    // READ — serve the shared roster from Firestore. Zero NuVizz calls.
    if (!refresh) {
      const roster = isFirestoreEnabled() ? await readDriverRoster(tenant).catch(() => null) : null;
      if (!roster || !Array.isArray(roster.users)) {
        return new Response(JSON.stringify({ ok: true, source: 'cache', tenant, neverScanned: true, drivers: [], driverCount: 0, enabledDriverCount: 0, disabledDriverCount: 0, totalUsers: 0, updatedAt: null }), { status: 200, headers: cors });
      }
      return new Response(JSON.stringify({ ok: true, source: 'cache', tenant, ...summarize(roster.users), updatedAt: roster._updatedAt || null }), { status: 200, headers: cors });
    }

    // REFRESH — on-demand /user/list pull (~1 call), then persist the shared roster.
    if (!scansEnabled()) {
      return new Response(JSON.stringify({ ok: false, error: 'NUVIZZ_SCANS_ENABLED=false — roster refresh disabled' }), { status: 503, headers: cors });
    }
    setCallTrigger('manual');
    const { users, totalUsers, totalRecords, pagesFetched } = await fetchDriverRoster();

    // Clobber guard: a scan that returns zero users is almost certainly a transient hiccup —
    // don't overwrite a previously-good roster with nothing.
    if (totalUsers === 0) {
      return new Response(JSON.stringify({ ok: false, error: 'NuVizz returned no users — roster left unchanged', tenant, apiCalls: pagesFetched }), { status: 200, headers: cors });
    }

    const sum = summarize(users);
    const refreshedAt = new Date().toISOString();
    if (isFirestoreEnabled()) {
      try { await writeDriverRoster(tenant, { users, totalUsers, totalRecords, driverCount: sum.driverCount }); }
      catch (e: any) { console.error('writeDriverRoster failed:', e?.message); }
    }
    return new Response(JSON.stringify({ ok: true, source: 'live', tenant, ...sum, apiCalls: pagesFetched, refreshedAt }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'driver roster failed' }), { status: 502, headers: cors });
  }
};
