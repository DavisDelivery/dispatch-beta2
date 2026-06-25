// Shared status → colour palette for map markers + legends (mirrors the
// stopcard.is-* hexes in index.css). Used by /map and /routing.

import { statusBucket } from './stopView.js'

export const STATUS_COLORS = {
  Delivered: '#34d399',
  'En Route': '#38bdf8',
  Exception: '#fb7185',
  Scheduled: '#fbbf24',
  Pending: '#94a3b8',
  Other: '#64748b',
}

export const LEGEND_ENTRIES = [
  { bucket: 'Delivered', color: STATUS_COLORS.Delivered },
  { bucket: 'En Route', color: STATUS_COLORS['En Route'] },
  { bucket: 'Exception', color: STATUS_COLORS.Exception },
  { bucket: 'Scheduled', color: STATUS_COLORS.Scheduled },
  { bucket: 'Pending', color: STATUS_COLORS.Pending },
]

export function markerColor(stop) {
  return STATUS_COLORS[statusBucket(stop)] ?? STATUS_COLORS.Other
}

// Google marker symbol for a stop — enlarged + light-ringed when selected.
export function markerIcon(api, stop, selected) {
  return {
    path: api.SymbolPath.CIRCLE,
    scale: selected ? 7.5 : 5,
    fillColor: markerColor(stop),
    fillOpacity: selected ? 1 : 0.9,
    strokeColor: selected ? '#f8fafc' : '#0b1220',
    strokeWeight: selected ? 2.5 : 1,
  }
}
