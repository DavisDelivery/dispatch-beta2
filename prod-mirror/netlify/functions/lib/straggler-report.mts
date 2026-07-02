// lib/straggler-report.mts — Phase 5 (call-reduction): undelivered / delivered-late /
// aged-out report + 91 (manual portal) vs 90 (system) completion breakdown.
//
// PURE derivations over the multi-day history warehouse — ZERO NuVizz calls. Ground
// truth (per the brief): a missed stop ROLLS to a later day's board under the SAME PRO
// and delivers there; NuVizz never rewrites the origin day. Since the scanner snapshots
// every day, a cross-day late delivery is recoverable directly from the warehouse — no
// stateful /stop/info watchlist needed. The 91-vs-90 status is already persisted on each
// stop record (status / executed.stopStatus), so this is a derived view.

export type CompletionKind = '90' | '91' | null;

// 91 = dispatch-portal MANUAL completion; 90 = system/scan completion; null = not delivered.
export function completionKind(stop: any): CompletionKind {
  const code = String(stop?.status ?? stop?.executed?.stopStatus ?? '').trim();
  if (code === '91') return '91';
  if (code === '90') return '90';
  // Align with production classifyStopStatus (nuvizz-scan): a stop with an actual
  // delivery timestamp — or whose normalizedStatus already settled to DELIVERED —
  // IS delivered even when the raw status code lags behind. Without this the report
  // under-counts deliveries and mislabels delivered PROs as open/aged. A code-less
  // delivery carries no 90/91 signal, so attribute it to the system (90).
  if (stop?.deliveredDTTM || stop?.executed?.deliveredDTTM || stop?.normalizedStatus === 'DELIVERED') return '90';
  return null;
}

function daysBetween(aDate: string, bDate: string): number {
  return Math.round((Date.parse(`${bDate}T00:00:00Z`) - Date.parse(`${aDate}T00:00:00Z`)) / 86400000);
}

export interface RouteCompletion { route: string; delivered: number; system90: number; manual91: number; manualRate: number }
export interface CompletionSummary {
  delivered: number; system90: number; manual91: number; manualRate: number;
  byRoute: RouteCompletion[];
}

// 91-vs-90 summary over a set of delivered stops, overall + per route/driver (with 91-rate).
export function summarizeCompletions(stops: any[]): CompletionSummary {
  let s90 = 0, m91 = 0;
  const routes = new Map<string, RouteCompletion>();
  for (const st of stops) {
    const k = completionKind(st);
    if (!k) continue;
    const route = st.routeName || st.driverName || st.loadNbr || '(unrouted)';
    const r = routes.get(route) || routes.set(route, { route, delivered: 0, system90: 0, manual91: 0, manualRate: 0 }).get(route)!;
    if (k === '91') { m91++; r.manual91++; } else { s90++; r.system90++; }
    r.delivered++;
  }
  const delivered = s90 + m91;
  const byRoute = [...routes.values()].map((r) => ({ ...r, manualRate: r.delivered ? r.manual91 / r.delivered : 0 }))
    .sort((a, b) => b.manual91 - a.manual91 || b.delivered - a.delivered);
  return { delivered, system90: s90, manual91: m91, manualRate: delivered ? m91 / delivered : 0, byRoute };
}

export interface ReportRow {
  stopNbr: string; scheduledDate: string; customer: string | null;
  loadNbr: string | null; route: string | null; driver: string | null;
}
export interface UndeliveredReport {
  windowDays: number; today: string;
  deliveredLate: (ReportRow & { deliveredDate: string; daysLate: number; kind: 'manual' | 'system' })[];
  open: (ReportRow & { openDays: number })[];
  agedOut: (ReportRow & { ageDays: number })[];
  // Delivered on its FIRST visible day, but that day is the window's oldest edge — the
  // PRO may have rolled in from before the read window, so on-time vs late can't be
  // confirmed. Surfaced separately instead of being silently assumed on-time.
  indeterminate: (ReportRow & { deliveredDate: string; kind: 'manual' | 'system' })[];
  completions: CompletionSummary;
}

// Build the report from {date → stop records} spanning the window. Planned stops only.
export function buildUndeliveredReport(
  daysByDate: Record<string, any[]>,
  opts: { windowDays?: number; today: string },
): UndeliveredReport {
  const windowDays = opts.windowDays ?? 7;
  const dates = Object.keys(daysByDate).sort(); // ascending
  // The oldest day we can actually see. A same-day delivery on this edge can't be
  // confirmed on-time (its open origin may predate the window), so it's routed to
  // `indeterminate` rather than silently dropped as on-time.
  const oldestReadDate = dates[0] ?? opts.today;

  // Per-PRO timeline across days: earliest appearance + earliest terminal day.
  interface Pro { firstDate: string; terminalDate: string | null; terminalKind: CompletionKind; last: any }
  const byPro = new Map<string, Pro>();
  const deliveredStops: any[] = [];
  for (const date of dates) {
    for (const st of daysByDate[date] || []) {
      if (!st || st.isPlanned === false || !st.stopNbr) continue;
      if (completionKind(st)) deliveredStops.push(st);
      const pro = String(st.stopNbr);
      const e = byPro.get(pro) || { firstDate: date, terminalDate: null, terminalKind: null, last: st };
      if (date < e.firstDate) e.firstDate = date;
      const k = completionKind(st);
      if (k && (e.terminalDate == null || date < e.terminalDate)) { e.terminalDate = date; e.terminalKind = k; }
      e.last = st;
      byPro.set(pro, e);
    }
  }

  const deliveredLate: any[] = [], open: any[] = [], agedOut: any[] = [], indeterminate: any[] = [];
  for (const [pro, e] of byPro) {
    const row: ReportRow = {
      stopNbr: pro, scheduledDate: e.firstDate,
      customer: e.last.businessName || null, loadNbr: e.last.loadNbr || null,
      route: e.last.routeName || null, driver: e.last.driverName || null,
    };
    if (e.terminalDate) {
      const daysLate = daysBetween(e.firstDate, e.terminalDate);
      const kind = e.terminalKind === '91' ? 'manual' : 'system';
      if (daysLate > 0) deliveredLate.push({ ...row, deliveredDate: e.terminalDate, daysLate, kind });
      else if (e.firstDate === oldestReadDate) indeterminate.push({ ...row, deliveredDate: e.terminalDate, kind });
      // daysLate === 0 strictly inside the window → we DID have visibility into earlier
      // days and never saw it open, so it's genuine same-day on-time → excluded.
    } else {
      const age = daysBetween(e.firstDate, opts.today);
      if (age >= windowDays) agedOut.push({ ...row, ageDays: age });
      else open.push({ ...row, openDays: age });
    }
  }
  deliveredLate.sort((a, b) => b.daysLate - a.daysLate);
  open.sort((a, b) => (a.scheduledDate < b.scheduledDate ? 1 : -1));
  agedOut.sort((a, b) => b.ageDays - a.ageDays);
  indeterminate.sort((a, b) => (a.deliveredDate < b.deliveredDate ? 1 : -1));
  return { windowDays, today: opts.today, deliveredLate, open, agedOut, indeterminate, completions: summarizeCompletions(deliveredStops) };
}
