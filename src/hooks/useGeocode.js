// Client-side geocoding for order addresses via the Google Maps Geocoder.
// This is a GOOGLE call, not a NuVizz call — it never touches the write fn, so
// the API counter stays honest. Results are cached in localStorage by address,
// so each distinct address is geocoded at most once, ever.

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '../lib/googleMaps.js'

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''
const CACHE_KEY = 'dd_geocode_cache'

const addrKey = (o) => (o.addr1 && o.city && o.state ? `${o.addr1}|${o.city}|${o.state}|${o.zip || ''}`.toUpperCase() : '')
const addrStr = (o) => [o.addr1, o.city, o.state, o.zip].filter(Boolean).join(', ')

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
  } catch {
    return {}
  }
}
function writeCache(c) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c))
  } catch {
    /* ignore */
  }
}

function geocodeOne(geocoder, address) {
  return new Promise((resolve) => {
    geocoder.geocode({ address }, (results, status) => {
      if (status === 'OK' && results && results[0]) {
        const loc = results[0].geometry.location
        resolve({ lat: loc.lat(), lng: loc.lng() })
      } else {
        resolve(null)
      }
    })
  })
}

// Returns { byStop: { [stopNbr]: {lat,lng} }, ready, error }.
export function useGeocode(orders) {
  const [byStop, setByStop] = useState({})
  const [state, setState] = useState({ ready: !API_KEY ? false : false, error: API_KEY ? '' : 'No Google Maps key' })
  const cacheRef = useRef(readCache())
  const sig = orders.map((o) => o.stopNbr).join(',')

  useEffect(() => {
    if (!API_KEY) return
    let cancelled = false
    loadGoogleMaps(API_KEY)
      .then(async (api) => {
        const geocoder = new api.Geocoder()
        const out = {}
        for (const o of orders) {
          if (cancelled) return
          const key = addrKey(o)
          if (!key) continue
          let ll = cacheRef.current[key]
          if (!ll) {
            ll = await geocodeOne(geocoder, addrStr(o))
            if (ll) {
              cacheRef.current[key] = ll
              writeCache(cacheRef.current)
            }
          }
          if (ll) out[o.stopNbr] = ll
        }
        if (!cancelled) {
          setByStop(out)
          setState({ ready: true, error: '' })
        }
      })
      .catch((e) => !cancelled && setState({ ready: false, error: e.message }))
    return () => {
      cancelled = true
    }
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps

  return { byStop, ...state }
}
