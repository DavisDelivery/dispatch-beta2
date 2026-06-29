// Live view of load → driver assignments. Server-backed (syncs across devices):
// refreshes on mount, window focus, and a slow interval; re-renders on local
// mutation via the 'dd-assignments' event.

import { useEffect, useState } from 'react'
import { getAssignments, assignDriver, refreshAssignments, ASSIGNMENTS_EVENT } from '../lib/assignments.js'

export function useAssignments() {
  const [assignments, setAssignments] = useState(getAssignments)

  useEffect(() => {
    const sync = () => setAssignments({ ...getAssignments() })
    window.addEventListener(ASSIGNMENTS_EVENT, sync)
    window.addEventListener('storage', sync)

    refreshAssignments()
    const onFocus = () => refreshAssignments()
    window.addEventListener('focus', onFocus)
    const id = setInterval(refreshAssignments, 20000)

    return () => {
      window.removeEventListener(ASSIGNMENTS_EVENT, sync)
      window.removeEventListener('storage', sync)
      window.removeEventListener('focus', onFocus)
      clearInterval(id)
    }
  }, [])

  return { assignments, assign: assignDriver }
}
