# prod-mirror — the 1:1 UAT copy of dd-dispatch-map

This directory is a **byte-for-byte copy** of `davis-nuvizz/dispatch-map` (the production
dispatch app: UI + Netlify functions). It exists so testing happens on the EXACT production
experience against the UAT tenant — the Jul 2 incident slipped through partly because UAT
testing ran on a different UI.

**Never edit files here.** Change `davis-nuvizz` and re-run `../scripts/sync-prod-mirror.sh`
(it rsyncs with `--delete`; local edits are wiped by design). The sync script prints the
source commit so the mirror is always attributable to a prod commit.

## How it points at UAT (environment only — zero code fork)

Deployed as Netlify site **dd-dispatch-map-uat**. The env does all the work:

| var | value | why |
|---|---|---|
| NUVIZZ_BASE_URL | https://uat.nuvizz.com/deliverit/openapi/v7 | all NuVizz traffic → UAT |
| NUVIZZ_DAVIS_COMPANY_CODE / USER / PASS | DAVISV5 / (UAT creds) | UAT tenant |
| FIRESTORE_DATABASE | uat-mirror | server data → the NAMED Firestore DB (same davismarginiq project, fully separate data) |
| VITE_FIRESTORE_DATABASE | uat-mirror | client writes (customer notes) → same named DB |
| NUVIZZ_WRITE_ENABLED | true | live writes allowed (it's UAT) |
| NUVIZZ_LOAD_IMPORT | on | the two-lever import engine is ON here — this mirror exists to test it |
| NUVIZZ_SCANS_ENABLED | true | scheduled scans keep the UAT board fresh |

Safety invariant (in prod code, v0.38.1): if NUVIZZ_BASE_URL is a uat host and
FIRESTORE_DATABASE is unset, Firestore refuses to run — a misconfigured mirror can never
write into the production board's data.

Deliberately NOT set on the mirror: SIMPLETEXTING_* (no real-driver SMS from tests),
DEBUG_CAPTURE_* (no issues filed on the prod repo from UAT), MOTIVE_* (no live prod trucks
on the UAT map), ANTHROPIC_API_KEY / GOOGLE_ROUTES_API_KEY (AI search + road-matrix
optimization degrade gracefully; add later if wanted).

## Day-to-day

```bash
# refresh the mirror to current prod code
./scripts/sync-prod-mirror.sh
cd prod-mirror && npm ci && npm test && npm run build

# deploy it
netlify deploy --prod --site dd-dispatch-map-uat
```

The board fills from the scheduled UAT scans (or the in-app manual scan — cheap on the tiny
UAT tenant). UAT evidence loads live under the SQT* naming convention.
