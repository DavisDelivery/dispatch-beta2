// Client-side data access for the Stops page.
//
// MOCK MODE: when VITE_USE_MOCK_NUVIZZ=true the page renders a bundled fixture
// with NO NuVizz credentials required (used for the first deploy preview before
// secrets are set). Otherwise it hits the Netlify Function, which does the live
// (server-side) NuVizz v7 read.

export const IS_MOCK = import.meta.env.VITE_USE_MOCK_NUVIZZ === 'true'

const MOCK_URL = '/test-fixtures/nuvizz-today-stops.json'
const LIVE_URL = '/.netlify/functions/stops'

/**
 * @param {{ horizon?: string }} opts  horizon defaults to "today".
 * @returns {Promise<{ stops: object[], meta: object, mock: boolean }>}
 */
export async function loadStops({ horizon = 'today' } = {}) {
  const url = IS_MOCK
    ? MOCK_URL
    : `${LIVE_URL}?horizon=${encodeURIComponent(horizon)}`

  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = body?.error ? ` — ${body.error}` : ''
    } catch {
      /* non-JSON error body; ignore */
    }
    throw new Error(`Stops request failed (${res.status})${detail}`)
  }

  const data = await res.json()
  // Accept either a bare array or { stops, meta } so the fixture and the live
  // function can share the same client.
  const stops = Array.isArray(data) ? data : data.stops ?? []
  const meta = Array.isArray(data) ? {} : data.meta ?? {}
  return { stops, meta, mock: IS_MOCK }
}
