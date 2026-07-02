// nuvizz-att-plan-snapshot-background.mts  (Attempts — morning routed-plan freeze)
//
// Scheduled BACKGROUND writer. Each morning run freezes today's ROUTED plan —
// stopNbr → {driver, load, route, customer} for every PLANNED stop — into
// att_plan/{tenant}__{date}. This is the "who had it originally" record the evening
// attempt scan joins against. Shared logic lives in lib/attempts-core.mts.
//
// Manual trigger (any time; cron only fires on PUBLISHED deploys):
//   POST /.netlify/functions/nuvizz-att-plan-snapshot-background?date=YYYY-MM-DD
//   No query string → today (ET), gated to the 08:00–11:59 ET window, once/day.
//
// ── Schedule: 12:30 AND 13:30 UTC ────────────────────────────────────────────
//   30 12,13 * * *
// 8:30am ET is 12:30 UTC under EDT (UTC-4) and 13:30 UTC under EST (UTC-5). Firing
// at BOTH and gating on the real ET hour (attempts-core: window [8,12), once/day)
// means exactly one fire acts year-round with no DST code; if the first candidate is
// dropped, the second still finds the day not-yet-captured and runs.

import { runPlanSnapshot } from './lib/attempts-core.mts';

export default runPlanSnapshot;

export const config = {
  schedule: '30 12,13 * * *',
};
