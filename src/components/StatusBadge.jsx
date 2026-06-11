// StatusBadge — purely presentational. Renders a colored dot + label for a
// load status bucket. Mirrors the stop-card accent palette for visual cohesion.
// Receives the raw bucket string; renders nothing special if unknown.

const BUCKET_HUE = {
  Complete: '#34d399',      // emerald — matches is-delivered
  'In Progress': '#38bdf8', // sky — matches is-enroute
  Exceptions: '#fb7185',    // rose — matches is-exception
  Planned: '#fbbf24',       // amber — matches is-scheduled
  Unassigned: '#94a3b8',    // slate — matches is-pending
}
const DEFAULT_HUE = '#64748b' // slate-500 — matches is-other

export default function StatusBadge({ bucket }) {
  if (!bucket) return '—'
  const hue = BUCKET_HUE[bucket] ?? DEFAULT_HUE
  return (
    <span className="status-badge" style={{ '--hue': hue }}>
      <span className="status-badge__dot" aria-hidden="true" />
      {bucket}
    </span>
  )
}
