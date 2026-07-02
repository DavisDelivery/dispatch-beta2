// lib/nuvizz-write.mts
//
// ── NuVizz v7 WRITE executor (the IMPURE half) ───────────────────────────────
//
// Fires the PURE requests built in nuvizz-write-ops.mts through the SHARED metered
// requester (getNuvizzRequester) so every write is counted against the daily ceiling,
// honors the circuit breaker, and is visible per-route in Diagnostics — exactly like
// every read. POSTs are never deduped by the requester (writes must not coalesce).
//
// The requester is INJECTED (runOp's first arg) so this is unit-testable with the same
// makeHarness() pattern as test/nuvizz-request.test.mjs — no network, no Firestore.
// The HTTP op-envelope handler (nuvizz-write.mts function) calls runOp(getNuvizzRequester(), …).
//
// Multi-call ops:
//   removeStops  = GET load/info (echo header + versionId) → POST load/edit   (2 calls, §3.5)
//   commitLoad   = the Compare-panel "Save" batch: optionally one getLoad to resolve
//                  loadId/header, then remove → insert → assign → dispatch in order,
//                  stopping at the first failure. (This is what the Save button commits.)

import { getCreds, basicAuthHeader } from './nuvizz-scan.mts';
import {
  buildOpRequest, parseOpResponse, toEditHeader, normalizeLoad, planSequence, deliveryOrder,
  importEchoFromRaw, assembleImportHeader, sameOrder, buildStopPayload, normStopNbr,
  type SingleOp, type WriteOp, type WriteCreds,
} from './nuvizz-write-ops.mts';
import { isHashLikeId } from './nuvizz-list.mts';

const hasDriverId = (v: any) => v != null && String(v).trim() !== '' && Number(v) !== 0;

// A caller-supplied loadId is only trustworthy AS the assign/dispatch routeId when it's a real
// INTERNAL load id (the 24-hex loadHeader.loadId, e.g. 6a438e9d52ef82bd1ed4516b). A load that
// carries stops gets that canonical id off its stops; but an EMPTY/Draft load (no stops) can only
// fall back to the PkgRoute roster KeyColumn, which is NOT guaranteed to be that internal id. NuVizz
// SILENTLY no-ops an assign whose routeId isn't the internal loadId — it returns "Success" while
// persisting nothing (the exact "accepted but didn't take" symptom). So: trust a hash-like client
// loadId (the proven path is untouched — those ids ARE hash-like); otherwise resolve the canonical
// loadHeader.loadId from load/info before assigning. If the roster id already IS the internal id,
// this guard is a no-op; if it isn't, this is what makes an empty-load assign actually persist.
const trustableLoadId = (v: any) => v != null && isHashLikeId(String(v));

// v7 API base — same env var the read path uses (nuvizz-scan.mts). Host-agnostic so a
// UAT base can be set without code changes. No raw network call in this file (every
// request goes through the metered requester), so the no-direct-nuvizz guard stays green.
const NUVIZZ_V7_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

export function resolveWriteCreds(): WriteCreds {
  const { companyCode } = getCreds();
  return { base: NUVIZZ_V7_BASE.replace(/\/+$/, ''), companyCode, auth: basicAuthHeader() };
}

// Minimal surface of the metered requester we depend on (lets tests pass a stub).
export interface RequesterLike {
  request(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string | null; maxRetries?: number }, meta: { route: string; tenant: string; source?: string }): Promise<Response>;
}

async function safeJson(resp: Response): Promise<any> {
  try { return await resp.json(); }
  catch { try { return { _text: await resp.text() }; } catch { return {}; } }
}

async function fireSingle(requester: RequesterLike, op: SingleOp, payload: any, creds: WriteCreds): Promise<any> {
  const br = buildOpRequest(op, payload, creds);
  // NON-IDEMPOTENT writes are never transport-retried: an assign/dispatch whose first attempt
  // APPLIED but answered 5xx would double-fire on retry (a duplicate DISPATCH to the driver).
  // Reads and the DECLARATIVE import keep the default retry policy — re-sending those is safe.
  const noRetry = op === 'assignDriver' || op === 'dispatchLoad' || op === 'insertStops' || op === 'removeStops' || op === 'createStop';
  const resp = await requester.request(br.url, { method: br.method, headers: br.headers, body: br.body, ...(noRetry ? { maxRetries: 0 } : {}) }, br.meta);
  const j = await safeJson(resp);
  return { ...parseOpResponse(op, resp.ok, j), httpStatus: resp.status };
}

/** GET load/info → { load, httpStatus, hadLoadId }. `load` is the normalized load when the
 * lookup resolved (2xx AND a real loadId), else null. The diagnostic fields let callers say WHY
 * a load didn't resolve — a 404 (the load number isn't recognized by NuVizz) vs a 200 with no
 * loadId (unexpected response shape) — so "load not found" is actionable in the field. */
export async function fetchLoad(requester: RequesterLike, loadNbr: string, creds: WriteCreds): Promise<{ load: any; httpStatus: number | null; hadLoadId: boolean }> {
  const r = await fireSingle(requester, 'getLoad', { loadNbr }, creds);
  // normalizeLoad ALWAYS returns an object (even for a 404/empty body), so "not found" must be
  // detected by a non-2xx response or a missing loadId — never edit/dispatch a phantom load.
  const hadLoadId = !!(r.load && r.load.loadId != null);
  const ok = !!r.ok && hadLoadId;
  return { load: ok ? r.load : null, httpStatus: r.httpStatus ?? null, hadLoadId };
}

/** Resolve a load's HUMAN loadNbr from its INTERNAL loadId via load/static/info(routeId). load/info
 * (and the load/edit unplan step) is keyed by the human number, so a load we only know by its id
 * (Draft / Loads-grid) needs this bridge before it can be reordered/unplanned. Null if unresolved. */
// load/static/info is HTTP 501 (not implemented) on the live DAVIS tenant — remember the first
// 501 per warm instance so every later resolution skips the guaranteed-wasted NuVizz call.
let staticInfoUnavailable = false;
/** Test hook: clears the per-instance 501 memo so scripted suites stay order-independent. */
export function _resetStaticInfoMemo(): void { staticInfoUnavailable = false; }
export async function resolveLoadNbrById(requester: RequesterLike, loadId: string, creds: WriteCreds): Promise<string | null> {
  if (staticInfoUnavailable) return null;
  try {
    const r = await fireSingle(requester, 'getLoadByRouteId', { routeId: loadId }, creds);
    if (r?.httpStatus === 501) { staticInfoUnavailable = true; return null; }
    return r?.ok && r.load?.loadNbr != null && String(r.load.loadNbr).trim() !== '' ? String(r.load.loadNbr) : null;
  } catch { return null; }
}

/** Resolve a load's HUMAN loadNbr from a stop CURRENTLY ON it, via getStop → Stop.load.loadNbr
 * (assignedLoadNbr). This is the RELIABLE bridge on the live tenant: the loads-roster saved search
 * carries no load-number column, and load/static/info(routeId) returns HTTP 501 — so a stop's own
 * load membership is the only place a Draft/grid load's real number (DAVIS000000123) is exposed.
 * Verified live. Null if the stop isn't on a load. */
export async function resolveLoadNbrByStopNbr(requester: RequesterLike, stopNbr: string, creds: WriteCreds): Promise<string | null> {
  try {
    const r = await fireSingle(requester, 'getStop', { stopNbr }, creds);
    const nbr = r?.ok ? r.stop?.assignedLoadNbr : null;
    return nbr != null && String(nbr).trim() !== '' && !isHashLikeId(String(nbr)) ? String(nbr) : null;
  } catch { return null; }
}

/**
 * resolveLoadNbrBySeeding — the LAST-RESORT loadNbr bridge for an EMPTY Draft load we only know
 * by its internal loadId (the live tenant's loads roster has no load-number column, static/info
 * is HTTP 501, and an empty load has no stops to read the number from — the exact state that
 * refused every "build a load from unplanned orders" Save with "needs a load number").
 *
 * The trick: load/insertstops is keyed by the INTERNAL loadId (the proven add path), so SEED the
 * load with the first desired stop (1 call), then read that stop back — Stop.load.loadNbr is the
 * load's real human number (the verified live bridge). The seeded stop is part of the desired
 * order anyway, so the follow-up (import rebuild or anchor plan) seats it — never an extra stop.
 * Only ever seeds a stop that is genuinely UNPLANNED (a planned stop returns its current load's
 * number directly, or is somebody else's — never stolen here).
 */
async function resolveLoadNbrBySeeding(
  requester: RequesterLike, loadId: any, stopNbr: string, creds: WriteCreds, sleep: (ms: number) => Promise<void> = realSleep,
): Promise<{ loadNbr: string | null; seeded: boolean; error?: string }> {
  const g1 = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  if (!g1?.ok) return { loadNbr: null, seeded: false, error: `stop ${stopNbr} could not be read (stale board — refresh and retry)` };
  const already = String(g1.stop?.assignedLoadNbr ?? '').trim();
  if (already && !isHashLikeId(already)) return { loadNbr: already, seeded: false };
  const stopId = g1.stop?.stopId ? String(g1.stop.stopId) : null;
  if (!stopId) return { loadNbr: null, seeded: false, error: `stop ${stopNbr} has no internal id to seed the load with` };
  const ins = await fireSingle(requester, 'insertStops', { insertStopIds: [stopId], loadId }, creds);
  if (!ins?.ok) return { loadNbr: null, seeded: false, error: `seeding the load failed: ${ins?.error || 'insertStops failed'}` };
  // Membership usually reflects immediately; retry briefly in case the read lags the insert.
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(1500);
    const g2 = await fireSingle(requester, 'getStop', { stopNbr }, creds);
    const nbr = g2?.ok ? String(g2.stop?.assignedLoadNbr ?? '').trim() : '';
    if (nbr && !isHashLikeId(nbr)) return { loadNbr: nbr, seeded: true };
  }
  return { loadNbr: null, seeded: true, error: 'load seeded but its number is not visible yet — Save again in a moment (safe to repeat)' };
}

