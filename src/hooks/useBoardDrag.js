// Pointer-based drag for the dispatch board — works with mouse, touch, and pen
// (HTML5 drag-and-drop is mouse-only). Drag is initiated from a card's grip
// handle (which sets `touch-action: none` so the touch won't scroll the list);
// tapping the card body still selects.
//
// Drop targets are any element with a `data-dropzone="<id>"` attribute; we find
// the one under the pointer via elementFromPoint. onDrop(zoneId, order) fires on
// release over a zone.

import { useCallback, useRef, useState } from 'react'

export function useBoardDrag(onDrop) {
  const [drag, setDrag] = useState(null) // { order, x, y } while dragging
  const [zone, setZone] = useState(null) // dropzone id under the pointer
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  const zoneAt = (x, y) => {
    const el = document.elementFromPoint(x, y)
    const dz = el && el.closest ? el.closest('[data-dropzone]') : null
    return dz ? dz.getAttribute('data-dropzone') : null
  }

  const start = useCallback(
    (order) => (e) => {
      // Primary button / touch only; don't start a drag from the card body.
      if (e.button != null && e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      setDrag({ order, x: e.clientX, y: e.clientY })

      const move = (ev) => {
        setDrag({ order, x: ev.clientX, y: ev.clientY })
        setZone(zoneAt(ev.clientX, ev.clientY))
      }
      const up = (ev) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        const zoneId = zoneAt(ev.clientX, ev.clientY)
        setDrag(null)
        setZone(null)
        if (zoneId) onDropRef.current(zoneId, order)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [],
  )

  return { drag, zone, start }
}
