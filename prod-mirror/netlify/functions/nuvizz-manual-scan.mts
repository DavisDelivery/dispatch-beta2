// nuvizz-manual-scan.mts
//
// SYNCHRONOUS on-demand scan for the manual "Scan now" button. Unlike the
// scheduled -background writer, this is a plain function the client can AWAIT and
// then repaint on completion. It runs runRefreshStops in manual mode:
//   - the client passes ?date=<viewed date>, so it does a FORCED single-date scan
//     of that date's LOADS + ORDERS (the explicit path). Scanning ONE date keeps
//     it inside the synchronous timeout — a full today+tomorrow manual descent
//     (loads + orders for both) can exceed it. (No ?date → full today+tomorrow.)
//   - BYPASSES the cadence gate and the per-date MIN_SCAN_INTERVAL_MS floor
//   - STILL HONORS the NUVIZZ_SCANS_ENABLED kill switch and the daily-ceiling breaker
//   - caps the unplanned descent lower (maxProbes 800) so it finishes in time

import { runRefreshStops } from './lib/refresh-stops-core.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  // Force manual mode regardless of how this was invoked.
  const url = new URL(req.url);
  url.searchParams.set('manual', '1');
  try {
    const resp = await runRefreshStops(new Request(url.toString(), { method: 'POST' }));
    const body = await resp.text();
    return new Response(body, { status: resp.status, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'manual scan failed' }), { status: 500, headers: cors });
  }
};
