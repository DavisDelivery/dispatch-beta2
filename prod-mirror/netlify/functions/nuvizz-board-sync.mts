// nuvizz-board-sync.mts
//
// ── Board write-through after a CONFIRMED live Save (issue #361) ─────────────
//
//   POST /.netlify/functions/nuvizz-board-sync
//   Body: { date: 'YYYY-MM-DD', routeName, orderedStopNbrs: [...],
//           unplannedStopNbrs?: [...], driverName? }
//   → { ok, patched, missing }
//
// The client calls this the moment a Save is CONFIRMED (the import engine's order
// read-back matched, or a classic save's steps all succeeded), then re-reads the cache —
// so the board agrees with NuVizz immediately instead of waiting out the next scheduled
// scan (and NuVizz's own list feed, which can lag an async import by minutes; the scan
// merge holds this write over a lagging list for a grace window — applyBoardWriteGrace).
//
// STRICTLY FIRESTORE-ONLY: this function makes ZERO NuVizz calls — it patches our own
// board cache with state the Save already verified against NuVizz.

import { patchBoardPlan, isFirestoreEnabled } from './lib/firestore.mts';
import { getCreds } from './lib/nuvizz-scan.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no board cache to sync' }, 200);

  let body: any;
  try { body = await req.json(); } catch { return J({ ok: false, error: 'invalid JSON' }, 400); }
  const date = String(body?.date ?? '');
  const routeName = String(body?.routeName ?? '').trim();
  const ordered = Array.isArray(body?.orderedStopNbrs) ? body.orderedStopNbrs.map((x: any) => String(x)).filter(Boolean) : [];
  const unplanned = Array.isArray(body?.unplannedStopNbrs) ? body.unplannedStopNbrs.map((x: any) => String(x)).filter(Boolean) : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return J({ ok: false, error: 'date (YYYY-MM-DD) required' }, 400);
  if (!routeName && ordered.length) return J({ ok: false, error: 'routeName required when planning stops' }, 400);
  if (!ordered.length && !unplanned.length) return J({ ok: false, error: 'nothing to sync' }, 400);
  if (ordered.length + unplanned.length > 500) return J({ ok: false, error: 'too many stops' }, 400);

  let tenant = 'DAVIS';
  try { tenant = getCreds().companyCode; } catch { /* default tenant */ }
  try {
    const r = await patchBoardPlan(tenant, date, {
      routeName, orderedStopNbrs: ordered, unplannedStopNbrs: unplanned,
      driverName: body?.driverName ? String(body.driverName) : null,
      at: new Date().toISOString(),
    });
    return J({ ok: true, ...r });
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'board sync failed' }, 500);
  }
};
