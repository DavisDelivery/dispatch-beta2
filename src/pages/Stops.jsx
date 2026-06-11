import { useEffect, useMemo, useState } from 'react'
import { fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildStopView, STATUS_FILTERS, matchesStatusFilter } from '../lib/stopView.js'
import { STOP_CHIPS } from '../lib/parseStopComments.ts'
import { formatDate } from '../lib/format.js'
import { useSortableTable } from '../hooks/useSortableTable.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import StopCard from '../components/StopCard.jsx'
import { ChipLegend } from '../components/StopChips.jsx'
import SortPills from '../components/SortPills.jsx'
import FreshnessStamp from '../components/FreshnessStamp.jsx'
import ExportButton from '../components/ExportButton.jsx'

// Stops Intelligence — the keystone. Each stop's comments are parsed into chips,
// a soft (advisory) receiving window, appointment reality and Non-Uline Rev.
const SORT_OPTIONS = [
  { key: 'plannedEta', label: 'ETA' },
  { key: 'name', label: 'Customer' },
  { key: 'revenue', label: 'Non-Uline Rev' },
  { key: 'recvStart', label: 'Receiving Hrs' },
]
const SORT_TYPES = { plannedEta: 'date', name: 'text', revenue: 'number', recvStart: 'text' }

export default function Stops() {
  const { date, isToday } = useSelectedDate()
  const [state, setState] = useState({ status: 'loading', stops: [], meta: null, error: '' })
  const [statusFilter, setStatusFilter] = useState('All')
  const [chipFilters, setChipFilters] = useState({}) // key -> bool
  const [recvOnly, setRecvOnly] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', stops: [], meta: null, error: '' })
    fetchFleetStops({ date })
      .then((res) => {
        if (!cancelled)
          setState({
            status: 'ready',
            stops: res.stops,
            meta: { source: res.source, cachedAt: res.cachedAt, mock: res.mock },
            error: '',
          })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', stops: [], meta: null, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [date])

  // Parse every stop once.
  const views = useMemo(() => state.stops.map(buildStopView), [state.stops])

  const activeChipKeys = useMemo(
    () => STOP_CHIPS.filter((c) => chipFilters[c.key]).map((c) => c.key),
    [chipFilters],
  )

  // Filters are ANDed: status + every active chip + has-receiving-hours.
  const filtered = useMemo(() => {
    return views.filter((v) => {
      if (!matchesStatusFilter(v, statusFilter)) return false
      for (const key of activeChipKeys) {
        if (!v.parsed[key]) return false
      }
      if (recvOnly && !v.parsed.receivingHours) return false
      return true
    })
  }, [views, statusFilter, activeChipKeys, recvOnly])

  const { sortedItems, sortKey, sortDirection, requestSort } = useSortableTable(filtered, {
    initialKey: 'plannedEta',
    initialDirection: 'asc',
    types: SORT_TYPES,
  })

  // Live counts for each filter control.
  const statusCounts = useMemo(() => {
    const counts = {}
    for (const f of STATUS_FILTERS) counts[f] = views.filter((v) => matchesStatusFilter(v, f)).length
    return counts
  }, [views])

  const chipCounts = useMemo(() => {
    const counts = {}
    for (const c of STOP_CHIPS) counts[c.key] = views.filter((v) => v.parsed[c.key]).length
    return counts
  }, [views])

  const recvCount = useMemo(() => views.filter((v) => v.parsed.receivingHours).length, [views])

  const activeFilterCount = activeChipKeys.length + (recvOnly ? 1 : 0)

  function toggleChip(key) {
    setChipFilters((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const dayLabel = isToday ? 'today' : formatDate(date + 'T12:00:00Z')

  return (
    <section className="page page--stops">
      <div className="stops__head">
        <h1 className="page__title">
          Stops
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
        </h1>
        <p className="stops__count">
          {state.status === 'ready' ? (
            <>
              <strong>{sortedItems.length}</strong>
              {sortedItems.length !== views.length && <> (of {views.length})</>} stops · {dayLabel} ·{' '}
              <FreshnessStamp meta={state.meta} />
            </>
          ) : (
            <>&nbsp;</>
          )}
        </p>
      </div>

      {/* Status filter */}
      <div className="filterbar">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`filterchip ${statusFilter === f ? 'is-active' : ''}`}
            aria-pressed={statusFilter === f}
            onClick={() => setStatusFilter(f)}
          >
            {f} <span className="filterchip__n">{statusCounts[f] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* Tools row: Filters disclosure + sort + CSV export */}
      <div className="tools-row">
        <button
          type="button"
          className={`tool-btn ${filtersOpen || activeFilterCount > 0 ? 'is-active' : ''}`}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          {filtersOpen ? '▾' : '▸'} Filters
          {activeFilterCount > 0 && <span className="tool-btn__n">{activeFilterCount}</span>}
        </button>
        <SortPills
          options={SORT_OPTIONS}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSort={requestSort}
        />
        <ExportButton
          stops={sortedItems.map((v) => v.stop)}
          filename={`stops-${date}.csv`}
        />
      </div>

      {/* Per-chip toggle filters + receiving-hours toggle (collapsed by default) */}
      {filtersOpen && (
        <div className="filterpanel">
          {STOP_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`filterchip filterchip--chip ${chipFilters[c.key] ? 'is-active' : ''}`}
              aria-pressed={!!chipFilters[c.key]}
              style={{ '--chip': c.color }}
              onClick={() => toggleChip(c.key)}
            >
              {c.label} <span className="filterchip__n">{chipCounts[c.key] ?? 0}</span>
            </button>
          ))}
          <button
            type="button"
            className={`filterchip ${recvOnly ? 'is-active' : ''}`}
            aria-pressed={recvOnly}
            onClick={() => setRecvOnly((v) => !v)}
          >
            Receiving hrs <span className="filterchip__n">{recvCount}</span>
          </button>
          <ChipLegend />
        </div>
      )}

      {state.status === 'loading' && <p className="stops__msg">Loading stops…</p>}
      {state.status === 'error' && (
        <p className="stops__msg stops__msg--error">Could not load stops: {state.error}</p>
      )}
      {state.status === 'ready' && sortedItems.length === 0 && (
        <p className="stops__msg">No stops match the current filters.</p>
      )}

      {state.status === 'ready' && sortedItems.length > 0 && (
        <div className="stoplist">
          {sortedItems.map((v, i) => (
            <StopCard key={`${v.stop.loadNbr}-${v.stop.stopNbr}-${i}`} view={v} />
          ))}
        </div>
      )}
    </section>
  )
}
