// Routing (beta) — map-driven plan/unplan workspace, UAT watchlist model.
//
// The board is YOUR sandbox, driven entirely by the live write function (getLoad/
// getStop) — no scan, no read-fn dependency:
//   • Created orders (the Builder registry) — Orders tab. Carry their stopId.
//   • Watched loads (load #s you add, plus any load your orders are planned onto)
//     — Loads tab. Read live via getLoad + getStop (names/coords).
// Plan adds the selection onto a target load; Unplan removes selected stops from
// their current load. Both update the created-orders registry's planned state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getStop, getLoad, insertStops, removeStops, normalizeStop, normalizeLoad, summarize } from '../lib/nuvizzWrite.js'
import { latLngInBounds } from '../lib/routingSelect.js'
import { markerIcon, LEGEND_ENTRIES } from '../lib/statusColors.js'
import { formatDate } from '../lib/format.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import { useWriteCreds } from '../hooks/useWriteCreds.js'
import { useCreatedOrders } from '../hooks/useCreatedOrders.js'
import { useWatchedLoads } from '../hooks/useWatchedLoads.js'
import { loadGoogleMaps } from '../lib/googleMaps.js'
import { MarkerClusterer } from '@googlemaps/markerclusterer'
import SelectionDraw from '../components/SelectionDraw.jsx'
import PlanBar from '../components/PlanBar.jsx'
import RoutingPanel from '../components/RoutingPanel.jsx'

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const weekdayFull = (iso) => WEEKDAYS[new Date(iso + 'T12:00:00Z').getUTCDay()]

const orderKey = (stopNbr) => `order|${stopNbr}`
const loadStopKey = (loadNbr, stopNbr) => `load|${loadNbr}|${stopNbr}`

