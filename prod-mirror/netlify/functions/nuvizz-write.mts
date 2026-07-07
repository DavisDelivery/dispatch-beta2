// nuvizz-write.mts
//
// ── The ONE live-write endpoint (op-envelope) ────────────────────────────────
//
//   POST /.netlify/functions/nuvizz-write
//   Body: { op, payload, dryRun?, clientOpId?, createdBy? }
//   → { ok, op, tenant, live, dryRun, result, ops:{current,ceiling}, error? }
//
// This is the single chokepoint for every NuVizz WRITE, so all the safety lives in one
// auditable place (mirrors send-sms.mts: validate → guard → side-effect → {ok,…}).
//
// SAFETY MODEL (matches the agreed design — writes to DAVIS *production*):
//   • dryRun:true  → NEVER calls NuVizz. Returns the plan of what WOULD fire. Always
//                    allowed (this is what the Compare panel uses in Beta mode and while
//                    you build/reorder — nothing fires until you Save in Live mode).
//   • Mutating ops (create/insert/remove/assign/dispatch/commit) require the server-side
//     kill switch  NUVIZZ_WRITE_ENABLED=true  — OFF by default, so nothing can fire until
//     it is deliberately set. This is the hard cutoff behind the UI's Beta/Live toggle.
//   • Idempotency: a Save carries a clientOpId; a repeat returns the prior success
//     without re-firing (no duplicate orders/assignments on a retry).
//   • Pre-flight budget: refuse to start a write once the day's NuVizz call count is at
//     the ceiling (the breaker is monitor-mode by default and won't block on its own).
//   • Every call routes through getNuvizzRequester() (counted, breaker-guarded, POSTs not
//     deduped) — enforced fleet-wide by test/no-direct-nuvizz-fetch.test.mjs.
//   • The response always reports `tenant` + `live` so the UI banner shows PROD vs the
//     write-enabled state. No NuVizz creds ever reach the browser (this fn is the proxy).

import { WRITE_OPS, MUTATING_OPS, type WriteOp } from './lib/nuvizz-write-ops.mts';
import { runOp, resolveWriteCreds, loadImportBlocked } from './lib/nuvizz-write.mts';
import { rwbEngineBlocked } from './lib/nuvizz-rwb.mts';
import { getNuvizzRequester, setCallTrigger, effectiveDailyCeiling, NuvizzCircuitOpenError } from './lib/nuvizz-request.mts';
import { isFirestoreEnabled, getDoc, etDayString } from './lib/firestore.mts';
import { getOpRecord, putOpRecord, priorShortCircuits, recordCreatedOrder, recordAssignment } from './lib/write-registries.mts';

function writeEnabled(): boolean {
  return String(process.env.NUVIZZ_WRITE_ENABLED ?? '').trim().toLowerCase() === 'true';
}

async function opsSnapshot(): Promise<{ current: number; ceiling: number }> {
  const ceiling = effectiveDailyCeiling();
  let current = 0;
  if (isFirestoreEnabled()) {
    try { const d = (await getDoc(`nuvizz_ops/calls__${etDayString()}`)) as any; current = Number(d?.count) || 0; } catch { /* treat as 0 */ }
  }
  return { current, ceiling };
}

