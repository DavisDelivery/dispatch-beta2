// lib/freight-geometry.mts
//
// PURE freight-geometry derivation: turn a normalized stop's line items + comments
// into the physical attributes the solver needs — total skids, total weight (lbs),
// estimated linear floor-inches consumed, and an oversize flag.
//
// Deterministic-FIRST: works with NO model call, using totalPallets, NuVizz's own
// productCategory 'L' flag, criticalDimension/length, and a keyword scan. The Opus
// assist (Section 8/11) only touches stops the deterministic pass marks AMBIGUOUS,
// and results are cached by SKU/stopNbr so we never re-parse or call the model in a
// hot loop. The model is injected, never imported here, so this stays unit-testable.

import {
  PALLET_LENGTH_IN, PALLET_WIDTH_IN, DEFAULT_DECK_WIDTH_IN,
} from './routing-types.mts';

export interface StopGeometry {
  skids: number;
  weightLbs: number;
  linearFeetIn: number;   // floor length consumed, INCHES
  oversize: boolean;
  ambiguous: boolean;     // deterministic pass couldn't be sure of length → assist candidate
  parsedBy: 'deterministic' | 'assist';
  notes: string[];        // why oversize / how length was estimated (for risk flags + debugging)
}

export interface GeometryAssist { linearFeetIn?: number; oversize?: boolean }

// Long/oversize keywords scanned in product text + order instructions.
const LONG_KEYWORDS = /\b(rack|racking|tube|tubing|ladder|pipe|pipes|lineal|linear|lumber|beam|beams|rod|rods|conduit|mast|pole|poles|coil|coils|extrusion|moulding|molding|trim|baseboard|gutter)\b/i;

// Convert any length value to inches given its UOM (defaults to inches).
function toInches(value: number | null | undefined, uom: string | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const u = String(uom || 'IN').toUpperCase();
  if (u === 'FT' || u === 'FOOT' || u === 'FEET') return value * 12;
  if (u === 'CM') return value / 2.54;
  if (u === 'M' || u === 'MTR' || u === 'METER') return value * 39.3701;
  if (u === 'MM') return value / 25.4;
  return value; // IN / unknown → treat as inches
}

function toLbs(value: number | null | undefined, uom: string | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  const u = String(uom || 'LB').toUpperCase();
  if (u === 'KG' || u === 'KGS' || u === 'KILOGRAM') return value * 2.20462;
  if (u === 'G' || u === 'GRAM') return value * 0.00220462;
  if (u === 'OZ') return value / 16;
  return value; // LB / LBS / unknown → pounds
}

// Floor inches consumed by N standard pallets, loaded ~2-across on the deck.
export function palletLinearInches(skids: number, deckWidthIn = DEFAULT_DECK_WIDTH_IN): number {
  if (skids <= 0) return 0;
  const across = Math.max(1, Math.floor(deckWidthIn / PALLET_WIDTH_IN));
  return Math.ceil(skids / across) * PALLET_LENGTH_IN;
}

