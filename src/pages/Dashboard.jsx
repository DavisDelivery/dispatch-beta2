import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchFleet, fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildStopView } from '../lib/stopView.js'
import { formatUSD } from '../lib/stopView.js'
import { formatDate } from '../lib/format.js'
import FreshnessStamp from '../components/FreshnessStamp.jsx'
import { useSelectedDate } from '../hooks/useSelectedDate.js'

// Dashboard — the day's status pulse + two tiles for the selected day.
// The revenue tile is a lean secondary __fleetstops fetch and must never block
// the main pulse view.
export default function Dashboard() {
  const { date, isToday } = useSelectedDate()
  const [fleet, setFleet] = useState({ status: 'loading', loads: [], meta: null, error: '' })
  const [rev, setRev] = useState({ status: 'loading', total: 0, billed: 0 })

  useEffect(() => {
    let cancelled = false
    setFleet({ status: 'loading', loads: [], meta: null, error: '' })
    fetchFleet({ date })
      .then((res) => {
        if (!cancelled)
          setFleet({
            status: 'ready',
            loads: res.loads,
            meta: { source: res.source, cachedAt: res.cachedAt, mock: res.mock },
            error: '',
          })
      })
      .catch((err) => {
        if (!cancelled) setFleet({ status: 'error', loads: [], meta: null, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [date])

  // Secondary, non-blocking revenue fetch.
  useEffect(() => {
    let cancelled = false
    setRev({ status: 'loading', total: 0, billed: 0 })
    fetchFleetStops({ date })
      .then(({ stops }) => {
        if (cancelled) return
        let total = 0
        let billed = 0
        for (const s of stops) {
          const v = buildStopView(s)
          if (v.revenue != null) {
            total += v.revenue
            billed += 1
          }
        }
        setRev({ status: 'ready', total, billed })
      })
      .catch(() => {
        if (!cancelled) setRev({ status: 'error', total: 0, billed: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [date])

  const pulse = useMemo(() => {
    const loads = fleet.loads
    const drivers = new Set(loads.map((l) => l.driverUserName).filter(Boolean)).size
    const stops = loads.reduce((n, l) => n + (l.stopCount || 0), 0)
    const issues = loads.reduce((n, l) => n + (l.stopsExceptions || 0), 0)
    const delivered = loads.reduce((n, l) => n + (l.stopsDelivered || 0), 0)
    const pct = stops > 0 ? Math.round((delivered / stops) * 100) : 0
    const unassigned = loads.filter((l) => !l.driverUserName).length
    return { loads: loads.length, drivers, stops, issues, pct, unassigned }
  }, [fleet.loads])

  const dayLabel = isToday ? 'today' : formatDate(date + 'T12:00:00Z')

  // Preserve the selected date on every drill-down link.
  const withDate = (path) => {
    if (isToday) return path
    return path.includes('?') ? `${path}&date=${date}` : `${path}?date=${date}`
  }

  const unassignedLoadsHref = withDate('/loads?status=Unassigned')
  const stopsHref = withDate('/stops')

  return (
    <section className="page page--dash">
      <div className="stops__head">
        <h1 className="page__title">
          Dashboard
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
        </h1>
        <p className="stops__count">
          {fleet.status === 'ready' ? <FreshnessStamp meta={fleet.meta} /> : <>&nbsp;</>} · {dayLabel}
        </p>
      </div>

      {fleet.status === 'error' && (
        <p className="stops__msg stops__msg--error">Could not load fleet: {fleet.error}</p>
      )}

      <div className="pulse">
        <Stat label="Loads" value={fleet.status === 'ready' ? pulse.loads : '—'} to={withDate('/loads')} />
        <Stat label="Drivers" value={fleet.status === 'ready' ? pulse.drivers : '—'} to={withDate('/workbench')} />
        <Stat label="Stops" value={fleet.status === 'ready' ? pulse.stops : '—'} to={withDate('/stops')} />
        <Stat
          label="Issues"
          value={fleet.status === 'ready' ? pulse.issues : '—'}
          tone={pulse.issues > 0 ? 'danger' : undefined}
          to={withDate('/loads?status=Exceptions')}
        />
        <Stat
          label="% Complete"
          value={fleet.status === 'ready' ? `${pulse.pct}%` : '—'}
          to={withDate('/loads?status=Complete')}
        />
      </div>

      <h2 className="dash__h2">{isToday ? 'Today' : dayLabel}</h2>
      <div className="tiles">
        <Link className="tile" to={unassignedLoadsHref}>
          <span className="tile__big">{fleet.status === 'ready' ? pulse.unassigned : '—'}</span>
          <span className="tile__label">Unassigned Loads</span>
          <span className="tile__hint">Tap to view unassigned →</span>
        </Link>

        <Link className="tile tile--rev" to={stopsHref}>
          <span className="tile__big">
            {rev.status === 'ready' ? formatUSD(rev.total) : rev.status === 'error' ? '—' : '…'}
          </span>
          <span className="tile__label">Non-Uline Rev {dayLabel}</span>
          <span className="tile__hint">
            {rev.status === 'ready' ? `${rev.billed} billed stops →` : 'Calculating…'}
          </span>
        </Link>
      </div>
    </section>
  )
}

function Stat({ label, value, tone, to }) {
  const cls = `stat ${tone === 'danger' ? 'stat--danger' : ''} ${to ? 'stat--link' : ''}`
  const inner = (
    <>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </>
  )
  return to ? (
    <Link className={cls} to={to}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  )
}
