import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'

const SINGAPORE = { lat: 1.3521, lng: 103.8198, zoom: 11 }
const SINGAPORE_BOUNDS = [
  [103.55, 1.16],
  [104.12, 1.49],
]
const GRAB_MAPS_BASE_URL = 'https://maps.grab.com'
const MAP_MIN_ZOOM = 10
const MAP_MAX_ZOOM = 15
const MAP_LOAD_FAILURE_PATTERN =
  /(?:style|sprite|glyph|metadata|source .*not found)/i
const MAP_CONFIG_FETCH_TIMEOUT_MS = 5000
const DEFAULT_CLIENT_CONFIG = {
  tileProvider: 'grab',
  googleTilesUrlTemplate: '/api/tiles/google/{z}/{x}/{y}.png',
  googleTilesAttribution: 'Google',
}

function isMapLike(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.project === 'function' &&
      typeof value.on === 'function' &&
      typeof value.off === 'function',
  )
}

function getInternalMap(grabMapsInstance) {
  const candidateMap =
    grabMapsInstance?.map ??
    grabMapsInstance?.mapInstance ??
    grabMapsInstance?.maplibreMap ??
    grabMapsInstance?.client?.map ??
    grabMapsInstance
  return isMapLike(candidateMap) ? candidateMap : null
}

function projectToWorld(lat, lng, zoom) {
  const sinLat = Math.sin((lat * Math.PI) / 180)
  const clampedSinLat = Math.max(Math.min(sinLat, 0.9999), -0.9999)
  const worldSize = 512 * (2 ** zoom)
  return {
    x: ((lng + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + clampedSinLat) / (1 - clampedSinLat)) / (4 * Math.PI)) * worldSize,
  }
}

function getFallbackPosition(pin, viewport, mapSize) {
  const center = projectToWorld(viewport.lat, viewport.lng, viewport.zoom)
  const point = projectToWorld(pin.lat, pin.lng, viewport.zoom)
  return {
    x: mapSize.width / 2 + point.x - center.x,
    y: mapSize.height / 2 + point.y - center.y,
  }
}

function getViewport(pins, midpoint) {
  if (!pins.length) {
    return midpoint ? { ...midpoint, zoom: 11 } : SINGAPORE
  }
  const latitudes = pins.map((pin) => pin.lat)
  const longitudes = pins.map((pin) => pin.lng)
  const avgLat = latitudes.reduce((sum, value) => sum + value, 0) / pins.length
  const avgLng = longitudes.reduce((sum, value) => sum + value, 0) / pins.length
  const span = Math.max(
    Math.max(...latitudes) - Math.min(...latitudes),
    Math.max(...longitudes) - Math.min(...longitudes),
  )
  const zoom = span > 0.14 ? 10 : span > 0.08 ? 11 : span > 0.035 ? 12 : 13
  return { lat: avgLat, lng: avgLng, zoom }
}

function buildPins(participants, candidates, selectedCandidateId) {
  const originPins = participants
    .filter((participant) => participant.origin?.location)
    .map((participant, index) => ({
      id: `origin-${participant.id}`,
      sourceId: participant.id,
      label: participant.name.slice(0, 1).toUpperCase(),
      name: `${participant.name} from ${participant.originText}`,
      lat: participant.origin.location.lat,
      lng: participant.origin.location.lng,
      kind: 'origin',
      color: '#2563eb',
      index,
    }))

  const venuePins = candidates.slice(0, 10).map((candidateScore) => {
    const candidate = candidateScore.candidate
    const selected = candidate.id === selectedCandidateId
    return {
      id: candidate.id,
      sourceId: candidate.id,
      label: String(candidateScore.rank),
      name: candidate.name,
      lat: candidate.location.lat,
      lng: candidate.location.lng,
      kind: selected ? 'winner' : 'candidate',
      color: selected ? '#00b14f' : '#64748b',
      index: candidateScore.rank,
    }
  })

  return [...originPins, ...venuePins]
}

function createMarkerElement(pin) {
  const marker = document.createElement('button')
  marker.type = 'button'
  marker.className = `map-marker ${pin.kind}`
  marker.title = pin.name
  marker.setAttribute('aria-label', pin.name)
  marker.textContent = pin.label
  marker.style.background = pin.color
  return marker
}

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