// Human "why didn't it resolve" suffix for a failed fetchLoad. Surfaces the exact load number we
// queried and NuVizz's response so a wrong/blank load number (404) is distinguishable from a load
// that resolved but parsed without an id (200/no loadId) — turns an opaque "load not found" into
// something a dispatcher can read back to us verbatim.
function loadMissDiag(loadNbr: any, f: { httpStatus: number | null; hadLoadId: boolean }): string {
  const detail = f.httpStatus === 200 && !f.hadLoadId ? 'load/info 200 but no loadId in response' : `load/info HTTP ${f.httpStatus}`;
  return `loadNbr="${loadNbr ?? ''}", ${detail}`;
}

/**
 * removeStops (§3.5): ALWAYS resolve the echoed header + versionId from a live getLoad —
 * we never trust a caller-supplied editHeader/versionId. load/edit is a full-header replace,
 * so echoing a hand-crafted/stale header could blank live load fields; server-resolving the
 * header from NuVizz is the only safe contract.
 */
async function runRemoveStops(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const loadNbr = req(payload?.loadNbr, 'removeStops: loadNbr');
  const f = await fetchLoad(requester, loadNbr, creds);
  if (!f.load) return { ok: false, error: `removeStops: load not found (${loadMissDiag(loadNbr, f)})`, loadNbr };
  return fireSingle(requester, 'removeStops', { removeStopIds: payload?.removeStopIds, editHeader: toEditHeader(f.load.loadHeader), versionId: f.load.versionId }, creds);
}

/**
 * commitLoad — the Save batch for ONE load card. Resolves loadId/header once if needed,
 * then applies removes → inserts → assign → dispatch in order, capturing a per-step
 * result and aborting the remainder on the first failure (so a failed insert never
 * dispatches a half-built load).
 */
