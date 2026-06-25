// DISABLED (v0.17.0) — the scheduled scan is OFF.
//
// We no longer scan NuVizz. The app is local-first (hardcoded loads + the
// created-orders registry) and only calls the API on create / plan / unplan.
// This function used to run a */5min cron that scanned ~600 load numbers to warm
// the Blobs cache; the cron schedule has been REMOVED so it never fires. The
// handler is a no-op kept only so a stale scheduled registration can't scan.

export default async function handler() {
  return new Response(JSON.stringify({ disabled: true, reason: 'scans removed (local-first)' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
