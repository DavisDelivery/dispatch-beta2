# Dispatch Map — Davis Delivery Service

Morning triage tool for the dispatcher. Pulls today's NuVizz stops, joins them
against a Firestore-backed customer metadata layer (receiving hours, equipment
restrictions, dock notes, priority flags), and renders the result on a Google
Map with color-coded markers and a sidebar editor.

Replacement for stuffing instructions into NuVizz address-line-2.

## Stack

- React (single-file `App.jsx`) + Vite + Tailwind
- Firebase (Auth + Firestore — reuses the `davismarginiq` project)
- Google Maps JS API + `@googlemaps/markerclusterer` for 750-marker performance
- Netlify Functions (`.mts`) — proxy NuVizz / Motive calls so the API keys stay server-side

## Quickstart

```bash
cp .env.example .env
# Fill in VITE_FIREBASE_* and VITE_GOOGLE_MAPS_API_KEY at minimum.
# If NUVIZZ_DAVIS_USER/_PASS are missing the function falls back to the mock fixture,
# so you can see the map render before live creds are wired.

npm install
npm run dev        # http://localhost:5173

# To run with Netlify Functions locally:
npx netlify dev    # http://localhost:8888 — proxies the .mts functions
```

Force the mock fixture even when NuVizz creds are set:

```
VITE_USE_MOCK_NUVIZZ=true npm run dev
```

## What's in the box

| Milestone | Status | Notes |
|---|---|---|
| M1 — Read-only map | ✅ | login gate, marker cluster, refresh, sidebar |
| M2 — Metadata + edit | ✅ | Firestore CRUD, colored markers, filter rail, pro_history |
| M3 — Diagnostics | 🟡 stub | page shell + TODO comments per section |
| M4 — Motive overlay | ✅ | toggle button, 60s refresh, truck-icon markers |
| M5 — Route polylines | ⛔ next session |

See `HANDOFF.md` for the full picture (env vars, NuVizz contract notes, known issues).

## Deployment

**Do not deploy from a dev session.** Push to the `dispatch-map` repo and let
Netlify CI build, or trigger via `deploy.html`. The Netlify project is
`dd-dispatch-map.netlify.app`; custom domain `map.davisdelivery.com` is queued.

Required Netlify env vars (set in site → Build & deploy → Environment):

- `VITE_FIREBASE_*` (six values — copy from davismarginiq)
- `VITE_GOOGLE_MAPS_API_KEY`
- `NUVIZZ_DAVIS_USER` / `NUVIZZ_DAVIS_PASS` / `NUVIZZ_DAVIS_COMPANY_CODE`
- `NUVIZZ_BASE_URL` (default `https://portal.nuvizz.com/deliverit/openapi/v7`)
- `MOTIVE_API_KEY` (`__REDACTED__`)
