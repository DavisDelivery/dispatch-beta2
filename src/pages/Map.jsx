// Map page — plots the selected day's stops on a Leaflet/OSM map.
// Uses the imperative Leaflet API directly (no react-leaflet).
// Read-only; no write paths.

import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildStopView, statusBucket, STATUS_FILTERS, matchesStatusFilter } from '../lib/stopView.js'
import { formatDate, formatTime } from '../lib/format.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import FreshnessStamp from '../components/FreshnessStamp.jsx'

// ---- Status colour palette — mirrors stopcard.is-* in index.css ----
const STATUS_COLORS = {
  Delivered: '#34d399',
  'En Route': '#38bdf8',
  Exception:  '#fb7185',
  Scheduled:  '#fbbf24',
  Pending:    '#94a3b8',
  Other:      '#64748b',
}

const LEGEND_ENTRIES = [
  { bucket: 'Delivered', color: STATUS_COLORS.Delivered },
  { bucket: 'En Route',  color: STATUS_COLORS['En Route'] },
  { bucket: 'Exception', color: STATUS_COLORS.Exception },
  { bucket: 'Scheduled', color: STATUS_COLORS.Scheduled },
  { bucket: 'Pending',   color: STATUS_COLORS.Pending },
]

// Short weekday names indexed by getUTCDay() (0=Sun…6=Sat).
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function weekdayFull(iso) {
  const d = new Date(iso + 'T12:00:00Z')
  return WEEKDAYS[d.getUTCDay()]
}

function markerColor(stop) {
  const bucket = statusBucket(stop)
  return STATUS_COLORS[bucket] ?? STATUS_COLORS.Other
}

function popupHtml(view) {
  const { stop, appt, revenueText, bucket } = view
  const addr = [stop.addr1, stop.city, stop.state].filter(Boolean).join(', ')
  const eta = stop.plannedEta ? formatTime(stop.plannedEta) : '—'
  const apptText = appt.placeholder ? 'no appt' : appt.text
  const rev = revenueText
    ? `<div class="map-popup__rev">Non-Uline Rev: <strong>${revenueText}</strong></div>`
    : ''
  return `
    <div class="map-popup">
      <div class="map-popup__name"><strong>${stop.name ?? '—'}</strong></div>
      <div class="map-popup__addr">${addr}</div>
      <div class="map-popup__row">ETA ${eta} &middot; ${apptText}</div>
      <div class="map-popup__status">${bucket}</div>
      ${rev}
    </div>
  `.trim()
}

