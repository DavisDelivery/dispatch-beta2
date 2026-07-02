// lib/truck-profiles.mts
//
// Reusable truck capacity profiles (truck_profiles collection) + the mapping from a
// stored profile to the solver's SolverTruck shape. Reuses firestore.mts; no auth
// duplication. Per-DRIVER profiles are P2.5 — the optional driverKey field is modeled
// now but there is no driver UI.

import { getDoc, setDoc, listDocs } from './firestore.mts';
import type { SolverTruck, TruckCapabilities } from './routing-types.mts';

export interface TruckProfile {
  id: string;
  label: string;
  truckClass: string;        // BOX_26 | TRACTOR_53 | …
  maxSkids: number;
  maxWeightLbs: number;
  deckLengthIn: number;
  deckWidthIn: number;
  palletFootprintIn: { length: number; width: number };
  capabilities: TruckCapabilities;
  driverKey?: string | null; // P2.5 hook — unused in v1
  notes?: string;
  active: boolean;
}

// Seed defaults (editable). 26ft box ≈ 12–15 skids / ~10k lb / deck ~312in;
// 53ft trailer ≈ 24–30 skids / deck ~636in.
export const DEFAULT_TRUCK_PROFILES: TruckProfile[] = [
  {
    id: 'box_26', label: '26ft Box', truckClass: 'BOX_26',
    maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, deckWidthIn: 96,
    palletFootprintIn: { length: 48, width: 40 },
    capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true },
    driverKey: null, notes: 'Default 26ft straight truck with liftgate.', active: true,
  },
  {
    id: 'tractor_53', label: '53ft Trailer', truckClass: 'TRACTOR_53',
    maxSkids: 28, maxWeightLbs: 44000, deckLengthIn: 636, deckWidthIn: 100,
    palletFootprintIn: { length: 48, width: 40 },
    capabilities: { liftgate: false, tractor: true, lengthClassFt: 53, overheadClearance: true },
    driverKey: null, notes: 'Default 53ft tractor-trailer.', active: true,
  },
];

export function profileToSolverTruck(p: TruckProfile): SolverTruck {
  return {
    id: p.id,
    label: p.label,
    maxSkids: p.maxSkids,
    maxWeightLbs: p.maxWeightLbs,
    deckLengthIn: p.deckLengthIn,
    capabilities: { ...p.capabilities },
  };
}

const COLLECTION = 'truck_profiles';

export async function listTruckProfiles(): Promise<TruckProfile[]> {
  const docs = await listDocs(COLLECTION);
  return docs.map(({ _id, ...rest }) => ({ id: _id, ...(rest as object) })) as TruckProfile[];
}
export async function getTruckProfile(id: string): Promise<TruckProfile | null> {
  const d = await getDoc(`${COLLECTION}/${id}`);
  return d ? ({ id, ...d } as TruckProfile) : null;
}
export async function saveTruckProfile(p: TruckProfile): Promise<void> {
  await setDoc(`${COLLECTION}/${p.id}`, p);
}
// Idempotent seeding helper (used by the UI/back end on first run).
export async function ensureSeedProfiles(): Promise<TruckProfile[]> {
  const existing = await listTruckProfiles();
  if (existing.length) return existing;
  await Promise.all(DEFAULT_TRUCK_PROFILES.map(saveTruckProfile));
  return DEFAULT_TRUCK_PROFILES;
}
