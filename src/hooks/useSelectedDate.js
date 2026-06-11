// useSelectedDate — reads / writes the ?date=YYYY-MM-DD search param via
// react-router useSearchParams. When ?date is absent or invalid, defaults to
// today and keeps the URL clean.
//
// Returns: { date: 'YYYY-MM-DD', isToday: boolean, setDate(iso) }

import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { todayISO, isValidISO } from '../lib/dateNav.js'

export function useSelectedDate() {
  const [params, setParams] = useSearchParams()

  const today = todayISO()
  const raw = params.get('date')
  const date = raw && isValidISO(raw) ? raw : today
  const isToday = date === today

  const setDate = useCallback(
    (iso) => {
      const next = new URLSearchParams(params)
      if (iso === todayISO()) {
        // Keep URLs clean: omit the param when selecting today.
        next.delete('date')
      } else {
        next.set('date', iso)
      }
      setParams(next, { replace: true })
    },
    [params, setParams],
  )

  return { date, isToday, setDate }
}
