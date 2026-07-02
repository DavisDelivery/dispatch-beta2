// lib/routing-types.mts
//
// Phase 2 routing-engine shared contracts. Pure types + enums + tunable
// constants only — no I/O — so every engine module (geometry, solver, repair,
// intent, pipeline) and the tests share one vocabulary. The solver interface
// here is deliberately the SAME shape Google Route Optimization (optimizeTours,
// P2.4) can implement later, so it drops in without touching callers.

export type Strategy = 'CLOSEST_FIRST' | 'FARTHEST_FIRST' | 'MIN_DISTANCE' | 'MIN_TIME';
export const STRATEGIES: Strategy[] = ['CLOSEST_FIRST', 'FARTHEST_FIRST', 'MIN_DISTANCE', 'MIN_TIME'];
export const DEFAULT_STRATEGY: Strategy = 'MIN_DISTANCE';

// Matrix source is a PER-BUILD choice (Appendix B — cheap by default). The free
// haversine estimate is the DEFAULT even when the Google key is present; Google
// drive-times are an explicit per-build opt-in with the cost shown.
export type MatrixMode = 'haversine' | 'google';
export const DEFAULT_MATRIX_MODE: MatrixMode = 'haversine';

// Appointment-window enforcement. ADVISORY (default): never spill a stop for a
// window it can't meet — keep it and FLAG it (windowViolatedIds). STRICT (opt-in
// kill switch): the historical behavior — drop unsatisfiable-window stops.
export type WindowMode = 'advisory' | 'strict';
export const DEFAULT_WINDOW_MODE: WindowMode = 'advisory';

// Google Routes computeRouteMatrix Basic (non-traffic) tier — ~$5 / 1000 elements
// (Appendix B §5). Used for the transparent per-build cost estimate.
export const BASIC_MATRIX_RATE_PER_1K_USD = 5.0;

// Elements billed for an (depot + N stops) matrix = (N+1)² (origins × destinations).
export function matrixElementCount(stopCount: number): number {
  const nodes = stopCount + 1;
  return nodes * nodes;
}

// Transparent cost estimate (Basic tier). Zero unless the build actually used Google.
export function estimateMatrixCostUsd(elementCount: number, source: string): number {
  if (source !== 'google') return 0;
  return Math.round((elementCount / 1000) * BASIC_MATRIX_RATE_PER_1K_USD * 100) / 100;
}

// Equipment restriction kinds (from customer_notes; see HANDOFF.md). These are
// HARD constraints — a shown route must satisfy them.
export type EquipmentReq =
  | 'no_tractor_trailer'
  | 'uline_straight_truck'
  | 'straight_truck_only'
  | 'box_truck_only'
  | '26ft_max'
  | 'no_53'
  | 'no_overhead_clearance'
  | 'liftgate_required';

export interface ObjectiveWeights {
  distance: number;
  time: number;
  balance: number; // prefer balanced truck loads
}
export const DEFAULT_OBJECTIVE_WEIGHTS: ObjectiveWeights = { distance: 1, time: 1, balance: 0.5 };

// Depot default — Buford terminal (ORCHESTRATION.md §3).
export const DEPOT = Object.freeze({ name: 'Buford Terminal', lat: 34.14838, lng: -83.95948 });

// Standard GMA pallet footprint (inches) and default per-stop dwell.
export const PALLET_LENGTH_IN = 48;
export const PALLET_WIDTH_IN = 40;
export const DEFAULT_DECK_WIDTH_IN = 96;        // ~2 pallets across
export const DEFAULT_SERVICE_MIN = 15;          // configurable per-stop dwell (learned dwell = P2.5)
export const DEFAULT_DEPART_HHMM = '08:00';     // depot departure when none supplied

// Truck capability flags the solver reasons over.
export interface TruckCapabilities {
  liftgate: boolean;
  tractor: boolean;        // true = tractor/trailer; false = straight/box truck
  lengthClassFt: number;   // 26, 53, …
  overheadClearance?: boolean; // false = cannot service low-clearance docks
}

export interface SolverTruck {
  id: string;
  label?: string;
  maxSkids: number;
  maxWeightLbs: number;
  deckLengthIn: number;
  capabilities: TruckCapabilities;
}

export interface TimeWindowSec { startSec: number; endSec: number }

export interface SolverStop {
  id: string;
  lat: number;
  lng: number;
  skids: number;
  weightLbs: number;
  linearFeetIn: number;     // floor length consumed, INCHES (compared to deckLengthIn)
  oversize: boolean;
  serviceMin: number;
  timeWindow: TimeWindowSec | null;
  timeConstraint: 'STRICT' | 'SOFT';
  equipmentReqs: EquipmentReq[];
}

export interface RouteLeg { fromId: string; toId: string; distanceMeters: number; durationSec: number }

export interface RouteLoad { skids: number; weightLbs: number; linearFeetIn: number }

export interface BuiltRoute {
  truckId: string;
  orderedStopIds: string[];
  legs: RouteLeg[];
  etas: number[];          // epoch seconds, aligned to orderedStopIds (arrival at each)
  load: RouteLoad;
  capacity: RouteLoad;     // the assigned truck's capacity (for load-vs-capacity bars)
  feasible: boolean;       // always true for a SHOWN route (repair guarantees it)
  windowViolatedIds?: string[]; // stops kept on this route whose STRICT window the ETA misses (advisory flag)
}

export interface UnassignedStop { stopId: string; reasons: string[] }

export interface SolverMatrix {
  // index 0 = depot, index k+1 = stops[k]. durationSec[i][j] / distanceMeters[i][j].
  durationSec: number[][];
  distanceMeters: number[][];
}

export interface SolverInput {
  stops: SolverStop[];
  trucks: SolverTruck[];
  depot: { lat: number; lng: number };
  matrix: SolverMatrix;
  strategy: Strategy;
  objectiveWeights: ObjectiveWeights;
  constraints?: Record<string, unknown>;
  departEpochSec?: number; // depot departure; defaults applied by pipeline
  windowMode?: WindowMode; // 'advisory' (default) flags window misses; 'strict' spills them
}

export interface SolverOutput {
  routes: BuiltRoute[];
  unassigned: UnassignedStop[];
  meta: Record<string, unknown>;
}

// The swappable engine contract. The deterministic solver and (later) optimizeTours
// both satisfy this exact signature.
export type RoutingSolver = (input: SolverInput) => SolverOutput;
