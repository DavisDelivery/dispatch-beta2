// lib/scan-metrics.mts
//
// Lightweight "learn what we actually need" instrumentation for NuVizz load
// discovery. Each scan records how many loads it found, how many were NEW since
// the prior high-water, and the largest GAP between consecutive load numbers.
// Over a few days this tells us the real daily delta (~10) and the worst gap, so
// we can size the adaptive forward-walk's "stop after K empties" threshold from
// evidence instead of guessing — and detect if we ever start missing loads.

export interface ScanMetricSample {
  date: string;          // delivery date scanned
  at: string;            // ET timestamp of the scan
  foundLoads: number;    // loads found for the date this scan
  newLoads: number | null; // increase in maxLoadNbr vs prior roster (null if unknown)
  maxGap: number;        // largest gap between consecutive found load numbers
  windowProbed: number | null; // how many load numbers we actually probed
  lean: boolean;         // lean (incremental) vs cold wide-window
  missed: number;        // parity: loads the lean plan WOULD have missed (0 = safe)
}

// PURE: largest gap between consecutive (sorted, de-duped) numbers. 0 for <2.
export function maxConsecutiveGap(nums: number[]): number {
  const s = [...new Set((nums || []).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  let g = 0;
  for (let i = 1; i < s.length; i++) g = Math.max(g, s[i] - s[i - 1]);
  return g;
}

// PURE: roll up recent samples into a "what do we need" summary. The recommended
// empty-stop threshold is the worst observed gap + margin (so an adaptive walk
// never ends before bridging the largest real gap we've seen), floored at a
// sensible minimum. Exported for tests + the ops payload.
export function summarizeScanMetrics(
  samples: ScanMetricSample[],
  opts: { lookback?: number; minEmptyStop?: number; margin?: number } = {},
) {
  const lookback = opts.lookback ?? 300;
  const minEmptyStop = opts.minEmptyStop ?? 25;
  const margin = opts.margin ?? 10;
  const s = (samples || []).slice(-lookback);
  if (!s.length) return { scans: 0, avgNewLoads: 0, maxNewLoads: 0, maxGap: 0, recommendedEmptyStop: minEmptyStop, missedScans: 0, lastFoundLoads: 0 };
  const newLoads = s.map((x) => x.newLoads).filter((x): x is number => x != null && x >= 0);
  const gaps = s.map((x) => x.maxGap || 0);
  const avgNew = newLoads.length ? newLoads.reduce((a, b) => a + b, 0) / newLoads.length : 0;
  const maxNew = newLoads.length ? Math.max(...newLoads) : 0;
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const missedScans = s.filter((x) => (x.missed || 0) > 0).length;
  return {
    scans: s.length,
    avgNewLoads: Math.round(avgNew * 10) / 10,
    maxNewLoads: maxNew,
    maxGap,
    recommendedEmptyStop: Math.max(minEmptyStop, maxGap + margin),
    missedScans,
    lastFoundLoads: s[s.length - 1]?.foundLoads ?? 0,
  };
}