export default function RoutingPage() {
  const { date } = useSelectedDate()
  const [maps, setMaps] = useState({ status: API_KEY ? 'loading' : 'error', api: null, error: API_KEY ? '' : 'No Google Maps API key configured.' })

  const { creds, setCreds, canWrite } = useWriteCreds()
  const { orders, setPlanned } = useCreatedOrders()
  const { loads: watched, watch, unwatch } = useWatchedLoads()

  const [loadData, setLoadData] = useState({}) // loadNbr -> { loadNbr, loadId, routeName, status, stops[], loading, error }
  const [selectMode, setSelectMode] = useState(null)
  const [selectedKeys, setSelectedKeys] = useState(() => new Set())
  const [targetLoad, setTargetLoad] = useState('')
  const [watchInput, setWatchInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [railTab, setRailTab] = useState('orders')
  const [tick, setTick] = useState(0)

  const mapElRef = useRef(null)
  const mapRef = useRef(null)
  const markerByKeyRef = useRef(new Map())
  const clustererRef = useRef(null)
  const projectionRef = useRef(null)
  const selectedKeysRef = useRef(selectedKeys)
  selectedKeysRef.current = selectedKeys
  const clickRef = useRef(() => {})

  // The set of loads to read: explicit watchlist + any load our orders are planned onto.
  const fetchList = useMemo(() => {
    const s = new Set(watched)
    for (const o of orders) if (o.plannedLoadNbr) s.add(o.plannedLoadNbr)
    return [...s]
  }, [watched, orders])
  const fetchKey = fetchList.join(',')

  // ---- Read each watched load live (getLoad + getStop enrichment) ----
  useEffect(() => {
    if (!canWrite || !fetchList.length) return
    let cancelled = false
    ;(async () => {
      for (const nbr of fetchList) {
        setLoadData((p) => ({ ...p, [nbr]: { ...(p[nbr] || { loadNbr: nbr }), loading: true } }))
        try {
          const L = normalizeLoad(await getLoad(creds, nbr))
          const stops = await Promise.all(
            L.stops.map(async (s) => {
              try {
                const d = normalizeStop(await getStop(creds, s.stopNbr))
                return { stopNbr: s.stopNbr, stopId: s.stopId || d.stopId, stopSeq: s.stopSeq, name: d.toName, city: d.toCity, state: d.toState, latitude: d.latitude, longitude: d.longitude }
              } catch {
                return { stopNbr: s.stopNbr, stopId: s.stopId, stopSeq: s.stopSeq }
              }
            }),
          )
          if (cancelled) return
          setLoadData((p) => ({ ...p, [nbr]: { loadNbr: L.loadNbr || nbr, loadId: L.loadId, routeName: L.routeName, status: L.status, stops, loading: false, error: L.loadId ? '' : 'not found' } }))
        } catch (e) {
          if (!cancelled) setLoadData((p) => ({ ...p, [nbr]: { loadNbr: nbr, stops: [], loading: false, error: e.message } }))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchKey, canWrite, creds, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshLoads = useCallback(() => setTick((t) => t + 1), [])

  // Watched-load list (for the Loads tab), in watchlist order then planned-only.
  const watchedLoads = useMemo(
    () => fetchList.map((nbr) => loadData[nbr] || { loadNbr: nbr, stops: [], loading: true }),
    [fetchList, loadData],
  )

  // ---- Selectable universe: created orders + watched-load stops ----
  const orderEntries = useMemo(
    () =>
      orders.map((o) => ({
        key: orderKey(o.stopNbr),
        isOrder: true,
        stop: {
          stopNbr: o.stopNbr,
          stopId: o.stopId,
          name: o.name,
          city: o.city,
          state: o.state,
          loadNbr: o.plannedLoadNbr || '',
          totalPallets: Number(o.pallets) || 0,
          totalCartons: Number(o.cartons) || 0,
          weight: Number(o.weight) || 0,
        },
      })),
    [orders],
  )
  const loadStopEntries = useMemo(() => {
    const out = []
    for (const ld of watchedLoads) {
      for (const s of ld.stops || []) {
        out.push({
          key: loadStopKey(ld.loadNbr, s.stopNbr),
          isOrder: false,
          stop: { ...s, loadNbr: ld.loadNbr },
        })
      }
    }
    return out
  }, [watchedLoads])

  const selectable = useMemo(() => {
    const m = new Map()
    for (const e of loadStopEntries) m.set(e.key, e)
    for (const e of orderEntries) m.set(e.key, e)
    return m
  }, [loadStopEntries, orderEntries])

  const mappedEntries = useMemo(
    () => [...selectable.values()].filter((e) => typeof e.stop.latitude === 'number' && typeof e.stop.longitude === 'number'),
    [selectable],
  )

  const selectedStops = useMemo(() => [...selectedKeys].map((k) => selectable.get(k)).filter(Boolean), [selectedKeys, selectable])
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

  // Day's loads, for the Plan target datalist.
  const loadOptions = useMemo(
    () => watchedLoads.filter((l) => l.loadId).map((l) => ({ loadNbr: l.loadNbr, loadId: l.loadId, routeName: l.routeName, driverUserName: '', stopCount: (l.stops || []).length })),
    [watchedLoads],
  )

  const toggleKey = useCallback((k) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })
  }, [])
  clickRef.current = (key) => toggleKey(key)

  // ---- Google Maps lifecycle ----
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

  useEffect(() => {
    if (maps.status !== 'ready' || !mapElRef.current || mapRef.current) return
    const api = maps.api
    const map = new api.Map(mapElRef.current, { center: { lat: 35.5, lng: -80.0 }, zoom: 8, mapTypeControl: true, streetViewControl: false, fullscreenControl: true, clickableIcons: false })
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

  useEffect(() => {
    const map = mapRef.current
    const api = maps.api
    const clusterer = clustererRef.current
    if (!map || !api || !clusterer) return
    clusterer.clearMarkers()
    const byKey = new Map()
    const markers = []
    const bounds = new api.LatLngBounds()
    for (const e of mappedEntries) {
      const pos = { lat: e.stop.latitude, lng: e.stop.longitude }
      const marker = new api.Marker({ position: pos, title: e.stop.name || e.stop.stopNbr || '', icon: markerIcon(api, e.stop, selectedKeysRef.current.has(e.key)) })
      marker.addListener('click', () => clickRef.current(e.key))
      markers.push(marker)
      byKey.set(e.key, { marker, stop: e.stop })
      bounds.extend(pos)
    }
    clusterer.addMarkers(markers)
    markerByKeyRef.current = byKey
    if (mappedEntries.length === 1) {
      map.setCenter(bounds.getCenter())
      map.setZoom(13)
    } else if (mappedEntries.length > 1) {
      map.fitBounds(bounds, 40)
    }
  }, [mappedEntries, maps.status])

  useEffect(() => {
    const api = maps.api
    if (!api) return
    for (const [key, rec] of markerByKeyRef.current) rec.marker.setIcon(markerIcon(api, rec.stop, selectedKeys.has(key)))
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
    mergeSelection(mappedEntries.filter((e) => latLngInBounds(e.stop.latitude, e.stop.longitude, box)).map((e) => e.key))
  }, [mappedEntries, mergeSelection])

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
      return normalizeStop(await getStop(creds, stop.stopNbr)).stopId
    },
    [creds],
  )

  const resolveTargetLoad = useCallback(
    async (nbr) => {
      const known = loadOptions.find((l) => l.loadNbr === nbr)
      if (known?.loadId) return { loadId: known.loadId, loadNbr: nbr }
      const norm = normalizeLoad(await getLoad(creds, nbr))
      if (!norm.loadId) throw new Error(`Load ${nbr} not found`)
      return { loadId: norm.loadId, loadNbr: norm.loadNbr || nbr }
    },
    [creds, loadOptions],
  )

  const onPlan = useCallback(async () => {
    const nbr = targetLoad.trim().toUpperCase()
    if (!nbr) return setMsg({ text: 'Enter a target load # first.', ok: false })
    setBusy(true)
    setMsg(null)
    try {
      const target = await resolveTargetLoad(nbr)
      const ids = []
      const orderNbrs = []
      for (const sel of selectedStops) {
        const id = await resolveStopId(sel.stop)
        if (id) {
          ids.push(id)
          if (sel.isOrder) orderNbrs.push(sel.stop.stopNbr)
        }
      }
      if (!ids.length) throw new Error('No resolvable stop IDs in the selection.')
      const s = summarize(await insertStops(creds, target.loadId, ids))
      if (!s.ok) throw new Error(s.message)
      if (orderNbrs.length) setPlanned(orderNbrs, target.loadNbr)
      watch(target.loadNbr)
      setMsg({ text: `Planned ${ids.length} order(s) onto ${target.loadNbr}.`, ok: true })
      setSelectedKeys(new Set())
      refreshLoads()
    } catch (e) {
      setMsg({ text: e.message, ok: false })
    } finally {
      setBusy(false)
    }
  }, [creds, targetLoad, selectedStops, resolveStopId, resolveTargetLoad, setPlanned, watch, refreshLoads])

  const onUnplan = useCallback(async () => {
    setBusy(true)
    setMsg(null)
    try {
      const byLoad = new Map()
      const orderNbrs = []
      for (const sel of selectedStops) {
        const loadNbr = sel.stop.loadNbr
        if (!loadNbr) continue
        const id = await resolveStopId(sel.stop)
        if (!id) continue
        if (!byLoad.has(loadNbr)) byLoad.set(loadNbr, [])
        byLoad.get(loadNbr).push(id)
        if (sel.isOrder) orderNbrs.push(sel.stop.stopNbr)
      }
      if (!byLoad.size) throw new Error('Nothing to unplan — selected items aren’t on a load.')
      let total = 0
      const failures = []
      for (const [loadNbr, ids] of byLoad) {
        const s = summarize(await removeStops(creds, loadNbr, ids))
        if (s.ok) total += ids.length
        else failures.push(`${loadNbr}: ${s.message}`)
      }
      if (orderNbrs.length) setPlanned(orderNbrs, null)
      setMsg(failures.length ? { text: `Unplanned ${total}; errors — ${failures.join(' · ')}`, ok: false } : { text: `Unplanned ${total} order(s).`, ok: true })
      setSelectedKeys(new Set())
      refreshLoads()
    } catch (e) {
      setMsg({ text: e.message, ok: false })
    } finally {
      setBusy(false)
    }
  }, [creds, selectedStops, resolveStopId, setPlanned, refreshLoads])

  const onWatch = useCallback(() => {
    const n = watchInput.trim()
    if (n) {
      watch(n)
      setWatchInput('')
      setRailTab('loads')
    }
  }, [watchInput, watch])

  const fullDayLabel = `${weekdayFull(date)}, ${formatDate(date + 'T12:00:00Z')}`

  return (
    <section className="page page--routing">
      <div className="routing__head">
        <h1 className="page__title">Routing <span className="pill pill--beta">beta</span></h1>
        <p className="routing__sub">
          <strong>{fullDayLabel}</strong> · {orders.length} order(s) · {watchedLoads.length} load(s) watched · {selectedKeys.size} selected
        </p>
      </div>

      <div className="routing__grid">
        <div className="routing__controls">
          <div className="routing__section-title">1 · Select</div>
          <p className="map__tools-hint">Check orders (<b>Orders</b>) or load stops (<b>Loads</b>) → then Plan/Unplan.</p>
          <div className="map__tools">
            <button type="button" className="wb-btn wb-btn--sm" onClick={addInView}>＋ In view</button>
            <button type="button" className={`wb-btn wb-btn--sm ${selectMode === 'box' ? 'is-active' : ''}`} onClick={() => setSelectMode((m) => (m === 'box' ? null : 'box'))}>▱ Box</button>
            <button type="button" className={`wb-btn wb-btn--sm ${selectMode === 'lasso' ? 'is-active' : ''}`} onClick={() => setSelectMode((m) => (m === 'lasso' ? null : 'lasso'))}>⬠ Lasso</button>
          </div>
          {selectMode && <p className="map__tools-hint">{selectMode === 'box' ? 'Drag a box on the map' : 'Draw around stops'} · Esc to cancel</p>}

          <div className="routing__section-title">2 · Plan / Unplan</div>
          <PlanBar
            count={selectedKeys.size}
            tally={tally}
            loads={loadOptions}
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

        <div className="routing__map">
          <div className="map__container">
            {maps.status === 'error' && (
              <div className="map__empty">
                Map unavailable: {maps.error}
                {!API_KEY && <> Set <code>VITE_GOOGLE_MAPS_API_KEY</code> and redeploy.</>}
              </div>
            )}
            {maps.status === 'loading' && <div className="map__empty">Loading map…</div>}
            {maps.status === 'ready' && mappedEntries.length === 0 && (
              <div className="map__empty">No geocoded stops yet. Add a load in the Loads tab, or plan created orders →</div>
            )}
            <div ref={mapElRef} className="map__canvas" aria-label="Routing map" />
            {selectMode && maps.status === 'ready' && (
              <SelectionDraw
                mode={selectMode}
                project={project}
                candidates={mappedEntries}
                onCommit={(keys) => {
                  mergeSelection(keys)
                  setSelectMode(null)
                }}
                onCancel={() => setSelectMode(null)}
              />
            )}
          </div>
        </div>

        <RoutingPanel
          tab={railTab}
          setTab={setRailTab}
          orders={orders}
          selectedKeys={selectedKeys}
          onToggleOrder={toggleKey}
          stops={selectedStops}
          onRemove={removeKey}
          watchedLoads={watchedLoads}
          watchInput={watchInput}
          setWatchInput={setWatchInput}
          onWatch={onWatch}
          onUnwatch={unwatch}
          onToggleStop={toggleKey}
          targetLoad={targetLoad}
          setTargetLoad={setTargetLoad}
          loadStopKey={loadStopKey}
        />
      </div>
    </section>
  )
}
