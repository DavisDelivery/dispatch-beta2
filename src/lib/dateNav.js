// dateNav.js — Pure, side-effect-free date helpers for the date-selector feature.
//
// All date values are calendar-date strings in 'YYYY-MM-DD' format.
// UTC noon (T12:00:00Z) is used internally to avoid TZ/DST off-by-one when
// converting between a Date object and a date string.

// Build a Date at UTC noon for a given ISO calendar date.
function noon(iso) {
  return new Date(iso + 'T12:00:00Z')
}

// Format a Date back to 'YYYY-MM-DD' using UTC calendar fields.
function toISO(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Return today's local calendar date as 'YYYY-MM-DD'.
export function todayISO() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Return true if the given ISO date falls on a Saturday (6) or Sunday (0) in UTC.
export function isWeekend(iso) {
  const day = noon(iso).getUTCDay() // 0=Sun, 6=Sat
  return day === 0 || day === 6
}

// Add `n` calendar days to `iso` (n can be negative).
export function addDays(iso, n) {
  const d = noon(iso)
  d.setUTCDate(d.getUTCDate() + n)
  return toISO(d)
}

// Step back one business day from `iso` (skip Sat/Sun).
export function prevBusinessDay(iso) {
  let cur = addDays(iso, -1)
  while (isWeekend(cur)) {
    cur = addDays(cur, -1)
  }
  return cur
}

// Step forward one business day from `iso` (skip Sat/Sun).
export function nextBusinessDay(iso) {
  let cur = addDays(iso, 1)
  while (isWeekend(cur)) {
    cur = addDays(cur, 1)
  }
  return cur
}

// Validate that a string looks like a well-formed 'YYYY-MM-DD' date.
export function isValidISO(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false
  const d = noon(str)
  return !isNaN(d.getTime()) && toISO(d) === str
}
