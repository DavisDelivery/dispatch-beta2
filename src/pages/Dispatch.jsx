import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PackagePlus, Truck, Inbox, ArrowRight, X, CheckCircle2, AlertCircle, Package, LayoutGrid, Map as MapIcon, GripVertical, User, RefreshCw, Send, ChevronUp, ChevronDown, ListOrdered } from 'lucide-react'
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

// Auto-reconcile with NuVizz once per page load (a fresh module instance per
// full reload), so the board reflects reality when you open it.
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
  const { orders, plan, unplan, reconcile, dispatchDriver, dispatchLoad, sequenceByLoad, sequenceLoad } = usePlanning()
  const { byStop: coords } = useGeocode(orders)
  const { assignments, assign } = useAssignments()
  const [syncing, setSyncing] = useState(false)
  const [drafts, setDrafts] = useState({}) // loadNbr -> [stopNbr] pending manual order
  const [sel, setSel] = useState(() => new Set())
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [view, setView] = useState('board')

  const unassigned = useMemo(() => orders.filter((o) => !o.plannedLoadNbr), [orders])
  const lanes = useMemo(() => {
    const byNbr = new Map()
    for (const l of KNOWN_LOADS) byNbr.set(l.loadNbr, { loadNbr: l.loadNbr, name: l.name || l.loadNbr, planned: [] })
    for (const o of orders) {
      if (!o.plannedLoadNbr) continue
      if (!byNbr.has(o.plannedLoadNbr)) byNbr.set(o.plannedLoadNbr, { loadNbr: o.plannedLoadNbr, name: o.plannedLoadNbr, planned: [] })
      byNbr.get(o.plannedLoadNbr).planned.push(o)
    }
    return [...byNbr.values()]
  }, [orders])

  const plannedCount = orders.length - unassigned.length
  const selectedOrders = useMemo(() => orders.filter((o) => sel.has(o.stopNbr)), [orders, sel])

  const toggle = (stopNbr) =>
    setSel((prev) => {
      const next = new Set(prev)
      next.has(stopNbr) ? next.delete(stopNbr) : next.add(stopNbr)
      return next
    })
  const clearSel = () => setSel(new Set())
  const selectMany = (stopNbrs) => setSel((prev) => new Set([...prev, ...stopNbrs]))

  // Driver picker → record the board assignment + (for a real driver) dispatch in NuVizz.
  const onAssignDriver = useCallback(
    async (loadNbr, userName) => {
      assign(loadNbr, userName) // optimistic board record (cross-device)
      const driver = KNOWN_DRIVERS.find((d) => d.userName === userName)
      if (!driver) return // "Unassigned" → board-only clear (NuVizz un-dispatch not wired)
      setBusy(true)
      setToast(null)
      const r = await dispatchDriver(loadNbr, driver)
      setBusy(false)
      setToast(r)
    },
    [assign, dispatchDriver],
  )

  // Dispatch (release) a load to its assigned driver in NuVizz.
  const onDispatch = useCallback(
    async (loadNbr) => {
      setBusy(true)
      setToast(null)
      setToast(await dispatchLoad(loadNbr))
      setBusy(false)
    },
    [dispatchLoad],
  )

  // ---- Manual sequencing (one-at-a-time insert preserves order) ----
  // Effective order for a lane: a pending draft, else NuVizz's real order, else
  // registry order. Returns the planned orders in that order.
  const laneOrder = (lane) => {
    const base = drafts[lane.loadNbr] || sequenceByLoad[lane.loadNbr] || []
    const byNbr = new Map(lane.planned.map((o) => [o.stopNbr, o]))
    const ordered = base.map((sn) => byNbr.get(sn)).filter(Boolean)
    for (const o of lane.planned) if (!base.includes(o.stopNbr)) ordered.push(o)
    return ordered
  }
  const moveStop = (loadNbr, ordered, idx, dir) => {
    const j = idx + dir
    if (j < 0 || j >= ordered.length) return
    const nums = ordered.map((o) => o.stopNbr)
    ;[nums[idx], nums[j]] = [nums[j], nums[idx]]
    setDrafts((d) => ({ ...d, [loadNbr]: nums }))
  }
  const draftDiffers = (lane) => {
    const draft = drafts[lane.loadNbr]
    if (!draft) return false
    const committed = sequenceByLoad[lane.loadNbr] || lane.planned.map((o) => o.stopNbr)
    return draft.join(',') !== committed.join(',')
  }
  const clearDraft = (loadNbr) =>
    setDrafts((d) => {
      const n = { ...d }
      delete n[loadNbr]
      return n
    })
  const applySequence = async (loadNbr) => {
    if (!drafts[loadNbr]) return
    setBusy(true)
    setToast(null)
    const r = await sequenceLoad(loadNbr, drafts[loadNbr])
    setToast(r)
    if (r.ok) clearDraft(loadNbr)
    setBusy(false)
  }

  // Reconcile planned/unplanned against NuVizz reality.
  const doSync = useCallback(
    async (auto) => {
      setSyncing(true)
      const r = await reconcile()
      setSyncing(false)
      if (!auto || r.changed) {
        setToast({
          ok: true,
          message: r.changed
            ? `Synced with NuVizz — ${r.changed} order(s) corrected (${r.calls} load read${r.calls === 1 ? '' : 's'}).`
            : `Already in sync with NuVizz (${r.calls} load read${r.calls === 1 ? '' : 's'}).`,
        })
      }
    },
    [reconcile],
  )

  // Auto-sync once per page load, after the registry has loaded.
  useEffect(() => {
    if (orders.length && !autoSyncDone) {
      autoSyncDone = true
      doSync(true)
    }
  }, [orders.length, doSync])

  // Plan the selected orders onto `target` (moving any already planned elsewhere).
  const doPlan = async () => {
    if (!target || !selectedOrders.length) return
    setBusy(true)
    setToast(null)
    const planned = selectedOrders.filter((o) => o.plannedLoadNbr && o.plannedLoadNbr !== target)
    if (planned.length) await unplan(planned)
    const r = await plan(target, selectedOrders)
    setToast(r)
    if (r.ok) clearSel()
    setBusy(false)
  }
  const doUnplan = async () => {
    const planned = selectedOrders.filter((o) => o.plannedLoadNbr)
    if (!planned.length) return
    setBusy(true)
    setToast(null)
    setToast(await unplan(planned))
    clearSel()
    setBusy(false)
  }

  // Drag-and-drop (mouse + touch): move a single dragged order to a dropzone.
  const onDrop = async (zoneId, o) => {
    if (!o) return
    if (zoneId === '__unassigned') {
      if (o.plannedLoadNbr) {
        setBusy(true)
        setToast(await unplan([o]))
        setBusy(false)
      }
      return
    }
    if (o.plannedLoadNbr === zoneId) return
    setBusy(true)
    setToast(null)
    if (o.plannedLoadNbr) await unplan([o])
    setToast(await plan(zoneId, [o]))
    setBusy(false)
  }
  const { drag, zone, start } = useBoardDrag(onDrop)

  return (
    <div className="mx-auto max-w-[1600px] p-4 md:p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Package} label="Orders" value={orders.length} />
        <Stat icon={Inbox} label="Unassigned" value={unassigned.length} tone={unassigned.length ? 'text-warning' : 'text-foreground'} />
        <Stat icon={CheckCircle2} label="Planned" value={plannedCount} tone={plannedCount ? 'text-success' : 'text-foreground'} />
        <Stat icon={Truck} label="Loads" value={lanes.length} />
      </div>

      {/* Toolbar: view toggle + selection action bar */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {[
            { id: 'board', label: 'Board', icon: LayoutGrid },
            { id: 'map', label: 'Map', icon: MapIcon },
          ].map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              className={cn(
                'focus-ring inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                view === v.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <v.icon className="h-4 w-4" /> {v.label}
            </button>
          ))}
        </div>

        <Button variant="ghost" size="sm" onClick={() => doSync(false)} disabled={syncing} title="Re-read NuVizz and fix any planned/unplanned drift">
          <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
          {syncing ? 'Syncing…' : 'Sync'}
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {sel.size > 0 && <Badge tone="primary">{sel.size} selected</Badge>}
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="focus-ring h-9 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground"
          >
            <option value="">Target load…</option>
            {lanes.map((l) => (
              <option key={l.loadNbr} value={l.loadNbr}>{l.name} · {l.loadNbr}</option>
            ))}
          </select>
          <Button variant="primary" disabled={busy || !sel.size || !target} onClick={doPlan}>
            Plan <ArrowRight className="h-4 w-4" />
          </Button>
          <Button variant="secondary" disabled={busy || !selectedOrders.some((o) => o.plannedLoadNbr)} onClick={doUnplan}>
            Unplan
          </Button>
          {sel.size > 0 && (
            <Button variant="ghost" size="icon" onClick={clearSel} title="Clear selection">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {toast && (
        <div
          className={cn(
            'mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm animate-slide-up',
            toast.ok ? 'border-success/30 bg-success/10 text-success' : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          {toast.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          {toast.message}
        </div>
      )}

      {/* BOARD */}
      {view === 'board' && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
          <section
            data-dropzone="__unassigned"
            className={cn(
              'flex max-h-[calc(100dvh-260px)] flex-col rounded-xl border bg-card shadow-soft transition-colors',
              zone === '__unassigned' ? 'border-warning/60 ring-2 ring-warning/30' : 'border-border',
            )}
          >
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
                  <p className="text-sm text-muted-foreground">{orders.length === 0 ? 'Create an order to begin.' : 'All orders are planned.'}</p>
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
              <div
                key={lane.loadNbr}
                data-dropzone={lane.loadNbr}
                className={cn(
                  'flex flex-col rounded-xl border bg-card shadow-soft transition-colors',
                  zone === lane.loadNbr ? 'border-primary/60 ring-2 ring-primary/30' : 'border-border',
                )}
              >
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
                      <DriverSelect value={assignments[lane.loadNbr] || ''} onChange={(u) => onAssignDriver(lane.loadNbr, u)} />
                    </div>
                    <button
                      type="button"
                      onClick={() => onDispatch(lane.loadNbr)}
                      disabled={busy || !lane.planned.length}
                      title={lane.planned.length ? 'Dispatch this load to its driver in NuVizz' : 'Plan stops onto this load first'}
                      className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                    >
                      <Send className="h-3.5 w-3.5" /> Dispatch
                    </button>
                  </div>
                </div>
                <div className="min-h-[72px] space-y-1.5 p-2">
                  {lane.planned.length === 0 && (
                    <div className="px-3 py-5 text-center text-xs text-muted-foreground">Drop an order here, or select + Plan.</div>
                  )}
                  {laneOrder(lane).map((o, i, arr) => (
                    <OrderCard
                      key={o.stopNbr}
                      order={o}
                      planned
                      seqNo={i + 1}
                      onUp={i > 0 ? () => moveStop(lane.loadNbr, arr, i, -1) : null}
                      onDown={i < arr.length - 1 ? () => moveStop(lane.loadNbr, arr, i, 1) : null}
                      selected={sel.has(o.stopNbr)}
                      onClick={() => toggle(o.stopNbr)}
                      onHandleDown={start(o)}
                      dragging={drag?.order.stopNbr === o.stopNbr}
                      unplanOne={async () => {
                        setBusy(true)
                        setToast(await unplan([o]))
                        setBusy(false)
                      }}
                    />
                  ))}
                </div>
                {draftDiffers(lane) && (
                  <div className="flex items-center gap-2 border-t border-border bg-primary/5 px-3 py-2">
                    <ListOrdered className="h-3.5 w-3.5 text-primary" />
                    <span className="text-[11px] font-medium text-muted-foreground">Order changed</span>
                    <button type="button" onClick={() => clearDraft(lane.loadNbr)} disabled={busy} className="focus-ring ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
                      Reset
                    </button>
                    <button type="button" onClick={() => applySequence(lane.loadNbr)} disabled={busy} className="focus-ring inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
                      Apply order
                    </button>
                  </div>
                )}
              </div>
            ))}
          </section>
        </div>
      )}

      {/* MAP */}
      {view === 'map' && (
        <div className="mt-5 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <section className="flex max-h-[calc(100dvh-260px)] flex-col rounded-xl border border-border bg-card shadow-soft">
            <div className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">Orders</div>
            <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
              {orders.map((o) => (
                <OrderCard key={o.stopNbr} order={o} planned={!!o.plannedLoadNbr} selected={sel.has(o.stopNbr)} onClick={() => toggle(o.stopNbr)} noDrag mapped={!!coords[o.stopNbr]} />
              ))}
            </div>
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              Click markers or rows to select → pick a load above → Plan.
            </div>
          </section>
          <div className="h-[calc(100dvh-260px)]">
            <DispatchMap orders={orders} coords={coords} selected={sel} onToggle={toggle} onSelectMany={selectMany} />
          </div>
        </div>
      )}

      {/* Drag ghost (follows the pointer on mouse + touch) */}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-primary/50 bg-card px-3 py-2 text-sm font-medium text-foreground shadow-pop"
          style={{ left: drag.x, top: drag.y }}
        >
          {drag.order.name || drag.order.stopNbr}
        </div>
      )}
    </div>
  )
}

