# Mobile Responsive — Breakpoints & Decisions (M4.5)

Reference for how `dispatch-map` adapts across viewport sizes. The codebase is
still a single-file `src/App.jsx`; layout switches are conditional renders
keyed off `useViewportWidth() < MOBILE_BREAKPOINT`, plus a few Tailwind
`sm:` modifiers for in-flow elements like the diagnostics page.

## Breakpoints

| Range | Name | Layout |
|---|---|---|
| `< 768px` | **Mobile** | App bar 48px, FAB + slide-up drawers, no left rail, no footer, in-map version chip |
| `768px – 1023px` | **Tablet** | Same JSX path as Desktop (no degraded tablet variant — phone-sized intent doesn't kick in above 767px) |
| `≥ 1024px` | **Desktop** | Left filter rail, resizable handle, right-side stop/driver sidebars, FilterToolbar on map, footer |

`MOBILE_BREAKPOINT = 768` is defined once in `src/App.jsx`. The tablet range
intentionally inherits the desktop layout — testing showed dispatcher tablets
(iPad-class) are landscape-oriented and have enough width for the desktop
panel + map. A separate tablet path was scoped out to keep PR 1 / PR 2 / PR 3
diffs reviewable.

## Components rendered conditionally

| Component | Mobile | Desktop |
|---|---|---|
| Top header | `MobileAppBar` (48px, version chip menu) | desktop `<header>` (full nav, "Dispatch Map" title) |
| Footer | hidden (in-map chip covers it) | shown |
| Left rail (search, FilterPanel, Legend, StopMiniTable) | not rendered | rendered |
| `FilterToolbar` (over map) | not rendered (toggles live in drawer Filters tab) | rendered |
| In-map APP_VERSION chip | rendered above the FAB | not rendered (footer covers it) |
| FAB + `MobileDrawer` | rendered | not rendered |
| `MobileStopDetailDrawer` | rendered when stop selected | replaced by `StopSidebar` aside |
| `MobileDriverSnapshotDrawer` | rendered when driver selected | replaced by `DriverSnapshotSidebar` aside |
| `DiagnosticsScreen` padding | `p-3 space-y-4` | `sm:p-6 sm:space-y-6` (Tailwind sm = ≥640px) |

`StopSidebar` and `DriverSnapshotSidebar` still accept a `mobile` prop (carried
over from PR 1), but the new drawers are now the canonical mobile path; the
prop only matters for the rare case of a future caller deliberately reusing
the desktop sidebars on a small viewport.

`DriverSnapshotSidebar`'s body was extracted into `DriverSnapshotHeader` +
`DriverSnapshotBody` so both the desktop aside and the mobile drawer render
identical content from one source.

## Touch targets

All interactive controls on the mobile path meet a **44×44 px minimum** (Apple
HIG recommendation; matches Android Material spec at 48dp ≈ 48px on most
devices). Spot check by component:

| Element | Size |
|---|---|
| `MobileFAB` | 56×56 px |
| `MobileDrawer` tab buttons | min-height 44 px |
| `MobileStopDetailDrawer` close × | 44×44 px hit target |
| `MobileStopDetailDrawer` tab buttons | min-height 44 px |
| Stop list card | min-height 64 px |
| Driver list row | min-height 56 px |
| Day open/closed toggles (Hours tab) | min-height 44 px |
| `<input type="time">` rows | min-height 44 px |
| Edit-mode chips (priority, equipment, dock type) | min-height 44 px (`min-height` set per button) |
| Save / Cancel sticky bar buttons | min-height 44 px |
| Refresh button (top-right pill) | 32 px padded to 44 (icon + p-1) — acceptable since the entire pill is a tap target visually |

The drawer's drag handle visual is `w-8 h-1` (32×4) but its tap target is the
whole `py-2` wrapper, giving an effective ~28 px tall handle area.

## iOS safe-area handling

`env(safe-area-inset-top)` / `env(safe-area-inset-bottom)` are used wherever
fixed UI risks colliding with the notch or the home indicator:

| Element | Safe area used |
|---|---|
| `MobileAppBar` | `paddingTop: env(safe-area-inset-top)` |
| `MobileFAB` | `bottom: calc(16px + env(safe-area-inset-bottom))` |
| In-map version chip | `bottom: calc(80px + env(safe-area-inset-bottom))` (sits above FAB) |
| `BottomSheet` container | `paddingBottom: env(safe-area-inset-bottom)` so drawer body clears the home indicator |
| Sticky Save/Cancel bar | `paddingBottom: calc(0.5rem + env(safe-area-inset-bottom))` |

## Persistence

New localStorage keys added in M4.5:

| Key | Purpose | Default |
|---|---|---|
| `dispatchMap.mobileDrawerTab` | last-active main drawer tab (`stops` / `filters` / `drivers`) | `stops` |

Existing keys honored on mobile (no schema changes):

| Key | Used by |
|---|---|
| `dispatchMap.leftPanelWidth` | desktop only (panel hidden on mobile) |
| `dispatchMap.driverLabelsVisible` | both — but mobile defaults to `false` when unset (vs `true` on desktop) |
| `dispatchMap.searchHistory` | both |
| `dispatchMap.legendExpanded` | desktop only |
| `dispatchMap.tableColumns` | desktop only |
| `dispatchMap.mapFilters` | both (map-display toggles in mobile Filters tab) |
| `dispatchMap.filterToolbarCollapsed` | desktop only (FilterToolbar hidden on mobile) |

Drawer **height** intentionally does not persist; each open returns to the
default size (60vh main drawer, 80vh stop/driver detail drawers).

## Touch / drag implementation

`BottomSheet` does its own pointer handling with native `mousedown` /
`touchstart` event listeners and `requestAnimationFrame`-free updates. No
gesture library (`react-spring`, `framer-motion`, `react-use-gesture`) was
added in M4.5 — the brief's Rules of Engagement asked to defer libraries
unless strictly necessary, and the drag logic is small enough that a library
isn't worth the bundle cost. Drag handlers use `touchAction: 'none'` on the
drag handle so the browser doesn't claim the gesture for native scrolling.

Snap stops are chosen at release time by minimum distance to the configured
heights, with a downward-fling escape: dragging below `mini - 0.08` with
`delta > 60 px` closes the sheet instead of snapping.

## Tap-to-pick on the driver-snapshot drawer

Tapping a stop row inside a driver-snapshot drawer resolves the snapshot row
(which has its own shape with `primaryPro`, `pro`, optional `pros`) back to a
live stop in today's stops list by **PRO match**. If a match is found, the
driver drawer closes, the map pans/zooms to the stop, and the stop detail
drawer opens. If no match (rare — usually a snapshot stop that's not in
today's planned stops anymore), the map pans to the snapshot's lat/lng only.

Match logic lives inline in `MapScreen`'s mobile JSX:

```js
const targetPros = new Set();
if (snapshotStop.primaryPro) targetPros.add(snapshotStop.primaryPro);
if (snapshotStop.pro) targetPros.add(snapshotStop.pro);
if (Array.isArray(snapshotStop.pros)) for (const p of snapshotStop.pros) targetPros.add(p);
const liveMatch = stops.find((s) =>
  (s.pro && targetPros.has(s.pro)) ||
  (Array.isArray(s.pros) && s.pros.some((p) => targetPros.has(p)))
);
```

## Cluster behavior on mobile

Per brief P3.4, clustering is **required** on mobile — too many markers (645+)
would tank tap performance. The Filters tab on mobile renders the "Show
clustered markers" row as a label-only line with an inline "required on
mobile" note, with no toggle. The underlying `mapFilters.showClustered` is
left at its persisted value (so flipping it off on desktop, then resizing
to mobile, doesn't lose the desktop preference — clustering simply stays
applied while in mobile view).

## What was deliberately scoped out

- **Satellite toggle icon-only mode** — the brief referenced an "existing top-left M4.4 satellite toggle"; the M4.4 PR didn't actually ship one (only a HANDOFF mention). Out of scope to add it from scratch under the M4.5 banner.
- **Hover tooltips** — none exist on mobile (no hover gesture).
- **Long-press** — Google Maps' default touch handling is used; we don't bind to long-press.
- **Two-finger rotate** — Google Maps default. We pass standard map options; no rotation control added.
- **Drag-to-reorder restriction chips** — the brief explicitly excluded reordering on mobile.
- **Connection-recovery "Reconnecting…" toast** — Firestore SDK retries internally; we surface `saveError` in the sticky bar already. Adding an explicit toast was deferred to keep PR 3 focused.
- **Diagnostics M3 features** (verification PRO list, detection breakdown cards) — these are M3 deliverables, not M4.5. The current diagnostics screen is still mostly TODO placeholders. M4.5 only adjusted padding so the placeholders render reasonably on mobile.

## Known limitations not yet tested on real devices

Verification done in Chrome DevTools mobile emulation (iPhone 14 Pro and
Pixel 7 profiles). The following are plausible real-device issues that
deserve a physical test pass before declaring M4.5 done in production:

1. **iOS keyboard behavior** — when the user focuses a text input in the Notes tab edit mode, iOS may scroll the page to keep the input visible, which can interact awkwardly with the absolute-positioned `BottomSheet`. Tested in DevTools by manually adjusting the viewport; needs real-device verification.
2. **Pinch-to-zoom while drawer is open** — Google Maps' pinch gesture should work on the visible map area above the drawer, but the backdrop dim div catches pointer events when the drawer is open. Verify the gesture is reachable when the drawer is at 30vh (mini).
3. **Drawer scroll-momentum vs map gestures** — `overscroll-contain` is applied to the drawer body to prevent rubber-banding back to the document scroll. Verify there's no scroll-chaining into the map.
4. **Drag-to-close fling threshold** — `delta > 60 px` works in DevTools; may feel too sensitive on a phone with high pointer DPI. If users report accidental closes, raise to 100 px.
5. **Safe-area-inset on landscape** — handled for top + bottom only. The Cmd+Shift+M landscape orientation in iOS sometimes also inserts left/right notch padding (`env(safe-area-inset-left)` / `right`). Not currently applied — verify whether the FAB / app bar collide with the notch in landscape.

These are tracked as Chad's pre-prod verification list, not M4.5 blockers.
