// lib/attempts-core.mts
//
// Shared core for the delivery-ATTEMPTS feature. Two scheduled jobs + a join:
//
//   1. PLAN SNAPSHOT (~8:30am ET) — capturePlanSnapshot(date)
//      Davis routing is finalized by ~8:30am, so every delivery is PLANNED onto a
//      driver. We freeze that: stopNbr → {driver, load, route, customer}. This is
//      the authoritative "who had it" record for the day, captured BEFORE any
//      failed stop gets the ATT marker + unplanned later in the day.
//
//   2. ATTEMPT SCAN (~8:00pm ET) — runAttemptScan(date)
//      By evening, a delivery the driver couldn't complete has had "ATT" prepended
//      to its SHIPMENT number by customer service and been unplanned. We make ONE
//      NuVizz call — the ATTEMPTS saved search (SAVED_SEARCHES.attempts: Shipment Number
//      starts-with "att", Estimated Arrival = today) — and JOIN each returned stop back
//      to its morning driver by stopNbr (which never changes — the ATT prefix lands on
//      shipmentNbr only). The result is a per-day attempts list answering "who had this
//      delivery when it was attempted".
//
// WHY a dedicated saved search (not the live board index): the active (20,10) and
// completed (90,91,80) searches that feed the board do NOT reliably return ATT stops,
// so attempts have their OWN portal filter. It's the same single /entity/filterdata pull
// the board already uses, just a different filter — exactly ONE vendor call at 8pm. The
// original implementation re-probed every morning stop via /stop/info (~700 calls/night)
// — removed.
//
// DST: the crons fire on fixed UTC instants; everything date/hour here is computed
// off the America/New_York clock (nowET / etDayString), so the spring/fall flips
// need no code change. Each job uses TWO UTC candidate fires + an ET-hour gate so
// exactly one lands in the target ET window year-round (see the wrappers).

import { nowET } from './scan-schedule.mts';
import { etDayString, isFirestoreEnabled, readStops } from './firestore.mts';
import { isAttemptShipment } from './nuvizz-scan.mts';
import { fetchSavedSearchRows, fromRows, SAVED_SEARCHES } from './nuvizz-list.mts';
import { setCallTrigger } from './nuvizz-request.mts';
import { driverKeyFor, stopMatchKey } from './history-derive.mts';
import {
  getPlanMeta, setPlanMeta, listPlanStops, upsertPlanStops,
  setAttemptsManifest, upsertAttemptItems,
} from './attempts-store.mts';

const TENANT = 'davis';

