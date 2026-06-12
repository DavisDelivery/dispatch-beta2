// Map page — plots the selected day's stops on a Google Map, with Street View.
// Read-only; no write paths. Status + driver filters; date-driven.

import { useEffect, useMemo, useRef, useState } from 'react'

import { fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildStopView, statusBucket, STATUS_FILTERS, matchesStatusFilter } from '../lib/stopView.js'
import { formatDate, formatTime } from '../lib/format.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import FreshnessStamp from '../components/FreshnessStamp.jsx'
import { loadGoogleMaps } from '../lib/googleMaps.js'
import { MarkerClusterer } from '@googlemaps/markerclusterer'

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''

// ---- Status colour palette — mirrors stopcard.is-* in index.css ----
const STATUS_COLORS = {
  Delivered: '#34d399',
  'En Route': '#38bdf8',
  Exception: '#fb7185',
  Scheduled: '#fbbf24',
  Pending: '#94a3b8',
  Other: '#64748b',
}

const LEGEND_ENTRIES = [
  { bucket: 'Delivered', color: STATUS_COLORS.Delivered },
  { bucket: 'En Route', color: STATUS_COLORS['En Route'] },
  { bucket: 'Exception', color: STATUS_COLORS.Exception },
  { bucket: 'Scheduled', color: STATUS_COLORS.Scheduled },
  { bucket: 'Pending', color: STATUS_COLORS.Pending },
]

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function weekdayFull(iso) {
  return WEEKDAYS[new Date(iso + 'T12:00:00Z').getUTCDay()]
}

function markerColor(stop) {
  return STATUS_COLORS[statusBucket(stop)] ?? STATUS_COLORS.Other
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

export default function MapPage() {
  const { date } = useSelectedDate()
  const [state, setState] = useState({ status: 'loading', stops: [], meta: null, error: '' })
  const [statusFilter, setStatusFilter] = useState('All')
  const [driverFilter, setDriverFilter] = useState('All')
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
  const filteredViews = useMemo(
    () =>
      mappedViews.filter((v) => {
        if (!matchesStatusFilter(v, statusFilter)) return false
        if (driverFilter !== 'All' && v.stop.driverUserName !== driverFilter) return false
        return true
      }),
    [mappedViews, statusFilter, driverFilter],
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
  const isFiltered = statusFilter !== 'All' || driverFilter !== 'All'
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
