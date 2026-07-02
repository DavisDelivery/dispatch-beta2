// nuvizz-rebuild-customer-history-background.mts
//
// Rebuilds the per-customer history rollup (history_customers) FROM the immutable
// warehouse (history_days). Reads only our own Firestore — NEVER calls NuVizz.
// Used to backfill the rollup over already-captured days (the nightly snapshot
// keeps it current going forward; this seeds it for the past).
//
// Background fn (15-min budget) so a multi-day backfill can't hit the 30s cap.
//
// Manual trigger (cron only fires on PUBLISHED deploys; this has no schedule —
// run it on demand):
//   POST /.netlify/functions/nuvizz-rebuild-customer-history-background
//     ?date=YYYY-MM-DD                  → single day
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD    → inclusive range, processed oldest→newest
import { isFirestoreEnabled } from './lib/firestore.mts';
import { listStops } from './lib/history-store.mts';
import { updateCustomerRollupsForDay } from './lib/history-customers.mts';

const TENANT = 'davis';
const MAX_DAYS = 200;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resolveDates(url: URL): string[] {
  const one = url.searchParams.get('date');
  if (one) return [one];
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from && to) {
    const out: string[] = [];
    const d = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    while (d <= end && out.length < MAX_DAYS) {
      out.push(ymd(d));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }
  return [];
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  const dates = resolveDates(new URL(req.url));
  if (!dates.length) {
    return new Response(JSON.stringify({ ok: false, error: 'pass ?date=YYYY-MM-DD or ?from=&to=' }), { status: 400, headers });
  }
  const results: any[] = [];
  for (const date of dates) {
    const t0 = Date.now();
    try {
      const stops = await listStops(TENANT, date);
      const r = await updateCustomerRollupsForDay(TENANT, date, stops);
      results.push({ date, stops: stops.length, ...r, ms: Date.now() - t0 });
    } catch (e: any) {
      results.push({ date, ok: false, error: e?.message, ms: Date.now() - t0 });
    }
  }
  console.log('rebuild-customer-history:', JSON.stringify(results));
  return new Response(JSON.stringify({ ok: true, days: dates.length, results }), { status: 200, headers });
};