function DriverSelect({ value, onChange }) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-lg border px-2 py-1 transition-colors',
        value ? 'border-primary/40 bg-primary/5' : 'border-border bg-background',
      )}
    >
      <User className={cn('h-3.5 w-3.5 shrink-0', value ? 'text-primary' : 'text-muted-foreground')} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Assign a driver to this load"
        className="focus-ring w-full cursor-pointer truncate bg-transparent text-xs font-medium text-foreground outline-none"
      >
        <option value="">Unassigned</option>
        {KNOWN_DRIVERS.map((d) => (
          <option key={d.userName} value={d.userName}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  )
}

function OrderCard({ order, planned, selected, onClick, onHandleDown, dragging, unplanOne, noDrag, mapped, seqNo, onUp, onDown }) {
  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors',
        selected ? 'border-primary/50 bg-primary/10' : 'border-transparent bg-background hover:bg-accent',
        dragging && 'opacity-40',
      )}
    >
      {!noDrag && (
        <span
          onPointerDown={onHandleDown}
          className="-ml-1 grid shrink-0 cursor-grab touch-none place-items-center py-1 pl-1 pr-0.5 text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
          title="Drag to a load"
        >
          <GripVertical className="h-4 w-4" />
        </span>
      )}
      {seqNo != null && (
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold tabular-nums text-primary" title={`Stop ${seqNo}`}>
          {seqNo}
        </span>
      )}
      <button type="button" onClick={onClick} className="focus-ring flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong')}>
          {selected && <CheckCircle2 className="h-3 w-3" />}
        </span>
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
          <button type="button" onClick={onUp} disabled={!onUp} title="Move earlier" className="focus-ring grid h-3.5 w-5 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-20">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onDown} disabled={!onDown} title="Move later" className="focus-ring grid h-3.5 w-5 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-20">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
      {planned && unplanOne && (
        <button
          type="button"
          onClick={unplanOne}
          title="Unplan"
          className="focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
