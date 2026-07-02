// lib/marginiq.mts
//
// Resolves a driver's mobile number from MarginIQ's `employees` collection in the
// shared Firestore, so "Text driver" can send without the phone ever reaching the
// browser. Matches by normalized name across fullName / first+last / aliases.
//
// employees doc shape (discovered): { fullName, firstName, lastName, aliases[],
//   phone (10-digit), role ("driver"/"owner…"), status ("active"), externalIds{…} }.

import { listDocs } from './firestore.mts';
import { normalizePhone, validUsPhone } from './sms.mts';

const COLLECTION = process.env.MARGINIQ_EMPLOYEES_COLLECTION || 'employees';
const TTL_MS = 10 * 60 * 1000;
let __cache: { at: number; map: Map<string, string> } | null = null;
let __rosterCache: { at: number; rows: EmployeeContact[] } | null = null;

// A messageable person from the employee roster. `group` separates the contact
// list into Drivers vs Contractors (owner-operators / carriers) vs office Team,
// so the Messages contact picker can show them in labeled sections.
export type ContactGroup = 'driver' | 'contractor' | 'team';
export interface EmployeeContact {
  id: string;
  name: string;
  phone: string;   // normalized 10-digit
  role: string;    // raw role string from the roster
  group: ContactGroup;
}

// Normalize a name for matching: lowercase, strip punctuation, collapse spaces,
// and sort tokens so "Smith, Tony" and "Tony Smith" match.
function normName(s: any): string {
  const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return t.sort().join(' ');
}

// Bucket a raw role string into a contact group. Drivers are employees who drive;
// owner-operators / contractors / carriers are external; everyone else is "team".
export function employeeGroup(role: any): ContactGroup {
  const r = String(role ?? '').toLowerCase();
  if (r.includes('driver')) return 'driver';
  if (r.includes('owner') || r.includes('operator') || r.includes('contractor') || r.includes('carrier') || r.includes('vendor')) return 'contractor';
  return 'team';
}

// Best-name for a roster row: explicit fullName, else first+last.
function rowName(e: any): string {
  return String(e?.fullName || [e?.firstName, e?.lastName].filter(Boolean).join(' ') || '').trim();
}

// A roster row counts as messageable if it's active (or status unknown) and has a
// valid 10-digit phone. Deactivated/terminated employees are dropped.
function isMessageable(e: any): boolean {
  const status = String(e?.status ?? 'active').toLowerCase();
  return status === '' || status === 'active' || status === 'enabled' || status === 'available';
}

async function loadMap(): Promise<Map<string, string>> {
  if (__cache && Date.now() - __cache.at < TTL_MS) return __cache.map;
  const map = new Map<string, string>();
  try {
    const rows = await listDocs(COLLECTION);
    for (const e of rows) {
      const phone = normalizePhone(e?.phone);
      if (!validUsPhone(phone)) continue;
      const names = [
        e?.fullName,
        [e?.firstName, e?.lastName].filter(Boolean).join(' '),
        ...(Array.isArray(e?.aliases) ? e.aliases : []),
      ];
      for (const n of names) { const k = normName(n); if (k && !map.has(k)) map.set(k, phone); }
    }
  } catch (e: any) { console.warn(`[marginiq] employees load failed: ${e?.message}`); }
  __cache = { at: Date.now(), map };
  return map;
}

// Phone for a driver name, or null if no employee match / no valid phone.
export async function resolveDriverPhone(name: string): Promise<string | null> {
  const k = normName(name);
  if (!k) return null;
  const map = await loadMap();
  return map.get(k) || null;
}

// The full messageable roster (drivers + contractors + team), grouped and sorted
// by name. Powers the Messages contact picker so the dispatcher can start a new
// text to anyone on the roster without first knowing their number. Cached briefly
// per function instance — a roster changes rarely.
export async function listEmployees(): Promise<EmployeeContact[]> {
  if (__rosterCache && Date.now() - __rosterCache.at < TTL_MS) return __rosterCache.rows;
  const out: EmployeeContact[] = [];
  try {
    const rows = await listDocs(COLLECTION);
    const seen = new Set<string>();
    for (const e of rows) {
      if (!isMessageable(e)) continue;
      const phone = normalizePhone(e?.phone);
      if (!validUsPhone(phone) || seen.has(phone)) continue;
      const name = rowName(e);
      if (!name) continue;
      seen.add(phone);
      out.push({ id: String(e?._id || phone), name, phone, role: String(e?.role || ''), group: employeeGroup(e?.role) });
    }
  } catch (e: any) { console.warn(`[marginiq] listEmployees failed: ${e?.message}`); }
  out.sort((a, b) => a.name.localeCompare(b.name));
  __rosterCache = { at: Date.now(), rows: out };
  return out;
}
