import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildDriverGroups, matchesGroupSearch } from '../lib/workbenchModel.js'
import { formatTime, formatNumber } from '../lib/format.js'
import { useSortableTable } from '../hooks/useSortableTable.js'
import StopCard from '../components/StopCard.jsx'
import SortPills from '../components/SortPills.jsx'
import FreshnessStamp from '../components/FreshnessStamp.jsx'

// Driver-group sort options — useSortableTable operates over the flat group array.
const GROUP_SORT_OPTIONS = [
  { key: 'driverName', label: 'Driver' },
  { key: 'stopCount', label: 'Stops' },
  { key: 'firstEta', label: 'First ETA' },
  { key: 'revenue', label: 'Non-Uline Rev' },
]
const GROUP_SORT_TYPES = {
  driverName: 'text',
  stopCount: 'number',
  firstEta: 'date',
  revenue: 'number',
}

// A collapsible driver group section.
function DriverGroup({ group }) {
  const [open, setOpen] = useState(true)

  const etaWindow =
    group.firstEta && group.lastEta
      ? group.firstEta === group.lastEta
        ? formatTime(group.firstEta)
        : `${formatTime(group.firstEta)}–${formatTime(group.lastEta)}`
      : null

  return (
    <section className={`driver-group ${group.isUnassigned ? 'driver-group--unassigned' : ''}`}>
      {/* Collapsible header */}
      <button
        type="button"
        className="driver-group__hdr"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="driver-group__toggle" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>

        <span className="driver-group__name">
          {group.driverName}
          {group.isUnassigned && (
            <span className="driver-group__badge driver-group__badge--unassigned">Unassigned</span>
          )}
        </span>

        <span className="driver-group__meta">
          <span className="driver-group__stat">
            {group.loadCount} load{group.loadCount !== 1 ? 's' : ''}
          </span>
          <span className="driver-group__stat">
            {group.delivered}/{group.stopCount} delivered
          </span>
          {group.exceptions > 0 && (
            <span className="driver-group__stat driver-group__stat--exc">
              {group.exceptions} exc
            </span>
          )}
          {group.revenueText && (
            <span className="driver-group__stat driver-group__stat--rev">
              {group.revenueText}
            </span>
          )}
          {etaWindow && (
            <span className="driver-group__stat driver-group__stat--eta">
              {etaWindow}
            </span>
          )}
          <span className="driver-group__stat driver-group__stat--dim">
            {formatNumber(group.palletTotal)} plt · {formatNumber(group.cartonTotal)} ctn
          </span>
        </span>
      </button>

      {/* Expandable stop list */}
      {open && (
        <div className="driver-group__stops stoplist">
          {group.views.map((v, i) => (
            <div key={`${v.stop.loadNbr}-${v.stop.stopNbr}-${i}`} className="wb-stop-wrap">
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

export default function Workbench() {
  const [state, setState] = useState({ status: 'loading', groups: [], meta: null, error: '' })
  const [search, setSearch] = useState('')
  const [driverFilter, setDriverFilter] = useState('All') // 'All' | driverUserName | '__unassigned'
  const searchRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', groups: [], meta: null, error: '' })

    fetchFleetStops({ date: 'today' })
      .then((stopsRes) => {
        if (cancelled) return
        const groups = buildDriverGroups(stopsRes.stops ?? [])
        setState({
          status: 'ready',
          groups,
          meta: {
            source: stopsRes.source,
            cachedAt: stopsRes.cachedAt,
            mock: stopsRes.mock,
          },
          error: '',
        })
      })
      .catch((err) => {
        if (!cancelled)
          setState({ status: 'error', groups: [], meta: null, error: err.message })
      })

    return () => {
      cancelled = true
    }
  }, [])

  // All-group scalar array for useSortableTable.
  const groupRows = useMemo(
    () =>
      state.groups.map((g) => ({
        ...g,
        // Empties-last for date/number columns — null values handled by hook.
        firstEta: g.firstEta ?? null,
        revenue: g.revenue ?? null,
      })),
    [state.groups],
  )

  const { sortedItems: sortedGroups, sortKey, sortDirection, requestSort } =
    useSortableTable(groupRows, {
      initialKey: 'driverName',
      initialDirection: 'asc',
      types: GROUP_SORT_TYPES,
    })

  // Unassigned always last regardless of sort direction.
  const stableSorted = useMemo(() => {
    const named = sortedGroups.filter((g) => !g.isUnassigned)
    const unassigned = sortedGroups.filter((g) => g.isUnassigned)
    return [...named, ...unassigned]
  }, [sortedGroups])

  // Apply driver-filter pill + search box.
  const visibleGroups = useMemo(() => {
    let result = stableSorted

    if (driverFilter !== 'All') {
      const key = driverFilter === '__unassigned' ? '' : driverFilter
      result = result.filter((g) => g.driverUserName === key)
    }

    const q = search.trim()
    if (q) {
      result = result.filter((g) => matchesGroupSearch(g, q))
    }

    return result
  }, [stableSorted, driverFilter, search])

  // Total counts across all (unfiltered) groups.
  const totalDrivers = state.groups.filter((g) => !g.isUnassigned).length
  const totalStops = state.groups.reduce((n, g) => n + g.stopCount, 0)

  // Driver filter pills: All + one per named driver + Unassigned (if any).
  const namedDrivers = useMemo(
    () => state.groups.filter((g) => !g.isUnassigned),
    [state.groups],
  )
  const unassignedGroup = useMemo(
    () => state.groups.find((g) => g.isUnassigned) ?? null,
    [state.groups],
  )

  return (
    <section className="page page--wb">
      <div className="stops__head">
        <h1 className="page__title">
          Route Workbench
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
        </h1>
        <p className="stops__count">
          {state.status === 'ready' ? (
            <>
              <strong>{totalDrivers}</strong> driver{totalDrivers !== 1 ? 's' : ''} ·{' '}
              <strong>{totalStops}</strong> stop{totalStops !== 1 ? 's' : ''} ·{' '}
              <FreshnessStamp meta={state.meta} />
            </>
          ) : (
            <>&nbsp;</>
          )}
        </p>
      </div>

      {/* Search box */}
      <div className="stops__controls">
        <div className="control control--search">
          <input
            ref={searchRef}
            type="search"
            className="wb-search"
            placeholder="Search driver, route, customer, load…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search workbench"
          />
        </div>
      </div>

      {/* Driver filter pills */}
      {state.status === 'ready' && state.groups.length > 0 && (
        <div className="filterbar wb-driver-pills">
          <button
            type="button"
            className={`filterchip ${driverFilter === 'All' ? 'is-active' : ''}`}
            aria-pressed={driverFilter === 'All'}
            onClick={() => setDriverFilter('All')}
          >
            All{' '}
            <span className="filterchip__n">{totalStops}</span>
          </button>

          {namedDrivers.map((g) => (
            <button
              key={g.driverUserName}
              type="button"
              className={`filterchip ${driverFilter === g.driverUserName ? 'is-active' : ''}`}
              aria-pressed={driverFilter === g.driverUserName}
              onClick={() => setDriverFilter(g.driverUserName)}
            >
              {g.driverName}{' '}
              <span className="filterchip__n">{g.stopCount}</span>
            </button>
          ))}

          {unassignedGroup && (
            <button
              type="button"
              className={`filterchip ${driverFilter === '__unassigned' ? 'is-active' : ''}`}
              aria-pressed={driverFilter === '__unassigned'}
              onClick={() => setDriverFilter('__unassigned')}
            >
              Unassigned{' '}
              <span className="filterchip__n">{unassignedGroup.stopCount}</span>
            </button>
          )}
        </div>
      )}

      {/* Group sort pills */}
      {state.status === 'ready' && state.groups.length > 0 && (
        <SortPills
          options={GROUP_SORT_OPTIONS}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSort={requestSort}
          label="Sort groups"
        />
      )}

      {/* Loading / error / empty states */}
      {state.status === 'loading' && (
        <p className="stops__msg">Loading route data…</p>
      )}
      {state.status === 'error' && (
        <p className="stops__msg stops__msg--error">
          Could not load routes: {state.error}
        </p>
      )}
      {state.status === 'ready' && visibleGroups.length === 0 && (
        <p className="stops__msg">No drivers match the current filters.</p>
      )}

      {/* Driver groups */}
      {state.status === 'ready' && visibleGroups.length > 0 && (
        <div className="wb-groups">
          {visibleGroups.map((g) => (
            <DriverGroup key={g.driverUserName || '__unassigned'} group={g} />
          ))}
        </div>
      )}
    </section>
  )
}

