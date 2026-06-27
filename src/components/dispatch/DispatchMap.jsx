// Dispatch map panel — order markers you can click to (de)select, then assign to
// a load from the toolbar. Imperative Google Maps (StrictMode-guarded refs).
// Markers: amber = unassigned, blue = planned; selected = enlarged + white ring.

import { useEffect, useRef, useState } from 'react'
import { loadGoogleMaps } from '../../lib/googleMaps.js'

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''

function icon(api, planned, selected) {
  return {
    path: api.SymbolPath.CIRCLE,
    scale: selected ? 8.5 : 6,
    fillColor: planned ? '#2f9bed' : '#f5a524',
    fillOpacity: selected ? 1 : 0.92,
    strokeColor: selected ? '#ffffff' : '#0b1220',
    strokeWeight: selected ? 2.5 : 1,
  }
}

export default function DispatchMap({ orders, coords, selected, onToggle }) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const apiRef = useRef(null)
  const markersRef = useRef(new Map())
  const selRef = useRef(selected)
  selRef.current = selected
  const onToggleRef = useRef(onToggle)
  onToggleRef.current = onToggle
  const [status, setStatus] = useState(API_KEY ? 'loading' : 'error')

  const mapped = orders.filter((o) => coords[o.stopNbr])

  // Load + init the map once.
  useEffect(() => {
    if (!API_KEY) return
    let cancelled = false
    loadGoogleMaps(API_KEY)
      .then((api) => {
        if (cancelled || mapRef.current || !elRef.current) return
        apiRef.current = api
        mapRef.current = new api.Map(elRef.current, {
          center: { lat: 33.9, lng: -84.2 },
          zoom: 9,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
        })
        setStatus('ready')
      })
      .catch(() => !cancelled && setStatus('error'))
    return () => {
      cancelled = true
      markersRef.current.forEach((rec) => rec.marker.setMap(null))
      markersRef.current.clear()
      mapRef.current = null
    }
  }, [])

  // Rebuild markers when the mapped set changes; fit to them.
  useEffect(() => {
    const api = apiRef.current
    const map = mapRef.current
    if (!api || !map) return
    markersRef.current.forEach((rec) => rec.marker.setMap(null))
    markersRef.current.clear()
    const bounds = new api.LatLngBounds()
    for (const o of mapped) {
      const pos = coords[o.stopNbr]
      const planned = !!o.plannedLoadNbr
      const marker = new api.Marker({
        position: pos,
        map,
        title: `${o.name || o.stopNbr}${planned ? ` · on ${o.plannedLoadNbr}` : ''}`,
        icon: icon(api, planned, selRef.current.has(o.stopNbr)),
      })
      marker.addListener('click', () => onToggleRef.current(o.stopNbr))
      markersRef.current.set(o.stopNbr, { marker, planned })
      bounds.extend(pos)
    }
    if (mapped.length === 1) {
      map.setCenter(bounds.getCenter())
      map.setZoom(12)
    } else if (mapped.length > 1) {
      map.fitBounds(bounds, 56)
    }
  }, [mapped.map((o) => o.stopNbr + (o.plannedLoadNbr || '')).join(','), status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Restyle on selection change without refitting.
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    for (const [stopNbr, rec] of markersRef.current) {
      rec.marker.setIcon(icon(api, rec.planned, selected.has(stopNbr)))
    }
  }, [selected])

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-border">
      {status === 'error' && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-card p-6 text-center text-sm text-muted-foreground">
          Map unavailable — set <code className="mx-1 rounded bg-muted px-1">VITE_GOOGLE_MAPS_API_KEY</code>.
        </div>
      )}
      {status === 'ready' && mapped.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 mx-auto w-fit rounded-full bg-background/85 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
          Geocoding orders…
        </div>
      )}
      <div ref={elRef} className="h-full w-full" />
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex gap-3 rounded-lg border border-border bg-background/85 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: '#f5a524' }} /> Unassigned</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: '#2f9bed' }} /> Planned</span>
      </div>
    </div>
  )
}
