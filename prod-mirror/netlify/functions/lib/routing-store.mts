// lib/routing-store.mts
//
// Firestore access for the routing collections (reuses firestore.mts; no auth
// duplication). Kept SEPARATE from nuvizz_stop_index (cache) and history_days
// (Phase 1) — Phase 2 writes ONLY here.
//   routing_jobs/{jobId}    — async build job (client writes request + polls).
//   routing_routes/{id}     — a saved, reproducible plan (inputs + outputs).

import crypto from 'node:crypto';
import { getDoc, setDoc, listDocs } from './firestore.mts';

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

const JOBS = 'routing_jobs';
const ROUTES = 'routing_routes';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function createJob(job: any): Promise<string> {
  const id = job.id || newId('job');
  await setDoc(`${JOBS}/${id}`, { ...job, id });
  return id;
}
export async function getJob(id: string): Promise<any | null> {
  return getDoc(`${JOBS}/${id}`);
}
export async function updateJob(id: string, patch: any): Promise<void> {
  const cur = (await getDoc(`${JOBS}/${id}`)) || {};
  await setDoc(`${JOBS}/${id}`, { ...cur, ...patch, id });
}

export async function saveRouteSet(routeSet: any): Promise<string> {
  const id = routeSet.id || newId('routeset');
  await setDoc(`${ROUTES}/${id}`, { ...routeSet, id });
  return id;
}
export async function getRouteSet(id: string): Promise<any | null> {
  return getDoc(`${ROUTES}/${id}`);
}
export async function listRouteSets(): Promise<any[]> {
  return listDocs(ROUTES);
}