// A human-readable plan of what a (non-dry) call WOULD fire — used for the dry-run echo
// the Compare panel shows before you commit. Pure; no NuVizz calls.
function planFor(op: WriteOp, payload: any): string[] {
  if (op === 'commitBoard') {
    const loads: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
    if (!loads.length) return ['(no loads to commit)'];
    return loads.map((L) => {
      const ordered = Array.isArray(L?.orderedStopNbrs) ? L.orderedStopNbrs : (Array.isArray(L?.orderedStopIds) ? L.orderedStopIds : []);
      const rm = Array.isArray(L?.removeStopNbrs) ? L.removeStopNbrs.length : (Array.isArray(L?.removeStopIds) ? L.removeStopIds.length : 0);
      const bits: string[] = [];
      const inline = Array.isArray(L?.newStops) ? L.newStops.length : 0;
      if (L?.emptyLoad || (ordered.length === 0 && rm > 0)) {
        bits.push('EMPTY the load — remove ALL orders and CANCEL the route');
      } else {
        if (rm) bits.push(`unplan ${rm} order(s) (remove from route)`);
        // The Confirm modal tells you WHICH engine will fire — the classic anchor engine, the
        // async import + convergence reads, or (when the panel's engine toggle sent useRwb) the
        // 2-call SYNCHRONOUS Route Workbench sequence.
        if (ordered.length) bits.push(payload?.useRwb === true && !rwbEngineBlocked()
          ? `set ${ordered.length} stop(s) in order (RWB ENGINE: not-yet-planned orders are first planned with insertStops — real records, never cloned — then a 2-call SYNCHRONOUS Route Workbench sequence, references stops by id only, no async wait)`
          : payload?.useImport === true && !loadImportBlocked()
            ? `set ${ordered.length} stop(s) in order (TWO-LEVER IMPORT ENGINE: not-yet-planned orders are first planned with insertStops — real records, never cloned — then ONE full-echo ordering import + convergence read-backs)`
            : `set ${ordered.length} stop(s) in order (anchor remove + one-at-a-time insert)`);
        // Inline creation (item A, existence-gated since Jul 2): the import itself creates them.
        if (inline) bits.push(`create ${inline} NEW order(s) INLINE in the import (each order # first verified ABSENT in NuVizz — a collision is refused, never cloned)`);
      }
      if (L?.driverId != null && String(L?.driverId).trim() !== '') bits.push(`assign ${L?.driverName || L?.driverId}`);
      if (L?.dispatch) bits.push('dispatch');
      return `Load ${L?.routeName ?? L?.loadNbr ?? L?.loadId ?? '?'}: ${bits.length ? bits.join(' · ') : '(no change)'}`;
    });
  }
  if (op === 'commitLoad') {
    const steps: string[] = [];
    const rm = Array.isArray(payload?.removeStopIds) ? payload.removeStopIds.length : 0;
    const ins = Array.isArray(payload?.insertStopIds) ? payload.insertStopIds.length : 0;
    if (rm) steps.push(`remove ${rm} stop(s) from load ${payload?.loadNbr ?? '?'} (load/edit)`);
    if (ins) steps.push(`plan ${ins} stop(s) onto load ${payload?.loadNbr ?? '?'} (load/insertstops)`);
    if (payload?.driverId != null && payload?.driverId !== '') steps.push(`assign driver ${payload?.driverName || payload?.driverId} (load/assignanddispatch ASSIGN_DISPATCH)`);
    if (payload?.dispatch) steps.push(`dispatch load ${payload?.loadNbr ?? '?'} (load/assignanddispatch DISPATCH)`);
    return steps.length ? steps : ['(no changes to commit)'];
  }
  if (op === 'importLoad' || op === 'commitImport') {
    const loads: any[] = op === 'importLoad'
      ? (payload?.load ? [payload.load] : [])
      : (Array.isArray(payload?.loads) ? payload.loads : []);
    if (!loads.length) return ['(no loads to import)'];
    const gate = 'NUVIZZ_LOAD_IMPORT'; // shown so the dry run tells you the path is double-gated
    return loads.map((L) => {
      const n = Array.isArray(L?.stops) ? L.stops.length : 0;
      return `Load ${L?.loadHeader?.routeName ?? L?.loadHeader?.loadNbr ?? '?'}: IMPORT ${n} stop(s) in exact array order (async load/update/default + convergence read-backs; gated by ${gate})`;
    });
  }
  return [`${op} → 1 NuVizz call`];
}

