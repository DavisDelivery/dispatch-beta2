// refresh-stops-core.mts
//
// Shared handler for the scheduled stop-index writers. Two thin function
// wrappers (daytime + evening) both delegate here — Netlify allows only ONE
// cron expression per scheduled function, so covering two UTC windows requires
// two function files sharing this one implementation.
//
// Each run scans TODAY + the next 7 calendar days and upserts every normalized
// stop into nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr}, with a meta doc
// carrying last_scanned_at. Future dates are scanned so date-picker selections
// ahead of today aren't empty (see PR caveat).
//
// Scheduling is governed ENTIRELY by the two wrappers' cron expressions (see
// nuvizz-refresh-stops-background.mts) — there is deliberately no UTC-weekday
// skip here, because the Friday-evening ET window lands on Saturday UTC and a
// naive getUTCDay() check would wrongly drop it. Manual HTTP runs always proceed.
//
// The board day is anchored on the EASTERN calendar day (etDayString), not the UTC
// day: after ~8pm ET the UTC date is already tomorrow, so a UTC anchor filed the
// Friday-evening live board under Saturday's doc key — which, with no weekend scan to
// re-derive it, left Friday's deliveries sitting on Saturday's board all weekend.

import { scanDate, scansEnabled, deriveFleetSummary, estimateLoadRange, buildScanState, shadowWouldProbe, selectLoadProbeTargets, groupLoadMembers, estimateStopFrontier, unplannedFloor, FLOOR_MARGIN, loadNbrToInt, stopNbrToInt, shouldDeepSweep, deepSweepGate, lookupStopByPro } from './nuvizz-scan.mts';
import { loadProbeParity, frontierParity, loadMembershipDelta, dateSliceMismatch } from './scan-parity.mts';
import { isFirestoreEnabled, writeStops, writeFleetIndex, getDoc, markScanState, readCallStats, readCircuit, readScanState, writeScanState, readRecentFrontier, recordScanMetric, etDayString, readScanConfig, readStops, readEnrichedPros, writeEnrichedPros, writeLoadRoster, readLoadRoster, writeActiveUnplannedSet } from './firestore.mts';
import { listScanForDate, mergeEnrich, twoScanBuckets, etDateForTargetUTC, boardDayFor, applyBoardWriteGrace } from './nuvizz-list.mts';
import { loadIdsForDate, dropForeignLoadStops, loadRosterForDate } from './nuvizz-loads.mts';
import { resolveCoords, addrKey } from './geocode.mts';
import { maxConsecutiveGap } from './scan-metrics.mts';
import { notifyMarkedCustomers } from './cs-notify.mts';
import { breakerTripped, scanIntervalElapsed, breakerMode, setDailyCeilingOverride, setCallTrigger } from './nuvizz-request.mts';
import { scanDecision, isInRoutingWindow, clampScanConfig } from './scan-schedule.mts';

// Reuse the CANONICAL integer parsers from nuvizz-scan so the parity log's
// load/stop numbers are extracted identically to selectLoadProbeTargets /
// buildScanState (a divergent local parser could emit false MISSED_LOADS).
const loadNbrInt = loadNbrToInt;
const stopNbrInt = stopNbrToInt;

const TENANT = 'davis';
// Scheduled runs scan TODAY + the next BUSINESS day — the dispatcher's planning
// horizon. (The original today+next-7 was an 8× multiplier on every cron tick;
// today-only was too tight — it left tomorrow's board frozen, since the map only
// READS Firestore and never scans a future date itself.) Business-day stepping so
// a Friday run covers Monday, not an empty Saturday. Volume stays modest because
// the load-window self-calibrates to each day's actual span (see nuvizz-scan.mts).
const DEFAULT_DAYS = 2; // today + next business day (was 1 = today only)
// LIST-DISCOVERY write horizon: today + the next (N-1) BUSINESS days. The active saved-search
// pull is ALREADY a ±7d window, so writing an extra planning day costs NO extra list call — only
// that day's load roster + first-time enrichment of its new orders. 3 = today + next 2 business
// days, so a SUNDAY scan already builds TUESDAY's board (Uline ships Sunday for Tuesday delivery)
// instead of leaving it empty until Monday's scan reaches it (#251) — and the enrichment lands on
// Sunday, the week's lowest call-volume day, not on busy Monday. Env-overridable; clamped 2..5.
const LIST_HORIZON_DAYS = Math.max(2, Math.min(5, Number(process.env.NUVIZZ_LIST_HORIZON_DAYS) || 3));

