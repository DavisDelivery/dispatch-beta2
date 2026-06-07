import { useState } from 'react'
import { STOP_CHIPS } from '../lib/parseStopComments.ts'

// A row of special-instruction chips for a stop. `chips` is the output of
// activeChips(parsed) — already filtered + in catalog order.
export function StopChips({ chips }) {
  if (!chips || chips.length === 0) return null
  return (
    <div className="chips" aria-label="Special instructions">
      {chips.map((c) => (
        <span key={c.key} className="chip" style={{ '--chip': c.color }}>
          {c.label}
        </span>
      ))}
    </div>
  )
}

// Collapsible legend explaining every chip in the catalog.
export function ChipLegend() {
  const [open, setOpen] = useState(false)
  return (
    <div className="legend">
      <button
        type="button"
        className="legend__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} Chip legend
      </button>
      {open && (
        <div className="legend__body">
          {STOP_CHIPS.map((c) => (
            <span key={c.key} className="legend__item">
              <span className="chip" style={{ '--chip': c.color }}>
                {c.label}
              </span>
              <span className="legend__desc">{LEGEND_TEXT[c.key]}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const LEGEND_TEXT = {
  liftgate: 'Liftgate required',
  insideDelivery: 'Inside delivery',
  doNotBreakdownSkid: 'Do not break down the skid',
  doNotDoubleStack: 'Do not double-stack',
  callUponApproach: 'Call ahead / upon approach',
  gravelOrNewConstruction: 'Gravel lot / new construction',
}
