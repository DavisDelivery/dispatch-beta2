// src/lib/nuvizzWrite.js
//
// Browser write-client for the live-write endpoint. The browser NEVER holds NuVizz
// creds — it POSTs an {op,payload} envelope to /.netlify/functions/nuvizz-write, which
// adds Basic auth server-side and forwards to NuVizz. Mirrors the rest of the app's
// fetch() convention (cache:'no-store', JSON in/out).
//
// SAFETY: pass { dryRun:true } and NOTHING fires to NuVizz — the endpoint returns the
// plan of what WOULD happen. This is what the Compare panel uses in Beta mode and while
// you build/reorder; a real write only happens on Save in Live mode (and only if the
// server-side NUVIZZ_WRITE_ENABLED flag is set). A clientOpId makes a Save idempotent.

const WRITE_FN = '/.netlify/functions/nuvizz-write';

export async function callWrite(op, payload = {}, opts = {}) {
  const { dryRun = false, clientOpId, createdBy } = opts;
  let res;
  try {
    res = await fetch(WRITE_FN, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, payload, dryRun, clientOpId, createdBy }),
    });
  } catch (e) {
    return { ok: false, error: `network error: ${e?.message || e}` };
  }
  let j;
  try { j = await res.json(); } catch { j = { ok: false, error: `bad response (${res.status})` }; }
  if (typeof j.ok !== 'boolean') j.ok = res.ok;
  j.httpStatus = res.status;
  return j;
}

// Convenience wrappers (thin — all of these go through callWrite).
export const previewCommit = (payload, opts = {}) => callWrite('commitLoad', payload, { ...opts, dryRun: true });
export const commitLoad = (payload, opts = {}) => callWrite('commitLoad', payload, { ...opts, dryRun: false });
export const fetchRoster = (opts = {}) => callWrite('roster', {}, { ...opts, dryRun: false });

// Stable id so a Save can be retried without creating duplicate orders/assignments.
export function newClientOpId() {
  try { if (globalThis.crypto?.randomUUID) return `op_${globalThis.crypto.randomUUID()}`; } catch { /* fall through */ }
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
