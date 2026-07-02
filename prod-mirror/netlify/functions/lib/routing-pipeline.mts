// lib/routing-pipeline.mts
//
// The five-stage build pipeline (Section 5), wired with INJECTED dependencies so
// the whole thing is unit-testable with a mock matrix and mock model — and so it
// degrades to deterministic-only when a dependency is absent.
//
//   P1 parseIntent (opt, model) → { strategy, objectiveWeights, extraConstraints }
//   P2 buildMatrix (model/Google) → duration + distance matrices
//   P3 solve (deterministic)      → candidate routes + spill
//   P4 repair (deterministic)     → provably-valid routes + final spill
//   P5 explain (opt, model)       → rationale + risk flags (else deterministic summary)
//
// The model NEVER runs per-stop in a loop: parseIntent is one call, geometry assist
// hits only ambiguous stops (cached), explain is one call.

import {
  DEFAULT_OBJECTIVE_WEIGHTS, DEFAULT_SERVICE_MIN, DEFAULT_DEPART_HHMM, DEPOT,
  DEFAULT_MATRIX_MODE, matrixElementCount, estimateMatrixCostUsd,
  type SolverStop, type SolverTruck, type SolverInput, type SolverMatrix,
  type Strategy, type ObjectiveWeights, type EquipmentReq, type BuiltRoute, type MatrixMode,
  type WindowMode, DEFAULT_WINDOW_MODE,
} from './routing-types.mts';
import { deriveGeometryForStops, type GeometryAssist } from './freight-geometry.mts';
import { parseIntentResponse, parseGeometryAssist } from './routing-intent.mts';
import { solveRouting } from './routing-solver.mts';
import { repair } from './routing-repair.mts';

export interface PipelineStopInput {
  stopNbr?: string;
  id?: string;
  lat: number;
  lng: number;
  pallets?: number | null;
  weight?: number | null;
  weightUOM?: string | null;
  stopDetails?: any[];
  signalSources?: { orderInstructions?: string | null } | null;
  addr2?: string | null;
  scheduledFrom?: string | null;  // "HH:MM"
  scheduledTo?: string | null;    // "HH:MM"
  timeConstraint?: string | null; // "STRICT" | soft
  equipmentReqs?: EquipmentReq[];
  businessName?: string | null;
}

export interface PipelineRequest {
  stops: PipelineStopInput[];
  trucks: SolverTruck[];
  depot?: { lat: number; lng: number };
  intentText?: string;
  strategy?: Strategy;
  objectiveWeights?: ObjectiveWeights;
  date?: string;            // YYYY-MM-DD (for window epochs)
  departHHMM?: string;
  serviceMin?: number;
  matrixMode?: MatrixMode;  // 'haversine' (default, free) | 'google' (paid opt-in)
  windowMode?: WindowMode;  // 'advisory' (default, flag) | 'strict' (spill on unmet window)
}

export interface PipelineDeps {
  // May return a bare matrix (legacy) or { matrix, source } so the pipeline can
  // report the ACTUAL source used (Google can fall back to haversine on failure).
  buildMatrix: (depot: { lat: number; lng: number }, stops: { lat: number; lng: number }[]) => Promise<SolverMatrix | { matrix: SolverMatrix; source: string }>;
  parseIntent?: (text: string, strategy: Strategy) => Promise<unknown>;
  geometryAssist?: (stop: any) => Promise<GeometryAssist | null>;
  explain?: (plan: any) => Promise<{ rationale?: string; riskFlags?: string[] } | null>;
}

export interface RoutingPlan {
  routes: BuiltRoute[];
  unassigned: { stopId: string; reasons: string[] }[];
  intent: { strategy: Strategy; objectiveWeights: ObjectiveWeights; extraConstraints: Record<string, unknown>; source: string };
  rationale: string;
  riskFlags: string[];
  aiAssist: { intent: boolean; geometry: boolean; explain: boolean };
  meta: Record<string, unknown>;
  generatedAt: string;
}

