import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PackagePlus, Truck, Inbox, ArrowRight, X, CheckCircle2, AlertCircle, Package, LayoutGrid, Map as MapIcon, GripVertical, User, RefreshCw, Send, ChevronUp, ChevronDown, Save, Undo2 } from 'lucide-react'
import { usePlanning } from '../hooks/usePlanning.js'
import { useGeocode } from '../hooks/useGeocode.js'
import { useBoardDrag } from '../hooks/useBoardDrag.js'
import { useAssignments } from '../hooks/useAssignments.js'
import { KNOWN_LOADS } from '../lib/loads.js'
import { KNOWN_DRIVERS } from '../lib/drivers.js'
import DispatchMap from '../components/dispatch/DispatchMap.jsx'
import Button from '../ui/Button.jsx'
import Badge from '../ui/Badge.jsx'
import { cn } from '../lib/cn.js'

// Auto-reconcile with NuVizz once per page load so the board reflects reality.
let autoSyncDone = false

function Stat({ icon: Icon, label, value, tone = 'text-foreground' }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-soft">
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.9} />
      </span>
      <div className="leading-tight">
        <div className={cn('text-xl font-semibold tracking-tight tabular-nums', tone)}>{value}</div>
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}

export default function Dispatch() {
  const { orders, reconcile, dispatchDriver, dispatchLoad, sequenceByLoad, commit } = usePlanning()
  const { byStop: coords } = useGeocode(orders)
  const { assignments, assign } = useAssignments()
  const [syncing, setSyncing] = useState(false)
  const [sel, setSel] = useState(() => new Set())
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [view, setView] = useState('board')
  // Draft = the staged arrangement, committed on Save. null = clean (live state).
  const [draft, setDraft] = useState(null) // { place: {stopNbr: loadNbr|null}, order: {loadNbr: [stopNbr]} }

  const byNbr = useMemo(() => new Map(orders.map((o) => [o.stopNbr, o])), [orders])
  const baseLoadOf = (stopNbr) => byNbr.get(stopNbr)?.plannedLoadNbr || null
  const placeOf = useCallback(
    (o) => (draft && Object.prototype.hasOwnProperty.call(draft.place, o.stopNbr) ? draft.place[o.stopNbr] : o.plannedLoadNbr || null),
    [draft],
  )
  // Stops on a load, in baseline (NuVizz) order.
  const baselineOrder = useCallback(
    (loadNbr) => {
      const members = orders.filter((o) => (o.plannedLoadNbr || null) === loadNbr).map((o) => o.stopNbr)
      const seq = sequenceByLoad[loadNbr] || []
      return members.sort((a, b) => {
        const ia = seq.indexOf(a)
        const ib = seq.indexOf(b)
        return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib)
      })
    },
    [orders, sequenceByLoad],
  )
  const effOrder = useCallback((loadNbr) => draft?.order?.[loadNbr] || baselineOrder(loadNbr), [draft, baselineOrder])
  const dirty = !!draft && (Object.keys(draft.place).length > 0 || Object.keys(draft.order).length > 0)

  // Orders with their EFFECTIVE (draft-aware) placement — drives the whole board + map.
  const effOrders = useMemo(() => orders.map((o) => ({ ...o, plannedLoadNbr: placeOf(o) })), [orders, placeOf])
  const unassigned = useMemo(() => effOrders.filter((o) => !o.plannedLoadNbr), [effOrders])
  const lanes = useMemo(() => {
    const byL = new Map()
    for (const l of KNOWN_LOADS) byL.set(l.loadNbr, { loadNbr: l.loadNbr, name: l.name || l.loadNbr, planned: [] })
    for (const o of effOrders) {
      if (!o.plannedLoadNbr) continue
      if (!byL.has(o.plannedLoadNbr)) byL.set(o.plannedLoadNbr, { loadNbr: o.plannedLoadNbr, name: o.plannedLoadNbr, planned: [] })
      byL.get(o.plannedLoadNbr).planned.push(o)
    }
    return [...byL.values()]
  }, [effOrders])
  const orderedFor = (lane) => {
    const seq = effOrder(lane.loadNbr)
    const at = (sn) => {
      const i = seq.indexOf(sn)
      return i === -1 ? 1e9 : i
    }
    return [...lane.planned].sort((a, b) => at(a.stopNbr) - at(b.stopNbr))
  }

  const plannedCount = effOrders.filter((o) => o.plannedLoadNbr).length
  const selectedOrders = effOrders.filter((o) => sel.has(o.stopNbr))

  const toggle = (stopNbr) =>
    setSel((prev) => {
      const next = new Set(prev)
      next.has(stopNbr) ? next.delete(stopNbr) : next.add(stopNbr)
      return next
    })
  const clearSel = () => setSel(new Set())
  const selectMany = (stopNbrs) => setSel((prev) => new Set([...prev, ...stopNbrs]))

  // ---- Draft mutations (no API; applied on Commit) ----
  const moveTo = useCallback(
    (stopNbr, toLoad, atIndex) => {
      setDraft((prev) => {
        const d = { place: { ...(prev?.place || {}) }, order: { ...(prev?.order || {}) } }
        const from = Object.prototype.hasOwnProperty.call(d.place, stopNbr) ? d.place[stopNbr] : baseLoadOf(stopNbr)
        if (from) d.order[from] = (d.order[from] || baselineOrder(from)).filter((n) => n !== stopNbr)
        d.place[stopNbr] = toLoad || null
        if (toLoad) {
          const arr = (d.order[toLoad] || baselineOrder(toLoad)).filter((n) => n !== stopNbr)
          const idx = atIndex == null ? arr.length : Math.max(0, Math.min(atIndex, arr.length))
          arr.splice(idx, 0, stopNbr)
          d.order[toLoad] = arr
        }
        return d
      })
    },
    [baselineOrder, byNbr],
  )
  const moveMany = (stopNbrs, toLoad) => stopNbrs.forEach((sn) => moveTo(sn, toLoad))
  const reorderInLane = (loadNbr, stopNbr, dir) => {
    setDraft((prev) => {
      const d = { place: { ...(prev?.place || {}) }, order: { ...(prev?.order || {}) } }
      const arr = (d.order[loadNbr] || baselineOrder(loadNbr)).slice()
      const i = arr.indexOf(stopNbr)
      const j = i + dir
      if (i < 0 || j < 0 || j >= arr.length) return prev
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
      d.order[loadNbr] = arr
      return d
    })
  }

  // ---- Drag-and-drop (mouse + touch): stage a move into the draft ----
  const onDrop = (zoneId, o) => {
    if (!o) return
    moveTo(o.stopNbr, zoneId === '__unassigned' ? null : zoneId)
  }
  const { drag, zone, start } = useBoardDrag(onDrop)

  // ---- Toolbar plan/unplan = draft edits ----
  const doPlan = () => {
    if (!target || !selectedOrders.length) return
    moveMany(selectedOrders.map((o) => o.stopNbr), target)
    clearSel()
  }
  const doUnplan = () => {
    const planned = selectedOrders.filter((o) => o.plannedLoadNbr)
    if (!planned.length) return
    moveMany(planned.map((o) => o.stopNbr), null)
    clearSel()
  }

  // ---- Commit the draft to NuVizz ----
  const onCommit = async () => {
    setBusy(true)
    setToast(null)
    const loadsSet = new Set(effOrders.map((o) => o.plannedLoadNbr).filter(Boolean))
    const desiredByLoad = []
    for (const loadNbr of loadsSet) {
      const ord = effOrder(loadNbr)
        .map((n) => byNbr.get(n))
        .filter((o) => o && placeOf(o) === loadNbr && o.stopId)
      if (ord.length) desiredByLoad.push([loadNbr, ord])
    }
    const r = await commit(desiredByLoad)
    setToast(r)
    if (r.ok) {
      setDraft(null)
      await reconcile()
    }
    setBusy(false)
  }
  const onDiscard = () => setDraft(null)

  // ---- Reconcile (read NuVizz reality) ----
  const doSync = useCallback(
    async (auto) => {
      setSyncing(true)
      const r = await reconcile()
      setSyncing(false)
      if (!auto || r.changed) {
        setToast({ ok: true, message: r.changed ? `Synced — ${r.changed} order(s) corrected (${r.calls} read${r.calls === 1 ? '' : 's'}).` : `In sync (${r.calls} read${r.calls === 1 ? '' : 's'}).` })
      }
    },
    [reconcile],
  )
  useEffect(() => {
    if (orders.length && !autoSyncDone) {
      autoSyncDone = true
      doSync(true)
    }
  }, [orders.length, doSync])

  const onAssignDriver = useCallback(
    async (loadNbr, userName) => {
      assign(loadNbr, userName)
      const driver = KNOWN_DRIVERS.find((d) => d.userName === userName)
      if (!driver) return
      setBusy(true)
      setToast(null)
      setToast(await dispatchDriver(loadNbr, driver))
      setBusy(false)
    },
    [assign, dispatchDriver],
  )
  const onDispatch = useCallback(
    async (loadNbr) => {
      setBusy(true)
      setToast(null)
      setToast(await dispatchLoad(loadNbr))
      setBusy(false)
    },
    [dispatchLoad],
  )

  return (
    <div className="mx-auto max-w-[1600px] p-4 md:p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Package} label="Orders" value={orders.length} />
        <Stat icon={Inbox} label="Unassigned" value={unassigned.length} tone={unassigned.length ? 'text-warning' : 'text-foreground'} />
        <Stat icon={CheckCircle2} label="Planned" value={plannedCount} tone={plannedCount ? 'text-success' : 'text-foreground'} />
        <Stat icon={Truck} label="Loads" value={lanes.length} />
      </div>

      {/* Toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {[
            { id: 'board', label: 'Board', icon: LayoutGrid },
            { id: 'map', label: 'Map', icon: MapIcon },
          ].map((v) => (
            <button key={v.id} type="button" onClick={() => setView(v.id)} className={cn('focus-ring inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors', view === v.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <v.icon className="h-4 w-4" /> {v.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={() => doSync(false)} disabled={syncing || dirty} title={dirty ? 'Commit or discard your changes first' : 'Re-read NuVizz and fix any drift'}>
          <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
          {syncing ? 'Syncing…' : 'Sync'}
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {sel.size > 0 && <Badge tone="primary">{sel.size} selected</Badge>}
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="focus-ring h-9 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground">
            <option value="">Move to load…</option>
            {lanes.map((l) => (
              <option key={l.loadNbr} value={l.loadNbr}>{l.name} · {l.loadNbr}</option>
            ))}
          </select>
          <Button variant="primary" disabled={!sel.size || !target} onClick={doPlan}>
            Move <ArrowRight className="h-4 w-4" />
          </Button>
          <Button variant="secondary" disabled={!selectedOrders.some((o) => o.plannedLoadNbr)} onClick={doUnplan}>
            Unassign
          </Button>
          {sel.size > 0 && (
            <Button variant="ghost" size="icon" onClick={clearSel} title="Clear selection">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Unsaved-changes bar */}
      {dirty && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2">
          <Save className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Unsaved arrangement — nothing is in NuVizz until you commit.</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
              <Undo2 className="h-4 w-4" /> Discard
            </Button>
            <Button variant="primary" size="sm" onClick={onCommit} disabled={busy}>
              {busy ? 'Committing…' : <><Save className="h-4 w-4" /> Commit to NuVizz</>}
            </Button>
          </div>
        </div>
      )}

      {toast && (
        <div className={cn('mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm animate-slide-up', toast.ok ? 'border-success/30 bg-success/10 text-success' : 'border-destructive/30 bg-destructive/10 text-destructive')}>
          {toast.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          {toast.message}
        </div>
      )}

      {/* BOARD */}
      {view === 'board' && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
          <section data-dropzone="__unassigned" className={cn('flex max-h-[calc(100dvh-300px)] flex-col rounded-xl border bg-card shadow-soft transition-colors', zone === '__unassigned' ? 'border-warning/60 ring-2 ring-warning/30' : 'border-border')}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Inbox className="h-4 w-4 text-muted-foreground" /> Unassigned
                <Badge tone={unassigned.length ? 'warning' : 'neutral'}>{unassigned.length}</Badge>
              </div>
              <Link to="/build" className="focus-ring inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline">
                <PackagePlus className="h-3.5 w-3.5" /> New
              </Link>
            </div>
            <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
              {unassigned.length === 0 && (
                <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
                  <span className="grid h-11 w-11 place-items-center rounded-full bg-muted text-muted-foreground"><Inbox className="h-5 w-5" /></span>
                  <p className="text-sm text-muted-foreground">{orders.length === 0 ? 'Create an order to begin.' : 'All orders are placed.'}</p>
                  {orders.length === 0 && <Link to="/build"><Button size="sm" variant="primary" className="mt-1">Create order</Button></Link>}
                </div>
              )}
              {unassigned.map((o) => (
                <OrderCard key={o.stopNbr} order={o} selected={sel.has(o.stopNbr)} onClick={() => toggle(o.stopNbr)} onHandleDown={start(o)} dragging={drag?.order.stopNbr === o.stopNbr} />
              ))}
            </div>
          </section>

          <section className="grid auto-rows-min gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {lanes.map((lane) => (
              <div key={lane.loadNbr} data-dropzone={lane.loadNbr} className={cn('flex flex-col rounded-xl border bg-card shadow-soft transition-colors', zone === lane.loadNbr ? 'border-primary/60 ring-2 ring-primary/30' : 'border-border')}>
                <div className="space-y-2 border-b border-border px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Truck className="h-4 w-4" strokeWidth={1.9} /></span>
                      <div className="min-w-0 leading-tight">
                        <div className="truncate text-sm font-semibold text-foreground">{lane.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{lane.loadNbr}</div>
                      </div>
                    </div>
                    <Badge tone={lane.planned.length ? 'primary' : 'neutral'}>{lane.planned.length}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <DriverSelect value={assignments[lane.loadNbr] || ''} onChange={(u) => onAssignDriver(lane.loadNbr, u)} disabled={dirty} />
                    </div>
                    <button type="button" onClick={() => onDispatch(lane.loadNbr)} disabled={busy || dirty || !lane.planned.length} title={dirty ? 'Commit your changes first' : lane.planned.length ? 'Dispatch this load to its driver' : 'Plan stops first'} className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40">
                      <Send className="h-3.5 w-3.5" /> Dispatch
                    </button>
                  </div>
                </div>
                <div className="min-h-[72px] space-y-1.5 p-2">
                  {lane.planned.length === 0 && <div className="px-3 py-5 text-center text-xs text-muted-foreground">Drag an order here, or select + Move.</div>}
                  {orderedFor(lane).map((o, i, arr) => (
                    <OrderCard
                      key={o.stopNbr}
                      order={o}
                      planned
                      seqNo={i + 1}
                      onUp={i > 0 ? () => reorderInLane(lane.loadNbr, o.stopNbr, -1) : null}
                      onDown={i < arr.length - 1 ? () => reorderInLane(lane.loadNbr, o.stopNbr, 1) : null}
                      selected={sel.has(o.stopNbr)}
                      onClick={() => toggle(o.stopNbr)}
                      onHandleDown={start(o)}
                      dragging={drag?.order.stopNbr === o.stopNbr}
                      unplanOne={() => moveTo(o.stopNbr, null)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        </div>
      )}

      {/* MAP */}
      {view === 'map' && (
        <div className="mt-5 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <section className="flex max-h-[calc(100dvh-300px)] flex-col rounded-xl border border-border bg-card shadow-soft">
            <div className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">Orders</div>
            <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
              {effOrders.map((o) => (
                <OrderCard key={o.stopNbr} order={o} planned={!!o.plannedLoadNbr} selected={sel.has(o.stopNbr)} onClick={() => toggle(o.stopNbr)} noDrag mapped={!!coords[o.stopNbr]} />
              ))}
            </div>
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Select markers/rows → pick a load → Move. Commit when done.</div>
          </section>
          <div className="h-[calc(100dvh-300px)]">
            <DispatchMap orders={effOrders} coords={coords} selected={sel} onToggle={toggle} onSelectMany={selectMany} />
          </div>
        </div>
      )}

      {/* Drag ghost */}
      {drag && (
        <div className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-primary/50 bg-card px-3 py-2 text-sm font-medium text-foreground shadow-pop" style={{ left: drag.x, top: drag.y }}>
          {drag.order.name || drag.order.stopNbr}
        </div>
      )}
    </div>
  )
}

function DriverSelect({ value, onChange, disabled }) {
  return (
    <div className={cn('flex items-center gap-1.5 rounded-lg border px-2 py-1 transition-colors', value ? 'border-primary/40 bg-primary/5' : 'border-border bg-background', disabled && 'opacity-50')}>
      <User className={cn('h-3.5 w-3.5 shrink-0', value ? 'text-primary' : 'text-muted-foreground')} />
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} title={disabled ? 'Commit your changes first' : 'Assign a driver to this load'} className="focus-ring w-full cursor-pointer truncate bg-transparent text-xs font-medium text-foreground outline-none disabled:cursor-not-allowed">
        <option value="">Unassigned</option>
        {KNOWN_DRIVERS.map((d) => (
          <option key={d.userName} value={d.userName}>{d.name}</option>
        ))}
      </select>
    </div>
  )
}

function OrderCard({ order, planned, selected, onClick, onHandleDown, dragging, unplanOne, noDrag, mapped, seqNo, onUp, onDown }) {
  return (
    <div className={cn('group flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors', selected ? 'border-primary/50 bg-primary/10' : 'border-transparent bg-background hover:bg-accent', dragging && 'opacity-40')}>
      {!noDrag && (
        <span onPointerDown={onHandleDown} className="-ml-1 grid shrink-0 cursor-grab touch-none place-items-center py-1 pl-1 pr-0.5 text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing" title="Drag to a load">
          <GripVertical className="h-4 w-4" />
        </span>
      )}
      {seqNo != null && <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold tabular-nums text-primary" title={`Stop ${seqNo}`}>{seqNo}</span>}
      <button type="button" onClick={onClick} className="focus-ring flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong')}>{selected && <CheckCircle2 className="h-3 w-3" />}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{order.name || order.stopNbr}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {order.city ? `${order.city}${order.state ? ', ' + order.state : ''}` : order.stopNbr}
            {order.pallets ? ` · ${order.pallets} skid${order.pallets > 1 ? 's' : ''}` : ''}
          </span>
        </span>
      </button>
      {mapped === false && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" title="Not yet geocoded" />}
      {(onUp || onDown) && (
        <span className="flex shrink-0 flex-col opacity-0 transition group-hover:opacity-100">
          <button type="button" onClick={onUp} disabled={!onUp} title="Move earlier" className="focus-ring grid h-3.5 w-5 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronUp className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={onDown} disabled={!onDown} title="Move later" className="focus-ring grid h-3.5 w-5 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronDown className="h-3.5 w-3.5" /></button>
        </span>
      )}
      {planned && unplanOne && (
        <button type="button" onClick={unplanOne} title="Move to Unassigned" className="focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"><X className="h-4 w-4" /></button>
      )}
    </div>
  )
}
