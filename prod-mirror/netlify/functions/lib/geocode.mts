// lib/geocode.mts
//
// Address → {lat,lng} via Google Geocoding, cached permanently in Firestore
// (nuvizz_geocode/<hash>) so each unique address is geocoded ONCE. This is what
// lets the list-discovery scan place map pins without the NuVizz-provided
// coordinates we used to get from /load/info & /stop/info.
//
// Cost control: the caller seeds with coordinates already known (carried forward
// from the existing stop index — your repeat customers), so only brand-new
// addresses ever hit Google, and even those are cached forever (incl. a negative
// cache for un-geocodable addresses, so we never retry them every scan).
//
// Key: reuses the Google Maps key the app already has. Geocoding is a server-side
// web-service call, so the key must have the Geocoding API enabled (env override
// GOOGLE_GEOCODE_API_KEY if a dedicated server key is preferred).

import crypto from 'node:crypto';
import { getDoc, setDoc } from './firestore.mts';

const GEOCODE_KEY =
  process.env.GOOGLE_GEOCODE_API_KEY ||
  process.env.VITE_GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_ROUTES_API_KEY ||
  '';
const CACHE = 'nuvizz_geocode';

export interface GeoPoint { lat: number; lng: number }
export interface AddrParts { addr1?: string | null; city?: string | null; state?: string | null; zip?: string | null }

// Stable cache key for an address (case/space-insensitive). Null when there's no
// usable street address (we never geocode a bare city/zip — too imprecise for pins).
export function addrKey(p: AddrParts): string | null {
  if (!p || !String(p.addr1 || '').trim()) return null;
  const norm = [p.addr1, p.city, p.state, p.zip].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean).join(', ');
  return norm ? crypto.createHash('sha1').update(norm).digest('hex').slice(0, 24) : null;
}

function addrString(p: AddrParts): string {
  return [p.addr1, p.city, p.state, p.zip].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
}

export function isGeocodeConfigured(): boolean { return !!GEOCODE_KEY; }

async function geocodeOne(addr: string): Promise<GeoPoint | null> {
  if (!GEOCODE_KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${GEOCODE_KEY}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j: any = await r.json();
  const loc = j?.results?.[0]?.geometry?.location;
  if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') return { lat: loc.lat, lng: loc.lng };
  return null; // ZERO_RESULTS / OVER_QUERY_LIMIT / etc. — caller negative-caches it
}

/**
 * Resolve coords for a batch of addresses → Map<addrKey, GeoPoint>.
 * Order of resolution per unique address: seed (carried-forward known coords) →
 * Firestore cache (incl. negative cache) → Google geocode (then cached). Best-effort:
 * any failure just leaves that address without coords (pin omitted), never throws.
 */
export async function resolveCoords(items: AddrParts[], seed?: Map<string, GeoPoint>): Promise<Map<string, GeoPoint>> {
  const out = new Map<string, GeoPoint>();
  const misses: Array<{ key: string; str: string }> = [];
  const seen = new Set<string>();
  for (const it of items) {
    const k = addrKey(it);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (seed && seed.has(k)) { out.set(k, seed.get(k)!); continue; }
    let cached: any = null;
    try { cached = await getDoc(`${CACHE}/${k}`); } catch { /* treat as miss */ }
    if (cached) {
      if (typeof cached.lat === 'number' && typeof cached.lng === 'number') out.set(k, { lat: cached.lat, lng: cached.lng });
      continue; // present (positive or negative) → don't re-geocode
    }
    misses.push({ key: k, str: addrString(it) });
  }
  // Geocode the misses with bounded concurrency, writing each result (or a negative
  // marker) back to the cache so it's a one-time cost.
  const conc = 5;
  let idx = 0;
  const worker = async () => {
    while (idx < misses.length) {
      const { key, str } = misses[idx++];
      const pt = await geocodeOne(str).catch(() => null);
      try {
        await setDoc(`${CACHE}/${key}`, pt
          ? { lat: pt.lat, lng: pt.lng, addr: str, ts: new Date().toISOString() }
          : { failed: true, addr: str, ts: new Date().toISOString() });
      } catch { /* cache write best-effort */ }
      if (pt) out.set(key, pt);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return out;
}
