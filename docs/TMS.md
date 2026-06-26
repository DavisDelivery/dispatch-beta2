# Davis Dispatch — TMS product brief

The north star: a **premium operations cockpit** a dispatcher runs Davis Delivery from —
Linear/Stripe/Arc-grade feel, keyboard-first, zero clutter. Not a CRUD app.

## Principles
1. **Elegance → speed → logistics.** Every screen makes the dispatcher faster; every
   click saves time; every workflow lowers cognitive load.
2. **NuVizz is the system of record, we are the cockpit.** We orchestrate NuVizz
   (create order · plan · unplan · read) — we do **not** build a second database that
   re-owns orders/loads/customers. No Prisma/Postgres TMS duplicating NuVizz.
3. **Honest modules only.** A screen ships when it has a real data feed. Everything else
   is an explicit "coming soon", never a faked shell. (The prompt's own rule: never
   build ugly enterprise software.)
4. **Local-first, minimal API.** The API is touched only on create/plan/unplan; every
   call is metered by the topbar counter. No scans.

## Data reality (drives what's real vs. "soon")
| Domain | Source | Status |
|---|---|---|
| Orders / loads / plan-unplan | NuVizz v7 (UAT now) | **Live** — wired |
| Warehouse / fleet | Chad has a feed (TBD source) | **Wire next** — point me at it |
| Live GPS / ELD (Samsara/Motive) | — | Coming soon |
| Billing (QuickBooks) | — | Coming soon |

## Information architecture
- **Operate:** Dispatch · Routing · Orders · Live Map
- **Insight:** Dashboard · Loads · Stops · Workbench
- **Coming soon:** Customers · Fleet · Warehouse · Billing · Analytics
- Global: ⌘K command palette, universal search (phase 2), theme (dark-first), call counter.

## Design system (shipped in this PR)
- **Stack stays Vite + React + Netlify Functions** (keeps all NuVizz wiring + instant
  deploy). Added **Tailwind** (preflight off → coexists with legacy pages during the
  reskin), token-driven theme (HSL vars, dark + light), **Inter**, **lucide** icons.
- Tokens: `background / card / muted / accent / primary / border / ring / destructive /
  success / warning / info` (see `src/styles/theme.css`). Components in `src/ui/`
  (Button, Badge, Card, Kbd) + the shell in `src/components/shell/`.
- App shell: collapsible **Sidebar**, sticky **Topbar** (title · ⌘K search · theme ·
  call counter · build badge), **CommandPalette** (⌘K — navigate + actions), mobile drawer.

## Phases
1. ✅ **Design system + app shell** (this PR) — tokens, ui kit, sidebar/topbar/⌘K, themed,
   legacy pages rehomed inside the new frame so nothing breaks.
2. ◻ **Dispatch Center** (started) — KPI strip + unassigned queue + load lanes + plan/unplan
   on real data (`usePlanning`). Next: drag-and-drop orders between lanes, map panel,
   status/time-window chips, bulk dispatch.
3. ◻ **Orders workspace** — premium intake/management (Builder reborn): filters, saved
   views, status timeline, bulk actions.
4. ◻ **Live Map** — Google Maps cockpit (clustering, status colors, geofences as data allows).
5. ◻ **Reskin legacy** Loads/Stops/Workbench/Dashboard onto the design system; retire old CSS.
6. ◻ **Warehouse/Fleet** — once the feed is connected.
7. ◻ **AI dispatch assistant**, universal search, notifications.

## Conventions carried over
Mobile-first, multi-file, no mega-files. Dates via `src/lib/format.js`. NuVizz READ-ONLY
except the gated write paths. Bump `APP_VERSION` + open a PR per functional change.
