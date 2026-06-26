// Write credentials are now supplied by the server from env vars (UAT) — the UI
// no longer collects them. This hook is kept for the components that still import
// it; it reports writes as always enabled and sends no per-request creds (so the
// write function falls back to NUVIZZ_DAVIS_* on the server).

export function useWriteCreds() {
  return { creds: {}, setCreds: () => {}, canWrite: true }
}
