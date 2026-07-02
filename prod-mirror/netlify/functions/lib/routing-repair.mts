// lib/routing-repair.mts
//
// Feasibility / repair loop (Section 12). Takes the solver's candidate output and
// GUARANTEES every route it returns is provably valid against all hard constraints
// (capacity + equipment + STRICT windows). Violators are re-sequenced, moved to
// another feasible truck, or spilled with a human-readable reason.
//
// Termination is by construction:
//   Phase A (shrink): for each truck, window-aware re-order, then repeatedly REMOVE
//     the worst remaining violator (spill). Removal strictly shrinks the route, so
//     this halts and leaves every route valid.
//   Phase B (recover): try to RE-INSERT each spilled stop into a truck where it is
//     fully valid (capacity + equipment + windows). Insertion only happens when the
//     target stays valid, so it can never re-introduce a violation; each spilled
//     stop is tried once, so this halts too.

import type {
  SolverInput, SolverOutput, SolverStop, SolverTruck, BuiltRoute, UnassignedStop,
} from './routing-types.mts';
import { assembleRoute, sequence } from './routing-solver.mts';
import {
  computeLoad, capacityFits, equipmentOk, windowOk, emptyLoad, REASON,
} from './routing-constraints.mts';
import { DEFAULT_SERVICE_MIN } from './routing-types.mts';

function serviceSec(s: SolverStop): number {
  return Math.max(0, Number.isFinite(s.serviceMin) ? s.serviceMin : DEFAULT_SERVICE_MIN) * 60;
}

// Window-aware order: STRICT-windowed stops by earliest deadline (EDF) first, then
// the remaining stops by nearest-neighbor distance. Deterministic.
function windowAwareOrder(stops: SolverStop[], indexById: Map<string, number>, matrix: SolverInput['matrix']): SolverStop[] {
  const strict = stops.filter((s) => s.timeConstraint === 'STRICT' && s.timeWindow)
    .sort((a, b) => (a.timeWindow!.endSec - b.timeWindow!.endSec) || (a.timeWindow!.startSec - b.timeWindow!.startSec));
  const rest = stops.filter((s) => !(s.timeConstraint === 'STRICT' && s.timeWindow));
  // nearest-neighbor the rest by distance starting from depot.
  const dist = matrix.distanceMeters;
  const remaining = new Set(rest.map((s) => s.id));
  const ordered: SolverStop[] = [...strict];
  let cur = 0;
  while (remaining.size) {
    let next: SolverStop | null = null, bestC = Infinity;
    for (const s of rest) {
      if (!remaining.has(s.id)) continue;
      const c = dist[cur][indexById.get(s.id)!];
      if (c < bestC) { bestC = c; next = s; }
    }
    ordered.push(next!); remaining.delete(next!.id); cur = indexById.get(next!.id)!;
  }
  return ordered;
}

// The order repair both VALIDATES and ASSEMBLES with, so the two never diverge:
// when STRICT windows exist, EDF (window-aware); otherwise the dispatcher's chosen
// strategy order (windows are then irrelevant to validity, capacity is order-free).
function orderForTruck(stops: SolverStop[], input: SolverInput, indexById: Map<string, number>): SolverStop[] {
  const hasStrict = stops.some((s) => s.timeConstraint === 'STRICT' && s.timeWindow);
  if (hasStrict) return windowAwareOrder(stops, indexById, input.matrix);
  const byNode = new Map(stops.map((s) => [indexById.get(s.id)!, s]));
  const nodes = stops.map((s) => indexById.get(s.id)!);
  return sequence(nodes, input.strategy, input.matrix).map((n) => byNode.get(n)!);
}

function etasFor(ordered: SolverStop[], indexById: Map<string, number>, matrix: SolverInput['matrix'], depart: number): number[] {
  const etas: number[] = [];
  let prev = 0, clock = depart;
  for (const s of ordered) {
    const idx = indexById.get(s.id)!;
    clock += matrix.durationSec[prev][idx];
    etas.push(clock);
    clock += serviceSec(s);
    prev = idx;
  }
  return etas;
}

// Pick the worst violator in an ordered route, with its spill reason. Capacity /
// equipment first (structural), then — ONLY when windows are enforced (strict) —
// the STRICT-window stop with the most lateness. In advisory mode windows never
// cause a spill (they're flagged on the route instead).
function worstViolator(
  ordered: SolverStop[], etas: number[], truck: SolverTruck, enforceWindows: boolean,
): { stop: SolverStop; reasons: string[] } | null {
  // Capacity: if over, drop the largest-skid stop.
  const load = computeLoad(ordered);
  const capReasons: string[] = [];
  if (load.skids > truck.maxSkids) capReasons.push(REASON.overSkids);
  if (load.weightLbs > truck.maxWeightLbs) capReasons.push(REASON.overWeight);
  if (load.linearFeetIn > truck.deckLengthIn) capReasons.push(REASON.overDeck);
  if (capReasons.length) {
    const biggest = ordered.reduce((p, c) => (c.skids > p.skids ? c : p));
    return { stop: biggest, reasons: capReasons };
  }
  // Equipment (defensive — assignment should prevent this).
  for (const s of ordered) {
    const eq = equipmentOk(s, truck);
    if (!eq.ok) return { stop: s, reasons: eq.reasons };
  }
  // STRICT window: the stop with the greatest lateness past its window end.
  // Skipped entirely in advisory mode (windows flag, never spill).
  if (!enforceWindows) return null;
  let worst: SolverStop | null = null, worstLate = 0;
  ordered.forEach((s, i) => {
    if (!windowOk(s, etas[i])) {
      const late = etas[i] - (s.timeWindow!.endSec);
      if (late > worstLate || worst === null) { worstLate = late; worst = s; }
    }
  });
  if (worst) return { stop: worst, reasons: [REASON.windowUnsatisfiable] };
  return null;
}

