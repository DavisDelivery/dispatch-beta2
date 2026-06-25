// Presentational action bar for the Map's Plan mode. Shows the current selection
// tally, a target-load picker, and Plan / Unplan buttons wired to the gated
// NuVizz write function (UAT only). Credentials are entered here when missing and
// shared with the Builder page (sessionStorage). No write logic lives here.

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
  isMock,
}) {
  const set = (k) => (e) => setCreds((p) => ({ ...p, [k]: e.target.value }))
  const target = loads.find((l) => l.loadNbr === targetLoad)
  const canPlan = canWrite && !isMock && count > 0 && Boolean(target?.loadId) && !busy
  const canUnplan = canWrite && !isMock && count > 0 && !busy

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

      <div className="planbar__actions">
        <div className="control control--select planbar__load">
          <select
            value={targetLoad}
            onChange={(e) => setTargetLoad(e.target.value)}
            aria-label="Target load to plan into"
            disabled={busy}
          >
            <option value="">Plan onto load…</option>
            {loads.map((l) => (
              <option key={l.loadNbr} value={l.loadNbr}>
                {l.routeName || l.loadNbr}
                {l.driverUserName ? ` · ${l.driverUserName}` : ''}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="wb-btn wb-btn--pri" onClick={onPlan} disabled={!canPlan} title={target ? `Add to ${target.routeName || target.loadNbr}` : 'Pick a target load'}>
          {busy ? 'Working…' : 'Plan →'}
        </button>
        <button type="button" className="wb-btn" onClick={onUnplan} disabled={!canUnplan} title="Remove selected stops from their current load">
          Unplan
        </button>
      </div>

      {isMock && <p className="wb-msg wb-msg--err">Mock data — connect to live NuVizz to plan/unplan.</p>}
      {!isMock && !canWrite && <p className="wb-msg wb-msg--err">Enter UAT credentials to enable plan/unplan.</p>}
      {msg && <p className={`wb-msg ${msgOk ? 'wb-msg--ok' : 'wb-msg--err'}`}>{msg}</p>}
    </div>
  )
}
