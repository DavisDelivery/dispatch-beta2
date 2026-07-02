// lib/attempts-store.mts
//
// Thin Firestore access layer for the delivery-ATTEMPTS feature. Reuses the proven
// SA-JWT auth + value codecs from firestore.mts (getDoc/setDoc/listDocs) — no auth
// or token-cache logic is duplicated here. This module only knows attempt PATHS and
// bounded-concurrency upserts.
//
// Two date-partitioned collections (same {tenant}__{YYYY-MM-DD} pattern the history
// warehouse + live stop index use, so a day is one cheap subcollection list):
//
//   att_plan/{tenant}__{YYYY-MM-DD}                    ← plan-snapshot meta
//   att_plan/{tenant}__{YYYY-MM-DD}/stops/{stopNbr}    ← the 8:30am routed freeze:
//                                                         one doc per planned stop,
//                                                         stopNbr → driver/load/route
//
//   attempts/{tenant}__{YYYY-MM-DD}                    ← attempts-list manifest
//   attempts/{tenant}__{YYYY-MM-DD}/items/{stopNbr}    ← the 8pm result: one doc per
//                                                         detected attempt, joined back
//                                                         to the morning driver
//
// stopNbr is the stable join key between the two (an ATT prefix lands on shipmentNbr,
// never on stopNbr — see lib/nuvizz-scan.mts isAttemptShipment).

import { getDoc, setDoc, listDocs, deleteDoc } from './firestore.mts';

export const PLAN_COLLECTION = 'att_plan';
export const ATTEMPTS_COLLECTION = 'attempts';

export function dayId(tenant: string, date: string): string {
  return `${tenant}__${date}`;
}
export function planPath(tenant: string, date: string): string {
  return `${PLAN_COLLECTION}/${dayId(tenant, date)}`;
}
export function attemptsPath(tenant: string, date: string): string {
  return `${ATTEMPTS_COLLECTION}/${dayId(tenant, date)}`;
}

// ── bounded-concurrency upsert (UPSERT only — never delete) ───────────────────
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

// ── plan snapshot (8:30am routed freeze) ──────────────────────────────────────
export async function getPlanMeta(tenant: string, date: string): Promise<any | null> {
  return getDoc(planPath(tenant, date));
}
export async function setPlanMeta(tenant: string, date: string, meta: any): Promise<void> {
  await setDoc(planPath(tenant, date), meta);
}
export async function listPlanStops(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${planPath(tenant, date)}/stops`);
}
export async function upsertPlanStops(tenant: string, date: string, records: any[]): Promise<void> {
  const base = planPath(tenant, date);
  await upsertAll(records, (r: any) => `${base}/stops/${r.stopNbr}`);
}

// ── attempts list (8pm result) ────────────────────────────────────────────────
export async function getAttemptsManifest(tenant: string, date: string): Promise<any | null> {
  return getDoc(attemptsPath(tenant, date));
}
export async function setAttemptsManifest(tenant: string, date: string, manifest: any): Promise<void> {
  // Written LAST (after the items) so a reader never sees a fresh manifest over a
  // half-written item set — mirrors the history warehouse's manifest-last discipline.
  await setDoc(attemptsPath(tenant, date), manifest);
}
export async function listAttemptItems(tenant: string, date: string): Promise<any[]> {
  return listDocs(`${attemptsPath(tenant, date)}/items`);
}
export async function upsertAttemptItems(tenant: string, date: string, items: any[]): Promise<void> {
  const base = attemptsPath(tenant, date);
  await upsertAll(items, (r: any) => `${base}/items/${r.stopNbr}`);
}

// PURE: recompute the manifest counts from the surviving items, preserving the
// scan-only fields (probed/unprobed/candidates) the read can't re-derive. Exported
// for tests.
export function recountManifest(prevManifest: any, items: any[]): any {
  const matched = items.filter((it) => it && it.matched).length;
  const prevCounts = (prevManifest && prevManifest.counts) || {};
  return {
    ...(prevManifest || {}),
    counts: {
      ...prevCounts,
      attempts: items.length,
      matched,
      unmatched: items.length - matched,
    },
  };
}

// Remove ONE attempts-list row and keep the manifest counts honest. Returns whether
// a row was actually present, plus the post-delete count. Re-lists the surviving
// items and rewrites the manifest (counts only) so the read endpoint and the card
// stay consistent. Idempotent: deleting a missing row is a no-op success.
export async function deleteAttemptItem(
  tenant: string, date: string, stopNbr: string,
): Promise<{ deleted: boolean; remaining: number }> {
  const base = attemptsPath(tenant, date);
  await deleteDoc(`${base}/items/${stopNbr}`);
  const [items, prevManifest] = await Promise.all([
    listAttemptItems(tenant, date),
    getAttemptsManifest(tenant, date),
  ]);
  const survived = items.some((it) => String(it.stopNbr ?? it._id) === String(stopNbr));
  if (prevManifest) {
    await setAttemptsManifest(tenant, date, {
      ...recountManifest(prevManifest, items),
      lastEditedAt: new Date().toISOString(),
    });
  }
  return { deleted: !survived, remaining: items.length };
}
