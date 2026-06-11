import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchFleet, fetchLoadDetail, IS_MOCK } from '../lib/nuvizzApi.js'
import {
  LOAD_COLUMNS,
  LOAD_COLUMN_TYPES,
  LOAD_SEARCH_KEYS,
  LOAD_STATUS_FILTERS,
  matchesLoadFilter,
  buildLoadView,
} from '../lib/loadsModel.js'
import { buildStopView } from '../lib/stopView.js'
import { formatDate } from '../lib/format.js'
import { useSortableTable } from '../hooks/useSortableTable.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import SortableTh from '../components/SortableTh.jsx'
import StopCard from '../components/StopCard.jsx'
import FreshnessStamp from '../components/FreshnessStamp.jsx'

const PER_PAGE = 25

// Loads — real grid, READ-ONLY (no assign/dispatch/tender controls anywhere).
export default function Loads() {
  const [params, setParams] = useSearchParams()
  const { date, isToday } = useSelectedDate()
  const [state, setState] = useState({ status: 'loading', loads: [], meta: null, error: '' })
  const [search, setSearch] = useState('')
  // Read status from params — preserve alongside ?date.
  const statusFilter = params.get('status') || 'All'
  const [page, setPage] = useState(1)
  const [openLoad, setOpenLoad] = useState(null)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', loads: [], meta: null, error: '' })
    fetchFleet({ date })
      .then((res) => {
        if (!cancelled)
          setState({
            status: 'ready',
            loads: res.loads,
            meta: { source: res.source, cachedAt: res.cachedAt, mock: res.mock },
            error: '',
          })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', loads: [], meta: null, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [date])

  const views = useMemo(() => state.loads.map(buildLoadView), [state.loads])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return views.filter((v) => {
      if (!matchesLoadFilter(v, statusFilter)) return false
      if (!q) return true
      return LOAD_SEARCH_KEYS.map((k) => v[k] ?? '').join(' ').toLowerCase().includes(q)
    })
  }, [views, statusFilter, search])

  const { sortedItems, sortKey, sortDirection, requestSort } = useSortableTable(filtered, {
    initialKey: 'loadNbr',
    initialDirection: 'asc',
    types: LOAD_COLUMN_TYPES,
  })

  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, date])

  const totalPages = Math.max(1, Math.ceil(sortedItems.length / PER_PAGE))
  const currentPage = Math.min(page, totalPages)
  const startIdx = sortedItems.length === 0 ? 0 : (currentPage - 1) * PER_PAGE
  const pageItems = sortedItems.slice(startIdx, startIdx + PER_PAGE)

  // Preserve ?date when changing status filter.
  function setStatus(f) {
    const next = new URLSearchParams(params)
    if (f === 'All') next.delete('status')
    else next.set('status', f)
    setParams(next, { replace: true })
  }

  const dayLabel = isToday ? 'today' : formatDate(date + 'T12:00:00Z')

  return (
    <section className="page page--loads">
      <div className="stops__head">
        <h1 className="page__title">
          Loads
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
        </h1>
        <p className="stops__count">
          {state.status === 'ready' ? (
            <>
              <strong>{sortedItems.length}</strong>
              {sortedItems.length !== views.length && <> (of {views.length})</>} loads · {dayLabel} ·{' '}
              <FreshnessStamp meta={state.meta} />
            </>
          ) : (
            <>&nbsp;</>
          )}
        </p>
      </div>

      <div className="stops__controls">
        <input
          type="search"
          className="control control--search"
          placeholder="Search load / route / driver / PRO / reference…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Quick search loads"
        />
      </div>

      <div className="filterbar">
        {LOAD_STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`filterchip ${statusFilter === f ? 'is-active' : ''}`}
            aria-pressed={statusFilter === f}
            onClick={() => setStatus(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {state.status === 'loading' && <p className="stops__msg">Loading loads…</p>}
      {state.status === 'error' && (
        <p className="stops__msg stops__msg--error">Could not load loads: {state.error}</p>
      )}
      {state.status === 'ready' && sortedItems.length === 0 && (
        <p className="stops__msg">No loads match the current filters.</p>
      )}

      {state.status === 'ready' && sortedItems.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  {LOAD_COLUMNS.map((col) => (
                    <SortableTh
                      key={col.key}
                      columnKey={col.key}
                      label={col.label}
                      align={col.align}
                      sortKey={sortKey}
                      sortDirection={sortDirection}
                      onSort={requestSort}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageItems.map((row) => (
                  <tr
                    key={row.loadNbr}
                    className="data-table__row--click"
                    onClick={() => setOpenLoad(row)}
                  >
                    {LOAD_COLUMNS.map((col) => (
                      <td key={col.key} className={`align-${col.align}`}>
                        {col.render(row[col.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <button
              type="button"
              className="pager__btn"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
            >
              ‹ Prev
            </button>
            <span className="pager__status">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              className="pager__btn"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
            >
              Next ›
            </button>
          </div>
        </>
      )}

      {openLoad && <LoadDrawer load={openLoad} onClose={() => setOpenLoad(null)} />}
    </section>
  )
}

function LoadDrawer({ load, onClose }) {
  const [detail, setDetail] = useState({ status: 'loading', stops: [], error: '' })

  useEffect(() => {
    let cancelled = false
    setDetail({ status: 'loading', stops: [], error: '' })
    fetchLoadDetail({ loadNbr: load.loadNbr })
      .then(({ load: full }) => {
        if (cancelled) return
        setDetail({ status: 'ready', stops: (full && full.stops) || [], error: '' })
      })
      .catch((err) => {
        if (!cancelled) setDetail({ status: 'error', stops: [], error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [load.loadNbr])

  const views = useMemo(() => detail.stops.map(buildStopView), [detail.stops])

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label={`Load ${load.loadNbr}`}>
      <div className="drawer__scrim" onClick={onClose} />
      <div className="drawer__panel">
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{load.routeName || load.loadNbr}</h2>
            <p className="drawer__sub">
              {load.loadNbr} · {load.bucket}
              {load.loadStatus && <span className="drawer__raw"> (NuVizz: {load.loadStatus})</span>}
            </p>
          </div>
          <button type="button" className="drawer__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <dl className="drawer__facts">
          <Fact label="Driver" value={load.driver || 'Unassigned'} />
          <Fact label="PRO" value={load.pronbr} />
          <Fact label="Reference" value={load.reference} />
          <Fact label="Origin" value={load.origin} />
          <Fact label="Stops" value={load.stopCount} />
          <Fact label="Pallets" value={load.totalPallets} />
        </dl>

        <h3 className="drawer__section">Stops</h3>
        {detail.status === 'loading' && <p className="stops__msg">Loading stops…</p>}
        {detail.status === 'error' && (
          <p className="stops__msg stops__msg--error">Could not load stops: {detail.error}</p>
        )}
        {detail.status === 'ready' && views.length === 0 && (
          <p className="stops__msg">No stops on this load.</p>
        )}
        {detail.status === 'ready' && views.length > 0 && (
          <div className="stoplist">
            {views.map((v, i) => (
              <StopCard key={`${v.stop.stopNbr}-${i}`} view={v} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Fact({ label, value }) {
  return (
    <div className="fact">
      <dt className="fact__label">{label}</dt>
      <dd className="fact__value">{value == null || value === '' ? '—' : value}</dd>
    </div>
  )
}
