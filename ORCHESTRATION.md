# ORCHESTRATION — Beta 2 charter

## What Beta 2 is

A **mobile-first dispatch cockpit** for Davis Delivery — built for the dispatcher
and the driver working from a phone in the truck. It is a clean, routed,
multi-file app, deliberately the opposite of the legacy single-file
`dispatch-map` `App.jsx`.

## End state (the north star)

A superior mobile-first cockpit that will eventually **write loads back to
NuVizz** — building/assigning/sequencing loads from a better UI than the NuVizz
portal. That write capability is a **later, separately-authorized phase**.

**Until then, NuVizz is READ-ONLY.** This repo ports read paths only. No
`dispatch.cjs`, no assign/dispatch/tender/write endpoints.

## Phasing

- **v0.1.0 (this brief): Foundation + RAW Stops.** 4-page routed shell, build
  badge, NuVizz read wiring, a working RAW Stops list. No parsing, no writes.
- **Brief #2: Intelligence.** Comment parsing, chips, SealNbr revenue framing on
  top of the raw Stops data.
- **Later phase: Write-back to NuVizz.** Separately authorized.

## The four pages

Rail order mirrors NuVizz's Transport group:

1. **Dashboard** (`/`) — stub for now.
2. **Route Workbench** (`/workbench`) — stub.
3. **Loads** (`/loads`) — stub.
4. **Stops** (`/stops`) — **built**: a RAW, sortable, searchable, paginated list
   of today's NuVizz stops.

## Conventions (hard rules)

- **Multi-file + routed.** `src/pages/`, `src/components/`, `src/hooks/`,
  `src/lib/`, `netlify/functions/`. No mega-files.
- **Mobile-first.** Base styles target the phone; a single `min-width: 768px`
  breakpoint promotes the bottom tab bar to a persistent left rail. Tap targets
  ≥ 44px; the wide Stops grid scrolls horizontally on small screens.
- **Persistent build badge** on every page: `APP_VERSION · 7-char commit ·
  environment (prod|preview)`. Sourced from Netlify `COMMIT_REF` / `CONTEXT` at
  build time. **Bump `APP_VERSION` on every functional change.**
- **Dates in the UI:** `Jul 2025` when no day; `Jul 14, 2025` when a day is
  needed; always 4-digit years. **Never** ISO (`2025-07-14`) or bare numeric
  (`7/14`). Helpers live in `src/lib/format.js`.
- **All tables sortable** by clicking the header, via the reusable
  `useSortableTable` hook + `SortableTh` component. Every later page reuses them.
- **NuVizz is READ-ONLY.** Read paths only.
- **No NuVizz proprietary assets** (logo/icons/copy). Davis branding text only;
  icons are generic.

## NuVizz read wiring + the Firestore decision

`netlify/functions/lib/nuvizz.cjs` is the NuVizz DeliverIT **v7 read client**
(read-only). Beta 2 is **standalone**: it does a **DIRECT LIVE** read of NuVizz
with **no Firestore cache** (`nuvizz_stop_index`) and **no dependency on the
dispatch-map cron**. The endpoint `GET /.netlify/functions/stops` returns
normalized stop records mirroring the field set dispatch-map extracts.

> ⚠️ The original `nuvizz.cjs` in `davis-nuvizz` was not reachable from the
> session that authored this (out of repo scope), so the client's exact HTTP
> shape is **reconstructed** from the documented env contract and must be
> reconciled with the real client before the first live test. The env-var
> contract, the read-only stance, and the standalone/no-Firestore decision are
> authoritative; the login/stops paths and raw field names are marked `VERIFY:`
> in the file and can be corrected via `NUVIZZ_LOGIN_PATH` / `NUVIZZ_STOPS_PATH`
> without code changes.

## Write-back guardrail (for the later phase — NOT active in v0.1.0)

When write-back is authorized, every write to NuVizz must obey:

1. **Lowest blast radius first.** Start with the smallest, most reversible
   change; never bulk-write before single-write is proven.
2. **Preview-diff before any push.** Show the exact before→after of what will be
   sent; no silent writes.
3. **Per-write confirmation.** A human confirms each write (no auto-fire).
4. **Sandbox-first.** Exercise against a NuVizz sandbox/test company before
   touching production data.
5. **Undo.** Every write has a defined, tested reversal path.