function hhmmToEpochSec(date: string | undefined, hhmm: string): number {
  // UTC-anchored so depot departure and all windows share one clock (comparisons
  // stay correct). Wall-clock/ET nuance for display is a UI concern, not the math.
  // Tolerant of "HH:MM", "H:MM", and "HH:MM:SS" (NuVizz sometimes sends seconds).
  const base = date || '1970-01-01';
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const t = Date.parse(`${base}T${m[1].padStart(2, '0')}:${m[2]}:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// A schedule string is a placeholder when empty or midnight ("00:00"/"00:00:00").
function isPlaceholderTime(t: string | null | undefined): boolean {
  const s = String(t ?? '').trim();
  return s === '' || /^0{1,2}:0{2}(:0{2})?$/.test(s);
}

// A stop has a REAL appointment window only if BOTH ends are present, neither is a
// midnight/zero placeholder, both parse, and end > start. Otherwise null — so a
// NuVizz placeholder schedule (00:00/00:00) does NOT become a STRICT window that
// would clobber the optimizer's sequence. Returns { startSec, endSec } | null.
function realWindowSec(date: string | undefined, from: string | null | undefined, to: string | null | undefined): { startSec: number; endSec: number } | null {
  if (!from || !to) return null;
  if (isPlaceholderTime(from) && isPlaceholderTime(to)) return null;
  const startSec = hhmmToEpochSec(date, from);
  const endSec = hhmmToEpochSec(date, to);
  if (!startSec || !endSec || endSec <= startSec) return null; // zero/negative length or unparseable
  return { startSec, endSec };
}

function toSolverStops(
  stops: PipelineStopInput[],
  geo: Map<string, any>,
  date: string | undefined,
  serviceMin: number,
): SolverStop[] {
  return stops.map((s) => {
    const id = s.stopNbr ?? s.id!;
    const g = geo.get(id) ?? { skids: 0, weightLbs: 0, linearFeetIn: 0, oversize: false };
    // REAL-window detection: a placeholder/zero-length schedule yields no window and
    // SOFT, so a normal build has hasStrict=false and orderForTruck re-runs
    // sequence(strategy) — the optimizer's order is what ships.
    const win = realWindowSec(date, s.scheduledFrom, s.scheduledTo);
    const strictFlag = String(s.timeConstraint || '').toUpperCase() === 'STRICT';
    return {
      id,
      lat: s.lat, lng: s.lng,
      skids: g.skids, weightLbs: g.weightLbs, linearFeetIn: g.linearFeetIn, oversize: g.oversize,
      serviceMin,
      timeWindow: win,
      timeConstraint: (win && strictFlag) ? 'STRICT' : 'SOFT',  // STRICT only with a REAL window
      equipmentReqs: s.equipmentReqs || [],
    };
  });
}

function deterministicRationale(plan: { routes: BuiltRoute[]; unassigned: any[] }, strategy: Strategy): string {
  const r = plan.routes;
  const totalStops = r.reduce((a, x) => a + x.orderedStopIds.length, 0);
  const parts = [`${r.length} truck${r.length === 1 ? '' : 's'} routed ${totalStops} stop${totalStops === 1 ? '' : 's'} using ${strategy.replace(/_/g, ' ').toLowerCase()}.`];
  if (plan.unassigned.length) parts.push(`${plan.unassigned.length} stop${plan.unassigned.length === 1 ? '' : 's'} could not be placed (see spill list).`);
  return parts.join(' ');
}

// "HH:MM–HH:MM" (UTC, matching the planning clock) for a STRICT window, or ''.
function windowLabel(s: any): string {
  const w = s?.timeWindow;
  if (!w) return '';
  const hhmm = (sec: number) => new Date(sec * 1000).toISOString().slice(11, 16);
  return `${hhmm(w.startSec)}–${hhmm(w.endSec)}`;
}

function deterministicRiskFlags(input: SolverInput, plan: { routes: BuiltRoute[]; unassigned: any[] }): string[] {
  const flags: string[] = [];
  const stopById = new Map(input.stops.map((s) => [s.id, s]));
  for (const route of plan.routes) {
    if (route.load.skids > route.capacity.skids * 0.9) flags.push(`Truck ${route.truckId}: tight on skids (${route.load.skids}/${route.capacity.skids}).`);
    if (route.load.weightLbs > route.capacity.weightLbs * 0.9) flags.push(`Truck ${route.truckId}: tight on weight (${route.load.weightLbs}/${route.capacity.weightLbs} lb).`);
    if (route.load.linearFeetIn > route.capacity.linearFeetIn * 0.9) flags.push(`Truck ${route.truckId}: tight on deck length.`);
    const violated = new Set(route.windowViolatedIds || []);
    for (const id of route.orderedStopIds) {
      const s = stopById.get(id);
      if (s?.oversize) flags.push(`Stop ${id} is oversize — confirm it fits the assigned truck.`);
      if (s?.equipmentReqs?.length) flags.push(`Stop ${id} has equipment restrictions (${s.equipmentReqs.join(', ')}) — confirm before dispatch.`);
      // Advisory windows: flag only the stops actually OUT OF WINDOW, not every STRICT stop.
      if (violated.has(id)) { const w = windowLabel(s); flags.push(`Stop ${id} is outside its appointment window${w ? ` (${w})` : ''} — kept on the route as advisory.`); }
    }
  }
  if (plan.unassigned.length) flags.push(`${plan.unassigned.length} stop(s) spilled — review reasons.`);
  return [...new Set(flags)];
}

export async function runPipeline(req: PipelineRequest, deps: PipelineDeps): Promise<RoutingPlan> {
  const depot = req.depot || { lat: DEPOT.lat, lng: DEPOT.lng };
  const chosenStrategy: Strategy = req.strategy || 'MIN_DISTANCE';
  const serviceMin = req.serviceMin ?? DEFAULT_SERVICE_MIN;
  const departEpochSec = hhmmToEpochSec(req.date, req.departHHMM || DEFAULT_DEPART_HHMM);

  // ── P1 parseIntent (optional model) ──
  let intentRaw: unknown = null;
  let intentUsed = false;
  if (deps.parseIntent && req.intentText && req.intentText.trim()) {
    try { intentRaw = await deps.parseIntent(req.intentText, chosenStrategy); intentUsed = true; }
    catch { intentRaw = null; intentUsed = false; }
  }
  const intent = parseIntentResponse(intentRaw, chosenStrategy);
  if (req.objectiveWeights) intent.objectiveWeights = req.objectiveWeights; // explicit UI weights win

  // ── geometry (deterministic; model assist only on ambiguous, cached) ──
  let geometryUsed = false;
  const assist = deps.geometryAssist
    ? async (stop: any) => { const r = await deps.geometryAssist!(stop); const p = parseGeometryAssist(r); if (p) geometryUsed = true; return p; }
    : undefined;
  const stopsForGeo = req.stops.map((s) => ({ ...s, stopNbr: s.stopNbr ?? s.id }));
  const geo = await deriveGeometryForStops(stopsForGeo, { assist });

  const solverStops = toSolverStops(req.stops, geo, req.date, serviceMin);

  // ── P2 buildMatrix (depot first, then stops in solverStops order) ──
  const matrixMode: MatrixMode = req.matrixMode === 'google' ? 'google' : DEFAULT_MATRIX_MODE;
  const mres: any = await deps.buildMatrix(depot, solverStops.map((s) => ({ lat: s.lat, lng: s.lng })));
  const matrix: SolverMatrix = mres && mres.matrix ? mres.matrix : mres;
  const matrixSource: string = (mres && mres.source) ? mres.source : matrixMode;
  const googleElementCount = matrixElementCount(solverStops.length);
  const estimatedCostUsd = estimateMatrixCostUsd(googleElementCount, matrixSource);

  const solverInput: SolverInput = {
    stops: solverStops,
    trucks: req.trucks,
    depot,
    matrix,
    strategy: intent.strategy,
    objectiveWeights: intent.objectiveWeights,
    constraints: intent.extraConstraints,
    departEpochSec,
    windowMode: req.windowMode === 'strict' ? 'strict' : DEFAULT_WINDOW_MODE,
  };

  // ── P3 solve + P4 repair (deterministic) ──
  const solved = solveRouting(solverInput);
  const repaired = repair(solverInput, solved);

  // ── P5 explain (optional model; else deterministic summary) ──
  let rationale = deterministicRationale(repaired, intent.strategy);
  let riskFlags = deterministicRiskFlags(solverInput, repaired);
  let explainUsed = false;
  if (deps.explain) {
    try {
      const r = await deps.explain({ routes: repaired.routes, unassigned: repaired.unassigned, strategy: intent.strategy });
      if (r && (r.rationale || r.riskFlags)) {
        if (r.rationale) rationale = r.rationale;
        if (Array.isArray(r.riskFlags) && r.riskFlags.length) riskFlags = r.riskFlags;
        explainUsed = true;
      }
    } catch { /* keep deterministic */ }
  }

  return {
    routes: repaired.routes,
    unassigned: repaired.unassigned,
    intent: { strategy: intent.strategy, objectiveWeights: intent.objectiveWeights, extraConstraints: intent.extraConstraints, source: intent.source },
    rationale,
    riskFlags,
    aiAssist: { intent: intentUsed && intent.source === 'model', geometry: geometryUsed, explain: explainUsed },
    meta: {
      ...repaired.meta, depot, departEpochSec, serviceMin,
      matrixMode, matrixSource, googleElementCount, estimatedCostUsd,
    },
    generatedAt: new Date().toISOString(),
  };
}