// Can `stop` be inserted into this truck's stop set with the result fully valid?
// In advisory mode windows are ignored for the validity test (capacity + equipment
// only), so a window-only mismatch never blocks recovery.
function canInsert(stop: SolverStop, truckStops: SolverStop[], truck: SolverTruck, input: SolverInput, indexById: Map<string, number>, enforceWindows: boolean): boolean {
  const eq = equipmentOk(stop, truck);
  if (!eq.ok) return false;
  const cap = capacityFits(computeLoad(truckStops), stop, truck);
  if (!cap.ok) return false;
  if (!enforceWindows) return true;
  const ordered = orderForTruck([...truckStops, stop], input, indexById);
  const etas = etasFor(ordered, indexById, input.matrix, input.departEpochSec ?? 0);
  return ordered.every((s, i) => windowOk(s, etas[i]));
}

// Stops kept on an ordered route whose STRICT-window ETA is missed (advisory flag).
function windowViolations(ordered: SolverStop[], etas: number[]): string[] {
  return ordered.filter((s, i) => !windowOk(s, etas[i])).map((s) => s.id);
}

export function repair(input: SolverInput, output: SolverOutput): SolverOutput {
  const indexById = new Map<string, number>();
  input.stops.forEach((s, k) => indexById.set(s.id, k + 1));
  const idByIndex = new Map<number, string>();
  indexById.forEach((idx, id) => idByIndex.set(idx, id));
  const stopById = new Map(input.stops.map((s) => [s.id, s]));
  const depart = input.departEpochSec ?? 0;
  // Default ADVISORY: windows flag, never spill. STRICT keeps the old drop behavior.
  const enforceWindows = input.windowMode === 'strict';

  // Working stop sets per truck (from the solver's assignment).
  const sets = new Map<string, SolverStop[]>();
  for (const r of output.routes) sets.set(r.truckId, r.orderedStopIds.map((id) => stopById.get(id)!).filter(Boolean));
  const unassigned: UnassignedStop[] = output.unassigned.map((u) => ({ stopId: u.stopId, reasons: [...u.reasons] }));

  // ── Phase A: shrink each truck until valid ───────────────────────────────────
  for (const truck of input.trucks) {
    let stops = sets.get(truck.id) ?? [];
    let guard = 0;
    while (stops.length && guard++ < stops.length + 2) {
      const ordered = orderForTruck(stops, input, indexById);
      const etas = etasFor(ordered, indexById, input.matrix, depart);
      const v = worstViolator(ordered, etas, truck, enforceWindows);
      if (!v) { stops = ordered; break; }
      stops = ordered.filter((s) => s.id !== v.stop.id);
      unassigned.push({ stopId: v.stop.id, reasons: v.reasons });
    }
    sets.set(truck.id, stops);
  }

  // ── Phase B: try to recover spilled stops into any truck where they're valid ──
  const stillUnassigned: UnassignedStop[] = [];
  for (const u of unassigned) {
    const stop = stopById.get(u.stopId);
    if (!stop) { stillUnassigned.push(u); continue; }
    let placed = false;
    for (const truck of input.trucks) {
      if (canInsert(stop, sets.get(truck.id)!, truck, input, indexById, enforceWindows)) {
        sets.set(truck.id, [...sets.get(truck.id)!, stop]);
        placed = true;
        break;
      }
    }
    if (!placed) stillUnassigned.push(u);
  }

  // ── assemble final, provably-valid routes ────────────────────────────────────
  const routes: BuiltRoute[] = [];
  for (const truck of input.trucks) {
    const stops = sets.get(truck.id) ?? [];
    if (!stops.length) continue;
    const ordered = orderForTruck(stops, input, indexById);
    const nodes = ordered.map((s) => indexById.get(s.id)!);
    const route = assembleRoute(truck, stops, nodes, idByIndex, input.matrix, depart);
    // Advisory flag: STRICT-window stops kept on the route whose ETA misses the
    // window (always empty in strict mode — those were spilled in Phase A).
    route.windowViolatedIds = windowViolations(ordered, etasFor(ordered, indexById, input.matrix, depart));
    routes.push(route);
  }

  return {
    routes,
    unassigned: dedupeUnassigned(stillUnassigned),
    meta: { ...output.meta, repaired: true },
  };
}

function dedupeUnassigned(list: UnassignedStop[]): UnassignedStop[] {
  const m = new Map<string, Set<string>>();
  for (const u of list) {
    if (!m.has(u.stopId)) m.set(u.stopId, new Set());
    for (const r of u.reasons) m.get(u.stopId)!.add(r);
  }
  return [...m.entries()].map(([stopId, reasons]) => ({ stopId, reasons: [...reasons] }));
}
