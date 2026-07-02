// lib/routing-solver.mts
//
// The deterministic routing solver (Section 9). PURE: solveRouting(input) -> output,
// the swappable RoutingSolver contract that Google optimizeTours (P2.4) can later
// implement without touching callers.
//
// Pipeline within solve:
//   1. Assignment — best-fit-decreasing bin-packing across the N trucks, honoring
//      equipment + capacity HARD constraints. Hard-to-place stops (oversize / most
//      restricted / largest) are placed first; anything that fits no truck spills.
//   2. Sequencing per strategy — CLOSEST/FARTHEST order by depot distance;
//      MIN_DISTANCE / MIN_TIME use nearest-neighbor seeding + 2-opt improvement on
//      the injected Google matrix.
//   3. Legs + ETAs + load/capacity.
// STRICT appointment windows are validated/enforced by the repair loop, not here.

import type {
  SolverInput, SolverOutput, SolverStop, SolverTruck, BuiltRoute, RouteLeg,
  UnassignedStop, Strategy,
} from './routing-types.mts';
import { DEFAULT_SERVICE_MIN } from './routing-types.mts';
import {
  truckCanCarry, capacityFits, emptyLoad, addLoad, computeLoad, REASON,
} from './routing-constraints.mts';

const DEPOT_ID = 'DEPOT';

// matrix index: depot = 0, stop k = k+1 (in input.stops order).
function buildIndex(stops: SolverStop[]): Map<string, number> {
  const m = new Map<string, number>();
  stops.forEach((s, k) => m.set(s.id, k + 1));
  return m;
}

function serviceSec(stop: SolverStop): number {
  const min = Number.isFinite(stop.serviceMin) ? stop.serviceMin : DEFAULT_SERVICE_MIN;
  return Math.max(0, min) * 60;
}

// ── assignment ───────────────────────────────────────────────────────────────
interface Assignment { byTruck: Map<string, SolverStop[]>; unassigned: UnassignedStop[] }