function resolveBackendUrl(baseUrl, urlOrPath) {
  if (!urlOrPath) {
    return ''
  }
  if (/^https?:\/\//i.test(urlOrPath)) {
    return urlOrPath
  }
  const normalizedPath = urlOrPath.startsWith('/') ? urlOrPath : `/${urlOrPath}`
  return `${baseUrl}${normalizedPath}`
}

function getGrabMapsIntegration(moduleValue) {
  const builderCandidates = [
    moduleValue?.GrabMaps,
    moduleValue,
    window.GrabMaps,
  ]
  const builderApi = builderCandidates.find(
    (candidate) =>
      candidate &&
      typeof candidate.GrabMapsBuilder === 'function' &&
      typeof candidate.MapBuilder === 'function',
  )

  return builderApi ? { builderApi } : null
}

function callBuilderToggle(builder, methodName) {
  if (typeof builder?.[methodName] !== 'function') {
    return builder
  }
  return builder[methodName]() ?? builder
}

function constrainInternalMap(internalMap) {
  internalMap.setMaxBounds?.(SINGAPORE_BOUNDS)
  internalMap.setMinZoom?.(MAP_MIN_ZOOM)
  internalMap.setMaxZoom?.(MAP_MAX_ZOOM)
}

function createGrabMapClient(integration, options, clientRef) {
  if (clientRef.current) {
    return clientRef.current
  }
  let builder = new integration.builderApi.GrabMapsBuilder()
    .setBaseUrl(options.upstreamBaseUrl)
  if (options.apiKey && typeof builder.setApiKey === 'function') {
    builder = builder.setApiKey(options.apiKey) ?? builder
  }
  clientRef.current = builder.build()
  return clientRef.current
}

async function buildGrabMap(integration, options, clientRef) {
  const client = createGrabMapClient(integration, options, clientRef)
  let builder = new integration.builderApi.MapBuilder(client)
    .setContainer(options.container)
    .setCenter([options.lng, options.lat])
    .setZoom(options.zoom)

  if (typeof builder.setMinZoom === 'function') {
    builder = builder.setMinZoom(MAP_MIN_ZOOM) ?? builder
  }
  if (typeof builder.setMaxZoom === 'function') {
    builder = builder.setMaxZoom(MAP_MAX_ZOOM) ?? builder
  }
  if (typeof builder.setMaxBounds === 'function') {
    builder = builder.setMaxBounds(SINGAPORE_BOUNDS) ?? builder
  }
  if (options.corsProxy && typeof builder.setCorsProxy === 'function') {
    builder = builder.setCorsProxy(options.corsProxy) ?? builder
  }
  builder = callBuilderToggle(builder, 'enableNavigation')
  builder = callBuilderToggle(builder, 'enableLabels')
  builder = callBuilderToggle(builder, 'enableBuildings')
  builder = callBuilderToggle(builder, 'enableAttribution')
  return builder.build()
}

function buildGoogleMap(options) {
  return new maplibregl.Map({
    container: options.container,
    center: [options.lng, options.lat],
    zoom: options.zoom,
    minZoom: MAP_MIN_ZOOM,
    maxZoom: MAP_MAX_ZOOM,
    maxBounds: SINGAPORE_BOUNDS,
    attributionControl: true,
    style: {
      version: 8,
      sources: {
        googleTiles: {
          type: 'raster',
          tiles: [options.tileUrlTemplate],
          tileSize: 256,
          attribution: options.attribution,
        },
      },
      layers: [
        {
          id: 'googleTilesLayer',
          type: 'raster',
          source: 'googleTiles',
        },
      ],
    },
  })
}

