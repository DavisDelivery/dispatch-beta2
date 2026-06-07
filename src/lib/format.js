// Date + value formatting helpers.
//
// UI DATE RULES (hard convention — see ORCHESTRATION.md):
//   - "Jul 2025"      when no day is needed
//   - "Jul 14, 2025"  when a day is needed
//   - Always 4-digit years.
//   - NEVER ISO (2025-07-14) and NEVER bare numeric (7/14).

function toDate(value) {
  if (value == null || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

const monthYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
})

const dayMonthYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

// "Jul 2025"
export function formatMonthYear(value, fallback = '—') {
  const d = toDate(value)
  return d ? monthYear.format(d) : fallback
}

// "Jul 14, 2025"
export function formatDate(value, fallback = '—') {
  const d = toDate(value)
  return d ? dayMonthYear.format(d) : fallback
}

// Time of day, 12h short form: "7:05a" / "3:30p". Accepts a Date, a timestamp
// (ms), or an ISO string.
export function formatTime(value, fallback = '—') {
  const d = toDate(value)
  if (!d) return fallback
  const h = d.getHours()
  const m = d.getMinutes()
  const suffix = h < 12 ? 'a' : 'p'
  let h12 = h % 12
  if (h12 === 0) h12 = 12
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`
}

// Numbers: render with thousands separators; blanks stay blank.
export function formatNumber(value, fallback = '—') {
  if (value == null || value === '') return fallback
  const n = Number(value)
  return Number.isNaN(n) ? String(value) : n.toLocaleString('en-US')
}

// Plain text passthrough with an em-dash for empties so columns never look broken.
export function formatText(value, fallback = '—') {
  if (value == null || value === '') return fallback
  return String(value)
}