async function journal(op: WriteOp, payload: any, result: any, tenant: string, clientOpId: string | null, createdBy: string | null): Promise<void> {
  const date = String(payload?.date || etDayString());
  try {
    if (op === 'createStop' && result?.ok) {
      await recordCreatedOrder({ tenant, stopNbr: result.entityNbr, stopId: result.entityId, loadNbr: payload?.loadNbr ?? null, status: 'succeeded', createdBy, createdAt: new Date().toISOString(), clientOpId, nuvizzResponse: result });
    }
    if ((op === 'assignDriver' || op === 'commitLoad') && payload?.driverId != null && payload?.driverId !== '') {
      await recordAssignment({ tenant, date, loadNbr: String(payload?.loadNbr ?? ''), loadId: payload?.loadId ?? result?.loadId ?? null, driverId: payload?.driverId, driverName: payload?.driverName ?? null, status: result?.ok ? 'assigned' : 'failed', assignedAt: new Date().toISOString() });
    }
    if ((op === 'dispatchLoad' || (op === 'commitLoad' && payload?.dispatch)) && result?.ok) {
      await recordAssignment({ tenant, date, loadNbr: String(payload?.loadNbr ?? ''), loadId: payload?.loadId ?? result?.loadId ?? null, status: 'dispatched', dispatchedAt: new Date().toISOString() });
    }
    if (op === 'commitBoard') {
      const reqLoads: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
      const resLoads: any[] = Array.isArray(result?.loads) ? result.loads : [];
      for (const L of reqLoads) {
        // Join by loadId FIRST: a loadId-only card sends no loadNbr while the result carries the
        // server-resolved number, so a name-only join records every assignment as 'failed'.
        const res = resLoads.find((r) => (L?.loadId != null && r?.loadId != null && String(r.loadId) === String(L.loadId))
          || (L?.loadNbr != null && String(r?.loadNbr ?? '') === String(L.loadNbr))) || {};
        if (L?.driverId != null && String(L?.driverId).trim() !== '') {
          await recordAssignment({ tenant, date, loadNbr: String(L?.loadNbr ?? ''), loadId: L?.loadId ?? res?.loadId ?? null, driverId: L.driverId, driverName: L?.driverName ?? null, status: res?.ok ? 'assigned' : 'failed', assignedAt: new Date().toISOString() });
        }
        if (L?.dispatch && res?.ok) {
          await recordAssignment({ tenant, date, loadNbr: String(L?.loadNbr ?? ''), loadId: L?.loadId ?? res?.loadId ?? null, status: 'dispatched', dispatchedAt: new Date().toISOString() });
        }
      }
    }
  } catch { /* journaling is best-effort */ }
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return J({ ok: false, error: 'invalid JSON' }, 400); }

  const op = String(body?.op ?? '') as WriteOp;
  if (!WRITE_OPS.includes(op)) return J({ ok: false, error: `unknown op '${body?.op}'`, allowed: WRITE_OPS }, 400);
  const payload = body?.payload ?? {};
  const dryRun = body?.dryRun === true;
  const clientOpId = body?.clientOpId ? String(body.clientOpId) : null;
  const createdBy = body?.createdBy ? String(body.createdBy) : null;

  // Resolve tenant for the response banner even on the early-return paths.
  let tenant = 'DAVIS';
  try { tenant = resolveWriteCreds().companyCode; } catch { /* creds resolved again below */ }
  const live = writeEnabled();
  const ops = await opsSnapshot();

  // 1) DRY RUN — never touches NuVizz. The Compare panel's default mode + Beta mode.
  if (dryRun) return J({ ok: true, op, tenant, live, dryRun: true, plan: planFor(op, payload), ops });

  // 2) Mutating ops require the server-side kill switch.
  if (MUTATING_OPS.has(op) && !live) {
    return J({ ok: false, op, tenant, live: false, dryRun: false, error: 'live writes disabled — set NUVIZZ_WRITE_ENABLED=true to enable', ops }, 403);
  }

  // 3) Creds must be present (basicAuthHeader throws if not) — fail clearly, no NuVizz call.
  let creds;
  try { creds = resolveWriteCreds(); }
  catch (e: any) { return J({ ok: false, op, tenant, error: e?.message || 'missing NuVizz creds', ops }, 500); }
  tenant = creds.companyCode;

  // 4) Idempotency — a repeated Save returns the prior success without re-firing. NOTE: the
  // ledger lives in Firestore; when Firestore is off it silently no-ops, so a retry CAN re-fire.
  // Warn loudly so an operator relying on dedup isn't unknowingly unprotected. (Truly-concurrent
  // identical Saves are also not deduped — only sequential retries; the UI's busy-disable + a
  // single clientOpId per Save cover the common case.)
  if (MUTATING_OPS.has(op) && clientOpId) {
    if (!isFirestoreEnabled()) console.warn(`[nuvizz-write] clientOpId supplied but Firestore is off — idempotency unavailable; a retry of op=${op} can re-fire.`);
    const prior = await getOpRecord(tenant, clientOpId);
    if (priorShortCircuits(prior)) return J({ ok: true, op, tenant, live, dryRun: false, idempotent: true, result: prior!.result, ops });
  }

  // 5) Pre-flight budget — refuse to start at/over the ceiling (breaker is monitor by default).
  if (ops.current >= ops.ceiling) {
    return J({ ok: false, op, tenant, live, error: `daily NuVizz call ceiling reached (${ops.current}/${ops.ceiling}) — write refused`, ops }, 429);
  }

  // 6) Fire. Attribute the spike distinctly so Diagnostics shows live-write volume.
  setCallTrigger('live-write');
  let result: any;
  try {
    result = await runOp(getNuvizzRequester(), op, payload, creds);
  } catch (e: any) {
    if (e instanceof NuvizzCircuitOpenError) return J({ ok: false, op, tenant, live, error: 'NuVizz circuit breaker open — write refused', ops: await opsSnapshot() }, 503);
    // A builder threw → malformed payload (missing required field) → 400.
    return J({ ok: false, op, tenant, live, error: e?.message || 'write failed', ops: await opsSnapshot() }, 400);
  }

  // 7) Journal (best-effort) + idempotency ledger.
  if (MUTATING_OPS.has(op)) {
    await journal(op, payload, result, tenant, clientOpId, createdBy);
    if (clientOpId) await putOpRecord({ clientOpId, op, status: result?.ok ? 'succeeded' : 'failed', result, tenant, at: new Date().toISOString() });
  }

  return J({ ok: !!result?.ok, op, tenant, live, dryRun: false, result, ops: await opsSnapshot() }, result?.ok ? 200 : 502);
};
