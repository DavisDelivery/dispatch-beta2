// nuvizz-refresh-stops-background.mts  (M5.2 · 24/7 since v0.11.2)
//
// Scheduled BACKGROUND writer for the Firestore stop index. The inline scan
// can't run on the request path — load+unplanned scan is >22s and 502s past the
// 26s request cap — so the scan lives here instead, and the map reads the index
// in <2s (see nuvizz-pull-today-stops.mts). The shared scan + write logic is in
// lib/refresh-stops-core.mts.
//
// The "-background" suffix is what gives the 15-min budget the multi-day scan
// needs; a plain scheduled function caps at 30s.
//
// Manual trigger (any time): POST /.netlify/functions/nuvizz-refresh-stops-background
//   optional ?date=YYYY-MM-DD (single date) or ?days=N (today+N-1).
//   Background fns return 202 and run async — poll the read endpoint's
//   lastScannedAt to confirm (see acceptance test in RESEARCH-m5.md).
//   NOTE: scheduled (cron) triggers only fire on PUBLISHED deploys, never on
//   deploy previews/branch deploys — use the manual POST to test a preview.
//
// ── Schedule: every 5 minutes, every hour, every day (24/7) ──────────────────
//   */5 * * * *
// v0.11.2 widened the old business-hours windows (two files: daytime
// */5 14-23 * * 1-5 + evening */5 0-3 * * 1-6) to continuous coverage. Rationale:
//   • drivers can start as early as ~7am ET — the old 10am ET start missed
//     early-morning execution/status changes;
//   • catches overnight system/board changes and rare weekend activity;
//   • a single 24/7 expression makes ONE function cover all days/hours, so the
//     second (evening) wrapper was removed — running both every 5 min would just
//     double the NuVizz load and Firestore writes against the same dates/index
//     for no benefit. One scheduled function, one cron.
//
// ── DST: no adjustment needed ────────────────────────────────────────────────
// The old windowed expressions were tuned to ET local hours and had to be
// shifted on the 2026-11-01 EDT→EST flip (and back 2027-03-08). A 24/7 every-5-min
// cron is timezone-agnostic — it runs the same regardless of UTC offset — so the
// DST flips require NO change to this expression.

import { runRefreshStops } from './lib/refresh-stops-core.mts';

export default runRefreshStops;

// P0 (Jun 2026, runaway-volume incident): cron eased from */5 (288 runs/day) to
// */15 (96 runs/day). Combined with the today-only scan (refresh-stops-core
// DEFAULT_DAYS 8→1) and the narrowed load window (nuvizz-scan LOAD_WINDOW_HALF
// 600→250), per-day scheduled NuVizz calls drop ~24× vs. the incident baseline.
// A 15-minute index freshness is acceptable for a dispatch board; tighten again
// only with real cost numbers in hand (see the runaway-calls incident report).
export const config = {
  schedule: '*/15 * * * *',
};
