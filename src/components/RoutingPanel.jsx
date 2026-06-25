// Right rail for the Routing page: Orders / Stops / Loads tabs.
//  - Orders: the created-orders registry (what we made in UAT); check to select
//    for planning. Shows planned/unplanned status.
//  - Stops: the current selection (orders + any map stops), with per-row remove.
//  - Loads: the day's loads; click one to set it as the Plan target.
// Presentational — all state lives in the Routing page.

import { useMemo } from 'react'
import { useSortableTable } from '../hooks/useSortableTable.js'
import SortableTh from './SortableTh.jsx'
import { stopKey } from '../lib/routingSelect.js'

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
        name: v.stop.name || '—',
        city: v.stop.city || '',
        skids: v.stop.totalPallets || 0,
        pcs: v.stop.totalCartons || 0,
        wt: v.stop.weight || 0,
      })),
    [stops],
  )
  const { sortedItems, sortKey, sortDirection, requestSort } = useSortableTable(rows, {
    initialKey: 'name',
    types: COL_TYPES,
  })

  if (!rows.length) return <p className="routing__empty">Nothing selected. Check orders (Orders tab) or click map stops.</p>

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
              <button type="button" className="routing__x" title="Remove from selection" onClick={() => onRemove(r.key)}>
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function LoadsList({ loads, targetLoad, setTargetLoad }) {
  if (!loads.length) return <p className="routing__empty">No loads listed for this day. Type the load # in the Target field.</p>
  return (
    <ul className="routing__loads">
      {loads.map((l) => (
        <li key={l.loadNbr}>
          <button
            type="button"
            className={`routing__load ${targetLoad === l.loadNbr ? 'is-target' : ''}`}
            onClick={() => setTargetLoad(targetLoad === l.loadNbr ? '' : l.loadNbr)}
            title="Set as the Plan target"
          >
            <span className="routing__load-name">{l.routeName || l.loadNbr}</span>
            <span className="routing__load-meta">
              {l.driverUserName || 'unassigned'}
              {typeof l.stopCount === 'number' ? ` · ${l.stopCount} stops` : ''}
            </span>
            {targetLoad === l.loadNbr && <span className="routing__load-target">target</span>}
          </button>
        </li>
      ))}
    </ul>
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
  loads,
  targetLoad,
  setTargetLoad,
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
          Loads <span className="filterchip__n">{loads.length}</span>
        </button>
      </div>
      <div className="routing__panel">
        {tab === 'orders' && <OrdersList orders={orders} selectedKeys={selectedKeys} onToggle={onToggleOrder} />}
        {tab === 'stops' && <StopsTable stops={stops} onRemove={onRemove} />}
        {tab === 'loads' && <LoadsList loads={loads} targetLoad={targetLoad} setTargetLoad={setTargetLoad} />}
      </div>
    </aside>
  )
}
