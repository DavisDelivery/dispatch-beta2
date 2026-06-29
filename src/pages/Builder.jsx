// Builder — the write playground (separately-authorized write-back phase).
//
// Two tools, both LIVE against UAT via the gated nuvizz-write function:
//   1. Create order(s)  -> POST /stop/sync/update
//   2. Load assembly     -> add (insertstops) / remove (load/edit) stops on a load
//
// Credentials are entered here and held only in the browser (sessionStorage);
// they are never bundled or stored on the server. The function forwards them.

import { useEffect, useState } from 'react'
import {
  buildStopPayload,
  createOrder,
  getLoad,
  insertStops,
  removeStops,
  getStop,
  summarize,
  normalizeLoad,
  normalizeStop,
} from '../lib/nuvizzWrite.js'
import { useCreatedOrders } from '../hooks/useCreatedOrders.js'

const SETTINGS_KEY = 'dd_write_settings'

const load = (k, fallback) => {
  try {
    return { ...fallback, ...JSON.parse(sessionStorage.getItem(k) || '{}') }
  } catch {
    return fallback
  }
}
const save = (k, v) => {
  try {
    sessionStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10)

const blankOrder = () => ({
  name: '',
  addr1: '',
  addr2: '',
  city: '',
  state: '',
  zip: '',
  pro: '',
  pallets: '',
  cartons: '',
  weight: '',
  stopNbr: '',
})

// Compact TSV/CSV parser for bulk paste (header optional; falls back to column order).
const COLS = ['name', 'addr1', 'addr2', 'city', 'state', 'zip', 'pro', 'pallets', 'cartons', 'weight', 'stopNbr']
// Ordered header rules (first match wins) — robust to the Davis export layout
// ("Ship To Name", "Ship To - Address Line 1", "Stop Number", "Shipment Number",
// "Skids", "Loose", "Stop Weight", "Zip Code") AND simple hand-typed headers.
// Consignee ("Ship To") address only — "Ship From" (origin) columns are ignored.
const HEADER_RULES = [
  ['stopNbr', /^stop\s*(number|nbr|no|#)|^stop$|stop\s*#/],
  ['pro', /shipment\s*(number|nbr|#)|^pro\b|^pro#|tracking/],
  ['name', /ship\s*to\s*name|consignee|^name$|customer\s*name/],
  ['addr2', /ship\s*to.*(address.*(line\s*)?2|addr.*2)|^addr2$|^address\s*2|suite|^ste$|^unit$/],
  ['addr1', /ship\s*to.*(address.*(line\s*)?1?|addr)|^addr1$|^address\s*1?$|^street$/],
  ['city', /ship\s*to.*city|^city$/],
  ['state', /ship\s*to.*state|^state$|^st$/],
  ['zip', /zip|postal/],
  ['pallets', /skid|pallet|^plt$/],
  ['cartons', /loose|carton|^ctn$|cases/],
  ['weight', /weight|^wt$|lbs/],
]
const headerToKey = (h) => {
  const n = h.trim().toLowerCase()
  if (!n || /ship\s*from/.test(n) || /uom|sequence|signature|stop\s*type|volume|product|price|email|customer\s*number|confirmation|dttm|^comments?$/.test(n)) {
    // explicitly-ignored columns (incl. Ship From origin + non-order metadata)
    if (!/ship\s*to/.test(n)) return null
  }
  const hit = HEADER_RULES.find(([, re]) => re.test(n))
  return hit ? hit[0] : null
}
function parseDelimited(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '')
  if (!lines.length) return []
  const delim = lines[0].includes('\t') ? '\t' : ','
  const split = (l) => l.split(delim).map((c) => c.trim())
  const header = split(lines[0]).map(headerToKey)
  const hasHeader = header.some(Boolean)
  const keys = hasHeader ? header : COLS
  return (hasHeader ? lines.slice(1) : lines).map((l) => {
    const cells = split(l)
    const row = blankOrder()
    keys.forEach((k, i) => {
      if (k && cells[i] != null) row[k] = cells[i]
    })
    return row
  })
}

function SettingsBar({ settings, setSettings }) {
  const set = (k) => (e) => setSettings((p) => ({ ...p, [k]: e.target.value }))
  return (
    <details className="card wb-card">
      <summary className="wb-card__title">Pickup origin &amp; delivery date (applied to created orders)</summary>
      <div className="wb-grid wb-grid--4" style={{ marginTop: 10 }}>
        <label className="wb-field"><span>Pickup name</span><input value={settings.originName} onChange={set('originName')} /></label>
        <label className="wb-field"><span>Pickup addr1</span><input value={settings.originAddr1} onChange={set('originAddr1')} /></label>
        <label className="wb-field"><span>Pickup city</span><input value={settings.originCity} onChange={set('originCity')} /></label>
        <label className="wb-field"><span>ST / Zip</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <input value={settings.originState} onChange={set('originState')} style={{ width: '40%' }} />
            <input value={settings.originZip} onChange={set('originZip')} style={{ width: '60%' }} />
          </span>
        </label>
        <label className="wb-field"><span>Delivery date</span><input type="date" value={settings.serviceDate} onChange={set('serviceDate')} /></label>
        <label className="wb-field"><span>Weight UOM</span><input value={settings.weightUOM} onChange={set('weightUOM')} /></label>
      </div>
    </details>
  )
}

function CreateOrders({ creds, settings, canWrite, onCreated }) {
  const [rows, setRows] = useState([blankOrder()])
  const [paste, setPaste] = useState('')
  const [results, setResults] = useState({})
  const [busy, setBusy] = useState(false)

  const setCell = (i, k, v) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)))
  const addRow = () => setRows((rs) => [...rs, blankOrder()])
  const delRow = (i) => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs))
  const doParse = () => {
    const parsed = parseDelimited(paste)
    if (parsed.length) {
      setRows(parsed)
      setResults({})
      setPaste('')
    }
  }

  const valid = (r) => r.name && r.addr1 && r.city && r.state && r.zip
  const allValid = rows.every(valid)

  const createAll = async () => {
    setBusy(true)
    setResults({})
    for (let i = 0; i < rows.length; i++) {
      try {
        const stop = buildStopPayload({ ...rows[i], _seq: `${Date.now()}-${i}` }, settings)
        const resp = await createOrder(creds, stop)
        const s = summarize(resp)
        setResults((p) => ({ ...p, [i]: { ok: s.ok, msg: s.ok ? `created · ${s.entityNbr || ''}` : s.message, stopId: s.entityId } }))
        if (s.ok && s.entityNbr) {
          onCreated({
            stopNbr: s.entityNbr,
            stopId: s.entityId,
            name: rows[i].name,
            addr1: rows[i].addr1,
            city: rows[i].city,
            state: rows[i].state,
            zip: rows[i].zip,
            pallets: rows[i].pallets,
            cartons: rows[i].cartons,
            weight: rows[i].weight,
          })
        }
      } catch (err) {
        setResults((p) => ({ ...p, [i]: { ok: false, msg: err.message } }))
      }
    }
    setBusy(false)
  }

  return (
    <div className="card wb-card">
      <h2 className="wb-card__title">Create orders</h2>
      <textarea
        className="wb-paste"
        rows="3"
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        placeholder="Paste rows from a spreadsheet (name, addr1, addr2, city, state, zip, pro, pallets, cartons, weight)…"
      />
      <div className="wb-row">
        <button className="wb-btn" onClick={doParse} disabled={!paste.trim()}>
          Parse paste
        </button>
        <button className="wb-btn" onClick={addRow}>+ Row</button>
      </div>

      <div className="wb-tbl-wrap">
        <table className="wb-tbl">
          <thead>
            <tr>
              <th></th>
              <th>Consignee</th><th>Addr1</th><th>Addr2</th><th>City</th><th>ST</th><th>Zip</th>
              <th>PRO</th><th>Plt</th><th>Ctn</th><th>Wt</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const res = results[i]
              return (
                <tr key={i}>
                  <td><button className="wb-x" title="remove row" onClick={() => delRow(i)}>×</button></td>
                  {['name', 'addr1', 'addr2', 'city', 'state', 'zip', 'pro', 'pallets', 'cartons', 'weight'].map((k) => (
                    <td key={k} className={!valid(r) && ['name', 'addr1', 'city', 'state', 'zip'].includes(k) && !r[k] ? 'wb-bad' : ''}>
                      <input value={r[k] || ''} onChange={(e) => setCell(i, k, e.target.value)} />
                    </td>
                  ))}
                  <td className="wb-st">
                    {!res && <span className="wb-pill">—</span>}
                    {res && <span className={`wb-pill ${res.ok ? 'wb-pill--ok' : 'wb-pill--err'}`} title={res.stopId || ''}>{res.msg}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="wb-row">
        <button className="wb-btn wb-btn--pri" onClick={createAll} disabled={busy || !canWrite || !allValid}>
          {busy ? 'Creating…' : `Create ${rows.length} order${rows.length > 1 ? 's' : ''}`}
        </button>
        {!allValid && <span className="wb-hint">Fill consignee, addr1, city, state, zip for every row.</span>}
      </div>
    </div>
  )
}

function LoadAssembly({ creds, canWrite }) {
  const [loadNbr, setLoadNbr] = useState('')
  const [loadView, setLoadView] = useState(null)
  const [addStopNbr, setAddStopNbr] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (nbr = loadNbr) => {
    if (!nbr) return
    setBusy(true)
    setMsg(null)
    try {
      const resp = await getLoad(creds, nbr)
      const norm = normalizeLoad(resp)
      if (!norm.loadId) {
        setLoadView(null)
        setMsg({ ok: false, text: `Load ${nbr} not found` })
      } else {
        setLoadView(norm)
      }
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    }
    setBusy(false)
  }

  const doAdd = async () => {
    if (!loadView || !addStopNbr.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      // resolve stopNbr -> stopId via a read (insertstops needs stopId)
      const sResp = await getStop(creds, addStopNbr.trim())
      const s = normalizeStop(sResp)
      if (!s.stopId) throw new Error(`Stop ${addStopNbr} not found`)
      const resp = await insertStops(creds, loadView.loadId, [s.stopId])
      const sum = summarize(resp)
      setMsg(sum.ok ? { ok: true, text: `Added ${s.stopNbr}` } : { ok: false, text: sum.message })
      setAddStopNbr('')
      await refresh()
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    }
    setBusy(false)
  }

  const doRemove = async (stopId, stopNbr) => {
    setBusy(true)
    setMsg(null)
    try {
      const resp = await removeStops(creds, loadView.loadNbr, [stopId])
      const sum = summarize(resp)
      setMsg(sum.ok ? { ok: true, text: `Removed ${stopNbr}` } : { ok: false, text: sum.message })
      await refresh()
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    }
    setBusy(false)
  }

  const cancelled = loadView && String(loadView.status) === '99'

  return (
    <div className="card wb-card">
      <h2 className="wb-card__title">Load assembly</h2>
      <div className="wb-row">
        <input
          className="wb-inp"
          value={loadNbr}
          onChange={(e) => setLoadNbr(e.target.value)}
          placeholder="Load # (e.g. LOAD000112122)"
          onKeyDown={(e) => e.key === 'Enter' && refresh()}
        />
        <button className="wb-btn" onClick={() => refresh()} disabled={busy || !loadNbr.trim()}>
          Load
        </button>
      </div>

      {msg && <p className={`wb-msg ${msg.ok ? 'wb-msg--ok' : 'wb-msg--err'}`}>{msg.text}</p>}

      {loadView && (
        <div className="wb-load">
          <div className="wb-load__head">
            <strong>{loadView.routeName || loadView.loadNbr}</strong>
            <span className="wb-hint"> · {loadView.loadNbr} · {loadView.stops.length} stop(s)</span>
            {cancelled && <span className="wb-pill wb-pill--err">Cancelled (99) — can’t add</span>}
          </div>
          <ul className="wb-stoplist">
            {loadView.stops.map((s) => (
              <li key={s.stopId} className="wb-stop">
                <span className="wb-stop__seq">{s.stopSeq ?? '—'}</span>
                <span className="wb-stop__nbr">{s.stopNbr}</span>
                <button className="wb-btn wb-btn--sm" onClick={() => doRemove(s.stopId, s.stopNbr)} disabled={busy || !canWrite}>
                  Unplan
                </button>
              </li>
            ))}
            {loadView.stops.length === 0 && <li className="wb-hint">No stops on this load.</li>}
          </ul>
          <div className="wb-row">
            <input
              className="wb-inp"
              value={addStopNbr}
              onChange={(e) => setAddStopNbr(e.target.value)}
              placeholder="Stop # to add (e.g. 1706264_023)"
              onKeyDown={(e) => e.key === 'Enter' && doAdd()}
            />
            <button className="wb-btn wb-btn--pri" onClick={doAdd} disabled={busy || !canWrite || cancelled || !addStopNbr.trim()}>
              Add to load
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Running list of orders we've created in UAT (localStorage registry). This is
// the same list the Routing screen reads to plan/unplan, so it's the canonical
// record of "orders we created".
function CreatedOrdersPanel({ orders, remove, clear }) {
  return (
    <div className="card wb-card">
      <h2 className="wb-card__title">
        Created orders <span className="wb-hint">({orders.length})</span>
        {orders.length > 0 && (
          <button className="wb-btn wb-btn--sm" style={{ float: 'right' }} onClick={clear}>
            Clear all
          </button>
        )}
      </h2>
      {orders.length === 0 ? (
        <p className="wb-hint">Orders you create are tracked here, then planned onto loads from the Routing screen.</p>
      ) : (
        <div className="wb-tbl-wrap">
          <table className="wb-tbl">
            <thead>
              <tr>
                <th>Stop #</th><th>Consignee</th><th>City</th><th>ST</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.stopNbr}>
                  <td className="wb-stop__nbr">{o.stopNbr}</td>
                  <td>{o.name || '—'}</td>
                  <td>{o.city || ''}</td>
                  <td>{o.state || ''}</td>
                  <td className="wb-st">
                    {o.plannedLoadNbr ? (
                      <span className="wb-pill wb-pill--ok" title={o.plannedLoadNbr}>on {o.plannedLoadNbr}</span>
                    ) : (
                      <span className="wb-pill">unplanned</span>
                    )}
                  </td>
                  <td><button className="wb-x" title="forget this order" onClick={() => remove(o.stopNbr)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function Builder() {
  const { orders, add, remove, clear } = useCreatedOrders()
  // Credentials now come from server env (UAT) — the UI no longer collects them.
  const creds = {}
  const canWrite = true
  const [settings, setSettings] = useState(() =>
    load(SETTINGS_KEY, {
      originName: 'ULINEUAT',
      originAddr1: '943 GAINESVILLE HIGHWAY',
      originCity: 'BUFORD',
      originState: 'GA',
      originZip: '30518',
      serviceDate: tomorrow(),
      weightUOM: 'LBS',
    }),
  )

  useEffect(() => save(SETTINGS_KEY, settings), [settings])

  return (
    <section className="page page--builder">
      <div className="wb-head">
        <h1 className="page__title">
          Builder <span className="pill pill--write">Live write · UAT</span>
        </h1>
        <p className="wb-warn">
          ⚠ These actions write to live NuVizz (UAT). Create orders and add/remove stops on a load.
        </p>
      </div>

      <SettingsBar settings={settings} setSettings={setSettings} />
      <CreateOrders creds={creds} settings={settings} canWrite={canWrite} onCreated={add} />
      <CreatedOrdersPanel orders={orders} remove={remove} clear={clear} />
      <LoadAssembly creds={creds} canWrite={canWrite} />
    </section>
  )
}
