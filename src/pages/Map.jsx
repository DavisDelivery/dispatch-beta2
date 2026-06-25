// Map page — plots the selected day's stops on a Google Map, with Street View.
// READ-ONLY by default. "Plan mode" (gated, UAT-only) adds box/lasso/in-view
// multi-select and Plan / Unplan actions that drive the NuVizz write function.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildStopView, statusBucket, STATUS_FILTERS, matchesStatusFilter } from '../lib/stopView.js'
import { getStop, insertStops, removeStops, normalizeStop, summarize } from '../lib/nuvizzWrite.js'
import { pointInPolygon, latLngInBounds, boxFromCorners, stopKey } from '../lib/routingSelect.js'
import { formatDate, formatTime } from '../lib/format.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import { useWriteCreds } from '../hooks/useWriteCreds.js'
import FreshnessStamp from '../components/FreshnessStamp.jsx'
import PlanBar from '../components/PlanBar.jsx'
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

// Google marker symbol for a stop — enlarged + light-ringed when selected.
function iconFor(api, view, selected) {
  return {
    path: api.SymbolPath.CIRCLE,
    scale: selected ? 7.5 : 5,
    fillColor: markerColor(view.stop),
    fillOpacity: selected ? 1 : 0.9,
    strokeColor: selected ? '#f8fafc' : '#0b1220',
    strokeWeight: selected ? 2.5 : 1,
  }
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

// ---------------------------------------------------------------------------
// Box / lasso drawing overlay — only mounted while a draw tool is armed. It
// captures pointer events over the canvas, converts screen pixels to LatLng via
// the parent-supplied projection, then runs the pure enclosure tests.
// ---------------------------------------------------------------------------
function SelectionDraw({ mode, project, candidates, onCommit, onCancel }) {
  const [box, setBox] = useState(null) // {x0,y0,x1,y1} px
  const [path, setPath] = useState([]) // [{x,y}] px
  const drawing = useRef(false)
  const ptsRef = useRef([])
  const startRef = useRef(null)

  const rel = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const down = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drawing.current = true
    const p = rel(e)
    if (mode === 'box') {
      startRef.current = p
      setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    } else {
      ptsRef.current = [p]
      setPath([p])
    }
  }

  const move = (e) => {
    if (!drawing.current) return
    const p = rel(e)
    if (mode === 'box') {
      const s = startRef.current
      setBox({ x0: s.x, y0: s.y, x1: p.x, y1: p.y })
    } else {
      const last = ptsRef.current[ptsRef.current.length - 1]
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 4) {
        ptsRef.current.push(p)
        setPath(ptsRef.current.slice())
      }
    }
  }

  const up = (e) => {
    if (!drawing.current) return
    drawing.current = false
    if (mode === 'box') {
      const s = startRef.current
      const p = rel(e)
      setBox(null)
      if (Math.abs(p.x - s.x) < 4 && Math.abs(p.y - s.y) < 4) return onCancel()
      const a = project(s.x, s.y)
      const b = project(p.x, p.y)
      if (!a || !b) return onCancel()
      const bx = boxFromCorners(a, b)
      onCommit(
        candidates.filter((v) => latLngInBounds(v.stop.latitude, v.stop.longitude, bx)).map((v) => stopKey(v.stop)),
      )
    } else {
      const pts = ptsRef.current.slice()
      setPath([])
      if (pts.length < 3) return onCancel()
      const poly = pts.map((q) => project(q.x, q.y)).filter(Boolean).map((ll) => [ll.lat, ll.lng])
      if (poly.length < 3) return onCancel()
      onCommit(
        candidates.filter((v) => pointInPolygon(v.stop.latitude, v.stop.longitude, poly)).map((v) => stopKey(v.stop)),
      )
    }
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="map__draw" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
      {mode === 'box' && box && (
        <div
          className="map__box"
          style={{
            left: Math.min(box.x0, box.x1),
            top: Math.min(box.y0, box.y1),
            width: Math.abs(box.x1 - box.x0),
            height: Math.abs(box.y1 - box.y0),
          }}
        />
      )}
      {mode === 'lasso' && path.length > 1 && (
        <svg className="map__lasso">
          <polyline points={path.map((p) => `${p.x},${p.y}`).join(' ')} />
        </svg>
      )}
    </div>
  )
}

