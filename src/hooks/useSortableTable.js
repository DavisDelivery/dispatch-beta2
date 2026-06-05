import { useMemo, useState } from 'react'

// Reusable client-side sortable-table state.
// EVERY table in the app should use this hook + the <SortableTh> component so
// behaviour (toggle asc/desc, empties-last, type-aware compare) stays uniform.
//
//   const { sortedItems, sortKey, sortDirection, requestSort } =
//     useSortableTable(rows, { initialKey: 'stopNumber', types: STOP_COLUMN_TYPES })
//
// `types` maps column key -> 'text' | 'number' | 'date'. Unknown keys sort as
// text with natural numeric collation ("Stop 2" before "Stop 10").

function isEmpty(v) {
  return v == null || v === ''
}

function baseCompare(a, b, type) {
  if (type === 'number') return Number(a) - Number(b)
  if (type === 'date') return new Date(a).getTime() - new Date(b).getTime()
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

export function useSortableTable(items, { initialKey = null, initialDirection = 'asc', types = {} } = {}) {
  const [sortKey, setSortKey] = useState(initialKey)
  const [sortDirection, setSortDirection] = useState(initialDirection)

  function requestSort(key) {
    if (key === sortKey) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDirection('asc')
    }
  }

  const sortedItems = useMemo(() => {
    if (!sortKey) return items
    const dir = sortDirection === 'asc' ? 1 : -1
    const type = types[sortKey] ?? 'text'
    // Copy so we never mutate the source array.
    return [...items].sort((rowA, rowB) => {
      const a = rowA[sortKey]
      const b = rowB[sortKey]
      // Empties always sort last, regardless of direction.
      if (isEmpty(a) && isEmpty(b)) return 0
      if (isEmpty(a)) return 1
      if (isEmpty(b)) return -1
      return dir * baseCompare(a, b, type)
    })
  }, [items, sortKey, sortDirection, types])

  return { sortedItems, sortKey, sortDirection, requestSort }
}
