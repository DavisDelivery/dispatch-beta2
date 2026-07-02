// lib/firestore.mts
//
// Firestore REST client for the davismarginiq project. Ported from the parent
// app's netlify/functions/lib/firestore.cjs (the proven pattern: the scheduled
// background scan WRITES stop docs, the user-facing read function READS them).
//
// Auth: service-account JSON in env var FIREBASE_SA (same SA the parent uses).
// Access tokens are cached in-memory across warm invocations.
//
// REQUIRED: FIREBASE_SA must be set in THIS Netlify site's environment
// (dd-dispatch-map) for the index to work — it is separate from the parent
// site. When absent, isFirestoreEnabled() is false and callers degrade safely.
//
// Schema (nuvizz_stop_index):
//   nuvizz_stop_index/{tenant}__{date}              ← meta doc: last_scanned_at, counts
//   nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr} ← one doc per normalized stop
// {tenant}__{date} as the parent id mirrors the parent app's nuvizzFleet layout
// (REST API needs each path level to be a real doc; double-underscore is
// unambiguous since tenant codes have no underscore).

import crypto from 'node:crypto';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';

let __token: { access_token: string; expires_at_ms: number } | null = null;
let __saCache: any = null;

function loadServiceAccount(): any {
  if (__saCache) return __saCache;
  const raw = process.env.FIREBASE_SA;
  if (!raw) throw new Error('FIREBASE_SA env var not set');
  __saCache = JSON.parse(raw);
  return __saCache;
}

// ── Firestore DATABASE selection (prod-mirror isolation, Jul 2 2026) ──────────
// FIRESTORE_DATABASE picks a NAMED Firestore database inside the same Firebase
// project; unset = '(default)' (production, unchanged). The UAT prod-mirror site
// sets FIRESTORE_DATABASE=uat-mirror so its scans/journals/counters land in a
// fully separate database — same code, same service account, zero data mixing.
export function firestoreDatabase(): string {
  return String(process.env.FIRESTORE_DATABASE || '').trim() || '(default)';
}
/** SAFETY INVARIANT: a deploy pointed at UAT NuVizz must NEVER write the production
 *  (default) Firestore — that would mix UAT scan/journal rows into the live board's
 *  data. If NUVIZZ_BASE_URL is a uat host and no named database is set, Firestore is
 *  treated as OFF (loudly) rather than corrupting prod data. */
export function uatMisconfigured(): boolean {
  return /uat\.nuvizz\.com/i.test(String(process.env.NUVIZZ_BASE_URL || '')) && firestoreDatabase() === '(default)';
}
let __warnedUatMisconfig = false;
export function isFirestoreEnabled(): boolean {
  if (!process.env.FIREBASE_SA) return false;
  if (uatMisconfigured()) {
    if (!__warnedUatMisconfig) {
      __warnedUatMisconfig = true;
      console.error('[firestore] REFUSING to use the (default) database from a UAT-pointed deploy — set FIRESTORE_DATABASE (e.g. uat-mirror). Firestore is OFF for this instance.');
    }
    return false;
  }
  return true;
}

// Traditional local-day (America/New_York) date string YYYY-MM-DD. The NuVizz
// call counter is keyed by this so the displayed "calls today" follows a normal
// midnight-to-midnight ET day. Without it, jobs that fire after UTC midnight but
// before ET midnight (e.g. the 06:00 UTC ≈ 2am ET history snapshot) land on the
// NEXT UTC date and inflate "today".
export function etDayString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// ET hour-of-day as 'HH' (00–23). The call counter increments an hour__HH bucket
// keyed by this in the SAME atomic commit as the total, giving a midnight-to-midnight
// ET hourly breakdown for free (zero extra NuVizz calls) so spikes (e.g. the 10am
// unplanned open) are visible per-hour. en-GB yields 00–23; a midnight 'hour: 24'
// quirk is normalized via % 24.
export function etHourString(d: Date = new Date()): string {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).format(d);
  return String(parseInt(h, 10) % 24).padStart(2, '0');
}

function base64UrlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(): Promise<string> {
  if (__token && Date.now() < __token.expires_at_ms - 60_000) return __token.access_token;

  const sa = loadServiceAccount();
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sigB64 = signer.sign(sa.private_key).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${unsigned}.${sigB64}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const tok: any = await resp.json();
  __token = { access_token: tok.access_token, expires_at_ms: Date.now() + (tok.expires_in - 60) * 1000 };
  return __token.access_token;
}

function toFirestoreValue(v: any): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') {
    const fields: any = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined) fields[k] = toFirestoreValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFirestoreValue(v: any): any {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) {
    const out: any = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFirestoreValue(val);
    return out;
  }
  return null;
}

function docToObject(doc: any): any {
  if (!doc || !doc.fields) return null;
  const out: any = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = fromFirestoreValue(v);
  return out;
}

function objectToFields(obj: any): any {
  const fields: any = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) fields[k] = toFirestoreValue(v);
  return fields;
}

// Exported (export-only, behavior-preserving) so the immutable history warehouse
// (lib/history-store.mts) can reuse the same SA-JWT auth + value codecs instead
// of duplicating the token/cache logic. The live-cache helpers below are unchanged.
export async function getDoc(path: string): Promise<any | null> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/${firestoreDatabase()}/documents/${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`getDoc ${path} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return docToObject(await resp.json());
}

export async function setDoc(path: string, data: any): Promise<boolean> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/${firestoreDatabase()}/documents/${path}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: objectToFields(data) }),
  });
  if (!resp.ok) throw new Error(`setDoc ${path} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return true;
}

export async function listDocs(collectionPath: string): Promise<any[]> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const all: any[] = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(`${FIRESTORE_BASE}/projects/${sa.project_id}/databases/${firestoreDatabase()}/documents/${collectionPath}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.status === 404) return [];
    if (!resp.ok) throw new Error(`listDocs ${collectionPath} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const body: any = await resp.json();
    for (const d of body.documents || []) {
      const parts = (d.name || '').split('/');
      const obj = docToObject(d);
      if (obj) all.push({ _id: parts[parts.length - 1], ...obj });
    }
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return all;
}

