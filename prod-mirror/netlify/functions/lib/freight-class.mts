// lib/freight-class.mts
//
// PURE freight-class / density derivation from a stored history stop record.
// No I/O, no model — just unit conversions + the standard density→class scale,
// so it's unit-testable and reusable by the report endpoint.
//
// "Density" freight class = total weight (lb) / total cube (ft³), bucketed on the
// published NMFC density guideline. We compute cube two ways and report BOTH so a
// downstream rate generator can trust or override:
//   • cube_dims      — from line-item L×W×H (the real thing, when present)
//   • cube_pallet_est— pallets × a standard pallet footprint × assumed stack height
// `cube_used` prefers real dims when every line has them, else the pallet estimate.

const PALLET_FOOTPRINT_IN2 = 48 * 40; // standard GMA pallet, square inches

// Length → inches (default IN). Mirrors lib/freight-geometry.mts.
export function toInches(value: number | null | undefined, uom: string | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const u = String(uom || 'IN').toUpperCase();
  if (u === 'FT' || u === 'FOOT' || u === 'FEET') return value * 12;
  if (u === 'CM') return value / 2.54;
  if (u === 'M' || u === 'MTR' || u === 'METER') return value * 39.3701;
  if (u === 'MM') return value / 25.4;
  return value; // IN / unknown
}

// Weight → pounds (default LB). Mirrors lib/freight-geometry.mts.
export function toLbs(value: number | null | undefined, uom: string | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const u = String(uom || 'LB').toUpperCase();
  if (u === 'KG' || u === 'KGS' || u === 'KILOGRAM') return value * 2.20462;
  if (u === 'G' || u === 'GRAM') return value * 0.00220462;
  if (u === 'OZ') return value / 16;
  return value; // LB / LBS / unknown
}

export function cubicFeet(lenIn: number, widIn: number, heiIn: number): number {
  return (lenIn * widIn * heiIn) / 1728;
}

// Standard NMFC density guideline (pounds per cubic foot → class). Confirm exact
// breakpoints against your tariff; a multiplier refit absorbs minor differences.
export function densityToClass(pcf: number): number {
  if (!Number.isFinite(pcf) || pcf <= 0) return 500;
  if (pcf >= 50) return 50;
  if (pcf >= 35) return 55;
  if (pcf >= 30) return 60;
  if (pcf >= 22.5) return 65;
  if (pcf >= 15) return 70;
  if (pcf >= 13.5) return 77.5;
  if (pcf >= 12) return 85;
  if (pcf >= 10.5) return 92.5;
  if (pcf >= 9) return 100;
  if (pcf >= 8) return 110;
  if (pcf >= 7) return 125;
  if (pcf >= 6) return 150;
  if (pcf >= 5) return 175;
  if (pcf >= 4) return 200;
  if (pcf >= 3) return 250;
  if (pcf >= 2) return 300;
  if (pcf >= 1) return 400;
  return 500;
}

export type DimsCoverage = 'full' | 'partial' | 'critical' | 'none';

export interface ShipmentFreight {
  lines: number;
  linesWithFullDims: number;
  dimsCoverage: DimsCoverage;
  weightLb: number | null;
  pallets: number | null;
  cartons: number | null;
  lbPerPallet: number | null;       // weight ÷ pallets — the real signal when dims are absent
  skus: string[];                   // distinct SKUs on the shipment (for a product→class table)
  products: string[];               // distinct product descriptions
  cubeFt3Dims: number | null;       // from L×W×H of lines that have all three
  cubeFt3PalletEst: number | null;  // pallets × footprint × stack height
  cubeFt3Used: number | null;
  cubeSource: 'dims' | 'pallet_est' | 'none';
  densityPcf: number | null;
  freightClass: number | null;
  oversize: boolean;
  hasLongCat: boolean;
}

// Derive shipment-level freight from a stored stop record. `stackHeightIn` is the
// assumed loaded-pallet height used ONLY for the pallet-cube fallback.
export function deriveShipmentFreight(stop: any, opts: { stackHeightIn?: number } = {}): ShipmentFreight {
  const stackHeightIn = opts.stackHeightIn ?? 60;
  const details: any[] = Array.isArray(stop?.stopDetails) ? stop.stopDetails : [];

  let linesWithFullDims = 0;
  let cubeDims = 0;
  let sawCritical = false;
  let hasLongCat = false;
  let oversize = false;
  let lineWeightSum = 0;
  let sawLineWeight = false;
  const skuSet = new Set<string>();
  const productSet = new Set<string>();

  for (const d of details) {
    const qty = Math.max(1, Math.round(Number(d?.quantity) || 1));
    const L = toInches(d?.length, d?.lengthUOM);
    const W = toInches(d?.width, d?.widthUOM);
    const H = toInches(d?.height, d?.heightUOM);
    if (L != null && W != null && H != null) {
      linesWithFullDims++;
      cubeDims += cubicFeet(L, W, H) * qty;
    }
    if (d?.criticalDimension != null) sawCritical = true;
    if (String(d?.productCategory || '').toUpperCase() === 'L') { hasLongCat = true; oversize = true; }
    const lw = toLbs(d?.weight, d?.weightUOM);
    if (lw != null) { lineWeightSum += lw; sawLineWeight = true; }
    const sku = d?.sku != null ? String(d.sku).trim() : '';
    if (sku) skuSet.add(sku);
    const product = d?.product != null ? String(d.product).trim() : '';
    if (product) productSet.add(product);
  }

  const lines = details.length;
  const dimsCoverage: DimsCoverage =
    lines > 0 && linesWithFullDims === lines ? 'full'
      : linesWithFullDims > 0 ? 'partial'
        : sawCritical ? 'critical'
          : 'none';

  // Weight: prefer the stop-level weight, else the summed line weights.
  const stopWeight = toLbs(stop?.weight, stop?.weightUOM);
  const weightLb = stopWeight != null && stopWeight > 0 ? Math.round(stopWeight)
    : sawLineWeight ? Math.round(lineWeightSum) : null;

  const pallets = Number.isFinite(stop?.pallets) ? Number(stop.pallets) : null;
  const cartons = Number.isFinite(stop?.cartons) ? Number(stop.cartons) : null;
  const lbPerPallet = weightLb != null && pallets && pallets > 0 ? round2(weightLb / pallets) : null;

  const cubeFt3Dims = dimsCoverage === 'full' && cubeDims > 0 ? round2(cubeDims) : null;
  const cubeFt3PalletEst = pallets && pallets > 0
    ? round2((pallets * PALLET_FOOTPRINT_IN2 * stackHeightIn) / 1728) : null;

  let cubeFt3Used: number | null = null;
  let cubeSource: 'dims' | 'pallet_est' | 'none' = 'none';
  if (cubeFt3Dims != null) { cubeFt3Used = cubeFt3Dims; cubeSource = 'dims'; }
  else if (cubeFt3PalletEst != null) { cubeFt3Used = cubeFt3PalletEst; cubeSource = 'pallet_est'; }

  const densityPcf = weightLb != null && cubeFt3Used && cubeFt3Used > 0
    ? round2(weightLb / cubeFt3Used) : null;
  const freightClass = densityPcf != null ? densityToClass(densityPcf) : null;

  return {
    lines, linesWithFullDims, dimsCoverage,
    weightLb, pallets, cartons, lbPerPallet,
    skus: [...skuSet], products: [...productSet],
    cubeFt3Dims, cubeFt3PalletEst, cubeFt3Used, cubeSource,
    densityPcf, freightClass, oversize, hasLongCat,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
