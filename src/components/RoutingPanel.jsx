// Right rail for the Routing page: Orders / Selected / Loads tabs.
//  - Orders:   the created-orders registry; check to select for planning.
//  - Selected: the current selection (orders + load stops), with per-row remove.
//  - Loads:    the watchlist — add a load #, see its live stops (getLoad/getStop);
//              check stops to unplan/move, click the header to set the Plan target.
// Presentational — all state lives in the Routing page.

import { useMemo } from 'react'
import { useSortableTable } from '../hooks/useSortableTable.js'
import SortableTh from './SortableTh.jsx'

const COL_TYPES = { name: 'text', city: 'text', skids: 'number', pcs: 'number', wt: 'number' }

function OrdersList({ orders, selectedKeys, onToggle }) {
  if (!orders.length)
    return <p className="routing__empty">No created orders yet. Make orders on the Builder screen — they appear here to plan.</p>
  return (
    <ul className="routing__orders">
      {orders.map((o) => {
        const key = `order|${o.stopNbr}`
        const checked = selectedKeys.has(key)
        return (
          <li key={o.stopNbr}>
            <label className={`routing__order ${checked ? 'is-sel' : ''}`}>
              <input type="checkbox" checked={checked} onChange={() => onToggle(key)} />
              <span className="routing__order-main">
                <span className="routing__order-name">{o.name || o.stopNbr}</span>
                <span className="routing__order-meta">
                  {o.stopNbr}
                  {o.city ? ` · ${o.city}${o.state ? ', ' + o.state : ''}` : ''}
                </span>
              </span>
              {o.plannedLoadNbr ? (
                <span className="routing__order-tag is-planned" title={o.plannedLoadNbr}>on {o.plannedLoadNbr}</span>
              ) : (
                <span className="routing__order-tag">unplanned</span>
              )}
            </label>
          </li>
        )
      })}
    </ul>
  )
}

