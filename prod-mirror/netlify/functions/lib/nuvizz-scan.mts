// lib/nuvizz-scan.mts
//
// Shared NuVizz scan + normalization logic. Extracted from
// nuvizz-pull-today-stops.mts (M5.2) so it can be reused by the scheduled
// background writer (nuvizz-refresh-stops-background.mts) and any debug path.
//
// NuVizz v7 has NO bulk "list stops for a date" endpoint — every list-style
// endpoint demands a per-record id (verified live 2026-05-26: /stop/eventinfo
// → 400 needs stopNbr, /stop/info/customer → 400 needs custAccNbr,
// /event/eventactivity → 400 needs entityId, /load/static/info → 501). So the
// only way to discover a day's stops is to scan the number space:
//   • PLANNED stops: probe a load-number range via /load/info and flatten stops.
//   • UNPLANNED stops (status-10, not yet routed): probe the /stop/info number
//     space, since unplanned orders never appear under any load.
// This is why the scan must run in a 15-min background function, not inline
// (inline load+unplanned scan = >22s, exceeds the 26s request cap → 502).
//
// Phase 4: every probe routes through the shared request wrapper
// (getNuvizzRequester) so it is counted against the fleet-wide daily ceiling and
// short-circuited by the circuit breaker.

import { getNuvizzRequester } from './nuvizz-request.mts';
import type { ScanState, KnownLoad } from './firestore.mts';
import { readTerminalStops, mergeTerminalStops } from './firestore.mts';

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

export interface SignalSources {
  addressLine2: string | null;
  orderInstructions: string | null;
}

// One NuVizz stop comment, surfaced VERBATIM for the stop card's notes panel (the portal's
// "Driver Instruction" list). Unlike orderInstructions (filtered to ORD_IN/SPL-INSTR-TEXT)
// this carries EVERY comment with its type, author and time so the card can show them all.
export interface StopComment {
  text: string;
  type: string | null;          // cmtType (e.g. ORD_IN) or legacy commentType code
  typeDesc: string | null;      // commentTypeDescription (human label)
  addedBy: string | null;       // addedByName
  addedOn: string | null;       // addedOn (yyyy-MM-ddTHH:mm:ss)
  access: string[];             // accessLevels (DISPATCHER/DRIVER/CUSTOMER)
  source: string | null;        // origin company (e.g. ULINE / DAVIS DELIVERY)
}

// One activity-timeline event for a stop (the portal's "Activity Timeline"). From NuVizz's
// /event/eventinfo (rich: carries user + company) or /stop/eventinfo (lean: no user/company).
export interface StopEvent {
  code: string | null;          // eventCode
  name: string | null;          // eventName (e.g. "Stop Planned", "Stop Departure")
  dttm: string | null;          // eventDTTM (yyyy-MM-ddTHH:mm:ss)
  user: string | null;          // userName — the "By:" actor (rich endpoint only)
  company: string | null;       // companyName — the "From:" company (rich endpoint only)
  routeName: string | null;     // routeName (rich endpoint, STOP entity)
  lat: number | null;
  lng: number | null;
}

export interface NormalizedStop {
  pro: string | null;
  pros: string[];
  primaryPro: string | null;
  proCount: number;
  // Raw NuVizz shipment number. Normally equals stopNbr (RESEARCH-parent-app-endpoints:
  // "stop.shipmentNbr always equals stopNbr"). When a delivery fails, Davis customer
  // service prepends "ATT" to the SHIPMENT number (e.g. stopNbr 007137828 →
  // shipmentNbr ATT007137828) and unplans it — so an ATT prefix here is the
  // authoritative re-delivery-attempt marker, while stopNbr stays clean (the stable
  // key that joins an attempt back to the morning routed-plan snapshot).
  shipmentNbr: string | null;
  isAttempt: boolean; // shipmentNbr carries the "ATT" re-attempt marker (see isAttemptShipment).
  stopNbr: string | null;
  stopId: string | null;            // NuVizz system stop id (stop.stopId) — entityId for /event/eventinfo (activity timeline).
  loadNbr: string | null;
  loadStopSeq: number | null;
  routeSeq: number | null;          // M5.3 — NuVizz's authoritative route stop sequence (stop.to.seq). 1..N over physical stops; co-located orders share a number. This is the Route Workbench order, present even before ETAs exist (loadStopSeq is only array order — unreliable).
  stopType: string | null;
  status: string | null;
  businessName: string | null;
  addr1: string | null;
  addr2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  scheduledFrom: string | null;
  scheduledTo: string | null;
  cartons: number | null;
  pallets: number | null;
  volume: number | null;            // loose-piece count (Davis records loose pieces in NuVizz `volume`).
  weight: number | null;
  // Bill-of-Lading header fields (NuVizz field → BOL label):
  bol: string | null;               // BOLID
  orderNbr: string | null;          // Order#  (NuVizz laneNumber)
  terms: string | null;             // Terms   (NuVizz scheduleAttribute, e.g. PREPAID)
  warehouse: string | null;         // Whse    (NuVizz proNumber, e.g. G6)
  custRef: string | null;           // Cust#   (NuVizz reference2)
  poRef: string | null;             // PO      (NuVizz reference1)
  billTo: any;                      // bill-to party block (name/addr/city/state/zip)
  itemsSummary: string;
  customerAccount: string | null;
  driverName: string | null;
  routeName: string | null;         // M5.2.1 — human-readable route name (e.g. "DULUTH"). From loadHeader.routeName.
  driverUserName: string | null;
  isTerminal: boolean;
  isUnplanned: boolean;
  isPlanned: boolean;     // M5.2 — came from a load scan (routed) vs the unplanned number-space scan.
  normalizedStatus: StopStatusKind; // M5.1 — execution-lifecycle bucket for marker/sidebar.
  arrivalDTTM: string | null;       // M5.1 — actual on-site time, when present.
  deliveredDTTM: string | null;     // M5.1 — actual completion time, when present.
  podDocs: PodDoc[];                // Proof-of-delivery document metadata (name/guid/path/ext);
                                    // only present once delivered. Bytes need a separate fetch.
  plannedEtaDTTM: string | null;    // M5.2 — canonical delivery-order timestamp for route polylines.
  // ── Phase 2 (routing engine) ADDITIVE fields. Surfaced for the solver; all
  // nullable, raw preserved. Existing callers (live cache, Phase 1 derive) ignore
  // them. None of the fields above are renamed or removed.
  stopDetails: StopLineItem[];      // P2 — per-line freight (SKU, qty, weight, dims, L flag).
  timeConstraint: string | null;    // P2 — STRICT vs soft delivery window.
  estimatedDurationMin: number | null; // P2 — NuVizz dwell estimate; UNRELIABLE (flat ~20m).
  plannedDistanceToNextStop: number | null; // P2 — NuVizz routing baseline.
  plannedDurationToNextStop: number | null; // P2 — NuVizz routing baseline.
  stopDistance: number | null;      // P2 — NuVizz per-stop distance.
  contact: StopContact;             // P2 — destination contact.
  origin: StopOrigin | null;        // P2 — pickup/depot origin address.
  markfor: unknown;                 // P2 — NuVizz mark-for, when present (raw).
  signalSources: SignalSources;
  allComments: StopComment[];       // FULL comment list (every type, author + time) for the notes panel.
  raw: unknown;
}

// Proof-of-delivery document metadata, as NuVizz returns it under
// stopExecutionInfo.{to,from}.podDoc[] in the /stop/info response. This is METADATA only —
// the actual file bytes (image/PDF) live on NuVizz's document server and need a separate
// fetch keyed by documentGuid/documentPath.
export interface PodDoc {
  documentName: string | null;
  documentGuid: string | null;
  documentPath: string | null;
  extension: string | null;
  createdTime: string | null;
}

// P2 — normalized freight line item (additive). Mirrors NuVizz StopDetail fields
// the routing geometry derivation needs; productCategory 'L' is NuVizz's own
// oversize/long flag, criticalDimension/length feed linear-foot estimation.
export interface StopLineItem {
  product: string | null;
  productIdentifier: unknown;       // SKU (may be object); preserved as-is.
  sku: string | null;              // best-effort string form of productIdentifier.
  quantity: number | null;
  quantityUOM: string | null;
  weight: number | null;
  weightUOM: string | null;
  productCategory: string | null;   // 'S' standard / 'L' long-oversize.
  referenceText: string | null;     // freight CLASS value shown on the Bill of Lading.
  length: number | null;
  lengthUOM: string | null;
  width: number | null;
  widthUOM: string | null;
  height: number | null;
  heightUOM: string | null;
  criticalDimension: number | null;
  criticalDimensionUOM: string | null;
}

export interface StopContact {
  name: string | null;
  phone: string | null;
  sms: string | null;
  email: string | null;
}

export interface StopOrigin {
  name: string | null;
  addr1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
}

