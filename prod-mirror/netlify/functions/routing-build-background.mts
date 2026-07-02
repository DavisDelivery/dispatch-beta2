// netlify/functions/routing-build-background.mts
//
// Async build-job orchestration (Section 5/6). BACKGROUND function: the model +
// Google calls plus the solve/repair can exceed the 26s request cap, so the work
// runs here and the client polls the routing_jobs/{jobId} doc it created.
//
// Flow: client writes routing_jobs/{jobId} { status:'queued', request } and POSTs
// { jobId } here → we mark running, resolve the selected stops (live cache, READ-only)
// + their equipment restrictions (customer_notes) + the chosen truck profiles, run
// the five-stage pipeline with real deps (Google matrix + Opus, each gated by its
// key), and write { status:'done', result } or { status:'error', error }.
//
// GUARDRAILS: NuVizz is never written. We only READ nuvizz_stop_index and
// customer_notes. Nothing here touches the refresh functions or Phase 1 history.

import { isFirestoreEnabled, readStops } from './lib/firestore.mts';
import { getJob, updateJob } from './lib/routing-store.mts';
import { profileToSolverTruck, getTruckProfile, type TruckProfile } from './lib/truck-profiles.mts';
import { runPipeline, type PipelineRequest, type PipelineStopInput } from './lib/routing-pipeline.mts';
import { resolveMatrix } from './google-route-matrix.mts';
import { isAnthropicEnabled, parseIntentModel, geometryAssistModel, explainModel } from './anthropic-routing.mts';
import { DEPOT, type EquipmentReq, type SolverTruck } from './lib/routing-types.mts';
import { getDoc } from './lib/firestore.mts';
import { normalizeMatchKey } from '../../src/lib/matchKey.js';
import { withDeadline } from './lib/async-util.mts';

// Overall job deadline (belt-and-suspenders with the per-call 8s timeouts). A
// normal deterministic build finishes in well under a second; this only fires if
// something pathological stalls the pipeline.
const BUILD_DEADLINE_MS = 25000;
// When AI assist is ON, hard-cap the number of per-stop geometry model calls so it
// can never become an unbounded sequential loop. Off by default → never runs.
const GEO_ASSIST_CAP = 10;

const KNOWN_REQS = new Set<EquipmentReq>([
  'no_tractor_trailer', 'uline_straight_truck', 'straight_truck_only', 'box_truck_only',
  '26ft_max', 'no_53', 'no_overhead_clearance', 'liftgate_required',
]);

// Equipment requirements a 53' tractor-trailer can't satisfy. A dispatcher's
// explicit "tractor OK" (green) mark suppresses these — green wins over an
// auto-detected restriction. Liftgate is orthogonal and is never suppressed.
const TRAILER_BLOCKERS = new Set<EquipmentReq>([
  'no_tractor_trailer', 'uline_straight_truck', 'straight_truck_only', 'box_truck_only',
  '26ft_max', 'no_53', 'no_overhead_clearance',
]);

async function equipmentReqsFor(stop: any, opts?: { tractorOnlyGreen?: boolean }): Promise<EquipmentReq[]> {
  try {
    const key = normalizeMatchKey(stop.businessName, stop.addr1, stop.city, stop.zip);
    const note = await getDoc(`customer_notes/${key}`);
    let reqs: EquipmentReq[] = [];
    const arr = note?.equipment_restrictions;
    if (Array.isArray(arr)) for (const r of arr) if (KNOWN_REQS.has(r)) reqs.push(r);
    if (note?.liftgate_required === true && !reqs.includes('liftgate_required')) reqs.push('liftgate_required');
    // Dispatcher-set vehicle eligibility (the Routing green/red marking — a property
    // of the LOCATION). Green ('tractor') = a 53' fits → drop any trailer-blocking
    // restriction (green wins over an auto-detected one). Red ('box_only') → force a
    // straight/box truck. And when the build opts into "trailer = green only", any
    // stop NOT marked green is held to a box truck too, so only green rides a 53'.
    const elig = note?.vehicle_eligibility;
    if (elig === 'tractor') {
      reqs = reqs.filter((r) => !TRAILER_BLOCKERS.has(r));
    } else if (elig === 'box_only' || opts?.tractorOnlyGreen === true) {
      if (!reqs.includes('box_truck_only')) reqs.push('box_truck_only');
    }
    return reqs;
  } catch { return []; }
}

// Resolve the pipeline's stop inputs from selectedStopIds against the live cache.
async function resolveStops(tenant: string, date: string, selectedStopIds: string[], opts?: { tractorOnlyGreen?: boolean }): Promise<PipelineStopInput[]> {
  const { stops } = await readStops(tenant, date);
  const byId = new Map(stops.map((s: any) => [String(s.stopNbr), s]));
  const want = new Set(selectedStopIds.map(String));
  const out: PipelineStopInput[] = [];
  for (const id of want) {
    const s = byId.get(id);
    if (!s || s.lat == null || s.lng == null) continue; // unmappable → skip (surfaced as missing)
    out.push({
      stopNbr: s.stopNbr, lat: Number(s.lat), lng: Number(s.lng),
      pallets: s.pallets, weight: s.weight, weightUOM: s.weightUOM,
      stopDetails: s.stopDetails || [],
      signalSources: s.signalSources || null, addr2: s.addr2 || null,
      scheduledFrom: s.scheduledFrom || null, scheduledTo: s.scheduledTo || null,
      timeConstraint: s.timeConstraint || null,
      equipmentReqs: await equipmentReqsFor(s, opts),
      businessName: s.businessName || null,
    });
  }
  return out;
}

