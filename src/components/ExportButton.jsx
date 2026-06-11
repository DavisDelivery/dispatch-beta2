import { stopsToCsv, downloadCsv } from '../lib/csv.js'

/**
 * ExportButton — renders a "Export CSV" button in .tool-btn style.
 * Props:
 *   stops    {object[]}  raw stop objects (NuVizz shape)
 *   filename {string}    download filename, e.g. 'stops-2025-07-14.csv'
 */
export default function ExportButton({ stops, filename }) {
  const empty = !stops || stops.length === 0

  function handleClick() {
    if (empty) return
    const csv = stopsToCsv(stops)
    downloadCsv(filename, csv)
  }

  return (
    <button
      type="button"
      className="tool-btn export-btn"
      onClick={handleClick}
      disabled={empty}
      aria-disabled={empty}
      title={empty ? 'No stops to export' : `Export ${stops.length} stop${stops.length !== 1 ? 's' : ''} to CSV`}
    >
      ↓ Export CSV
    </button>
  )
}
