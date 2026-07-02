// Match-key normalization for customer_notes lookup.
// Spec: take (businessName, addressLine1, city, zip), normalize suffixes,
// strip punctuation, collapse whitespace to underscores, and join with __ separators.
// The same business at the same street address across different PROs must produce
// the same key, even if NuVizz returns slightly different name casing or trailing "LLC".

const NAME_SUFFIXES = /\b(llc|inc|corp|corporation|company|co|ltd)\b\.?/g;

const STREET_REPLACEMENTS = [
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

export function normalizeMatchKey(businessName, addressLine1, city, zip) {
  const safe = (v) => (v == null ? '' : String(v));
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