// Pure haversine (meters) on lat/lng — geographic proximity that does NOT depend on
// the matrix mode (haversine vs google).
function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Geography-aware capacitated assignment (Chunk B). Operator rule: nearby stops ride
// the SAME truck; two trucks share an area ONLY when (a) an equipment restriction
// forces a stop onto a specific truck, or (b) a cluster exceeds one truck's capacity.
// Equipment + capacity stay the ONLY hard gates (truckCanCarry / capacityFits); spill
// reasons are unchanged. Deterministic: equipment/oversize anchors first, then
// farthest-point seeds per empty truck, then global nearest-pair region growth.
function assign(stops: SolverStop[], trucks: SolverTruck[], depot: { lat: number; lng: number }): Assignment {
  const byTruck = new Map<string, SolverStop[]>();
  const loadByTruck = new Map<string, ReturnType<typeof emptyLoad>>();
  for (const t of trucks) { byTruck.set(t.id, []); loadByTruck.set(t.id, emptyLoad()); }
  const unassigned: UnassignedStop[] = [];

  const place = (stop: SolverStop, t: SolverTruck) => {
    byTruck.get(t.id)!.push(stop);
    loadByTruck.set(t.id, addLoad(loadByTruck.get(t.id)!, stop));
  };
  const fits = (stop: SolverStop, t: SolverTruck) =>
    truckCanCarry(stop, t).ok && capacityFits(loadByTruck.get(t.id)!, stop, t).ok;
  // Distance from a stop to a truck's current territory (nearest assigned stop), or to
  // the depot when the territory is still empty.
  const distToTruck = (stop: SolverStop, t: SolverTruck): number => {
    const terr = byTruck.get(t.id)!;
    if (!terr.length) return haversineM(stop, depot);
    let best = Infinity;
    for (const s of terr) { const d = haversineM(stop, s); if (d < best) best = d; }
    return best;
  };
  const spillNoTruck = (stop: SolverStop) => {
    const reasons = new Set<string>();
    for (const t of trucks) for (const r of truckCanCarry(stop, t).reasons) reasons.add(r);
    unassigned.push({ stopId: stop.id, reasons: [REASON.noTruckFits, ...reasons] });
  };
  const spillCapacity = (stop: SolverStop, capable: SolverTruck[]) => {
    const roomiest = capable.reduce((p, c) =>
      (c.maxSkids - loadByTruck.get(c.id)!.skids) > (p.maxSkids - loadByTruck.get(p.id)!.skids) ? c : p);
    unassigned.push({ stopId: stop.id, reasons: capacityFits(loadByTruck.get(roomiest.id)!, stop, roomiest).reasons });
  };

  // ── Phase 1: anchor restricted + oversize stops on a capable truck (equipment
  //    decides; geography is secondary for these). Hardest-first, deterministic. ──
  const isRestricted = (s: SolverStop) => s.oversize || (s.equipmentReqs?.length || 0) > 0;
  const restricted = stops.filter(isRestricted).sort((a, b) =>
    (Number(b.oversize) - Number(a.oversize)) ||
    ((b.equipmentReqs?.length || 0) - (a.equipmentReqs?.length || 0)) ||
    (b.skids - a.skids) || (b.weightLbs - a.weightLbs) || (a.id < b.id ? -1 : 1));
  for (const stop of restricted) {
    const capable = trucks.filter((t) => truckCanCarry(stop, t).ok);
    if (!capable.length) { spillNoTruck(stop); continue; }
    const fitting = capable.filter((t) => capacityFits(loadByTruck.get(t.id)!, stop, t).ok);
    if (!fitting.length) { spillCapacity(stop, capable); continue; }
    const best = fitting.reduce((p, c) =>
      (c.maxSkids - loadByTruck.get(c.id)!.skids) > (p.maxSkids - loadByTruck.get(p.id)!.skids) ? c : p);
    place(stop, best);
  }

  // ── Phase 2: seed each EMPTY truck with a geographically spread plain stop
  //    (farthest-point sampling) so separated clusters land on different trucks. ──
  const assignedIds = new Set<string>();
  for (const terr of byTruck.values()) for (const s of terr) assignedIds.add(s.id);
  const remaining = stops.filter((s) => !isRestricted(s) && !assignedIds.has(s.id));
  const chosenSeeds: SolverStop[] = [];
  const farthestPoint = (): SolverStop | null => {
    let best: SolverStop | null = null, bestScore = -1;
    for (const s of remaining) {
      if (chosenSeeds.includes(s)) continue;
      let score = haversineM(s, depot);
      for (const seed of chosenSeeds) score = Math.min(score, haversineM(s, seed));
      if (score > bestScore || (score === bestScore && best && s.id < best.id)) { bestScore = score; best = s; }
    }
    return best;
  };
  for (const t of trucks) {
    if (byTruck.get(t.id)!.length) continue; // already anchored in phase 1
    let seed = farthestPoint();
    while (seed && !fits(seed, t)) { chosenSeeds.push(seed); seed = farthestPoint(); } // skip seeds this truck can't take
    if (!seed) break;
    chosenSeeds.push(seed);
    place(seed, t);
    remaining.splice(remaining.indexOf(seed), 1);
  }

  // ── Phase 3: global nearest-pair region growth for the rest. ──
  // Cap the iterations up front: remaining.length shrinks by one each pass, so a cap
  // that re-reads remaining.length would halve the budget and bail with routable stops
  // still in hand (they'd then phantom-spill below). Each pass places exactly one stop,
  // so remaining.length passes suffice; +5 is slack.
  const maxIters = remaining.length + 5;
  let guard = 0;
  while (remaining.length && guard++ < maxIters) {
    let bestStop: SolverStop | null = null, bestTruck: SolverTruck | null = null, bestD = Infinity;
    for (const stop of remaining) {
      for (const t of trucks) {
        if (!fits(stop, t)) continue;
        const d = distToTruck(stop, t);
        if (d < bestD || (d === bestD && bestStop && stop.id < bestStop.id)) { bestD = d; bestStop = stop; bestTruck = t; }
      }
    }
    if (!bestStop) break; // nothing fits any truck with room
    place(bestStop, bestTruck!);
    remaining.splice(remaining.indexOf(bestStop), 1);
  }
  // Anything still remaining fits no truck with room → capacity (or no-truck) spill.
  for (const stop of remaining) {
    const capable = trucks.filter((t) => truckCanCarry(stop, t).ok);
    if (!capable.length) spillNoTruck(stop); else spillCapacity(stop, capable);
  }

  return { byTruck, unassigned };
}

