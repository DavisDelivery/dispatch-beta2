// netlify/functions/google-route-matrix.mts
//
// Server proxy for Google Routes API computeRouteMatrix (Section 10). Holds the
// DEDICATED server key GOOGLE_ROUTES_API_KEY (functions scope) — never the
// referrer-restricted client VITE_GOOGLE_MAPS_API_KEY, and never shipped to the
// client. The client calls THIS function; the key stays here.
//
// computeRouteMatrix caps elements (origins × destinations) per request, so large
// selections are CHUNKED and stitched into one full (depot + stops) matrix. If the
// key is absent or a request fails, we fall back to a haversine estimate so the
// engine still produces routes deterministically (degraded, clearly flagged).

import { fetchWithTimeout } from './lib/async-util.mts';

const ROUTES_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const MAX_ELEMENTS = 600;         // under Google's 625 element cap, with margin
const MAX_STOPS = 150;            // sane selection bound (surfaced as an error)
const AVG_SPEED_MPS = 13.4;       // ~30 mph fallback effective speed
const GOOGLE_TIMEOUT_MS = 8000;   // hard cap per chunk — a stalled call aborts → haversine fallback

export interface LatLng { lat: number; lng: number }
export interface Matrix { durationSec: number[][]; distanceMeters: number[][] }

export function isGoogleRoutesEnabled(): boolean {
  return !!process.env.GOOGLE_ROUTES_API_KEY;
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Deterministic fallback matrix (no network). Distance = 1.3× crow-flies (road
// factor); duration = distance / avg speed. Used when Google is unavailable.
export function haversineMatrix(depot: LatLng, stops: LatLng[]): Matrix {
  const nodes = [depot, ...stops];
  const n = nodes.length;
  const durationSec = Array.from({ length: n }, () => new Array(n).fill(0));
  const distanceMeters = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const d = haversineMeters(nodes[i], nodes[j]) * 1.3;
    distanceMeters[i][j] = Math.round(d);
    durationSec[i][j] = Math.round(d / AVG_SPEED_MPS);
  }
  return { durationSec, distanceMeters };
}

function parseDuration(s: any): number {
  if (typeof s === 'number') return s;
  const m = String(s ?? '').match(/^(\d+(?:\.\d+)?)s$/);
  return m ? Math.round(Number(m[1])) : 0;
}

async function computeChunk(origins: LatLng[], destinations: LatLng[], apiKey: string): Promise<{ originIndex: number; destinationIndex: number; durationSec: number; distanceMeters: number }[]> {
  const wp = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const resp = await fetchWithTimeout(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition',
    },
    body: JSON.stringify({ origins: origins.map(wp), destinations: destinations.map(wp), travelMode: 'DRIVE' }),
  }, GOOGLE_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`computeRouteMatrix ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data: any = await resp.json();
  const rows = Array.isArray(data) ? data : (data.elements || data.matrix || []);
  return rows.map((e: any) => ({
    originIndex: e.originIndex ?? 0,
    destinationIndex: e.destinationIndex ?? 0,
    durationSec: parseDuration(e.duration),
    distanceMeters: typeof e.distanceMeters === 'number' ? e.distanceMeters : 0,
  }));
}

// Full (depot + stops) matrix via Google, chunked to respect the element cap.
export async function buildMatrixViaGoogle(depot: LatLng, stops: LatLng[], apiKey: string): Promise<Matrix> {
  const nodes = [depot, ...stops];
  const n = nodes.length;
  const durationSec = Array.from({ length: n }, () => new Array(n).fill(0));
  const distanceMeters = Array.from({ length: n }, () => new Array(n).fill(0));

  const originChunk = Math.max(1, Math.floor(MAX_ELEMENTS / n));
  for (let o = 0; o < n; o += originChunk) {
    const originsSlice = nodes.slice(o, o + originChunk);
    const elements = await computeChunk(originsSlice, nodes, apiKey);
    for (const e of elements) {
      const i = o + e.originIndex, j = e.destinationIndex;
      if (i < n && j < n) { durationSec[i][j] = e.durationSec; distanceMeters[i][j] = e.distanceMeters; }
    }
  }
  return { durationSec, distanceMeters };
}

// Resolve the best available matrix for the requested mode (Appendix B: cheap by
// default). Google is used ONLY when mode === 'google' AND the key is present;
// otherwise (default) the free haversine estimate — even when the key exists.
export async function resolveMatrix(depot: LatLng, stops: LatLng[], mode: 'haversine' | 'google' = 'haversine'): Promise<{ matrix: Matrix; source: 'google' | 'haversine' }> {
  if (stops.length > MAX_STOPS) throw new Error(`selection too large: ${stops.length} stops (max ${MAX_STOPS})`);
  if (mode === 'google') {
    const key = process.env.GOOGLE_ROUTES_API_KEY;
    if (key) {
      try { return { matrix: await buildMatrixViaGoogle(depot, stops, key), source: 'google' }; }
      catch (e: any) { console.error('google-route-matrix: falling back to haversine —', e?.message); }
    } else {
      console.error('google-route-matrix: mode=google requested but GOOGLE_ROUTES_API_KEY not set — using haversine');
    }
  }
  return { matrix: haversineMatrix(depot, stops), source: 'haversine' };
}

// HTTP handler: POST { depot, stops, mode? } → { matrix, source }. Defaults to the
// free haversine estimate; pass mode:'google' to bill live Google drive-times.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 }); }
  const depot = body?.depot;
  const stops = Array.isArray(body?.stops) ? body.stops : null;
  const mode = body?.mode === 'google' || body?.matrixMode === 'google' ? 'google' : 'haversine';
  if (!depot || !stops) return new Response(JSON.stringify({ error: 'depot and stops required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  try {
    const { matrix, source } = await resolveMatrix(depot, stops, mode);
    return new Response(JSON.stringify({ matrix, source, available: isGoogleRoutesEnabled() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
}
