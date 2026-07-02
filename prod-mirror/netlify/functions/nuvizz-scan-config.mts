// nuvizz-scan-config.mts
//
// Read + edit the live scan schedule from the Diagnostics UI.
//   GET  /.netlify/functions/nuvizz-scan-config
//        → { ok, config, stored, defaults, bounds }
//        config   = effective schedule the scanner runs (defaults overlaid with stored)
//        stored   = just the persisted overrides (so the UI can show what's customized)
//        defaults = env/hardcoded baseline (what an empty doc falls back to)
//        bounds   = per-field [min,max] the editor clamps to
//   POST /.netlify/functions/nuvizz-scan-config   body: partial ScanConfig
//        → validates + clamps to bounds, persists to nuvizz_ops/scan_config, returns
//          the new effective config. The scheduled scanner reads this each run, so an
//          edit takes effect on the next cron fire (no redeploy).
//
// Validation/clamping is the SAME pure helper the scanner uses (scan-schedule.mts),
// so the UI can never persist a value the scanner would reject.

import { isFirestoreEnabled, readScanConfig, writeScanConfig } from './lib/firestore.mts';
import { clampScanConfig, effectiveScanConfig, scanConfigDefaults, SCAN_CONFIG_BOUNDS } from './lib/scan-schedule.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  if (!isFirestoreEnabled()) {
    // No Firestore (e.g. preview without FIREBASE_SA): still serve the defaults so the
    // editor renders, but it can't persist.
    return new Response(JSON.stringify({
      ok: true, persistent: false, config: effectiveScanConfig({}), stored: {},
      defaults: scanConfigDefaults(), bounds: SCAN_CONFIG_BOUNDS,
    }), { status: 200, headers: cors });
  }

  try {
    if (req.method === 'GET') {
      const stored = await readScanConfig();
      return new Response(JSON.stringify({
        ok: true, persistent: true, config: effectiveScanConfig(stored), stored,
        defaults: scanConfigDefaults(), bounds: SCAN_CONFIG_BOUNDS,
      }), { status: 200, headers: cors });
    }

    if (req.method === 'POST') {
      let body: any;
      try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, error: 'invalid JSON' }), { status: 400, headers: cors }); }

      const clean = clampScanConfig(body);
      // Merge onto any existing overrides so a partial edit doesn't drop other fields,
      // then stamp metadata. The scanner re-clamps on read, so this is safe regardless.
      const prior = await readScanConfig().catch(() => ({}));
      const toStore = { ...prior, ...clean, updatedAt: new Date().toISOString(), updatedBy: String(body?.updatedBy || 'diagnostics-ui').slice(0, 120) };
      await writeScanConfig(toStore);

      return new Response(JSON.stringify({
        ok: true, persistent: true, config: effectiveScanConfig(toStore), stored: toStore,
        defaults: scanConfigDefaults(), bounds: SCAN_CONFIG_BOUNDS,
      }), { status: 200, headers: cors });
    }

    return new Response(JSON.stringify({ ok: false, error: 'GET or POST only' }), { status: 405, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'scan-config failed' }), { status: 500, headers: cors });
  }
};
