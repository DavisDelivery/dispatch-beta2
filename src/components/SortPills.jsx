// Sort control for card-list views (Stops). Drives the SAME useSortableTable
// hook the tables use — click a pill to sort by that key; click again to toggle
// asc/desc. Keeps sorting centralized instead of hand-rolled per page.
export default function SortPills({ options, sortKey, sortDirection, onSort, label = 'Sort' }) {
  return (
    <div className="sortpills" role="group" aria-label={`${label} by`}>
      <span className="sortpills__label">{label}</span>
      {options.map((opt) => {
        const active = sortKey === opt.key
        const indicator = active ? (sortDirection === 'asc' ? '▲' : '▼') : '↕'
        return (
          <button
            key={opt.key}
            type="button"
            className={`sortpill ${active ? 'is-active' : ''}`}
            aria-pressed={active}
            onClick={() => onSort(opt.key)}
          >
            {opt.label}
            <span className="sortpill__ind" aria-hidden="true">
              {indicator}
            </span>
          </button>
        )
      })}
    </div>
  )
}
