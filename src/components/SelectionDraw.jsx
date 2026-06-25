// Box / lasso drawing overlay for map selection. Mounted only while a draw tool
// is armed; captures pointer events over the map canvas, converts screen pixels
// to LatLng via the parent-supplied `project`, then runs the pure enclosure
// tests from routingSelect.js. Provider-agnostic: `project(x,y) -> {lat,lng}`.

import { useEffect, useRef, useState } from 'react'
import { pointInPolygon, latLngInBounds, boxFromCorners, stopKey } from '../lib/routingSelect.js'

export default function SelectionDraw({ mode, project, candidates, onCommit, onCancel }) {
  const [box, setBox] = useState(null) // {x0,y0,x1,y1} px
  const [path, setPath] = useState([]) // [{x,y}] px
  const drawing = useRef(false)
  const ptsRef = useRef([])
  const startRef = useRef(null)

  const rel = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const down = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drawing.current = true
    const p = rel(e)
    if (mode === 'box') {
      startRef.current = p
      setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    } else {
      ptsRef.current = [p]
      setPath([p])
    }
  }

  const move = (e) => {
    if (!drawing.current) return
    const p = rel(e)
    if (mode === 'box') {
      const s = startRef.current
      setBox({ x0: s.x, y0: s.y, x1: p.x, y1: p.y })
    } else {
      const last = ptsRef.current[ptsRef.current.length - 1]
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 4) {
        ptsRef.current.push(p)
        setPath(ptsRef.current.slice())
      }
    }
  }

  const up = (e) => {
    if (!drawing.current) return
    drawing.current = false
    if (mode === 'box') {
      const s = startRef.current
      const p = rel(e)
      setBox(null)
      if (Math.abs(p.x - s.x) < 4 && Math.abs(p.y - s.y) < 4) return onCancel()
      const a = project(s.x, s.y)
      const b = project(p.x, p.y)
      if (!a || !b) return onCancel()
      const bx = boxFromCorners(a, b)
      onCommit(
        candidates.filter((v) => latLngInBounds(v.stop.latitude, v.stop.longitude, bx)).map((v) => stopKey(v.stop)),
      )
    } else {
      const pts = ptsRef.current.slice()
      setPath([])
      if (pts.length < 3) return onCancel()
      const poly = pts.map((q) => project(q.x, q.y)).filter(Boolean).map((ll) => [ll.lat, ll.lng])
      if (poly.length < 3) return onCancel()
      onCommit(
        candidates.filter((v) => pointInPolygon(v.stop.latitude, v.stop.longitude, poly)).map((v) => stopKey(v.stop)),
      )
    }
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="map__draw" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
      {mode === 'box' && box && (
        <div
          className="map__box"
          style={{
            left: Math.min(box.x0, box.x1),
            top: Math.min(box.y0, box.y1),
            width: Math.abs(box.x1 - box.x0),
            height: Math.abs(box.y1 - box.y0),
          }}
        />
      )}
      {mode === 'lasso' && path.length > 1 && (
        <svg className="map__lasso">
          <polyline points={path.map((p) => `${p.x},${p.y}`).join(' ')} />
        </svg>
      )}
    </div>
  )
}
