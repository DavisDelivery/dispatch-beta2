# dispatch-beta2

**Davis Delivery — Beta 2.** A mobile-first dispatch cockpit for the driver in
the truck. This is the **v0.1.0 foundation**: a routed, multi-file React app
(the deliberate opposite of the old single-file dispatch-map), a persistent
build badge, the NuVizz **read-only** wiring, and a working **RAW Stops** list
that proves the NuVizz read works end-to-end.

> v0.1.0 has **no parsing/intelligence** and performs **no writes** to NuVizz.
> Comment parsing, chips, and SealNbr revenue framing are brief #2.
> Writing loads back to NuVizz is a later, separately-authorized phase.

## Stack

- **Vite + React + react-router** — `src/pages/`, `src/components/`, `src/hooks/`,
  `src/lib/`, `netlify/functions/`.
- **Mobile-first**: bottom tab bar on phones, persistent left rail at
  `min-width: 768px`.
- **Netlify**: static build + Functions; CD builds on push to `main`, deploy
  previews on PRs.

## Pages

| Route        | Page            | v0.1.0 state       |
| ------------ | --------------- | ------------------ |
| `/`          | Dashboard       | stub ("coming next") |
| `/workbench` | Route Workbench | stub               |
| `/loads`     | Loads           | stub               |
| `/stops`     | Stops           | **built** (RAW list) |

## Local development

```bash
npm install
npm run dev      # http://localhost:5173 — runs in MOCK mode (bundled fixture)
npm run build    # production build to dist/
npm run preview  # preview the production build
```

`npm run dev` defaults to mock mode (`.env.development`), so the Stops page
renders the bundled fixture without any NuVizz credentials or running Functions.

## Environment variables

Set these in the **dispatch-beta2 Netlify site** (Site settings → Environment).

**Server-side** (Netlify Functions runtime) — **never** prefix with `VITE_`,
they must not reach the client bundle:

| Variable                    | Value                                                   |
| --------------------------- | ------------------------------------------------------- |
| `NUVIZZ_DAVIS_COMPANY_CODE` | `DAVIS`                                                  |
| `NUVIZZ_DAVIS_USER`         | _NuVizz user_                                           |
| `NUVIZZ_DAVIS_PASS`         | _NuVizz pass_                                           |
| `NUVIZZ_BASE_URL`           | `https://portal.nuvizz.com/deliverit/openapi/v7`        |

**Client-side** (baked into the bundle at build time — safe to expose):

| Variable                | Value                                              |
| ----------------------- | -------------------------------------------------- |
| `VITE_USE_MOCK_NUVIZZ`  | `false` (set `true` to demo the UI without creds)  |

Netlify also injects `COMMIT_REF` and `CONTEXT` at build time; these feed the
build badge (version · 7-char commit · prod/preview). No setup needed.

> _Optional reconciliation knobs:_ `NUVIZZ_LOGIN_PATH` / `NUVIZZ_STOPS_PATH`
> let you correct the live endpoint paths without code changes — see
> `netlify/functions/lib/nuvizz.cjs`.

## The Stops read endpoint

`GET /.netlify/functions/stops?horizon=today` → normalized, read-only stop
records. The function does a **direct live** read of NuVizz v7 (no Firestore
cache, no cron dependency — Beta 2 is standalone). See `ORCHESTRATION.md` and
the header note in `netlify/functions/lib/nuvizz.cjs`.
