// nuvizz-attempts.mts  (Attempts — read endpoint for the driver scorecard)
//
// Fast, CORS-enabled read of the per-day attempts list written by the evening scan
// (nuvizz-att-scan-background). Returns instantly from Firestore — no NuVizz traffic.
// Consumed by the EXTERNAL driver-scorecard site (davis-driver-scorecard.netlify.app),
// so it sends a permissive Access-Control-Allow-Origin like the other read feeds.
//
// Query params:
//   date=YYYY-MM-DD   optional; defaults to today (ET). Browse history by passing a date.
//   driver=NAME       optional; filter to one driver (matches original driver
//                     userName OR name, case-insensitive substring).
//
// Response: { ok, date, generated, manifest, count, attempts[] }
//   attempts[] items: { stopNbr, shipmentNbr, originalDriverName, originalDriverUserName,
//                       originalLoadNbr, routeName, businessName, addr1, city, state, zip,
//                       currentStatus, currentlyUnplanned, matched, detectedAt }

import { isFirestoreEnabled, etDayString } from './lib/firestore.mts';
import { getAttemptsManifest, listAttemptItems, deleteAttemptItem } from './lib/attempts-store.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const url = new URL(req.url);
  const qDate = url.searchParams.get('date');
  const date = qDate && DATE_RE.test(qDate) ? qDate : etDayString();
  const driver = (url.searchParams.get('driver') || '').trim().toLowerCase();

  // ── delete a row ────────────────────────────────────────────────────────────
  // DELETE ?date=…&stopNbr=…   (the REST verb)         or, curl/browser-friendly,
  // POST   ?date=…&delete=…    (?delete=<stopNbr>).    Removes one item from the
  // day's attempts list and recomputes the manifest counts.
  const delStop = (req.method === 'DELETE'
    ? (url.searchParams.get('stopNbr') || url.searchParams.get('stop'))
    : (req.method === 'POST' ? url.searchParams.get('delete') : null)) || '';
  if (delStop) {
    if (!isFirestoreEnabled()) {
      return new Response(JSON.stringify({ ok: false, error: 'firestore-disabled' }), { status: 200, headers: cors });
    }
    try {
      const res = await deleteAttemptItem(TENANT, date, String(delStop).trim());
      return new Response(JSON.stringify({ ok: true, date, stopNbr: String(delStop).trim(), ...res }), {
        status: 200, headers: cors,
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, date, error: e?.message || 'delete failed' }), {
        status: 500, headers: cors,
      });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ ok: false, error: 'method not allowed (DELETE needs ?stopNbr=, POST needs ?delete=)' }), {
      status: 405, headers: cors,
    });
  }

  try {
    if (!isFirestoreEnabled()) {
      return new Response(JSON.stringify({
        ok: true, date, generated: new Date().toISOString(),
        manifest: null, count: 0, attempts: [], note: 'firestore-disabled',
      }), { status: 200, headers: cors });
    }

    const [manifest, items] = await Promise.all([
      getAttemptsManifest(TENANT, date),
      listAttemptItems(TENANT, date),
    ]);

    // Strip the internal _id; sort newest-detected first then by driver for a stable,
    // readable order. Optional driver filter for a per-driver scorecard view.
    let attempts = items
      .map(({ _id, ...rest }) => rest)
      .sort((a: any, b: any) =>
        String(b.detectedAt || '').localeCompare(String(a.detectedAt || '')) ||
        String(a.originalDriverName || '').localeCompare(String(b.originalDriverName || '')));
    if (driver) {
      attempts = attempts.filter((a: any) =>
        String(a.originalDriverUserName || '').toLowerCase().includes(driver) ||
        String(a.originalDriverName || '').toLowerCase().includes(driver));
    }

    return new Response(JSON.stringify({
      ok: true,
      date,
      generated: new Date().toISOString(),
      manifest: manifest || null,
      count: attempts.length,
      attempts,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, date, error: e?.message || 'error' }), {
      status: 500, headers: cors,
    });
  }
};
