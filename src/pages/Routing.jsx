// Routing (beta) — LOCAL-FIRST plan/unplan. No scans, no discovery reads.
//
// The board is built entirely from local state:
//   • Created orders — the Builder registry (Orders tab). Carry their stopId.
//   • Known loads — the hardcoded src/lib/loads.js list (Loads tab) + the loads our
//     orders are planned onto.
// The NuVizz API is touched ONLY by the user's write actions:
//   • Plan  → insertStops (loadId from the list / a cached one-time getLoad)
//   • Unplan → removeStops
// Every such call is tallied by the call-counter pill (topbar).

import { useCallback, useMemo, useState } from 'react'

import { getLoad, insertStops, removeStops, normalizeLoad, summarize } from '../lib/nuvizzWrite.js'
import { formatDate } from '../lib/format.js'
import { useSelectedDate } from '../hooks/useSelectedDate.js'
import { useWriteCreds } from '../hooks/useWriteCreds.js'
import { useCreatedOrders } from '../hooks/useCreatedOrders.js'
import { KNOWN_LOADS } from '../lib/loads.js'
import PlanBar from '../components/PlanBar.jsx'
import RoutingPanel from '../components/RoutingPanel.jsx'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const weekdayFull = (iso) => WEEKDAYS[new Date(iso + 'T12:00:00Z').getUTCDay()]
const orderKey = (stopNbr) => `order|${stopNbr}`

// loadNbr -> loadId cache so we resolve a load's internal id at most once.
const LOADID_KEY = 'dd_loadid_cache'
const loadIdCache = {
  get(nbr) {
    try {
      return JSON.parse(localStorage.getItem(LOADID_KEY) || '{}')[nbr] || null
    } catch {
      return null
    }
  },
  set(nbr, id) {
    try {
      const m = JSON.parse(localStorage.getItem(LOADID_KEY) || '{}')
      m[nbr] = id
      localStorage.setItem(LOADID_KEY, JSON.stringify(m))
    } catch {
      /* ignore */
    }
  },
}

