import { StopChips } from './StopChips.jsx'
import { formatText } from '../lib/format.js'

// One stop, rendered as an intelligence card: chips, appointment reality, soft
// receiving hours, Non-Uline Rev, plus address/status/ETA. Reused by the Stops
// page and the Loads detail drawer.
const BUCKET_CLASS = {
  Delivered: 'is-delivered',
  'En Route': 'is-enroute',
  Exception: 'is-exception',
  Scheduled: 'is-scheduled',
  Pending: 'is-pending',
  Other: 'is-other',
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

  return (
    <article className="stopcard">
      <div className="stopcard__top">
        <div className="stopcard__who">
          <h3 className="stopcard__name">{formatText(stop.name)}</h3>
          <p className="stopcard__addr">
            {[stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', ')}
          </p>
        </div>
        <div className="stopcard__rev">
          {revenueText && (
            <>
              <span className="stopcard__rev-amt">{revenueText}</span>
              <span className="stopcard__rev-lbl">Non-Uline Rev</span>
            </>
          )}
        </div>
      </div>

      <StopChips chips={chips} />

      <div className="stopcard__meta">
        <span className={`statusdot ${BUCKET_CLASS[bucket] || 'is-other'}`}>{bucket}</span>
        {eta && <span className="stopcard__eta">ETA {eta}</span>}
        <span className={`stopcard__appt ${appt.placeholder ? 'is-placeholder' : ''}`}>
          {appt.placeholder ? appt.text : `Appt ${appt.text}`}
        </span>
        {recvText && (
          <span className="stopcard__recv" title="Receiving hours are advisory only">
            {recvText} <span className="soft-mark">soft</span>
          </span>
        )}
        {stop.loadNbr && <span className="stopcard__load">{stop.routeName || stop.loadNbr}</span>}
        {stop.driverName && <span className="stopcard__driver">{stop.driverName}</span>}
      </div>

      {parsed.other.length > 0 && (
        <p className="stopcard__notes">{parsed.other.join('; ')}</p>
      )}
    </article>
  )
}