function addDaysUTC(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The next Mon–Fri date strictly after dateStr (skips Sat/Sun).
export function nextBusinessDayUTC(dateStr: string): string {
  let d = addDaysUTC(dateStr, 1);
  let dow = new Date(d + 'T00:00:00Z').getUTCDay();
  while (dow === 0 || dow === 6) { d = addDaysUTC(d, 1); dow = new Date(d + 'T00:00:00Z').getUTCDay(); }
  return d;
}

// Build the scan date list: today + the next (n-1) BUSINESS days. Exported for tests.
export function scanDatesFrom(today: string, n: number): string[] {
  const dates = [today];
  let cur = today;
  for (let i = 1; i < n; i++) { cur = nextBusinessDayUTC(cur); dates.push(cur); }
  return dates;
}

// Has a FUTURE date's load roster been GOOD-captured today (skip the re-pull)? A capture
// only counts when it was taken THIS ET day, is non-empty, AND at least one row carries a
// real load NUMBER. Tomorrow's load SET is fixed once it exists (per Chad — the shells are
// generated up front, the set doesn't change through the day), so ONE good capture per scan
// day is the whole job. The number check is the guard the once-a-day dedup was missing on
// Jul 1 2026: that morning's capture ran before the Load-Number column/parser fix (#336)
// landed, wrote 102 rows with ZERO numbers, and the "non-empty → done" dedup froze the
// number-less snapshot all day — so every evening reorder/unplan Save was refused ("needs
// a load number"). A number-less capture now reads as NOT captured and keeps re-pulling
// until the numbers come through (parser fixed / column present / NuVizz hiccup passed).
// Exported for tests.
export function futureRosterCaptured(cached: { at?: string; loads?: any[] } | null | undefined, now: Date): boolean {
  if (!cached?.at || (cached.loads?.length ?? 0) === 0) return false;
  const atD = new Date(cached.at);
  if (!Number.isFinite(atD.getTime())) return false;
  if (etDayString(atD) !== etDayString(now)) return false;      // a prior scan-day's capture never counts
  return (cached.loads || []).some((l: any) => l?.loadNbr);     // a number-less capture never counts
}

export async function runRefreshStops(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const now = new Date();
  const url = new URL(req.url);
  const isManual = url.searchParams.get('manual') === '1';
  const dateParam = url.searchParams.get('date');
  const daysParam = url.searchParams.get('days');
  const explicit = !!(dateParam || daysParam); // ops/testing: full forced scan of given dates
  const trigger = isManual ? 'manual' : (explicit ? 'explicit' : 'schedule');
  // Attribute every NuVizz call this run makes (list pulls + enrichment) to the right
  // trigger on the shared counter, so a spike is traceable to the scheduled scanner vs
  // a manual scan vs on-demand. ('scheduled-scan' is the cron path; 'manual' a human scan.)
  setCallTrigger(isManual ? 'manual' : 'scheduled-scan');

  // Anchor the board day on the EASTERN calendar day, NOT the UTC day. They agree all day
  // and diverge only after ~8pm ET (UTC already rolled to tomorrow). The board doc is keyed by
  // this date AND the dispatcher's date picker selects an ET calendar day, so anchoring on UTC
  // made the Friday-evening run write FRIDAY's live board into the SATURDAY-keyed doc — and on a
  // weekend (no follow-up scan) that stale bleed sat on Saturday's board all weekend. ET-anchoring
  // files each day's board under its own ET date (the same fix attempts-core already uses).
  // today + tomorrow drive the number-probe fallback; the LIST path writes the full planning
  // horizon (today + next LIST_HORIZON_DAYS-1 business days) from its single ±7d pull.
  const scanDates = scanDatesFrom(etDayString(), LIST_HORIZON_DAYS);
  const [today, tomorrow] = scanDates;
  const fsOn = isFirestoreEnabled();
  let ceiling = Number(process.env.NUVIZZ_DAILY_CEILING) || 12000;
  // Phase 2 — lean load discovery (known-active + buffer + gap sweep). OFF by
  // default; flip NUVIZZ_LEAN_DISCOVERY=on only AFTER preview stop-set parity is
  // confirmed. Off = the proven wide-window probe, unchanged.
  const LEAN_DISCOVERY = (process.env.NUVIZZ_LEAN_DISCOVERY || '').toLowerCase() === 'on';
  // Adaptive forward discovery (default ON; set NUVIZZ_FORWARD_SCAN=off to revert
  // to the wide-window/lean behavior). Instead of a cold ~601-wide load window +
  // findCeiling order descent, seed from the persisted frontier (carried ACROSS
  // days on a cold/resumption day — e.g. Sunday after the weekend blackout) and
  // walk FORWARD in 25-chunks until nothing new turns up. Nothing changes below the
  // frontier over the weekend, so the Sunday resume is a cheap forward walk, not a
  // big sweep. Takes precedence over lean. The deep sweep (every
  // NUVIZZ_DEEP_SWEEP_HOURS, default 8) stays the periodic full-floor backstop that
  // reconciles below-frontier status changes / out-of-order imports.
  const FORWARD_SCAN = (process.env.NUVIZZ_FORWARD_SCAN || '').toLowerCase() !== 'off';
  // PRIMARY list discovery (NUVIZZ_LIST_DISCOVERY=on): source the board from NuVizz's
  // stop LIST in one windowed pull instead of number-probing /load/info & /stop/info.
  // Coordinates are carried forward from the existing index + geocoded for new
  // addresses. The number-probe below remains the automatic FALLBACK.
  const LIST_DISCOVERY = (process.env.NUVIZZ_LIST_DISCOVERY || '').toLowerCase() === 'on';
  // Two-saved-search source (see nuvizz-list SAVED_SEARCHES): one ACTIVE pull
  // (planned+unplanned) + one COMPLETED pull (delivered/unable-to-deliver, updated
  // today), merged and bucketed by date. OFF = the legacy per-day single query.
  const TWO_SCAN = (process.env.NUVIZZ_TWO_SCAN || '').toLowerCase() === 'on';
  // Enrichment: one /stop/info per NEW PRO (the list gives us exact PRO #s, so these
  // are direct calls). Enriched detail (real coords, line items, contact, schedule)
  // is carried forward via the index, so each PRO is enriched ONCE; as orders arrive
  // through the day each scan only enriches the increment, spreading the calls. ON by
  // default; cap is per-scan (default 10000 = no real throttle).
  const ENRICH = (process.env.NUVIZZ_ENRICH || '').toLowerCase() !== 'off';
  // Load-ID anchor (NUVIZZ_LOAD_ANCHOR=on; default OFF): pull the day's authoritative
  // load roster (PkgRoute list, unique per-day loadIds) and drop board stops carrying a
  // loadId that isn't in today's set — a prior-day instance of a recurring route that
  // bled in. Best-effort: a load-list failure is swallowed and the board is unchanged.
  const LOAD_ANCHOR = (process.env.NUVIZZ_LOAD_ANCHOR || '').toLowerCase() === 'on';
  const loadIdCache = new Map<string, Set<string>>();
  // Hard per-scan enrichment cap (backstop against a burst). 250 comfortably covers a
  // real day's incremental new orders (~700/day spread across many */15 scans) while
  // bounding the worst case if the registry is ever cold/unavailable — a cold board just
  // backfills over a few ticks instead of firing thousands of /stop/info at once. Was
  // 10000 (effectively unbounded), which let the registry cold-start spike to ~1,400.
  const ENRICH_MAX = Number(process.env.NUVIZZ_ENRICH_MAX_PER_SCAN) || 250;
  const ENRICH_CONC = Number(process.env.NUVIZZ_ENRICH_CONC) || 8;

  // Read today's last LOAD scan time — this is what drives the elapsed-time
  // cadence (Fix 1). Also read the shared call counter + breaker for the log line.
  let lastLoadScanAt: string | null = null;
  let dayCount = 0;
  let byRoute: Record<string, number> = {};
  let breakerState = false;
  const mode = breakerMode();
  const refreshOps = async () => {
    try { const st = await readCallStats(today); dayCount = st.count; byRoute = st.byRoute; } catch { /* best effort */ }
    try { breakerState = (await readCircuit()).open; } catch { /* best effort */ }
  };
  if (fsOn) {
    try {
      const m = (await getDoc(`nuvizz_stop_index/${TENANT}__${today}`)) as any;
      lastLoadScanAt = m?.lastLoadScanAt ?? m?.last_scanned_at ?? null;
    } catch { /* treat as never-scanned */ }
    await refreshOps();
  }

  // Live-editable schedule (Diagnostics UI → nuvizz_ops/scan_config). Best-effort and
  // clamped to safe bounds: an empty/missing doc or a read failure = the proven
  // env/default behavior. Overlaid on defaults inside scanDecision/intervalForHour.
  let scanCfg: Record<string, any> = {};
  if (fsOn) { try { scanCfg = clampScanConfig(await readScanConfig()); } catch { scanCfg = {}; } }
  if (typeof scanCfg.dailyCeiling === 'number') ceiling = scanCfg.dailyCeiling;
  // Apply the configured spend cap to the per-call breaker for THIS invocation.
  setDailyCeilingOverride(typeof scanCfg.dailyCeiling === 'number' ? scanCfg.dailyCeiling : null);

  const decision = scanDecision(now, isManual, lastLoadScanAt, scanCfg);

  // Fix 4 — exactly ONE structured line per invocation, so "why didn't it scan"
  // is answerable from the log. today/tomorrow report the DECISION's feed intent.
  // Now also carries today's NuVizz volume: total, per-route, breaker + mode.
  const fmtEl = (m: number) => (m === Infinity ? 'inf' : String(Math.round(m)));
  const fmtByRoute = (br: Record<string, number>) => {
    const parts = Object.entries(br).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`);
    return parts.length ? parts.join(',') : '-';
  };
  const no = { l: false, u: false };
  const logScan = (skip: string, act: boolean, t: { l: boolean; u: boolean }, m: { l: boolean; u: boolean }, extra = '') => {
    console.log(`[scan] trigger=${trigger} etHour=${decision.etHour} etMin=${decision.etMin} act=${act} today={loads:${t.l},unplanned:${t.u}} tomorrow={loads:${m.l},unplanned:${m.u}} lastLoadScanAt=${lastLoadScanAt || 'null'} elapsedMin=${fmtEl(decision.elapsedMin)} intervalMin=${decision.intervalMin} dayCount=${dayCount} ceiling=${ceiling} mode=${mode} breaker=${breakerState} byRoute=${fmtByRoute(byRoute)} skip=${skip}${extra}`);
  };

  const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  // Kill switch (Fix 5: record halted state for the UI banner). Honors BOTH the env
  // kill switch and the UI master toggle (scan_config.scansEnabled === false).
  if (!scansEnabled() || scanCfg.scansEnabled === false) {
    if (fsOn) { try { await markScanState(TENANT, today, { halted: true, reason: 'killswitch', since: now.toISOString() }); } catch { /* */ } }
    logScan('killswitch', false, no, no);
    return json({ ok: true, skipped: 'scans-disabled' });
  }

  if (!fsOn) {
    logScan('error', false, no, no, ' msg=FIREBASE_SA-not-set');
    return json({ ok: false, error: 'FIREBASE_SA not set' });
  }

  // Circuit breaker — daily ceiling reached (Fix 5: record halted state).
  if (await breakerTripped()) {
    try { await markScanState(TENANT, today, { halted: true, reason: 'ceiling', since: now.toISOString() }); } catch { /* */ }
    logScan('ceiling', false, no, no);
    return json({ ok: true, skipped: 'circuit-open' });
  }

  const results: any[] = [];

  // Capture a date's FULL load roster (incl. empty loads not yet filled with orders) into the
  // cache the Loads view reads. A FUTURE date's roster is captured ONCE per scan day — tomorrow's
  // load SET is fixed once it exists (per Chad), so there's nothing to re-pull all day. But the
  // capture only COUNTS when it actually carries load NUMBERS (futureRosterCaptured): the Jul 1
  // 2026 board froze because that morning's capture ran before the Load-Number parser fix (#336),
  // wrote rows with zero numbers, and the old "non-empty → done" dedup kept the number-less
  // snapshot all day (every evening reorder/unplan Save refused "needs a load number"). Empty OR
  // number-less → keep re-pulling each acting cycle until a numbered roster lands, then stop for
  // the day (steady state: 1 cheap PkgRoute list call/day; the manual Refresh button (?live=1)
  // remains the on-demand override). Today's roster refreshes each load-scan as before.
  // Best-effort: a hiccup is logged, never affects the scan.
  const persistLoadRoster = async (date: string, scannedAt: string) => {
    if (!fsOn) return;
    try {
      if (date !== today) {
        const cached = await readLoadRoster(TENANT, date).catch(() => null);
        if (futureRosterCaptured(cached, new Date())) return;
      }
      const roster = await loadRosterForDate(date);
      await writeLoadRoster(TENANT, date, roster, scannedAt);
      console.log(`[scan] load-roster ${date}: cached ${roster.length} load(s)${date !== today ? ' (next-day, once/day once numbered)' : ''}`);
    } catch (e: any) { console.warn(`[scan] load-roster ${date} skipped: ${e?.message}`); }
  };

  // Next-business-day empty-loads roster — captured once per scan day, re-tried each acting
  // cycle only until a NUMBERED roster lands (see persistLoadRoster; steady state 1 cheap
  // PkgRoute list call/day). DECOUPLED from the next-day LOAD *scan*, which is 8pm-gated to
  // avoid the expensive load-number probe — the roster is the cheap list endpoint, so
  // tomorrow's empty/Draft loads (and their real load NUMBERS, which Saves are keyed by) are
  // on the board all day. That is what lets the dispatcher build TOMORROW's routes TODAY.
  // Runs on any acting scan >=6am ET.
  if (decision.act && fsOn && decision.etHour >= 6) {
    const rosterAt = new Date().toISOString();
    for (const d of scanDates.slice(1)) await persistLoadRoster(d, rosterAt);
  }

  // scanAndWrite — one date. includeUnplanned gates the order descent; `forced`
  // (manual/explicit) bypasses the per-date min-interval floor; manual caps the
  // unplanned descent lower so the synchronous endpoint finishes in time.
  const scanAndWrite = async (date: string, includeUnplanned: boolean, forced: boolean, includeLoads = true) => {
    const t0 = Date.now();
    try {
      if (!forced) {
        const metaDoc = await getDoc(`nuvizz_stop_index/${TENANT}__${date}`);
        if (metaDoc && !scanIntervalElapsed(metaDoc.last_scanned_at, Date.now())) {
          results.push({ date, ok: true, skipped: 'min-interval', ms: Date.now() - t0 });
          return;
        }
      }
      // Read this date's existing roster ONCE — used for BOTH Phase 2 lean planning
      // (as the current known-active set) and the Phase 1 shadow write below.
      const priorState = (includeLoads || FORWARD_SCAN) ? await readScanState(date, TENANT) : null;

      // Phase 2 (gated by NUVIZZ_LEAN_DISCOVERY=on): probe only known-active loads +
      // forward buffer + periodic gap sweep instead of the ±window. null plan ⇒
      // leave loadTargets undefined ⇒ scanDate falls back to the wide window.
      // R10: a MANUAL scan bypasses lean entirely (wide window + full unplanned
      // floor) so a human "refresh" is always the authoritative full re-scan.
      // FORWARD_SCAN takes precedence over lean (mutually exclusive load strategies).
      let loadTargets: number[] | null = null;
      if (!FORWARD_SCAN && LEAN_DISCOVERY && includeLoads && !isManual) {
        try {
          const plan = selectLoadProbeTargets(priorState, {
            inWindow: isInRoutingWindow(decision.etHour, scanCfg),
            scanCount: priorState?.scanCount || 0,
            fwdIn: 50, fwdOut: 10, gapSweepEvery: 3,
          });
          if (plan) {
            loadTargets = plan.numbers;
            console.log(`[scan-lean] date=${date} mode=${plan.mode} probe=${plan.numbers.length} active=${plan.activeLoads} buffer=${plan.forwardBuffer} gapSweep=${plan.gapSweep}`);
          } else {
            console.log(`[scan-lean] date=${date} mode=cold-fallback (no roster yet) → wide window`);
          }
        } catch (e: any) { console.warn(`[scan-lean] ${date} planning failed, wide window: ${e?.message}`); }
      }

      // Phase 1 (shadow): capture the load-number window THIS cycle is about to
      // probe BEFORE scanDate calibrates the in-memory cache (serverless runs are
      // almost always cold → this is the real ~600-wide window). Only meaningful
      // when NOT using lean targets.
      const preRange = (includeLoads && !loadTargets) ? estimateLoadRange(date) : null;
      // Phase 3 lean unplanned: only on a WARM cycle (we have a roster + high-water);
      // descend only NEW stop numbers above the last high-water. Cold cycles do the
      // full descent (establishes the high-water), same as the wide load fallback.
      const leanUnplanned = LEAN_DISCOVERY && includeUnplanned && !!loadTargets && (priorState?.highWaterUnplannedStopNbr != null);
      const DEEP_SWEEP_HOURS = scanCfg.deepSweepHours ?? (Number(process.env.NUVIZZ_DEEP_SWEEP_HOURS) || 8);
      const DEEP_SWEEP_CHUNKS = Number(process.env.NUVIZZ_DEEP_SWEEP_CHUNKS) || 25;

      // Adaptive forward seeds (NUVIZZ_FORWARD_SCAN). Loads: re-pull today's
      // known-active loads + walk forward from the max known load number. Orders:
      // walk forward from the unplanned high-water. Both seeds carry ACROSS days
      // when today has no roster yet (cold/resumption) so the Sunday post-blackout
      // fire is a cheap forward walk, NOT a cold wide rescan.
      let forwardLoad: { start: number; known?: number[] } | null = null;
      let forwardUnplanned: { start: number } | null = null;
      let resumption = false;
      if (FORWARD_SCAN && !isManual) {
        const carried = await readRecentFrontier(TENANT, date, 4)
          .catch(() => ({ maxLoadNbr: null, maxStopNbr: null, maxUnplannedStopNbr: null, carriedLoadNbrs: [] as number[] }));
        const todayCold = !(priorState && (priorState.knownLoads?.length || 0) > 0);
        resumption = todayCold && (carried.maxLoadNbr != null || carried.maxStopNbr != null || carried.maxUnplannedStopNbr != null);
        if (includeLoads) {
          const start = priorState?.maxLoadNbr ?? carried.maxLoadNbr ?? null;
          if (start != null) {
            const todayKnown = (priorState?.knownLoads || []).filter((k) => !k.allTerminal)
              .map((k) => loadNbrInt(k.loadNbr)).filter((n): n is number => n != null);
            // Also re-pull recent NON-TERMINAL loads from prior days — a carryover /
            // earlier-started route can still deliver stops today; forward-only would
            // miss it (it's below the frontier). probeLoad keeps just its today-stops.
            const known = [...new Set([...todayKnown, ...(carried.carriedLoadNbrs || [])])];
            forwardLoad = { start, known };
          }
        }
        if (includeUnplanned) {
          const ustart = priorState?.highWaterUnplannedStopNbr ?? carried.maxUnplannedStopNbr ?? carried.maxStopNbr ?? null;
          if (ustart != null) forwardUnplanned = { start: ustart };
        }
      }

      // DEEP SWEEP — periodic FULL-floor descent (relaxed early-stop) that catches
      // low advance-order stragglers / date-changed orders the frontier floor or the
      // forward walk skip. Runs in lean OR forward mode, never on a MANUAL run, and
      // never on the cold RESUMPTION fire (that one must stay cheap — and nothing
      // changed below the frontier over the weekend anyway; a due sweep runs on the
      // next warm cycle instead).
      // No-spike morning open: the deep sweep is the only FULL-floor descent (~2k
      // probes), and shouldDeepSweep() returns true on a cold day — so without a guard
      // the very FIRST unplanned cycle (the 10am open, when there are <~100 new orders)
      // would full-sweep and spike. deepSweepGate holds it back to a WARM cycle (today's
      // unplanned high-water already set by the cheap forward walk) at/after an off-peak
      // ET hour (NUVIZZ_DEEP_SWEEP_HOUR, default 13:00), so the open ramps up gently and
      // the one daily reconciliation lands in the afternoon lull.
      const DEEP_SWEEP_HOUR = scanCfg.deepSweepHour ?? (Number(process.env.NUVIZZ_DEEP_SWEEP_HOUR) || 13);
      const deepSweep = (LEAN_DISCOVERY || FORWARD_SCAN) && includeUnplanned && !isManual && !resumption
        && deepSweepGate({
          due: shouldDeepSweep(priorState?.lastDeepSweepAt, Date.now(), DEEP_SWEEP_HOURS * 3600_000),
          todayUnplannedWarm: priorState?.highWaterUnplannedStopNbr != null,
          etHour: decision.etHour,
          offPeakHour: DEEP_SWEEP_HOUR,
        });
      // A deep sweep is the authoritative full re-baseline → drop forward/lean and
      // probe the full load window + full unplanned floor.
      if (deepSweep) { forwardLoad = null; forwardUnplanned = null; loadTargets = null; }

      const unplannedOpts: any = {};
      if (isManual && includeUnplanned) unplannedOpts.maxProbes = 800;
      // Lean frontier floor (bounded on the UNPLANNED high-water) — but NOT on a
      // deep sweep, which must descend the full floor.
      if (leanUnplanned && !deepSweep) unplannedOpts.sinceStopNbr = priorState!.highWaterUnplannedStopNbr;
      if (deepSweep) unplannedOpts.postTargetChunks = DEEP_SWEEP_CHUNKS;
      const scan = await scanDate(date, {
        includeUnplanned,
        includeLoads,
        loadTargets,
        forwardLoad,
        forwardUnplanned,
        unplanned: Object.keys(unplannedOpts).length ? unplannedOpts : undefined,
      });
      // partial* : in lean mode we re-pulled only a SUBSET of each feed — tell
      // writeStops to PRESERVE the stops it didn't re-scan (terminal loads /
      // older still-unplanned orders) so lean never prunes already-known stops.
      // R1: tell writeStops which load NUMBERS we actually re-pulled this lean cycle
      // so it can prune a stop removed from a re-scanned load (vs preserving stops on
      // loads we didn't touch). Only meaningful in lean mode (loadTargets set).
      // partialUnplanned = PRESERVE un-rescanned unplanned (don't prune). True when:
      //  • a lean frontier cycle (we only scanned above the high-water), OR
      //  • the descent was TRUNCATED (cap/budget/breaker) — it didn't reach the
      //    floor, so anything below the truncation point that we DIDN'T see must be
      //    preserved, never pruned (else a truncated full/deep descent would delete
      //    still-valid low unplanned orders). Only a COMPLETE full descent prunes.
      const truncatedDescent = includeUnplanned && scan.descentComplete === false;
      // Forward + lean both re-pulled only a SUBSET → PRESERVE un-rescanned stops
      // (never prune). Only a COMPLETE full descent / deep sweep prunes.
      const partialUnplanned = (leanUnplanned && !deepSweep) || !!forwardUnplanned || truncatedDescent;
      const partialLoads = !!loadTargets || !!forwardLoad;
      const meta = await writeStops(TENANT, date, scan.stops, scan.scannedAt, { includeUnplanned, includeLoads, partialLoads, partialUnplanned, rescannedLoads: loadTargets || undefined });
      // Only rebuild the fleet (load) index when we actually scanned loads — an
      // unplanned-only run would otherwise wipe the load index with an empty scan.
      if (includeLoads) {
        const fleet = deriveFleetSummary(scan.stops, scan.loadHeaders);
        await writeFleetIndex(TENANT, date, fleet.loads, fleet.summary, fleet.driverIndex, scan.scannedAt);
        // Cache the date's empty-loads roster too (once/day for a future date).
        await persistLoadRoster(date, scan.scannedAt);
      }
      // Phase 1 (shadow mode): persist scan_state + log what lean discovery WOULD
      // probe (known-active loads + buffer) vs the wide window we ACTUALLY probed.
      // NO probing change yet — this de-risks Phase 2. Best-effort; never fails a scan.
      if (includeLoads) {
        try {
          const state = buildScanState(date, scan.stops, priorState, scan.scannedAt, {
            descentComplete: scan.descentComplete,
            observedFrontierStopNbr: scan.observedFrontierStopNbr,
            // Stamp the deep-sweep time whenever a sweep RAN (not gated on
            // completeness): a truncated sweep still covered most of the band, and
            // gating on completeness would loop every cycle into a deep sweep if it
            // kept truncating — a cost blowup. Persistent truncation shows as
            // descentComplete=false in the logs (a tuning signal), not a loop.
            deepSweepRan: deepSweep,
          });
          await writeScanState(date, state, TENANT);
          const inWindow = isInRoutingWindow(decision.etHour, scanCfg);
          const wp = shadowWouldProbe(state, { inWindow, fwdIn: 50, fwdOut: 10 });
          const windowSize = preRange ? (preRange.endNbr - preRange.startNbr + 1) : (loadTargets ? loadTargets.length : null);
          console.log(`[scan-shadow] date=${date} lean=${!!loadTargets} knownLoads=${state.knownLoads.length} active=${wp.activeLoads} terminal=${wp.terminalLoads} routes=${Object.keys(state.routeMap).length} minLoad=${state.minLoadNbr} maxLoad=${state.maxLoadNbr} highWaterStop=${state.highWaterStopNbr} inWindow=${inWindow} WOULD_PROBE_LOADS=${wp.wouldProbe} (active=${wp.activeLoads}+buffer=${wp.forwardBuffer}) PROBED=${windowSize} scanCount=${state.scanCount}`);

          // ── Step 1 parity (SHADOW; logging only — lean/frontier remain OFF) ──
          // Set-membership comparison: what lean WOULD have probed from the PRIOR
          // roster vs what the wide scan actually found. This is the real
          // "would lean miss something?" gate. Self-contained try/catch so a
          // parity bug can never affect the scan or the state write above.
          try {
            const foundLoads = [...new Set(
              scan.stops.filter((s: any) => s.isPlanned && s.loadNbr)
                .map((s: any) => loadNbrInt(s.loadNbr)).filter((n: any): n is number => n != null),
            )];
            const leanPlan = selectLoadProbeTargets(priorState, {
              inWindow, scanCount: priorState?.scanCount || 0, fwdIn: 50, fwdOut: 10, gapSweepEvery: 3,
            });
            const lp = loadProbeParity(leanPlan ? leanPlan.numbers : null, foundLoads);

            const foundUnplanned = scan.includeUnplanned
              ? [...new Set(scan.stops.filter((s: any) => s.isPlanned === false)
                  .map((s: any) => stopNbrInt(s.stopNbr)).filter((n: any): n is number => n != null))]
              : [];
            const hwu = priorState?.highWaterUnplannedStopNbr ?? null;
            const floor = (scan.includeUnplanned && hwu != null)
              ? unplannedFloor(estimateStopFrontier(date) - FLOOR_MARGIN, hwu) : null;
            const fp = frontierParity(floor, foundUnplanned, priorState?.unplannedStopNbrs);

            const mem = loadMembershipDelta(priorState?.loadMembers, groupLoadMembers(scan.stops));
            const dmax = (state.maxLoadNbr != null && priorState?.maxLoadNbr != null)
              ? state.maxLoadNbr - priorState.maxLoadNbr : null;
            const dateAudit = scan.includeUnplanned
              ? dateSliceMismatch(scan.stops.filter((s: any) => s.isPlanned === false).map((s: any) => s.scheduledFrom), date)
              : { mismatch: 0, unauditable: 0 };

            console.log(`[scan-parity] date=${date} loadMode=${lp.mode} foundLoads=${lp.foundCount} leanTargets=${lp.targetCount} MISSED_LOADS=${JSON.stringify(lp.missed)} emptyProbed=${lp.extra.length} | frontierFloor=${fp.floor ?? 'na'} foundUnplanned=${fp.foundCount} BELOW_FLOOR_NEW=${JSON.stringify(fp.belowFloorNew)} belowFloorKnown=${fp.belowFloorKnown.length} | LOAD_REMOVED=${mem.removed.length} LOAD_ADDED=${mem.added.length} | dMaxLoad=${dmax ?? 'na'} dateSliceMismatch=${dateAudit.mismatch} dateUnauditable=${dateAudit.unauditable} descentComplete=${scan.descentComplete ?? 'na'} deepSweep=${deepSweep}`);
            // Learning instrumentation: record this scan's real load delta + worst
            // gap so we can size the adaptive forward-walk from evidence. Today only
            // (the date the dispatcher actually works); best-effort.
            if (date === today) {
              await recordScanMetric({
                date, at: etDayString() + ' ' + new Date().toISOString().slice(11, 16),
                foundLoads: lp.foundCount,
                newLoads: dmax,
                maxGap: maxConsecutiveGap(foundLoads),
                windowProbed: windowSize,
                lean: !!loadTargets,
                missed: lp.missed.length,
              });
            }
            if (lp.missed.length) console.warn(`[scan-parity] date=${date} ⚠ LEAN WOULD MISS LOADS ${JSON.stringify(lp.missed)}`);
            if (fp.belowFloorNew.length) console.warn(`[scan-parity] date=${date} ⚠ FRONTIER WOULD MISS NEW UNPLANNED ${JSON.stringify(fp.belowFloorNew.slice(0, 20))}${fp.belowFloorNew.length > 20 ? ' …' : ''}`);
            if (mem.removed.length) console.log(`[scan-parity] date=${date} off-load removals=${JSON.stringify(mem.removed.slice(0, 20))}`);
          } catch (e: any) { console.warn(`[scan-parity] ${date} failed: ${e?.message}`); }
        } catch (e: any) { console.warn(`[scan-shadow] ${date} failed: ${e?.message}`); }
      }
      // CS notify — email customer service the first time a "notify_cs"-flagged
      // customer appears on this date's board (deduped per delivery date). Fully
      // best-effort; a mail failure never affects the scan.
      try {
        const n = await notifyMarkedCustomers(date, scan.stops);
        if (n.matched) console.log(`[cs-notify] date=${date} matched=${n.matched} sent=${n.sent} failed=${n.failed}${n.skipped ? ` skipped=${n.skipped}` : ''}`);
      } catch (e: any) { console.warn(`[cs-notify] ${date} failed: ${e?.message}`); }
      results.push({ date, ok: true, ms: Date.now() - t0, includeUnplanned, includeLoads, count: meta.count, planned: meta.plannedCount, unplanned: meta.unplannedCount });
    } catch (e: any) {
      results.push({ date, ok: false, ms: Date.now() - t0, error: e?.message });
    }
  };

  // Ops/testing path: ?date=… or ?days=N → full scan (loads + unplanned), forced.
  if (explicit) {
    let dates: string[];
    if (dateParam) dates = [dateParam];
    else { const n = Math.max(1, Math.min(31, parseInt(daysParam || '', 10) || DEFAULT_DAYS)); dates = scanDatesFrom(etDayString(), n); }
    for (const date of dates) await scanAndWrite(date, true, true);
    await refreshOps();
    logScan('none', true, { l: true, u: true }, { l: true, u: true });
    return json({ ok: true, tenant: TENANT, mode: 'explicit', totalMs: Date.now() - startedAt, dates: results });
  }

  // Cadence gate (Fix 1: elapsed-time, not wall-clock minute).
  if (!decision.act) {
    logScan(decision.skip, false, no, no);
    return json({ ok: true, skipped: decision.skip, reason: decision.reason });
  }

  // ── PRIMARY: list-discovery, EXCLUSIVE (no number-probe) ─────────────────────
  // When on, the board is sourced ONLY from NuVizz's stop list (one pull/day), with
  // geocoded/carried-forward coords. The old number-probe NEVER runs here. Safety:
  // an empty/failed pull writes nothing for that date, so the last-good board is
  // preserved (stale, never blank) — per Chad's call we'd just fix-forward if the
  // list endpoint ever changes, rather than fall back to the expensive probe.
  if (LIST_DISCOVERY) {
    try {
      const scannedAt = new Date().toISOString();
      const targets = [today];
      // Tomorrow + further planning days (LIST_HORIZON_DAYS) — all sliced from the SAME ±7d pull,
      // so e.g. Sunday writes Mon AND Tue. Gated by the same decision so far-day work only runs
      // once the next-day window opens (loads/orders exist by then).
      if (decision.scanTomorrowLoads || decision.scanTomorrowUnplanned) {
        for (const d of scanDates.slice(1)) targets.push(d);
      }
      // Two-scan mode pulls both saved searches ONCE up front (not per target day) and
      // buckets by date; a fetch failure throws → outer catch preserves the last-good board.
      const buckets = TWO_SCAN ? await twoScanBuckets() : null;
      // Snapshot the CURRENT live unplanned stop-number set (across the whole ±7d pull) so the
      // read-time carry-over fold-in can drop prior-day stops that have since been delivered/
      // planned (they vanish from the active search → not in this set). Zero extra calls. The
      // window the active search reaches back is ~7 days (NUVIZZ_ACTIVE_ARRIVAL '+/-7d'), so
      // carry-over only trusts the filter for days >= windowStart. Best-effort.
      if (TWO_SCAN && buckets) {
        try {
          const live = new Set<string>();
          for (const stops of buckets.values()) for (const s of stops) if (s.isUnplanned && s.stopNbr) live.add(String(s.stopNbr));
          const windowStart = addDaysUTC(today, -7);
          await writeActiveUnplannedSet(TENANT, { at: scannedAt, windowStart, stopNbrs: [...live] });
        } catch (e: any) { console.warn(`[scan] active-set snapshot skipped: ${e?.message}`); }
      }
      // FINISHED rows across the WHOLE pull, keyed by stopNbr regardless of bucket day. A stop
      // delivered while running as rolled-over work buckets under its (stale) past arrival day —
      // which is never a write target — while today's board (where the clamp had filed the OPEN
      // stop) would re-carry the stale open snapshot forever. The carry-forward below consults
      // this map so the terminal state lands on the board that was actually showing the stop.
      const finishedByNbr = new Map<string, any>();
      if (TWO_SCAN && buckets) {
        for (const stops of buckets.values()) for (const s of stops) {
          if (s.stopNbr && (s.normalizedStatus === 'DELIVERED' || s.normalizedStatus === 'EXCEPTION')) finishedByNbr.set(String(s.stopNbr), s);
        }
      }
      for (const date of targets) {
        // Two-scan: this day's slice of the merged active+completed pull (board keys are
        // UTC, the saved searches bucket by ET arrival date — map across the frames).
        // Legacy: per-day pull, ET-adjusted period (one request; entity page doesn't paginate).
        let dateStops = TWO_SCAN
          ? (buckets!.get(etDateForTargetUTC(date, today)) || []).map((s) => { s.scheduledDate = date; return s; })
          : await listScanForDate(date);
        if (!dateStops.length) { results.push({ date, ok: true, skipped: 'list-empty', source: 'list' }); continue; }

        // This day's prior index — carries same-day enriched detail forward + seeds coords.
        // Cross-day "already enriched" memory lives in the per-PRO registry (below), not here.
        const prevByNbr = new Map<string, any>();
        try {
          const prev = await readStops(TENANT, date);
          for (const p of (prev?.stops || [])) prevByNbr.set(String(p.stopNbr), p);
        } catch { /* no prior index */ }

        // Two-scan carry-forward: the two saved searches only cover open (20,10) and
        // finished (90,91,80) stops, so a stop mid-flight (in-transit/arrived) momentarily
        // matches NEITHER. Re-add any stop already on this day's board that's absent from
        // this scan, keeping its last-known state, so the live board never loses a stop
        // between status flips. (Firestore holds prior days; this protects the current one.)
        //
        // BOARD-DAY GUARD: only carry a stop forward if it actually belongs to THIS board's
        // day (boardDayFor === this board's ET date). Without it, the carry-forward re-added
        // EVERY stop from a board's prior index regardless of day, so once a stop landed on
        // the wrong day it was re-added every scan forever — that snowball was filing all of
        // today's ~700 deliveries onto tomorrow's board (and triggering their re-enrichment).
        // Wrong-day stays out of dateStops → the full writeStops below prunes it, self-healing
        // an already-polluted index on the next scan.
        const boardEtDate = TWO_SCAN ? etDateForTargetUTC(date, today) : date;
        if (TWO_SCAN) {
          const have = new Set(dateStops.map((s) => String(s.stopNbr)));
          let dropped = 0;
          for (const [nbr, p] of prevByNbr) {
            if (have.has(nbr)) continue;
            if (boardDayFor(p) !== boardEtDate) { dropped++; continue; } // belongs to another day
            // The stop lived on THIS board while open, and the pull now shows it FINISHED under a
            // stale past arrival day (rolled-over work delivered today). File the finished row HERE
            // — pinned to this board's day so it stays — instead of re-carrying the open snapshot,
            // which froze such stops as open forever and lost the delivery entirely.
            const fin = finishedByNbr.get(nbr);
            if (fin) { dateStops.push({ ...fin, boardDate: boardEtDate, scheduledDate: date }); continue; }
            dateStops.push(p);
          }
          if (dropped) console.log(`[scan] ${date}: carry-forward dropped ${dropped} wrong-day stop(s) (board=${boardEtDate})`);
        }
        const seed = new Map<string, { lat: number; lng: number }>();
        const toEnrich: any[] = [];
        for (const s of dateStops) {
          const p = prevByNbr.get(String(s.stopNbr));
          if (p) {
            if (p.enriched) mergeEnrich(s, p); // carry same-day enriched detail forward
            // A recent CONFIRMED live Save (write-through, #361) outranks a lagging list row:
            // hold the confirmed plan fields until the list agrees or the grace expires.
            applyBoardWriteGrace(s, p, Date.now());
            if (typeof p.lat === 'number' && typeof p.lng === 'number') { const k = addrKey(p); if (k) seed.set(k, { lat: p.lat, lng: p.lng }); }
          }
          // Status AND the delivery time are FREE & live from the list every scan (see
          // LIVE_LIST_FIELDS + toBoardStop's deliveredDTTM), so we do NOT spend a /stop/info
          // call to track delivery. We enrich a PRO exactly ONCE — when it first appears — for
          // the static detail (line items, coords, contact, …); the list keeps status/delivery
          // current thereafter. POD photos are pulled ON DEMAND when a stop is opened (a single
          // /stop/info + documentapi fetch keyed by the clicked PRO), never in the background,
          // so a delivery costs zero scheduled calls.
          // We do NOT re-enrich already-enriched stops to backfill newer fields (full notes,
          // stopId) — those load ON DEMAND when a dispatcher opens the stop (the card's Refresh
          // / timeline), keeping background calls minimal (dispatcher's choice). New orders get
          // the fields on their first (and only) enrichment.
          if (!s.enriched) toEnrich.push(s);
        }

        // Per-PRO enrichment registry (day-independent): before spending a /stop/info, check
        // the registry for any PRO not already enriched via a recent day-board. A PRO ever
        // enriched (on ANY day) is carried forward and NEVER re-pulled — only a manual Refresh
        // or a timeline open re-fetches it. Targeted reads (just the candidate set).
        // FAIL-SAFE: if the registry read THROWS (Firestore hiccup), we must NOT fall through
        // and re-enrich every candidate — that's how a transient blip turned into a ~700-call
        // /stop/info burst. A failed read = we can't prove a PRO is new, so we skip enrichment
        // this cycle entirely and retry next scan. Under-enriching for one tick is harmless;
        // bursting the vendor is not.
        let regOk = true;
        let regUnresolved = new Set<string>();
        if (ENRICH && toEnrich.length) {
          try {
            const reg = await readEnrichedPros(TENANT, toEnrich.map((s) => String(s.stopNbr)));
            regUnresolved = reg.unresolved;
            if (reg.found.size) for (const s of toEnrich) { const r = reg.found.get(String(s.stopNbr)); if (r) mergeEnrich(s, r); }
            if (regUnresolved.size) console.warn(`[scan] ${date}: registry read could not resolve ${regUnresolved.size} PRO(s) after retries; SKIPPING those this cycle (retry next scan, never re-enrich on a read error)`);
          } catch (e: any) { regOk = false; console.warn(`[scan] ${date}: enrichment registry read failed (${e?.message}); SKIPPING enrichment this cycle to avoid a burst`); }
        }
        // Enrichment: one direct /stop/info per genuinely-new PRO (bounded concurrency, capped).
        // The hard per-scan cap (ENRICH_MAX) is a backstop: even a cold/empty registry can never
        // burst more than ENRICH_MAX calls in one scan — a cold board backfills over a few ticks.
        // A registry read that ERRORED for a PRO (regUnresolved) is treated as UNKNOWN, not "new":
        // it is excluded here so a transient Firestore blip can never cause a re-enrichment spike.
        let enriched = 0;
        const stillNeed = (ENRICH && regOk) ? toEnrich.filter((s) => !s.enriched && !regUnresolved.has(String(s.stopNbr))) : [];
        if (stillNeed.length > ENRICH_MAX) console.warn(`[scan] ${date}: ${stillNeed.length} PROs need enrichment; capping at ENRICH_MAX=${ENRICH_MAX} this scan (rest next tick)`);
        if (ENRICH && stillNeed.length) {
          // Observability: log WHICH PROs we're about to enrich + a sample, so a future "spike"
          // is self-diagnosing (cross-check these against the registry to catch any miss).
          console.log(`[scan] ${date}: enriching ${Math.min(stillNeed.length, ENRICH_MAX)} new PRO(s) via /stop/info — sample ${JSON.stringify(stillNeed.slice(0, 10).map((s) => String(s.stopNbr)))}`);
          const batch = stillNeed.slice(0, ENRICH_MAX);
          let i = 0;
          const worker = async () => {
            while (i < batch.length) {
              const s = batch[i++];
              try { const r = await lookupStopByPro(s.stopNbr); if (r.ok && r.stop) { mergeEnrich(s, r.stop); enriched++; } } catch { /* skip; geocode fallback below */ }
            }
          };
          await Promise.all(Array.from({ length: Math.min(ENRICH_CONC, batch.length) }, worker));
          // Record the newly-enriched PROs so they're never auto-enriched again (any day).
          await writeEnrichedPros(TENANT, batch, scannedAt).catch(() => {});
        }

        // Coords: geocode any stop STILL missing coords (enrichment off / failed / capped).
        const need = dateStops.filter((s) => typeof s.lat !== 'number' || typeof s.lng !== 'number');
        if (need.length) {
          const coords = await resolveCoords(need, seed);
          for (const s of need) { const k = addrKey(s); const pt = k ? coords.get(k) : null; if (pt) { s.lat = pt.lat; s.lng = pt.lng; } }
        }

        // Load-ID anchor: drop prior-day instances of recurring routes whose loadId isn't
        // in today's authoritative load roster (one extra NuVizz call per day, cached).
        if (LOAD_ANCHOR) {
          try {
            let ids = loadIdCache.get(date);
            if (!ids) { const r = await loadIdsForDate(date); ids = r.ids; loadIdCache.set(date, ids); console.log(`[scan] load-anchor ${date}: ${r.count} loads (${r.cols} cols)`); }
            const before = dateStops.length;
            dateStops = dropForeignLoadStops(dateStops, ids, date);
            if (dateStops.length !== before) console.log(`[scan] load-anchor ${date}: dropped ${before - dateStops.length} foreign-load stops`);
          } catch (e: any) { console.warn(`[scan] load-anchor ${date} skipped: ${e?.message}`); }
        }

        const meta = await writeStops(TENANT, date, dateStops, scannedAt, { includeUnplanned: true, includeLoads: true });
        // Cache the date's empty-loads roster (once/day for a future date) so the Loads view can
        // show e.g. Monday's empty loads without a per-request live fetch.
        await persistLoadRoster(date, scannedAt);
        results.push({ date, ok: true, source: 'list', count: meta.count, planned: meta.plannedCount, unplanned: meta.unplannedCount, enriched, newPros: stillNeed.length });
      }
    } catch (e: any) {
      // List-only: do NOT fall back to the number-probe; preserve the existing index.
      console.warn(`[scan] list-discovery error (${e?.message}); preserving last-good board (list-only, no number-probe)`);
      results.push({ ok: false, source: 'list', error: e?.message });
    }
    await refreshOps();
    logScan('none', decision.act, { l: true, u: true }, { l: decision.scanTomorrowLoads, u: decision.scanTomorrowUnplanned }, ' src=list-only');
    return json({ ok: true, tenant: TENANT, mode: isManual ? 'manual' : 'scheduled', source: 'list', decision, totalMs: Date.now() - startedAt, dates: results });
  }

  // Today: loads always; orders inside the 10am-midnight window.
  await scanAndWrite(today, decision.scanTodayUnplanned, isManual, true);
  // Tomorrow (Fix 2): descend orders 10am-midnight, but only scan tomorrow's LOADS
  // 8pm-midnight (they don't exist earlier) — avoids ~13 empty load scans/day.
  if (decision.scanTomorrowLoads || decision.scanTomorrowUnplanned) {
    await scanAndWrite(tomorrow, decision.scanTomorrowUnplanned, isManual, decision.scanTomorrowLoads);
  }

  await refreshOps();
  logScan('none', true,
    { l: true, u: decision.scanTodayUnplanned },
    { l: decision.scanTomorrowLoads, u: decision.scanTomorrowUnplanned });
  return json({ ok: true, tenant: TENANT, mode: isManual ? 'manual' : 'scheduled', decision, totalMs: Date.now() - startedAt, dates: results });
}