// The deterministic pass. `comments` is any free-text (order instructions) to scan.
export function deriveGeometryDeterministic(
  stop: any,
  opts: { deckWidthIn?: number } = {},
): StopGeometry {
  const deckWidthIn = opts.deckWidthIn ?? DEFAULT_DECK_WIDTH_IN;
  const details: any[] = Array.isArray(stop?.stopDetails) ? stop.stopDetails : [];
  const notes: string[] = [];

  // Skids: NuVizz MISLABELS its freight fields — the normalized `cartons` field (NuVizz
  // totalCartons) is the real PALLET/SKID count, while `pallets` (NuVizz totalPallets) is
  // the TOTAL piece count (pallets + loose). Use the real skid count for deck capacity;
  // else sum pallet-UOM line quantities.
  let skids = Number.isFinite(stop?.cartons) && stop.cartons != null ? Number(stop.cartons) : 0;
  if (!skids && details.length) {
    skids = details.reduce((a, d) => {
      const uom = String(d?.quantityUOM || '').toUpperCase();
      return a + (uom.startsWith('PLT') || uom === 'PALLET' || uom === 'PALLETS' || uom === 'SKID' ? Number(d?.quantity) || 0 : 0);
    }, 0);
  }
  skids = Math.max(0, Math.round(skids));

  // Weight: prefer normalized stop weight; else sum line weights.
  let weightLbs = toLbs(stop?.weight, stop?.weightUOM);
  if (!weightLbs && details.length) {
    weightLbs = details.reduce((a, d) => a + toLbs(d?.weight, d?.weightUOM), 0);
  }
  weightLbs = Math.round(weightLbs);

  // Oversize + extra length from long items.
  let oversize = false;
  let oversizeLengthIn = 0;
  let sawStructuredLength = false;
  for (const d of details) {
    const isLongCat = String(d?.productCategory || '').toUpperCase() === 'L';
    const lenIn = toInches(d?.length, d?.lengthUOM) ?? toInches(d?.criticalDimension, d?.criticalDimensionUOM);
    if (lenIn != null) sawStructuredLength = true;
    const longByDim = lenIn != null && lenIn > PALLET_LENGTH_IN;
    const longByText = LONG_KEYWORDS.test(String(d?.product || ''));
    if (isLongCat || longByDim || longByText) {
      oversize = true;
      const qty = Math.max(1, Math.round(Number(d?.quantity) || 1));
      const eachLen = lenIn != null ? lenIn : PALLET_LENGTH_IN * 2; // unknown long item → assume 2 pallets long
      oversizeLengthIn += eachLen * qty;
      notes.push(`oversize line "${d?.product || d?.sku || 'item'}": ~${Math.round(eachLen)}in × ${qty}`);
    }
  }

  // Ambiguous: free-text hints at a long item but nothing structured proves length.
  const freeText = `${stop?.signalSources?.orderInstructions || ''} ${stop?.addr2 || ''}`;
  const longByFreeText = LONG_KEYWORDS.test(freeText);
  const ambiguous = !sawStructuredLength && longByFreeText && !oversize;
  if (longByFreeText && !oversize) notes.push('free-text mentions a long item but no structured length');

  const linearFeetIn = palletLinearInches(skids, deckWidthIn) + Math.round(oversizeLengthIn);

  return { skids, weightLbs, linearFeetIn, oversize, ambiguous, parsedBy: 'deterministic', notes };
}

// Merge a (cached or model-provided) assist result onto a deterministic geometry.
export function applyAssist(base: StopGeometry, assist: GeometryAssist | null | undefined): StopGeometry {
  if (!assist) return base;
  const out: StopGeometry = { ...base, parsedBy: 'assist', ambiguous: false, notes: [...base.notes] };
  if (Number.isFinite(assist.linearFeetIn as number)) {
    // Assist provides the OVERSIZE length contribution; keep the pallet floor we
    // already computed deterministically and add the assist's long-item length.
    out.linearFeetIn = palletLinearInches(base.skids) + Math.max(0, Math.round(assist.linearFeetIn as number));
    out.notes.push(`assist length ${Math.round(assist.linearFeetIn as number)}in`);
  }
  if (typeof assist.oversize === 'boolean') out.oversize = assist.oversize || out.oversize;
  return out;
}

// Cache key for parsed geometry — SKU first (item-level reuse), else stopNbr.
export function geometryCacheKey(stop: any): string {
  const skus = (Array.isArray(stop?.stopDetails) ? stop.stopDetails : [])
    .map((d: any) => d?.sku).filter(Boolean).sort();
  return skus.length ? `sku:${skus.join(',')}` : `stop:${stop?.stopNbr ?? 'unknown'}`;
}

// Full derivation over many stops. Deterministic for all; for ambiguous stops it
// consults the injected async `assist` (model proxy) ONCE per cache key, caching
// the result. With no assist fn, ambiguous stops keep their deterministic estimate.
export async function deriveGeometryForStops(
  stops: any[],
  opts: {
    deckWidthIn?: number;
    assist?: (stop: any) => Promise<GeometryAssist | null>;
    cache?: Map<string, GeometryAssist | null>;
  } = {},
): Promise<Map<string, StopGeometry>> {
  const cache = opts.cache ?? new Map<string, GeometryAssist | null>();
  const out = new Map<string, StopGeometry>();
  for (const stop of stops) {
    const id = stop?.stopNbr ?? stop?.id;
    let geo = deriveGeometryDeterministic(stop, { deckWidthIn: opts.deckWidthIn });
    if (geo.ambiguous && opts.assist) {
      const key = geometryCacheKey(stop);
      let assist = cache.get(key);
      if (assist === undefined) {
        try { assist = await opts.assist(stop); } catch { assist = null; }
        cache.set(key, assist ?? null);
      }
      geo = applyAssist(geo, assist);
    }
    out.set(id, geo);
  }
  return out;
}
