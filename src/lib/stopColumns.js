// Canonical Stops column set — mirrors NuVizz's Stops grid.
// RAW fields only for v0.1.0 (no parsing/chips/revenue framing — that is brief #2).
//
// `key`   -> normalized field name (see netlify/functions/stops.cjs + fixture)
// `label` -> header text
// `type`  -> drives sorting ('text' | 'number' | 'date')
// `align` -> cell alignment

import { formatDate, formatNumber, formatText } from './format.js'

export const STOP_COLUMNS = [
  { key: 'stopNumber', label: 'Stop Number', type: 'text', align: 'left', render: formatText },
  { key: 'stopCreated', label: 'Stop Created', type: 'date', align: 'left', render: formatDate },
  { key: 'shipmentNumber', label: 'Shipment Number', type: 'text', align: 'left', render: formatText },
  { key: 'driverName', label: 'Driver Name', type: 'text', align: 'left', render: formatText },
  { key: 'loadName', label: 'Load Name', type: 'text', align: 'left', render: formatText },
  { key: 'shipToName', label: 'Ship To Name', type: 'text', align: 'left', render: formatText },
  { key: 'address1', label: 'Address 1', type: 'text', align: 'left', render: formatText },
  { key: 'address2', label: 'Address 2', type: 'text', align: 'left', render: formatText },
  { key: 'city', label: 'City', type: 'text', align: 'left', render: formatText },
  { key: 'zip', label: 'Zip', type: 'text', align: 'left', render: formatText },
  { key: 'totalCartons', label: 'Total Cartons', type: 'number', align: 'right', render: formatNumber },
  { key: 'volume', label: 'Volume', type: 'number', align: 'right', render: formatNumber },
  { key: 'weight', label: 'Weight', type: 'number', align: 'right', render: formatNumber },
  { key: 'status', label: 'Status', type: 'text', align: 'left', render: formatText },
  { key: 'sealNbr', label: 'SealNbr', type: 'text', align: 'left', render: formatText },
  { key: 'comments', label: 'Comments', type: 'text', align: 'left', render: formatText },
]

// key -> type lookup for the sortable-table hook.
export const STOP_COLUMN_TYPES = Object.fromEntries(
  STOP_COLUMNS.map((c) => [c.key, c.type]),
)

// Fields the quick-search box scans (free-text columns only).
export const STOP_SEARCH_KEYS = [
  'stopNumber',
  'shipmentNumber',
  'driverName',
  'loadName',
  'shipToName',
  'address1',
  'address2',
  'city',
  'zip',
  'status',
  'sealNbr',
  'comments',
]
