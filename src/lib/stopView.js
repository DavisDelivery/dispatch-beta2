// Presentation helpers for a flattened stop — the bridge between the raw NuVizz
// stop record and the Stops page / Loads detail drawer. Sorting/filtering both
// key off the view object this builds, so the two surfaces stay consistent.

import {
  parseStopComments,
  activeChips,
  isPlaceholderWindow,
  fmt12h,
  fmtReceivingHours,
} from './parseStopComments.ts'

// Non-Uline revenue: the parsed TOTAL-AMOUNT if present, else the SealNbr read as
// currency (only when the seal is a bare numeric value — "145.00", not "SL-90021").
function sealAsCurrency(sealNbr) {
  if (sealNbr == null) return null
  const raw = String(sealNbr).trim()
  if (!/^\$?\d+(\.\d+)?$/.test(raw)) return null
  const n = Number(raw.replace(/[^0-9.]/g, ''))
  return Number.isNaN(n) ? null : n
}

export function nonUlineRevenue(stop, parsed) {
  if (parsed && parsed.totalAmount != null) return parsed.totalAmount
  return sealAsCurrency(stop.sealNbr)
}

export function formatUSD(n) {
  if (n == null) return ''
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

// Appointment reality. Placeholder windows render as a muted "no appt".
export function apptDisplay(stop) {
  if (isPlaceholderWindow(stop.apptFrom, stop.apptTo)) {
    return { placeholder: true, text: 'no appt' }
  }
  return { placeholder: false, text: `${fmt12h(norm(stop.apptFrom))}–${fmt12h(norm(stop.apptTo))}` }
}

function norm(v) {
  const m = String(v ?? '').match(/(\d{1,2}):?(\d{2})/)
  if (!m) return String(v ?? '')
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`
}

// Status bucket — Exception only counts when it is a TRUE exception (status 50
// alone is frequently a false positive; see the verified contract).
export function statusBucket(stop) {
  if (stop.trueException) return 'Exception'
  switch (stop.stopStatus) {
    case 90:
      return 'Delivered'
    case 40:
      return 'En Route'
    case 30:
      return 'Scheduled'
    case 10:
      return 'Pending'
    default:
      return 'Other'
  }
}

// Filter dropdown values; "Active" = anything not yet delivered.
export const STATUS_FILTERS = ['All', 'Active', 'Delivered', 'En Route', 'Exceptions', 'Scheduled']

export function matchesStatusFilter(view, filter) {
  switch (filter) {
    case 'All':
      return true
    case 'Active':
      return view.bucket !== 'Delivered'
    case 'Delivered':
      return view.bucket === 'Delivered'
    case 'En Route':
      return view.bucket === 'En Route'
    case 'Exceptions':
      return view.stop.trueException
    case 'Scheduled':
      return view.bucket === 'Scheduled'
    default:
      return true
  }
}

// Build the per-stop view used for rendering, filtering and sorting.
export function buildStopView(stop) {
  const parsed = parseStopComments(stop.comments)
  const chips = activeChips(parsed)
  const revenue = nonUlineRevenue(stop, parsed)
  return {
    stop,
    parsed,
    chips,
    bucket: statusBucket(stop),
    appt: apptDisplay(stop),
    revenueText: formatUSD(revenue),
    recvText: fmtReceivingHours(parsed.receivingHours),
    // ---- sortable scalars ----
    name: stop.name || '',
    plannedEta: stop.plannedEta || '',
    revenue: revenue == null ? null : revenue,
    recvStart: parsed.receivingHours ? parsed.receivingHours.start : '',
  }
}
