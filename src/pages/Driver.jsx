import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { fetchDriver } from '../lib/nuvizzApi.js'
import { buildStopView, formatUSD } from '../lib/stopView.js'
import { formatDate, formatTime, formatNumber } from '../lib/format.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import StopCard from '../components/StopCard.jsx'
import FreshnessStamp from '../components/FreshnessStamp.jsx'
import ExportButton from '../components/ExportButton.jsx'
import PrintButton from '../components/PrintButton.jsx'

export default function Driver() {
  const { userName } = useParams()
  const { date, isToday } = useSelectedDate()
  const [state, setState] = useState({ status: 'loading', data: null, error: '' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', data: null, error: '' })

    fetchDriver({ date, userName })
      .then((res) => {
        if (cancelled) return
        setState({ status: 'ready', data: res, error: '' })
      })
      .catch((err) => {
        if (!cancelled)
          setState({ status: 'error', data: null, error: err.message })
      })

    return () => {
      cancelled = true
    }
  }, [date, userName])

  const data = state.data

  // Derive display name from first load or stop, fall back to userName.
  const driverName =
    (data?.loads?.[0]?.driverName) ||
    (data?.stops?.[0]?.driverName) ||
    userName

  // Build stop views (stops already sorted by plannedEta from the API).
  const stopViews = data?.stops?.map(buildStopView) ?? []

  // Summary stats.
  const totalLoads = data?.loads?.length ?? 0
  const totalStops = data?.stops?.length ?? 0
  const totalDelivered = data?.loads?.reduce((n, l) => n + (l.stopsDelivered ?? 0), 0) ?? 0
  const totalExceptions = data?.loads?.reduce((n, l) => n + (l.stopsExceptions ?? 0), 0) ?? 0
  const totalRevenue = stopViews.reduce((sum, v) => sum + (v.revenue ?? 0), 0)
  const hasRevenue = stopViews.some((v) => v.revenue != null)

  // ETA window across all stops.
  const etas = (data?.stops ?? []).map((s) => s.plannedEta).filter(Boolean)
  const firstEta = etas.length > 0 ? etas[0] : null
  const lastEta = etas.length > 1 ? etas[etas.length - 1] : null
  const etaWindow =
    firstEta && lastEta && firstEta !== lastEta
      ? `${formatTime(firstEta)}–${formatTime(lastEta)}`
      : firstEta
      ? formatTime(firstEta)
      : null

  // Back-link — preserve ?date when not today.
  const workbenchHref = isToday ? '/workbench' : `/workbench?date=${date}`

  const dayLabel = isToday ? 'today' : formatDate(date + 'T12:00:00Z')

  const meta = data
    ? { source: data.source, cachedAt: data.cachedAt, mock: data.mock }
    : null

  // Route names / load numbers pill line.
  const loadPills = data?.loads ?? []

  return (
    <section className="page page--driver">
      {/* Print-only manifest header — invisible on screen, shown when printing */}
      <div className="print-only print-header">
        <div className="print-header__title">Davis Dispatch — Driver Manifest</div>
        <div className="print-header__meta">
          <span className="print-header__driver">{state.status === 'ready' ? driverName : userName}</span>
          <span className="print-header__sep">·</span>
          <span className="print-header__date">{formatDate(date + 'T12:00:00Z')}</span>
          {state.status === 'ready' && (
            <>
              <span className="print-header__sep">·</span>
              <span className="print-header__counts">
                {totalLoads} load{totalLoads !== 1 ? 's' : ''}, {totalStops} stop{totalStops !== 1 ? 's' : ''}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Back link */}
      <div className="driver-back">
        <Link to={workbenchHref} className="driver-back__link">
          &#8249; Workbench
        </Link>
      </div>

      {/* Header */}
      <div className="stops__head">
        <h1 className="page__title driver__title">
          {state.status === 'ready' ? driverName : userName}
        </h1>
        <p className="stops__count">
          {state.status === 'ready' ? (
            <>
              <strong>{totalLoads}</strong> load{totalLoads !== 1 ? 's' : ''} ·{' '}
              <strong>{totalStops}</strong> stop{totalStops !== 1 ? 's' : ''} · {dayLabel} ·{' '}
              <FreshnessStamp meta={meta} />
            </>
          ) : (
            <>&nbsp;</>
          )}
        </p>
      </div>

      {/* Loading / error / empty states */}
      {state.status === 'loading' && (
        <p className="stops__msg">Loading driver day&hellip;</p>
      )}
      {state.status === 'error' && (
        <p className="stops__msg stops__msg--error">
          Could not load driver data: {state.error}
        </p>
      )}
      {state.status === 'ready' && totalStops === 0 && (
        <p className="stops__msg">No stops found for this driver on {dayLabel}.</p>
      )}

      {/* Summary strip */}
      {state.status === 'ready' && totalStops > 0 && (
        <div className="driver-summary">
          <div className="driver-stat">
            <span className="driver-stat__value">{formatNumber(totalLoads)}</span>
            <span className="driver-stat__label">Loads</span>
          </div>
          <div className="driver-stat">
            <span className="driver-stat__value">{totalDelivered}/{totalStops}</span>
            <span className="driver-stat__label">Delivered</span>
          </div>
          <div className={`driver-stat ${totalExceptions > 0 ? 'driver-stat--exc' : ''}`}>
            <span className="driver-stat__value">{formatNumber(totalExceptions)}</span>
            <span className="driver-stat__label">Exceptions</span>
          </div>
          {hasRevenue && (
            <div className="driver-stat driver-stat--rev">
              <span className="driver-stat__value">{formatUSD(totalRevenue)}</span>
              <span className="driver-stat__label">Non-Uline Rev</span>
            </div>
          )}
          {etaWindow && (
            <div className="driver-stat driver-stat--eta">
              <span className="driver-stat__value">{etaWindow}</span>
              <span className="driver-stat__label">ETA Window</span>
            </div>
          )}
        </div>
      )}

      {/* Load pills (route names + load numbers) + CSV export */}
      {state.status === 'ready' && loadPills.length > 0 && (
        <div className="driver-loads">
          {loadPills.map((l) => (
            <span key={l.loadNbr} className="driver-load-pill">
              {l.routeName || l.loadNbr}
              <span className="driver-load-pill__nbr">#{l.loadNbr}</span>
            </span>
          ))}
        </div>
      )}
      {state.status === 'ready' && (
        <div className="tools-row">
          <ExportButton
            stops={data?.stops ?? []}
            filename={`driver-${userName}-${date}.csv`}
          />
          <PrintButton />
        </div>
      )}

      {/* Ordered stop sequence */}
      {state.status === 'ready' && stopViews.length > 0 && (
        <div className="stoplist">
          {stopViews.map((v, i) => (
            <div
              key={`${v.stop.loadNbr}-${v.stop.stopNbr ?? i}-${i}`}
              className="wb-stop-wrap"
            >
              <span className="wb-seq">{i + 1}</span>
              <div className="wb-stop-card">
                <StopCard view={v} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
