import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchFleet, fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildStopView } from '../lib/stopView.js'
import { formatUSD } from '../lib/stopView.js'

// Dashboard — the day's status pulse + two "Today" tiles. The revenue tile is a
// lean secondary __fleetstops fetch and must never block the main pulse view.
export default function Dashboard() {
  const [fleet, setFleet] = useState({ status: 'loading', loads: [], error: '' })
  const [rev, setRev] = useState({ status: 'loading', total: 0, billed: 0 })
  const [asOf] = useState(() => new Date())

  useEffect(() => {
    let cancelled = false
    fetchFleet({ date: 'today' })
      .then(({ loads }) => {
        if (!cancelled) setFleet({ status: 'ready', loads, error: '' })
      })
      .catch((err) => {
        if (!cancelled) setFleet({ status: 'error', loads: [], error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Secondary, non-blocking revenue fetch.
  useEffect(() => {
    let cancelled = false
    fetchFleetStops({ date: 'today' })
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
  }, [])

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

  const asOfText = asOf.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  return (
    <section className="page page--dash">
      <div className="stops__head">
        <h1 className="page__title">
          Dashboard
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
        </h1>
        <p className="stops__count">as of {asOfText} · today</p>
      </div>

      {fleet.status === 'error' && (
        <p className="stops__msg stops__msg--error">Could not load fleet: {fleet.error}</p>
      )}

      <div className="pulse">
        <Stat label="Loads" value={fleet.status === 'ready' ? pulse.loads : '—'} />
        <Stat label="Drivers" value={fleet.status === 'ready' ? pulse.drivers : '—'} />
        <Stat label="Stops" value={fleet.status === 'ready' ? pulse.stops : '—'} />
        <Stat
          label="Issues"
          value={fleet.status === 'ready' ? pulse.issues : '—'}
          tone={pulse.issues > 0 ? 'danger' : undefined}
        />
        <Stat label="% Complete" value={fleet.status === 'ready' ? `${pulse.pct}%` : '—'} />
      </div>

      <h2 className="dash__h2">Today</h2>
      <div className="tiles">
        <Link className="tile" to="/loads?status=Unassigned">
          <span className="tile__big">{fleet.status === 'ready' ? pulse.unassigned : '—'}</span>
          <span className="tile__label">Unassigned Loads</span>
          <span className="tile__hint">Tap to view unassigned →</span>
        </Link>

        <Link className="tile" to="/stops">
          <span className="tile__big">
            {rev.status === 'ready' ? formatUSD(rev.total) : rev.status === 'error' ? '—' : '…'}
          </span>
          <span className="tile__label">Non-Uline Rev today</span>
          <span className="tile__hint">
            {rev.status === 'ready' ? `${rev.billed} billed stops →` : 'Calculating…'}
          </span>
        </Link>
      </div>
    </section>
  )
}

function Stat({ label, value, tone }) {
  return (
    <div className={`stat ${tone === 'danger' ? 'stat--danger' : ''}`}>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  )
}