// Build a sorted list of distinct drivers from mapped stop views.
function buildDriverList(views) {
  const seen = new Map() // userName -> driverName
  for (const { stop } of views) {
    if (
      typeof stop.latitude  === 'number' &&
      typeof stop.longitude === 'number' &&
      stop.driverUserName
    ) {
      if (!seen.has(stop.driverUserName)) {
        seen.set(stop.driverUserName, stop.driverName || stop.driverUserName)
      }
    }
  }
  return Array.from(seen.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export default function MapPage() {
  const { date } = useSelectedDate()
  const [state, setState] = useState({ status: 'loading', stops: [], meta: null, error: '' })

  // ---- Filter state ----
  const [statusFilter, setStatusFilter] = useState('All')
  const [driverFilter, setDriverFilter] = useState('All') // driverUserName or 'All'

  // Refs to hold the Leaflet map instance and the marker layer group.
  const mapRef     = useRef(null)  // holds the L.Map instance
  const mapElRef   = useRef(null)  // DOM node for the map container
  const markersRef = useRef(null)  // L.LayerGroup for the markers

  // ---- Data fetch — re-runs when date changes; reset filters on new date ----
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', stops: [], meta: null, error: '' })
    setStatusFilter('All')
    setDriverFilter('All')
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
    return () => { cancelled = true }
  }, [date])

  // ---- Leaflet init — runs once after mount ----
  useEffect(() => {
    if (!mapElRef.current) return
    // Guard against React 18 StrictMode double-invoke: don't re-init if already done.
    if (mapRef.current) return

    const map = L.map(mapElRef.current, {
      center: [35.5, -80.0], // North Carolina default centre
      zoom: 8,
    })

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map)

    markersRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    // Keep Leaflet's internal size in sync with the container. In a flex column
    // the container's real height often settles AFTER init, which would otherwise
    // leave the map blank/mis-sized until an interaction; the observer fixes that.
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(mapElRef.current)
    const t = setTimeout(() => { map.invalidateSize() }, 150)

    return () => {
      clearTimeout(t)
      ro.disconnect()
      // Cleanup on unmount.
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markersRef.current = null
      }
    }
  }, []) // intentionally empty: init once, cleanup on unmount

  // ---- Derived data: all views + mapped views ----
  const allViews = useMemo(
    () => (state.status === 'ready' ? state.stops.map(buildStopView) : []),
    [state.stops, state.status],
  )

  const mappedViews = useMemo(
    () =>
      allViews.filter(({ stop }) => {
        return typeof stop.latitude === 'number' && typeof stop.longitude === 'number'
      }),
    [allViews],
  )

  // ---- Driver list derived from mapped stops ----
  const driverList = useMemo(() => buildDriverList(allViews), [allViews])

  // ---- Status counts for the filterbar (based on mapped stops only) ----
  const statusCounts = useMemo(() => {
    const counts = {}
    for (const f of STATUS_FILTERS) {
      counts[f] = mappedViews.filter((v) => matchesStatusFilter(v, f)).length
    }
    return counts
  }, [mappedViews])

  // ---- Apply both filters to get the set of views to show on the map ----
  const filteredViews = useMemo(
    () =>
      mappedViews.filter((v) => {
        if (!matchesStatusFilter(v, statusFilter)) return false
        if (driverFilter !== 'All' && v.stop.driverUserName !== driverFilter) return false
        return true
      }),
    [mappedViews, statusFilter, driverFilter],
  )

  // ---- Marker layer — re-runs when filtered views change ----
  // Does NOT reinitialize the map — only clears and rebuilds the marker layer.
  useEffect(() => {
    const map = mapRef.current
    const layer = markersRef.current
    if (!map || !layer) return

    // Clear previous markers.
    layer.clearLayers()

    const points = []

    for (const view of filteredViews) {
      const { stop } = view
      // filteredViews are already guaranteed to have lat/lng from mappedViews
      const lat = stop.latitude
      const lng = stop.longitude

      const color = markerColor(stop)
      const marker = L.circleMarker([lat, lng], {
        radius:      8,
        color:       color,
        fillColor:   color,
        fillOpacity: 0.85,
        weight:      2,
      })

      marker.bindPopup(popupHtml(view), { maxWidth: 260 })
      layer.addLayer(marker)
      points.push([lat, lng])
    }

    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 13 })
    }
    // If zero visible, keep current view (no-match note is shown in JSX).

    // Ensure size is correct after filter update.
    map.invalidateSize()
  }, [filteredViews])

  // ---- Derived counts for the header ----
  const mappedCount   = mappedViews.length
  const unmappedCount = allViews.length - mappedCount
  const visibleCount  = filteredViews.length
  const isFiltered    = statusFilter !== 'All' || driverFilter !== 'All'

  // Day header: always shows full weekday + date so users know exactly which day is shown.
  const fullDayLabel = `${weekdayFull(date)}, ${formatDate(date + 'T12:00:00Z')}`

  return (
    <section className="page page--map">
      <div className="map__head">
        <h1 className="page__title">
          Map
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
        </h1>
        {state.status === 'ready' && (
          <p className="map__count">
            <strong className="map__day">{fullDayLabel}</strong>
            <span className="map__count-sep"> · </span>
            <strong>{visibleCount}</strong>
            {isFiltered && visibleCount !== mappedCount && <> of {mappedCount}</>}
            {' mapped'}
            {isFiltered && (
              <span className="map__filter-note"> (filtered)</span>
            )}
            <span className="map__count-sep"> · </span>
            <FreshnessStamp meta={state.meta} />
            {unmappedCount > 0 && (
              <span className="map__unmapped"> ({unmappedCount} without coordinates)</span>
            )}
          </p>
        )}
        {state.status === 'loading' && <p className="stops__msg">Loading stops…</p>}
        {state.status === 'error' && (
          <p className="stops__msg stops__msg--error">Could not load stops: {state.error}</p>
        )}
      </div>

      {/* Status filter chips — reuse the same .filterbar / .filterchip pattern as Stops */}
      {state.status === 'ready' && (
        <div className="filterbar map__filterbar">
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
      )}

      {/* Driver filter — compact select, only shown when there are drivers to pick from */}
      {state.status === 'ready' && driverList.length > 0 && (
        <div className="map__driver-row">
          <span className="map__driver-label">Driver</span>
          <div className="control control--select map__driver-select">
            <select
              id="map-driver-filter"
              value={driverFilter}
              onChange={(e) => setDriverFilter(e.target.value)}
              aria-label="Filter by driver"
            >
              <option value="All">All drivers ({driverList.length})</option>
              {driverList.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Legend + no-match note */}
      <div className="map__legend">
        {LEGEND_ENTRIES.map(({ bucket, color }) => (
          <span key={bucket} className="map__legend-item">
            <span className="map__legend-dot" style={{ background: color }} />
            <span className="map__legend-label">{bucket}</span>
          </span>
        ))}
      </div>

      {/* The map container — Leaflet mounts here */}
      <div className="map__container">
        {state.status === 'ready' && mappedCount === 0 && (
          <div className="map__empty">No stops with coordinates for this day.</div>
        )}
        {state.status === 'ready' && mappedCount > 0 && visibleCount === 0 && (
          <div className="map__empty">No stops match the current filters.</div>
        )}
        <div ref={mapElRef} className="map__canvas" aria-label="Stop locations map" />
      </div>
    </section>
  )
}
