// nuvizz-loads-roster.mts
//
// Load roster for a given board date — the FULL list of that day's loads (route name,
// status, trip/stop count), INCLUDING empty loads created but not yet filled with orders.
// The stop-grouped Loads view can't show an empty load (it has no stops to group), so the
// dispatcher couldn't see e.g. Monday's empty loads waiting for orders. This surfaces them.
//
// SOURCE PREFERENCE:
//   1. The cached roster the background scanner persists per date (incl. the next business
//      day, captured ONCE — next-day loads are static). Instant, zero NuVizz calls.
//   2. Fallback: one live PkgRoute filterdata call (the portal's "Loads" grid,
//      customListDefId 35833), which is then cached so the next read is free.
//   ?live=1 forces the live pull (and refreshes the cache) — for an explicit "refresh".
//
// Best-effort: an error returns ok:false and the UI just shows the stop-grouped loads it
// already has. Creds stay server-side.
//
//   GET ?date=YYYY-MM-DD [&live=1]  → { ok, date, source, at, count, loads:[{loadId,name,status,trips}] }
import { loadRosterForDate } from './lib/nuvizz-loads.mts';
import { isFirestoreEnabled, readLoadRoster, writeLoadRoster } from './lib/firestore.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || '';
  const live = url.searchParams.get('live') === '1';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ ok: false, reason: 'missing or bad date (YYYY-MM-DD)' }), { status: 400, headers: cors });
  }
  try {
    // 1) Cached roster (scanner-persisted) — instant, no NuVizz call. Skipped on ?live=1.
    if (!live && isFirestoreEnabled()) {
      const cached = await readLoadRoster(TENANT, date).catch(() => null);
      if (cached && cached.loads.length) {
        return new Response(JSON.stringify({ ok: true, date, source: 'cache', at: cached.at, count: cached.loads.length, loads: cached.loads }), { status: 200, headers: cors });
      }
    }
    // 2) Live fetch — one deliberate call — then cache it so the next read is free.
    const loads = await loadRosterForDate(date);
    const at = new Date().toISOString();
    if (isFirestoreEnabled()) { try { await writeLoadRoster(TENANT, date, loads, at); } catch { /* cache best-effort */ } }
    return new Response(JSON.stringify({ ok: true, date, source: 'live', at, count: loads.length, loads }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'roster failed' }), { status: 502, headers: cors });
  }
};
