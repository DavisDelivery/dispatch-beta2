import { formatTime } from '../lib/format.js'

// "as of 7:05a" freshness stamp, driven by the API response metadata.
//   meta = { source: 'cache' | 'live', cachedAt: <ms> | null, mock?: true }
// When the data came from the warm cache, the stamp shows when it was cached.
// When it came from a live (cold) scan, a subtle "warming…" marker explains the
// first-load delay instead of letting it look broken.
export default function FreshnessStamp({ meta }) {
  if (!meta) return null
  const when =
    meta.source === 'cache' && meta.cachedAt ? formatTime(meta.cachedAt) : formatTime(Date.now())
  return (
    <span className="freshness">
      as of {when}
      {meta.source === 'live' && <span className="freshness__warming">warming…</span>}
    </span>
  )
}
