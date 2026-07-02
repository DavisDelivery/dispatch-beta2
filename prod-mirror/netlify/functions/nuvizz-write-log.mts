// nuvizz-write-log.mts
//
// ── Read-only forensics for live writes ──────────────────────────────────────
//
//   GET /.netlify/functions/nuvizz-write-log?limit=5
//   → { ok, count, ops: [{ clientOpId, op, status, at, result }...] }   (newest first)
//
// Returns the last N rows of the write op ledger (nuvizz_write_ops — one row per Save,
// including each import's sentHeader/sentStopNbrs, NuVizz's verbatim ack, and every
// convergence read-back). This is how a "Save said SUCCESS but nothing landed" gets
// diagnosed without guessing.
//
// STRICTLY FIRESTORE-ONLY: this function makes ZERO NuVizz calls — it reads our own
// journal. Safe to hit any time; costs nothing against the NuVizz ceiling.

import { listDocs, isFirestoreEnabled } from './lib/firestore.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'GET') return J({ ok: false, error: 'GET only' }, 405);
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no write journal available' }, 200);

  const url = new URL(req.url);
  const limit = Math.min(25, Math.max(1, Number(url.searchParams.get('limit')) || 5));
  try {
    const all = ((await listDocs('nuvizz_write_ops')) as any[]) || [];
    const ops = all
      .filter((o) => o && o.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, limit);
    return J({ ok: true, count: ops.length, ops });
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'journal read failed' }, 500);
  }
};
