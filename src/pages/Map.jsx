// Map page — plots the selected day's stops on a Leaflet/OSM map.
// Uses the imperative Leaflet API directly (no react-leaflet).
// Read-only; no write paths.

import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildStopView, statusBucket } from '../lib/stopView.js'
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

export default function MapPage() {
  const { date, isToday } = useSelectedDate()
  const [state, setState] = useState({ status: 'loading', stops: [], meta: null, error: '' })

  // Refs to hold the Leaflet map instance and the marker layer group.
  const mapRef     = useRef(null)  // holds the L.Map instance
  const mapElRef   = useRef(null)  // DOM node for the map container
  const markersRef = useRef(null)  // L.LayerGroup for the markers

  // ---- Data fetch — re-runs when date changes ----
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

  // ---- Marker layer — re-runs when stops data changes ----
  useEffect(() => {
    const map = mapRef.current
    const layer = markersRef.current
    if (!map || !layer) return

    // Clear previous markers.
    layer.clearLayers()

    const views = state.stops.map(buildStopView)
    const points = []

    for (const view of views) {
      const { stop } = view
      const lat = typeof stop.latitude  === 'number' ? stop.latitude  : null
      const lng = typeof stop.longitude === 'number' ? stop.longitude : null
      if (lat === null || lng === null) continue

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
    } else {
      // No valid points — show the NC default view.
      map.setView([35.5, -80.0], 8)
    }

    // Ensure size is correct after data update.
    map.invalidateSize()
  }, [state.stops])

  // ---- Derived counts ----
  const views        = state.status === 'ready' ? state.stops.map(buildStopView) : []
  const mappedCount  = views.filter((v) => {
    const s = v.stop
    return typeof s.latitude === 'number' && typeof s.longitude === 'number'
  }).length
  const unmappedCount = views.length - mappedCount

  const dayLabel = isToday ? 'today' : formatDate(date + 'T12:00:00Z')

  return (
    <section className="page page--map">
      <div className="map__head">
        <h1 className="page__title">
          Map
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
        </h1>
        {state.status === 'ready' && (
          <p className="map__count">
            <strong>{mappedCount}</strong> mapped · {dayLabel} · <FreshnessStamp meta={state.meta} />
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

      {/* Status legend */}
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
        <div ref={mapElRef} className="map__canvas" aria-label="Stop locations map" />
      </div>
    </section>
  )
}