// Structured query against a ROOT collection (no parent path), reusing the same
// SA-JWT auth + value codec. Single-field filters only in our usage (single
// tenant), so Firestore's automatic single-field indexes cover it — no composite
// index config required. Returns plain objects (with _id) like listDocs.
export async function runQuery(structuredQuery: any): Promise<any[]> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/${firestoreDatabase()}/documents:runQuery`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!resp.ok) throw new Error(`runQuery failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const rows: any[] = await resp.json();
  const out: any[] = [];
  for (const r of rows) {
    if (!r || !r.document) continue;
    const parts = (r.document.name || '').split('/');
    const obj = docToObject(r.document);
    if (obj) out.push({ _id: parts[parts.length - 1], ...obj });
  }
  return out;
}

// List top-level collection ids (or sub-collections under `docPath` if given).
// Used to DISCOVER the MarginIQ employees collection name from the shared DB.
export async function listCollectionIds(docPath?: string): Promise<string[]> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const base = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/${firestoreDatabase()}/documents`;
  const url = `${docPath ? `${base}/${docPath}` : base}:listCollectionIds`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageSize: 300 }),
  });
  if (!resp.ok) throw new Error(`listCollectionIds failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const body: any = await resp.json();
  return body.collectionIds || [];
}

// Delete a single document (used to prune stops that disappeared between scans,
// and to remove an attempts-list row on request). Exported so the attempts store
// can reuse the same SA-JWT auth instead of duplicating it.
export async function deleteDoc(path: string): Promise<void> {
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/${firestoreDatabase()}/documents/${path}`;
  const resp = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`deleteDoc ${path} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  }
}

// ── nuvizz_stop_index helpers ────────────────────────────────────────────────
const COLLECTION = 'nuvizz_stop_index';
function parentId(tenant: string, dateStr: string): string {
  return `${tenant}__${dateStr}`;
}

export interface StopIndexMeta {
  tenant: string;
  date: string;
  last_scanned_at: string;
  count: number;
  plannedCount: number;
  unplannedCount: number;
  // Per-feed scan times — loads and orders run on different cadences now, so a
  // single stamp would mislead. UTC instants; the UI shows them split.
  lastLoadScanAt?: string | null;
  lastUnplannedScanAt?: string | null;
  // Set when a scan cycle is SUPPRESSED (daily ceiling reached or kill switch),
  // so the UI can show an honest banner instead of silent staleness. Cleared on
  // the next successful scan.
  scanState?: { halted: boolean; reason: 'ceiling' | 'killswitch'; since: string } | null;
}

// Decide whether an EXISTING stop (not re-scanned this run) should be PRESERVED
// rather than pruned. Pure + exported for tests. Preserve when:
//  • the unplanned feed was skipped and this is an unplanned (status-10) stop, or
//  • the load feed was skipped and this is a planned stop, or
//  • partialLoads (Phase 2 lean): only a SUBSET of loads was re-pulled this cycle
//    (terminal loads deliberately skipped) → keep planned stops we didn't re-scan
//    so terminal-skip never deletes already-delivered stops.
// Embedded integer of a prefixed loadNbr ("DAVIS000197184" → 197184). All-digits
// form, matching loadNbrToInt in nuvizz-scan (kept local to avoid an import cycle).
function loadDigits(loadNbr: any): number | null {
  const d = String(loadNbr ?? '').replace(/\D/g, '');
  return d ? parseInt(d, 10) : null;
}

export function preserveStopOnWrite(
  stop: { isPlanned?: boolean; loadNbr?: any },
  opts: { includeUnplanned: boolean; includeLoads: boolean; partialLoads?: boolean; partialUnplanned?: boolean; rescannedLoads?: Set<number> },
): boolean {
  if (!opts.includeUnplanned && stop.isPlanned === false) return true;
  if (!opts.includeLoads && stop.isPlanned === true) return true;
  if (opts.partialLoads && stop.isPlanned === true) {
    // R1 (membership-aware): a lean cycle re-pulled only a SUBSET of loads. If THIS
    // stop's load was among the loads we actually re-pulled and the stop is no
    // longer in the fresh results, it was genuinely removed from that load → do
    // NOT preserve (let it prune). Preserve only stops on loads we did NOT re-pull
    // (terminal-skipped / outside the target set) — their absence is ambiguous, not
    // a removal. rescannedLoads omitted → legacy behaviour (preserve all planned).
    const ln = loadDigits(stop.loadNbr);
    if (opts.rescannedLoads && ln != null && opts.rescannedLoads.has(ln)) return false;
    return true;
  }
  // Phase 3 lean: the unplanned descent only re-probed NEW stop numbers above the
  // last high-water, so older still-unplanned orders weren't re-scanned → preserve
  // them instead of pruning (mirrors partialLoads for the planned side).
  if (opts.partialUnplanned && stop.isPlanned === false) return true;
  return false;
}

