// test/no-direct-nuvizz-fetch.test.mjs
//
// Guards the integrity of the shared NuVizz call counter. EVERY NuVizz request
// must go through getNuvizzRequester() (lib/nuvizz-request.mts), which counts it
// against the daily total + per-route breakdown and the circuit breaker. A raw
// fetch() to a NuVizz URL is invisible to the counter — exactly the bug that let
// nuvizz-driver-route fire thousands of UNCOUNTED /load/info calls per session,
// so the displayed "calls today" under-reported real volume.
//
// Rule: no file under netlify/functions (except the metered wrapper itself) may
// both construct a NuVizz URL (`${NUVIZZ_BASE}` or portal.nuvizz.com) and call
// fetch(). The route-label strings ('/load/info' etc.) are intentionally NOT
// matched, so comments and { route } metadata don't trip the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = join(__dirname, '..', 'netlify', 'functions');
// The one file allowed to call fetch() for NuVizz: the metered wrapper's fetchImpl.
const WRAPPER = join(FUNCTIONS_DIR, 'lib', 'nuvizz-request.mts');

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.name.endsWith('.mts') || ent.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const NUVIZZ_URL = /\$\{NUVIZZ_BASE\}|portal\.nuvizz\.com/;
const RAW_FETCH = /\bfetch\s*\(/;

test('no function calls NuVizz outside the metered requester', () => {
  const offenders = [];
  for (const file of walk(FUNCTIONS_DIR)) {
    if (file === WRAPPER) continue;
    const src = readFileSync(file, 'utf8');
    if (NUVIZZ_URL.test(src) && RAW_FETCH.test(src)) offenders.push(relative(FUNCTIONS_DIR, file));
  }
  assert.deepEqual(
    offenders,
    [],
    `These files build a NuVizz URL and call fetch() directly, bypassing the shared ` +
      `call counter. Route them through getNuvizzRequester().request() so every call is ` +
      `counted: ${offenders.join(', ')}`,
  );
});