function numOrNull(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// P2 — additive: normalize a single NuVizz StopDetail line item.
export function normalizeStopDetail(d: any): StopLineItem {
  const pid = d?.productIdentifier ?? null;
  const sku = pid == null ? null
    : typeof pid === 'string' ? pid
    : (pid.value || pid.id || pid.code || pid.productIdentifier || null);
  return {
    product: d?.product ?? null,
    productIdentifier: pid,
    sku: sku != null ? String(sku) : null,
    quantity: numOrNull(d?.quantity),
    quantityUOM: d?.quantityUOM ?? null,
    weight: numOrNull(d?.weight),
    weightUOM: d?.weightUOM ?? null,
    productCategory: d?.productCategory ?? null,
    referenceText: d?.referenceText ?? null,
    length: numOrNull(d?.length),
    lengthUOM: d?.lengthUOM ?? null,
    width: numOrNull(d?.width),
    widthUOM: d?.widthUOM ?? null,
    height: numOrNull(d?.height),
    heightUOM: d?.heightUOM ?? null,
    criticalDimension: numOrNull(d?.criticalDimension),
    criticalDimensionUOM: d?.criticalDimensionUOM ?? null,
  };
}

// M5.1 — canonical stop-status buckets driving marker visuals + sidebar badge.
export type StopStatusKind =
  | 'UNPLANNED'
  | 'SCHEDULED'
  | 'OUT_FOR_DEL'
  | 'ARRIVED'
  | 'DELIVERED'
  | 'EXCEPTION';

// Actual-execution timestamps. Field names VERIFIED against live delivered stops
// (2026-05-27): arrival is exec.to.arrivalDTTM; delivery confirmation is
// exec.to.confirmedDTTM (mirrored at exec.receiveDTTM). The earlier guesses
// (completionDTTM/confirmDTTM/etc.) never matched, so deliveredDTTM came back null
// and the sidebar showed no delivery time — keep them as fallbacks but probe the
// real fields first.
export function execArrivalDTTM(exec: any): string | null {
  return (
    exec?.to?.arrivalDTTM || exec?.to?.arrivalDttm ||
    exec?.arrivalDTTM || exec?.arrivalDttm || exec?.arrivedDttm || null
  );
}
export function execDeliveredDTTM(exec: any): string | null {
  return (
    exec?.to?.confirmedDTTM || exec?.receiveDTTM ||
    exec?.confirmedDTTM || exec?.completionDTTM || exec?.completedDttm ||
    exec?.completionDttm || exec?.confirmDTTM || exec?.to?.completionDTTM || null
  );
}

// True ONLY when NuVizz recorded a real failure on the stop. Parent-app precedent
// (normalize.js:80-89): status===50 with empty exceptions[] AND exceptionPresent=false
// is JUST a paperwork issue (driver arrived but didn't tap Complete) — NOT a real
// exception. So we require an authoritative signal: NuVizz's own exceptionPresent
// flag, an actual cancellation timestamp, or a non-empty exceptions[] entry. A bare
// status 50/80 code alone is NOT enough — many "50" stops are just unfinished
// paperwork on a driver-arrived stop, which should classify as ARRIVED, not EXCEPTION.
export function hasExceptionSignal(exec: any): boolean {
  if (exec?.exceptionPresent === true) return true;
  if (Array.isArray(exec?.exceptions) && exec.exceptions.length > 0) return true;
  const c = exec?.cancellation;
  return !!(c && c.cancelDTTM);
}

// Most-progressed state wins, with one inversion: ARRIVED beats a bare-code EXCEPTION
// (v0.11.8 — Chad's call). NuVizz often parks an arrived-but-not-completed stop at
// status 50 with no real exception data; the driver IS at the customer, so classify
// it ARRIVED. A REAL exception (exceptionPresent, cancelDTTM, exceptions[], or the
// explicit "Unable to deliver" code 80) still wins even with an arrival recorded.
// Status codes verified in live data: 10/20/30/40/50/80/90/91.
export function classifyStopStatus(opts: {
  status: string | null;
  isPlanned: boolean;
  exec?: any;
}): StopStatusKind {
  const code = String(opts.status ?? '').trim();
  const exec = opts.exec || {};
  if (code === '90' || code === '91' || execDeliveredDTTM(exec)) return 'DELIVERED';
  // Code 80 ("Unable to deliver") is the explicit failure outcome — EXCEPTION even
  // if an arrival was recorded earlier in the same lifecycle.
  if (code === '80') return 'EXCEPTION';
  // Authoritative exception signals (NuVizz's own flag, cancellation, real exceptions[]).
  if (hasExceptionSignal(exec)) return 'EXCEPTION';
  // Driver-on-site beats bare status 50 paperwork.
  if (execArrivalDTTM(exec)) return 'ARRIVED';
  if (code === '40') return 'OUT_FOR_DEL';
  if (!opts.isPlanned) return 'UNPLANNED';
  return 'SCHEDULED';
}

// PURE: does this shipment number carry the "ATT" re-delivery-attempt marker?
// Davis customer service prepends "ATT" (case-insensitive in live data — both
// "ATT007137828" and "att007138005" observed) to the shipment number of a failed
// delivery before unplanning it for re-routing. The stop number itself is never
// prefixed, so this is the one authoritative signal that a stop is an attempt —
// the same filter the NuVizz portal "Attempts" saved search uses ("Shipment Number
// Starts With att"). Exported + pure so it is unit-tested without the network.
export function isAttemptShipment(shipmentNbr: string | null | undefined): boolean {
  return /^att/i.test(String(shipmentNbr ?? '').trim());
}

export function getCreds() {
  return {
    companyCode: (process.env.NUVIZZ_DAVIS_COMPANY_CODE || 'DAVIS').toUpperCase(),
    user: process.env.NUVIZZ_DAVIS_USER,
    pass: process.env.NUVIZZ_DAVIS_PASS,
  };
}

export function basicAuthHeader(): string {
  const { user, pass } = getCreds();
  if (!user || !pass) throw new Error('Missing NUVIZZ_DAVIS_USER or NUVIZZ_DAVIS_PASS');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Runaway-scan kill switch (P0, Jun 2026) ──────────────────────────────────
// Every NuVizz scan path checks this. Set Netlify env NUVIZZ_SCANS_ENABLED=false
// on the site to short-circuit ALL number-space scanning (load + unplanned) without
// a code change — the map/app keep reading the last-written Firestore index, but no
// new NuVizz traffic is generated. Default is ENABLED (only the literal string
// "false" disables) so a missing/blank var never silently kills live data.
export function scansEnabled(): boolean {
  return String(process.env.NUVIZZ_SCANS_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

function extractOrderInstructions(stop: any): string | null {
  const comments = stop?.comments;
  if (!Array.isArray(comments) || !comments.length) return null;
  const lines: string[] = [];
  for (const c of comments) {
    if (!c) continue;
    const desc = typeof c.commentDescription === 'string' ? c.commentDescription : '';
    if (!desc) continue;
    const isOrderInstr = c.cmtType === 'ORD_IN' || desc.startsWith('SPL-INSTR-TEXT:');
    if (isOrderInstr) lines.push(desc);
  }
  return lines.length ? lines.join('\n') : null;
}

// The FULL comment list (every type), surfaced verbatim for the stop card's notes panel.
// Unlike extractOrderInstructions (filtered to delivery instructions), this keeps billing,
// pre-visit, etc. with their type/author/time so the card mirrors the portal's notes.
function extractAllComments(stop: any): StopComment[] {
  const comments = stop?.comments;
  if (!Array.isArray(comments) || !comments.length) return [];
  const out: StopComment[] = [];
  for (const c of comments) {
    if (!c) continue;
    const text = typeof c.commentDescription === 'string' ? c.commentDescription.trim() : '';
    if (!text) continue;
    out.push({
      text,
      type: c.cmtType ?? c.commentType ?? null,
      typeDesc: c.commentTypeDescription ?? null,
      addedBy: c.addedByName ?? null,
      addedOn: c.addedOn ?? null,
      access: Array.isArray(c.accessLevels) ? c.accessLevels : [],
      source: c.source ?? null,
    });
  }
  return out;
}

function detectTerminal(addr1: string | null, businessName: string | null): boolean {
  const a = (addr1 || '').toUpperCase();
  if (/\b943\b/.test(a) && /GAINESVILLE/.test(a)) return true;
  const b = (businessName || '').toUpperCase();
  if (/^DAVIS\s+DELIVERY(\s+SERVICE)?$/.test(b)) return true;
  return false;
}

export function normalizeStop(raw: any): NormalizedStop {
  const stop = raw.stop || raw;
  const exec = raw.stopExecutionInfo || {};
  const load = raw.load || {};
  const stopType = stop.stopType || raw.stopType || 'DO';
  const primary = stopType === 'PU' ? (stop.from || {}) : (stop.to || stop.from || {});
  const addr = primary.address || stop.address || {};
  const schedule = primary.schedule || {};
  // NuVizz MISLABELS its freight fields (confirmed by Davis dispatch):
  //   • totalCartons = PALLETS (skids)
  //   • volume       = LOOSE pieces
  //   • totalPallets = TOTAL pieces  (= pallets + loose)
  // We relabel them to their real meaning here. (The normalized field names below still
  // mirror NuVizz's raw naming — only the display labels are corrected.)
  const items = [];
  if (stop.totalCartons) items.push(`${stop.totalCartons} pallet${stop.totalCartons === 1 ? '' : 's'}`);
  if (stop.volume) items.push(`${stop.volume} loose`);
  if (stop.totalPallets) items.push(`${stop.totalPallets} ${stop.totalPallets === 1 ? 'piece' : 'pieces'}`);
  if (stop.weight) items.push(`${stop.weight} ${stop.weightUOM || 'lbs'}`);
  const stopNbr: string | null = stop.stopNbr ?? null;
  // Shipment number is a distinct raw field from stopNbr (usually identical). The
  // "ATT" prefix that customer service adds to a failed delivery lives HERE, not on
  // stopNbr — so it is preserved verbatim and surfaced as the attempt marker.
  const shipmentNbr: string | null = stop.shipmentNbr ?? null;
  const pros: string[] = stopNbr ? [stopNbr] : [];
  const addr2 = addr.addr2 ?? null;
  const orderInstructions = extractOrderInstructions(stop);
  const allComments = extractAllComments(stop);
  const businessName = addr.name || stop.custInfo?.custName || null;
  const addr1 = addr.addr1 ?? null;
  const driverUserName = load.driverUserName ?? null;
  const driverName = load.driverName ?? null;
  const loadNbr = load.loadNbr || raw.loadNbr || null;
  const statusCode = exec.stopStatus || stop.status || null;
  const isPlanned = !!loadNbr;
  const arrivalDTTM = execArrivalDTTM(exec);
  const deliveredDTTM = execDeliveredDTTM(exec);
  // M5.2 — plannedEtaDTTM is the canonical "delivery order" timestamp on a planned
  // stop. Exposing it at the top level lets the client sort each load's stops into a
  // real sequential polyline (NuVizz's array order / stopSeq is unreliable).
  const plannedEtaDTTM: string | null = exec?.to?.plannedEtaDTTM || exec?.from?.plannedEtaDTTM || null;
  // Proof-of-delivery docs — populated once the stop is delivered (driver capture). NuVizz
  // exposes these in TWO places and the portal merges both, so we must too:
  //   • exec.to/from.podDoc       — the signed POD bundle
  //   • stop.to/from.documents    — the driver's "Document Capture" photos (the timeline's
  //                                 DOCUMENT CAPTURE events). These are NOT under podDoc, so
  //                                 a stop with capture photos but no signed POD showed an
  //                                 EMPTY proof-of-delivery section before this merge.
  // For a delivery (DO) the docs hang off .to; pickups (PU) off .from. Deduped by guid below.
  const rawPods = [
    ...(Array.isArray(exec?.to?.podDoc) ? exec.to.podDoc : []),
    ...(Array.isArray(exec?.from?.podDoc) ? exec.from.podDoc : []),
    ...(Array.isArray(stop?.to?.documents) ? stop.to.documents : []),
    ...(Array.isArray(stop?.from?.documents) ? stop.from.documents : []),
  ];
  const seenDocKey = new Set<string>();
  const podDocs: PodDoc[] = rawPods.map((d: any) => ({
    documentName: d?.documentName ?? null,
    documentGuid: d?.documentGuid ?? null,
    documentPath: d?.documentPath ?? null,
    // Capture docs key the extension as documentExtType (e.g. "JPG"); POD docs use extension.
    extension: d?.extension ?? d?.documentExtType ?? null,
    createdTime: d?.createdTime ?? d?.createdDTTM ?? null,
  })).filter((d: PodDoc) => {
    if (!(d.documentGuid || d.documentPath || d.documentName)) return false;
    const key = d.documentGuid || d.documentPath || d.documentName || '';
    if (seenDocKey.has(key)) return false;       // same doc surfaced under both podDoc + documents
    seenDocKey.add(key);
    return true;
  });
  // P2 (additive) — surface freight + routing-baseline + contact/origin for the engine.
  const rawDetails = Array.isArray(stop.stopDetails) ? stop.stopDetails : [];
  const stopDetails: StopLineItem[] = rawDetails.map(normalizeStopDetail);
  const contactRaw = primary.contact || {};
  const contact: StopContact = {
    name: contactRaw.contactName || contactRaw.name || null,
    phone: contactRaw.phone ?? null,
    sms: contactRaw.sms ?? null,
    email: contactRaw.email ?? null,
  };
  const fromAddr = (stop.from && stop.from.address) || {};
  const origin: StopOrigin | null = fromAddr.addr1 || fromAddr.latitude != null ? {
    name: fromAddr.name ?? null,
    addr1: fromAddr.addr1 ?? null,
    city: fromAddr.city ?? null,
    state: fromAddr.state ?? null,
    zip: fromAddr.zip ?? null,
    lat: fromAddr.latitude != null ? Number(fromAddr.latitude) : null,
    lng: fromAddr.longitude != null ? Number(fromAddr.longitude) : null,
  } : null;
  return {
    pro: stopNbr,
    pros,
    primaryPro: pros[0] ?? null,
    proCount: pros.length,
    shipmentNbr,
    isAttempt: isAttemptShipment(shipmentNbr),
    stopNbr,
    stopId: stop.stopId ?? null,
    loadNbr,
    loadStopSeq: typeof load.stopSeq === 'number' ? load.stopSeq : null,
    routeSeq: numOrNull(primary.seq),
    stopType,
    status: statusCode,
    businessName,
    addr1,
    addr2,
    city: addr.city ?? null,
    state: addr.state ?? null,
    zip: addr.zip ?? null,
    lat: addr.latitude != null ? Number(addr.latitude) : null,
    lng: addr.longitude != null ? Number(addr.longitude) : null,
    scheduledFrom: schedule.timeFrom ?? null,
    scheduledTo: schedule.timeTo ?? null,
    cartons: stop.totalCartons ?? null,
    pallets: stop.totalPallets ?? null,
    volume: numOrNull(stop.volume),         // loose-piece count (Davis uses NuVizz `volume`)
    weight: stop.weight ?? null,
    // Bill-of-Lading header fields (see interface for NuVizz→BOL mapping).
    bol: stop.bol ?? null,
    orderNbr: stop.laneNumber ?? null,
    terms: stop.scheduleAttribute ?? null,
    warehouse: stop.proNumber ?? null,
    custRef: stop.reference2 ?? null,
    poRef: stop.reference1 ?? null,
    billTo: stop.billTo ?? null,
    itemsSummary: items.join(' · ') || '—',
    customerAccount: stop.accountNumber || stop.custInfo?.custAccNbr || null,
    driverName,
    driverUserName,
    routeName: load.routeName ?? null,
    isTerminal: detectTerminal(addr1, businessName),
    isUnplanned: !driverUserName && !driverName,
    isPlanned,
    normalizedStatus: classifyStopStatus({ status: statusCode, isPlanned, exec }),
    arrivalDTTM,
    deliveredDTTM,
    podDocs,
    plannedEtaDTTM,
    stopDetails,
    timeConstraint: schedule.timeConstraint ?? null,
    estimatedDurationMin: numOrNull(schedule.estimatedDuration),
    plannedDistanceToNextStop: numOrNull(exec.plannedDistanceToNextStop),
    plannedDurationToNextStop: numOrNull(exec.plannedDurationToNextStop),
    stopDistance: numOrNull(stop.stopDistance),
    contact,
    origin,
    markfor: stop.markfor ?? null,
    signalSources: { addressLine2: addr2, orderInstructions },
    allComments,
    raw,
  };
}

// ── Load-number range estimation (planned stops) ────────────────────────────
// Davis dispatches only on BUSINESS days, so estimate a date's load-number center
// by business-day count from a known anchor. The prior calendar-day math
// (`daysDiff × 80`) OVERSHOOTS because it counts weekends that add no loads — that
// drift, with the narrow ±250 window, made the scheduled scan miss an entire day
// of loads (observed 2026-06-15: estimate 197220 vs actual ~196690, so the
// [196970,197470] window clipped every real load). This mirrors the parent app's
// proven anchor + self-calibration in netlify/functions/nuvizz.cjs.
const ANCHOR_DATE = new Date('2026-06-05T00:00:00Z');
const ANCHOR_LOAD = 196143; // center of Jun 5 (actual range 196094–196192)
const LOADS_PER_BIZ_DAY = 100; // Davis dispatches ~100 loads per business day

// Half-width of the COLD/first-scan window. ±300 brackets a day's ~100-load span
// plus drift slack so a fresh scan can't clip real loads; the self-calibration
// below then narrows it to the day's ACTUAL span (~220 numbers) so steady-state
// probe counts stay low. Re-widen only by re-calibrating the anchor, never as a
// blind fix for "missing" loads — a stale anchor is the usual cause.
const LOAD_WINDOW_HALF = 300;

// Count Mon–Fri days between two dates (signed). Weekends excluded since Davis
// doesn't dispatch Sat/Sun — this is what makes the estimate track real loads.
export function businessDaysBetween(from: Date, to: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const sign = to >= from ? 1 : -1;
  let count = 0;
  let cur = new Date(Math.min(from.getTime(), to.getTime()));
  const end = new Date(Math.max(from.getTime(), to.getTime()));
  while (cur < end) {
    cur = new Date(cur.getTime() + msPerDay);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return sign * count;
}

// Self-calibration: after a scan finds the day's real load span, cache it so the
// next scan (within the TTL) uses a tight, accurate window instead of the wide
// static guess — accurate AND cheap. Pads +100 high (late same-day dispatches),
// −20 low. Only narrows once a real batch (≥50) is found, so an early-morning
// scan before dispatch finishes doesn't clamp the afternoon.
const RANGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MIN_LOADS_TO_CALIBRATE = 50;
const __rangeCache = new Map<string, { storedAt: number; range: { startNbr: number; endNbr: number } }>();

export function calibrateLoadRange(dateStr: string, loadNbrs: string[]): void {
  const nums = (loadNbrs || [])
    .map((l) => { const m = String(l ?? '').match(/(\d+)$/); return m ? parseInt(m[1], 10) : null; })
    .filter((n): n is number => n != null);
  if (nums.length < MIN_LOADS_TO_CALIBRATE) return;
  const min = Math.min(...nums), max = Math.max(...nums);
  __rangeCache.set(dateStr, { storedAt: Date.now(), range: { startNbr: min - 20, endNbr: max + 100 } });
  if (__rangeCache.size > 30) { const k = __rangeCache.keys().next().value; if (k) __rangeCache.delete(k); }
}

export function estimateLoadRange(dateStr: string): { startNbr: number; endNbr: number } {
  const cached = __rangeCache.get(dateStr);
  if (cached && Date.now() - cached.storedAt < RANGE_CACHE_TTL_MS) return cached.range;
  const target = new Date(dateStr + 'T00:00:00Z');
  const bizDaysDiff = businessDaysBetween(ANCHOR_DATE, target);
  const center = ANCHOR_LOAD + bizDaysDiff * LOADS_PER_BIZ_DAY;
  return { startNbr: center - LOAD_WINDOW_HALF, endNbr: center + LOAD_WINDOW_HALF };
}

async function scanLoadRangeForDate(dateStr: string, startNbr: number, endNbr: number, concurrency = PROBE_CONCURRENCY) {
  const nums: number[] = [];
  for (let n = endNbr; n >= startNbr; n--) nums.push(n);
  return scanLoadNumbers(dateStr, nums, concurrency);
}

// PURE: a stop's own scheduled delivery date (YYYY-MM-DD) from a raw load-stop,
// mirroring normalizeStop's primary-schedule resolution. null when absent.
export function rawStopScheduledDate(rawStop: any): string | null {
  const stop = rawStop?.stop || rawStop || {};
  const stopType = stop.stopType || rawStop?.stopType || 'DO';
  const primary = stopType === 'PU' ? (stop.from || {}) : (stop.to || stop.from || {});
  const tf = primary?.schedule?.timeFrom || '';
  return typeof tf === 'string' && tf.length >= 10 ? tf.slice(0, 10) : null;
}

// PURE: a load can span days (carryover / multi-day routes that started on an
// earlier day but still deliver stops today). Keep only the stops whose OWN
// scheduled date matches the board date — so such a load contributes its today
// stops (correctly PLANNED) without polluting the day with its other-day stops.
// Stops with no schedule fall back to the load's start date. Returns the kept
// stops paired with their original index (preserves stopSeq). Exported for tests.
export function loadStopsForDate(rawStops: any[], dateStr: string, loadStartDate: string | null): Array<{ s: any; i: number }> {
  const out: Array<{ s: any; i: number }> = [];
  // A load that STARTED today is today's run, so trust LOAD MEMBERSHIP: keep all
  // its stops even when a stop carries an older date — that's a previously-
  // undelivered order rolled back to unplanned and re-added to today's truck (it
  // keeps its original delivery date but rides today). We still drop strictly
  // future-dated stops. A genuine CARRYOVER load (started on an earlier day) keeps
  // the original behavior: only its stops whose OWN date is today, so the load's
  // other-day stops don't leak onto this board.
  const todaysLoad = loadStartDate === dateStr;
  for (let i = 0; i < (rawStops?.length || 0); i++) {
    const s = rawStops[i];
    const d = rawStopScheduledDate(s);
    const keep = todaysLoad ? (d == null || d <= dateStr) : (d === dateStr);
    if (keep) out.push({ s, i });
  }
  return out;
}

// Probe ONE load number for a date. Returns the load's stop rows (header-stamped)
// for the stops that DELIVER on dateStr (so carryover loads contribute), else null.
// Extracted so both the set/range scan and the adaptive forward scan share one
// definition of "a load probe".
async function probeLoad(n: number, dateStr: string, authHeader: string, companyCode: string): Promise<any[] | null> {
  const loadNbr = `${companyCode}${String(n).padStart(9, '0')}`;
  const url = `${NUVIZZ_BASE}/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`;
  try {
    const resp = await getNuvizzRequester().request(url, { headers: { Authorization: authHeader, Accept: 'application/json' } }, { route: '/load/info', tenant: companyCode });
    if (!resp.ok) return null;
    const d: any = await resp.json();
    const h = d?.Load?.loadHeader || {};
    const a = d?.Load?.loadAssignment || {};
    const stops = d?.Load?.stops || [];
    const startDate = (h.earliestStartDttm || '').slice(0, 10) || null;
    // Phase 4: carry the full load HEADER (not just the 5 stop-linking fields)
    // so the sole scanner can build SITE A's complete nuvizzFleet load cards —
    // vehicleType, origin, pallet/carton/weight — without a second scan.
    const header = {
      loadNbr: h.loadNbr, routeName: h.routeName,
      driverName: a.driverName, driverUserName: a.driverUserName, driverEmail: a.driverEmail ?? null,
      loadId: h.loadId ?? null, vehicleType: h.vehicleType ?? null, startDate,
      totalPallets: h.totalPallets ?? null, totalCartons: h.totalCartons ?? null, weight: h.weight ?? null,
      origin: {
        name: h.originName ?? null, addr1: h.originAddr1 ?? null, city: h.originCity ?? null,
        state: h.originState ?? null, zip: h.originZip ?? null,
        latitude: h.originLatitude ?? null, longitude: h.originLongitude ?? null,
      },
    };
    // Match by the STOP's delivery date, not the load's start date, so a load that
    // started on a prior day still surfaces its today-stops as planned.
    const kept = loadStopsForDate(stops, dateStr, startDate);
    if (!kept.length) return null;
    return kept.map(({ s, i }) => ({ ...s, load: { ...header, stopSeq: i } }));
  } catch {
    return null;
  }
}

// Probe an EXPLICIT list of load numbers (Phase 2 lean discovery: known-active +
// forward buffer + gap sweep). Same per-load /load/info call + date-filter as the
// range scan — just an arbitrary set instead of a contiguous window.
async function scanLoadNumbers(dateStr: string, numbers: number[], concurrency = PROBE_CONCURRENCY) {
  const { companyCode } = getCreds();
  const authHeader = basicAuthHeader();

  const nums = numbers;
  const results: any[][] = [];
  let idx = 0;
  const runOne = async () => {
    while (idx < nums.length) {
      const r = await probeLoad(nums[idx++], dateStr, authHeader, companyCode);
      if (r && r.length) results.push(r);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runOne));
  return results.flat();
}

// ── Unplanned (status-10) number-space scan ─────────────────────────────────
// Calibrated 2026-05-26: stop 007123931 was the top of the 5/26 block. Stop
// numbers map ~linearly onto the expected-arrival date; unplanned orders are the
// newest imports and cluster at the high end ("frontier"). Recalibrate
// STOP_ANCHOR_* if the estimate drifts off the live frontier.
const STOP_ANCHOR_NBR = 7124000;
const STOP_ANCHOR_DATE = new Date('2026-05-26T00:00:00Z');
const STOPS_PER_DAY = 440;
const UNPLANNED_STATUS = '10';

// PURE: is a probed stop a genuine UNPLANNED order this descent should write?
// It must be status-10 (not yet started), scheduled for the scan date, AND not
// already assigned to a load. The load check is critical: NuVizz keeps a stop at
// status-10 even after it's been put on a load (planned but not dispatched). Such
// a stop is PLANNED — the load scan owns it — so the unplanned descent must not
// claim it, or it would overwrite the load scan's isPlanned=true record with
// isPlanned=false and the stop would wrongly surface under "Unplanned only".
export function isUnplannedTarget(stopStatus: any, expected: string | null, dateStr: string, loadNbr: any): boolean {
  return stopStatus === UNPLANNED_STATUS && expected === dateStr && !loadNbr;
}

const CEILING_MARGIN = 40;
const GALLOP_STEP = 200;
const MAX_GALLOP = 6;
export const FLOOR_MARGIN = 2500;
// Probe concurrency — how many /load/info or /stop/info calls fire in parallel.
// LOW by default so a scan SPREADS its calls over time instead of bursting (the
// NuVizz complaint: "1000+ at a single time, single minute"). Env-tunable so we
// can dial it without a deploy. Loads use the small value; the unplanned descent
// is gallop-based so it tolerates a slightly larger pool.
const PROBE_CONCURRENCY = Number(process.env.NUVIZZ_PROBE_CONCURRENCY) || 6;
const DESCENT_CONCURRENCY = Number(process.env.NUVIZZ_DESCENT_CONCURRENCY) || 10;
const FUTURE_CHUNKS_TO_STOP = 2;
const POST_TARGET_CHUNKS_TO_STOP = 3;
// Phase 6: keep ~2 weeks of recent stop numbers in the terminal skip cache so
// carry-over descents on older dates still hit it; older numbers are below every
// descent floor and never re-probed, so dropping them is free.
const TERMINAL_RETENTION_BAND = STOPS_PER_DAY * 14;

// Self-calibration: highest existing stop number observed this instance.
let observedFrontier = 0;

export function estimateStopFrontier(dateStr: string): number {
  const target = new Date(dateStr + 'T00:00:00Z');
  const daysDiff = Math.round((target.getTime() - STOP_ANCHOR_DATE.getTime()) / (1000 * 60 * 60 * 24));
  return STOP_ANCHOR_NBR + daysDiff * STOPS_PER_DAY;
}

interface StopProbe {
  n: number;
  exists: boolean;
  expected?: string | null;
  // Phase 6: status 90/91 → DELIVERED and immutable, so this number can be cached and
  // skipped (no /stop/info) on future descents.
  terminal?: boolean;
  record?: { stop: any; stopExecutionInfo: any } | null;
}

// 90 = system completion, 91 = manual/portal completion; both are terminal/immutable.
export function isTerminalStatus(code: any): boolean {
  const c = String(code ?? '').trim();
  return c === '90' || c === '91';
}

// On-demand lookup of a single stop by PRO/stop number — used by the mobile
// "search past PROs" button when a typed PRO isn't in our saved 20-stop history.
// Numeric PROs are zero-padded to 9 (NuVizz's format); alphanumeric (AVRT-…)
// are used as-is. Goes through the shared requester so it counts toward the
// daily call budget, and honors the kill switch.
export async function lookupStopByPro(pro: string): Promise<{ ok: boolean; stop?: NormalizedStop; reason?: string }> {
  if (!scansEnabled()) return { ok: false, reason: 'scans_disabled' };
  const raw = String(pro || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const { companyCode } = getCreds();
  const authHeader = basicAuthHeader();
  const id = /^[0-9]+$/.test(raw) ? raw.padStart(9, '0') : raw;
  const url = `${NUVIZZ_BASE}/stop/info/${encodeURIComponent(id)}/${encodeURIComponent(companyCode)}`;
  try {
    const resp = await getNuvizzRequester().request(url, { headers: { Authorization: authHeader, Accept: 'application/json' } }, { route: '/stop/info', tenant: companyCode });
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
    const d: any = await resp.json();
    const wrap = d?.Stop || d?.stop || d;
    if (!wrap?.stop?.stopNbr) return { ok: false, reason: 'not_found' };
    return { ok: true, stop: normalizeStop(wrap) };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'error' };
  }
}

// Map a NuVizz event-info response (either wrapper shape) into our common StopEvent[].
// Newest-first so the timeline reads top-down like the portal. PURE — unit-tested.
export function normalizeStopEvents(d: any): StopEvent[] {
  const arr =
    (Array.isArray(d?.events) && d.events) ||
    (Array.isArray(d?.stopEvents) && d.stopEvents) ||
    (Array.isArray(d?.eventList) && d.eventList) ||
    (Array.isArray(d) && d) || [];
  const out: StopEvent[] = arr.map((e: any) => ({
    code: e?.eventCode != null ? String(e.eventCode) : null,
    name: e?.eventName ?? null,
    dttm: e?.eventDTTM ?? e?.eventDttm ?? null,
    user: e?.userName ?? null,
    company: e?.companyName ?? null,
    routeName: e?.routeName ?? null,
    lat: e?.latitude != null ? Number(e.latitude) : null,
    lng: e?.longitude != null ? Number(e.longitude) : null,
  })).filter((e: StopEvent) => e.name || e.dttm);
  // Sort newest-first by eventDTTM (ISO-like strings sort lexically); undated go last.
  out.sort((a, b) => String(b.dttm || '').localeCompare(String(a.dttm || '')));
  return out;
}

// On-demand activity timeline for a single stop. Prefers /event/eventinfo (carries the
// "By:" user + "From:" company) when the system stopId is known; falls back to
// /stop/eventinfo by stop number. One NuVizz call (two only if the rich call fails and we
// fall back). Rides the shared requester so it counts against the daily ceiling.
export async function fetchStopEvents(
  stopNbr: string, stopId?: string | null,
): Promise<{ ok: boolean; events?: StopEvent[]; source?: string; reason?: string; stop?: NormalizedStop | null }> {
  if (!scansEnabled()) return { ok: false, reason: 'scans_disabled' };
  const { companyCode } = getCreds();
  const hdr = { Authorization: basicAuthHeader(), Accept: 'application/json' };
  const reqr = getNuvizzRequester();
  // Opening the timeline ALSO refreshes the delivery's detail: do one /stop/info so we catch
  // any newly-added notes/items, AND get the system stopId for the RICH /event/eventinfo
  // (carries the "By:" user, "From:" company and GPS). One /stop/info + one events call.
  let id = stopId && String(stopId).trim() ? String(stopId).trim() : null;
  let refreshed: NormalizedStop | null = null;
  if (String(stopNbr || '').trim()) {
    try { const r = await lookupStopByPro(String(stopNbr)); if (r.ok && r.stop) { refreshed = r.stop; if (!id && r.stop.stopId) id = String(r.stop.stopId); } } catch { /* fall back to lean below */ }
  }
  try {
    if (id) {
      const url = `${NUVIZZ_BASE}/event/eventinfo/${encodeURIComponent(companyCode)}?entityType=STOP&entityId=${encodeURIComponent(id)}`;
      const resp = await reqr.request(url, { headers: hdr }, { route: '/event/eventinfo', tenant: companyCode });
      if (resp.ok) return { ok: true, source: 'event', events: normalizeStopEvents(await resp.json()), stop: refreshed };
    }
    const raw = String(stopNbr || '').trim();
    const id2 = /^[0-9]+$/.test(raw) ? raw.padStart(9, '0') : raw;
    if (!id2) return { ok: false, reason: 'missing id' };
    const url = `${NUVIZZ_BASE}/stop/eventinfo/${encodeURIComponent(companyCode)}?stopNbr=${encodeURIComponent(id2)}`;
    const resp = await reqr.request(url, { headers: hdr }, { route: '/stop/eventinfo', tenant: companyCode });
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}`, stop: refreshed };
    return { ok: true, source: 'stop', events: normalizeStopEvents(await resp.json()), stop: refreshed };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'error' };
  }
}

async function probeStop(n: number, dateStr: string, authHeader: string, companyCode: string): Promise<StopProbe> {
  const stopNbr = String(n).padStart(9, '0');
  const url = `${NUVIZZ_BASE}/stop/info/${encodeURIComponent(stopNbr)}/${encodeURIComponent(companyCode)}`;
  try {
    const resp = await getNuvizzRequester().request(url, { headers: { Authorization: authHeader, Accept: 'application/json' } }, { route: '/stop/info', tenant: companyCode });
    if (!resp.ok) return { n, exists: false };
    const d: any = await resp.json();
    const wrap = d?.Stop || d?.stop || d;
    const stop = wrap?.stop;
    const exec = wrap?.stopExecutionInfo || {};
    if (!stop?.stopNbr) return { n, exists: false };
    const expected = ((stop?.to?.schedule?.timeFrom as string) || '').slice(0, 10) || null;
    // A stop already on a load is PLANNED even at status-10 — exclude it so the
    // descent never clobbers the load scan's planned record (see isUnplannedTarget).
    const loadNbr = wrap?.load?.loadNbr ?? null;
    const isTarget = isUnplannedTarget(exec.stopStatus, expected, dateStr, loadNbr);
    return { n, exists: true, expected, terminal: isTerminalStatus(exec.stopStatus), record: isTarget ? { stop, stopExecutionInfo: exec } : null };
  } catch {
    return { n, exists: false };
  }
}

// PURE: partition a descent batch into numbers that still need a /stop/info call vs
// ones we can synthesize from the terminal cache. A synthesized probe is identical to
// what the real call would return for a delivered stop — exists, the stored expected
// date, NOT a status-10 target — so the early-stop heuristics see the same inputs and
// the descent extent is unchanged; only the network call is eliminated. Exported for tests.
export function buildTerminalSkipPlan(
  batch: number[], terminalCache: Map<number, string>,
): { toProbe: number[]; synthesized: StopProbe[] } {
  const toProbe: number[] = [];
  const synthesized: StopProbe[] = [];
  for (const n of batch) {
    const expected = terminalCache.get(n);
    if (expected !== undefined) synthesized.push({ n, exists: true, expected, terminal: true, record: null });
    else toProbe.push(n);
  }
  return { toProbe, synthesized };
}

// Locate a ceiling just above the live frontier (highest existing stop number).
// We bracket the frontier with a doubling gallop (up if the estimate is below it,
// down if above), then binary-search the bracket to pin it. Anchoring on today's
// estimate (not the query date's) keeps the descent start near the real top for
// any date. sampleExists() tolerates single-number gaps by probing 8 in a row.
async function findCeiling(dateStr: string, authHeader: string, companyCode: string): Promise<number> {
  const sampleExists = async (top: number): Promise<boolean> => {
    const sample = Array.from({ length: 8 }, (_, k) => top - k);
    const rs = await Promise.all(sample.map((n) => probeStop(n, dateStr, authHeader, companyCode)));
    return rs.some((r) => r.exists);
  };
  const base = Math.max(estimateStopFrontier(todayUTC()), observedFrontier) + CEILING_MARGIN;

  let lo: number; // a level where stops EXIST (≤ frontier)
  let hi: number; // a level that is EMPTY    (> frontier)
  if (await sampleExists(base)) {
    // Under-estimated: gallop UP until empty.
    lo = base;
    let step = GALLOP_STEP;
    hi = base + step;
    for (let g = 0; g < MAX_GALLOP && (await sampleExists(hi)); g++) {
      lo = hi; step *= 2; hi += step;
    }
    if (await sampleExists(hi)) return hi + CEILING_MARGIN; // never found empty — best effort
  } else {
    // Over-estimated: gallop DOWN until we find existing stops.
    hi = base;
    let step = GALLOP_STEP;
    lo = base - step;
    let g = 0;
    for (; g < MAX_GALLOP && !(await sampleExists(lo)); g++) {
      hi = lo; step *= 2; lo -= step;
    }
    if (!(await sampleExists(lo))) return hi; // no stops found in range
  }

  // Binary-search the [lo exists, hi empty] bracket to converge on the frontier.
  while (hi - lo > 8) {
    const mid = Math.floor((lo + hi) / 2);
    if (await sampleExists(mid)) lo = mid; else hi = mid;
  }
  return lo + CEILING_MARGIN;
}

interface UnplannedScanOpts {
  concurrency?: number;
  timeBudgetMs?: number;
  maxProbes?: number;
  // Phase 3 lean: when set (last scan's highWaterStopNbr), descend only NEW stop
  // numbers above it (+ a small buffer) instead of the full FLOOR_MARGIN range —
  // new unplanned orders are the newest imports (highest numbers).
  sinceStopNbr?: number | null;
  // Step 4 deep sweep: raise the post-target early-stop threshold so the descent
  // pushes THROUGH gaps of older/non-target stops to reach low-numbered advance
  // stragglers (e.g. an order created days early, or one whose date moved to today)
  // instead of quitting at the first gap. Defaults to POST_TARGET_CHUNKS_TO_STOP.
  postTargetChunks?: number;
}

// New unplanned orders cluster at the high end; re-check a band below the last
// high-water each warm scan so the active unplanned cluster keeps getting
// re-confirmed (status changes / out-of-order imports). Live data (Jun 2026)
// shows the still-unplanned cluster spans ~160 numbers below the high-water at
// the quiet end of the day, so this can't go tiny without leaning entirely on
// the deep sweep for the lower part of the cluster. Trimmed 200 → 150 and made
// env-tunable so it can be pulled lower (and reverted) without a deploy once the
// [scan-parity] belowFloorNew gate confirms a smaller band misses nothing.
const UNPLANNED_HIGHWATER_BUFFER = Number(process.env.NUVIZZ_UNPLANNED_HIGHWATER_BUFFER) || 150;

// PURE: the descent floor. Lean (sinceStopNbr set) raises the floor to just below
// the last high-water; otherwise the full estimated floor. Unit-tested.
export function unplannedFloor(estimateFloor: number, sinceStopNbr?: number | null): number {
  if (sinceStopNbr == null) return estimateFloor;
  return Math.max(estimateFloor, sinceStopNbr - UNPLANNED_HIGHWATER_BUFFER);
}

// Descend the stop-number space for the date, collecting status-10 stops.
// Background callers pass generous budgets (no 26s cap) so the cluster is never
// truncated; the early-stop heuristics keep it from scanning the whole space.
async function scanUnplannedStops(dateStr: string, opts: UnplannedScanOpts = {}) {
  const concurrency = opts.concurrency ?? DESCENT_CONCURRENCY;
  const timeBudgetMs = opts.timeBudgetMs ?? 120_000;
  // P0 (Jun 2026): hard-cap the unplanned number-space descent. 6000 probes/run ×
  // every-date × every-5-min cron was a primary contributor to the NuVizz overage.
  // The early-stop heuristics (futureStreak/postTargetStreak) normally terminate
  // long before this; the cap is the backstop so a calibration miss can't fan out
  // thousands of extra /stop/info calls. Lowered 6000 → 2500.
  const maxProbes = opts.maxProbes ?? 2500;
  // Step 4: deep sweep raises this so the descent pushes past day-boundary gaps.
  const postTargetStop = Math.max(1, opts.postTargetChunks ?? POST_TARGET_CHUNKS_TO_STOP);
  const { companyCode } = getCreds();
  const authHeader = basicAuthHeader();
  const ceiling = await findCeiling(dateStr, authHeader, companyCode);
  const floor = unplannedFloor(estimateStopFrontier(dateStr) - FLOOR_MARGIN, opts.sinceStopNbr);

  // Phase 6 (default OFF): load the terminal-stop skip cache so numbers already
  // confirmed delivered (90/91) are synthesized instead of re-probed via /stop/info.
  const useTerminalSkip = (process.env.NUVIZZ_TERMINAL_SKIP || '').toLowerCase() === 'on';
  const terminalCache = new Map<number, string>();
  if (useTerminalSkip) {
    try {
      const cached = await readTerminalStops(companyCode);
      for (const [nbr, exp] of Object.entries(cached)) terminalCache.set(Number(nbr), exp);
    } catch { /* cache is best-effort; fall back to full probing */ }
  }
  const newTerminals: Record<string, string> = {};

  const results: any[] = [];
  let n = ceiling;
  let foundTarget = false;
  let futureStreak = 0;
  let postTargetStreak = 0;
  let probes = 0;
  let skipped = 0;
  let maxSeen = 0;
  const startedAt = Date.now();

  while (n >= floor && probes < maxProbes && Date.now() - startedAt < timeBudgetMs) {
    const batch: number[] = [];
    for (let i = 0; i < concurrency && n >= floor; i++) batch.push(n--);
    probes += batch.length;
    let rs: StopProbe[];
    if (useTerminalSkip && terminalCache.size) {
      // Synthesize the cached terminals (no call) + probe only the unknown numbers.
      const plan = buildTerminalSkipPlan(batch, terminalCache);
      skipped += plan.synthesized.length;
      const probed = await Promise.all(plan.toProbe.map((m) => probeStop(m, dateStr, authHeader, companyCode)));
      rs = [...plan.synthesized, ...probed];
    } else {
      rs = await Promise.all(batch.map((m) => probeStop(m, dateStr, authHeader, companyCode)));
    }
    // Record newly-confirmed terminals so future descents can skip them. Synthesized
    // entries are already cached, so this only captures fresh real-probe deliveries.
    if (useTerminalSkip) {
      for (const r of rs) {
        if (r.terminal && r.exists && r.expected && !terminalCache.has(r.n)) {
          newTerminals[String(r.n).padStart(9, '0')] = r.expected;
        }
      }
    }

    let existing = 0;
    let older = 0;
    let chunkTarget = false;
    for (const r of rs) {
      if (!r.exists) continue;
      existing++;
      if (r.n > maxSeen) maxSeen = r.n;
      if (r.record) { results.push(r.record); foundTarget = true; chunkTarget = true; }
      if (r.expected && r.expected < dateStr) older++;
    }

    if (existing > 0) {
      if (!foundTarget && older === existing) {
        if (++futureStreak >= FUTURE_CHUNKS_TO_STOP) break;
      } else {
        futureStreak = 0;
      }
      if (foundTarget && !chunkTarget) {
        if (++postTargetStreak >= postTargetStop) break;
      } else {
        postTargetStreak = 0;
      }
    }
  }

  if (maxSeen > observedFrontier) observedFrontier = maxSeen;
  // Persist freshly-confirmed terminals (best-effort). Retain a generous band below
  // the ceiling so carry-over descents on older dates still benefit; numbers below
  // that are never re-probed anyway.
  if (useTerminalSkip && Object.keys(newTerminals).length) {
    try {
      const retainFloor = Math.max(0, ceiling - TERMINAL_RETENTION_BAND);
      await mergeTerminalStops(companyCode, newTerminals, retainFloor);
    } catch { /* best-effort; a lost write just re-probes next scan */ }
  }
  if (useTerminalSkip) console.log(`[scan-terminal] date=${dateStr} probesIterated=${probes} skipped=${skipped} newTerminals=${Object.keys(newTerminals).length}`);
  // complete = the descent stopped because it reached the floor or early-stopped
  // BY DESIGN — not because it was truncated by the probe cap or the time budget.
  // A truncated descent must NOT be trusted to advance the lean high-water (R9).
  const complete = !(probes >= maxProbes) && !(Date.now() - startedAt >= timeBudgetMs);
  return { records: results, complete, ceiling, floor, maxSeen };
}

// ── Adaptive forward discovery (call-reduction: weekend/cold resumption) ─────
// New loads + orders always cluster ABOVE the last-known frontier (they're the
// newest imports → higher numbers). Instead of a cold ~601-wide load window +
// findCeiling-then-descend order scan, walk FORWARD from the persisted frontier
// in small chunks and stop once a run of chunks turns up nothing new. Over the
// weekend nothing changes below the frontier (Davis isn't working), so on the
// Sunday resumption "freeze Friday's frontier, scan forward" is both correct and
// far cheaper. Gated by NUVIZZ_FORWARD_SCAN; the deep sweep remains the periodic
// backstop that re-confirms the band BELOW the frontier (out-of-order imports).
export const FORWARD_CHUNK = Number(process.env.NUVIZZ_FORWARD_CHUNK) || 25;
// Stop after this many CONSECUTIVE chunks find nothing new (absorbs numbering
// gaps). Chad's spec is "until we don't find any new" — 2 empty 25-chunks = a
// 50-number dead zone, a strong end-of-frontier signal. Env-tunable to 1.
export const FORWARD_STOP_AFTER_EMPTY = Number(process.env.NUVIZZ_FORWARD_STOP_AFTER_EMPTY) || 2;

export interface ForwardProbe { exists: boolean; isNew: boolean; record?: any }
export interface ForwardScanResult { records: any[]; maxSeen: number; probes: number; complete: boolean }
export interface ForwardScanOpts { chunk?: number; maxProbes?: number; stopAfterEmpty?: number; timeBudgetMs?: number }

// Adaptive forward walk: probe `chunk` consecutive numbers from `start`, extend by
// another chunk while chunks keep turning up NEW items, stop after `stopAfterEmpty`
// consecutive empty chunks. maxProbes + timeBudget are hard backstops. Generic over
// what a "probe" means (loads vs orders) so one definition serves both. PURE w.r.t.
// the injected probe → unit-testable with no network (see test/scan-forward.test.mjs).
export async function scanForward(
  start: number,
  probe: (n: number) => Promise<ForwardProbe>,
  opts: ForwardScanOpts = {},
): Promise<ForwardScanResult> {
  const chunk = Math.max(1, opts.chunk ?? FORWARD_CHUNK);
  const maxProbes = opts.maxProbes ?? 2500;
  const stopAfterEmpty = Math.max(1, opts.stopAfterEmpty ?? FORWARD_STOP_AFTER_EMPTY);
  const timeBudgetMs = opts.timeBudgetMs ?? 120_000;
  const records: any[] = [];
  let n = start;
  let probes = 0;
  let emptyStreak = 0;
  let maxSeen = 0;
  const startedAt = Date.now();
  while (probes < maxProbes && Date.now() - startedAt < timeBudgetMs) {
    const batch: number[] = [];
    for (let i = 0; i < chunk; i++) batch.push(n++);
    probes += batch.length;
    const rs = await Promise.all(batch.map((m) => probe(m).then((r) => ({ m, ...r }))));
    let newCount = 0;
    for (const r of rs) {
      if (r.exists && r.m > maxSeen) maxSeen = r.m;
      if (r.isNew) {
        newCount++;
        if (r.record !== undefined && r.record !== null) records.push(r.record);
      }
    }
    if (newCount === 0) {
      if (++emptyStreak >= stopAfterEmpty) break;
    } else {
      emptyStreak = 0;
    }
  }
  const complete = !(probes >= maxProbes) && !(Date.now() - startedAt >= timeBudgetMs);
  return { records, maxSeen, probes, complete };
}

// Forward order discovery: walk UP from the last-known unplanned high-water,
// collecting status-10 target stops, until the frontier runs dry. Mirrors the
// return shape of scanUnplannedStops so scanDate consumes it identically.
async function scanUnplannedForward(dateStr: string, fromStopNbr: number, opts: ForwardScanOpts = {}) {
  const { companyCode } = getCreds();
  const authHeader = basicAuthHeader();
  const start = fromStopNbr + 1;
  const r = await scanForward(start, async (n) => {
    const p = await probeStop(n, dateStr, authHeader, companyCode);
    return { exists: p.exists, isNew: !!p.record, record: p.record ?? undefined };
  }, opts);
  if (r.maxSeen > observedFrontier) observedFrontier = r.maxSeen;
  return { records: r.records, complete: r.complete, ceiling: r.maxSeen || fromStopNbr, floor: start, maxSeen: r.maxSeen };
}

// Forward load discovery: re-pull already-known active loads (status updates),
// then walk UP from the last-known max load number for NEW loads until the
// frontier runs dry. Returns flattened stop rows like scanLoadNumbers.
async function scanLoadForward(dateStr: string, fromLoadNbr: number, knownActive: number[], opts: ForwardScanOpts = {}) {
  const { companyCode } = getCreds();
  const authHeader = basicAuthHeader();
  const knownRows = knownActive.length ? await scanLoadNumbers(dateStr, knownActive) : [];
  const fwd = await scanForward(fromLoadNbr + 1, async (n) => {
    const rows = await probeLoad(n, dateStr, authHeader, companyCode);
    const hit = !!(rows && rows.length);
    return { exists: hit, isNew: hit, record: hit ? rows : undefined };
  }, opts);
  return [...knownRows, ...fwd.records.flat()];
}

export interface ScanResult {
  date: string;
  stops: NormalizedStop[];
  plannedCount: number;
  unplannedCount: number;
  scannedAt: string;
  // Phase 4: per-load header (vehicleType/origin/pallets/…) keyed by loadNbr, so
  // deriveFleetSummary can build SITE A's complete fleet cards. Empty when scans
  // are disabled.
  loadHeaders?: Record<string, any>;
  // True when the unplanned/status-10 descent ran this scan (false = load-only).
  includeUnplanned?: boolean;
  // True when the load-number scan ran this scan (false = unplanned-only — used
  // for tomorrow's order descent before its loads exist, ~10am-8pm ET).
  includeLoads?: boolean;
  // Step 1 instrumentation. descentComplete: the unplanned descent reached the
  // floor / early-stopped by design (not truncated by cap/budget/breaker) — only
  // set when includeUnplanned. observedFrontierStopNbr: highest stop number seen.
  descentComplete?: boolean;
  observedFrontierStopNbr?: number | null;
}

// Full scan for one date: planned (load scan) + unplanned (number-space scan),
// deduped (load-sourced wins), normalized. Used by the background writer.
export async function scanDate(dateStr: string, opts: { unplanned?: UnplannedScanOpts; includeUnplanned?: boolean; includeLoads?: boolean; loadTargets?: number[] | null; forwardLoad?: { start: number; known?: number[] } | null; forwardUnplanned?: { start: number } | null } = {}): Promise<ScanResult> {
  const includeUnplanned = opts.includeUnplanned !== false; // default true
  const includeLoads = opts.includeLoads !== false;         // default true
  // P0 kill switch — when scans are disabled, generate ZERO NuVizz traffic and
  // return an empty result. Callers (background refresh / history snapshot) treat
  // this as "nothing new to write" and leave the existing Firestore index intact.
  if (!scansEnabled()) {
    return { date: dateStr, stops: [], plannedCount: 0, unplannedCount: 0, scannedAt: new Date().toISOString(), includeUnplanned, includeLoads };
  }
  // Phase 2: when loadTargets is provided (lean discovery from scan_state), probe
  // exactly that set; forwardLoad → adaptive forward walk from the carried frontier;
  // otherwise probe the calibrated ±window (cold-start fallback).
  const useTargets = Array.isArray(opts.loadTargets) && opts.loadTargets.length > 0;
  const useForwardLoad = !!opts.forwardLoad;
  // partialLoad = we deliberately probed a SUBSET (lean set / forward walk), not the
  // full window — so don't calibrate the cold-start window off it (would poison it).
  const partialLoad = useTargets || useForwardLoad;
  const { startNbr, endNbr } = partialLoad ? { startNbr: 0, endNbr: 0 } : estimateLoadRange(dateStr);
  // includeLoads=false → unplanned-only (skip the load-number scan entirely — no
  // /load/info probes). includeUnplanned=false → load-only (skip the descent +
  // its findCeiling probing). At least one is always true at the call sites.
  const EMPTY_DESCENT = { records: [] as any[], complete: true, ceiling: 0, floor: 0, maxSeen: 0 };
  const loadScan = !includeLoads
    ? Promise.resolve([] as any[])
    : useForwardLoad
      ? scanLoadForward(dateStr, opts.forwardLoad!.start, opts.forwardLoad!.known || [])
      : useTargets
        ? scanLoadNumbers(dateStr, opts.loadTargets as number[])
        : scanLoadRangeForDate(dateStr, startNbr, endNbr);
  const unplannedScan = !includeUnplanned
    ? Promise.resolve(EMPTY_DESCENT)
    : opts.forwardUnplanned
      ? scanUnplannedForward(dateStr, opts.forwardUnplanned.start).catch(() => ({ ...EMPTY_DESCENT, complete: false }))
      : scanUnplannedStops(dateStr, opts.unplanned).catch(() => ({ ...EMPTY_DESCENT, complete: false }));
  const [loadStops, descent] = await Promise.all([loadScan, unplannedScan]);
  const unplannedStops = descent.records;

  const seen = new Set<string>(loadStops.map((s: any) => s.stopNbr).filter(Boolean));
  const extraUnplanned = unplannedStops.filter((u: any) => {
    const nbr = u?.stop?.stopNbr;
    return nbr && !seen.has(nbr);
  });

  const stops = [...loadStops, ...extraUnplanned].map(normalizeStop);
  const unplannedCount = stops.filter((s) => !s.isPlanned).length;

  // Phase 4: collect the load headers (one per loadNbr) from the raw load-scan
  // rows before normalization drops them. deriveFleetSummary merges these in.
  const loadHeaders: Record<string, any> = {};
  for (const ls of loadStops as any[]) {
    const L = ls?.load;
    if (L?.loadNbr && !loadHeaders[L.loadNbr]) {
      const { stopSeq, ...rest } = L;
      loadHeaders[L.loadNbr] = rest;
    }
  }

  // Self-calibrate the load-number window from the loads actually found, so the
  // next scan of this date uses a tight, accurate range (see estimateLoadRange).
  // Only from a FULL wide-window scan — never from a lean target set (useTargets):
  // a lean scan deliberately omits terminal low-end loads, so calibrating off it
  // would poison the cold-start fallback window with an artificially-high min.
  if (includeLoads && !partialLoad) calibrateLoadRange(dateStr, Object.keys(loadHeaders));

  return {
    date: dateStr,
    stops,
    loadHeaders,
    plannedCount: stops.length - unplannedCount,
    unplannedCount,
    scannedAt: new Date().toISOString(),
    includeUnplanned,
    includeLoads,
    // Step 1 instrumentation: descent metadata (only meaningful when the unplanned
    // descent ran this scan). descentComplete=false ⇒ truncated, don't trust the
    // high-water to advance the lean floor (R9).
    descentComplete: includeUnplanned ? descent.complete : undefined,
    observedFrontierStopNbr: includeUnplanned ? (descent.maxSeen || null) : undefined,
  };
}

// ── Incremental-scan shadow helpers (call-reduction Phase 1) ─────────────────
// PURE: derive the next scan_state from a scan's normalized stops + the prior
// state, and compute what lean planned-discovery WOULD probe. Phase 1 only logs
// the comparison; later phases act on it. Unit-tested.
export function stopNbrToInt(stopNbr: any): number | null {
  const m = /\d+/.exec(String(stopNbr ?? ''));
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}
// loadNbr like "DAVIS000196999" → the embedded integer 196999 (what gets probed).
export function loadNbrToInt(loadNbr: any): number | null {
  const digits = String(loadNbr ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

// PURE: group a scan's PLANNED stops into { loadNbr: sorted stopNbr[] }. Lets the
// next cycle diff membership to detect stops pulled off a load (R1). Exported for
// reuse by the shadow parity log and for unit tests.
export function groupLoadMembers(stops: any[]): Record<string, string[]> {
  const sets: Record<string, Set<string>> = {};
  for (const s of stops || []) {
    if (s && s.isPlanned && s.loadNbr && s.stopNbr) (sets[s.loadNbr] ||= new Set<string>()).add(String(s.stopNbr));
  }
  const out: Record<string, string[]> = {};
  // Numeric sort (stop numbers are numeric strings — a default lexicographic
  // sort would order "10" before "9"). Set-membership comparisons don't depend on
  // order, but keeping the stored arrays/logs numerically ordered avoids foot-guns.
  for (const k of Object.keys(sets)) out[k] = [...sets[k]].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  return out;
}

// PURE: should this cycle run a DEEP SWEEP (full-floor, relaxed-early-stop unplanned
// descent)? True when none has run yet (cold) or the interval since the last has
// elapsed. The deep sweep is the safety net that catches low advance-order
// stragglers / date-changed orders the lean frontier floor would skip.
export function shouldDeepSweep(lastAtISO: string | null | undefined, nowMs: number, intervalMs: number): boolean {
  if (!lastAtISO) return true;
  const last = Date.parse(lastAtISO);
  if (!Number.isFinite(last)) return true;
  return (nowMs - last) >= intervalMs;
}

// Whether THIS unplanned cycle may run the full-floor deep sweep — the only ~2k-probe
// descent, and the cause of the 10am open SPIKE (shouldDeepSweep() returns true on a
// cold day, so the very first unplanned cycle would otherwise full-sweep). Pure so the
// "never spike on the cold open" guarantee is unit-tested. The sweep runs only when:
//   - it's DUE (shouldDeepSweep), AND
//   - the cycle is WARM (today's unplanned high-water already set by the cheap forward
//     walk) — never the cold opening cycle, which must ramp gently, AND
//   - we're at/after the off-peak ET hour, so the one daily reconciliation lands in the
//     afternoon lull instead of the morning order rush.
export function deepSweepGate(opts: { due: boolean; todayUnplannedWarm: boolean; etHour: number; offPeakHour: number }): boolean {
  return opts.due && opts.todayUnplannedWarm && opts.etHour >= opts.offPeakHour;
}

export function buildScanState(
  dateStr: string,
  stops: any[],
  prev: ScanState | null,
  nowISO: string,
  extra?: { descentComplete?: boolean; observedFrontierStopNbr?: number | null; deepSweepRan?: boolean },
): ScanState {
  // Merge the prior roster so an unplanned-only cycle can't wipe known loads.
  const merged = new Map<string, KnownLoad>();
  for (const k of prev?.knownLoads || []) merged.set(k.loadNbr, { ...k });

  // R9: a TRUNCATED descent (cap / time budget / breaker) did NOT reach the true
  // frontier, so it must not advance the unplanned high-water (which bounds the
  // lean floor) nor be trusted to refresh the known-unplanned set. descentComplete
  // is: true = ran & reached floor/early-stopped; false = ran & truncated;
  // undefined = the descent didn't run this cycle (load-only / kill-switch). We
  // advance the high-water unless EXPLICITLY truncated (undefined defaults to the
  // legacy "trust it" behaviour — load-only cycles have no unplanned stops anyway).
  const descentTruncated = extra?.descentComplete === false;
  const descentCompleted = extra?.descentComplete === true;

  // Group THIS scan's planned stops by load; a load is allTerminal only when
  // EVERY one of its stops is DELIVERED (status 90/91) — conservative on purpose.
  const seenLoad = new Map<string, { routeName: string | null; allTerminal: boolean }>();
  let highWater = prev?.highWaterStopNbr ?? null;
  // Separate UNPLANNED-only high-water: the lean order descent bounds off the
  // unplanned frontier, NOT the global max — a planned stop number far above the
  // order cluster must not ratchet the floor past genuine new unplanned orders.
  let highWaterUnplanned = prev?.highWaterUnplannedStopNbr ?? null;
  for (const s of stops) {
    const sn = stopNbrToInt(s.stopNbr);
    if (sn != null) {
      highWater = highWater == null ? sn : Math.max(highWater, sn);
      if (s.isPlanned === false && !descentTruncated) highWaterUnplanned = highWaterUnplanned == null ? sn : Math.max(highWaterUnplanned, sn);
    }
    if (s.isPlanned && s.loadNbr) {
      const cur = seenLoad.get(s.loadNbr) || { routeName: s.routeName || null, allTerminal: true };
      if (!cur.routeName && s.routeName) cur.routeName = s.routeName;
      if (s.normalizedStatus !== 'DELIVERED') cur.allTerminal = false;
      seenLoad.set(s.loadNbr, cur);
    }
  }
  const routeMap: Record<string, string> = { ...(prev?.routeMap || {}) };
  for (const [loadNbr, v] of seenLoad) {
    merged.set(loadNbr, { loadNbr, routeName: v.routeName, allTerminal: v.allTerminal, lastSeenAt: nowISO });
    if (v.routeName) routeMap[v.routeName] = loadNbr;
  }

  const knownLoads = [...merged.values()];
  // loadNbr is the prefixed, zero-padded form (e.g. "DAVIS000196999"); the load
  // NUMBER scanLoadRangeForDate probes is the embedded integer (196999). Extract
  // the digits so min/max are comparable to estimateLoadRange's integer space.
  const nums = knownLoads.map((k) => loadNbrToInt(k.loadNbr)).filter((n): n is number => n != null);
  // Merge per-load members: keep prior members for loads NOT re-scanned this cycle
  // (e.g. future terminal-skipped loads), overwrite with the fresh grouping for
  // loads we did see. In the Step-1 wide shadow every load is seen, so this is just
  // the current grouping; the merge keeps it correct once lean coverage lands.
  const loadMembers = { ...(prev?.loadMembers || {}), ...groupLoadMembers(stops) };
  // Known-unplanned set: refresh ONLY from a descent that RAN AND COMPLETED. That
  // single condition correctly handles every other case — a truncated descent
  // (don't trust the partial set), a load-only cycle, and a kill-switched/empty
  // scan (descentComplete undefined) all carry the prior set instead of wiping it.
  // Default to [] (never undefined) so the Firestore doc stays clean.
  const unplannedStopNbrs = descentCompleted
    ? [...new Set(stops.filter((s) => s.isPlanned === false).map((s) => stopNbrToInt(s.stopNbr)).filter((n): n is number => n != null))].sort((a, b) => a - b)
    : (prev?.unplannedStopNbrs ?? []);
  return {
    date: dateStr,
    knownLoads,
    minLoadNbr: nums.length ? Math.min(...nums) : (prev?.minLoadNbr ?? null),
    maxLoadNbr: nums.length ? Math.max(...nums) : (prev?.maxLoadNbr ?? null),
    highWaterStopNbr: highWater,
    highWaterUnplannedStopNbr: highWaterUnplanned,
    routeMap,
    lastScanAt: nowISO,
    scanCount: (prev?.scanCount || 0) + 1,
    loadMembers,
    // Carry the prior flag when this cycle didn't run the descent (load-only);
    // default false so the field is never undefined on the persisted doc.
    descentComplete: extra?.descentComplete ?? prev?.descentComplete ?? false,
    observedFrontierStopNbr: extra?.observedFrontierStopNbr ?? prev?.observedFrontierStopNbr ?? null,
    unplannedStopNbrs,
    // Stamp the deep-sweep time only on a cycle that actually ran one; else carry.
    lastDeepSweepAt: extra?.deepSweepRan ? nowISO : (prev?.lastDeepSweepAt ?? undefined),
  };
}

export interface WouldProbe { activeLoads: number; terminalLoads: number; forwardBuffer: number; wouldProbe: number }
export function shadowWouldProbe(state: ScanState, opts: { inWindow: boolean; fwdIn?: number; fwdOut?: number }): WouldProbe {
  const active = state.knownLoads.filter((k) => !k.allTerminal).length;
  // Overnight routing window = volatile → larger forward buffer for new load numbers;
  // daytime = stable → small buffer for the rare add.
  const forwardBuffer = opts.inWindow ? (opts.fwdIn ?? 50) : (opts.fwdOut ?? 10);
  return { activeLoads: active, terminalLoads: state.knownLoads.length - active, forwardBuffer, wouldProbe: active + forwardBuffer };
}

// ── Phase 2: lean load-discovery planner (PURE) ──────────────────────────────
// Decide which load NUMBERS to probe this cycle from today's scan_state, instead
// of the ±300 window. Returns null → caller MUST fall back to the wide window
// (cold start: no roster for today yet). Terminal loads are dropped (terminal-skip).
export interface LoadProbePlan {
  numbers: number[];
  mode: 'lean-warm';
  activeLoads: number; forwardBuffer: number; gapSweep: boolean;
}
export function selectLoadProbeTargets(
  todayState: ScanState | null,
  opts: { inWindow: boolean; scanCount: number; fwdIn?: number; fwdOut?: number; gapSweepEvery?: number },
): LoadProbePlan | null {
  const fwd = opts.inWindow ? (opts.fwdIn ?? 50) : (opts.fwdOut ?? 10);

  // WARM — we already have today's roster: re-pull NON-TERMINAL loads (terminal-skip),
  // + a forward buffer above maxLoadNbr (catch appended routes), + a periodic gap
  // re-sweep across [min,max] (catch mid-window inserts), in-window only.
  if (todayState && todayState.knownLoads.length && todayState.maxLoadNbr != null && todayState.minLoadNbr != null) {
    const known = new Set<number>();
    const active: number[] = [];
    const terminal: number[] = [];
    for (const k of todayState.knownLoads) {
      const n = loadNbrToInt(k.loadNbr);
      if (n == null) continue;
      known.add(n);
      if (!k.allTerminal) active.push(n); else terminal.push(n);
    }
    const max = todayState.maxLoadNbr, min = todayState.minLoadNbr;
    const forward: number[] = [];
    for (let n = max + 1; n <= max + fwd; n++) forward.push(n);
    const every = opts.gapSweepEvery ?? 3;
    // Gap-sweep [min,max] for loads NOT yet in the roster — e.g. a route shell that
    // gained today-stops AFTER the cold scan (dispatch routing mid-day). Davis
    // routes during the DAY, so sweep EVERY out-of-window cycle (daytime cadence is
    // already slow); overnight (high-frequency, volatile) sweep every Nth for cost.
    const doGap = every > 0 && (!opts.inWindow || (opts.scanCount % every === 0));
    const gaps: number[] = [];
    if (doGap) for (let n = min; n <= max; n++) if (!known.has(n)) gaps.push(n);
    // R2: on gap-sweep cycles, also re-confirm TERMINAL (all-delivered) loads —
    // otherwise a load is dropped forever once done and a same-day delivery
    // correction / re-added stop on it would never be seen again.
    const terminals = doGap ? terminal : [];
    const numbers = [...new Set([...active, ...forward, ...gaps, ...terminals])].sort((a, b) => b - a);
    return { numbers, mode: 'lean-warm', activeLoads: active.length, forwardBuffer: fwd, gapSweep: doGap };
  }

  // COLD START (no roster for today yet) → return null so the caller uses the
  // PROVEN wide ±window probe for this one cycle. We intentionally do NOT seed a
  // one-directional forward span from the prior day: an audit showed that if a
  // day's load numbers don't increment contiguously (~+100/day) the real loads can
  // fall outside the span AND the non-null plan would suppress the wide fallback —
  // a parity gap. Correctness over savings: one wide scan per day (the first
  // overnight cycle) seeds an accurate roster; every later cycle that day goes lean.
  return null;
}

// ── Phase 4: derive the canonical fleet summary from normalized stops ─────────
// SITE A's mobile dashboard needs a load-level view (load list + aggregate +
// driver index). Planned stops carry loadNbr / driverName / routeName /
// normalizedStatus, and scanDate now also returns loadHeaders (vehicleType,
// origin, pallet/carton/weight, loadId), so the sole scanner can derive SITE A's
// COMPLETE nuvizzFleet shape WITHOUT a second scan — that's what lets SITE A stop
// scanning NuVizz and read Firestore instead. Pure + unit-tested.
export interface DerivedLoad {
  loadNbr: string; route: string | null; driver: string | null; driverUserName: string | null;
  driverEmail: string | null; loadId: string | null; vehicleType: string | null; startDate: string | null;
  totalStops: number; delivered: number; inProgress: number; exceptions: number; pctComplete: number;
  totalPallets: number | null; totalCartons: number | null; weight: number | null;
  origin: any;
}
export interface DerivedFleet {
  loads: DerivedLoad[];
  summary: {
    totalLoads: number; assignedLoads: number; unassignedLoads: number;
    totalStops: number; totalDelivered: number; totalInProgress: number;
    totalExceptions: number; uniqueDrivers: number; pctComplete: number;
  };
  driverIndex: Record<string, string[]>;
}

export function deriveFleetSummary(stops: any[], loadHeaders: Record<string, any> = {}): DerivedFleet {
  const byLoad = new Map<string, any[]>();
  for (const s of stops || []) {
    if (!s || !s.isPlanned || !s.loadNbr) continue;
    if (!byLoad.has(s.loadNbr)) byLoad.set(s.loadNbr, []);
    byLoad.get(s.loadNbr)!.push(s);
  }
  const loads: DerivedLoad[] = [];
  const driverIndex: Record<string, string[]> = {};
  let totalStops = 0, totalDelivered = 0, totalInProgress = 0, totalExceptions = 0, assignedLoads = 0;
  const drivers = new Set<string>();
  for (const [loadNbr, ls] of byLoad) {
    const delivered = ls.filter((s) => s.normalizedStatus === 'DELIVERED').length;
    const inProgress = ls.filter((s) => s.normalizedStatus === 'OUT_FOR_DEL' || s.normalizedStatus === 'ARRIVED').length;
    const exceptions = ls.filter((s) => s.normalizedStatus === 'EXCEPTION').length;
    const driverUserName = ls.find((s) => s.driverUserName)?.driverUserName || null;
    const driver = ls.find((s) => s.driverName)?.driverName || null;
    const route = ls.find((s) => s.routeName)?.routeName || null;
    const h = loadHeaders[loadNbr] || {};
    const n = ls.length;
    if (driverUserName) { assignedLoads++; drivers.add(driverUserName); (driverIndex[driverUserName] ||= []).push(loadNbr); }
    totalStops += n; totalDelivered += delivered; totalInProgress += inProgress; totalExceptions += exceptions;
    loads.push({
      loadNbr, route, driver, driverUserName,
      driverEmail: h.driverEmail ?? null, loadId: h.loadId ?? null, vehicleType: h.vehicleType ?? null, startDate: h.startDate ?? null,
      totalStops: n, delivered, inProgress, exceptions, pctComplete: n ? Math.round((delivered / n) * 100) : 0,
      totalPallets: h.totalPallets ?? null, totalCartons: h.totalCartons ?? null, weight: h.weight ?? null,
      origin: h.origin ?? null,
    });
  }
  loads.sort((a, b) => a.loadNbr.localeCompare(b.loadNbr));
  return {
    loads,
    summary: {
      totalLoads: loads.length, assignedLoads, unassignedLoads: loads.length - assignedLoads,
      totalStops, totalDelivered, totalInProgress, totalExceptions,
      uniqueDrivers: drivers.size,
      pctComplete: totalStops ? Math.round((totalDelivered / totalStops) * 100) : 0,
    },
    driverIndex,
  };
}