function StopsTable({ stops, onRemove }) {
  const rows = useMemo(
    () =>
      stops.map((v) => ({
        key: v.key,
        name: v.stop.name || v.stop.stopNbr || '—',
        city: v.stop.city || '',
        skids: v.stop.totalPallets || 0,
        pcs: v.stop.totalCartons || 0,
        wt: v.stop.weight || 0,
      })),
    [stops],
  )
  const { sortedItems, sortKey, sortDirection, requestSort } = useSortableTable(rows, { initialKey: 'name', types: COL_TYPES })
  if (!rows.length) return <p className="routing__empty">Nothing selected. Check orders (Orders) or load stops (Loads).</p>
  return (
    <table className="routing__tbl">
      <thead>
        <tr>
          <SortableTh columnKey="name" label="Customer" sortKey={sortKey} sortDirection={sortDirection} onSort={requestSort} />
          <SortableTh columnKey="city" label="City" sortKey={sortKey} sortDirection={sortDirection} onSort={requestSort} />
          <SortableTh columnKey="skids" label="Skids" sortKey={sortKey} sortDirection={sortDirection} onSort={requestSort} align="right" />
          <SortableTh columnKey="pcs" label="Pcs" sortKey={sortKey} sortDirection={sortDirection} onSort={requestSort} align="right" />
          <SortableTh columnKey="wt" label="Wt" sortKey={sortKey} sortDirection={sortDirection} onSort={requestSort} align="right" />
          <th aria-label="Remove" />
        </tr>
      </thead>
      <tbody>
        {sortedItems.map((r) => (
          <tr key={r.key}>
            <td>{r.name}</td>
            <td>{r.city}</td>
            <td className="align-right">{r.skids}</td>
            <td className="align-right">{r.pcs}</td>
            <td className="align-right">{r.wt ? r.wt.toLocaleString() : ''}</td>
            <td className="align-right">
              <button type="button" className="routing__x" title="Remove from selection" onClick={() => onRemove(r.key)}>×</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function WatchList({ watchedLoads, watchInput, setWatchInput, onWatch, onUnwatch, selectedKeys, onToggleStop, targetLoad, setTargetLoad, loadStopKey }) {
  return (
    <div className="routing__watch">
      <div className="routing__watch-add">
        <input
          value={watchInput}
          onChange={(e) => setWatchInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onWatch()}
          placeholder="Watch a load # (e.g. LOAD000112225)"
          autoComplete="off"
        />
        <button type="button" className="wb-btn wb-btn--sm" onClick={onWatch} disabled={!watchInput.trim()}>Watch</button>
      </div>

      {watchedLoads.length === 0 && <p className="routing__empty">No loads watched. Add a UAT load # above to pull it onto the board.</p>}

      {watchedLoads.map((l) => {
        const isTarget = targetLoad === l.loadNbr
        return (
          <div key={l.loadNbr} className="routing__wload">
            <div className={`routing__wload-head ${isTarget ? 'is-target' : ''}`}>
              <button type="button" className="routing__wload-name" onClick={() => setTargetLoad(isTarget ? '' : l.loadNbr)} title="Set as Plan target">
                {l.routeName || l.loadNbr}
                <span className="routing__wload-sub">
                  {l.loadNbr}
                  {l.loading ? ' · loading…' : l.error ? ` · ${l.error}` : ` · ${(l.stops || []).length} stop(s)${l.status ? ' · ' + l.status : ''}`}
                  {isTarget ? ' · TARGET' : ''}
                </span>
              </button>
              <button type="button" className="routing__x" title="Stop watching" onClick={() => onUnwatch(l.loadNbr)}>×</button>
            </div>
            {(l.stops || []).length > 0 && (
              <ul className="routing__wstops">
                {l.stops.map((s) => {
                  const key = loadStopKey(l.loadNbr, s.stopNbr)
                  const checked = selectedKeys.has(key)
                  return (
                    <li key={s.stopNbr}>
                      <label className={`routing__wstop ${checked ? 'is-sel' : ''}`}>
                        <input type="checkbox" checked={checked} onChange={() => onToggleStop(key)} />
                        <span className="routing__wstop-seq">{s.stopSeq ?? '—'}</span>
                        <span className="routing__wstop-main">
                          <span>{s.name || s.stopNbr}</span>
                          {(s.city || s.stopNbr !== (s.name || s.stopNbr)) && <span className="routing__wstop-meta">{s.city ? `${s.city}${s.state ? ', ' + s.state : ''} · ` : ''}{s.stopNbr}</span>}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function RoutingPanel({
  tab,
  setTab,
  orders,
  selectedKeys,
  onToggleOrder,
  stops,
  onRemove,
  watchedLoads,
  watchInput,
  setWatchInput,
  onWatch,
  onUnwatch,
  onToggleStop,
  targetLoad,
  setTargetLoad,
  loadStopKey,
}) {
  return (
    <aside className="routing__rail">
      <div className="routing__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'orders'} className={`routing__tab ${tab === 'orders' ? 'is-active' : ''}`} onClick={() => setTab('orders')}>
          Orders <span className="filterchip__n">{orders.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'stops'} className={`routing__tab ${tab === 'stops' ? 'is-active' : ''}`} onClick={() => setTab('stops')}>
          Selected <span className="filterchip__n">{stops.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'loads'} className={`routing__tab ${tab === 'loads' ? 'is-active' : ''}`} onClick={() => setTab('loads')}>
          Loads <span className="filterchip__n">{watchedLoads.length}</span>
        </button>
      </div>
      <div className="routing__panel">
        {tab === 'orders' && <OrdersList orders={orders} selectedKeys={selectedKeys} onToggle={onToggleOrder} />}
        {tab === 'stops' && <StopsTable stops={stops} onRemove={onRemove} />}
        {tab === 'loads' && (
          <WatchList
            watchedLoads={watchedLoads}
            watchInput={watchInput}
            setWatchInput={setWatchInput}
            onWatch={onWatch}
            onUnwatch={onUnwatch}
            selectedKeys={selectedKeys}
            onToggleStop={onToggleStop}
            targetLoad={targetLoad}
            setTargetLoad={setTargetLoad}
            loadStopKey={loadStopKey}
          />
        )}
      </div>
    </aside>
  )
}
