// Address mis-split detection + auto-fix suggestion.
//
// NuVizz frequently returns the deliverable street in `addr2` while `addr1`
// holds a suite/dock/building token or a contact name (e.g. addr1 "BLDG 200" /
// addr2 "4310 INDUSTRIAL ACCESS RD", or addr1 "PROPERTY MANAGER" / addr2 "2611
// SPRINGDALE RD SW"). Because the client geocoder only ever sends `addr1`, those
// stops land on the wrong spot. These pure helpers (1) flag the pattern and
// (2) propose a corrected addr1/addr2 split so the street line gets geocoded.
//
// Conservative by design: only clear cases (a unit token leading addr1, or a
// numberless addr1 paired with a street-numbered addr2). The suite/contact text
// is always preserved in addr2 — never dropped.

// Unit / non-street tokens that should never lead a street line.
export const UNIT_LEAD = /^\s*(suite|ste|unit|apt|apartment|#|bldg|building|dock|fl|floor|rm|room|lot|spc|space|gate)\b/i;

// A real street line starts with a house number. Flag when addr1 does NOT begin
// with a digit but addr2 DOES — the deliverable street is in addr2 and addr1 is a
// dock/descriptor/contact (e.g. addr1 "MGE1 NON INVENTORY DOCK DR 178" — note it
// HAS digits but doesn't START with the house number — and addr2 "652 BROADWAY
// AVE"). This is broader than "addr1 has no digit" and catches dock descriptors.
const STARTS_WITH_NUMBER = /^\s*\d/;

// True when a stop's addr1 looks mis-split. Clears automatically once the stop
// has an address_override (i.e. it's already been corrected).
export function addressLooksOff(stop, note) {
  if (!stop) return false;
  if (note && note.address_override) return false;
  const a1 = String(stop.addr1 || '').trim();
  const a2 = String(stop.addr2 || '').trim();
  if (!a1) return false;
  if (UNIT_LEAD.test(a1)) return true;                                  // suite/dock/contact token in front
  if (!STARTS_WITH_NUMBER.test(a1) && STARTS_WITH_NUMBER.test(a2)) return true; // street (house #) is in addr2
  return false;
}

// Propose a corrected { addr1, addr2, reason } split, or null when we can't
// confidently fix it (caller should fall back to a manual edit).
export function suggestAddressFix(stop) {
  if (!stop) return null;
  const a1 = String(stop.addr1 || '').trim();
  const a2 = String(stop.addr2 || '').trim();

  // Case A — addr1 leads with a unit/contact token.
  if (UNIT_LEAD.test(a1)) {
    // A1: the unit and the street share addr1 ("BLDG 200 4310 INDUSTRIAL ACCESS RD").
    // Split at the first run of digits that starts the street portion.
    const m = a1.match(/^\s*((?:suite|ste|unit|apt|apartment|#|bldg|building|dock|fl|floor|rm|room|lot|spc|space|gate)\b\.?\s*#?\s*\S+)\s+(\d.*)$/i);
    if (m) {
      const suite = m[1].trim(), street = m[2].trim();
      return { addr1: street, addr2: a2 ? `${suite}, ${a2}` : suite, reason: 'suite was in front of the street' };
    }
    // A2: addr1 is only the unit/contact ("BLDG 200"); the street is in addr2 → swap.
    if (/\d/.test(a2)) return { addr1: a2, addr2: a1, reason: 'street was in addr2 (swapped)' };
    return null; // can't confidently split
  }

  // Case B — addr1 doesn't start with a house number but addr2 does → swap so the
  // real street (e.g. "652 BROADWAY AVE") leads and the dock/descriptor moves to addr2.
  if (!STARTS_WITH_NUMBER.test(a1) && STARTS_WITH_NUMBER.test(a2)) {
    return { addr1: a2, addr2: a1, reason: 'street was in addr2 (swapped)' };
  }
  return null;
}
