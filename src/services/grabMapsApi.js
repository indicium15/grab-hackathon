const GRAB_MAPS_BASE_URL = 'https://maps.grab.com'

function getGrabApiKey() {
  return import.meta.env.VITE_GRAB_API_KEY?.trim() || import.meta.env.VITE_BRAGMAPS_KEY?.trim() || ''
}

async function grabMapsRequest(path, params) {
  const apiKey = getGrabApiKey()
  if (!apiKey) {
    throw new Error('Missing Grab API key. Set VITE_GRAB_API_KEY.')
  }

  const query = new URLSearchParams(params)
  const response = await fetch(`${GRAB_MAPS_BASE_URL}${path}?${query.toString()}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || `GrabMaps request failed with status ${response.status}`)
  }

  return response.json()
}

export async function searchPlaces(keyword, options = {}) {
  return grabMapsRequest('/api/v1/maps/poi/v1/search', {
    keyword,
    country: options.country ?? 'SGP',
    limit: String(options.limit ?? 5),
    ...(options.location ? { location: options.location } : {}),
  })
}

export async function fetchDirections({ from, to, profile = 'driving' }) {
  if (!from || !to) {
    throw new Error('Route endpoints are required.')
  }

  const params = new URLSearchParams()
  params.append('coordinates', `${from.lng},${from.lat}`)
  params.append('coordinates', `${to.lng},${to.lat}`)
  params.set('profile', profile)

  return grabMapsRequest('/api/v1/maps/eta/v1/direction', params)
}
