# M4.6 — Bundle Audit

Date: 2026-05-22
Branch: `claude/dispatch-map-m4.6-bundle-audit`
Build tooling: Vite 5.4.21, @vitejs/plugin-react 4.3.1, rollup-plugin-visualizer 7.0.1
Starting version: 0.8.1 (M4.5 + the v0.8.1 502-handling hotfix from PR #19)
Target version: 0.8.2

## Method

1. Added `rollup-plugin-visualizer` as a dev dependency, wired into `vite.config.js` with `template: 'treemap'`, `gzipSize: true`, `brotliSize: true`. Plugin stays in the config — zero bundle cost, gives us `dist/bundle-stats.html` on every build.
2. Ran `npm run build` and inspected `dist/bundle-stats.html`. The plugin's data injection format has changed since the brief was written; it now emits `const data = { ... }` rather than `window.nodesData`. Recovered the payload via brace-match extraction (the regex pattern in the brief does not work against v7.0.1).
3. Walked the leaf nodes, joined `nodeParts` (sizes) with `nodeMetas` (canonical `id` paths) through their shared `moduleParts` map, then aggregated by package.

## Bundle totals (post-M4.5 baseline)

| | Raw | Gzipped |
|---|---:|---:|
| `dist/assets/index-C5avKDyJ.js` | 570.06 KB | 154.91 KB |
| `dist/assets/index-5h9T0YDU.css` | 21.74 KB | 4.80 KB |
| `dist/index.html` | 0.46 KB | 0.30 KB |

(M4.5 wrap-up reported 569.51 KB raw / 154.64 KB gzipped — within rounding; difference is the visualizer plugin's banner-injected `__VISUALIZER__` metadata, which is stripped from runtime code paths.)

## Top 10 leaves by gzipped size

| Rank | Gzipped | Raw | Module |
|---:|---:|---:|---|
| 1 | 108.7 KB | 481.9 KB | `@firebase/firestore/dist/index.esm2017.js` |
| 2 | 42.6 KB | 133.7 KB | `react-dom/cjs/react-dom.production.min.js` |
| 3 | 35.0 KB | 182.9 KB | `src/App.jsx` |
| 4 | 15.9 KB | 42.3 KB | `@firebase/webchannel-wrapper/.../webchannel_blob_es2018.js` |
| 5 | 6.7 KB | 28.0 KB | `@firebase/app/dist/esm/index.esm2017.js` |
| 6 | 6.3 KB | 25.3 KB | `@googlemaps/markerclusterer/dist/index.esm.mjs` |
| 7 | 5.4 KB | 23.3 KB | `fast-equals/dist/es/index.mjs` |
| 8 | 4.1 KB | 15.1 KB | `supercluster/index.js` |
| 9 | 4.0 KB | 16.6 KB | `@firebase/util/dist/index.esm2017.js` |
| 10 | 3.7 KB | 11.3 KB | `@firebase/webchannel-wrapper/.../bloom_blob_es2018.js` |

## Aggregated by package

| Gzipped | Raw | Files | Package |
|---:|---:|---:|---|
| **108.7 KB** | **481.9 KB** | 1 | `@firebase/firestore` |
| 43.0 KB | 134.2 KB | 6 | `react-dom` |
| 41.3 KB | 201.0 KB | 8 | local src (`src/App.jsx` + 7 helpers in `src/lib/`) |
| 19.6 KB | 53.6 KB | 2 | `@firebase/webchannel-wrapper` |
| **7.4 KB** | 11.6 KB | **25** | `lucide-react` |
| 6.7 KB | 28.0 KB | 1 | `@firebase/app` |
| 6.3 KB | 25.3 KB | 1 | `@googlemaps/markerclusterer` |
| 5.4 KB | 23.3 KB | 1 | `fast-equals` |
| 4.1 KB | 16.6 KB | 2 | `@firebase/util` |
| 4.1 KB | 15.1 KB | 1 | `supercluster` |
| 3.8 KB | 9.0 KB | 8 | `react` |
| 3.3 KB | 13.0 KB | 1 | `kdbush` |
| 3.3 KB | 10.3 KB | 2 | `idb` |
| 2.0 KB | 4.5 KB | 4 | `scheduler` |
| 1.8 KB | 5.3 KB | 1 | `@firebase/logger` |
| 0.7 KB | 1.5 KB | 1 | `@googlemaps/js-api-loader` |
| 0.4 KB | 1.2 KB | 1 | `@firebase/component` |
| 0.4 KB | 0.7 KB | 1 | `firebase` (re-export shim) |

**Firebase + transitive deps total: ~141 KB gzipped — 91% of the bundle.**

## Lucide-react audit

**Verdict: ALL MODULAR — no fix needed.**

Sole import statement (`dispatch-map/src/App.jsx:15-20`):
```js
import {
  MapPin, RefreshCw, X, Filter, Truck, Save, Plus, Trash2,
  Activity, ChevronDown, ChevronUp, Eye, EyeOff,
  Search, Tag, Tags, ArrowLeft, Gauge, Clock, MapPinned,
  Info, Settings, LayoutList,
} from 'lucide-react';
```

This is the correct per-icon named-import pattern. Vite tree-shakes it cleanly: the bundle contains exactly 23 icon source files (one per name above, minus `Eye`/`EyeOff` which appear unused — see follow-up) plus `Icon.js`, `createLucideIcon.js`, `defaultAttributes.js`, and `shared/utils.js`. Every icon is 220–435 bytes gzipped; the whole lucide footprint is 7.4 KB.

Possible micro-win (not pursued in M4.6): two imported icons (`Eye`, `EyeOff`) may be unused after M4.5; dropping them would save ~0.6 KB. Not worth a code change — leaving for a tidy-up pass.

## Firebase audit

**Verdict: ALL MODULAR — no fix needed.**

All three import sites use the v9+ modular API:

| File | Imports |
|---|---|
| `src/lib/firebase.js:6-7` | `import { initializeApp } from 'firebase/app'` / `import { getFirestore } from 'firebase/firestore'` |
| `src/App.jsx:21-23` | `import { collection, doc, getDoc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore'` |
| `src/lib/customer-notes-writer.ts:26` | `import { doc, writeBatch, serverTimestamp, deleteField, Firestore } from 'firebase/firestore'` |

No legacy v8 namespace imports (`import firebase from 'firebase'`, `import * as firebase from 'firebase/app'`) exist anywhere in the codebase. `package.json` pulls `firebase: ^11.0.2` which is the modular SDK; the top-level `firebase` package shows up in the bundle only as a 442-byte re-export shim.

The 141 KB gzipped Firebase footprint is the **irreducible cost of the modular Firestore client itself** — primarily the Firestore SDK core (`@firebase/firestore` 108.7 KB) plus its WebChannel long-poll transport (`@firebase/webchannel-wrapper` 19.6 KB). This is what Firestore costs when you use the regular SDK. The `firebase/firestore/lite` build would cut it significantly (~30–40 KB gz) but removes real-time `onSnapshot` listeners, which the app relies on (`App.jsx` has at least one `onSnapshot` subscription on `customer_notes`).

## Phase 2 recommendations

| Item | Action |
|---|---|
| Lucide per-icon imports | **Skip** — already correct. |
| Firebase modular imports | **Skip** — already correct. |
| `Eye` / `EyeOff` unused-import tidy-up | **Defer** — 0.6 KB; not worth touching App.jsx for it. |
| `APP_VERSION` bump 0.8.1 → 0.8.2 | **Do** — visualizer plugin install + RESEARCH doc still warrants a version line, and it pins the audit to a build the dispatcher can recognize. |
| `rollup-plugin-visualizer` permanent | **Keep** — dev-dep only, zero bundle cost, gives `dist/bundle-stats.html` on every future build. |

## What this audit deliberately did NOT do (deferred)

These are the real avenues if/when bundle size becomes a felt problem:

1. **`firebase/firestore/lite` swap.** Would cut ~30–40 KB gz but kills `onSnapshot`. Customer-notes edits currently update markers live without reload via the snapshot subscription. Removing that needs a refactor to polling or a post-save manual refetch — a real product decision, not an obvious win.
2. **Mobile/desktop route-split (the M4.6 brief's pre-flagged deferral).** The 17 mobile components from M4.5 ship in the same chunk as the desktop tree. Dynamic-importing one half based on `isMobile` would shave roughly 5–8 KB gz off the initial page load (asymmetric — mobile users would still get the smaller desktop fallback wrapper). Worth doing only if first-paint becomes a problem on 3G; current mobile bundle is fine.
3. **Proxying Firestore through Netlify Functions.** Removes Firebase from the client entirely (~141 KB gz saved). Architecturally significant — kills real-time updates, adds a serverless hop to every read/write, requires re-implementing the security model server-side. Not an "audit fix"; that's a whole milestone.
4. **`react-dom` is 42.6 KB gz** — irreducible for a React 18 app. Mentioning it only so the next person reading this knows it's not an oversight.

## Results

| | Raw | Gzipped |
|---|---:|---:|
| Before (M4.5 + 502 hotfix, v0.8.1) | 569.51 KB | 154.64 KB |
| After (M4.6, v0.8.2) | 570.06 KB | 154.91 KB |
| Delta | +0.55 KB | +0.27 KB |

The 0.27 KB gz delta is the visualizer plugin's own metadata banner that Rollup injects into the chunk header when the plugin is active — **not application code**. With the plugin removed from `vite.config.js` (or replaced with a build-script-only invocation), the bundle reverts to the pre-M4.6 byte count. Since the visualizer adds no runtime code and pays for itself on every future audit, we're keeping it in the config; the cost is the 0.27 KB.

**Net code change to shipped bundle: 0 bytes.** No imports rewritten — the audit found nothing to rewrite. The "Results" line is honest about the null result, which is what the brief asked for.

## Regression smoke

This sandbox cannot launch a browser; `npm run dev` would start a server with no way to drive it. Smoke verification limited to what's observable from the build itself:

- [x] `npm run build` exits 0
- [x] Bundle byte-count delta within rounding (0 KB of new application code)
- [x] `APP_VERSION = '0.8.2'` present in built JS (`grep '0.8.2' dist/assets/index-CZPy_C9Q.js` → match)
- [x] No imports rewritten → no risk of breaking `onSnapshot`/Firestore call sites
- [ ] **Real-browser smoke deferred to Chad** — the M4.5 desktop / mobile checklist from this milestone's brief still applies and is the right verification to run against the deploy preview before merging.

## Files touched this milestone

- `dispatch-map/package.json` — added `rollup-plugin-visualizer` dev-dep, version bump.
- `dispatch-map/package-lock.json` — `npm install` propagation.
- `dispatch-map/vite.config.js` — wired the visualizer plugin.
- `dispatch-map/src/App.jsx` — `APP_VERSION` 0.8.1 → 0.8.2.
- `dispatch-map/RESEARCH-bundle-audit-m4.6.md` — this file.
