// M5 — centralized "today" + date helpers. All "today" checks across the app
// go through these so we never scatter `new Date().toISOString().slice(0,10)`
// (which is UTC and wrong overnight: at 1am ET, UTC is already tomorrow).
//
// Buford GA is America/New_York. We derive the ET calendar date using
// Intl.DateTimeFormat with timeZone, which honors DST automatically.

const ET_TZ = 'America/New_York';

// "YYYY-MM-DD" for the current calendar day in America/New_York.
export function todayInET() {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape NuVizz wants.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// True if the given "YYYY-MM-DD" string is today in ET.
export function isTodayET(dateString) {
  return dateString === todayInET();
}

// Human label for a "YYYY-MM-DD" date. Returns "Today" when it is today,
// otherwise "Mon, May 25, 2026". Parsed as a local-noon date to dodge
// timezone-rollover when formatting the day-of-week.
export function formatDateForDisplay(dateString) {
  if (!dateString) return '';
  if (isTodayET(dateString)) return 'Today';
  return formatDateLong(dateString);
}

// "Mon, May 25, 2026" — always the long form, even when today. Used where we
// want the explicit date alongside a "Today" chip.
export function formatDateLong(dateString) {
  if (!dateString) return '';
  const [y, m, d] = dateString.split('-').map(Number);
  if (!y || !m || !d) return dateString;
  // Construct at local noon so DST/UTC never shifts the weekday.
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(dt);
}
