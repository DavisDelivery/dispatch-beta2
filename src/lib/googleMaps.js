// Google Maps JS API loader — injects the script once and resolves with the
// google.maps namespace. Read-only; client-side. The API key is a build-time
// VITE_ var (VITE_GOOGLE_MAPS_API_KEY) — Google Maps JS keys are public by
// design and must be protected with HTTP-referrer restrictions in the Google
// Cloud console (restrict to the dispatch-beta2 domains).

let loaderPromise = null

export function loadGoogleMaps(apiKey) {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps requires a browser'))
  }
  if (window.google && window.google.maps) {
    return Promise.resolve(window.google.maps)
  }
  if (!apiKey) {
    return Promise.reject(new Error('Missing VITE_GOOGLE_MAPS_API_KEY'))
  }
  if (loaderPromise) return loaderPromise

  loaderPromise = new Promise((resolve, reject) => {
    const cbName = '__davisGmapsReady'
    window[cbName] = () => {
      resolve(window.google.maps)
      delete window[cbName]
    }
    const s = document.createElement('script')
    s.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&v=weekly&loading=async&callback=${cbName}`
    s.async = true
    s.defer = true
    s.onerror = () => {
      loaderPromise = null
      reject(new Error('Failed to load Google Maps'))
    }
    document.head.appendChild(s)
  })
  return loaderPromise
}
