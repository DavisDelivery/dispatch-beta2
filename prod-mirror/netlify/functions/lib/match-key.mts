// lib/match-key.mts
//
// Server-side mirror of src/lib/matchKey.js. The CLIENT computes a stop's
// customer_notes key from (businessName, addr1, city, zip); the scheduled scan
// has no access to that client code, so to cross-reference a scanned stop against
// its customer note (e.g. the "notify CS" flag) it must reproduce the SAME key.
//
// KEEP IN SYNC with src/lib/matchKey.js — test/match-key-parity.test.mjs asserts
// both produce identical keys for a sample set, so a drift fails CI.

const NAME_SUFFIXES = /\b(llc|inc|corp|corporation|company|co|ltd)\b\.?/g;

const STREET_REPLACEMENTS: [RegExp, string][] = [
  [/\b(suite|ste|unit|apt)\b\.?\s*#?/g, 'ste_'],
  [/\b(parkway|pkwy)\b\.?/g, 'pkwy'],
  [/\b(boulevard|blvd)\b\.?/g, 'blvd'],
  [/\b(drive|dr)\b\.?/g, 'dr'],
  [/\b(street|st)\b\.?/g, 'st'],
  [/\b(road|rd)\b\.?/g, 'rd'],
  [/\b(avenue|ave)\b\.?/g, 'ave'],
  [/\b(highway|hwy)\b\.?/g, 'hwy'],
  [/\b(north|n)\b\.?/g, 'n'],
  [/\b(south|s)\b\.?/g, 's'],
  [/\b(east|e)\b\.?/g, 'e'],
  [/\b(west|w)\b\.?/g, 'w'],
];

export function normalizeMatchKey(businessName: any, addressLine1: any, city: any, zip: any): string {
  const safe = (v: any) => (v == null ? '' : String(v));
  const normName = safe(businessName)
    .toLowerCase()
    .replace(NAME_SUFFIXES, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '_')
    .trim();

  let normStreet = safe(addressLine1).toLowerCase();
  for (const [re, sub] of STREET_REPLACEMENTS) normStreet = normStreet.replace(re, sub);
  normStreet = normStreet
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '_')
    .trim();

  const normCity = safe(city).toLowerCase().replace(/[^\w]/g, '');
  const zip5 = safe(zip).substring(0, 5);

  return `${normName}__${normStreet}__${normCity}__${zip5}`;
}
