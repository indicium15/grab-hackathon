function getBackendBaseUrl() {
  const configuredBaseUrl = import.meta.env.VITE_BACKEND_BASE_URL?.trim()
  if (
    import.meta.env.DEV &&
    (!configuredBaseUrl || configuredBaseUrl === 'http://localhost:8000')
  ) {
    return ''
  }
  return configuredBaseUrl ?? ''
}

const BASE_URL = getBackendBaseUrl()

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || `Request failed with status ${response.status}`)
  }

  return response.json()
}

export function fetchProfile() {
  return request('/api/profile')
}

export function generateItinerary(payload) {
  return request('/api/itinerary/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function tryAnotherItinerary(payload) {
  return request('/api/itinerary/another', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function planFairlyLate(payload) {
  return request('/api/fairly-late/plan', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
