// DateNav — a slim, mobile-friendly date bar rendered below the topbar.
// Shows: ‹ Prev | "Thu · Jun 11, 2026" label | Next ›
// Also: a native <input type="date"> to jump to any day, and a "Today" button
// (only when not viewing today).
//
// Tap targets are >= 44px (var(--tap)). Uses the dark design tokens.

import { useSelectedDate } from '../hooks/useSelectedDate.js'
import { prevBusinessDay, nextBusinessDay, todayISO } from '../lib/dateNav.js'
import { formatDate } from '../lib/format.js'

// Short weekday names indexed by getUTCDay() (0=Sun…6=Sat).
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function weekdayLabel(iso) {
  const d = new Date(iso + 'T12:00:00Z')
  return WEEKDAYS[d.getUTCDay()]
}

export default function DateNav() {
  const { date, isToday, setDate } = useSelectedDate()

  const label = `${weekdayLabel(date)} · ${formatDate(date + 'T12:00:00Z')}`

  return (
    <div className="datenav" aria-label="Date selector">
      <button
        type="button"
        className="datenav__step"
        aria-label="Previous business day"
        onClick={() => setDate(prevBusinessDay(date))}
      >
        ‹
      </button>

      <div className="datenav__center">
        <span className="datenav__label">{label}</span>
        <input
          type="date"
          className="datenav__input"
          value={date}
          aria-label="Jump to date"
          onChange={(e) => {
            if (e.target.value) setDate(e.target.value)
          }}
        />
      </div>

      <div className="datenav__right">
        {!isToday && (
          <button
            type="button"
            className="datenav__today"
            onClick={() => setDate(todayISO())}
          >
            Today
          </button>
        )}
        <button
          type="button"
          className="datenav__step"
          aria-label="Next business day"
          onClick={() => setDate(nextBusinessDay(date))}
        >
          ›
        </button>
      </div>
    </div>
  )
}
