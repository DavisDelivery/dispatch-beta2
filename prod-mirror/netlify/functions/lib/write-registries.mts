// lib/write-registries.mts
//
// ── Local state for the live-write path (Firestore, best-effort) ─────────────
//
// The write ops mutate NuVizz; these registries are OUR record of what we did, so the
// board has an audit trail without re-reading NuVizz:
//   nuvizz_write_orders/{tenant}__{key}        — orders we created (createStop)
//   nuvizz_write_assignments/{tenant}__{key}   — load→driver assignments we set
//   nuvizz_write_ops/{tenant}__{clientOpId}    — idempotency ledger (one row per Save)
//
// All writes are BEST-EFFORT: when Firestore is off they no-op, so a live write still
// works (it just isn't journaled, and idempotency is a no-op for that request). Mirrors
// routing-store.mts (getDoc/setDoc/listDocs, no auth duplication). Keys are tenant-scoped.

import { getDoc, setDoc, listDocs, isFirestoreEnabled, etDayString } from './firestore.mts';

const ORDERS = 'nuvizz_write_orders';
const ASSIGNMENTS = 'nuvizz_write_assignments';
const OPS = 'nuvizz_write_ops';

const safeKey = (s: any) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);

export type OpStatus = 'pending' | 'succeeded' | 'failed';

export interface OpRecord {
  clientOpId: string;
  op: string;
  status: OpStatus;
  result?: any;
  tenant: string;
  at: string;
}

// ── Idempotency ledger ───────────────────────────────────────────────────────

/** Look up a prior Save by its clientOpId. Returns null when absent or Firestore off. */
export async function getOpRecord(tenant: string, clientOpId: string): Promise<OpRecord | null> {
  if (!isFirestoreEnabled() || !clientOpId) return null;
  try { return (await getDoc(`${OPS}/${safeKey(tenant)}__${safeKey(clientOpId)}`)) as OpRecord | null; }
  catch { return null; }
}

/** The ONE dedup decision (convergence-audit directive): only a prior SUCCEEDED record
 *  short-circuits a repeat. A 'failed' or 'pending' prior (e.g. an import Save handed to the
 *  client verifier as pending) must NEVER swallow a re-send — the convergence recipe depends
 *  on the repeat reaching the wire. (Escalation re-Saves also carry a FRESH clientOpId, and
 *  in-invocation resends bypass the handler entirely — this guard is the last belt.) */
export function priorShortCircuits(prior: OpRecord | null): boolean {
  return prior?.status === 'succeeded';
}

/** Persist (create or update) a Save's outcome. No-op when Firestore is off. */
export async function putOpRecord(rec: OpRecord): Promise<void> {
  if (!isFirestoreEnabled() || !rec.clientOpId) return;
  try { await setDoc(`${OPS}/${safeKey(rec.tenant)}__${safeKey(rec.clientOpId)}`, { ...rec, at: rec.at || new Date().toISOString() }); }
  catch { /* best-effort journal */ }
}

// ── Created-orders registry ──────────────────────────────────────────────────

export interface CreatedOrder {
  tenant: string;
  stopNbr?: string | null;
  stopId?: string | null;
  loadNbr?: string | null;
  status: OpStatus;
  createdBy?: string | null;
  createdAt: string;
  clientOpId?: string | null;
  nuvizzResponse?: any;
  error?: string | null;
}

export async function recordCreatedOrder(o: CreatedOrder): Promise<void> {
  if (!isFirestoreEnabled()) return;
  const key = safeKey(o.clientOpId || o.stopId || o.stopNbr || `${etDayString()}_${Date.now()}`);
  try { await setDoc(`${ORDERS}/${safeKey(o.tenant)}__${key}`, { ...o, createdAt: o.createdAt || new Date().toISOString() }); }
  catch { /* best-effort */ }
}

export async function listCreatedOrders(tenant: string): Promise<CreatedOrder[]> {
  if (!isFirestoreEnabled()) return [];
  try { return ((await listDocs(ORDERS)) as CreatedOrder[]).filter((o) => o?.tenant === tenant); }
  catch { return []; }
}

// ── Load→driver assignments ──────────────────────────────────────────────────

export interface Assignment {
  tenant: string;
  date: string;            // ET board day
  loadNbr: string;
  loadId?: string | null;
  driverId?: any;
  driverName?: string | null;
  status: 'assigned' | 'dispatched' | 'failed';
  assignedAt?: string | null;
  dispatchedAt?: string | null;
}

export async function recordAssignment(a: Assignment): Promise<void> {
  if (!isFirestoreEnabled()) return;
  const key = `${safeKey(a.tenant)}__${safeKey(a.date)}__${safeKey(a.loadNbr)}`;
  try {
    const cur = ((await getDoc(`${ASSIGNMENTS}/${key}`)) as Assignment | null) || null;
    await setDoc(`${ASSIGNMENTS}/${key}`, { ...(cur || {}), ...a });
  } catch { /* best-effort */ }
}

export async function listAssignments(tenant: string, date: string): Promise<Assignment[]> {
  if (!isFirestoreEnabled()) return [];
  try { return ((await listDocs(ASSIGNMENTS)) as Assignment[]).filter((a) => a?.tenant === tenant && a?.date === date); }
  catch { return []; }
}
