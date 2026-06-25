// KNOWN LOADS — the fixed set of UAT loads we work with, so the Routing board
// needs NO scan and NO discovery read to show targets. Edit this list to match
// the loads you're using.
//
// Each entry: { loadNbr, name?, loadId? }
//   - loadNbr is required (e.g. 'LOAD000112222').
//   - name is just a label for the picker.
//   - loadId is OPTIONAL. insertStops needs the internal loadId; if it's omitted
//     here, Routing resolves it ONCE via getLoad on the first Plan onto that load
//     and caches it in localStorage (dd_loadid_cache), so it's read at most once.
//     Provide loadId here to avoid even that one read.
//
// Seeded from the UAT portal (Draft loads — plannable). Replace with yours.
export const KNOWN_LOADS = [
  { loadNbr: 'LOAD000112226', name: 'XZS' },
  { loadNbr: 'LOAD000112223', name: 'TODAY_2' },
  { loadNbr: 'LOAD000112222', name: 'TODAY_1' },
  { loadNbr: 'LOAD000112221', name: 'TESTROUTE1A' },
  { loadNbr: 'LOAD000112220', name: 'TESTJUN' },
  { loadNbr: 'LOAD000112219', name: 'TESTHB2' },
  { loadNbr: 'LOAD000112218', name: 'TESTHB1' },
  { loadNbr: 'LOAD000112217', name: 'TESTH1' },
]
