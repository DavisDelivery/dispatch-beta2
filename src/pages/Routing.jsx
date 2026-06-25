// Routing (beta) — dedicated map-driven plan/unplan workspace, mirroring the
// davis-nuvizz Routing layout (left controls · map · right Stops/Loads rail).
// Phase 1: box/lasso/in-view select → Plan (insertStops) / Unplan (removeStops)
// via the gated UAT write function. The route optimizer (trucks + Build + Result)
// is the planned next layer. READ paths + warm cache untouched.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { fetchFleetStops, IS_MOCK } from '../lib/nuvizzApi.js'
import { buildStopView } from '../lib/stopView.js'
import { getStop, insertStops, removeStops, normalizeStop, summarize } from '../lib/nuvizzWrite.js'
import { latLngInBounds, stopKey } from '../lib/routingSelect.js'
import { markerIcon, LEGEND_ENTRIES } from '../lib/statusColors.js'
import { formatDate } from '../lib/format.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import { useWriteCreds } from '../hooks/useWriteCreds.js'
import { loadGoogleMaps } from '../lib/googleMaps.js'
import { MarkerClusterer } from '@googlemaps/markerclusterer'
import SelectionDraw from '../components/SelectionDraw.jsx'
import PlanBar from '../components/PlanBar.jsx'
import RoutingPanel from '../components/RoutingPanel.jsx'

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function weekdayFull(iso) {
  return WEEKDAYS[new Date(iso + 'T12:00:00Z').getUTCDay()]
}