async function resolveTrucks(profileIds: string[]): Promise<SolverTruck[]> {
  const trucks: SolverTruck[] = [];
  for (const id of profileIds) {
    const p = (await getTruckProfile(id)) as TruckProfile | null;
    if (p) trucks.push(profileToSolverTruck(p));
  }
  return trucks;
}

export default async function handler(req: Request): Promise<Response> {
  const json = (b: any, s = 202) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return json({ ok: false, error: 'FIREBASE_SA not set' }, 200);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const jobId = body?.jobId;
  if (!jobId) return json({ ok: false, error: 'jobId required' }, 400);

  const job = await getJob(jobId);
  if (!job) return json({ ok: false, error: 'job not found' }, 404);

  // P0 FIX: AWAIT the work to completion. This is a *-background function — the
  // platform already returned 202 to the client; the handler is allowed to run
  // for minutes. Previously the work ran in an un-awaited IIFE and the handler
  // returned immediately, so the runtime could freeze/recycle the instance before
  // the job was written → status stuck at 'running' forever (the hang). Now every
  // path ends at 'done' or 'error'.
  try {
    await updateJob(jobId, { status: 'running', stage: 'resolve', started_at: new Date().toISOString() });
    const r = job.request || {};
    const tenant = r.tenant || 'davis';
    const date = r.date;
    const tractorOnlyGreen = r.tractorOnlyGreen === true;
    // Eligibility rules (box_only / green override / tractorOnlyGreen) are applied in
    // equipmentReqsFor, which runs via resolveStops. The direct r.stops path is a caching
    // shortcut the client does not currently use (it always sends selectedStopIds); a
    // future caller that pre-resolves r.stops must bake the eligibility reqs in itself,
    // since this path bypasses equipmentReqsFor.
    const stops: PipelineStopInput[] = Array.isArray(r.stops) && r.stops.length
      ? r.stops
      : await resolveStops(tenant, date, r.selectedStopIds || [], { tractorOnlyGreen });
    const trucks = Array.isArray(r.trucks) && r.trucks.length ? r.trucks : await resolveTrucks(r.truckProfileIds || []);

    if (!stops.length) { await updateJob(jobId, { status: 'error', error: 'no mappable stops selected', finished_at: new Date().toISOString() }); return json({ ok: true, jobId, accepted: true }); }
    if (!trucks.length) { await updateJob(jobId, { status: 'error', error: 'no truck profiles selected', finished_at: new Date().toISOString() }); return json({ ok: true, jobId, accepted: true }); }

    await updateJob(jobId, { stage: 'build' });
    // Cheap by default (Appendix B): haversine unless the build explicitly opts
    // into 'google'. resolveMatrix honors the mode; absent → haversine.
    const matrixMode = r.matrixMode === 'google' ? 'google' : 'haversine';
    // Appointment windows are ADVISORY by default (flag, don't spill). Kill switch
    // back to strict via the request or an env (ROUTING_WINDOWS=strict).
    const windowMode = (r.windowMode === 'strict' || process.env.ROUTING_WINDOWS === 'strict') ? 'strict' : 'advisory';

    // P1 FIX: the Opus model is OPT-IN, default OFF — exactly parallel to the
    // Google matrix opt-in. The deps are passed ONLY when the build explicitly
    // asks for it AND the key exists; otherwise the pipeline runs its fully
    // deterministic paths (deterministic intent, deterministic geometry with NO
    // per-stop model calls, deterministic explanation). A default build makes
    // ZERO model calls.
    const aiOn = r.aiAssist === true && isAnthropicEnabled();
    // P3 FIX: even when on, hard-cap per-stop geometry model calls.
    let geoCalls = 0;
    const cappedGeometryAssist = aiOn
      ? async (stop: any) => { if (geoCalls >= GEO_ASSIST_CAP) return null; geoCalls++; return geometryAssistModel(stop); }
      : undefined;

    const pipelineReq: PipelineRequest = {
      stops, trucks,
      depot: r.depot || { lat: DEPOT.lat, lng: DEPOT.lng },
      intentText: r.intent || r.intentText || '',
      strategy: r.strategy || 'MIN_DISTANCE',
      objectiveWeights: r.objectiveWeights,
      date, departHHMM: r.departHHMM, serviceMin: r.serviceMin,
      matrixMode, windowMode,
    };
    // P4 FIX: overall watchdog. If the pipeline somehow overruns, reject with a
    // clear, client-actionable message so the UI stops polling.
    const plan = await withDeadline(
      runPipeline(pipelineReq, {
        buildMatrix: async (depot, pts) => resolveMatrix(depot, pts, matrixMode),
        parseIntent: aiOn ? parseIntentModel : undefined,
        geometryAssist: cappedGeometryAssist,
        explain: aiOn ? explainModel : undefined,
      }),
      BUILD_DEADLINE_MS,
      'build timed out — try fewer stops',
    );

    await updateJob(jobId, {
      status: 'done',
      finished_at: new Date().toISOString(),
      result: { ...plan, aiConfigured: aiOn },
    });
  } catch (e: any) {
    console.error('routing-build:', e?.message);
    await updateJob(jobId, { status: 'error', error: e?.message || 'build failed', finished_at: new Date().toISOString() });
  }

  return json({ ok: true, jobId, accepted: true });
}
