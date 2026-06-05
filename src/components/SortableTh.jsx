// Clickable sortable table header cell. Pairs with useSortableTable.
// Shows an active ▲/▼ indicator, and a faint ↕ to signal sortability.

export default function SortableTh({
  columnKey,
  label,
  sortKey,
  sortDirection,
  onSort,
  align = 'left',
}) {
  const active = sortKey === columnKey
  const ariaSort = active
    ? sortDirection === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none'
  const indicator = active ? (sortDirection === 'asc' ? '▲' : '▼') : '↕'

  return (
    <th aria-sort={ariaSort} className={`sortable-th align-${align}`}>
      <button
        type="button"
        className="sortable-th__btn"
        onClick={() => onSort(columnKey)}
      >
        <span className="sortable-th__label">{label}</span>
        <span
          className={`sortable-th__ind ${active ? 'is-active' : ''}`}
          aria-hidden="true"
        >
          {indicator}
        </span>
      </button>
    </th>
  )
}
