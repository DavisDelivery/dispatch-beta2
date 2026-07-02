# P0 — M2.1 Scanner Regression Diagnosis

**Date:** 2026-05-22
**Diagnostic conclusion:** The premise of "regression" is invalid. M2.1 scanner code was never merged to `main`. There is nothing on `main` that could have regressed.

---

## What the brief assumed

> "Yesterday detected many STRAIGHT TRUCK ONLY stops. Today only OES Equipment shows flagged. Something regressed between M4.1, M4.1.5, M4.1.6."

This frames Problem C as a regression bug — code that worked on `main` yesterday is broken on `main` today.

## What is actually true

### Finding 1: The M2.1 scanner code is on an unmerged branch

The branch `origin/claude/dispatch-map-m2.1-scanner` contains the scanner:

- `dispatch-map/src/lib/signal-scanner.ts` (118 lines, scans SPL-INSTR-TEXT + addressLine2)
- `dispatch-map/src/lib/customer-notes-writer.ts` (235 lines, writes to Firestore with auto_sources)

Relevant commits on that branch (none of which appear in `main`'s history):

```
07e0575 M2.1: auto-scanner for SPL-INSTR-TEXT + addressLine2 signals
d84f4f9 Source-lock Davis vs Uline signals, add general_notes, satellite toggle
2d980aa Clean up legacy auto_sources/auto_matches when migrating no_tractor_trailer -> uline_straight_truck
8c42bb8 Search box, expandable legend, flag-colored table dots, Confirm/Dismiss Uline
50f2599 Show today's saved receiving hours on marker hover + in stops table
33dab6a Auto-sign-in anonymously instead of email/password login
```

`git log main --oneline | grep -i scanner` returns nothing. `grep -rn "signal-scanner\|customer-notes-writer\|auto_sources\|SPL-INSTR" dispatch-map/src dispatch-map/netlify` on `main` returns nothing.

### Finding 2: The M2.1 branch and main diverged dramatically

`git diff main..origin/claude/dispatch-map-m2.1-scanner --stat -- dispatch-map/`:

```
 dispatch-map/HANDOFF.md                            |  641 +++----
 dispatch-map/netlify/functions/motive-driver-positions.mts | 198 +-
 dispatch-map/netlify/functions/nuvizz-debug-driver-routes.mts | 126 --   <-- DELETED on M2.1
 dispatch-map/netlify/functions/nuvizz-driver-route.mts | 267 ---           <-- DELETED on M2.1
 dispatch-map/netlify/functions/nuvizz-pull-today-stops.mts |  33 +-
 dispatch-map/src/App.jsx                           | 2014 +++++++-------/-- (-1500 net)
 dispatch-map/src/lib/customer-notes-writer.ts      |  235 +++              <-- NEW on M2.1
 dispatch-map/src/lib/distance.js                   |   36 -                <-- DELETED on M2.1
 dispatch-map/src/lib/firebase.js                   |   6 +-
 dispatch-map/src/lib/signal-scanner.ts             |  118 ++               <-- NEW on M2.1
 dispatch-map/test/fixtures/nuvizz-today-stops.json |  356 +++-
 13 files changed, 1625 insertions(+), 2411 deletions(-)
```

The M2.1 branch **deleted** the driver-route functions that `main` then went on to build M4 features around (M4, M4.1, M4.1.5, M4.1.6 — including the driver day-snapshot sidebar). The two branches are now mutually incompatible without a substantial merge resolution.

### Finding 3: Firestore confirms the scanner DID run once

Dumped `customer_notes` collection from the `davismarginiq` Firestore project: **16 docs total, all 16 with `equipment_restrictions` populated**.

Breakdown:
- 14 docs use `uline_straight_truck` (new field name introduced by commit `2d980aa`)
- 3 docs use `no_tractor_trailer` (legacy name)
- 1 doc (`apc_concepts`) has both names in `auto_sources`
- 15 docs have `auto_sources` populated (machine-written)
- 15 docs have `auto_matches` populated (machine-written)

So the scanner was deployed at *some* point in the past — likely a preview build of the M2.1 branch, or a local dev run — and wrote these 16 docs. The data has persisted because Firestore is shared across all branch deploys.

### Finding 4: `updated_at` is null on every customer_notes doc

We cannot empirically confirm or refute Chad's "yesterday >> today" observation because the timestamp field is null on every doc. Either the scanner never wrote it, or the field is stored under a different name we did not query.

The brief's P0.2 ("group by last_updated date, compare yesterday vs today") cannot be executed against this data.

### Finding 5: What is "flagging OES Equipment" right now

OES Equipment is one of the 16 docs already in Firestore. The current `main` build of dispatch-map reads `customer_notes` via `onSnapshot(collection(db, 'customer_notes'))` at `src/App.jsx:325` and renders any doc with `equipment_restrictions.length > 0` as restricted on the map. So OES (and the 15 others) show as flagged because the **read** path on `main` works fine — it's the **write** path (the scanner itself) that does not exist on `main`.

## What the brief got wrong

The brief assumed three problems share a root cause and can ship in one PR:
- **A. PROs missing** — real, present on `main`, can be addressed in this PR.
- **B. Routes missing** — real, present on `main`, can be addressed in this PR.
- **C. Scanner regression** — *misdiagnosed*. There is no scanner on `main` to regress. M2.1 was never merged.

## What Problem C actually requires

Three options, ranked by surface area:

1. **Forward-port the M2.1 branch into `main`.** Resolve the conflict where M2.1 deleted `nuvizz-driver-route.mts` and `nuvizz-debug-driver-routes.mts` (which M4 work on `main` then built on). Reconcile a ~1500-line App.jsx delta. Bring `signal-scanner.ts` and `customer-notes-writer.ts` forward unchanged. Test that the scanner output still feeds the map correctly. **Estimated scope:** a full PR by itself, not a tack-on to M4.2.

2. **Rebuild the scanner from scratch on `main`.** Read the M2.1 branch's scanner logic, re-implement on the M4-heavy `main` App.jsx in a smaller, more surgical way. Skip the unrelated M2.1 changes (general_notes, anonymous sign-in, legend rework). **Estimated scope:** a focused PR by itself, smaller than option 1 but still its own deliverable.

3. **Defer Problem C entirely.** Ship M4.2 as A + B only. Decide later (separately) which of options 1 or 2 to take for the scanner.

## Recommended path

**Option 3.** Reasons:

- The brief authorizes "fix the regression" — but there is no regression. Forward-porting an unmerged feature branch is a different kind of change, with different risk, and Chad has not authorized that scope.
- Mixing a scanner-revival with the PRO + route pipeline work in one PR would make a future revert harder if either side breaks.
- The 16 existing detections on Firestore continue to render correctly on `main` today. Nothing is on fire — Chad just isn't getting *new* detections, which he never was on this `main` line.

This needs Chad's explicit say-so before P2 production code starts.

## Resolution

**Decision (Chad, 2026-05-22):** Defer Problem C from this PR. Ship A+B only. Scanner work gets its own PR later.

**Chad confirms:** M2.1 is currently deployed on Netlify and GitHub. This means the Netlify production site is *not* serving from `main` — it must be serving from `claude/dispatch-map-m2.1-scanner` or a deploy alias pointing at it. That divergence (prod served from a non-main branch) is worth resolving separately. It's noted here for the record but does not block the M4.2 PR.

Implication for M4.2: this PR's changes will land on `main` and only take effect in prod once the deploy source is realigned to `main` (or the M2.1 branch is forward-merged). The user should be informed at handoff so deploy expectations are realistic.
