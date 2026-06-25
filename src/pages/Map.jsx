// Map page — plots the selected day's stops on a Google Map, with Street View.
// READ-ONLY browse + filter view. Plan/unplan lives on the dedicated /routing page.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildStopView, STATUS_FILTERS, matchesStatusFilter } from '../lib/stopView.js'
import { markerColor, LEGEND_ENTRIES } from '../lib/statusColors.js'
import { formatDate, formatTime } from '../lib/format.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import FreshnessStamp from '../components/FreshnessStamp.jsx'
import { loadGoogleMaps } from '../lib/googleMaps.js'
import { MarkerClusterer } from '@googlemaps/markerclusterer'

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function weekdayFull(iso) {
  return WEEKDAYS[new Date(iso + 'T12:00:00Z').getUTCDay()]
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Build the InfoWindow content as a DOM node so the Street View button can be wired.
function popupNode(view, onStreetView) {
  const { stop, appt, revenueText, bucket } = view
  const addr = [stop.addr1, stop.city, stop.state].filter(Boolean).join(', ')
  const eta = stop.plannedEta ? formatTime(stop.plannedEta) : '—'
  const apptText = appt.placeholder ? 'no appt' : appt.text
  const rev = revenueText ? `<div class="gm-popup__rev">Non-Uline Rev: <strong>${esc(revenueText)}</strong></div>` : ''

  const el = document.createElement('div')
  el.className = 'gm-popup'
  el.innerHTML = `
    <div class="gm-popup__name">${esc(stop.name) || '—'}</div>
    <div class="gm-popup__addr">${esc(addr)}</div>
    <div class="gm-popup__row">ETA ${esc(eta)} &middot; ${esc(apptText)}</div>
    <div class="gm-popup__status">${esc(bucket)}</div>
    ${rev}
  `
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'gm-popup__sv'
  btn.textContent = '🛣 Street View'
  btn.addEventListener('click', () => onStreetView(stop.latitude, stop.longitude))
  el.appendChild(btn)
  return el
}

function buildDriverList(views) {
  const seen = new Map()
  for (const { stop } of views) {
    if (typeof stop.latitude === 'number' && typeof stop.longitude === 'number' && stop.driverUserName) {
      if (!seen.has(stop.driverUserName)) seen.set(stop.driverUserName, stop.driverName || stop.driverUserName)
    }
  }
  return Array.from(seen.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// Comment-derived flag filters — mirrors NuVizz's map filter panel.
const FLAG_FILTERS = [
  { key: 'appt', label: 'Appt required', test: (v) => !v.appt.placeholder },
  { key: 'liftgate', label: 'Liftgate', test: (v) => v.parsed.liftgate },
  { key: 'restriction', label: 'Has restriction', test: (v) => v.chips.length > 0 },
  { key: 'unflagged', label: 'Unflagged', test: (v) => v.chips.length === 0 },
]

export default function MapPage() {
  const { date } = useSelectedDate()
  const [state, setState] = useState({ status: 'loading', stops: [], meta: null, error: '' })
  const [statusFilter, setStatusFilter] = useState('All')
  const [driverFilter, setDriverFilter] = useState('All')
  const [flagFilters, setFlagFilters] = useState({}) // key -> bool
  // 'loading' | 'ready' | 'error' for the Google Maps script itself.
  const [maps, setMaps] = useState({ status: API_KEY ? 'loading' : 'error', api: null, error: API_KEY ? '' : 'No Google Maps API key configured.' })

  const mapElRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const infoRef = useRef(null)
  const clustererRef = useRef(null)

  // ---- Load the Google Maps script once ----
  useEffect(() => {
    if (!API_KEY) return
    let cancelled = false
    loadGoogleMaps(API_KEY)
      .then((api) => {
        if (!cancelled) setMaps({ status: 'ready', api, error: '' })
      })
      .catch((err) => {
        if (!cancelled) setMaps({ status: 'error', api: null, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ---- Create the map once the script is ready and the element is mounted ----
  useEffect(() => {
    if (maps.status !== 'ready' || !mapElRef.current || mapRef.current) return
    const api = maps.api
    const map = new api.Map(mapElRef.current, {
      center: { lat: 35.5, lng: -80.0 }, // North Carolina default
      zoom: 8,
      mapTypeControl: true,
      streetViewControl: true, // pegman
      fullscreenControl: true,
      clickableIcons: false,
    })
    map.getStreetView().setOptions({ enableCloseButton: true })
    infoRef.current = new api.InfoWindow()
    // Cluster dense markers; clusters expand as you zoom (handles 600+ stops).
    clustererRef.current = new MarkerClusterer({ map })
    mapRef.current = map
    return () => {
      // No explicit destroy for google.maps.Map; drop refs so a remount re-creates.
      if (clustererRef.current) clustererRef.current.clearMarkers()
      markersRef.current = []
      clustererRef.current = null
      mapRef.current = null
      infoRef.current = null
    }
  }, [maps.status])

  // ---- Data fetch — re-runs when date changes; reset filters on a new date ----
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', stops: [], meta: null, error: '' })
    setStatusFilter('All')
    setDriverFilter('All')
    setFlagFilters({})
    fetchFleetStops({ date })
      .then((res) => {
        if (!cancelled)
          setState({ status: 'ready', stops: res.stops, meta: { source: res.source, cachedAt: res.cachedAt, mock: res.mock }, error: '' })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', stops: [], meta: null, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [date])

  const allViews = useMemo(
    () => (state.status === 'ready' ? state.stops.map(buildStopView) : []),
    [state.stops, state.status],
  )
  const mappedViews = useMemo(
    () => allViews.filter(({ stop }) => typeof stop.latitude === 'number' && typeof stop.longitude === 'number'),
    [allViews],
  )
  const driverList = useMemo(() => buildDriverList(allViews), [allViews])
  const statusCounts = useMemo(() => {
    const counts = {}
    for (const f of STATUS_FILTERS) counts[f] = mappedViews.filter((v) => matchesStatusFilter(v, f)).length
    return counts
  }, [mappedViews])
  const flagCounts = useMemo(() => {
    const counts = {}
    for (const f of FLAG_FILTERS) counts[f.key] = mappedViews.filter(f.test).length
    return counts
  }, [mappedViews])
  const filteredViews = useMemo(
    () =>
      mappedViews.filter((v) => {
        if (!matchesStatusFilter(v, statusFilter)) return false
        if (driverFilter !== 'All' && v.stop.driverUserName !== driverFilter) return false
        for (const f of FLAG_FILTERS) {
          if (flagFilters[f.key] && !f.test(v)) return false
        }
        return true
      }),
    [mappedViews, statusFilter, driverFilter, flagFilters],
  )

  // ---- (Re)build markers when the filtered set or the map changes ----
  useEffect(() => {
    const map = mapRef.current
    const api = maps.api
    const clusterer = clustererRef.current
    if (!map || !api || !clusterer) return

    // Open Street View at a position (the map's embedded panorama).
    const openStreetView = (lat, lng) => {
      const pano = map.getStreetView()
      pano.setPosition({ lat, lng })
      pano.setPov({ heading: 0, pitch: 0 })
      pano.setVisible(true)
    }

    // Clear old markers from the clusterer.
    clusterer.clearMarkers()

    const markers = []
    const bounds = new api.LatLngBounds()
    for (const view of filteredViews) {
      const { stop } = view
      const pos = { lat: stop.latitude, lng: stop.longitude }
      const color = markerColor(stop)
      // No `map` here — the clusterer adds/removes markers from the map.
      const marker = new api.Marker({
        position: pos,
        title: stop.name || '',
        icon: {
          path: api.SymbolPath.CIRCLE,
          scale: 5,
          fillColor: color,
          fillOpacity: 0.9,
          strokeColor: '#0b1220',
          strokeWeight: 1,
        },
      })
      marker.addListener('click', () => {
        infoRef.current.setContent(popupNode(view, openStreetView))
        infoRef.current.open({ map, anchor: marker })
      })
      markers.push(marker)
      bounds.extend(pos)
    }
    clusterer.addMarkers(markers)
    markersRef.current = markers

    if (filteredViews.length === 1) {
      map.setCenter(bounds.getCenter())
      map.setZoom(14)
    } else if (filteredViews.length > 1) {
      map.fitBounds(bounds, 40)
    }
  }, [filteredViews, maps.status])

  const mappedCount = mappedViews.length
  const unmappedCount = allViews.length - mappedCount
  const visibleCount = filteredViews.length
  const isFiltered =
    statusFilter !== 'All' || driverFilter !== 'All' || FLAG_FILTERS.some((f) => flagFilters[f.key])
  const fullDayLabel = `${weekdayFull(date)}, ${formatDate(date + 'T12:00:00Z')}`

  return (
    <section className="page page--map">
      <div className="map__head">
        <h1 className="page__title">
          Map
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
          <Link to="/routing" className="map__build-link" title="Plan / unplan orders on the map">
            ⤳ Routing
          </Link>
          <Link to="/build" className="map__build-link" title="Create orders &amp; assemble loads">
            ＋ Build orders
          </Link>
        </h1>
        {state.status === 'ready' && (
          <p className="map__count">
            <strong className="map__day">{fullDayLabel}</strong>
            <span className="map__count-sep"> · </span>
            <strong>{visibleCount}</strong>
            {isFiltered && visibleCount !== mappedCount && <> of {mappedCount}</>}
            {' mapped'}
            {isFiltered && <span className="map__filter-note"> (filtered)</span>}
            <span className="map__count-sep"> · </span>
            <FreshnessStamp meta={state.meta} />
            {unmappedCount > 0 && <span className="map__unmapped"> ({unmappedCount} without coordinates)</span>}
          </p>
        )}
        {state.status === 'loading' && <p className="stops__msg">Loading stops…</p>}
        {state.status === 'error' && (
          <p className="stops__msg stops__msg--error">Could not load stops: {state.error}</p>
        )}
      </div>

      {/* Status filter chips */}
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

      {/* Flag filters — parsed from stop notes (NuVizz parity) */}
      {state.status === 'ready' && (
        <div className="filterbar map__filterbar">
          {FLAG_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`filterchip ${flagFilters[f.key] ? 'is-active' : ''}`}
              aria-pressed={!!flagFilters[f.key]}
              onClick={() => setFlagFilters((p) => ({ ...p, [f.key]: !p[f.key] }))}
            >
              {f.label} <span className="filterchip__n">{flagCounts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {/* Driver filter */}
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
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="map__legend">
        {LEGEND_ENTRIES.map(({ bucket, color }) => (
          <span key={bucket} className="map__legend-item">
            <span className="map__legend-dot" style={{ background: color }} />
            <span className="map__legend-label">{bucket}</span>
          </span>
        ))}
      </div>

      {/* The map container — Google Map mounts here */}
      <div className="map__container">
        {maps.status === 'error' && (
          <div className="map__empty">
            Map unavailable: {maps.error}
            {!API_KEY && <> Set <code>VITE_GOOGLE_MAPS_API_KEY</code> and redeploy.</>}
          </div>
        )}
        {maps.status === 'loading' && <div className="map__empty">Loading map…</div>}
        {maps.status === 'ready' && state.status === 'ready' && mappedCount === 0 && (
          <div className="map__empty">No stops with coordinates for this day.</div>
        )}
        {maps.status === 'ready' && state.status === 'ready' && mappedCount > 0 && visibleCount === 0 && (
          <div className="map__empty">No stops match the current filters.</div>
        )}
        <div ref={mapElRef} className="map__canvas" aria-label="Stop locations map" />
      </div>
    </section>
  )
}
