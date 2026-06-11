// CSV helpers — pure export utilities (no side effects, no DOM, no React).
// escapeCsvField + toCsv are pure; stopsToCsv imports buildStopView for revenue/comments.

import { buildStopView } from './stopView.js'

// ---------------------------------------------------------------------------
// Pure CSV primitives
// ---------------------------------------------------------------------------

/**
 * Returns a CSV-safe string for a single field value.
 * - null/undefined -> ''
 * - coerces to string
 * - wraps in double quotes if the value contains a comma, double-quote, CR, or LF
 * - embedded double-quotes are escaped by doubling ("")
 */
export function escapeCsvField(value) {
  if (value == null) return ''
  const s = String(value)
  if (s.includes(',') || s.includes('"') || s.includes('\r') || s.includes('\n')) {
    return '"' + s.replaceAll('"', '""') + '"'
  }
  return s
}

/**
 * Converts an array of objects to a CSV string.
 * @param {object[]} rows
 * @param {{ key: string, label: string }[]} columns
 * @returns {string} CSV with CRLF line endings and a trailing CRLF (Excel-friendly)
 */
export function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCsvField(c.label)).join(',')
  const lines = [header]
  for (const row of rows) {
    const line = columns.map((c) => escapeCsvField(row[c.key])).join(',')
    lines.push(line)
  }
  return lines.join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------------------
// Stop-specific columns
// ---------------------------------------------------------------------------

const STOP_COLUMNS = [
  { key: 'driverName',   label: 'Driver' },
  { key: 'routeName',    label: 'Route' },
  { key: 'loadNbr',      label: 'Load' },
  { key: 'name',         label: 'Stop' },
  { key: 'addr1',        label: 'Address' },
  { key: 'city',         label: 'City' },
  { key: 'state',        label: 'State' },
  { key: 'zip',          label: 'Zip' },
  { key: 'apptFrom',     label: 'Appt From' },
  { key: 'apptTo',       label: 'Appt To' },
  { key: 'plannedEta',   label: 'Planned ETA' },
  { key: 'statusLabel',  label: 'Status' },
  { key: 'totalPallets', label: 'Pallets' },
  { key: 'totalCartons', label: 'Cartons' },
  { key: 'weight',       label: 'Weight' },
  { key: 'sealNbr',      label: 'Seal' },
  { key: 'nonUlineRev',  label: 'Non-Uline Rev' },
  { key: 'comments',     label: 'Comments' },
]

/**
 * Converts an array of raw stop objects (from NuVizz) into a CSV string.
 * Uses buildStopView for Non-Uline Rev (.revenue) and the verbatim comment
 * string (.parsed.raw). Dates are kept as raw ISO values (data export, not UI).
 */
export function stopsToCsv(stops) {
  const rows = stops.map((stop) => {
    const view = buildStopView(stop)
    return {
      driverName:   stop.driverName   ?? '',
      routeName:    stop.routeName    ?? '',
      loadNbr:      stop.loadNbr      ?? '',
      name:         stop.name         ?? '',
      addr1:        stop.addr1        ?? '',
      city:         stop.city         ?? '',
      state:        stop.state        ?? '',
      zip:          stop.zip          ?? '',
      apptFrom:     stop.apptFrom     ?? '',
      apptTo:       stop.apptTo       ?? '',
      plannedEta:   stop.plannedEta   ?? '',
      statusLabel:  view.bucket       ?? '',
      totalPallets: stop.totalPallets ?? '',
      totalCartons: stop.totalCartons ?? '',
      weight:       stop.weight       ?? '',
      sealNbr:      stop.sealNbr      ?? '',
      nonUlineRev:  view.revenue != null ? view.revenue : '',
      comments:     view.parsed.raw   ?? '',
    }
  })
  return toCsv(rows, STOP_COLUMNS)
}

// ---------------------------------------------------------------------------
// Browser download helper
// ---------------------------------------------------------------------------

/**
 * Triggers a CSV file download in the browser.
 * Guard: only runs when document is available (browser, not SSR).
 * @param {string} filename  e.g. 'stops-2025-07-14.csv'
 * @param {string} csvString  the CSV content
 */
export function downloadCsv(filename, csvString) {
  if (typeof document === 'undefined') return
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
