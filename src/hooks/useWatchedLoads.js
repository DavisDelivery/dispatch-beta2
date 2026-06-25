// The Routing board's watchlist: the set of UAT load numbers we're working with.
// Persisted in localStorage (dd_watched_loads) so it survives reloads. Loads are
// read live via the write function's getLoad — no scan, no read-fn dependency.

import { useEffect, useState } from 'react'

const KEY = 'dd_watched_loads'
const EVENT = 'dd-watched-loads'

function read() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(arr) ? arr.filter(Boolean) : []
  } catch {
    return []
  }
}
function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* ignore */
  }
}

export function useWatchedLoads() {
  const [loads, setLoads] = useState(read)

  useEffect(() => {
    const sync = () => setLoads(read())
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  return {
    loads,
    watch: (nbr) => {
      const n = String(nbr || '').trim().toUpperCase()
      if (!n) return
      const cur = read()
      if (!cur.includes(n)) write([n, ...cur])
    },
    unwatch: (nbr) => write(read().filter((n) => n !== String(nbr).toUpperCase())),
  }
}
