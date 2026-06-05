import { useEffect, useMemo, useState } from 'react'
import { loadStops, IS_MOCK } from '../lib/stopsApi.js'
import {
  STOP_COLUMNS,
  STOP_COLUMN_TYPES,
  STOP_SEARCH_KEYS,
} from '../lib/stopColumns.js'
import { useSortableTable } from '../hooks/useSortableTable.js'
import SortableTh from '../components/SortableTh.jsx'

const PER_PAGE_OPTIONS = [10, 25, 50, 100]

export default function Stops() {
  const [state, setState] = useState({ status: 'loading', stops: [], meta: {}, error: '' })

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
  const [perPage, setPerPage] = useState(25)
  const [page, setPage] = useState(1)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', stops: [], meta: {}, error: '' })
    loadStops({ horizon: 'today' })
      .then(({ stops, meta }) => {
        if (!cancelled) setState({ status: 'ready', stops, meta, error: '' })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', stops: [], meta: {}, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Distinct status values for the filter dropdown.
  const statusOptions = useMemo(() => {
    const set = new Set(
      state.stops.map((s) => s.status).filter((v) => v != null && v !== ''),
    )
    return ['All', ...[...set].sort((a, b) => a.localeCompare(b))]
  }, [state.stops])

  // Apply status filter + quick-search before sorting.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return state.stops.filter((row) => {
      if (statusFilter !== 'All' && row.status !== statusFilter) return false
      if (!q) return true
      const haystack = STOP_SEARCH_KEYS.map((k) => row[k] ?? '')
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [state.stops, statusFilter, search])

  const { sortedItems, sortKey, sortDirection, requestSort } = useSortableTable(
    filtered,
    { initialKey: 'stopNumber', initialDirection: 'asc', types: STOP_COLUMN_TYPES },
  )

  // Reset to first page whenever the result set changes shape.
  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, perPage])

  const totalPages = Math.max(1, Math.ceil(sortedItems.length / perPage))
  const currentPage = Math.min(page, totalPages)
  const startIdx = sortedItems.length === 0 ? 0 : (currentPage - 1) * perPage
  const pageItems = sortedItems.slice(startIdx, startIdx + perPage)
  const showingFrom = sortedItems.length === 0 ? 0 : startIdx + 1
  const showingTo = startIdx + pageItems.length

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
              Showing <strong>{showingFrom}–{showingTo}</strong> of{' '}
              <strong>{sortedItems.length}</strong>
              {sortedItems.length !== state.stops.length && (
                <> (filtered from {state.stops.length})</>
              )}{' '}
              stops · today
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
          placeholder="Quick search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Quick search stops"
        />
        <label className="control control--select">
          <span className="control__label">Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {statusOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
        <label className="control control--select">
          <span className="control__label">Per page</span>
          <select
            value={perPage}
            onChange={(e) => setPerPage(Number(e.target.value))}
          >
            {PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.status === 'loading' && <p className="stops__msg">Loading stops…</p>}

      {state.status === 'error' && (
        <p className="stops__msg stops__msg--error">
          Could not load stops: {state.error}
        </p>
      )}

      {state.status === 'ready' && sortedItems.length === 0 && (
        <p className="stops__msg">No stops match the current filters.</p>
      )}

      {state.status === 'ready' && sortedItems.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  {STOP_COLUMNS.map((col) => (
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
                {pageItems.map((row, i) => (
                  <tr key={row.stopNumber ?? row.shipmentNumber ?? i}>
                    {STOP_COLUMNS.map((col) => (
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
    </section>
  )
}