export async function runCommitLoad(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const loadNbr = payload?.loadNbr ?? null;
  const removeStopIds: any[] = Array.isArray(payload?.removeStopIds) ? payload.removeStopIds : [];
  const insertStopIds: any[] = Array.isArray(payload?.insertStopIds) ? payload.insertStopIds : [];
  const driverId = payload?.driverId ?? null;
  const dispatch = Boolean(payload?.dispatch);
  // driverId is a NuVizz numeric userId; treat null/blank/0 as "no driver" so a falsy-but-
  // present 0 cannot half-fire an assign. The same predicate gates load resolution below.
  const hasDriver = driverId != null && String(driverId).trim() !== '' && Number(driverId) !== 0;

  // Prefer a loadId the CALLER already knows (the board's same-day loadId) over re-resolving
  // by name: recurring loads share a NAME across days but have a distinct loadId per day, so
  // name-resolution could otherwise hit the wrong day's instance. We still getLoad when a
  // remove needs the header/versionId, or when no loadId was supplied. Only trust a hash-like
  // (internal) loadId, though — a non-canonical roster id (empty-load fallback) is dropped to
  // null here so it is RE-RESOLVED to the real loadHeader.loadId below rather than sent as a
  // routeId NuVizz silently ignores.
  let loadId = trustableLoadId(payload?.loadId) ? payload.loadId : null;
  let editHeader: any = null, versionId: any = null;

  const needLoad = (!loadId && (insertStopIds.length || hasDriver || dispatch)) || removeStopIds.length;
  if (needLoad) {
    if (!loadNbr) return { ok: false, error: 'commitLoad: loadNbr required to resolve load', loadNbr, loadId, steps: [] };
    const f = await fetchLoad(requester, loadNbr, creds);
    if (!f.load) return { ok: false, error: `commitLoad: load not found (${loadMissDiag(loadNbr, f)})`, loadNbr, loadId, steps: [] };
    loadId = loadId || f.load.loadId;
    // NOTE: versionId/editHeader are snapshotted from this single getLoad. Safe today because
    // removeStops runs FIRST and is the only step that uses them; if a future step re-edits the
    // header after a remove, re-fetch the load to refresh the (now-bumped) versionId.
    editHeader = toEditHeader(f.load.loadHeader);
    versionId = f.load.versionId;
  }

  const steps: Array<{ op: WriteOp; ok: boolean; result?: any; error?: string | null }> = [];
  const push = (op: WriteOp, r: any) => { steps.push({ op, ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') }); return !!r.ok; };

  if (removeStopIds.length) {
    if (!push('removeStops', await fireSingle(requester, 'removeStops', { removeStopIds, editHeader, versionId }, creds))) return done(false);
  }
  if (insertStopIds.length) {
    if (!loadId) return { ok: false, error: 'commitLoad: loadId unresolved for insertStops', loadNbr, loadId, steps };
    if (!push('insertStops', await fireSingle(requester, 'insertStops', { insertStopIds, loadId }, creds))) return done(false);
  }
  if (hasDriver) {
    if (!loadId) return { ok: false, error: 'commitLoad: loadId unresolved for assignDriver', loadNbr, loadId, steps };
    if (!push('assignDriver', await fireSingle(requester, 'assignDriver', { routeId: loadId, driverId }, creds))) return done(false);
  }
  if (dispatch) {
    if (!loadId) return { ok: false, error: 'commitLoad: loadId unresolved for dispatch', loadNbr, loadId, steps };
    if (!push('dispatchLoad', await fireSingle(requester, 'dispatchLoad', { routeId: loadId }, creds))) return done(false);
  }
  return done(true);

  function done(ok: boolean) { return { ok: ok && steps.every((s) => s.ok), loadNbr, loadId, steps }; }
}

// The delivery stopIds currently on a load, in visit order (the pickup, stopType!='DO',
// is excluded so it stays as a natural anchor and is never removed/re-sequenced).
function currentDeliveryStopIds(load: any): string[] {
  return (load?.stops || [])
    .filter((s: any) => String(s?.stopType || '').toUpperCase() === 'DO')
    .slice()
    .sort((a: any, b: any) => Number(a?.stopSeq ?? 0) - Number(b?.stopSeq ?? 0))
    .map((s: any) => String(s?.stopId ?? ''))
    .filter(Boolean);
}

// True when a load carries a non-pickup stop the DO-filter would skip: a stop whose type isn't
// 'DO' but sits in a delivery slot (stopSeq > 1; doc §10 says seq 1 = origin pickup). Re-sequencing
// such a load would leave that stop out of the rebuilt order — refuse rather than de-sequence it.
function hasUnmodeledDelivery(load: any): boolean {
  return (load?.stops || []).some((s: any) => String(s?.stopType || '').toUpperCase() !== 'DO' && Number(s?.stopSeq ?? 0) > 1);
}

/**
 * commitBoard — the panel-level "Save" for the staged Compare board (handoff doc §10
 * Draft→Save). TWO PHASES across ALL touched loads so a stop moved from load A to load B
 * is removed from A BEFORE it is inserted onto B (a stop can be on only one load):
 *   Phase 0  resolve+plan — getLoad each load (loadId, versionId, header, current deliveries),
 *            then planSequence(current, desired) = the anchor method.
 *   Phase 1  removes — load/edit each load's removeStopIds (keeping its anchor; never all).
 *   Phase 2  rebuild — insertStops one-at-a-time in the desired order, then assignDriver,
 *            then dispatch, per load.
 * A load that fails a step aborts ITS remaining steps but never blocks other loads.
 * payload: { loads: [{ loadNbr, loadId?, orderedStopIds:[stopId...], driverId?, dispatch? }] }
 */
export async function runCommitBoard(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const loadsIn: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
  if (!loadsIn.length) return { ok: true, loads: [] };

  // ── Phase 0 — resolve + plan ──
  const planned: any[] = [];
  // Every load NUMBER that is part of THIS Save (declared up front + resolved as we go). Used to
  // tell a legitimate cross-load move (source load in the batch → Phase 1 frees the stop) from a
  // GRAB off a load that isn't in the payload at all (nothing would free it → double-plan).
  const batchNbrs = new Set<string>();
  for (const l of loadsIn) { const v = String(l?.loadNbr ?? '').trim(); if (v && !isHashLikeId(v)) batchNbrs.add(v); }
  for (const L of loadsIn) {
    const loadNbr = L?.loadNbr ?? null;
    const result: any = { loadNbr, ok: true, steps: [], error: null };
    // Desired order can arrive as stopIds (legacy + the loadId-only insert path) or as stopNbrs
    // (resolved server-side from the load — robust to board stops that were never enriched and so
    // carry no client stopId; the #symptom-A silent drop).
    const orderedNbrs: string[] | null = Array.isArray(L?.orderedStopNbrs) ? L.orderedStopNbrs.map((x: any) => String(x)).filter(Boolean) : null;
    const emptyLoad = L?.emptyLoad === true;
    let desired: any[] = Array.isArray(L?.orderedStopIds) ? L.orderedStopIds.map((x: any) => String(x)) : [];
    if (!loadNbr && !L?.loadId) { result.ok = false; result.error = 'commitBoard: loadNbr or loadId required'; planned.push({ L, result }); continue; }
    // Does this load change its stop set (reorder / unplan / empty the load)? Assign/dispatch-only
    // (no stop change) skips getLoad with a TRUSTWORTHY (internal/hash-like) loadId. A non-canonical
    // loadId (empty-load roster fallback) is NOT trusted — it falls through to fetchLoad so the real
    // loadHeader.loadId is resolved, else NuVizz returns Success on the assign but never persists it.
    const changesStops = emptyLoad || orderedNbrs !== null || desired.length > 0;
    if (!changesStops && trustableLoadId(L?.loadId)) {
      planned.push({ L, loadId: L.loadId, hasLoad: true, plan: { ok: true, unchanged: true, removeStopIds: [], insertOrdered: [] }, result });
      continue;
    }
    // Resolve a USABLE human loadNbr. load/info (and the load/edit unplan step) is keyed by the human
    // number (DAVIS000000123), NOT the hex loadId. A load opened from the Loads grid / a Draft load has
    // only its internal id, so we must bridge to its real number before a REORDER/UNPLAN can run the
    // real unplan(load/edit)→re-insert path (instead of blind-inserting already-planned stops).
    let loadNbrX = (loadNbr != null && String(loadNbr).trim() !== '' && !isHashLikeId(String(loadNbr))) ? String(loadNbr) : null;
    if (!loadNbrX) {
      // PREFER reading a stop CURRENTLY on the load (getStop → assignedLoadNbr) — the RELIABLE source
      // on the live tenant, where the loads-roster saved search has no load-number column and
      // load/static/info(routeId) is HTTP 501. A reorder/unplan/empty always carries stop NUMBERS the
      // caller says are on the load (ordered ∪ removed), so probe the first of those. [verified live]
      const probeNbr = (orderedNbrs && orderedNbrs[0])
        || (Array.isArray(L?.removeStopNbrs) && L.removeStopNbrs.length ? String(L.removeStopNbrs[0]) : null);
      if (probeNbr) loadNbrX = await resolveLoadNbrByStopNbr(requester, String(probeNbr), creds);
      // Fallback: load/static/info(routeId) where that endpoint exists (some tenants).
      if (!loadNbrX && trustableLoadId(L?.loadId)) loadNbrX = await resolveLoadNbrById(requester, L.loadId, creds);
      if (loadNbrX) result.loadNbr = loadNbrX;
    }
    if (loadNbrX) batchNbrs.add(loadNbrX);
    // Add BRAND-NEW (unplanned) stops to a load we STILL only know by its id (static/info couldn't
    // resolve a number): insert the stopIds straight onto the loadId, no anchor-remove. Only a pure ADD
    // by stopIds — a reorder-by-stopNbr / emptyLoad needs the load's current stops (getLoad, below). [#328]
    if (desired.length && orderedNbrs === null && !emptyLoad && trustableLoadId(L?.loadId) && !loadNbrX) {
      planned.push({ L, loadId: L.loadId, hasLoad: true, plan: { ok: true, removeStopIds: [], insertOrdered: desired.map((x) => String(x)) }, curIds: [], want: desired.map((x) => String(x)), result });
      continue;
    }
    // EMPTY Draft load known only by its internal id: SEED it with the first desired stop
    // (loadId-keyed insertstops), then read that stop back for the real load number — the same
    // bridge the import engine uses. Only for an order-building Save (never an empty/cancel).
    if (!loadNbrX && !emptyLoad && trustableLoadId(L?.loadId) && orderedNbrs && orderedNbrs.length) {
      const seed = await resolveLoadNbrBySeeding(requester, L.loadId, orderedNbrs[0], creds);
      result.steps.push({ op: 'seedLoad', ok: !!seed.loadNbr, seeded: seed.seeded, loadNbr: seed.loadNbr, error: seed.error || null });
      if (seed.loadNbr) { loadNbrX = seed.loadNbr; result.loadNbr = loadNbrX; batchNbrs.add(loadNbrX); }
      else { result.ok = false; result.error = `commitBoard: ${seed.error || 'could not resolve the load number'}`; planned.push({ L, result }); continue; }
    }
    // Reorder / unplan / empty needs the load's CURRENT stops (a getLoad), which needs a real loadNbr.
    // If seeding also couldn't resolve one, guide the dispatcher to open it from the board.
    if (!loadNbrX) {
      result.ok = false; result.error = 'commitBoard: reorder/unplan needs a load number — open the route from the board (not the Loads grid)'; planned.push({ L, result }); continue;
    }
    const f = await fetchLoad(requester, loadNbrX, creds);
    if (!f.load) { result.ok = false; result.error = `commitBoard: load not found (${loadMissDiag(loadNbrX, f)})`; planned.push({ L, result }); continue; }
    const load = f.load;
    // curIds is captured on EVERY fetched load (even refused ones) so holderOf below can see a
    // cross-load arrival whose source load was refused — otherwise the target would insert a stop
    // the refused source never freed.
    const curIds = currentDeliveryStopIds(load);
    // Resolve a stopNbr-based desired order → stopIds. Stops already ON the load carry their stopId
    // in the getLoad response (nbrToId) — this is what lets an unplan/reorder work even when the
    // client never enriched its board stops. A stopNbr NOT on the load is a stop being ADDED (e.g.
    // re-planning an order that was just unplanned) — resolve its id via getStop so it gets INSERTED,
    // instead of being silently dropped (which read as "nothing to send" on a re-add).
    if (orderedNbrs !== null) {
      const nbrToId = new Map<string, string>();
      for (const s of (load.stops || [])) { const n = String(s?.stopNbr ?? ''); const id = String(s?.stopId ?? ''); if (n && id) nbrToId.set(n, id); }
      const resolved: string[] = [];
      let anyOnLoad = false;
      let refuse: string | null = null;
      for (const n of orderedNbrs) {
        let id = nbrToId.get(n);
        if (id) { anyOnLoad = true; }
        else {
          // Not on this load → an add. getStop resolves its stopId (and it's not in holderOf, so
          // Phase 2 inserts it safely). null only if the stop number is genuinely unknown.
          const gs = await fireSingle(requester, 'getStop', { stopNbr: n }, creds);
          id = gs?.ok && gs.stop?.stopId ? String(gs.stop.stopId) : undefined;
          // A stop still PLANNED on a load that is NOT part of this Save would be silently pulled
          // off that load by the insert (holderOf only sees loads in the payload, so the Phase-2
          // "still on another load" guard is blind here). Refuse — the source must be in the Save
          // so the move is a staged remove+insert, never a grab.
          const srcNbr = gs?.ok ? String(gs.stop?.assignedLoadNbr ?? '').trim() : '';
          if (id && srcNbr && srcNbr !== String(loadNbrX ?? '') && !batchNbrs.has(srcNbr)) {
            refuse = `commitBoard: stop ${n} is still planned on load ${srcNbr}, which is not part of this Save — open that load in Compare so the move is staged`;
            break;
          }
        }
        if (id) resolved.push(String(id));
      }
      if (refuse) { result.ok = false; result.error = refuse; planned.push({ L, curIds, result }); continue; }
      // Refuse only when NOTHING resolved AND nothing was even on the load — a genuinely stale board.
      if (orderedNbrs.length && !resolved.length && !anyOnLoad) {
        result.ok = false; result.error = 'commitBoard: ordered stops not found (stale board — refresh and retry)'; planned.push({ L, curIds, result }); continue;
      }
      desired = resolved;
    }
    // EMPTY-LOAD intent (§10): the user removed EVERY order — removing all deliveries CANCELS the
    // route. Computed BEFORE the wrong-load guard so a cancel is identity-checked too: an emptied
    // load whose NAME resolved to a different day's instance must never cancel that other route.
    const intendedEmpty = emptyLoad || (orderedNbrs !== null && orderedNbrs.length === 0);
    // Wrong-load guard: a reorder (or cancel) resolves the load by NAME (for header + versionId)
    // but targets the caller's loadId — if the caller's same-day loadId disagrees with what the
    // name resolved to, the recurring name hit a different day's instance; refuse rather than
    // split remove/insert (or cancel the wrong route).
    if ((desired.length || intendedEmpty) && L?.loadId && load.loadId && String(load.loadId) !== String(L.loadId)) {
      result.ok = false; result.error = `commitBoard: load identity mismatch (name resolved ${load.loadId}, expected ${L.loadId})`; planned.push({ L, curIds, result }); continue;
    }
    if (desired.length && hasUnmodeledDelivery(load)) {
      result.ok = false; result.error = 'commitBoard: load has a non-DO stop in a delivery slot — reorder skipped (verify in portal)'; planned.push({ L, curIds, result }); continue;
    }
    let plan: any;
    if (!desired.length && intendedEmpty) {
      if (!curIds.length) { result.ok = false; result.error = 'commitBoard: load already has no deliveries to remove'; planned.push({ L, curIds, result }); continue; }
      plan = { ok: true, unchanged: false, removeStopIds: curIds, insertOrdered: [], cancelRoute: true };
    } else {
      plan = desired.length ? planSequence(curIds, desired) : { ok: true, unchanged: true, removeStopIds: [], insertOrdered: [] };
    }
    if (!plan.ok) { result.ok = false; result.error = plan.reason; planned.push({ L, curIds, result }); continue; }
    // Prefer a hash-like caller loadId (the board's same-day internal id); otherwise use the
    // loadHeader.loadId we just resolved — never let a non-canonical roster id become the routeId.
    planned.push({ L, load, hasLoad: true, loadId: trustableLoadId(L?.loadId) ? L.loadId : (load.loadId || L.loadId), loadNbr: loadNbrX, editHeader: toEditHeader(load.loadHeader), versionId: load.versionId, plan, curIds, want: desired.map((x) => String(x)), result });
  }

  const live = planned.filter((p) => p.result.ok && p.hasLoad);
  // Every stopId currently on any FETCHED load — lets Phase 2 tell a cross-load ARRIVAL (must have
  // been freed by a Phase-1 remove) from an unplanned/new stop (no current load → safe to insert).
  const holderOf = new Set<string>();
  for (const p of planned) for (const id of (p.curIds || [])) holderOf.add(String(id));
  const actuallyFreed = new Set<string>();   // removed by a SUCCESSFUL Phase-1 remove
  const inserted = new Set<string>();         // successfully (re)inserted in Phase 2

  // ── Phase 0.5 — anchor pre-insert (advanced: a NEW stop is the desired first delivery) ──
  // Insert that stop FIRST so it anchors the load, THEN Phase 1 can remove the current deliveries
  // without ever emptying the load (which would cancel it). Sequenced before any remove. If the
  // pre-insert fails we abort the load so Phase 1 does NOT strip it to zero stops.
  for (const p of live) {
    const anchorInsert = p.plan.anchorInsert ? String(p.plan.anchorInsert) : null;
    if (!anchorInsert) continue;
    // A cross-load anchor (a stop still on ANOTHER load) cannot be pre-inserted here: its source
    // frees it only in Phase 1, which runs AFTER this. Refuse rather than double-place it. (A truly
    // new/unplanned first delivery isn't in holderOf, so it passes.)
    if (!(p.curIds || []).includes(anchorInsert) && holderOf.has(anchorInsert)) {
      p.result.steps.push({ op: 'insertStops', ok: false, result: null, error: `anchor ${anchorInsert} is still on another load — move it from there first` });
      p.result.ok = false; p.aborted = true; continue;
    }
    const r = await fireSingle(requester, 'insertStops', { insertStopIds: [anchorInsert], loadId: p.loadId }, creds);
    p.result.steps.push({ op: 'insertStops', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
    if (!r.ok) { p.result.ok = false; p.aborted = true; }
    else {
      inserted.add(anchorInsert);
      // The pre-insert bumped this load's versionId; Phase 1's removeStops echoes versionId (a
      // version-checked full-header replace), so a STALE token would reject the remove and leave the
      // load in a wrong state. Re-fetch to refresh editHeader/versionId before the remove.
      if ((p.plan.removeStopIds || []).length && p.loadNbr) {
        const f = await fetchLoad(requester, String(p.loadNbr), creds);
        if (f.load) { p.editHeader = toEditHeader(f.load.loadHeader); p.versionId = f.load.versionId; }
      }
    }
  }

  // ── Phase 1 — all removes first (frees moved stops before any re-insert) ──
  for (const p of live) {
    if (p.aborted) continue;                 // anchor pre-insert failed → never strip this load
    const ids = p.plan.removeStopIds || [];
    if (!ids.length) continue;
    const r = await fireSingle(requester, 'removeStops', { removeStopIds: ids, editHeader: p.editHeader, versionId: p.versionId }, creds);
    // Removing ALL deliveries CANCELS the route; NuVizz may report that cancel as a non-OK body
    // (a "Cancelled route" message). For an INTENTIONAL empty-load we treat a cancellation response
    // as success. (Defensive: the exact cancel-response shape is pending a live confirm on a stable
    // load — the raw result is kept in the step so the first real cancel is diagnosable.)
    const cancelled = !!p.plan.cancelRoute && /cancel/i.test(String(r.error ?? ''));
    const ok = !!r.ok || cancelled;
    p.result.steps.push({ op: 'removeStops', ok, result: r, error: ok ? null : (r.error || 'failed'), cancelledRoute: (p.plan.cancelRoute && ok) || undefined });
    if (!ok) { p.result.ok = false; p.aborted = true; }
    else for (const id of ids) actuallyFreed.add(String(id));
  }

  // ── Phase 2 — rebuild (ordered, one-at-a-time) + assign + dispatch ──
  for (const p of live) {
    if (p.aborted) continue;
    let ok = true;
    for (const id of (p.plan.insertOrdered || [])) {
      const sid = String(id);
      // A cross-load ARRIVAL (not originally on THIS load) is only safe to insert once its source
      // load actually freed it. If the source failed Phase 0/1, skip rather than place a stop that
      // is still on another load. (Unplanned/new stops aren't in holderOf, so they pass.)
      if (!(p.curIds || []).includes(sid) && holderOf.has(sid) && !actuallyFreed.has(sid)) {
        p.result.steps.push({ op: 'insertStops', ok: false, result: null, error: `source load not freed for stop ${sid} — a load this move depends on failed` });
        ok = false; break;
      }
      const r = await fireSingle(requester, 'insertStops', { insertStopIds: [sid], loadId: p.loadId }, creds);
      p.result.steps.push({ op: 'insertStops', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) { ok = false; break; }
      inserted.add(sid);
    }
    // Never assign/dispatch a route we just EMPTIED/CANCELLED — the load no longer exists to crew,
    // and firing against it errors and flips the (successful) cancel to a reported failure.
    if (ok && !p.plan.cancelRoute && hasDriverId(p.L?.driverId)) {
      const r = await fireSingle(requester, 'assignDriver', { routeId: p.loadId, driverId: p.L.driverId }, creds);
      p.result.steps.push({ op: 'assignDriver', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) ok = false;
    }
    if (ok && !p.plan.cancelRoute && p.L?.dispatch) {
      const r = await fireSingle(requester, 'dispatchLoad', { routeId: p.loadId }, creds);
      p.result.steps.push({ op: 'dispatchLoad', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) ok = false;
    }
    if (!ok) p.result.ok = false;
  }

  // Orphans: a stop that was FREED (removed from its source) and was meant to land on some load
  // (in a desired order) but its insert never succeeded — it is now UNPLANNED in NuVizz. Surfaced
  // so the dispatcher can re-Save. (A freed stop NOT in any desired order is an intended unplan.)
  const intendedOnSomeLoad = new Set<string>();
  for (const p of live) for (const id of (p.want || [])) intendedOnSomeLoad.add(String(id));
  const orphaned = [...actuallyFreed].filter((id) => intendedOnSomeLoad.has(id) && !inserted.has(id));

  const loads = planned.map((p) => ({ loadNbr: p.result.loadNbr, loadId: p.loadId ?? p.L?.loadId ?? null, ok: p.result.ok, error: p.result.error, steps: p.result.steps }));
  return { ok: loads.every((l) => l.ok) && orphaned.length === 0, loads, orphaned };
}

/**
 * runOp — single entry for the handler. `op` is validated by the caller against the
 * allowlist. Returns a plain object (never throws for a *NuVizz* failure — those are
 * reported as { ok:false, error }); a malformed-payload throw from a builder propagates
 * so the handler maps it to a 400.
 */
/**
 * Standalone assignDriver / dispatchLoad (the Routes-panel driver dropdown). NuVizz SILENTLY
 * no-ops an assign/dispatch whose routeId isn't the INTERNAL loadHeader.loadId — it answers
 * "Success" while persisting nothing. The Routes panel may hand us a roster KeyColumn id (for a
 * Draft/empty load with no enriched stops) that is NOT guaranteed to be that internal id. So when
 * we have the load NUMBER, resolve the canonical loadHeader.loadId via load/info first and assign
 * against THAT — the same guard commitLoad/commitBoard already apply. (Enriched loads pass their
 * real internal id and this getLoad simply re-confirms it.)
 */
async function runAssignDispatch(requester: RequesterLike, op: SingleOp, payload: any, creds: WriteCreds): Promise<any> {
  let routeId = payload?.routeId ?? payload?.loadId ?? null;
  const loadNbr = (payload?.loadNbr != null && String(payload.loadNbr).trim() !== '' && !isHashLikeId(String(payload.loadNbr))) ? String(payload.loadNbr) : null;
  if (loadNbr) {
    const f = await fetchLoad(requester, loadNbr, creds);
    if (f.load?.loadId) routeId = f.load.loadId;
    else if (!trustableLoadId(routeId)) return { ok: false, error: `${op}: could not resolve the load's internal id (${loadMissDiag(loadNbr, f)}) — assign would silently no-op` };
  }
  if (!routeId) return { ok: false, error: `${op}: no routeId — cannot ${op === 'assignDriver' ? 'assign' : 'dispatch'}` };
  return fireSingle(requester, op, { ...payload, routeId }, creds);
}

// ── §I  async LOAD IMPORT executor — one call per load + the convergence recipe ──
//
// The NEW sequencing path (see nuvizz-write-ops.mts §I for the full contract): one
// POST load/update/default per touched load sets that load's complete stop list in exact
// array order — no anchors, no removes, no one-at-a-time inserts. UAT-verified DAVISV5
// Jul 1 2026. The ENGINE CHOICE LIVES IN THE APP: the Compare panel's engine toggle sends
// useImport on the Save payload, which is the only routing switch (plus the handler's
// NUVIZZ_WRITE_ENABLED kill switch that gates ALL writes, exactly as before). The
// NUVIZZ_LOAD_IMPORT env var survives only as an emergency hard-off brake. The classic
// anchor engine remains the default whenever the toggle is off.
//
// CONVERGENCE (mandatory after EVERY order-affecting import — a 200 ack is async and can
// silently not land): poll GET load/info every ~pollMs up to a phase budget, comparing the
// load's deliveryOrder() (sorted by to.seq) to the requested stopNbr order. Not converged →
// re-send the SAME import (also what seats a newly-added stop, which APPENDS on its first
// import). Still stuck → send the array REVERSED then the desired order (verified to unstick
// the async worker's stale-state window). Never trust the 200 alone.
//
// Call cost (worst case, defaults): ≤4 imports + ≤18 polls ≈ 22 counted calls per load;
// a clean first-poll converge is 1 import + 1 read. NB: the default budgets (~90s total)
// exceed a synchronous Netlify function's ~26s window — enabling this path for real routes
// includes moving the poll into a background function (or passing a tighter
// payload.convergence budget); that wiring is part of the enable-with-sign-off step.

/** SAFETY GATE for the import path. Since the Jul 2 2026 incident (production NuVizz treats
 *  import REFERENCE stops as full replaces — freight wiped on 10 orders + 10 unplanned
 *  duplicates created, violating the UAT-verified "referenced stops keep their other fields"
 *  contract) the import engine is DISABLED unless the server explicitly re-enables it:
 *  NUVIZZ_LOAD_IMPORT must be set to 1/true/on/yes. Unset (the normal state) now BLOCKS the
 *  import path — the app's in-panel toggle still picks the engine, but only once the server
 *  says imports are safe again. Read at call time so flipping it needs no code deploy. */
export function importEngineEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test(String(process.env.NUVIZZ_LOAD_IMPORT ?? '').trim());
}
export function loadImportBlocked(): boolean {
  return !importEngineEnabled();
}

/** Injectable pacing so the convergence loop is unit-testable with no real clock. */
export interface ImportPacing {
  pollMs?: number;        // delay between load/info polls (default 5000)
  phaseWaitMs?: number;   // per-phase poll budget (default 30000 → 3 phases ≈ the ~90s recipe)
  sleep?: (ms: number) => Promise<void>;
  /** QUICK mode (the board Save): fire the import + ONE short poll phase, then return
   *  `pending: true` instead of burning the full resend/reverse recipe inside a single
   *  function invocation (a sync Netlify function gets ~26s TOTAL). The CLIENT drives the
   *  rest of the convergence: cheap getLoad polls + a re-Save resend until the read-back
   *  matches. Never reports ok without a matching read-back, same as the full recipe. */
  quick?: boolean;
  /** Skip even the quick confirm poll — fire the import and return pending immediately.
   *  Used when a Save carries MULTIPLE import loads: the fixed confirm budget doesn't scale,
   *  and the client verifier polls every load anyway. */
  skipConfirm?: boolean;
  /** UNSTICK escalation (client ladder's last resort): fire the array REVERSED, one beat,
   *  then the DESIRED order — the §10.1-verified cure for the async worker's stuck-append
   *  state (same-direction re-sends demonstrably don't clear it: the Jul 2 2026 SUW session
   *  appended the two membership-changed stops to the tail across 9 same-direction imports).
   *  Skips the initial import (the desired order was already sent); 2 update calls + 1 poll. */
  unstick?: boolean;
}
const realSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// One poll phase: read load/info up to `polls` times, pollMs apart, until the load's
// delivery order equals `want` (array equality = order AND membership — an omitted stop
// that is still on the load means not-converged). A brand-new load 404s until the async
// worker creates it; fetchLoad returns null then, which simply reads as not-yet-converged.
async function pollUntilConverged(
  requester: RequesterLike, loadNbr: string, want: string[], creds: WriteCreds,
  pollMs: number, polls: number, sleep: (ms: number) => Promise<void>,
): Promise<{ converged: boolean; seen: string[] | null; loadId: any; reads: number; seenHistory: Array<string[] | null>; stopIds: Record<string, string> | null }> {
  let seen: string[] | null = null, loadId: any = null, reads = 0;
  let stopIds: Record<string, string> | null = null;   // stopNbr → NuVizz stopId, harvested from the SAME read
  const seenHistory: Array<string[] | null> = [];   // EVERY poll's read-back, for the journal (directive #1)
  for (let i = 0; i < polls; i++) {
    await sleep(pollMs);
    const f = await fetchLoad(requester, loadNbr, creds);
    reads++;
    if (f.load) {
      loadId = f.load.loadId ?? loadId;
      // HARVEST stopIds off the convergence read (work item A): inline-created stops get their
      // NuVizz internal id from the load/info we were reading anyway — zero extra calls. Keyed
      // by the RAW stopNbr as NuVizz echoes it (callers normalize for comparison, not storage).
      const ids: Record<string, string> = {};
      for (const s of (f.load.stops || [])) if (s?.stopNbr != null && s?.stopId != null) ids[String(s.stopNbr)] = String(s.stopId);
      if (Object.keys(ids).length) stopIds = ids;
      seen = deliveryOrder(f.load);
      seenHistory.push(seen);
      // STRICT: a mid-rebuild read can list all stops before the worker assigns their to.seq —
      // a missing seq degrades the sort to raw array order, which could read as a FALSE
      // convergence (and then assign/dispatch an order the worker may still change). Require a
      // real numeric seq on every delivery before trusting the comparison.
      const seqsComplete = (f.load.stops || [])
        .filter((s: any) => String(s?.stopType ?? 'DO').toUpperCase() !== 'PU')
        .every((s: any) => s?.stopSeq != null && Number.isFinite(Number(s.stopSeq)));   // null coerces to 0 — check presence first
      // Comparison is NORMALIZED both sides (trim/case/zero-padding — sameOrder/normStopNbr):
      // NuVizz's padding/typing must never read as "not converged". (Verified from the Jul 2
      // journal that today's mismatches were REAL order differences, not padding — but the
      // normalization guard costs nothing and closes that class for good.)
      if (seqsComplete && sameOrder(seen, want)) {
        return { converged: true, seen, loadId, reads, seenHistory, stopIds };
      }
    } else {
      seenHistory.push(null);   // 404/no-load read (brand-new load not created yet)
    }
  }
  return { converged: false, seen, loadId, reads, seenHistory, stopIds };
}

/**
 * runImportLoad — fire ONE load's import and drive it to convergence.
 * payload: { load: { loadHeader, stops }, convergence?: ImportPacing }
 * Returns { ok, converged, loadNbr, loadId, requestedOrder, seenOrder, steps[], error }.
 * ok=true ONLY when the read-back order matches the request — never on the async ack alone.
 */
export async function runImportLoad(requester: RequesterLike, payload: any, creds: WriteCreds, pacing?: ImportPacing): Promise<any> {
  if (loadImportBlocked()) {
    return { ok: false, gated: true, error: 'load-import engine is disabled on the server (emergency brake: prod imports wipe freight — NUVIZZ_LOAD_IMPORT must be explicitly re-enabled) — use the classic engine' };
  }
  const load = payload?.load;
  const loadNbr = String(load?.loadHeader?.loadNbr ?? '').trim();
  if (!loadNbr || !Array.isArray(load?.stops) || !load.stops.length) {
    // buildImportBody re-validates in depth; this early check just yields a friendlier error
    // before any pacing math. An empty stops[] is NEVER sent (use load/cancel to retire a load).
    return { ok: false, error: 'importLoad: payload.load needs loadHeader.loadNbr and a non-empty stops[]' };
  }
  const p = { ...(pacing || {}), ...(payload?.convergence || {}) };
  const pollMs = Math.max(250, Number(p.pollMs) || 5000);
  const phaseWaitMs = Math.max(pollMs, Number(p.phaseWaitMs) || 30000);
  const polls = Math.max(1, Math.ceil(phaseWaitMs / pollMs));
  const sleep = p.sleep || realSleep;

  // The requested visit order = the stops[] array order (deliveries; a PU never sorts in
  // deliveryOrder, so exclude it from the comparator too).
  const want = load.stops
    .filter((s: any) => String(s?.stopType ?? 'DO').toUpperCase() !== 'PU')
    .map((s: any) => String(s?.stopNbr ?? '')).filter(Boolean);

  const steps: any[] = [];
  let loadId: any = null;
  let stopIds: Record<string, string> | null = null;   // harvested from the convergence read (item A)
  const fire = async (stops: any[], label: string) => {
    const r = await fireSingle(requester, 'importLoad', { load: { loadHeader: load.loadHeader, stops } }, creds);
    // FORENSICS: keep exactly what was sent (header + stop order) and exactly what NuVizz said
    // (verbatim ack). An async import that "succeeds" and never lands is only diagnosable from
    // this pair — it rides the op ledger into Firestore and the client console.
    steps.push({
      op: 'importLoad', label, ok: !!r.ok, appMessageLogId: r.appMessageLogId ?? null,
      ackText: r.ackText ?? null, httpStatus: r.httpStatus ?? null,
      sentHeader: load.loadHeader, sentStopNbrs: stops.map((s: any) => String(s?.stopNbr ?? '')),
      error: r.ok ? null : (r.error || 'failed'),
    });
    try { console.log('[nuvizz-write] importLoad', label, JSON.stringify({ loadNbr, header: load.loadHeader, stopNbrs: stops.map((s: any) => s?.stopNbr), ack: r.ackText ?? r.error ?? null })); } catch { /* log only */ }
    return r;
  };
  const poll = async (label: string) => {
    const c = await pollUntilConverged(requester, loadNbr, want, creds, pollMs, polls, sleep);
    steps.push({ op: 'converge', label, ok: c.converged, reads: c.reads, seen: c.seen, seenHistory: c.seenHistory });
    loadId = c.loadId ?? loadId;
    stopIds = c.stopIds ?? stopIds;
    return c;
  };
  // Per-save call anatomy (directive #4): X load/update + Y load/info fired by THIS invocation.
  // Rides the result into the journal + client console so every Save self-reports its cost.
  const anatomy = () => ({
    updates: steps.filter((s) => s.op === 'importLoad').length,
    infos: steps.filter((s) => s.op === 'converge').reduce((n, s) => n + (s.reads || 0), 0),
  });
  const done = (converged: boolean, seen: string[] | null) => ({
    ok: converged, converged, loadNbr, loadId, requestedOrder: want, seenOrder: seen, steps, calls: anatomy(),
    // stopIds (stopNbr → internal id) rides out ONLY from a converged read-back — the client
    // enriches inline-created stops with their NuVizz ids at zero extra call cost (item A).
    stopIds: converged ? stopIds : null,
    error: converged ? null : `importLoad: order did not converge after re-send + reverse-unstick — verify load ${loadNbr} in the portal before retrying`,
  });

  // UNSTICK escalation (client ladder, quick): the desired order was ALREADY sent and the worker
  // is in the stuck-append state — same-direction re-sends don't clear it (proven Jul 2 2026:
  // nine same-direction imports, the two membership-changed stops appended every time). The
  // §10.1-verified cure: REVERSED, one beat, then DESIRED. One invocation, 2 updates + 1 poll.
  if (p.unstick === true) {
    const rev = await fire([...load.stops].reverse(), 'reverse-unstick');
    if (!rev.ok) return { ok: false, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: rev.error || 'reverse-unstick rejected' };
    await sleep(pollMs); // one beat between the reversed and forward imports
    const fwd = await fire(load.stops, 'forward-after-reverse');
    if (!fwd.ok) return { ok: false, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: fwd.error || 'forward import rejected' };
    if (p.skipConfirm === true) {   // multi-load unstick: the client polls; keep the invocation inside budget
      return { ok: false, pending: true, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: null };
    }
    const cu = await poll('after-unstick');
    if (cu.converged) return done(true, cu.seen);
    return { ok: false, pending: true, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: cu.seen, steps, calls: anatomy(), error: null };
  }

  // Phase 1 — the import, then poll.
  let r = await fire(load.stops, 'import');
  if (!r.ok) return { ok: false, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: r.error || 'import rejected' };
  if (p.skipConfirm === true) {
    return { ok: false, pending: true, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: null };
  }
  let c = await poll('after-import');
  if (c.converged) return done(true, c.seen);
  if (p.quick === true) {
    // QUICK mode: the import is fired and accepted, just not CONFIRMED yet. Hand convergence
    // to the caller (the client polls getLoad on a backoff + escalates) instead of blocking
    // this invocation.
    return { ok: false, pending: true, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: c.seen, steps, calls: anatomy(), error: null };
  }

  // Phase 2 — re-send the SAME import (the recipe's first unstick; also the reorder pass
  // that seats a newly-added stop, which appends on its first import).
  r = await fire(load.stops, 'resend');
  if (r.ok) { c = await poll('after-resend'); if (c.converged) return done(true, c.seen); }

  // Phase 3 — REVERSED then desired (verified to unstick the async worker), then poll.
  await fire([...load.stops].reverse(), 'reverse-unstick');
  await sleep(pollMs); // give the worker one beat between the reversed and forward imports
  r = await fire(load.stops, 'forward-after-reverse');
  c = await poll('after-reverse-forward');
  return done(c.converged, c.seen);
}

/**
 * runCommitImport — the import-path Save: one import per touched load, applied strictly in
 * the caller's array order. For a cross-load move (A → B) the caller MUST list the SOURCE
 * load (without the stop) BEFORE the destination (with it) — a "steal" while the stop is
 * still planned on A is untested and never relied on. A load that fails to converge stops
 * the batch (later loads may depend on its unplans); already-imported loads are reported.
 * payload: { loads: [{ loadHeader, stops }...], convergence?: ImportPacing }
 */
export async function runCommitImport(requester: RequesterLike, payload: any, creds: WriteCreds, pacing?: ImportPacing): Promise<any> {
  if (loadImportBlocked()) {
    return { ok: false, gated: true, error: 'load-import engine is disabled on the server (emergency brake: prod imports wipe freight — NUVIZZ_LOAD_IMPORT must be explicitly re-enabled) — use the classic engine' };
  }
  const loadsIn: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
  if (!loadsIn.length) return { ok: true, loads: [] };
  const results: any[] = [];
  for (const L of loadsIn) {
    const r = await runImportLoad(requester, { load: L, convergence: payload?.convergence }, creds, pacing);
    results.push(r);
    if (!r.ok) break; // sources-before-destinations: a stuck source must not let a destination "steal"
  }
  const skipped = loadsIn.length - results.length;
  return { ok: results.every((r) => r.ok) && skipped === 0, loads: results, skipped };
}

/**
 * runCommitBoardImport — the SAME board Save (identical payload + result shape as
 * runCommitBoard) executed through the TWO-LEVER import engine (rebuilt after the Jul 2
 * incident — see the §I contract correction in nuvizz-write-ops.mts).
 *
 * Per order-changing load:
 *   LEVER 1 — MEMBERSHIP. Stops to ADD (unplanned orders / staged cross-load arrivals) are
 *   planned with ONE bulk insertStops by stopId — the REAL records; an existing stop's number
 *   NEVER rides the import (rule 3: the import would CLONE it). Unplans happen declaratively
 *   by omission from lever 2 (the omitted on-load record survives, data intact). After an
 *   insert the load is RE-READ so lever 2 echoes the arrivals' actual on-load records.
 *   LEVER 2 — ORDER. One import whose stops[] are FULL ECHOES (importEchoFromRaw — freight +
 *   references + from-block; rule 2: a matched stop is full-replaced, so a partial entry
 *   blanks fields) in the exact desired order, then the convergence recipe, then
 *   assign/dispatch. Brand-new orders (newStops rows) may ride the import as full payloads
 *   ONLY after a per-number existence read proves the number absent (a collision would
 *   clone). A STRUCTURAL GUARD refuses any entry whose number is not on the just-read load
 *   (or proven-absent-new) — the clone case is unrepresentable, not just avoided.
 *
 * Loads the import path can't or shouldn't handle fall back to the UNCHANGED legacy engine
 * in the same Save: emptyLoad (cancel — NEVER an empty import), assign/dispatch-only, a
 * loadId-only add with no resolvable load number (#328), and any load whose number can't be
 * resolved. Cross-load moves run sources-before-destinations (the source's omission-unplan
 * must CONVERGE before the destination inserts); a genuine cycle (a swap) is refused — save
 * it as two steps. The steal guard (stop still planned on a load outside this Save) matches
 * the legacy engine's.
 */
export async function runCommitBoardImport(requester: RequesterLike, payload: any, creds: WriteCreds, pacing?: ImportPacing): Promise<any> {
  const loadsIn: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
  if (!loadsIn.length) return { ok: true, loads: [], orphaned: [] };
  // Board pacing: QUICK mode — fire the import + a short confirm poll, and hand unconfirmed
  // loads back as `pending` for the CLIENT to verify (getLoad polls + re-Save resend). The full
  // resend/reverse recipe cannot fit a sync function's budget (the 10s default killed the first
  // live Save mid-flight); quick keeps a 1-2 load Save well inside the 26s window.
  // ONE confirm poll at ~6s (was 2 polls at 3s): prod's async worker demonstrably takes 30-90s
  // to seat an import, so a 3s poll never confirms and just spends a load/info. The client's
  // backoff ladder (6/10/15/25s) owns the wait; this single poll only catches the fast case.
  const boardPacing: ImportPacing = { pollMs: 6000, phaseWaitMs: 6000, quick: true, ...(pacing || {}), ...(payload?.convergence || {}) };
  const clientOrigin = payload?.origin ?? payload?.settings?.origin ?? null;
  // INLINE STOP CREATION (work item A): a Save may carry per-load `newStops` (StopRow-shaped
  // rows for orders that do NOT exist in NuVizz yet). Those ride the import's stops[] as FULL
  // payloads (buildStopPayload) — the §10.1 create-with-order contract makes ONE import create
  // the load AND its stops. No per-stop stop/sync/update pre-creates, no stop/info echo reads.
  // Building a full payload needs the batch's OriginSettings: payload.settings = { origin:
  // {name,addr1,city,state,zip[,addr2]}, serviceDate:'YYYY-MM-DD'[, timeZone] }.
  const stopSettings = (payload?.settings?.origin && payload?.settings?.serviceDate) ? payload.settings : null;

  const legacy: any[] = [];   // loads the legacy engine keeps handling (see doc above)
  const imp: any[] = [];      // { L, loadNbr, load(normalized), refs[], curNbrs:Set, result }
  const batchNbrs = new Set<string>();
  for (const l of loadsIn) { const v = String(l?.loadNbr ?? '').trim(); if (v && !isHashLikeId(v)) batchNbrs.add(v); }

  // ── resolve + read + build refs per order-changing load ──
  for (const L of loadsIn) {
    const orderedNbrs: string[] | null = Array.isArray(L?.orderedStopNbrs) ? L.orderedStopNbrs.map((x: any) => String(x)).filter(Boolean) : null;
    if (L?.emptyLoad === true || !orderedNbrs || orderedNbrs.length === 0) { legacy.push(L); continue; }
    const result: any = { loadNbr: L?.loadNbr ?? null, ok: true, steps: [], error: null };

    // Inline-new rows for THIS load, keyed by normalized stopNbr (item A). Each row is
    // StopRow-shaped and MUST carry its stopNbr (the order number is the convergence key).
    const newRows = new Map<string, any>();
    for (const row of (Array.isArray(L?.newStops) ? L.newStops : [])) {
      const n = row?.stopNbr != null && String(row.stopNbr).trim() !== '' ? normStopNbr(row.stopNbr) : '';
      if (n) newRows.set(n, row);
    }
    if (newRows.size && !stopSettings) {
      result.ok = false; result.error = 'commitBoard(import): newStops need payload.settings ({origin, serviceDate}) to build full stop payloads';
      imp.push({ L, loadNbr: L?.loadNbr ?? null, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
    }

    // A card with NEITHER identifier could probe-resolve a cross-load arrival's SOURCE load and
    // then declaratively rebuild the WRONG load — refuse up front (same rule as the legacy engine).
    if (!L?.loadNbr && !L?.loadId) {
      result.ok = false; result.error = 'commitBoard(import): loadNbr or loadId required';
      imp.push({ L, loadNbr: null, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
    }

    // Resolve the human load number (same ladder as the legacy engine).
    let loadNbrX = (L?.loadNbr != null && String(L.loadNbr).trim() !== '' && !isHashLikeId(String(L.loadNbr))) ? String(L.loadNbr) : null;
    if (!loadNbrX && orderedNbrs[0]) loadNbrX = await resolveLoadNbrByStopNbr(requester, orderedNbrs[0], creds);
    if (!loadNbrX && trustableLoadId(L?.loadId)) loadNbrX = await resolveLoadNbrById(requester, L.loadId, creds);
    if (!loadNbrX && trustableLoadId(L?.loadId) && orderedNbrs[0]) {
      // EMPTY Draft load known only by its internal id (the live-tenant state that refused every
      // build-from-unplanned Save): SEED it with the first desired stop via loadId-keyed
      // insertstops, then read the stop back for the load's real number. The import rebuild that
      // follows seats the seeded stop in its proper slot.
      const seed = await resolveLoadNbrBySeeding(requester, L.loadId, orderedNbrs[0], creds);
      result.steps.push({ op: 'seedLoad', ok: !!seed.loadNbr, seeded: seed.seeded, loadNbr: seed.loadNbr, error: seed.error || null });
      if (seed.loadNbr) {
        loadNbrX = seed.loadNbr;
        // Surface the physical side effect: even if a later step fails, the dispatcher must know
        // this stop is now PLANNED on this load (re-Saving the SAME card self-heals).
        result.seededStopNbr = orderedNbrs[0]; result.seededLoadNbr = seed.loadNbr;
      }
      else { result.ok = false; result.error = `commitBoard(import): ${seed.error || 'could not resolve the load number'}`; imp.push({ L, loadNbr: null, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue; }
    }
    if (!loadNbrX) { legacy.push(L); continue; }   // e.g. loadId-only pure add — the #328 legacy path still works
    result.loadNbr = loadNbrX;

    const f = await fetchLoad(requester, loadNbrX, creds);
    const allInline = newRows.size > 0 && orderedNbrs.every((n) => newRows.has(normStopNbr(n)));
    let load = f.load;
    let createMode = false;
    if (!load) {
      // CREATE MODE (item A): a load number NuVizz doesn't know + EVERY ordered stop supplied
      // inline = a brand-new load built by ONE import (§10.1 create-with-order: new loadNbr +
      // full stop payloads creates the load AND its stops). Anything else unresolved is still
      // an error — a rebuild needs the load's own record to echo from.
      if (!allInline) {
        result.ok = false; result.error = `commitBoard(import): load not found (${loadMissDiag(loadNbrX, f)})`;
        imp.push({ L, loadNbr: loadNbrX, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
      }
      createMode = true;
    }
    // A CREATE aimed at a load that already EXISTS with deliveries would declaratively REBUILD it
    // (the import would replace its whole stop set) — refuse; that edit belongs on the board.
    if (load && L?.createNew === true) {
      const existing = (load.stops || []).filter((s: any) => s?.stopNbr != null && String(s?.stopType ?? 'DO').toUpperCase() !== 'PU');
      if (existing.length) {
        result.ok = false; result.error = `commitBoard(import): load ${loadNbrX} already carries ${existing.length} stop(s) — a new-load create would rebuild it; open it from the board to edit it instead`;
        imp.push({ L, loadNbr: loadNbrX, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
      }
    }
    // Same wrong-instance guard as the legacy engine: a recurring NAME resolving to a different
    // day's load must never be rebuilt. (Create mode resolved nothing, so there is nothing to check.)
    if (load && L?.loadId && load.loadId && String(load.loadId) !== String(L.loadId)) {
      result.ok = false; result.error = `commitBoard(import): load identity mismatch (name resolved ${load.loadId}, expected ${L.loadId})`;
      imp.push({ L, loadNbr: loadNbrX, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
    }
    // Only an IDENTITY-VERIFIED number may vouch for the steal guard — adding it before the check
    // above could let a mis-resolved number bless pulls off a load that isn't really in this Save.
    batchNbrs.add(loadNbrX);

    const rawByNbr = new Map<string, any>();
    for (const rs of (load?.rawStops || [])) { const st = rs?.stop || rs || {}; if (st.stopNbr != null) rawByNbr.set(String(st.stopNbr), rs); }

    // ── TWO-LEVER CLASSIFICATION (Jul 2 correction) ──
    // Every ordered stop is exactly one of:
    //   ON-LOAD  → an import entry, built later as a FULL ECHO of the (fresh) load read;
    //   ARRIVAL  → an EXISTING stop not on this load. NEVER an import entry (rule 3: the
    //              import would CLONE it) — it is planned with insertStops by stopId (the
    //              REAL record) in the fire phase, then echoed off the post-insert re-read;
    //   INLINE   → a brand-new order (newStops row) whose number is PROVEN ABSENT by a
    //              per-number existence read — the import creates it (full payload).
    // ARRIVAL reads run IN PARALLEL (getStop resolves stopId + the steal guard); INLINE
    // existence gates run in the same sweep. Any other number refuses the load.
    const inlineNbrs = orderedNbrs.filter((n) => !rawByNbr.has(n) && newRows.has(normStopNbr(n)));
    const missing = orderedNbrs.filter((n) => !rawByNbr.has(n) && !newRows.has(normStopNbr(n)));
    const fetched = new Map<string, any>(await Promise.all([...missing, ...inlineNbrs].map(async (n): Promise<[string, any]> => {
      try { return [n, await fireSingle(requester, 'getStop', { stopNbr: n }, creds)]; }
      catch (e: any) { return [n, { ok: false, error: e?.message || 'getStop failed' }]; }
    })));
    const arrivals: Array<{ nbr: string; stopId: string; srcLoadNbr?: string }> = [];
    const newAbsent = new Set<string>();   // normalized inline numbers PROVEN absent (safe to create)
    const originDonors: any[] = [];   // "from" addresses off the added stops — origin for an EMPTY load
    // Service date for synthesized echo windows (an echo entry is address + schedule at minimum).
    const svcDate = (String(load?.loadHeader?.earliestStartDttm || '').match(/^\d{4}-\d{2}-\d{2}/) || [null])[0]
      || (stopSettings ? String(stopSettings.serviceDate) : null);
    let err: string | null = null;
    for (const nbr of orderedNbrs) {
      if (rawByNbr.has(nbr)) continue;   // ON-LOAD — echoed in the fire phase
      const rowNew = newRows.get(normStopNbr(nbr));
      if (rowNew) {
        // INLINE CREATION — allowed ONLY when the number exists nowhere. A colliding number
        // would make the import CLONE the existing record (rule 3), so a found stop refuses
        // the load; only an explicit 404 proves absence (a transient read failure must never
        // be read as "absent" — that is exactly the clone hole).
        const gs = fetched.get(nbr);
        if (gs?.ok && gs.stop?.stopId) {
          err = `commitBoard(import): order # ${nbr} already exists in NuVizz (stop id ${gs.stop.stopId}) — creating it inline would CLONE it; plan the existing order from the board instead`; break;
        }
        if (!(gs?.httpStatus === 404)) {
          err = `commitBoard(import): could not verify order # ${nbr} is new (stop read ${gs?.httpStatus ?? 'failed'}) — refusing to create it (a collision would clone)`; break;
        }
        newAbsent.add(normStopNbr(nbr));
        const full = buildStopPayload({ ...rowNew, stopNbr: String(rowNew.stopNbr) }, stopSettings);
        if (full?.from?.address) originDonors.push({ stop: { from: { address: full.from.address } } });
        continue;
      }
      // ARRIVAL — an existing stop to PLAN here (insertStops, the real record). Steal guard
      // unchanged: its source must be this load or a load in this Save.
      const gs = fetched.get(nbr);
      const srcNbr = gs?.ok ? String(gs.stop?.assignedLoadNbr ?? '').trim() : '';
      if (!gs?.ok || !gs.stop?.stopId) { err = `commitBoard(import): stop ${nbr} could not be read for planning (stale board — refresh and retry)`; break; }
      if (srcNbr && srcNbr !== loadNbrX && !batchNbrs.has(srcNbr)) {
        err = `commitBoard(import): stop ${nbr} is still planned on load ${srcNbr}, which is not part of this Save — open that load in Compare so the move is staged`; break;
      }
      if (gs.stop.fromAddress) originDonors.push({ stop: { from: { address: gs.stop.fromAddress } } });
      arrivals.push({ nbr, stopId: String(gs.stop.stopId), srcLoadNbr: srcNbr && srcNbr !== loadNbrX ? srcNbr : undefined });
    }
    if (err) { result.ok = false; result.error = err; imp.push({ L, loadNbr: loadNbrX, arrivals: [], orderedNbrs, curNbrs: new Set(), result }); continue; }
    imp.push({ L, loadNbr: loadNbrX, load, createMode, orderedNbrs, arrivals, newAbsent, svcDate, originDonors, curNbrs: new Set(rawByNbr.keys()), result, addReads: missing.length + inlineNbrs.length });
  }

  // ── legacy subset (unchanged engine) ──
  const legacyResult = legacy.length
    ? await runCommitBoard(requester, { ...payload, loads: legacy }, creds)
    : { ok: true, loads: [], orphaned: [] };

  // ── order the imports: sources before destinations (a destination's arrival must be freed
  //    by its source's import first; a stop is never "stolen" while still planned elsewhere) ──
  const live = imp.filter((p) => p.result.ok);
  const ordered: any[] = [];
  const pending = new Set(live);
  // A load p WAITS ON load q when one of p's ARRIVALS is coming off q (q must unplan it —
  // via its own import's omission — before p may insertStops it; the real record can only
  // be on one load).
  const waitsOnQ = (p: any, q: any) => q !== p && p.arrivals.some((a: any) =>
    (a.srcLoadNbr && String(q.loadNbr) === String(a.srcLoadNbr)) || q.curNbrs.has(a.nbr));
  while (pending.size) {
    let emitted = false;
    for (const p of [...pending]) {
      const waitsOn = [...pending].some((q) => waitsOnQ(p, q));
      if (!waitsOn) { ordered.push(p); pending.delete(p); emitted = true; }
    }
    if (!emitted) {   // a cycle (e.g. two loads swapping stops) — refuse those loads, keep the rest honest
      for (const p of pending) { p.result.ok = false; p.result.error = 'commitBoard(import): circular cross-load move (a swap) — save it in two steps'; }
      pending.clear();
    }
  }

  // ── one import per load (+ convergence), then assign/dispatch ──
  // With MULTIPLE import loads, the fixed confirm budget can't cover them inside one function
  // window — fire each import and return them ALL as pending immediately; the client verifier
  // polls every load anyway. (Single-load Saves keep the in-function quick confirm.)
  const perLoadPacing: ImportPacing = ordered.length > 1 ? { ...boardPacing, skipConfirm: true } : boardPacing;
  // Track per-load outcome so a DESTINATION never fires while a load it depends on hasn't
  // CONFIRMED freeing its stop — a pending/failed/refused source must halt its destinations
  // (the cross-load "steal" is untested and never relied on; matches runCommitImport's break).
  const outcome = new Map<string, string>();   // loadNbr → 'converged' | 'pending' | 'failed'
  for (const p of imp) if (!p.result.ok && p.loadNbr) outcome.set(String(p.loadNbr), 'failed');
  const dependsOnUnconfirmed = (p: any) => imp.some((q) => q !== p && q.loadNbr
    && waitsOnQ(p, q)
    && outcome.get(String(q.loadNbr)) !== 'converged');
  for (const p of ordered) {
    if (dependsOnUnconfirmed(p)) {
      p.result.ok = false;
      p.result.error = 'commitBoard(import): a load this move depends on has not confirmed yet — Save again once it lands';
      outcome.set(String(p.loadNbr), 'failed');
      continue;
    }
    let loadId: any = trustableLoadId(p.L?.loadId) ? p.L.loadId : (p.load?.loadId ?? null);
    let inserts = 0, extraInfos = 0;
    try {
      // ── LEVER 1: MEMBERSHIP — plan the arrivals with ONE bulk insertStops (the REAL records,
      // by stopId; bulk geo-scrambles the order but lever 2 owns ordering). Then RE-READ the
      // load so the ordering entries echo the arrivals' actual on-load records. An arrival is
      // NEVER an import entry (Jul 2 rule 3: the import would clone it).
      let loadX = p.load;   // normalized load whose rawStops feed the echoes (null in create mode)
      if (p.arrivals.length) {
        if (!loadId) { p.result.ok = false; p.result.error = 'commitBoard(import): loadId unresolved for insertStops'; outcome.set(String(p.loadNbr), 'failed'); continue; }
        const ins = await fireSingle(requester, 'insertStops', { insertStopIds: p.arrivals.map((a: any) => a.stopId), loadId }, creds);
        inserts = 1;
        p.result.steps.push({ op: 'insertStops', ok: !!ins.ok, stopIds: p.arrivals.map((a: any) => a.stopId), result: ins, error: ins.ok ? null : (ins.error || 'failed') });
        if (!ins.ok) { p.result.ok = false; p.result.error = `commitBoard(import): planning ${p.arrivals.length} stop(s) failed: ${ins.error || 'insertStops failed'}`; outcome.set(String(p.loadNbr), 'failed'); continue; }
        const f2 = await fetchLoad(requester, String(p.loadNbr), creds);
        extraInfos = 1;
        if (!f2.load) { p.result.ok = false; p.result.error = `commitBoard(import): load unreadable after planning (${loadMissDiag(p.loadNbr, f2)}) — the ${p.arrivals.length} stop(s) ARE planned; Save again to set the order`; outcome.set(String(p.loadNbr), 'failed'); continue; }
        loadX = f2.load;
      }

      // ── LEVER 2: ORDER — one import whose entries are FULL ECHOES of the load's own records
      // (freight + references included; a partial entry would blank fields on the matched stop),
      // plus full payloads for the PROVEN-ABSENT inline creations. STRUCTURAL GUARD: any other
      // number refuses the import — an off-load number in stops[] is exactly the clone bug.
      const rawByNbr2 = new Map<string, any>();
      for (const rs of (loadX?.rawStops || [])) { const st = rs?.stop || rs || {}; if (st.stopNbr != null) rawByNbr2.set(String(st.stopNbr), rs); }
      const stops: any[] = [];
      let entryErr: string | null = null;
      for (const nbr of p.orderedNbrs) {
        const raw = rawByNbr2.get(nbr);
        if (raw) {
          const echo = importEchoFromRaw(raw, p.svcDate);
          if (!echo) { entryErr = `commitBoard(import): stop ${nbr} on load ${p.loadNbr} has no usable delivery address to echo — refresh and retry`; break; }
          stops.push(echo);
          continue;
        }
        const rowNew = p.newAbsent?.has(normStopNbr(nbr)) ? (Array.isArray(p.L?.newStops) ? p.L.newStops.find((r: any) => normStopNbr(r?.stopNbr) === normStopNbr(nbr)) : null) : null;
        if (rowNew) { stops.push(buildStopPayload({ ...rowNew, stopNbr: String(rowNew.stopNbr) }, stopSettings)); continue; }
        entryErr = `commitBoard(import): stop ${nbr} is not on load ${p.loadNbr} after planning — refusing to import it (an off-load number would be CLONED); Save again`;
        break;
      }
      if (entryErr) { p.result.ok = false; p.result.error = entryErr; outcome.set(String(p.loadNbr), 'failed'); continue; }

      // CREATE MODE: nothing to echo — synthesize the minimal raw header (loadNbr + routeName);
      // dates derive from the service date, origin from the inline stops' "from" blocks (or the
      // client ship-from) via assembleImportHeader's donor ladder.
      const rawHeader = loadX?.loadHeader
        ?? { loadNbr: p.loadNbr, routeName: p.L?.routeName != null && String(p.L.routeName).trim() !== '' ? String(p.L.routeName) : undefined };
      const header = assembleImportHeader(rawHeader, [...(loadX?.rawStops || []), ...(p.originDonors || [])], clientOrigin,
        // Service-date fallback: the first entry's delivery window date (echoed from NuVizz).
        String(stops[0]?.to?.schedule?.timeFrom || '').slice(0, 10) || p.svcDate || null);
      const r = await runImportLoad(requester, { load: { loadHeader: header, stops }, convergence: perLoadPacing }, creds, perLoadPacing);
      p.result.steps.push(...(r.steps || []));
      p.result.requestedOrder = r.requestedOrder || null;
      if (r.stopIds) p.result.stopIds = r.stopIds;   // stopNbr → internal id, harvested free (item A)
      // Per-save call anatomy (directive #4): imports/polls from the executor + this load's own
      // pre-read + the post-insert re-read + per-stop reads (arrival resolution / existence
      // gates) + the membership insert, so the journal shows the full cost.
      p.result.calls = { updates: r.calls?.updates ?? 0, infos: (r.calls?.infos ?? 0) + 1 + extraInfos, stopInfos: p.addReads || 0, inserts };
      outcome.set(String(p.loadNbr), r.pending ? 'pending' : (r.ok ? 'converged' : 'failed'));
      if (r.pending) {
        // Import fired + accepted, not yet CONFIRMED. The client verifies (getLoad polls +
        // re-Save resend) — assign/dispatch wait until the order is confirmed, so a driver is
        // never dispatched onto an unverified route. Staged driver/dispatch survive on the card.
        p.result.pending = true; p.result.ok = false; continue;
      }
      if (!r.ok) { p.result.ok = false; p.result.error = r.error || 'import did not converge'; continue; }
      loadId = r.loadId ?? loadId;
    } catch (e: any) {
      p.result.ok = false; p.result.error = e?.message || 'import build failed';
      outcome.set(String(p.loadNbr), 'failed');
      continue;
    }
    if (hasDriverId(p.L?.driverId)) {
      if (!loadId) { p.result.ok = false; p.result.error = 'commitBoard(import): loadId unresolved for assignDriver'; continue; }
      const r = await fireSingle(requester, 'assignDriver', { routeId: loadId, driverId: p.L.driverId }, creds);
      p.result.steps.push({ op: 'assignDriver', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) { p.result.ok = false; continue; }
    }
    if (p.L?.dispatch) {
      if (!loadId) { p.result.ok = false; p.result.error = 'commitBoard(import): loadId unresolved for dispatch'; continue; }
      const r = await fireSingle(requester, 'dispatchLoad', { routeId: loadId }, creds);
      p.result.steps.push({ op: 'dispatchLoad', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) p.result.ok = false;
    }
  }

  const loads = [
    ...(legacyResult.loads || []),
    ...imp.map((p) => ({
      loadNbr: p.result.loadNbr ?? p.loadNbr, loadId: p.load?.loadId ?? p.L?.loadId ?? null,
      ok: p.result.ok, error: p.result.error, steps: p.result.steps,
      // pending + requestedOrder drive the CLIENT's convergence verification (getLoad polls).
      pending: p.result.pending || undefined, requestedOrder: p.result.requestedOrder || undefined,
      // stopNbr → NuVizz internal id, harvested from the converged read-back (item A).
      stopIds: p.result.stopIds || undefined,
      // Per-save anatomy (directive #4): updates/infos/stopInfos/inserts for THIS load.
      calls: p.result.calls || undefined,
      // A seed physically planned this stop on this load — surfaced so a failed Save can never
      // read as "nothing happened" and the orders get re-staged elsewhere.
      seededStopNbr: p.result.seededStopNbr || undefined, seededLoadNbr: p.result.seededLoadNbr || undefined,
    })),
  ];
  return { ok: loads.every((l: any) => l.ok) && (legacyResult.orphaned || []).length === 0, loads, orphaned: legacyResult.orphaned || [] };
}

export async function runOp(requester: RequesterLike, op: WriteOp, payload: any, creds: WriteCreds): Promise<any> {
  switch (op) {
    // The Compare panel's Save: the in-panel toggle sends useImport on the payload, but since
    // the Jul 2 incident the import engine ALSO needs the server's explicit re-enable
    // (NUVIZZ_LOAD_IMPORT=1) — otherwise every Save runs the classic anchor engine.
    case 'commitBoard': return (payload?.useImport === true && !loadImportBlocked())
      ? runCommitBoardImport(requester, payload, creds)
      : runCommitBoard(requester, payload, creds);
    case 'commitLoad': return runCommitLoad(requester, payload, creds);
    case 'removeStops': return runRemoveStops(requester, payload, creds);
    case 'assignDriver':
    case 'dispatchLoad': return runAssignDispatch(requester, op, payload, creds);
    case 'importLoad': return runImportLoad(requester, payload, creds);
    case 'commitImport': return runCommitImport(requester, payload, creds);
    default: return fireSingle(requester, op as SingleOp, payload, creds);
  }
}

function req<T>(v: T, label: string): T {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) throw new Error(`missing required field — ${label}`);
  return v;
}