// Write a full day's normalized stops. Each stop doc is keyed by stopNbr and
// carries isPlanned + last_scanned_at + the full normalized shape (incl. raw).
// Stops that vanished since the previous scan are pruned so cancelled/replanned
// orders don't linger. Returns the meta record written.
export async function writeStops(
  tenant: string,
  dateStr: string,
  stops: any[],
  scannedAt: string,
  opts: { includeUnplanned?: boolean; includeLoads?: boolean; partialLoads?: boolean; partialUnplanned?: boolean; rescannedLoads?: number[] } = {},
): Promise<StopIndexMeta> {
  const includeUnplanned = opts.includeUnplanned !== false; // default true (full scan)
  const includeLoads = opts.includeLoads !== false;         // default true
  const partialLoads = opts.partialLoads === true;          // Phase 2 lean: only a SUBSET of loads re-pulled
  const partialUnplanned = opts.partialUnplanned === true;  // Phase 3 lean: only NEW stop numbers re-probed
  // R1: the load NUMBERS actually re-pulled this lean cycle — lets preserve prune a
  // planned stop removed from a load we DID re-scan, while keeping stops on loads
  // we didn't touch. Empty/undefined → preserve all planned (legacy partial-loads).
  const rescannedLoads = opts.rescannedLoads && opts.rescannedLoads.length ? new Set(opts.rescannedLoads) : undefined;
  const base = `${COLLECTION}/${parentId(tenant, dateStr)}`;
  const withNbr = stops.filter((s) => s && s.stopNbr);
  const nextNbrs = new Set(withNbr.map((s) => String(s.stopNbr)));

  const [existing, prevMeta] = await Promise.all([
    listDocs(`${base}/stops`),
    getDoc(base) as Promise<StopIndexMeta | null>,
  ]);

  // PRESERVE-ON-SKIP: a partial run must NOT wipe the feed it didn't scan. A
  // load-only run keeps existing status-10 orders; an unplanned-only run keeps
  // existing planned/routed stops. Docs re-scanned this run are upserted below.
  const preserved = existing.filter((d) =>
    !nextNbrs.has(String(d._id)) && preserveStopOnWrite(d, { includeUnplanned, includeLoads, partialLoads, partialUnplanned, rescannedLoads }));
  const preservedNbrs = new Set(preserved.map((d) => String(d._id)));
  await Promise.all(
    existing
      .filter((d) => !nextNbrs.has(String(d._id)) && !preservedNbrs.has(String(d._id)))
      .map((d) => deleteDoc(`${base}/stops/${d._id}`)),
  );

  // Upsert each freshly-scanned stop (bounded concurrency to stay polite).
  const conc = 12;
  let i = 0;
  const writeOne = async () => {
    while (i < withNbr.length) {
      const s = withNbr[i++];
      await setDoc(`${base}/stops/${s.stopNbr}`, { ...s, last_scanned_at: scannedAt });
    }
  };
  await Promise.all(Array.from({ length: conc }, writeOne));

  // Counts reflect the FULL index = freshly scanned + preserved (the feed we
  // didn't re-scan this run), split by planned vs unplanned.
  const freshPlanned = withNbr.filter((s) => s.isPlanned).length;
  const preservedPlanned = preserved.filter((d) => d.isPlanned === true).length;
  const count = withNbr.length + preserved.length;
  const plannedCount = freshPlanned + preservedPlanned;
  const unplannedCount = count - plannedCount;
  const meta: StopIndexMeta = {
    tenant,
    date: dateStr,
    last_scanned_at: scannedAt,
    count,
    plannedCount,
    unplannedCount,
    // Each per-feed stamp advances only when that feed actually ran; otherwise it
    // carries forward, so "Loads/Orders updated …" reflects the real last scan.
    lastLoadScanAt: includeLoads ? scannedAt : (prevMeta?.lastLoadScanAt ?? null),
    lastUnplannedScanAt: includeUnplanned ? scannedAt : (prevMeta?.lastUnplannedScanAt ?? null),
    // A successful scan clears any prior halted state (ceiling/kill switch).
    scanState: null,
  };

  // Meta doc last so a reader never sees a fresh timestamp over a half-written set.
  await setDoc(base, meta as any);
  return meta;
}

// Fix 5 — record that a scan cycle was SUPPRESSED (ceiling/kill switch) so the UI
// can banner it. Read-modify-write so we never clobber the existing counts/stamps
// (setDoc replaces the whole doc). A no-op-safe upsert when the meta is absent.
export async function markScanState(
  tenant: string,
  dateStr: string,
  state: { halted: boolean; reason: 'ceiling' | 'killswitch'; since: string } | null,
): Promise<void> {
  const base = `${COLLECTION}/${parentId(tenant, dateStr)}`;
  const prev = (await getDoc(base)) as StopIndexMeta | null;
  // Don't churn a write if nothing changed (avoids rewriting the meta every cron
  // tick while halted).
  if (prev && JSON.stringify(prev.scanState ?? null) === JSON.stringify(state ?? null)) return;
  const next = { ...(prev || { tenant, date: dateStr }), scanState: state };
  await setDoc(base, next as any);
}

export interface StopIndexRead {
  meta: StopIndexMeta | null;
  stops: any[];
}

export async function readStops(tenant: string, dateStr: string): Promise<StopIndexRead> {
  const base = `${COLLECTION}/${parentId(tenant, dateStr)}`;
  const [meta, docs] = await Promise.all([getDoc(base), listDocs(`${base}/stops`)]);
  // Strip the internal _id and last_scanned_at off each stop before returning.
  const stops = docs.map(({ _id, last_scanned_at, ...rest }) => rest);
  return { meta: (meta as StopIndexMeta) || null, stops };
}

// ── Board write-through (issue #361) ─────────────────────────────────────────
//
// A CONFIRMED live Save (the import engine's order read-back, or a classic save whose steps
// all succeeded) changes NuVizz immediately — but the board cache only learns about it at the
// next scheduled scan, and NuVizz's own saved-search list can lag an async import by minutes.
// So a dispatcher who just planned orders onto a load kept seeing them UNPLANNED ("fresh scan
// … however they are planned on suw 2"). These helpers write the confirmed plan state
// straight onto the day's per-stop cache docs, stamped `board_write_at`, so the board agrees
// with NuVizz the moment a Save confirms. The scan's merge honors the stamp for a grace
// window (see applyBoardWriteGrace in nuvizz-list.mts) so a lagging list can't revert it.
//
// PURE field builders (exported for tests) — mirror toBoardStop's shapes exactly:
// planned open stop = status '20'/SCHEDULED, board loadNbr = the route NAME.
export function boardWritePlannedFields(routeName: string, seq: number, driverName: string | null, at: string): any {
  return {
    status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false,
    loadNbr: routeName, routeName, routeSeq: seq,
    ...(driverName ? { driverName, driverUserName: driverName } : {}),
    board_write_at: at, board_write_planned: true,
  };
}
export function boardWriteUnplannedFields(at: string): any {
  return {
    status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true,
    loadNbr: null, routeName: null, routeSeq: null, driverName: null, driverUserName: null,
    board_write_at: at, board_write_planned: false,
  };
}

