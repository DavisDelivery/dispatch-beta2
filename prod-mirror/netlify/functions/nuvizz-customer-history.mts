// nuvizz-customer-history.mts
//
// Read-only history search for the mobile "search past PROs / customer history"
// button. Reads OUR OWN per-customer rollup (history_customers, built nightly
// from the immutable warehouse) — it NEVER calls NuVizz. So a business-name
// search costs nothing at NuVizz; it's a single indexed Firestore lookup.
//
//   GET ?name=<business name>   → customers whose name starts with the query,
//                                 each with their last 20 {pro,date}
//   GET ?pro=<pro number>       → customers whose saved history contains that PRO
//                                 (numeric PROs are matched zero-padded to 9 too)
import { isFirestoreEnabled } from './lib/firestore.mts';
import { queryCustomersByName, queryCustomersByPro } from './lib/history-customers.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, reason: 'history_unavailable', customers: [] }), { status: 200, headers: cors });
  }
  const url = new URL(req.url);
  const name = (url.searchParams.get('name') || '').trim();
  const pro = (url.searchParams.get('pro') || '').trim();
  try {
    if (name) {
      const customers = await queryCustomersByName(name, 25);
      return new Response(JSON.stringify({ ok: true, mode: 'name', customers }), { status: 200, headers: cors });
    }
    if (pro) {
      // Match both the raw token and the zero-padded-to-9 form NuVizz stores for
      // numeric PROs, then de-dupe by customer.
      const candidates = new Set<string>([pro]);
      if (/^[0-9]+$/.test(pro)) candidates.add(pro.padStart(9, '0'));
      const seen = new Set<string>();
      const customers: any[] = [];
      for (const c of candidates) {
        for (const row of await queryCustomersByPro(c, 25)) {
          const key = row.matchKey || row.name;
          if (seen.has(key)) continue;
          seen.add(key);
          customers.push(row);
        }
      }
      return new Response(JSON.stringify({ ok: true, mode: 'pro', customers }), { status: 200, headers: cors });
    }
    return new Response(JSON.stringify({ ok: false, reason: 'missing name or pro', customers: [] }), { status: 400, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'search failed', customers: [] }), { status: 500, headers: cors });
  }
};
