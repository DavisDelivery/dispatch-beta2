// nuvizz-att-scan-background.mts  (Attempts — evening attempt scan + join)
//
// Scheduled BACKGROUND writer. Each evening run finds the day's delivery ATTEMPTS
// with ONE NuVizz call — the portal's ATTEMPTS saved search (shipment number starts
// with "ATT") — then JOINS each stop back to the driver who had it this morning (by
// stopNbr, from the 8am plan snapshot) and writes the per-day attempts list
// attempts/{tenant}__{date}. Shared logic in lib/attempts-core.mts.
//
// Manual trigger (any time; cron only fires on PUBLISHED deploys):
//   POST /.netlify/functions/nuvizz-att-scan-background?date=YYYY-MM-DD
//   No query string → today (ET), gated to the 20:00–23:59 ET window. Re-runnable.
//   NOTE: needs the SAME day's morning snapshot to attribute drivers, so run the
//   plan-snapshot job for a date before back-running this one.
//
// ── Schedule: 00:00–03:00 UTC hourly ─────────────────────────────────────────
//   0 0,1,2,3 * * *
// 8:00pm ET is 00:00 UTC under EDT (UTC-4) and 01:00 UTC under EST (UTC-5) — both the
// NEXT UTC date but the SAME ET day (so attempts-core targets etDayString(), not
// todayUTC()). Firing across 00:00–03:00 UTC lands several fires in the 20:00–23:59 ET
// window (EDT 8/9/10/11pm; EST 7/8/9/10pm — the 7pm one is gated out). The scan has NO
// once-per-day gate, so each in-window fire re-runs and catches attempts marked later
// in the evening — one cheap saved-search call per run.

import { runAttemptsScan } from './lib/attempts-core.mts';

export default runAttemptsScan;

export const config = {
  schedule: '0 0,1,2,3 * * *',
};
