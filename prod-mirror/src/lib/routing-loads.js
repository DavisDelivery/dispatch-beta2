// src/lib/routing-loads.js
//
// Pure helpers for the Shared Loads view — auto-name, summary, and the standard
// date/time format ("Jun 5, 2026 2:14p"). Extracted so they're unit-testable
// without the React/Firestore shell. Time is rendered in America/New_York (the
// depot/dispatch timezone) so it's stable regardless of the device clock.

const TZ = 'America/New_York';

// Epoch ms (or Date) → "Jun 5, 2026 2:14p". Empty string on bad input.
export function formatDateTime(input) {
  if (input == null) return '';
  const d = input instanceof Date ? input : new Date(Number(input));
  if (Number.isNaN(d.getTime())) return '';
  const date = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value || '';
  const minute = parts.find((p) => p.type === 'minute')?.value || '00';
  const ap = (parts.find((p) => p.type === 'dayPeriod')?.value || '').toLowerCase().startsWith('p') ? 'p' : 'a';
  return `${date} ${hour}:${minute}${ap}`;
}

// Normalize a Firestore Timestamp / millis / Date / ISO string → epoch ms or null.
export function tsToMillis(ts) {
  if (ts == null) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  if (ts instanceof Date) return ts.getTime();
  const n = Number(ts);
  if (Number.isFinite(n)) return n;
  const p = Date.parse(ts);
  return Number.isFinite(p) ? p : null;
}

export function loadTruckCount(result) {
  return Array.isArray(result?.routes) ? result.routes.length : 0;
}

export function loadStopCount(result) {
  if (!Array.isArray(result?.routes)) return 0;
  return result.routes.reduce((a, r) => a + (Array.isArray(r.orderedStopIds) ? r.orderedStopIds.length : 0), 0);
}

// "3 trucks · 28 stops" (+ " · N spilled" when some stops couldn't be placed).
export function loadSummary(result) {
  const t = loadTruckCount(result), s = loadStopCount(result);
  const parts = [`${t} truck${t === 1 ? '' : 's'}`, `${s} stop${s === 1 ? '' : 's'}`];
  const spill = Array.isArray(result?.unassigned) ? result.unassigned.length : 0;
  if (spill) parts.push(`${spill} spilled`);
  return parts.join(' · ');
}

// Sensible default name: "Jun 5, 2026 2:14p · 3 trucks · 28 stops".
export function buildLoadAutoName(result, nowInput) {
  const t = loadTruckCount(result), s = loadStopCount(result);
  return `${formatDateTime(nowInput)} · ${t} truck${t === 1 ? '' : 's'} · ${s} stop${s === 1 ? '' : 's'}`;
}
