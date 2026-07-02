// freight-class-report.mts
//
// Read-only freight-class / density export, computed ENTIRELY from the Firestore
// history warehouse — no NuVizz (or any other) API calls. One row per shipment
// (stop), carrying the PRO(s) so the output joins straight back to a rate
// generator, plus the density inputs (weight, cube, dims coverage) and the
// derived density-based freight class.
//
//   GET /.netlify/functions/freight-class-report
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD   inclusive date range (history day partitions)
//     ?days=N                          alt: last N days (ET) when from/to omitted (default 90)
//     ?tenant=CODE                     optional filter (else every tenant in range)
//     ?stackHeightIn=60                assumed loaded-pallet height for the cube fallback
//     ?format=csv|json                 default csv (downloads as a file)
//
// Source: history_days/{tenant}__{date}/stops/{stopNbr}, where each doc is the full
// normalized stop (incl. stopDetails L×W×H + weight). See lib/history-store.mts.

import { isFirestoreEnabled, listDocs, etDayString } from './lib/firestore.mts';
import { HISTORY_COLLECTION } from './lib/history-store.mts';
import { deriveShipmentFreight } from './lib/freight-class.mts';

const MAX_DAYS = 400;     // safety bound on the scan span
const DAY_CONCURRENCY = 6;

const COLUMNS = [
  'date', 'tenant', 'load_nbr', 'stop_nbr', 'primary_pro', 'pros', 'pro_count',
  'business_name', 'customer_account', 'city', 'state', 'zip', 'driver_name',
  'status', 'delivered_dttm',
  'pallets', 'cartons', 'weight_lb', 'lb_per_pallet',
  'lines', 'lines_with_full_dims', 'dims_coverage', 'skus', 'products',
  'cube_ft3_dims', 'cube_ft3_pallet_est', 'cube_ft3_used', 'cube_source',
  'density_pcf', 'freight_class', 'oversize', 'has_long_cat',
];

function csvCell(v: any): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= end && i < MAX_DAYS; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set (Firestore unavailable in this environment)' }), { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const url = new URL(req.url);
  const format = (url.searchParams.get('format') || 'csv').toLowerCase();
  const tenantFilter = url.searchParams.get('tenant') || null;
  const stackHeightIn = Number(url.searchParams.get('stackHeightIn')) || 60;

  let from = url.searchParams.get('from');
  let to = url.searchParams.get('to');
  if (!from || !to) {
    const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 90));
    to = to || etDayString();
    const start = new Date(`${to}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - (days - 1));
    from = from || start.toISOString().slice(0, 10);
  }
  const wantDates = new Set(daysBetween(from, to));

  try {
    // 1) Discover which day partitions actually exist (manifests), filtered to range.
    const manifests = await listDocs(HISTORY_COLLECTION);
    const partitions = manifests
      .map((m: any) => {
        const id = String(m?._id || '');
        const sep = id.indexOf('__');
        if (sep < 0) return null;
        return { tenant: id.slice(0, sep), date: id.slice(sep + 2) };
      })
      .filter((p): p is { tenant: string; date: string } => !!p && wantDates.has(p.date) && (!tenantFilter || p.tenant === tenantFilter))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // 2) Read each partition's stops (bounded concurrency) and emit one row per stop.
    const rows: string[] = [];
    let shipments = 0, withFullDims = 0, withClass = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < partitions.length) {
        const { tenant, date } = partitions[idx++];
        let stops: any[] = [];
        try { stops = await listDocs(`${HISTORY_COLLECTION}/${tenant}__${date}/stops`); } catch { stops = []; }
        for (const s of stops) {
          const f = deriveShipmentFreight(s, { stackHeightIn });
          shipments++;
          if (f.dimsCoverage === 'full') withFullDims++;
          if (f.freightClass != null) withClass++;
          const pros: string[] = Array.isArray(s?.pros) ? s.pros : [];
          const rec: Record<string, any> = {
            date, tenant,
            load_nbr: s?.loadNbr ?? s?.load?.loadNbr ?? null,
            stop_nbr: s?.stopNbr ?? null,
            primary_pro: s?.primaryPro ?? pros[0] ?? null,
            pros: pros.join(';'),
            pro_count: s?.proCount ?? pros.length,
            business_name: s?.businessName ?? null,
            customer_account: s?.customerAccount ?? null,
            city: s?.city ?? null, state: s?.state ?? null, zip: s?.zip ?? null,
            driver_name: s?.driverName ?? null,
            status: s?.normalizedStatus ?? s?.executed?.stopStatus ?? s?.status ?? null,
            delivered_dttm: s?.executed?.deliveredDTTM ?? s?.deliveredDTTM ?? null,
            pallets: f.pallets, cartons: f.cartons, weight_lb: f.weightLb, lb_per_pallet: f.lbPerPallet,
            lines: f.lines, lines_with_full_dims: f.linesWithFullDims, dims_coverage: f.dimsCoverage,
            skus: f.skus.join(';'), products: f.products.slice(0, 12).join(' | '),
            cube_ft3_dims: f.cubeFt3Dims, cube_ft3_pallet_est: f.cubeFt3PalletEst,
            cube_ft3_used: f.cubeFt3Used, cube_source: f.cubeSource,
            density_pcf: f.densityPcf, freight_class: f.freightClass,
            oversize: f.oversize ? 1 : 0, has_long_cat: f.hasLongCat ? 1 : 0,
          };
          rows.push(COLUMNS.map((c) => csvCell(rec[c])).join(','));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DAY_CONCURRENCY, partitions.length || 1) }, worker));

    if (format === 'json') {
      return new Response(JSON.stringify({
        ok: true, from, to, partitions: partitions.length, shipments,
        coverage: { full_dims: withFullDims, with_class: withClass },
        columns: COLUMNS,
      }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const csv = [COLUMNS.join(','), ...rows].join('\n') + '\n';
    return new Response(csv, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="freight-class-report_${from}_to_${to}.csv"`,
        'X-Report-Shipments': String(shipments),
        'X-Report-Full-Dims': String(withFullDims),
        'X-Report-With-Class': String(withClass),
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'report failed' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