export default function RoutingPage() {
  const { date } = useSelectedDate()
  const [state, setState] = useState({ status: 'loading', stops: [], meta: null, error: '' })
  const [maps, setMaps] = useState({ status: API_KEY ? 'loading' : 'error', api: null, error: API_KEY ? '' : 'No Google Maps API key configured.' })

  const { creds, setCreds, canWrite } = useWriteCreds()
  const [selectMode, setSelectMode] = useState(null) // null | 'box' | 'lasso'
  const [selectedKeys, setSelectedKeys] = useState(() => new Set())
  const [targetLoad, setTargetLoad] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [railTab, setRailTab] = useState('stops')

  const mapElRef = useRef(null)
  const mapRef = useRef(null)
  const markerByKeyRef = useRef(new Map())
  const clustererRef = useRef(null)
  const projectionRef = useRef(null)
  const selectedKeysRef = useRef(selectedKeys)
  selectedKeysRef.current = selectedKeys
  const clickRef = useRef(() => {})

  // ---- Load Google Maps once ----
  useEffect(() => {
    if (!API_KEY) return
    let cancelled = false
    loadGoogleMaps(API_KEY)
      .then((api) => !cancelled && setMaps({ status: 'ready', api, error: '' }))
      .catch((err) => !cancelled && setMaps({ status: 'error', api: null, error: err.message }))
    return () => {
      cancelled = true
    }
  }, [])

  // ---- Create map once ready ----
  useEffect(() => {
    if (maps.status !== 'ready' || !mapElRef.current || mapRef.current) return
    const api = maps.api
    const map = new api.Map(mapElRef.current, {
      center: { lat: 35.5, lng: -80.0 },
      zoom: 8,
      mapTypeControl: true,
      streetViewControl: false,
      fullscreenControl: true,
      clickableIcons: false,
    })
    clustererRef.current = new MarkerClusterer({ map })
    const projOv = new api.OverlayView()
    projOv.onAdd = projOv.draw = projOv.onRemove = () => {}
    projOv.setMap(map)
    projectionRef.current = projOv
    mapRef.current = map
    return () => {
      if (clustererRef.current) clustererRef.current.clearMarkers()
      if (projectionRef.current) projectionRef.current.setMap(null)
      markerByKeyRef.current.clear()
      clustererRef.current = null
      projectionRef.current = null
      mapRef.current = null
    }
  }, [maps.status])

  // ---- Fetch stops on date change ----
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', stops: [], meta: null, error: '' })
    setSelectedKeys(new Set())
    setTargetLoad('')
    setMsg(null)
    fetchFleetStops({ date })
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', stops: res.stops, meta: { source: res.source, cachedAt: res.cachedAt, mock: res.mock }, error: '' })
      })
      .catch((err) => !cancelled && setState({ status: 'error', stops: [], meta: null, error: err.message }))
    return () => {
      cancelled = true
    }
  }, [date])

  const refresh = useCallback(async () => {
    const res = await fetchFleetStops({ date })
    setState({ status: 'ready', stops: res.stops, meta: { source: res.source, cachedAt: res.cachedAt, mock: res.mock }, error: '' })
  }, [date])

  const allViews = useMemo(() => (state.status === 'ready' ? state.stops.map(buildStopView) : []), [state.stops, state.status])
  const mappedViews = useMemo(
    () => allViews.filter(({ stop }) => typeof stop.latitude === 'number' && typeof stop.longitude === 'number'),
    [allViews],
  )
  const loadsList = useMemo(() => {
    const m = new Map()
    for (const { stop } of allViews) {
      if (!stop.loadNbr) continue
      if (!m.has(stop.loadNbr)) m.set(stop.loadNbr, { loadNbr: stop.loadNbr, loadId: stop.loadId, routeName: stop.routeName, driverUserName: stop.driverUserName, stopCount: 0 })
      m.get(stop.loadNbr).stopCount += 1
    }
    return Array.from(m.values()).sort((a, b) => (a.routeName || a.loadNbr).localeCompare(b.routeName || b.loadNbr))
  }, [allViews])

  const selectedStops = useMemo(() => mappedViews.filter((v) => selectedKeys.has(stopKey(v.stop))), [mappedViews, selectedKeys])
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

  // Marker click toggles selection (the whole page is select mode).
  clickRef.current = (view) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      const k = stopKey(view.stop)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })
  }

  // ---- Build markers on data/map change ----
  useEffect(() => {
    const map = mapRef.current
    const api = maps.api
    const clusterer = clustererRef.current
    if (!map || !api || !clusterer) return
    clusterer.clearMarkers()
    const byKey = new Map()
    const markers = []
    const bounds = new api.LatLngBounds()
    for (const view of mappedViews) {
      const { stop } = view
      const key = stopKey(stop)
      const pos = { lat: stop.latitude, lng: stop.longitude }
      const marker = new api.Marker({ position: pos, title: stop.name || '', icon: markerIcon(api, stop, selectedKeysRef.current.has(key)) })
      marker.addListener('click', () => clickRef.current(view))
      markers.push(marker)
      byKey.set(key, { marker, stop })
      bounds.extend(pos)
    }
    clusterer.addMarkers(markers)
    markerByKeyRef.current = byKey
    if (mappedViews.length === 1) {
      map.setCenter(bounds.getCenter())
      map.setZoom(13)
    } else if (mappedViews.length > 1) {
      map.fitBounds(bounds, 40)
    }
  }, [mappedViews, maps.status])

  // ---- Restyle on selection change (no rebuild / no re-fit) ----
  useEffect(() => {
    const api = maps.api
    if (!api) return
    for (const [key, rec] of markerByKeyRef.current) {
      rec.marker.setIcon(markerIcon(api, rec.stop, selectedKeys.has(key)))
    }
  }, [selectedKeys, maps.status])

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
    if (keys.length) setSelectedKeys((prev) => new Set([...prev, ...keys]))
  }, [])

  const addInView = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    const b = map.getBounds()
    if (!b) return
    const ne = b.getNorthEast()
    const sw = b.getSouthWest()
    const box = { north: ne.lat(), south: sw.lat(), east: ne.lng(), west: sw.lng() }
    mergeSelection(mappedViews.filter((v) => latLngInBounds(v.stop.latitude, v.stop.longitude, box)).map((v) => stopKey(v.stop)))
  }, [mappedViews, mergeSelection])

  const removeKey = useCallback((key) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

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
      setMsg({ text: 'Pick a target load (Loads tab) first.', ok: false })
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
      const byLoad = new Map()
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
      setMsg(failures.length ? { text: `Unplanned ${total}; errors — ${failures.join(' · ')}`, ok: false } : { text: `Unplanned ${total} stop(s).`, ok: true })
      await refresh()
      setSelectedKeys(new Set())
    } catch (e) {
      setMsg({ text: e.message, ok: false })
    } finally {
      setBusy(false)
    }
  }, [creds, selectedStops, resolveStopId, refresh])

  const fullDayLabel = `${weekdayFull(date)}, ${formatDate(date + 'T12:00:00Z')}`

  return (
    <section className="page page--routing">
      <div className="routing__head">
        <h1 className="page__title">
          Routing <span className="pill pill--beta">beta</span>
          {IS_MOCK && <span className="pill pill--mock">Mock data</span>}
        </h1>
        <p className="routing__sub">
          <strong>{fullDayLabel}</strong> · {mappedViews.length} mapped · {selectedKeys.size} selected
        </p>
      </div>

      <div className="routing__grid">
        {/* Left: select tools + plan action bar */}
        <div className="routing__controls">
          <div className="routing__section-title">1 · Select stops</div>
          <div className="map__tools">
            <button type="button" className="wb-btn wb-btn--sm" onClick={addInView}>＋ In view</button>
            <button type="button" className={`wb-btn wb-btn--sm ${selectMode === 'box' ? 'is-active' : ''}`} onClick={() => setSelectMode((m) => (m === 'box' ? null : 'box'))}>▱ Box</button>
            <button type="button" className={`wb-btn wb-btn--sm ${selectMode === 'lasso' ? 'is-active' : ''}`} onClick={() => setSelectMode((m) => (m === 'lasso' ? null : 'lasso'))}>⬠ Lasso</button>
          </div>
          {selectMode && <p className="map__tools-hint">{selectMode === 'box' ? 'Drag a box on the map' : 'Draw around stops'} · Esc to cancel</p>}

          <div className="routing__section-title">2 · Plan</div>
          <PlanBar
            count={selectedKeys.size}
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

          <div className="routing__legend">
            {LEGEND_ENTRIES.map(({ bucket, color }) => (
              <span key={bucket} className="map__legend-item">
                <span className="map__legend-dot" style={{ background: color }} />
                <span className="map__legend-label">{bucket}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Center: the map */}
        <div className="routing__map">
          <div className="map__container">
            {maps.status === 'error' && (
              <div className="map__empty">
                Map unavailable: {maps.error}
                {!API_KEY && <> Set <code>VITE_GOOGLE_MAPS_API_KEY</code> and redeploy.</>}
              </div>
            )}
            {maps.status === 'loading' && <div className="map__empty">Loading map…</div>}
            {maps.status === 'ready' && state.status === 'ready' && mappedViews.length === 0 && (
              <div className="map__empty">No stops with coordinates for this day.</div>
            )}
            {state.status === 'error' && <div className="map__empty">Could not load stops: {state.error}</div>}
            <div ref={mapElRef} className="map__canvas" aria-label="Routing map" />
            {selectMode && maps.status === 'ready' && (
              <SelectionDraw
                mode={selectMode}
                project={project}
                candidates={mappedViews}
                onCommit={(keys) => {
                  mergeSelection(keys)
                  setSelectMode(null)
                }}
                onCancel={() => setSelectMode(null)}
              />
            )}
          </div>
        </div>

        {/* Right: Stops / Loads rail */}
        <RoutingPanel
          tab={railTab}
          setTab={setRailTab}
          stops={selectedStops}
          onRemove={removeKey}
          loads={loadsList}
          targetLoad={targetLoad}
          setTargetLoad={setTargetLoad}
        />
      </div>
    </section>
  )
}
