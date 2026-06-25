// Presentational action bar for map-driven plan/unplan. Shows the current
// selection tally, a typeable target-load field (datalist of known loads, but
// any UAT load number can be entered), and Plan / Unplan buttons wired to the
// gated NuVizz write function (UAT only). Credentials are entered here when
// missing and shared with the Builder page (sessionStorage). No write logic here.

const fmtWeight = (n) => (n ? `${n.toLocaleString()} lb` : '0 lb')

export default function PlanBar({
  count,
  tally,
  loads,
  targetLoad,
  setTargetLoad,
  onPlan,
  onUnplan,
  onClear,
  busy,
  msg,
  msgOk,
  creds,
  setCreds,
  canWrite,
}) {
  const set = (k) => (e) => setCreds((p) => ({ ...p, [k]: e.target.value }))
  const canPlan = canWrite && count > 0 && Boolean(targetLoad.trim()) && !busy
  const canUnplan = canWrite && count > 0 && !busy

  return (
    <div className="planbar">
      <div className="planbar__head">
        <span className="planbar__title">Plan {count} selected</span>
        <button type="button" className="wb-btn wb-btn--sm planbar__clear" onClick={onClear} disabled={!count || busy}>
          Clear
        </button>
      </div>

      <div className="planbar__tally">
        <span>Skids <b>{tally.skids}</b></span>
        <span>Loose <b>{tally.pieces}</b></span>
        <span>Weight <b>{fmtWeight(tally.weight)}</b></span>
      </div>

      {!canWrite && (
        <div className="planbar__creds">
          <label>
            <span>Company</span>
            <input value={creds.companyCode} onChange={set('companyCode')} autoComplete="off" />
          </label>
          <label>
            <span>Username</span>
            <input value={creds.username} onChange={set('username')} autoComplete="off" />
          </label>
          <label>
            <span>Password</span>
            <input type="password" value={creds.password} onChange={set('password')} autoComplete="off" />
          </label>
          <p className="planbar__creds-note">Held only in this browser tab — UAT tenant only.</p>
        </div>
      )}

      <label className="planbar__target">
        <span>Target load #</span>
        <input
          list="planbar-loads"
          value={targetLoad}
          onChange={(e) => setTargetLoad(e.target.value)}
          placeholder="e.g. LOAD000112225"
          autoComplete="off"
          disabled={busy}
        />
        <datalist id="planbar-loads">
          {loads.map((l) => (
            <option key={l.loadNbr} value={l.loadNbr}>
              {l.routeName || l.loadNbr}
              {l.driverUserName ? ` · ${l.driverUserName}` : ''}
            </option>
          ))}
        </datalist>
      </label>

      <div className="planbar__actions">
        <button type="button" className="wb-btn wb-btn--pri" onClick={onPlan} disabled={!canPlan} title={targetLoad ? `Add to ${targetLoad}` : 'Enter a target load #'}>
          {busy ? 'Working…' : 'Plan →'}
        </button>
        <button type="button" className="wb-btn" onClick={onUnplan} disabled={!canUnplan} title="Remove selected stops from their current load">
          Unplan
        </button>
      </div>

      {!canWrite && <p className="wb-msg wb-msg--err">Enter UAT credentials to enable plan/unplan.</p>}
      {msg && <p className={`wb-msg ${msgOk ? 'wb-msg--ok' : 'wb-msg--err'}`}>{msg}</p>}
    </div>
  )
}