export default function RoutingPage() {
  const { date } = useSelectedDate()
  const { creds } = useWriteCreds()
  const { orders, setPlanned } = useCreatedOrders()

  const [selectedKeys, setSelectedKeys] = useState(() => new Set())
  const [targetLoad, setTargetLoad] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [railTab, setRailTab] = useState('orders')

  // Selectable universe = created orders (each carries its stopId + planned load).
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
  const selectable = useMemo(() => new Map(orderEntries.map((e) => [e.key, e])), [orderEntries])
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

  // Loads for the picker = KNOWN_LOADS + any load an order is planned onto, with a
  // live count of our orders currently on each (from the registry — no API call).
  const loadsList = useMemo(() => {
    const byNbr = new Map()
    for (const l of KNOWN_LOADS) byNbr.set(l.loadNbr, { loadNbr: l.loadNbr, routeName: l.name || l.loadNbr, loadId: l.loadId, driverUserName: '', stopCount: 0 })
    for (const o of orders) {
      if (!o.plannedLoadNbr) continue
      if (!byNbr.has(o.plannedLoadNbr)) byNbr.set(o.plannedLoadNbr, { loadNbr: o.plannedLoadNbr, routeName: o.plannedLoadNbr, loadId: loadIdCache.get(o.plannedLoadNbr), driverUserName: '', stopCount: 0 })
      byNbr.get(o.plannedLoadNbr).stopCount += 1
    }
    return [...byNbr.values()]
  }, [orders])

  const toggleKey = useCallback((k) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })
  }, [])
  const removeKey = useCallback((key) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  // Resolve a target load number -> loadId: from the known list, else a cached
  // one-time getLoad (the ONLY read this page can make, and only on first Plan).
  const resolveTargetLoad = useCallback(
    async (nbr) => {
      const known = KNOWN_LOADS.find((l) => l.loadNbr === nbr)
      if (known?.loadId) return { loadId: known.loadId, loadNbr: nbr }
      const cached = loadIdCache.get(nbr)
      if (cached) return { loadId: cached, loadNbr: nbr }
      const norm = normalizeLoad(await getLoad(creds, nbr))
      if (!norm.loadId) throw new Error(`Load ${nbr} not found`)
      loadIdCache.set(nbr, norm.loadId)
      return { loadId: norm.loadId, loadNbr: norm.loadNbr || nbr }
    },
    [creds],
  )

  const onPlan = useCallback(async () => {
    const nbr = targetLoad.trim().toUpperCase()
    if (!nbr) return setMsg({ text: 'Enter or pick a target load # first.', ok: false })
    const sel = selectedStops.filter((s) => s.stop.stopId)
    if (!sel.length) return setMsg({ text: 'Select created order(s) to plan.', ok: false })
    setBusy(true)
    setMsg(null)
    try {
      const target = await resolveTargetLoad(nbr)
      const ids = sel.map((s) => s.stop.stopId)
      const s = summarize(await insertStops(creds, target.loadId, ids))
      if (!s.ok) throw new Error(s.message)
      setPlanned(sel.map((s) => s.stop.stopNbr), target.loadNbr)
      setMsg({ text: `Planned ${ids.length} order(s) onto ${target.loadNbr}.`, ok: true })
      setSelectedKeys(new Set())
    } catch (e) {
      setMsg({ text: e.message, ok: false })
    } finally {
      setBusy(false)
    }
  }, [creds, targetLoad, selectedStops, resolveTargetLoad, setPlanned])

  const onUnplan = useCallback(async () => {
    const sel = selectedStops.filter((s) => s.stop.loadNbr && s.stop.stopId)
    if (!sel.length) return setMsg({ text: 'Select planned order(s) to unplan.', ok: false })
    setBusy(true)
    setMsg(null)
    try {
      const byLoad = new Map()
      for (const s of sel) {
        if (!byLoad.has(s.stop.loadNbr)) byLoad.set(s.stop.loadNbr, [])
        byLoad.get(s.stop.loadNbr).push(s.stop)
      }
      let total = 0
      const failures = []
      for (const [loadNbr, stops] of byLoad) {
        const r = summarize(await removeStops(creds, loadNbr, stops.map((s) => s.stopId)))
        if (r.ok) {
          total += stops.length
          setPlanned(stops.map((s) => s.stopNbr), null)
        } else failures.push(`${loadNbr}: ${r.message}`)
      }
      setMsg(failures.length ? { text: `Unplanned ${total}; errors — ${failures.join(' · ')}`, ok: false } : { text: `Unplanned ${total} order(s).`, ok: true })
      setSelectedKeys(new Set())
    } catch (e) {
      setMsg({ text: e.message, ok: false })
    } finally {
      setBusy(false)
    }
  }, [creds, selectedStops, setPlanned])

  const fullDayLabel = `${weekdayFull(date)}, ${formatDate(date + 'T12:00:00Z')}`

  return (
    <section className="page page--routing">
      <div className="routing__head">
        <h1 className="page__title">Routing <span className="pill pill--beta">beta</span></h1>
        <p className="routing__sub">
          <strong>{fullDayLabel}</strong> · {orders.length} order(s) · {loadsList.length} load(s) · {selectedKeys.size} selected · local-first (API only on plan/unplan)
        </p>
      </div>

      <div className="routing__grid routing__grid--nomap">
        <div className="routing__controls">
          <div className="routing__section-title">1 · Select orders</div>
          <p className="map__tools-hint">Check created orders in the <b>Orders</b> tab → pick a target in <b>Loads</b> → Plan. Select planned orders → Unplan.</p>

          <div className="routing__section-title">2 · Plan / Unplan</div>
          <PlanBar
            count={selectedStops.length}
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
          />
        </div>

        <RoutingPanel
          tab={railTab}
          setTab={setRailTab}
          orders={orders}
          selectedKeys={selectedKeys}
          onToggleOrder={toggleKey}
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
