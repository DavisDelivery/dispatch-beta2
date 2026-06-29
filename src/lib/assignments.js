// Load → driver assignments, server-backed (Netlify Blobs via /assignments) so
// they sync across devices. localStorage is a mirror for instant render + offline;
// a change updates the mirror optimistically, then POSTs and reconciles to the
// server's canonical map. A 'dd-assignments' window event fires on every change.

const KEY = 'dd_load_drivers'
const EVENT = 'dd-assignments'
const URL = '/.netlify/functions/assignments'

function readLocal() {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) || '{}')
    return m && typeof m === 'object' ? m : {}
  } catch {
    return {}
  }
}

let cache = readLocal()

function setCache(map) {
  cache = map && typeof map === 'object' ? map : {}
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVENT))
}

export function getAssignments() {
  return cache
}

export async function refreshAssignments() {
  try {
    const res = await fetch(URL)
    if (res.ok) {
      const d = await res.json()
      if (d.assignments) setCache(d.assignments)
    }
  } catch {
    /* offline */
  }
}

export function assignDriver(loadNbr, driverUserName) {
  if (!loadNbr) return
  const next = { ...cache }
  if (driverUserName) next[loadNbr] = driverUserName
  else delete next[loadNbr]
  setCache(next) // optimistic
  ;(async () => {
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loadNbr, driverUserName: driverUserName || '' }),
      })
      if (res.ok) {
        const d = await res.json()
        if (d.assignments) setCache(d.assignments)
      }
    } catch {
      /* offline — keep optimistic */
    }
  })()
}

export const ASSIGNMENTS_EVENT = EVENT