function MapPanel({
  participants,
  candidates,
  selectedCandidateId,
  midpoint,
  loading,
  loadingMessage,
  onSelectCandidate,
  pinsOverride = null,
  statusTitle = null,
  statusDescription = null,
  overlayLabel = 'Friendship Damage Control map pins',
}) {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const internalMapRef = useRef(null)
  const grabMapsIntegrationRef = useRef(null)
  const grabMapsClientRef = useRef(null)
  const markerRegistryRef = useRef(new Map())
  const mapReadyRef = useRef(false)
  const runtimeCleanupRef = useRef(null)
  const projectionRafRef = useRef(null)
  const pinsRef = useRef([])
  const onSelectCandidateRef = useRef(onSelectCandidate)
  const viewportRef = useRef(SINGAPORE)
  const sdkObjectUrlRef = useRef(null)
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 })
  const [clientConfig, setClientConfig] = useState(DEFAULT_CLIENT_CONFIG)
  const [configStatus, setConfigStatus] = useState('checking')
  const [mapSdkStatus, setMapSdkStatus] = useState('checking')
  const [mapRuntimeError, setMapRuntimeError] = useState('')
  const [projectedPositions, setProjectedPositions] = useState([])

  const frontendGrabApiKey = import.meta.env.VITE_GRAB_API_KEY?.trim() ?? ''
  const backendBaseUrl = getBackendBaseUrl()
  const clientConfigUrl = `${backendBaseUrl}/api/client-config`
  const sdkProxyUrl = import.meta.env.VITE_GRAB_SDK_URL ?? `${backendBaseUrl}/api/grabmaps/sdk`
  const corsProxyUrl = import.meta.env.VITE_GRAB_CORS_PROXY_URL ?? `${backendBaseUrl}/api/grabmaps/proxy?url=`
  const tileProvider = clientConfig.tileProvider === 'google' ? 'google' : 'grab'
  const googleTileTemplate = resolveBackendUrl(
    backendBaseUrl,
    clientConfig.googleTilesUrlTemplate,
  )
  const effectiveMapSdkStatus = configStatus !== 'ready' ? 'checking' : mapSdkStatus
  const effectiveMapSdkError = mapRuntimeError

  const plannedPins = useMemo(
    () => buildPins(participants, candidates, selectedCandidateId),
    [participants, candidates, selectedCandidateId],
  )
  const pins = pinsOverride ?? plannedPins
  const viewport = useMemo(() => getViewport(pins, midpoint), [pins, midpoint])
  const selectedCandidate = candidates.find(
    (candidate) => candidate.candidate.id === selectedCandidateId,
  )?.candidate
  const resolvedStatusTitle = statusTitle ?? selectedCandidate?.name ?? 'Least unfair search area'
  const resolvedStatusDescription = statusDescription ?? (
    pins.length
      ? `${participants.length} origins and ${Math.min(candidates.length, 10)} venues mapped`
      : 'Add friends, pick a category, and run the planner.'
  )
  const positionById = new Map(projectedPositions.map((position) => [position.id, position]))
  const displayPositions = mapSize.width > 0
    ? pins.map((pin) => ({
      pin,
      position: positionById.get(pin.id) ?? getFallbackPosition(pin, viewport, mapSize),
    }))
    : []
  const displayPositionById = new Map(
    displayPositions.map(({ pin, position }) => [pin.id, position]),
  )
  const routeTarget =
    displayPositions.find(({ pin }) => pin.kind === 'winner') ??
    displayPositions.find(({ pin }) => pin.kind === 'candidate' && pin.id === selectedCandidateId) ??
    displayPositions.find(({ pin }) => pin.kind === 'candidate')
  const routeLines = routeTarget
    ? displayPositions
      .filter(({ pin }) => pin.kind === 'origin')
      .map(({ pin, position }) => ({
        id: `${pin.id}-${routeTarget.pin.id}`,
        from: position,
        to: routeTarget.position,
      }))
    : []

  pinsRef.current = pins
  onSelectCandidateRef.current = onSelectCandidate
  viewportRef.current = viewport

  useEffect(() => {
    const container = mapContainerRef.current
    if (!container) {
      return undefined
    }
    const updateSize = () => {
      const rect = container.getBoundingClientRect()
      setMapSize({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
      const resizedMap = internalMapRef.current ?? getInternalMap(mapRef.current)
      resizedMap?.resize?.()
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), MAP_CONFIG_FETCH_TIMEOUT_MS)

    async function loadClientConfig() {
      setConfigStatus('checking')
      try {
        const response = await fetch(clientConfigUrl, {
          credentials: 'omit',
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const payload = await response.json()
        if (cancelled) {
          return
        }
        setClientConfig({
          tileProvider: payload.tileProvider === 'google' ? 'google' : 'grab',
          googleTilesUrlTemplate:
            payload.googleTilesUrlTemplate || DEFAULT_CLIENT_CONFIG.googleTilesUrlTemplate,
          googleTilesAttribution:
            payload.googleTilesAttribution || DEFAULT_CLIENT_CONFIG.googleTilesAttribution,
        })
        setConfigStatus('ready')
      } catch {
        if (cancelled) {
          return
        }
        setClientConfig(DEFAULT_CLIENT_CONFIG)
        setConfigStatus('ready')
      } finally {
        window.clearTimeout(timeoutId)
      }
    }

    loadClientConfig()

    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [clientConfigUrl])

  useEffect(() => {
    if (configStatus !== 'ready') {
      return undefined
    }
    if (tileProvider !== 'grab') {
      setMapSdkStatus('ready')
      setMapRuntimeError('')
      return undefined
    }

    let cancelled = false
    let objectUrl = null

    async function loadSdk() {
      setMapSdkStatus('checking')
      try {
        const response = await fetch(sdkProxyUrl, {
          credentials: 'omit',
        })
        const contentType = response.headers.get('content-type') ?? ''
        const sdkSource = await response.text()

        if (!response.ok) {
          throw new Error(`SDK proxy returned HTTP ${response.status}.`)
        }
        if (!contentType.includes('javascript') && !contentType.includes('ecmascript')) {
          throw new Error(`SDK proxy returned ${contentType || 'an unknown content type'}.`)
        }

        objectUrl = URL.createObjectURL(
          new Blob([sdkSource], { type: 'application/javascript' }),
        )
        sdkObjectUrlRef.current = objectUrl

        const sdkModule = await import(/* @vite-ignore */ objectUrl)
        if (cancelled) {
          return
        }
        const integration = getGrabMapsIntegration(sdkModule)
        if (integration) {
          grabMapsIntegrationRef.current = integration
          setMapSdkStatus('ready')
          setMapRuntimeError('')
          return
        }
        throw new Error('GrabMaps builder API export missing from SDK proxy.')
      } catch (error) {
        if (!cancelled) {
          setMapSdkStatus('failed')
          setMapRuntimeError(
            `GrabMaps SDK failed to load (${error.message}). Check backend /api/grabmaps/sdk and GRAB_API_KEY.`,
          )
        }
      }
    }

    loadSdk()
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
      if (sdkObjectUrlRef.current === objectUrl) {
        sdkObjectUrlRef.current = null
      }
    }
  }, [configStatus, sdkProxyUrl, tileProvider])

  useEffect(() => {
    function clearMarkers() {
      markerRegistryRef.current.forEach((entry) => {
        if (entry.clickHandler) {
          entry.element.removeEventListener('click', entry.clickHandler)
        }
        entry.marker.remove()
      })
      markerRegistryRef.current.clear()
    }

    function scheduleProjectedUpdate() {
      if (projectionRafRef.current || !internalMapRef.current) {
        return
      }
      projectionRafRef.current = window.requestAnimationFrame(() => {
        projectionRafRef.current = null
        const internalMap = internalMapRef.current
        if (!internalMap) {
          return
        }
        setProjectedPositions(
          pinsRef.current.map((pin) => {
            const point = internalMap.project([pin.lng, pin.lat])
            return { id: pin.id, x: point.x, y: point.y }
          }),
        )
      })
    }

    if (!mapContainerRef.current || effectiveMapSdkStatus !== 'ready') {
      return undefined
    }
    if (tileProvider === 'grab' && !grabMapsIntegrationRef.current) {
      return undefined
    }

    let initErrorTimeoutId = null
    let cancelled = false
    let failed = false
    let intervalId = null
    runtimeCleanupRef.current?.()
    runtimeCleanupRef.current = null

    const failMap = (message) => {
      if (cancelled || failed) {
        return
      }
      failed = true
      runtimeCleanupRef.current?.()
      runtimeCleanupRef.current = null
      clearMarkers()
      mapReadyRef.current = false
      internalMapRef.current = null
      if (projectionRafRef.current) {
        window.cancelAnimationFrame(projectionRafRef.current)
        projectionRafRef.current = null
      }
      if (mapRef.current?.remove) {
        mapRef.current.remove()
        mapRef.current = null
      }
      setProjectedPositions([])
      setMapSdkStatus('failed')
      setMapRuntimeError(message)
    }

    async function createMap() {
      if (mapRef.current) {
        return
      }

      const baseOptions = {
        container: mapContainerRef.current,
        apiKey: frontendGrabApiKey,
        upstreamBaseUrl: GRAB_MAPS_BASE_URL,
        corsProxy: corsProxyUrl,
        lat: viewportRef.current.lat,
        lng: viewportRef.current.lng,
        zoom: viewportRef.current.zoom,
      }
      try {
        if (tileProvider === 'google') {
          mapRef.current = buildGoogleMap({
            container: mapContainerRef.current,
            lat: viewportRef.current.lat,
            lng: viewportRef.current.lng,
            zoom: viewportRef.current.zoom,
            tileUrlTemplate: googleTileTemplate,
            attribution: clientConfig.googleTilesAttribution,
          })
        } else {
          mapRef.current = await buildGrabMap(
            grabMapsIntegrationRef.current,
            baseOptions,
            grabMapsClientRef,
          )
        }
      } catch (error) {
        if (!cancelled) {
          initErrorTimeoutId = window.setTimeout(() => {
            setMapSdkStatus('failed')
            setMapRuntimeError(
              tileProvider === 'google'
                ? `Google tile map initialization failed (${error.message}). Check backend /api/tiles/google and TILE_PROVIDER.`
                : `GrabMaps map initialization failed (${error.message}). Check backend /api/grabmaps/proxy and GRAB_API_KEY.`,
            )
          }, 0)
        }
        return
      }

      intervalId = window.setInterval(() => {
        if (failed) {
          window.clearInterval(intervalId)
          return
        }
        const internalMap = getInternalMap(mapRef.current)
        if (!internalMap) {
          return
        }
        window.clearInterval(intervalId)
        internalMapRef.current = internalMap
        mapReadyRef.current = true
        constrainInternalMap(internalMap)

        const handleMapError = (event) => {
          const message = event?.error?.message ?? event?.message ?? ''
          if (MAP_LOAD_FAILURE_PATTERN.test(message) && !/tile|\.pbf|5\d\d|4\d\d/i.test(message)) {
            failMap(
              tileProvider === 'google'
                ? 'Google tile assets are temporarily unavailable from upstream. Showing estimated pins.'
                : 'GrabMaps style assets are temporarily unavailable from the upstream service. Showing estimated pins.',
            )
          }
        }
        internalMap.on('error', handleMapError)
        const events = ['move', 'zoom', 'resize', 'rotate', 'pitch']
        events.forEach((eventName) => internalMap.on(eventName, scheduleProjectedUpdate))
        scheduleProjectedUpdate()
        runtimeCleanupRef.current = () => {
          internalMap.off('error', handleMapError)
          events.forEach((eventName) => internalMap.off(eventName, scheduleProjectedUpdate))
        }
      }, 100)
    }

    createMap()

    return () => {
      cancelled = true
      if (initErrorTimeoutId) {
        window.clearTimeout(initErrorTimeoutId)
      }
      if (intervalId) {
        window.clearInterval(intervalId)
      }
      runtimeCleanupRef.current?.()
      runtimeCleanupRef.current = null
      clearMarkers()
      mapReadyRef.current = false
      internalMapRef.current = null
      if (projectionRafRef.current) {
        window.cancelAnimationFrame(projectionRafRef.current)
        projectionRafRef.current = null
      }
      setProjectedPositions([])
      if (mapRef.current?.remove) {
        mapRef.current.remove()
        mapRef.current = null
      }
    }
  }, [
    clientConfig.googleTilesAttribution,
    corsProxyUrl,
    effectiveMapSdkStatus,
    frontendGrabApiKey,
    googleTileTemplate,
    tileProvider,
  ])

  useEffect(() => {
    if (!mapReadyRef.current || !internalMapRef.current) {
      return
    }
    const internalMap = internalMapRef.current
    const markerRegistry = markerRegistryRef.current
    const Marker = window.maplibregl?.Marker ?? maplibregl.Marker
    if (Marker) {
      const nextIds = new Set(pins.map((pin) => pin.id))
      markerRegistry.forEach((entry, id) => {
        if (nextIds.has(id)) {
          return
        }
        if (entry.clickHandler) {
          entry.element.removeEventListener('click', entry.clickHandler)
        }
        entry.marker.remove()
        markerRegistry.delete(id)
      })

      pins.forEach((pin) => {
        const existing = markerRegistry.get(pin.id)
        if (!existing) {
          const element = createMarkerElement(pin)
          const clickHandler = pin.kind !== 'origin'
            ? () => onSelectCandidateRef.current?.(pin.id)
            : null
          if (clickHandler) {
            element.addEventListener('click', clickHandler)
          }
          const marker = new Marker({ element, anchor: 'bottom' })
            .setLngLat([pin.lng, pin.lat])
            .addTo(internalMap)
          markerRegistry.set(pin.id, { marker, element, clickHandler })
          return
        }

        existing.marker.setLngLat([pin.lng, pin.lat])
        existing.element.className = `map-marker ${pin.kind}`
        existing.element.title = pin.name
        existing.element.setAttribute('aria-label', pin.name)
        existing.element.textContent = pin.label
        existing.element.style.background = pin.color
        if (existing.clickHandler) {
          existing.element.removeEventListener('click', existing.clickHandler)
        }
        existing.clickHandler = pin.kind !== 'origin'
          ? () => onSelectCandidateRef.current?.(pin.id)
          : null
        if (existing.clickHandler) {
          existing.element.addEventListener('click', existing.clickHandler)
        }
      })
    }

    if (pins.length > 1) {
      const bounds = pins.reduce(
        (box, pin) => ({
          minLng: Math.min(box.minLng, pin.lng),
          maxLng: Math.max(box.maxLng, pin.lng),
          minLat: Math.min(box.minLat, pin.lat),
          maxLat: Math.max(box.maxLat, pin.lat),
        }),
        {
          minLng: pins[0].lng,
          maxLng: pins[0].lng,
          minLat: pins[0].lat,
          maxLat: pins[0].lat,
        },
      )
      internalMap.fitBounds(
        [
          [bounds.minLng, bounds.minLat],
          [bounds.maxLng, bounds.maxLat],
        ],
        { padding: 80, maxZoom: 14, duration: 0 },
      )
      return
    }

    internalMap.jumpTo?.({
      center: [viewport.lng, viewport.lat],
      zoom: viewport.zoom,
    })
  }, [onSelectCandidate, pins, viewport])

  return (
    <section className="map-panel">
      <div className="map-canvas" ref={mapContainerRef}>
        <div className="map-fallback-grid" />
        {mapSize.width > 0 && routeLines.length > 0 && (
          <svg className="map-route-overlay" aria-hidden="true">
            {routeLines.map((line) => (
              <line
                key={line.id}
                x1={line.from.x}
                y1={line.from.y}
                x2={line.to.x}
                y2={line.to.y}
              />
            ))}
          </svg>
        )}
        {mapSize.width > 0 && pins.length > 0 && (
          <div className="pin-overlay" aria-label={overlayLabel}>
            {pins.map((pin) => {
              const position = displayPositionById.get(pin.id)
              return (
                <button
                  key={pin.id}
                  type="button"
                  className={`overlay-pin ${pin.kind}`}
                  style={{
                    left: `${position.x}px`,
                    top: `${position.y}px`,
                    backgroundColor: pin.color,
                  }}
                  title={pin.name}
                  aria-label={pin.name}
                  onClick={() => pin.kind !== 'origin' && onSelectCandidate?.(pin.id)}
                >
                  {pin.label}
                </button>
              )
            })}
          </div>
        )}
        <div className="map-status-card">
          <p className="eyebrow">Singapore</p>
          <h2>{resolvedStatusTitle}</h2>
          <p>{resolvedStatusDescription}</p>
          <div className="map-legend" aria-hidden="true">
            <span><i className="origin" />Start</span>
            <span><i className="candidate" />Venue</span>
            <span><i className="winner" />Selected</span>
          </div>
        </div>
        {(effectiveMapSdkStatus === 'failed' || effectiveMapSdkStatus === 'checking') && (
          <div className="map-warning">
            {effectiveMapSdkStatus === 'checking'
              ? `Loading ${tileProvider === 'google' ? 'Google tiles' : 'GrabMaps'}...`
              : effectiveMapSdkError}
          </div>
        )}
        {loading && <div className="map-loading">{loadingMessage}</div>}
      </div>
    </section>
  )
}

export default MapPanel
