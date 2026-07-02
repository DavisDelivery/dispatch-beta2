// lib/history-store.mts
//
// Thin Firestore access layer for the immutable history warehouse. It reuses the
// proven SA-JWT auth + value codecs from firestore.mts (getDoc/setDoc/listDocs are
// now exported there) so NONE of the service-account / token-cache logic is
// duplicated. This module only knows warehouse PATHS and bounded-concurrency
// upserts — it never prunes, mirroring the immutability invariant.
//
// Layout (date-partitioned, list-friendly — the same pattern nuvizz_stop_index uses):
//   history_days/{tenant}__{YYYY-MM-DD}                       ← manifest (written LAST)
//   history_days/{tenant}__{YYYY-MM-DD}/stops/{stopNbr}
//   history_days/{tenant}__{YYYY-MM-DD}/routes/{loadNbr}
//   history_days/{tenant}__{YYYY-MM-DD}/drivers/{driverKey}
//   history_days/{tenant}__{YYYY-MM-DD}/captures/v{n}         ← append-only audit
//   history_driver_days/{tenant}__{driverKey}/days/{YYYY-MM-DD} ← cross-day pointer

import { getDoc, setDoc, listDocs } from './firestore.mts';

export const HISTORY_COLLECTION = 'history_days';
export const DRIVER_DAYS_COLLECTION = 'history_driver_days';

export function dayId(tenant: string, date: string): string {
  return `${tenant}__${date}`;
}
export function dayPath(tenant: string, date: string): string {
  return `${HISTORY_COLLECTION}/${dayId(tenant, date)}`;
}

// ── manifest ─────────────────────────────────────────────────────────────────
export async function getManifest(tenant: string, date: string): Promise<any | null> {
  return getDoc(dayPath(tenant, date));
}
export async function setManifest(tenant: string, date: string, manifest: any): Promise<void> {
  await setDoc(dayPath(tenant, date), manifest);
}

// ── captures (append-only lineage) ───────────────────────────────────────────
export async function listCaptures(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${dayPath(tenant, date)}/captures`);
}
export async function appendCapture(tenant: string, date: string, version: number, audit: any): Promise<void> {
  await setDoc(`${dayPath(tenant, date)}/captures/v${version}`, audit);
}

// ── subcollection reads (used for verify-by-readback) ────────────────────────
export async function listStops(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${dayPath(tenant, date)}/stops`);
}
export async function listRoutes(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${dayPath(tenant, date)}/routes`);
}
export async function listDrivers(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${dayPath(tenant, date)}/drivers`);
}

// ── bounded-concurrency upserts (UPSERT only — never delete) ──────────────────
async function upsertAll<T>(items: T[], pathFn: (item: T) => string, conc = 12): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      await setDoc(pathFn(item), item as any);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, worker));
}

export async function upsertStops(tenant: string, date: string, records: any[]): Promise<void> {
  const base = dayPath(tenant, date);
  await upsertAll(records, (r) => `${base}/stops/${r.stopNbr}`);
}
export async function upsertRoutes(tenant: string, date: string, records: any[]): Promise<void> {
  const base = dayPath(tenant, date);
  await upsertAll(records, (r) => `${base}/routes/${r.loadNbr}`);
}
export async function upsertDrivers(tenant: string, date: string, records: any[]): Promise<void> {
  const base = dayPath(tenant, date);
  await upsertAll(records, (r) => `${base}/drivers/${r.driverKey}`);
}

// Cross-day driver index — listing history_driver_days/{tenant}__{driverKey}/days
// yields a driver's whole history cheaply (loads-by-driver without scanning days).
export async function upsertDriverDayPointer(tenant: string, driverKey: string, date: string, ptr: any): Promise<void> {
  await setDoc(`${DRIVER_DAYS_COLLECTION}/${tenant}__${driverKey}/days/${date}`, ptr);
}
export async function listDriverDays(tenant: string, driverKey: string): Promise<any[]> {
  return listDocs(`${DRIVER_DAYS_COLLECTION}/${tenant}__${driverKey}/days`);
}
