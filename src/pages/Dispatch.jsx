import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PackagePlus, Truck, Layers, Inbox, ArrowRight, X, CheckCircle2, AlertCircle, Package } from 'lucide-react'
import { usePlanning } from '../hooks/usePlanning.js'
import { KNOWN_LOADS } from '../lib/loads.js'
import Button from '../ui/Button.jsx'
import Badge from '../ui/Badge.jsx'
import { cn } from '../lib/cn.js'

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
  const { orders, plan, unplan } = usePlanning()
  const [sel, setSel] = useState(() => new Set())
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)

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
  const selectedOrders = unassigned.filter((o) => sel.has(o.stopNbr))

  const toggle = (stopNbr) =>
    setSel((prev) => {
      const next = new Set(prev)
      next.has(stopNbr) ? next.delete(stopNbr) : next.add(stopNbr)
      return next
    })

  const doPlan = async () => {
    setBusy(true)
    setToast(null)
    const r = await plan(target, selectedOrders)
    setToast(r)
    if (r.ok) setSel(new Set())
    setBusy(false)
  }
  const doUnplan = async (order) => {
    setBusy(true)
    const r = await unplan([order])
    setToast(r)
    setBusy(false)
  }

  return (
    <div className="mx-auto max-w-[1600px] p-4 md:p-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Package} label="Orders" value={orders.length} />
        <Stat icon={Inbox} label="Unassigned" value={unassigned.length} tone={unassigned.length ? 'text-warning' : 'text-foreground'} />
        <Stat icon={CheckCircle2} label="Planned" value={plannedCount} tone={plannedCount ? 'text-success' : 'text-foreground'} />
        <Stat icon={Layers} label="Loads" value={lanes.length} />
      </div>

      {toast && (
        <div
          className={cn(
            'mt-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm animate-slide-up',
            toast.ok ? 'border-success/30 bg-success/10 text-success' : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          {toast.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          {toast.message}
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* Unassigned queue */}
        <section className="flex max-h-[calc(100dvh-220px)] flex-col rounded-xl border border-border bg-card shadow-soft">
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
                <span className="grid h-11 w-11 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Inbox className="h-5 w-5" />
                </span>
                <p className="text-sm text-muted-foreground">Nothing waiting. {orders.length === 0 ? 'Create an order to begin.' : 'All orders are planned.'}</p>
                {orders.length === 0 && (
                  <Link to="/build"><Button size="sm" variant="primary" className="mt-1">Create order</Button></Link>
                )}
              </div>
            )}
            {unassigned.map((o) => {
              const checked = sel.has(o.stopNbr)
              return (
                <button
                  key={o.stopNbr}
                  type="button"
                  onClick={() => toggle(o.stopNbr)}
                  className={cn(
                    'focus-ring flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                    checked ? 'border-primary/50 bg-primary/10' : 'border-transparent hover:bg-accent',
                  )}
                >
                  <span className={cn('mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong')}>
                    {checked && <CheckCircle2 className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{o.name || o.stopNbr}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {o.city ? `${o.city}${o.state ? ', ' + o.state : ''} · ` : ''}{o.stopNbr}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>

          {/* Plan action */}
          <div className="space-y-2 border-t border-border p-3">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="focus-ring h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm text-foreground"
            >
              <option value="">Plan onto load…</option>
              {lanes.map((l) => (
                <option key={l.loadNbr} value={l.loadNbr}>{l.name} · {l.loadNbr}</option>
              ))}
            </select>
            <Button variant="primary" className="w-full" disabled={busy || !sel.size || !target} onClick={doPlan}>
              {busy ? 'Working…' : <>Plan {sel.size || ''} <ArrowRight className="h-4 w-4" /></>}
            </Button>
          </div>
        </section>

        {/* Load lanes */}
        <section className="grid auto-rows-min gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {lanes.map((lane) => (
            <div key={lane.loadNbr} className="flex flex-col rounded-xl border border-border bg-card shadow-soft">
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <Truck className="h-4 w-4" strokeWidth={1.9} />
                  </span>
                  <div className="min-w-0 leading-tight">
                    <div className="truncate text-sm font-semibold text-foreground">{lane.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{lane.loadNbr}</div>
                  </div>
                </div>
                <Badge tone={lane.planned.length ? 'primary' : 'neutral'}>{lane.planned.length}</Badge>
              </div>

              <div className="min-h-[72px] space-y-1.5 p-2">
                {lane.planned.length === 0 && (
                  <div className="px-3 py-5 text-center text-xs text-muted-foreground">Empty — select orders → plan onto this load.</div>
                )}
                {lane.planned.map((o) => (
                  <div key={o.stopNbr} className="group flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{o.name || o.stopNbr}</span>
                      <span className="block truncate text-xs text-muted-foreground">{o.stopNbr}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => doUnplan(o)}
                      disabled={busy}
                      title="Unplan"
                      className="focus-ring grid h-7 w-7 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100 disabled:opacity-30"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
