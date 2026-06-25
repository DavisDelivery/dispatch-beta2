// Shared UAT write credentials, held only in the browser tab (sessionStorage)
// under the same key the Builder page uses, so creds entered on either surface
// carry over. Never bundled or stored server-side.

import { useCallback, useMemo, useState } from 'react'

const CREDS_KEY = 'dd_write_creds'
const DEFAULTS = { companyCode: 'DAVISV5', username: '', password: '' }

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(sessionStorage.getItem(CREDS_KEY) || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

export function useWriteCreds() {
  const [creds, setCredsState] = useState(load)

  const setCreds = useCallback((next) => {
    setCredsState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next
      try {
        sessionStorage.setItem(CREDS_KEY, JSON.stringify(value))
      } catch {
        /* sessionStorage unavailable (private mode) — keep in-memory only */
      }
      return value
    })
  }, [])

  const canWrite = useMemo(
    () => Boolean(creds.companyCode && creds.username && creds.password),
    [creds],
  )

  return { creds, setCreds, canWrite }
}
