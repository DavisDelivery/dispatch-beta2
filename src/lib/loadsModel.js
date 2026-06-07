// Loads page model — READ-ONLY now, write-ready shape for the later phase.

import { formatDate, formatNumber, formatText } from './format.js'

// Derive a status bucket from stop progress while KEEPING the raw loadStatus.
export function deriveLoadBucket(load) {
  if ((load.stopsExceptions ?? 0) > 0) return 'Exceptions'
  if ((load.stopCount ?? 0) > 0 && (load.stopsDelivered ?? 0) >= load.stopCount) return 'Complete'
  if ((load.stopsDelivered ?? 0) > 0) return 'In Progress'
  if (!load.driverUserName) return 'Unassigned'
  return 'Planned'
}

export const LOAD_STATUS_FILTERS = [
  'All',
  'Unassigned',
  'Planned',
  'In Progress',
  'Complete',
  'Exceptions',
]

export function matchesLoadFilter(view, filter) {
  if (filter === 'All') return true
  if (filter === 'Unassigned') return !view.driverUserName
  return view.bucket === filter
}

// Build the per-row view (adds origin + bucket; keeps every raw value).
export function buildLoadView(load) {
  return {
    ...load,
    origin: [load.originCity, load.originState].filter(Boolean).join(', '),
    driver: load.driverName || '',
    bucket: deriveLoadBucket(load),
  }
}

// Sortable grid columns (every column sorts via useSortableTable + SortableTh).
export const LOAD_COLUMNS = [
  { key: 'routeName', label: 'Route', type: 'text', align: 'left', render: formatText },
  { key: 'loadNbr', label: 'Load', type: 'text', align: 'left', render: formatText },
  { key: 'pronbr', label: 'PRO', type: 'text', align: 'left', render: formatText },
  { key: 'reference', label: 'Reference', type: 'text', align: 'left', render: formatText },
  { key: 'driver', label: 'Driver', type: 'text', align: 'left', render: formatText },
  { key: 'bucket', label: 'Status', type: 'text', align: 'left', render: formatText },
  { key: 'stopCount', label: 'Stops', type: 'number', align: 'right', render: formatNumber },
  { key: 'totalPallets', label: 'Pallets', type: 'number', align: 'right', render: formatNumber },
  { key: 'totalCartons', label: 'Cartons', type: 'number', align: 'right', render: formatNumber },
  { key: 'volume', label: 'Volume', type: 'number', align: 'right', render: formatNumber },
  { key: 'weight', label: 'Weight', type: 'number', align: 'right', render: formatNumber },
  { key: 'origin', label: 'Origin', type: 'text', align: 'left', render: formatText },
  { key: 'earliestStart', label: 'Start', type: 'date', align: 'left', render: formatDate },
  { key: 'latestStart', label: 'Latest Departure', type: 'date', align: 'left', render: formatDate },
]

export const LOAD_COLUMN_TYPES = Object.fromEntries(LOAD_COLUMNS.map((c) => [c.key, c.type]))

export const LOAD_SEARCH_KEYS = ['loadNbr', 'routeName', 'driver', 'pronbr', 'reference']

/**
 * writeReadyModel — PURE. Returns the VALUES (not display strings) a future
 * write-back phase will send to NuVizz. READ-ONLY now: nothing here fires a
 * write; the two endpoints are left as explicit, unwired TODO markers.
 */
export function writeReadyModel(l) {
  // TODO(write): POST /load/update
  // TODO(write): POST /load/assignanddispatch
  return {
    loadId: l.loadId,
    loadNbr: l.loadNbr,
    loadStatus: l.loadStatus,
    assignment: {
      driverUserName: l.driverUserName,
      driverEmail: l.driverEmail,
      vehicleType: l.vehicleType,
    },
    pronbr: l.pronbr,
    reference: l.reference,
    earliestStart: l.earliestStart,
    latestStart: l.latestStart,
  }
}