// Master kill switch for the attempts jobs (independent of NUVIZZ_SCANS_ENABLED).
// Only the literal string "false" disables, so a missing/blank var never kills it.
export function attEnabled(env: Record<string, any> = process.env): boolean {
  return String(env.NUVIZZ_ATT_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ?date=YYYY-MM-DD → an explicit (manual) run for that ET day, which BYPASSES the
// schedule gate (for backfill / re-runs). No query string → the scheduled default:
// the current America/New_York calendar day. The 8pm scan fires at 00:00–01:00 UTC,
// which is the NEXT UTC date but still the SAME ET day (8–9pm ET) — etDayString gets
// that right, where todayUTC() would wrongly roll to tomorrow.
export function resolveAttemptDate(req: Request): { date: string; isManual: boolean } {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date');
    if (date && DATE_RE.test(date)) return { date, isManual: true };
  } catch { /* fall through to scheduled default */ }
  return { date: etDayString(), isManual: false };
}

export interface AttemptFireDecision {
  act: boolean;
  etHour: number;
  etMin: number;
  reason: string;
}

// PURE schedule gate (unit-tested). A scheduled fire ACTS only when it lands in the
// target ET hour window AND the day's job hasn't already succeeded — so the TWO UTC
// candidate fires collapse to exactly one action per day, and a DROPPED first
// candidate is covered by the second (it still finds the job not-yet-done). A manual
// (?date) run always acts; a disabled job never does.
export function attemptFireDecision(opts: {
  startHour: number;
  endHour: number;
  now?: Date;
  isManual?: boolean;
  alreadyDone?: boolean;
  enabled?: boolean;
}): AttemptFireDecision {
  const { hour, minute } = nowET(opts.now ?? new Date());
  const base = { etHour: hour, etMin: minute };
  if (opts.enabled === false) return { act: false, ...base, reason: 'disabled' };
  if (opts.isManual) return { act: true, ...base, reason: 'manual' };
  if (opts.alreadyDone) return { act: false, ...base, reason: `already-done h=${hour}` };
  if (hour >= opts.startHour && hour < opts.endHour) {
    return { act: true, ...base, reason: `act h=${hour} in[${opts.startHour},${opts.endHour})` };
  }
  return { act: false, ...base, reason: `out-of-window h=${hour} not in[${opts.startHour},${opts.endHour})` };
}

// ── PURE record builders (unit-tested without the network) ────────────────────

// One plan-snapshot doc: who had this delivery while it was routed this morning.
export function buildPlanRecord(s: any, date: string, capturedAt: string): any {
  return {
    tenant: TENANT,
    date,
    capturedAt,
    stopNbr: String(s.stopNbr),
    shipmentNbr: s.shipmentNbr ?? null,
    driverUserName: s.driverUserName ?? null,
    driverName: s.driverName ?? null,
    driverKey: driverKeyFor(s),
    loadNbr: s.loadNbr ?? null,
    routeName: s.routeName ?? null,
    businessName: s.businessName ?? null,
    customerMatchKey: stopMatchKey(s),
    addr1: s.addr1 ?? null,
    city: s.city ?? null,
    state: s.state ?? null,
    zip: s.zip ?? null,
    status: s.status ?? null,
    normalizedStatus: s.normalizedStatus ?? null,
  };
}

// One attempts-list item: a stop now carrying the ATT marker, joined back to the
// morning plan record by stopNbr. `matched` = the morning plan knew a driver for it
// (true for every item produced from the snapshot; the field is kept so a future
// midday-add path can surface unmatched attempts honestly rather than dropping them).
export function buildAttemptItem(plan: any, current: any, date: string, detectedAt: string): any {
  const matched = !!(plan.driverUserName || plan.driverName);
  return {
    tenant: TENANT,
    date,
    detectedAt,
    stopNbr: String(plan.stopNbr),
    shipmentNbr: current?.shipmentNbr ?? null,
    originalDriverUserName: plan.driverUserName ?? null,
    originalDriverName: plan.driverName ?? null,
    originalDriverKey: plan.driverKey ?? null,
    originalLoadNbr: plan.loadNbr ?? null,
    routeName: plan.routeName ?? null,
    businessName: plan.businessName ?? current?.businessName ?? null,
    customerMatchKey: plan.customerMatchKey ?? null,
    addr1: plan.addr1 ?? current?.addr1 ?? null,
    city: plan.city ?? current?.city ?? null,
    state: plan.state ?? current?.state ?? null,
    zip: plan.zip ?? current?.zip ?? null,
    // CURRENT (info only) — who the stop is on NOW (the re-delivery driver) and its
    // current state. NEVER used for attribution: by evening this is whoever it was
    // re-planned onto, not who attempted it. Kept so the UI can show "now on X".
    currentDriverName: current?.driverName ?? null,
    currentDriverUserName: current?.driverUserName ?? null,
    currentStatus: current?.normalizedStatus ?? null,
    currentlyUnplanned: !!current?.isUnplanned,
    matched,
  };
}

// ── 8:30am: freeze the routed plan ────────────────────────────────────────────
export async function capturePlanSnapshot(date: string): Promise<any> {
  // Read the already-warm live stop index ONLY (the */15 refresh has populated today
  // since ~4am) so the morning freeze costs ZERO NuVizz calls. There is deliberately NO
  // fallback to a live scanDate: a fresh scan of an empty board could fire ~700 NuVizz
  // calls, which is exactly the kind of burst this feature must never cause. If the index
  // is somehow empty, we abort the snapshot (it will succeed on a later fire once the
  // index is warm) rather than scan the vendor.
  const source: 'index' = 'index';
  const idx = await readStops(TENANT, date);
  const stops: any[] = idx.stops;
  if (!stops.length) {
    console.warn(`[att-plan] date=${date} stop index empty — SKIPPING snapshot (no NuVizz fallback by design)`);
    return { date, ok: false, source, skipped: 'index-empty', planned: 0, totalStops: 0 };
  }
  // The plan = who had each delivery while it was routed: PLANNED stops with a driver.
  const planned = stops.filter((s) => s && s.stopNbr && s.isPlanned && (s.driverUserName || s.driverName));
  const capturedAt = new Date().toISOString();
  const records = planned.map((s) => buildPlanRecord(s, date, capturedAt));
  await upsertPlanStops(TENANT, date, records);
  // Meta LAST (after the stop docs) so a reader/gate never treats a half-written
  // snapshot as complete.
  await setPlanMeta(TENANT, date, {
    tenant: TENANT, date, capturedAt, source,
    plannedCount: records.length, totalStops: stops.length,
  });
  console.log(`[att-plan] date=${date} source=${source} planned=${records.length} total=${stops.length}`);
  return { date, ok: true, source, planned: records.length, totalStops: stops.length };
}

// ── 8:00pm: find attempts + join back to the morning driver ───────────────────
export async function runAttemptScan(date: string): Promise<any> {
  const [plan, planMeta] = await Promise.all([listPlanStops(TENANT, date), getPlanMeta(TENANT, date)]);
  const detectedAt = new Date().toISOString();

  // ONE NuVizz call: pull the ATTEMPTS saved search (Shipment Number starts-with "att",
  // Estimated Arrival = today) — the same single /entity/filterdata pull the board uses for
  // the active/completed searches, just a different filter. The active (20,10) and completed
  // (90,91,80) searches don't reliably return ATT stops, which is why attempts have their
  // own filter. Each returned stop is then JOINED back to the morning plan snapshot
  // (Firestore, zero calls) by stopNbr to attribute the driver who had it.
  setCallTrigger('attempts'); // attribute this run's single call on the shared counter
  let attemptStops: any[] = [];
  let fetchOk = true;
  try {
    attemptStops = fromRows(await fetchSavedSearchRows(SAVED_SEARCHES.attempts));
  } catch (e: any) {
    fetchOk = false;
    console.warn(`[att-scan] date=${date} attempts saved-search pull failed (${e?.message}); writing empty attempts list`);
  }

  const planByNbr = new Map<string, any>();
  for (const p of plan) if (p && p.stopNbr) planByNbr.set(String(p.stopNbr), p);

  const items: any[] = [];
  for (const cur of attemptStops) {
    // Defensive: only keep stops actually carrying the ATT marker (the saved search already
    // filters to these, but never trust a feed blindly).
    if (!cur || !cur.stopNbr || !isAttemptShipment(cur.shipmentNbr)) continue;
    const p = planByNbr.get(String(cur.stopNbr)) || { stopNbr: String(cur.stopNbr) };
    items.push(buildAttemptItem(p, cur, date, detectedAt));
  }

  const matched = items.filter((it) => it.matched).length;
  await upsertAttemptItems(TENANT, date, items);
  const counts = {
    candidates: plan.length,       // morning-plan size (the attribution source)
    found: attemptStops.length,    // rows the attempts filter returned
    attempts: items.length,        // confirmed ATT stops written
    matched,                       // attempts we could attribute to a morning driver
    unmatched: items.length - matched,
  };
  // Manifest LAST.
  await setAttemptsManifest(TENANT, date, {
    tenant: TENANT, date, generatedAt: detectedAt,
    planSnapshotAt: planMeta?.capturedAt ?? null,
    planMissing: !planMeta,
    fetchOk,
    counts, ok: true,
  });
  console.log(`[att-scan] date=${date} ${JSON.stringify(counts)} planMissing=${!planMeta} fetchOk=${fetchOk} (1 NuVizz call)`);
  return { date, ok: true, ...counts };
}

// ── shared HTTP / scheduled entrypoint (gate → work → JSON) ────────────────────
async function runGated(
  req: Request,
  cfg: { label: string; startHour: number; endHour: number; work: (date: string) => Promise<any>; alreadyDone?: (date: string) => Promise<boolean> },
): Promise<Response> {
  const json = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  if (!isFirestoreEnabled()) {
    console.error(`${cfg.label}: FIREBASE_SA not set on this site — cannot run`);
    return json(200, { ok: false, error: 'FIREBASE_SA not set' });
  }
  const { date, isManual } = resolveAttemptDate(req);
  const enabled = attEnabled();
  // alreadyDone applies only to once-per-day jobs (the snapshot). The scan omits it so
  // every in-window fire re-runs — attempts accumulate through the evening, and a manual
  // run must never block the scheduled one (the bug that lost 6/25's evening attempts).
  const alreadyDone = !isManual && enabled && cfg.alreadyDone ? await cfg.alreadyDone(date).catch(() => false) : false;
  const decision = attemptFireDecision({ startHour: cfg.startHour, endHour: cfg.endHour, isManual, alreadyDone, enabled });
  if (!decision.act) {
    console.log(`[${cfg.label}] skip date=${date} ${decision.reason}`);
    return json(200, { ok: true, acted: false, date, reason: decision.reason, etHour: decision.etHour });
  }
  try {
    const t0 = Date.now();
    const result = await cfg.work(date);
    return json(200, { ok: true, acted: true, date, reason: decision.reason, ms: Date.now() - t0, result });
  } catch (e: any) {
    console.error(`[${cfg.label}] ERROR date=${date}:`, e?.message);
    return json(500, { ok: false, acted: true, date, error: e?.message });
  }
}

export function runPlanSnapshot(req: Request): Promise<Response> {
  // Window [8,12) ET: the snapshot must land after routing settles (~8:30am) and
  // well before any failed delivery is unplanned in the afternoon.
  return runGated(req, {
    label: 'att-plan', startHour: 8, endHour: 12,
    work: capturePlanSnapshot,
    alreadyDone: (date) => getPlanMeta(TENANT, date).then((m) => !!m),
  });
}

export function runAttemptsScan(req: Request): Promise<Response> {
  // Window [20,24) ET: after the day's deliveries are in and CS has marked/unplanned
  // the failures, but the same ET day as the morning snapshot we join against. NO
  // alreadyDone gate — it re-runs on every in-window fire so late-marked attempts are
  // caught and a manual run can't block the scheduled one (one cheap saved-search call).
  return runGated(req, {
    label: 'att-scan', startHour: 20, endHour: 24,
    work: runAttemptScan,
  });
}