export default function MapPage() {
  const { date } = useSelectedDate()
  const [state, setState] = useState({ status: 'loading', stops: [], meta: null, error: '' })
  const [statusFilter, setStatusFilter] = useState('All')
  const [driverFilter, setDriverFilter] = useState('All')
  const [flagFilters, setFlagFilters] = useState({}) // key -> bool
  // 'loading' | 'ready' | 'error' for the Google Maps script itself.
  const [maps, setMaps] = useState({ status: API_KEY ? 'loading' : 'error', api: null, error: API_KEY ? '' : 'No Google Maps API key configured.' })

  // ---- Plan mode (gated write) ----
  const { creds, setCreds, canWrite } = useWriteCreds()
  const [planMode, setPlanMode] = useState(false)
  const [selectMode, setSelectMode] = useState(null) // null | 'box' | 'lasso'
  const [selectedKeys, setSelectedKeys] = useState(() => new Set())
  const [targetLoad, setTargetLoad] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null) // { text, ok }

  const mapElRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const markerByKeyRef = useRef(new Map())
  const infoRef = useRef(null)
  const clustererRef = useRef(null)
  const projectionRef = useRef(null)

  // Refs let the marker effects read current plan state without rebuilding on
  // every toggle (which would re-fit the map and clobber the selection icons).
  const planModeRef = useRef(planMode)
  planModeRef.current = planMode
  const selectedKeysRef = useRef(selectedKeys)
  selectedKeysRef.current = selectedKeys
  const handleMarkerClickRef = useRef(() => {})

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
    // Invisible overlay purely to expose the exact pixel<->LatLng projection
    // used by the box/lasso tools (works even when tilted, unlike bounds-lerp).
    const projOv = new api.OverlayView()
    projOv.onAdd = projOv.draw = projOv.onRemove = () => {}
    projOv.setMap(map)
    projectionRef.current = projOv
    mapRef.current = map
    return () => {
      // No explicit destroy for google.maps.Map; drop refs so a remount re-creates.
      if (clustererRef.current) clustererRef.current.clearMarkers()
      if (projectionRef.current) projectionRef.current.setMap(null)
      markerByKeyRef.current.clear()
      markersRef.current = []
      clustererRef.current = null
      projectionRef.current = null
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
    setSelectedKeys(new Set())
    setMsg(null)
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

  // Refetch stops after a write, preserving filters (no full-page loading flash).
  const refresh = useCallback(async () => {
    const res = await fetchFleetStops({ date })
    setState({ status: 'ready', stops: res.stops, meta: { source: res.source, cachedAt: res.cachedAt, mock: res.mock }, error: '' })
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
  // Distinct loads for the Plan target picker (every stop carries loadId/loadNbr).
  const loadsList = useMemo(() => {
    const m = new Map()
    for (const { stop } of allViews) {
      if (stop.loadNbr && !m.has(stop.loadNbr)) {
        m.set(stop.loadNbr, { loadNbr: stop.loadNbr, loadId: stop.loadId, routeName: stop.routeName, driverUserName: stop.driverUserName })
      }
    }
    return Array.from(m.values()).sort((a, b) => (a.routeName || a.loadNbr).localeCompare(b.routeName || b.loadNbr))
  }, [allViews])
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

  // Selected stops (across ALL mapped stops, so the tally survives filtering).
  const selectedStops = useMemo(
    () => mappedViews.filter((v) => selectedKeys.has(stopKey(v.stop))),
    [mappedViews, selectedKeys],
  )
  const tally = useMemo(() => {
    let skids = 0
    let pieces = 0
    let weight = 0
    for (const { stop } of selectedStops) {
      skids += stop.totalPallets || 0
      pieces += stop.totalCartons || 0
      weight += stop.weight || 0
    }
    return { skids, pieces, weight }
  }, [selectedStops])

  // Keep the marker click handler current (plan-toggle vs popup) without rebuild.
  handleMarkerClickRef.current = (view, marker, openStreetView) => {
    if (planModeRef.current) {
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        const k = stopKey(view.stop)
        next.has(k) ? next.delete(k) : next.add(k)
        return next
      })
    } else {
      infoRef.current.setContent(popupNode(view, openStreetView))
      infoRef.current.open({ map: mapRef.current, anchor: marker })
    }
  }

  // ---- (Re)build markers when the filtered set or the map changes ----
  useEffect(() => {
    const map = mapRef.current
    const api = maps.api
    const clusterer = clustererRef.current
    if (!map || !api || !clusterer) return

    const openStreetView = (lat, lng) => {
      const pano = map.getStreetView()
      pano.setPosition({ lat, lng })
      pano.setPov({ heading: 0, pitch: 0 })
      pano.setVisible(true)
    }

    clusterer.clearMarkers()
    const byKey = new Map()
    const markers = []
    const bounds = new api.LatLngBounds()
    for (const view of filteredViews) {
      const { stop } = view
      const key = stopKey(stop)
      const pos = { lat: stop.latitude, lng: stop.longitude }
      const marker = new api.Marker({
        position: pos,
        title: stop.name || '',
        icon: iconFor(api, view, selectedKeysRef.current.has(key)),
      })
      marker.addListener('click', () => handleMarkerClickRef.current(view, marker, openStreetView))
      markers.push(marker)
      byKey.set(key, { marker, view })
      bounds.extend(pos)
    }
    clusterer.addMarkers(markers)
    markersRef.current = markers
    markerByKeyRef.current = byKey

    if (filteredViews.length === 1) {
      map.setCenter(bounds.getCenter())
      map.setZoom(14)
    } else if (filteredViews.length > 1) {
      map.fitBounds(bounds, 40)
    }
  }, [filteredViews, maps.status])

  // ---- Restyle markers on selection change — no rebuild, no re-fit ----
  useEffect(() => {
    const api = maps.api
    if (!api) return
    for (const [key, rec] of markerByKeyRef.current) {
      rec.marker.setIcon(iconFor(api, rec.view, selectedKeys.has(key)))
    }
  }, [selectedKeys, maps.status])

  // ---- Selection / plan actions ----
  const project = useCallback(
    (x, y) => {
      const proj = projectionRef.current?.getProjection?.()
      const api = maps.api
      if (!proj || !api) return null
      const ll = proj.fromContainerPixelToLatLng(new api.Point(x, y))
      return ll ? { lat: ll.lat(), lng: ll.lng() } : null
    },
    [maps.api],
  )

  const mergeSelection = useCallback((keys) => {
    if (!keys.length) return
    setSelectedKeys((prev) => new Set([...prev, ...keys]))
  }, [])

  const addInView = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    const b = map.getBounds()
    if (!b) return
    const ne = b.getNorthEast()
    const sw = b.getSouthWest()
    const box = { north: ne.lat(), south: sw.lat(), east: ne.lng(), west: sw.lng() }
    mergeSelection(
      filteredViews.filter((v) => latLngInBounds(v.stop.latitude, v.stop.longitude, box)).map((v) => stopKey(v.stop)),
    )
  }, [filteredViews, mergeSelection])

  const togglePlanMode = () => {
    setPlanMode((p) => {
      const next = !p
      if (!next) {
        setSelectMode(null)
        setSelectedKeys(new Set())
        setMsg(null)
      } else if (infoRef.current) {
        infoRef.current.close()
      }
      return next
    })
  }

  // Resolve a NuVizz stopId for a read-stop (present after the normalizer change;
  // falls back to a getStop read for any stop missing it).
  const resolveStopId = useCallback(
    async (stop) => {
      if (stop.stopId) return stop.stopId
      const r = await getStop(creds, stop.stopNbr)
      return normalizeStop(r).stopId
    },
    [creds],
  )

  const onPlan = useCallback(async () => {
    const target = loadsList.find((l) => l.loadNbr === targetLoad)
    if (!target?.loadId) {
      setMsg({ text: 'Pick a target load first.', ok: false })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const ids = []
      for (const { stop } of selectedStops) {
        const id = await resolveStopId(stop)
        if (id) ids.push(id)
      }
      if (!ids.length) throw new Error('No resolvable stop IDs in the selection.')
      const s = summarize(await insertStops(creds, target.loadId, ids))
      if (!s.ok) throw new Error(s.message)
      setMsg({ text: `Planned ${ids.length} stop(s) onto ${target.routeName || target.loadNbr}.`, ok: true })
      await refresh()
      setSelectedKeys(new Set())
    } catch (e) {
      setMsg({ text: e.message, ok: false })
    } finally {
      setBusy(false)
    }
  }, [creds, loadsList, targetLoad, selectedStops, resolveStopId, refresh])

  const onUnplan = useCallback(async () => {
    setBusy(true)
    setMsg(null)
    try {
      const byLoad = new Map() // loadNbr -> stopId[]
      for (const { stop } of selectedStops) {
        if (!stop.loadNbr) continue
        const id = await resolveStopId(stop)
        if (!id) continue
        if (!byLoad.has(stop.loadNbr)) byLoad.set(stop.loadNbr, [])
        byLoad.get(stop.loadNbr).push(id)
      }
      if (!byLoad.size) throw new Error('No resolvable stops to unplan.')
      let total = 0
      const failures = []
      for (const [loadNbr, ids] of byLoad) {
        if (!ids.length) continue
        const s = summarize(await removeStops(creds, loadNbr, ids))
        if (s.ok) total += ids.length
        else failures.push(`${loadNbr}: ${s.message}`)
      }
      setMsg(
        failures.length
          ? { text: `Unplanned ${total}; errors — ${failures.join(' · ')}`, ok: false }
          : { text: `Unplanned ${total} stop(s).`, ok: true },
      )
      await refresh()
      setSelectedKeys(new Set())
    } catch (e) {
      setMsg({ text: e.message, ok: false })
    } finally {
      setBusy(false)
    }
  }, [creds, selectedStops, resolveStopId, refresh])

  const mappedCount = mappedViews.length
  const unmappedCount = allViews.length - mappedCount
  const visibleCount = filteredViews.length
  const selectedCount = selectedKeys.size
  const isFiltered =
    statusFilter !== 'All' || driverFilter !== 'All' || FLAG_FILTERS.some((f) => flagFilters[f.key])
  const fullDayLabel = `${weekdayFull(date)}, ${formatDate(date + 'T12:00:00Z')}`

  return (
    <section className="page page--map">
      <div className="map__head">
        <h1 className="page__title">
          Map
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
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

      {/* Driver filter + Plan-mode toggle */}
      {state.status === 'ready' && (
        <div className="map__driver-row">
          {driverList.length > 0 && (
            <>
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
            </>
          )}
          <button
            type="button"
            className={`wb-btn wb-btn--sm map__plan-toggle ${planMode ? 'is-active' : ''}`}
            aria-pressed={planMode}
            onClick={togglePlanMode}
          >
            {planMode ? '✓ Plan mode' : '✋ Plan mode'}
          </button>
        </div>
      )}

      {/* Plan-mode tools + action bar */}
      {state.status === 'ready' && planMode && (
        <>
          <div className="map__tools">
            <button type="button" className="wb-btn wb-btn--sm" onClick={addInView}>
              ＋ In view
            </button>
            <button
              type="button"
              className={`wb-btn wb-btn--sm ${selectMode === 'box' ? 'is-active' : ''}`}
              onClick={() => setSelectMode((m) => (m === 'box' ? null : 'box'))}
            >
              ▱ Box
            </button>
            <button
              type="button"
              className={`wb-btn wb-btn--sm ${selectMode === 'lasso' ? 'is-active' : ''}`}
              onClick={() => setSelectMode((m) => (m === 'lasso' ? null : 'lasso'))}
            >
              ⬠ Lasso
            </button>
            {selectMode && <span className="map__tools-hint">{selectMode === 'box' ? 'Drag a box' : 'Draw around stops'} · Esc to cancel</span>}
          </div>
          <PlanBar
            count={selectedCount}
            tally={tally}
            loads={loadsList}
            targetLoad={targetLoad}
            setTargetLoad={setTargetLoad}
            onPlan={onPlan}
            onUnplan={onUnplan}
            onClear={() => setSelectedKeys(new Set())}
            busy={busy}
            msg={msg?.text}
            msgOk={msg?.ok}
            creds={creds}
            setCreds={setCreds}
            canWrite={canWrite}
            isMock={IS_MOCK}
          />
        </>
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
        {planMode && selectMode && maps.status === 'ready' && (
          <SelectionDraw
            mode={selectMode}
            project={project}
            candidates={filteredViews}
            onCommit={(keys) => {
              mergeSelection(keys)
              setSelectMode(null)
            }}
            onCancel={() => setSelectMode(null)}
          />
        )}
      </div>
    </section>
  )
}
