// workbenchModel.js — pure grouping and summary logic for Route Workbench.
// Converts a flat array of NuVizz stops into driver-grouped route objects,
// each with pre-computed summary scalars ready for sorting + rendering.
//
// READ-ONLY: no assign/dispatch/sequence-persist logic here.
// TODO(write): POST /load/assignanddispatch (sequence/assign is the later write-back phase)

import { buildStopView, formatUSD } from './stopView.js'

export { formatUSD }

/**
 * Sort stops within a driver group: plannedEta ascending, nulls last.
 */
function sortStopsByEta(stops) {
  return [...stops].sort((a, b) => {
    const av = a.plannedEta
    const bv = b.plannedEta
    if (!av && !bv) return 0
    if (!av) return 1
    if (!bv) return -1
    return new Date(av).getTime() - new Date(bv).getTime()
  })
}

/**
 * Build one driver group summary from a raw stop array (all belonging to one driver).
 * Returns a group object with sortable scalar fields and pre-sorted stops.
 *
 * @param {string} driverUserName
 * @param {string} driverName
 * @param {Array}  rawStops  - all raw NuVizz flattened stop objects for this driver
 * @returns {object}  group view object
 */
export function buildDriverGroup(driverUserName, driverName, rawStops) {
  const sorted = sortStopsByEta(rawStops)
  const views = sorted.map(buildStopView)

  // Distinct loads by loadNbr
  const loadNbrs = new Set(rawStops.map((s) => s.loadNbr).filter(Boolean))

  // Summary sums
  let delivered = 0
  let exceptions = 0
  let revenue = 0
  let hasRevenue = false
  let palletTotal = 0
  let cartonTotal = 0

  for (const v of views) {
    if (v.stop.stopStatus === 90) delivered++
    if (v.stop.trueException) exceptions++
    if (v.revenue != null) {
      revenue += v.revenue
      hasRevenue = true
    }
    palletTotal += Number(v.stop.totalPallets) || 0
    cartonTotal += Number(v.stop.totalCartons) || 0
  }

  // ETA window: first → last plannedEta among those with an ETA
  const etas = sorted.map((s) => s.plannedEta).filter(Boolean)
  const firstEta = etas.length > 0 ? etas[0] : null
  const lastEta = etas.length > 0 ? etas[etas.length - 1] : null

  return {
    driverUserName,
    driverName: driverName || driverUserName || 'Unassigned',
    isUnassigned: !driverUserName,
    rawStops: sorted,
    views,
    loadCount: loadNbrs.size,
    stopCount: sorted.length,
    delivered,
    exceptions,
    revenue: hasRevenue ? revenue : null,
    revenueText: hasRevenue ? formatUSD(revenue) : '',
    palletTotal,
    cartonTotal,
    firstEta,
    lastEta,
  }
}

/**
 * Build all driver groups from a flat stops array.
 * Named drivers come first (sorted by name); unassigned group is last.
 *
 * @param {Array} stops - flat NuVizz flattened stop objects
 * @returns {Array} of group view objects
 */
export function buildDriverGroups(stops) {
  if (!stops || stops.length === 0) return []

  // Partition by driverUserName; empties → unassigned bucket
  const byDriver = new Map()
  const unassigned = []

  for (const stop of stops) {
    const key = stop.driverUserName || ''
    if (!key) {
      unassigned.push(stop)
    } else {
      if (!byDriver.has(key)) {
        byDriver.set(key, { driverName: stop.driverName || key, stops: [] })
      }
      byDriver.get(key).stops.push(stop)
    }
  }

  // Build named driver groups, sorted alphabetically by driver name
  const named = [...byDriver.entries()]
    .sort((a, b) =>
      (a[1].driverName || a[0]).localeCompare(b[1].driverName || b[0], undefined, {
        sensitivity: 'base',
      }),
    )
    .map(([userName, { driverName, stops: s }]) => buildDriverGroup(userName, driverName, s))

  // Unassigned group last
  const groups = [...named]
  if (unassigned.length > 0) {
    groups.push(buildDriverGroup('', 'Unassigned', unassigned))
  }

  return groups
}

/**
 * Test whether a driver group matches a free-text search query.
 * Matches on driverName, route names, customer/stop names, and loadNbrs.
 *
 * @param {object} group  - result of buildDriverGroup
 * @param {string} query  - lowercased search string
 * @returns {boolean}
 */
export function matchesGroupSearch(group, query) {
  if (!query) return true
  const q = query.toLowerCase()

  // Driver name
  if ((group.driverName || '').toLowerCase().includes(q)) return true

  // Any stop's customer name, route name, or loadNbr
  for (const stop of group.rawStops) {
    if ((stop.name || '').toLowerCase().includes(q)) return true
    if ((stop.routeName || '').toLowerCase().includes(q)) return true
    if ((stop.loadNbr || '').toLowerCase().includes(q)) return true
  }

  return false
}