// ── sequencing ───────────────────────────────────────────────────────────────
export function pathCost(order: number[], cost: number[][]): number {
  if (!order.length) return 0;
  let total = cost[0][order[0]];
  for (let i = 0; i < order.length - 1; i++) total += cost[order[i]][order[i + 1]];
  return total;
}

export function nearestNeighbor(nodes: number[], cost: number[][]): number[] {
  const remaining = new Set(nodes);
  const out: number[] = [];
  let cur = 0; // depot
  while (remaining.size) {
    let next = -1, bestC = Infinity;
    for (const n of remaining) { const c = cost[cur][n]; if (c < bestC) { bestC = c; next = n; } }
    out.push(next); remaining.delete(next); cur = next;
  }
  return out;
}

// 2-opt improvement on the depot-anchored path (no return leg).
export function twoOpt(order: number[], cost: number[][]): number[] {
  let best = order.slice();
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        if (pathCost(candidate, cost) + 1e-9 < pathCost(best, cost)) { best = candidate; improved = true; }
      }
    }
  }
  return best;
}

export function sequence(nodes: number[], strategy: Strategy, matrix: SolverInput['matrix']): number[] {
  if (nodes.length <= 1) return nodes.slice();
  const { distanceMeters, durationSec } = matrix;
  switch (strategy) {
    case 'CLOSEST_FIRST':
      return nodes.slice().sort((a, b) => distanceMeters[0][a] - distanceMeters[0][b]);
    case 'FARTHEST_FIRST':
      return nodes.slice().sort((a, b) => distanceMeters[0][b] - distanceMeters[0][a]);
    case 'MIN_TIME':
      return twoOpt(nearestNeighbor(nodes, durationSec), durationSec);
    case 'MIN_DISTANCE':
    default:
      return twoOpt(nearestNeighbor(nodes, distanceMeters), distanceMeters);
  }
}

// ── route assembly (legs, ETAs, load) ────────────────────────────────────────
export function assembleRoute(
  truck: SolverTruck,
  stops: SolverStop[],
  orderedNodes: number[],
  idByIndex: Map<number, string>,
  matrix: SolverInput['matrix'],
  departEpochSec: number,
): BuiltRoute {
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const orderedStopIds = orderedNodes.map((n) => idByIndex.get(n)!);
  const legs: RouteLeg[] = [];
  const etas: number[] = [];
  let prev = 0; // depot
  let clock = departEpochSec;
  for (const node of orderedNodes) {
    const id = idByIndex.get(node)!;
    const stop = stopById.get(id)!;
    legs.push({
      fromId: prev === 0 ? DEPOT_ID : idByIndex.get(prev)!,
      toId: id,
      distanceMeters: matrix.distanceMeters[prev][node],
      durationSec: matrix.durationSec[prev][node],
    });
    clock += matrix.durationSec[prev][node];
    etas.push(clock);          // arrival at this stop
    clock += serviceSec(stop); // dwell before departing
    prev = node;
  }
  const load = computeLoad(stops);
  return {
    truckId: truck.id,
    orderedStopIds,
    legs,
    etas,
    load,
    capacity: { skids: truck.maxSkids, weightLbs: truck.maxWeightLbs, linearFeetIn: truck.deckLengthIn },
    feasible: true,
  };
}

export function solveRouting(input: SolverInput): SolverOutput {
  const { stops, trucks, matrix, strategy } = input;
  const idByIndex = new Map<number, string>();
  buildIndex(stops).forEach((idx, id) => idByIndex.set(idx, id));
  const indexById = buildIndex(stops);
  const departEpochSec = input.departEpochSec ?? 0;

  const { byTruck, unassigned } = assign(stops, trucks, input.depot);

  const routes: BuiltRoute[] = [];
  for (const truck of trucks) {
    const assigned = byTruck.get(truck.id) ?? [];
    if (!assigned.length) continue;
    const nodes = assigned.map((s) => indexById.get(s.id)!);
    const ordered = sequence(nodes, strategy, matrix);
    routes.push(assembleRoute(truck, assigned, ordered, idByIndex, matrix, departEpochSec));
  }

  return {
    routes,
    unassigned,
    meta: { engine: 'deterministic', strategy, truckCount: trucks.length, stopCount: stops.length },
  };
}
