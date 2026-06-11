import { StopChips } from './StopChips.jsx'
import { formatText } from '../lib/format.js'

// One stop, rendered as an intelligence card: a status accent bar, clear
// name/address hierarchy, Non-Uline Rev, special-instruction chips, and a tidy
// meta line (status · ETA · appointment reality · soft receiving hours · route).
// Reused by the Stops page and the Loads detail drawer.
const BUCKET_SLUG = {
  Delivered: 'delivered',
  'En Route': 'enroute',
  Exception: 'exception',
  Scheduled: 'scheduled',
  Pending: 'pending',
  Other: 'other',
}

function fmtClock(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function StopCard({ view }) {
  const { stop, parsed, chips, bucket, appt, revenueText, recvText } = view
  const eta = fmtClock(stop.plannedEta)
  const slug = BUCKET_SLUG[bucket] || 'other'

  return (
    <article className={`stopcard is-${slug}`}>
      <div className="stopcard__top">
        <div className="stopcard__who">
          <h3 className="stopcard__name">{formatText(stop.name)}</h3>
          <p className="stopcard__addr">
            {[stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', ')}
          </p>
        </div>
        {revenueText && (
          <div className="stopcard__rev">
            <span className="stopcard__rev-amt">{revenueText}</span>
            <span className="stopcard__rev-lbl">Non-Uline Rev</span>
          </div>
        )}
      </div>

      <StopChips chips={chips} />

      <div className="stopcard__meta">
        <span className="stopcard__status">
          <span className="stopcard__dot" aria-hidden="true" />
          {bucket}
        </span>
        {eta && (
          <span className="meta-item">
            <span className="meta-k">ETA</span> {eta}
          </span>
        )}
        <span className={`meta-item ${appt.placeholder ? 'is-muted' : ''}`}>
          {appt.placeholder ? (
            appt.text
          ) : (
            <>
              <span className="meta-k">Appt</span> {appt.text}
            </>
          )}
        </span>
        {recvText && (
          <span className="stopcard__recv" title="Receiving hours are advisory only">
            {recvText} <span className="soft-mark">soft</span>
          </span>
        )}
        <span className="stopcard__spacer" />
        {stop.routeName && <span className="meta-item is-dim">{stop.routeName}</span>}
        {stop.driverName && <span className="meta-item is-dim">{stop.driverName}</span>}
      </div>

      {parsed.other.length > 0 && (
        <p className="stopcard__notes">{parsed.other.join(' · ')}</p>
      )}
    </article>
  )
}