/**
 * Patch the day's board cache with a CONFIRMED plan: orderedStopNbrs are now ON routeName in
 * that order (routeSeq 1..N); unplannedStopNbrs are now OFF it. Only patches stops the cache
 * already holds (the scan owns row creation — a phantom row would lack address/coords).
 * Firestore-only — ZERO NuVizz calls. No-op when Firestore is off.
 */
export async function patchBoardPlan(
  tenant: string,
  dateStr: string,
  patch: { routeName: string; orderedStopNbrs: string[]; unplannedStopNbrs?: string[]; driverName?: string | null; at: string },
): Promise<{ patched: number; missing: number }> {
  if (!isFirestoreEnabled()) return { patched: 0, missing: 0 };
  const base = `${COLLECTION}/${parentId(tenant, dateStr)}`;
  const jobs: Array<{ nbr: string; fields: any }> = [];
  patch.orderedStopNbrs.forEach((nbr, i) => jobs.push({ nbr: String(nbr), fields: boardWritePlannedFields(patch.routeName, i + 1, patch.driverName ?? null, patch.at) }));
  for (const nbr of (patch.unplannedStopNbrs || [])) jobs.push({ nbr: String(nbr), fields: boardWriteUnplannedFields(patch.at) });
  let patched = 0, missing = 0, i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      try {
        const cur = await getDoc(`${base}/stops/${encodeURIComponent(j.nbr)}`);
        if (!cur) { missing++; continue; }
        const { _id, ...rest } = cur as any;
        await setDoc(`${base}/stops/${j.nbr}`, { ...rest, ...j.fields });
        patched++;
      } catch { missing++; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { patched, missing };
}

// ── Per-PRO enrichment registry (day-independent) ────────────────────────────
// A running log of which PRO numbers have been enriched, keyed by stopNbr (NOT by date).
// A PRO that's in here is never auto-enriched again by the scanner — it's re-pulled only by
// a manual Refresh or an activity-timeline open. Reads are TARGETED (getDoc by stopNbr for
// just the candidate set), never a full-collection scan, so read cost is bounded by the
// stops we'd otherwise enrich — not by registry size — and no pruning is needed for cost.
const enrichRegPath = (tenant: string, stopNbr: string) => `nuvizz_enriched/${tenant}/pros/${encodeURIComponent(stopNbr)}`;

// Look up enrichment detail for a set of PROs (parallel getDoc, bounded concurrency).
export async function readEnrichedPros(tenant: string, stopNbrs: string[], conc = 12): Promise<{ found: Map<string, any>; unresolved: Set<string> }> {
  const found = new Map<string, any>();
  const unresolved = new Set<string>(); // reads that ERRORED after retries — status UNKNOWN, NOT "new"
  const ids = [...new Set(stopNbrs.map((x) => String(x)).filter(Boolean))];
  // getDoc returns null for a genuine 404 (PRO truly not in the registry → enrich it) but THROWS
  // on a transient 429/500/network blip. Swallowing that throw used to drop the PRO from the map,
  // so an already-enriched PRO looked "new" and got re-enriched (a rate-limit-driven, unbounded
  // spike). Retry transient errors with small backoff; if still failing, mark UNRESOLVED so the
  // caller SKIPS it this cycle (retry next scan) instead of re-enriching on a read failure.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const getWithRetry = async (path: string): Promise<any | null> => {
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await getDoc(path); } catch (e) { lastErr = e; await sleep(120 * (attempt + 1)); }
    }
    throw lastErr;
  };
  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try { const d = await getWithRetry(enrichRegPath(tenant, id)); if (d) found.set(id, d); }
      catch { unresolved.add(id); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, ids.length) }, worker));
  return { found, unresolved };
}

