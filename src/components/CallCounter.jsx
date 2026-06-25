// NuVizz API call-counter pill (modeled on davis-nuvizz's "calls / ceiling (mode)").
// Reads the Blobs-backed counter from /.netlify/functions/nuvizz-ops — that endpoint
// never calls NuVizz, so polling it is free. Refetches whenever a write happens
// (the 'dd-api-call' event from nuvizzWrite) plus a slow idle poll.

import { useCallback, useEffect, useState } from 'react'

const OPS_URL = '/.netlify/functions/nuvizz-ops'

export default function CallCounter() {
  const [ops, setOps] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(OPS_URL, { headers: { Accept: 'application/json' } })
      if (res.ok) setOps(await res.json())
    } catch {
      /* offline / not deployed — hide */
    }
  }, [])

  useEffect(() => {
    refresh()
    const onCall = () => {
      // give the server a beat to finish the read-modify-write
      setTimeout(refresh, 400)
    }
    window.addEventListener('dd-api-call', onCall)
    const id = setInterval(refresh, 60000)
    return () => {
      window.removeEventListener('dd-api-call', onCall)
      clearInterval(id)
    }
  }, [refresh])

  if (!ops) return null
  const used = ops.dayCount || 0
  const ceiling = ops.ceiling || 0
  const pct = ceiling ? Math.min(100, Math.round((used / ceiling) * 100)) : 0
  const tone = pct >= 85 ? 'is-red' : pct >= 60 ? 'is-amber' : 'is-green'
  const routes = ops.byRoute
    ? Object.entries(ops.byRoute).map(([k, v]) => `${k}: ${v}`).join(' · ')
    : ''

  return (
    <span
      className={`callcounter ${tone}`}
      title={`Today's NuVizz API calls (${ops.mode})${routes ? ' — ' + routes : ''}`}
    >
      API <strong>{used.toLocaleString()}</strong>
      {ceiling ? <span className="callcounter__cap"> / {ceiling.toLocaleString()}</span> : null}
      <span className="callcounter__mode">{ops.mode}{ops.breaker ? ', halted' : ''}</span>
    </span>
  )
}
