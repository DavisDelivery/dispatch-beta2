# UAT prod-mirror: why the board was empty, and how it was fixed (Jul 2 2026)

Symptom: `dd-dispatch-map-uat` (the 1:1 prod-mirror site) showed **no loads or stops**
from UAT at all.

There were two independent root causes. Both are infrastructure/tenant config — the
mirror's code is untouched (the "never edit prod-mirror" invariant holds).

## Root cause 1 — prod saved-search IDs don't exist in the UAT tenant  ✅ FIXED

The scheduled scanner runs in list-discovery mode (`NUVIZZ_LIST_DISCOVERY=on`,
`NUVIZZ_TWO_SCAN=on`). Its saved searches are addressed by `customListDefId`, and the
defaults are the **production** portal tenant's IDs (active `77128`, completed `77131`,
attempts `77203`, legacy stop list `35824`, load list `35833`). `customListDefId` is
per-tenant (see `docs/NUVIZZ_API.md` — "the grid 500s without a valid one"), and
verified live: both `77128` and `35824` return **HTTP 500** from
`uat.nuvizz.com/.../entity/filterdata/VizzonStop/DAVISV5`. The list path is
deliberately list-only ("preserve last-good board, never fall back to the probe"), so
every scan aborted and the board stayed at its last-good state — which on a brand-new
site is *empty*.

(The number-probe fallback could never have saved it either: its anchors are hardcoded
to prod numbering — loads centered on `ANCHOR_LOAD=196143` probed as
`DAVISV5000196xxx`, unplanned descent anchored at stop `7124000` — while UAT loads are
`LOAD000112xxx` with an entirely different stop-number space.)

### Fix: real saved searches created in the UAT tenant (DAVISV5)

Created via the portal API (login `loginqa.nuvizz.com` → `uat.nuvizz.com`,
`routePlan/savefilter`), **Company Level** visibility, and verified end-to-end through
the exact openapi `filterdata` bodies the scanner sends:

| saved search | customListDefId | layout (filter positions the scanner hardcodes) |
|---|---|---|
| DD Mirror Active | **165484** | 12 fields — Stop Status @2, Estimated Arrival @10, Stop Created @12 |
| DD Mirror Completed | **165493** | 11 fields — Stop Status @2, Estimated Arrival @10, Stop Detail Updated @11 |
| DD Mirror Attempts | **165496** | 11 fields — Shipment Number @7 (prefix match), Estimated Arrival @9, Stop Created @10 |
| DD Mirror Loads (PkgRoute) | **165499** | 5 fields — Estimated Start Date @1 (period) |

Verification (live, Jul 2 2026): active `20,10 ±7d` → 79 rows (incl. SQTV912 with full
address/PRO/comments columns); positional status filter proven (`10`→39, `90`→10);
loads `0d` → 100 rows (incl. SQTLOADN… with real load numbers); attempts prefix match
proven case-insensitively (`PRO`→5, exact→1). Columns were chosen to cover every key
the board mapper reads (`vizzonInfo.*`, `route.name`, `route.driver.driverId`,
`route.rteNbr` = Load Number, `comments.commentList.commentText`,
`vizzonInfo.destination.dispSeq`, …).

> ⚠️ **Do not edit or delete these four filters in the UAT portal.** The scanner
> addresses their filter fields **by position** (e.g. "status is sequence 2 of 12");
> reordering/removing fields silently breaks filtering. Retune values via env instead
> (`NUVIZZ_ACTIVE_STATUS`, `NUVIZZ_ACTIVE_ARRIVAL`, …).

### Env vars set on `dd-dispatch-map-uat` (functions scope)

```
NUVIZZ_LISTDEF_ACTIVE=165484
NUVIZZ_LISTDEF_COMPLETED=165493
NUVIZZ_LISTDEF_ATTEMPTS=165496
NUVIZZ_STOP_LISTDEF=165484     # legacy single-scan body has the same 12-seq layout
NUVIZZ_LOAD_LISTDEF=165499
```

Netlify bakes function env at deploy time — **trigger a redeploy** of
`dd-dispatch-map-uat` after the database step below so these are guaranteed live.

## Root cause 2 — the named Firestore database `uat-mirror` doesn't exist  ⚠️ ONE MANUAL STEP

The mirror's env points server + client at the named Firestore database `uat-mirror`
(`FIRESTORE_DATABASE` / `VITE_FIRESTORE_DATABASE`) in the `davismarginiq` project — but
that database was **never created**. Only `(default)` exists (nam5). Every Firestore
touch 404s (`The database uat-mirror does not exist`), which aborts each scan at the
call counter and leaves the board with nothing to read. Confirmed by invoking the
mirror's `nuvizz-manual-scan` function.

The Netlify `FIREBASE_SA` service account can read/write data and manage rules but has
no `datastore.databases.create` — so this needs an Owner/Editor (console) account,
once:

```bash
gcloud firestore databases create --database=uat-mirror --location=nam5 \
  --type=firestore-native --project=davismarginiq
```

(or Firebase console → Firestore → Add database → id `uat-mirror`, location `nam5`.)

## Finishing sequence (after the database exists)

Run `node scripts/uat-mirror-finish.mjs` (needs the `FIREBASE_SA` JSON in env or a file
path argument). It:

1. deploys the project's existing open Firestore rules to the new `uat-mirror` database
   (the client SDK reads the board/notes directly, so the named DB needs its own rules
   release — the existing ruleset already matches any `{database}`);
2. triggers the mirror's manual scan (`/.netlify/functions/nuvizz-manual-scan`);
3. prints the per-date scan result so you can see loads/stops land.

Then "Trigger deploy" on `dd-dispatch-map-uat` (env-var bake, step above) and open the
board — the SQT\* evidence loads should be on it.

## Notes

- All four saved searches + the env wiring were done against UAT (`DAVISV5`) only; the
  production tenant and site are untouched.
- The mirror's own code was not modified. If prod ever wants env-tunable scan anchors
  (`NUVIZZ_LOAD_PREFIX`-style, as beta2's read client has), that change belongs in
  `davis-nuvizz` and flows here via `scripts/sync-prod-mirror.sh`.