// Record freshly-enriched PROs in the registry. Drops the bulky raw NuVizz payload; keeps the
// normalized detail (line items, coords, contact, pros, stopId, notes) needed to carry forward.
export async function writeEnrichedPros(tenant: string, stops: any[], atISO: string, conc = 12): Promise<number> {
  const list = stops.filter((s) => s && s.stopNbr && s.enriched);
  let i = 0, n = 0;
  const worker = async () => {
    while (i < list.length) {
      const s = list[i++];
      const { raw, ...lean } = s;
      try { await setDoc(enrichRegPath(tenant, String(s.stopNbr)), { ...lean, enriched: true, enriched_at: atISO }); n++; } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
  return n;
}

// ── Phase 4: shared call counter + circuit breaker ───────────────────────────
// One fleet-wide accountant. nuvizz-request.mts increments calls__{date} on every
// NuVizz round-trip (both apps share this davismarginiq doc) and, when the day's
// total crosses the ceiling, trips nuvizz_ops/circuit. scanGuardOpen() honours the
// flag so a regression is throttled in minutes instead of by a vendor email.
const OPS_COLLECTION = 'nuvizz_ops';

// Route label → field-safe per-route counter key, e.g. '/load/info' → 'count__load_info'.
// Exported for tests: a route name can never alias onto the authoritative `count`
// (it is always prefixed `count__`) nor inject a Firestore field path (non-alnum runs
// collapse to `_`), which is the safety property the counter relies on.
export function routeFieldKey(route?: string | null): string | null {
  if (!route) return null;
  const k = String(route).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return k ? `count__${k}` : null;
}

// Attribution field key: a DISTINCT prefix per dimension so app / trigger / source / tenant
// counters never collide with each other, with `count`, or with the hour buckets. Same
// non-alnum→`_` collapse as routeFieldKey (so a label can't inject a Firestore field path).
// This is what makes a spike SELF-EXPLAINING — every call records which app made it, WHY
// (trigger), the finer caller (source), and the tenant, in the same atomic commit:
//   app__<app>   dispatch-map | parent        trig__<trigger>  scheduled-scan | enrichment | attempts | on-demand | history | manual
//   src__<src>   board-list | pod | timeline  ten__<tenant>    davis | uline
export function attrFieldKey(prefix: 'app' | 'trig' | 'src' | 'ten', value?: string | null): string | null {
  if (!value) return null;
  const k = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return k ? `${prefix}__${k}` : null;
}

// Attribution carried with a counted call. Every field optional + backward-compatible: an
// un-attributed call still counts toward `count`, `count__route`, and the hour bucket — it
// just won't add the app/trigger/source/tenant breakdowns.
export interface CallAttribution {
  route?: string | null;
  app?: string | null;
  trigger?: string | null;
  source?: string | null;
  tenant?: string | null;
}

// ET hour 'HH' → hourly bucket field key, e.g. '10' → 'hour__10'. A DISTINCT prefix
// from count__ so per-hour totals never bleed into the per-route breakdown, and the
// strict 00–23 shape check means no arbitrary field path can be injected. Returns
// null for anything that isn't a valid two-digit ET hour.
export function hourFieldKey(hour?: string | null): string | null {
  return hour && /^([01]\d|2[0-3])$/.test(hour) ? `hour__${hour}` : null;
}

// Build the Firestore :commit body for an atomic counter increment. Exported PURE so a
// test can lock the merge-shape that the runaway-counter bug came from: the update MUST
// carry updateMask:['date'] (so the write MERGES `date` instead of REPLACING the doc and
// wiping `count`), and the increments MUST ride as updateTransforms with `count` first
// (transformResults[0] is read back as the authoritative new total).
export function buildCounterCommitBody(docName: string, dateStr: string, n: number, route?: string, hour?: string, attr?: CallAttribution) {
  const transforms: any[] = [{ fieldPath: 'count', increment: { integerValue: String(n) } }];
  const rk = routeFieldKey(route);
  if (rk) transforms.push({ fieldPath: rk, increment: { integerValue: String(n) } });
  // Per-hour bucket rides in the SAME commit, AFTER count/route, so `count` stays
  // transform[0] (the authoritative read-back) and the existing route ordering holds.
  const hk = hourFieldKey(hour);
  if (hk) transforms.push({ fieldPath: hk, increment: { integerValue: String(n) } });
  // Attribution buckets (app/trigger/source/tenant) ride LAST, after count/route/hour, so
  // none of them can displace `count` from transform[0]. Each is independent + optional.
  for (const [prefix, value] of [['app', attr?.app], ['trig', attr?.trigger], ['src', attr?.source], ['ten', attr?.tenant]] as const) {
    const fk = attrFieldKey(prefix, value);
    if (fk) transforms.push({ fieldPath: fk, increment: { integerValue: String(n) } });
  }
  return {
    writes: [{
      update: { name: docName, fields: { date: { stringValue: dateStr } } },
      updateMask: { fieldPaths: ['date'] }, // merge `date`; preserve + increment count/count__*
      updateTransforms: transforms,
    }],
  };
}

/**
 * Atomically add n to today's shared counter; returns the NEW total.
 *
 * The update MUST carry an updateMask scoped to the non-transform fields. Without
 * it, a commit `update` REPLACES the whole doc with just {date} on every call,
 * wiping `count` — the transform then re-creates count=1 each time and the total
 * never climbs (verified broken 2026-06-17). The mask makes the update MERGE so
 * `count` (and per-route counters) survive and accumulate.
 *
 * When `route` is given, a per-route counter (count__<route>) is incremented in
 * the SAME commit so we can see where the calls go. Total `count` stays
 * authoritative for the ceiling. Returns the new total `count`.
 */
export async function incrementCallCounter(dateStr: string, n: number, meta?: string | CallAttribution): Promise<number> {
  // Back-compat: a bare string is treated as the route (the original 3-arg signature).
  const attr: CallAttribution = typeof meta === 'string' ? { route: meta } : (meta || {});
  const token = await getAccessToken();
  const sa = loadServiceAccount();
  const docName = `projects/${sa.project_id}/databases/${firestoreDatabase()}/documents/${OPS_COLLECTION}/calls__${dateStr}`;
  const url = `${FIRESTORE_BASE}/projects/${sa.project_id}/databases/${firestoreDatabase()}/documents:commit`;
  // count is always transform[0] so transformResults[0] is the authoritative total.
  // Stamp the current ET hour so the same commit also grows that hour's bucket.
  const body = buildCounterCommitBody(docName, dateStr, n, attr.route ?? undefined, etHourString(), attr);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`incrementCallCounter failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const out: any = await resp.json();
  const tr = out.writeResults?.[0]?.transformResults?.[0];
  return tr ? parseInt(tr.integerValue, 10) : NaN;
}

export async function readCallCounter(dateStr: string): Promise<number> {
  const doc = await getDoc(`${OPS_COLLECTION}/calls__${dateStr}`);
  return doc && typeof doc.count === 'number' ? doc.count : 0;
}

/**
 * Today's total + per-route breakdown (count__* fields, route prefix stripped) +
 * per-hour breakdown (hour__HH fields → { '00'..'23': n }). byHour lets the UI/ops
 * see WHEN calls land (e.g. the 10am unplanned open) without any extra reads.
 */
export async function readCallStats(dateStr: string): Promise<{ count: number; byRoute: Record<string, number>; byHour: Record<string, number>; byApp: Record<string, number>; byTrigger: Record<string, number>; bySource: Record<string, number>; byTenant: Record<string, number> }> {
  const doc = await getDoc(`${OPS_COLLECTION}/calls__${dateStr}`);
  const byRoute: Record<string, number> = {};
  const byHour: Record<string, number> = {};
  const byApp: Record<string, number> = {};
  const byTrigger: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byTenant: Record<string, number> = {};
  if (doc) {
    for (const [k, v] of Object.entries(doc)) {
      if (typeof v !== 'number') continue;
      if (k.startsWith('count__')) byRoute[k.slice('count__'.length)] = v;
      else if (k.startsWith('hour__')) byHour[k.slice('hour__'.length)] = v;
      else if (k.startsWith('app__')) byApp[k.slice('app__'.length)] = v;
      else if (k.startsWith('trig__')) byTrigger[k.slice('trig__'.length)] = v;
      else if (k.startsWith('src__')) bySource[k.slice('src__'.length)] = v;
      else if (k.startsWith('ten__')) byTenant[k.slice('ten__'.length)] = v;
    }
  }
  return { count: doc && typeof doc.count === 'number' ? doc.count : 0, byRoute, byHour, byApp, byTrigger, bySource, byTenant };
}

// Live-editable scan configuration doc (Diagnostics UI). Stored as a flat doc at
// nuvizz_ops/scan_config; absent → the scanner uses env/hardcoded defaults. The
// SHAPE/validation lives in scan-schedule.mts (ScanConfig + clampScanConfig); this
// is just the persistence. Typed loosely to avoid an import cycle with scan-schedule.
const SCAN_CONFIG_PATH = `${OPS_COLLECTION}/scan_config`;
export async function readScanConfig(): Promise<Record<string, any>> {
  const doc = await getDoc(SCAN_CONFIG_PATH);
  return (doc as Record<string, any>) || {};
}
export async function writeScanConfig(cfg: Record<string, any>): Promise<void> {
  // setDoc PATCH-merges, so the write endpoint sends the full managed field set.
  await setDoc(SCAN_CONFIG_PATH, cfg);
}

export interface CircuitState { open: boolean; reason?: string; at?: string; day?: string }

// Day-scoped decision (Fix 3), exported PURE for tests: a flag tripped on a prior UTC
// day is stale — treat as CLOSED so a yesterday-tripped breaker can't halt today's
// scans at count 0; only an `open` flag stamped with today's day stays open.
export function circuitFromDoc(doc: any, today: string): CircuitState {
  if (!doc) return { open: false };
  const open = !!doc.open && doc.day === today;
  return { open, reason: doc.reason, at: doc.at, day: doc.day };
}

export async function readCircuit(): Promise<CircuitState> {
  const doc = await getDoc(`${OPS_COLLECTION}/circuit`);
  return circuitFromDoc(doc, new Date().toISOString().slice(0, 10));
}

export async function setCircuit(open: boolean, reason: string, atISO: string): Promise<void> {
  // Stamp the UTC day of the trip so readCircuit can auto-expire it at midnight.
  await setDoc(`${OPS_COLLECTION}/circuit`, { open, reason, at: atISO, day: atISO.slice(0, 10) });
}

// ── Scan-discovery metrics (learn the real load delta / gaps) ────────────────
// One rolling doc holds the last N per-scan samples so we can see, from evidence,
// how many new loads appear per day and the worst gap between load numbers — i.e.
// how big the adaptive forward-walk's "stop after K empties" really needs to be.
const SCAN_METRICS_MAX = 500;
export async function recordScanMetric(sample: any): Promise<void> {
  try {
    const doc = await getDoc(`${OPS_COLLECTION}/scan_metrics`);
    const prev: any[] = Array.isArray(doc?.samples) ? doc.samples : [];
    const samples = [...prev, sample].slice(-SCAN_METRICS_MAX);
    await setDoc(`${OPS_COLLECTION}/scan_metrics`, { samples, updated_at: new Date().toISOString() });
  } catch { /* best-effort: metrics must never affect a scan */ }
}
export async function readScanMetrics(): Promise<any[]> {
  const doc = await getDoc(`${OPS_COLLECTION}/scan_metrics`);
  return Array.isArray(doc?.samples) ? doc.samples : [];
}

// ── Phase 6: terminal-stop skip cache ────────────────────────────────────────
// A stop at status 90/91 is DELIVERED and immutable, so once the unplanned descent
// has confirmed a stop number terminal there is no reason to spend a /stop/info call
// re-probing it. We persist {stopNbr → expectedDate} for terminal numbers; the descent
// synthesizes the would-be probe (exists, expected, non-target) from the cache instead
// of calling NuVizz, which preserves the early-stop heuristics exactly. One doc per
// tenant, pruned to the live band so it stays small (numbers far below the descent
// floor are never re-probed anyway).
const TERMINAL_COLLECTION = 'nuvizz_stop_terminal';

// PURE: drop cache entries below the retained band so the doc stays bounded. Exported
// for tests. Keeps numbers >= retainFloor (everything the descent could still re-probe).
export function pruneTerminalMap(map: Record<string, string>, retainFloor: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [nbr, expected] of Object.entries(map)) {
    if (Number(nbr) >= retainFloor) out[nbr] = expected;
  }
  return out;
}

export async function readTerminalStops(tenant: string): Promise<Record<string, string>> {
  const doc = await getDoc(`${TERMINAL_COLLECTION}/${tenant}`);
  const stops = doc?.stops;
  return stops && typeof stops === 'object' ? (stops as Record<string, string>) : {};
}

// Merge newly-confirmed terminal numbers into the cache and prune to the live band.
// Read-modify-write (last-write-wins): a lost race just re-probes a few stops next
// scan — self-healing — so we skip the complexity of per-key field-path merges.
export async function mergeTerminalStops(
  tenant: string, additions: Record<string, string>, retainFloor: number,
): Promise<number> {
  const current = await readTerminalStops(tenant);
  const merged = pruneTerminalMap({ ...current, ...additions }, retainFloor);
  await setDoc(`${TERMINAL_COLLECTION}/${tenant}`, { tenant, stops: merged, updated_at: new Date().toISOString() });
  return Object.keys(merged).length;
}

// ── Incremental-scan state (call-reduction work) ─────────────────────────────
// Per-date roster written after every scan, read at the start of the next: which
// loads we already know (+ whether each is fully delivered), the load-number span,
// route→load map, and the highest stop number seen. Phase 1 only POPULATES this
// (shadow mode); later phases use it to probe only known-active loads + a buffer
// instead of a wide window.
const SCAN_STATE_COLLECTION = 'scan_state';

export interface KnownLoad { loadNbr: string; routeName: string | null; allTerminal: boolean; lastSeenAt: string }
export interface ScanState {
  date: string;
  knownLoads: KnownLoad[];
  minLoadNbr: number | null;
  maxLoadNbr: number | null;
  highWaterStopNbr: number | null;          // max over ALL stops (planned + unplanned)
  highWaterUnplannedStopNbr: number | null; // max over UNPLANNED stops only — bounds the lean order descent
  routeMap: Record<string, string>;
  lastScanAt: string;
  scanCount: number;
  // ── Step 1 shadow instrumentation (additive; existing readers ignore these) ──
  // Per-load member stop numbers from the latest scan — lets the next cycle diff
  // membership to surface stops pulled OFF a load (R1 evidence / future reconcile).
  loadMembers?: Record<string, string[]>;
  // True when the latest unplanned descent ran to the floor / early-stopped by
  // design (NOT truncated by maxProbes / time budget / breaker). High-water must
  // only be trusted to advance the lean floor when this is true (R9).
  descentComplete?: boolean;
  // Highest stop number actually SEEN to exist in the latest descent (frontier);
  // lets a future cycle seed the ceiling without re-galloping.
  observedFrontierStopNbr?: number | null;
  // Unplanned stop numbers seen in the latest FULL descent — the "known last
  // cycle" set, so the frontier audit can tell a NEW below-floor straggler
  // (harmful miss) from an already-known below-floor order (benign). Preserved
  // across load-only cycles (only refreshed when the descent actually ran).
  unplannedStopNbrs?: number[];
  // Step 4: ISO timestamp of the last DEEP SWEEP (full-floor, relaxed-early-stop
  // descent). Gates the deep-sweep cadence so the lean frontier's below-floor
  // blind spot is reconciled a few times a day.
  lastDeepSweepAt?: string;
}

// R5: scan_state is keyed per tenant so a second tenant can't collide on the
// roster/high-water. Back-compat: `tenant` is optional; callers pass it now. On
// the first read after this change the prefixed key is absent → null → one cold
// (wide) cycle reseeds it. The legacy date-only docs are simply abandoned.
function scanStateKey(tenant: string | undefined, dateStr: string): string {
  return `${SCAN_STATE_COLLECTION}/${tenant ? `${tenant}__${dateStr}` : dateStr}`;
}
export async function readScanState(dateStr: string, tenant?: string): Promise<ScanState | null> {
  const doc = await getDoc(scanStateKey(tenant, dateStr));
  return (doc as any) || null;
}

export async function writeScanState(dateStr: string, state: ScanState, tenant?: string): Promise<void> {
  await setDoc(scanStateKey(tenant, dateStr), state as any);
}

// PURE: fold prior-day scan states into a single carried frontier — the max load
// number, max stop number, and max UNPLANNED stop number seen across them. Seeds
// the adaptive forward scan on a cold/resumption day (e.g. Sunday after the
// weekend blackout) so we resume from "what we finished with" instead of a cold
// wide rescan. Unit-tested (test/recent-frontier.test.mjs).
export function mergeFrontier(
  states: Array<Partial<ScanState> | null | undefined>,
): { maxLoadNbr: number | null; maxStopNbr: number | null; maxUnplannedStopNbr: number | null; carriedLoadNbrs: number[] } {
  let maxLoadNbr: number | null = null;
  let maxStopNbr: number | null = null;
  let maxUnplannedStopNbr: number | null = null;
  const carried = new Set<number>();
  const loadInt = (ln: any): number | null => {
    const digits = String(ln ?? '').replace(/\D/g, '');
    return digits ? parseInt(digits, 10) : null;
  };
  const up = (cur: number | null, v: number | null | undefined) =>
    v == null ? cur : (cur == null ? v : Math.max(cur, v));
  for (const s of states) {
    if (!s) continue;
    maxLoadNbr = up(maxLoadNbr, s.maxLoadNbr);
    maxStopNbr = up(maxStopNbr, s.highWaterStopNbr);
    maxStopNbr = up(maxStopNbr, s.observedFrontierStopNbr);
    maxUnplannedStopNbr = up(maxUnplannedStopNbr, s.highWaterUnplannedStopNbr);
    // Carryover candidates: non-terminal loads from prior days that may still
    // deliver stops today (a multi-day / earlier-started route). The forward scan
    // re-pulls these so it doesn't miss loads below the frontier; probeLoad then
    // keeps only the stops actually scheduled for the board date.
    for (const k of s.knownLoads || []) {
      if (k && k.allTerminal === false) {
        const n = loadInt(k.loadNbr);
        if (n != null) carried.add(n);
      }
    }
  }
  return { maxLoadNbr, maxStopNbr, maxUnplannedStopNbr, carriedLoadNbrs: [...carried] };
}

// Read the most recent prior days' scan states and fold them into a carried
// frontier. Looks back `lookbackDays` calendar days (default 4 — spans a weekend:
// Sun reads back through Thu, picking up Friday's end-state).
export async function readRecentFrontier(
  tenant: string,
  dateStr: string,
  lookbackDays = 4,
): Promise<{ maxLoadNbr: number | null; maxStopNbr: number | null; maxUnplannedStopNbr: number | null; carriedLoadNbrs: number[] }> {
  const base = new Date(dateStr + 'T00:00:00Z');
  const dates: string[] = [];
  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const states = await Promise.all(dates.map((d) => readScanState(d, tenant).catch(() => null)));
  return mergeFrontier(states);
}

// ── Phase 4: canonical fleet index (the shape SITE A already reads) ───────────
// The sole scanner (this app) writes load summaries + aggregate + driver index to
// nuvizzFleet/{tenant}__{date} — byte-compatible with the parent app's existing
// reader (lib/firestore.cjs readSummary/listLoads/readDriverIndex) so SITE A can
// render its dashboard straight from Firestore and STOP scanning NuVizz itself.
const FLEET_COLLECTION = 'nuvizzFleet';

export interface FleetSummary {
  totalLoads: number; assignedLoads: number; unassignedLoads: number;
  totalStops: number; totalDelivered: number; totalInProgress: number;
  totalExceptions: number; uniqueDrivers: number; pctComplete: number;
}

export async function writeFleetIndex(
  tenant: string, dateStr: string,
  loads: any[], summary: FleetSummary, driverIndex: Record<string, string[]>, scannedAt: string,
): Promise<void> {
  const base = `${FLEET_COLLECTION}/${parentId(tenant, dateStr)}`;
  const withNbr = loads.filter((l) => l && l.loadNbr);

  // Prune loads that vanished since the previous scan.
  const existing = await listDocs(`${base}/loads`);
  const nextNbrs = new Set(withNbr.map((l) => String(l.loadNbr)));
  await Promise.all(existing.filter((d) => !nextNbrs.has(String(d._id))).map((d) => deleteDoc(`${base}/loads/${d._id}`)));

  const conc = 12; let i = 0;
  const writeOne = async () => {
    while (i < withNbr.length) {
      const l = withNbr[i++];
      await setDoc(`${base}/loads/${l.loadNbr}`, { ...l, _updatedAt: scannedAt });
    }
  };
  await Promise.all(Array.from({ length: conc }, writeOne));
  await setDoc(`${base}/meta/summary`, { ...summary, _updatedAt: scannedAt } as any);
  await setDoc(`${base}/meta/driverIndex`, { map: driverIndex, _updatedAt: scannedAt } as any);
  // Parent doc last, carrying freshness for SITE A's staleness check.
  await setDoc(base, { tenant, date: dateStr, last_scanned_at: scannedAt } as any);
}

// ── Load roster cache (empty loads incl.) ──────────────────────────────────────
// The portal's PkgRoute "Loads" grid for a date — every load, INCLUDING ones created
// but not yet filled with orders ("empty loads"). The scanner persists it so the
// dispatcher can see e.g. Monday's empty loads without a live fetch, and so the next
// day's roster is captured ONCE (it doesn't change) instead of re-pulled per request.
// Stored as a single JSON field (an array of {loadId,name,status,trips}) to sidestep
// the value codec's nested array-of-map handling. One doc per tenant+date.
const LOAD_ROSTER_COLLECTION = 'nuvizz_load_roster';
export async function writeLoadRoster(tenant: string, dateStr: string, loads: any[], scannedAt: string): Promise<void> {
  await setDoc(`${LOAD_ROSTER_COLLECTION}/${parentId(tenant, dateStr)}`, {
    tenant, date: dateStr, at: scannedAt, count: (loads || []).length, loadsJson: JSON.stringify(loads || []),
  } as any);
}
export async function readLoadRoster(tenant: string, dateStr: string): Promise<{ at: string | null; loads: any[] } | null> {
  const doc = await getDoc(`${LOAD_ROSTER_COLLECTION}/${parentId(tenant, dateStr)}`);
  if (!doc) return null;
  let loads: any[] = [];
  try { loads = JSON.parse(doc.loadsJson || '[]'); } catch { loads = []; }
  return { at: doc.at || doc._updatedAt || null, loads };
}

// ── Driver roster (on-demand, long-lived; SHARED with the parent app) ─────────
// One doc per tenant, NOT date-scoped. This is the SAME doc + shape the mobile app
// (davis-nuvizz) reads/writes — a native `users` array, so either app can refresh it
// and both read it back. Keep the shape in sync with the parent's writeDriverRoster.
const DRIVER_ROSTER_COLLECTION = 'nuvizzRoster';
export async function readDriverRoster(tenant: string): Promise<any | null> {
  return await getDoc(`${DRIVER_ROSTER_COLLECTION}/${tenant}`);
}
export async function writeDriverRoster(tenant: string, roster: any): Promise<void> {
  await setDoc(`${DRIVER_ROSTER_COLLECTION}/${tenant}`, { ...roster, _updatedAt: new Date().toISOString() });
}

// ── Live active-unplanned set (carry-over freshness guard) ──────────────────────
// The set of stop numbers that are CURRENTLY unplanned across the scan's ±7d active pull,
// snapshotted each scan. The read-time carry-over fold-in uses it to drop prior-day stops that
// have since been delivered/planned — they vanish from the live active search, so they're no
// longer in this set. `windowStart` is the oldest ET date the pull reliably covers; carry-over
// only trusts the filter for days >= windowStart (older days fall back to the index snapshot).
// One doc per tenant; stop numbers stored as a JSON array (codec-safe). Zero NuVizz cost.
const ACTIVE_SET_COLLECTION = 'nuvizz_active_set';
export async function writeActiveUnplannedSet(tenant: string, data: { at: string; windowStart: string; stopNbrs: string[] }): Promise<void> {
  await setDoc(`${ACTIVE_SET_COLLECTION}/${tenant}`, {
    tenant, at: data.at, windowStart: data.windowStart, count: (data.stopNbrs || []).length,
    stopNbrsJson: JSON.stringify(data.stopNbrs || []),
  } as any);
}
export async function readActiveUnplannedSet(tenant: string): Promise<{ at: string | null; windowStart: string | null; stopNbrs: Set<string> } | null> {
  const doc = await getDoc(`${ACTIVE_SET_COLLECTION}/${tenant}`);
  if (!doc) return null;
  let arr: string[] = [];
  try { arr = JSON.parse(doc.stopNbrsJson || '[]'); } catch { arr = []; }
  return { at: doc.at || null, windowStart: doc.windowStart || null, stopNbrs: new Set(arr.map(String)) };
}
