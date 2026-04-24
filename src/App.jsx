import { useCallback, useEffect, useMemo, useState } from 'react'
import MapPanel from './components/MapPanel.jsx'
import { planFairlyLate } from './services/backendApi.js'
import { fetchDirections, searchPlaces } from './services/grabMapsApi.js'

const RISK_BUFFERS = {
  responsible: 15,
  bold: 5,
  'career-ending': -2,
}

const DEPARTURE_TIMING_OPTIONS = [
  {
    key: 'responsible',
    label: 'Responsible',
    quip: 'Extra cushion. Annoyingly wise.',
  },
  {
    key: 'bold',
    label: 'Bold',
    quip: 'Probably fine. Great last words.',
  },
  {
    key: 'career-ending',
    label: 'Career-ending',
    quip: 'Technically a time. Not advice.',
  },
]

const WEIGHTS = {
  'can-suffer': 0.75,
  normal: 1,
  vip: 1.35,
}

const LOADING_TEXTS = [
  'Finding places...',
  'Routing everyone...',
  'Calculating emotional damage...',
  'Triaging bad decisions...',
]

const DEMO_PARTICIPANTS = [
  { id: 'alice', name: 'Alice', originText: 'Tampines MRT', weightLabel: 'normal' },
  { id: 'ben', name: 'Ben', originText: 'Jurong East', weightLabel: 'normal' },
  { id: 'chloe', name: 'Chloe', originText: 'Orchard', weightLabel: 'normal' },
  { id: 'deepak', name: 'David', originText: 'One North', weightLabel: 'normal' },
]

const TAB_ITEMS = {
  meetup: {
    label: 'Friendship Damage Control',
    copy: 'Everyone suffers equally.',
  },
  generic: {
    label: 'Procrastinavigator',
    copy: 'Because "leaving early" is overrated.',
  },
  concierge: {
    label: 'Disaster Concierge',
    copy: 'For emergencies of questionable seriousness.',
  },
}

const TRAVEL_PROFILES = {
  driving: 'Driving',
  motorcycle: 'Motorcycle',
  tricycle: 'Tricycle',
  cycling: 'Cycling',
  walking: 'Walking',
}

const CATEGORY_SUGGESTIONS = ['restaurant', 'cafe', 'hawker', 'bar']

const BRAND_COPY = {
  meetup: 'Find the least unfair place to meet, then see exactly how late everyone can leave.',
  generic: 'Calculate the latest safe departure time between any two places.',
  concierge: 'Pick a crisis, summon nearby rescue points, and let the map pretend this was all planned.',
}

const CRISIS_MODES = {
  starving: {
    label: 'I am starving',
    shortLabel: 'Starving',
    keywords: ['restaurant', 'hawker', 'food'],
    briefing: 'Emergency calories have been escalated to city-level priority.',
    protocols: [
      'Secure carbohydrates before making any major life decisions.',
      'Avoid venues requiring more than one group chat vote.',
      'Declare victory after the first edible thing arrives.',
    ],
  },
  caffeine: {
    label: 'I need caffeine',
    shortLabel: 'Caffeine',
    keywords: ['coffee', 'cafe'],
    briefing: 'Productivity systems are below minimum viable humanity.',
    protocols: [
      'Acquire coffee before opening Slack, email, or feelings.',
      'Choose the shortest route with the highest chance of seating.',
      'Reassess all deadlines after the first sip.',
    ],
  },
  impress: {
    label: 'I need to impress someone',
    shortLabel: 'Impress',
    keywords: ['restaurant', 'bar', 'dessert'],
    briefing: 'Charm logistics initiated. Tasteful panic only.',
    protocols: [
      'Pick somewhere close enough to look spontaneous.',
      'Never reveal the itinerary was generated under pressure.',
      'Dessert is the emergency backup plan.',
    ],
  },
  medical: {
    label: 'I need medical help',
    shortLabel: 'Medical',
    keywords: ['clinic', 'pharmacy', 'hospital'],
    briefing: 'Health-related locations prioritized. The jokes are now wearing a seatbelt.',
    protocols: [
      'For serious symptoms, contact emergency services immediately.',
      'Use the closest suitable care option, not the funniest one.',
      'Share your location with someone you trust.',
    ],
  },
  disappear: {
    label: 'I need to disappear for 20 minutes',
    shortLabel: 'Disappear',
    keywords: ['park', 'library', 'cafe'],
    briefing: 'Temporary vanishing protocol ready. Plausible deniability not included.',
    protocols: [
      'Find quiet, shade, or caffeine. Ideally two of three.',
      'Set a timer before the soft reset becomes a side quest.',
      'Return with one normal-sounding excuse.',
    ],
  },
}

const CONCIERGE_ROUTE_LIMIT = 8
const CONCIERGE_RESULT_LIMIT = 5
const FALLBACK_DRIVING_KPH = 32

function toPayloadParticipant(participant) {
  return {
    id: participant.id,
    name: participant.name.trim() || 'Friend',
    originText: participant.originText.trim(),
    weight: WEIGHTS[participant.weightLabel] ?? 1,
  }
}

function getArrivalDate(arrivalTime) {
  const [hours = '19', minutes = '00'] = arrivalTime.split(':')
  const arrival = new Date()
  arrival.setHours(Number(hours), Number(minutes), 0, 0)
  if (arrival <= new Date()) {
    arrival.setDate(arrival.getDate() + 1)
  }
  return arrival
}

function formatClock(value) {
  return new Intl.DateTimeFormat('en-SG', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(value instanceof Date ? value : new Date(value))
}

function formatMinutes(value) {
  return `${Math.round(value)} min`
}

function formatDistance(meters) {
  return `${(meters / 1000).toFixed(1)} km`
}

function getInitial(name) {
  return (name.trim().slice(0, 1) || '?').toUpperCase()
}

function normalizeToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function getPlaceName(place) {
  return place?.name?.trim() || place?.address?.trim() || 'Unknown place'
}

function getPlaceCoordinates(place) {
  const location = place?.location ?? place?.coordinate ?? {}
  const lat = Number(
    location.latitude ??
      location.lat ??
      location.y ??
      place?.latitude ??
      place?.lat,
  )
  const lng = Number(
    location.longitude ??
      location.lng ??
      location.lon ??
      location.long ??
      location.x ??
      place?.longitude ??
      place?.lng ??
      place?.lon,
  )
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null
  }
  return { lat, lng }
}

function getPlaceIdentity(place, coords, fallbackIndex = 0) {
  const upstreamId = place?.poi_id ?? place?.place_id ?? place?.id
  if (upstreamId) {
    return String(upstreamId)
  }
  const nameToken = normalizeToken(getPlaceName(place)) || 'place'
  if (!coords) {
    return `${nameToken}-${fallbackIndex}`
  }
  return `${nameToken}-${coords.lat.toFixed(5)}-${coords.lng.toFixed(5)}`
}

function getStraightLineDistanceMeters(from, to) {
  const earthRadiusMeters = 6371000
  const fromLat = (from.lat * Math.PI) / 180
  const toLat = (to.lat * Math.PI) / 180
  const deltaLat = ((to.lat - from.lat) * Math.PI) / 180
  const deltaLng = ((to.lng - from.lng) * Math.PI) / 180
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function buildConciergeCandidates(searchResponses, keywords) {
  const byKey = new Map()

  searchResponses.forEach((response, responseIndex) => {
    const keyword = keywords[responseIndex]
    const places = Array.isArray(response?.places) ? response.places : []

    places.forEach((place, placeIndex) => {
      const coords = getPlaceCoordinates(place)
      if (!coords) {
        return
      }
      const id = getPlaceIdentity(place, coords, placeIndex)
      const name = getPlaceName(place)
      const key = place?.poi_id
        ? `poi:${place.poi_id}`
        : `${normalizeToken(name)}:${coords.lat.toFixed(4)}:${coords.lng.toFixed(4)}`
      const existing = byKey.get(key)

      if (existing) {
        existing.keywords.add(keyword)
        return
      }

      byKey.set(key, {
        id,
        name,
        place,
        coords,
        keywords: new Set([keyword]),
        order: responseIndex * 10 + placeIndex,
      })
    })
  })

  return Array.from(byKey.values()).sort((first, second) => (
    second.keywords.size - first.keywords.size || first.order - second.order
  ))
}

function scoreConciergeCandidate(candidate, originCoords, routeData) {
  const route = routeData?.routes?.[0]
  const routeDurationSeconds = Number(route?.duration)
  const routeDistanceMeters = Number(route?.distance)
  const fallbackDistanceMeters = getStraightLineDistanceMeters(originCoords, candidate.coords)
  const routeAvailable = Number.isFinite(routeDurationSeconds) && routeDurationSeconds > 0
  const durationMinutes = routeAvailable
    ? routeDurationSeconds / 60
    : Math.max(6, (fallbackDistanceMeters / 1000 / FALLBACK_DRIVING_KPH) * 60)
  const distanceMeters =
    Number.isFinite(routeDistanceMeters) && routeDistanceMeters > 0
      ? routeDistanceMeters
      : fallbackDistanceMeters
  const keywordBonus = Math.min(candidate.keywords.size - 1, 2) * 6
  const routePenalty = routeAvailable ? 0 : 16
  const score = Math.max(
    28,
    Math.min(99, Math.round(104 - durationMinutes * 1.15 + keywordBonus - routePenalty)),
  )

  return {
    id: candidate.id,
    name: candidate.name,
    place: candidate.place,
    lat: candidate.coords.lat,
    lng: candidate.coords.lng,
    keywords: Array.from(candidate.keywords),
    score,
    distanceMeters,
    durationMinutes,
    routeAvailable,
  }
}

function buildDepartures(candidate, arrivalTime) {
  if (!candidate) {
    return []
  }
  const arrival = getArrivalDate(arrivalTime)
  return candidate.routes.map((route) => {
    const departures = {}
    Object.entries(RISK_BUFFERS).forEach(([risk, buffer]) => {
      departures[risk] = new Date(
        arrival.getTime() - (route.durationMinutes + buffer) * 60 * 1000,
      )
    })
    return {
      ...route,
      departures,
    }
  })
}

function getParticipantName(participants, id) {
  return participants.find((participant) => participant.id === id)?.name ?? 'Friend'
}

function explainCandidate(candidate, participants, isWinner, backendExplanation) {
  if (!candidate) {
    return ''
  }
  if (isWinner && backendExplanation) {
    return backendExplanation
  }
  const mostRoute = candidate.routes.reduce((current, route) => (
    route.durationMinutes > current.durationMinutes ? route : current
  ))
  const leastRoute = candidate.routes.reduce((current, route) => (
    route.durationMinutes < current.durationMinutes ? route : current
  ))
  return `Rank #${candidate.rank} is less fair because the travel spread is ${Math.round(candidate.rangeMinutes)} minutes. ${getParticipantName(participants, mostRoute.participantId)} takes ${Math.round(mostRoute.durationMinutes)} minutes while ${getParticipantName(participants, leastRoute.participantId)} only takes ${Math.round(leastRoute.durationMinutes)}.`
}

function App() {
  const [activeTab, setActiveTab] = useState('meetup')
  const [participants, setParticipants] = useState(DEMO_PARTICIPANTS)
  const [categoryKeyword, setCategoryKeyword] = useState('restaurant')
  const [arrivalTime, setArrivalTime] = useState('19:00')
  const [plan, setPlan] = useState(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingIndex, setLoadingIndex] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [genericOriginText, setGenericOriginText] = useState('Tampines MRT')
  const [genericDestinationText, setGenericDestinationText] = useState('Marina Bay Sands')
  const [genericArrivalTime, setGenericArrivalTime] = useState('09:00')
  const [genericProfile, setGenericProfile] = useState('driving')
  const [genericPlan, setGenericPlan] = useState(null)
  const [genericLoading, setGenericLoading] = useState(false)
  const [genericErrorMessage, setGenericErrorMessage] = useState('')
  const [conciergeMode, setConciergeMode] = useState('starving')
  const [conciergeStartText, setConciergeStartText] = useState('Orchard')
  const [conciergePlan, setConciergePlan] = useState(null)
  const [selectedConciergeId, setSelectedConciergeId] = useState(null)
  const [conciergeLoading, setConciergeLoading] = useState(false)
  const [conciergeErrorMessage, setConciergeErrorMessage] = useState('')

  useEffect(() => {
    if (!loading && !genericLoading && !conciergeLoading) {
      return undefined
    }
    const intervalId = window.setInterval(() => {
      setLoadingIndex((index) => (index + 1) % LOADING_TEXTS.length)
    }, 850)
    return () => window.clearInterval(intervalId)
  }, [loading, genericLoading, conciergeLoading])

  const selectedCandidate = useMemo(() => {
    if (!plan?.candidates?.length) {
      return null
    }
    return (
      plan.candidates.find((candidate) => candidate.candidate.id === selectedCandidateId) ??
      plan.candidates[0]
    )
  }, [plan, selectedCandidateId])
  const selectedCrisis = CRISIS_MODES[conciergeMode] ?? CRISIS_MODES.starving
  const selectedConciergeOption = useMemo(() => {
    if (!conciergePlan?.options?.length) {
      return null
    }
    return (
      conciergePlan.options.find((option) => option.id === selectedConciergeId) ??
      conciergePlan.options[0]
    )
  }, [conciergePlan, selectedConciergeId])

  const departureRows = useMemo(
    () => buildDepartures(selectedCandidate, arrivalTime),
    [selectedCandidate, arrivalTime],
  )

  const resolvedParticipants = plan?.participants ?? []
  const currentExplanation = explainCandidate(
    selectedCandidate,
    resolvedParticipants,
    selectedCandidate?.candidate.id === plan?.selectedCandidateId,
    plan?.explanation,
  )
  const hasEstimatedRoutes = selectedCandidate?.routes.some((route) => route.estimatedFallback)
  const mostSufferingName = plan?.mostSufferingParticipantId
    ? getParticipantName(resolvedParticipants, plan.mostSufferingParticipantId)
    : null
  const genericDepartures = useMemo(() => {
    if (!genericPlan?.durationMinutes) {
      return null
    }
    const arrival = getArrivalDate(genericArrivalTime)
    const departures = {}
    Object.entries(RISK_BUFFERS).forEach(([risk, buffer]) => {
      departures[risk] = new Date(
        arrival.getTime() - (genericPlan.durationMinutes + buffer) * 60 * 1000,
      )
    })
    return departures
  }, [genericArrivalTime, genericPlan])
  const genericPins = useMemo(() => {
    if (!genericPlan) {
      return []
    }
    return [
      {
        id: 'generic-origin',
        sourceId: genericPlan.origin.poi_id ?? 'generic-origin',
        label: 'S',
        name: `Start: ${genericPlan.origin.name}`,
        lat: genericPlan.origin.location.latitude,
        lng: genericPlan.origin.location.longitude,
        kind: 'origin',
        color: '#2563eb',
        index: 0,
      },
      {
        id: 'generic-destination',
        sourceId: genericPlan.destination.poi_id ?? 'generic-destination',
        label: 'D',
        name: `Destination: ${genericPlan.destination.name}`,
        lat: genericPlan.destination.location.latitude,
        lng: genericPlan.destination.location.longitude,
        kind: 'winner',
        color: '#00b14f',
        index: 1,
      },
    ]
  }, [genericPlan])
  const conciergePins = useMemo(() => {
    if (!conciergePlan?.origin || !conciergePlan?.options?.length) {
      return []
    }
    return [
      {
        id: 'concierge-origin',
        sourceId: conciergePlan.origin.id ?? 'concierge-origin',
        label: 'S',
        name: `Start: ${conciergePlan.origin.name}`,
        lat: conciergePlan.origin.lat,
        lng: conciergePlan.origin.lng,
        kind: 'origin',
        color: '#2563eb',
        index: 0,
      },
      ...conciergePlan.options.map((option) => {
        const selected = option.id === selectedConciergeOption?.id
        return {
          id: option.id,
          sourceId: option.id,
          label: selected ? '!' : String(option.rank),
          name: `${option.name}: ${option.score}% survival confidence`,
          lat: option.lat,
          lng: option.lng,
          kind: selected ? 'winner' : 'candidate',
          color: selected ? '#00b14f' : '#64748b',
          index: option.rank,
        }
      }),
    ]
  }, [conciergePlan, selectedConciergeOption])

  const handleMeetupCandidateSelect = useCallback((candidateId, source = 'unknown') => {
    setSelectedCandidateId((currentId) => {
      console.debug('[FriendshipDamageControl] candidate select', {
        source,
        previousCandidateId: currentId,
        nextCandidateId: candidateId,
      })
      return candidateId
    })
  }, [])
  const handleConciergeSelect = useCallback((optionId, source = 'unknown') => {
    setSelectedConciergeId((currentId) => {
      console.debug('[DisasterConcierge] option select', {
        source,
        previousOptionId: currentId,
        nextOptionId: optionId,
      })
      return optionId
    })
  }, [])

  function updateParticipant(id, field, value) {
    setParticipants((current) =>
      current.map((participant) =>
        participant.id === id ? { ...participant, [field]: value } : participant,
      ),
    )
  }

  function addParticipant() {
    const id = `friend-${Date.now()}`
    setParticipants((current) => [
      ...current,
      { id, name: `Friend ${current.length + 1}`, originText: '', weightLabel: 'normal' },
    ])
  }

  function removeParticipant(id) {
    setParticipants((current) => current.filter((participant) => participant.id !== id))
  }

  function swapGenericRoute() {
    setGenericOriginText(genericDestinationText)
    setGenericDestinationText(genericOriginText)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const usableParticipants = participants
      .map(toPayloadParticipant)
      .filter((participant) => participant.originText)

    if (usableParticipants.length < 2) {
      setErrorMessage('Add at least two starting locations before convening the fairness tribunal.')
      return
    }

    setLoading(true)
    setLoadingIndex(0)
    setErrorMessage('')

    try {
      const response = await planFairlyLate({
        participants: usableParticipants,
        categoryKeyword,
        targetArrivalTime: arrivalTime,
        mode: 'drive',
      })
      setPlan(response)
      setSelectedCandidateId(response.selectedCandidateId)
    } catch (error) {
      console.error(error)
      setErrorMessage('Could not build the meetup plan. Check the backend and GrabMaps credentials.')
    } finally {
      setLoading(false)
    }
  }

  async function handleGenericSubmit(event) {
    event.preventDefault()
    const originKeyword = genericOriginText.trim()
    const destinationKeyword = genericDestinationText.trim()

    if (!originKeyword || !destinationKeyword) {
      setGenericErrorMessage('Add both start and destination locations.')
      return
    }

    setGenericLoading(true)
    setLoadingIndex(0)
    setGenericErrorMessage('')

    try {
      const [originResult, destinationResult] = await Promise.all([
        searchPlaces(originKeyword, { limit: 1 }),
        searchPlaces(destinationKeyword, { limit: 1 }),
      ])

      const origin = originResult?.places?.[0]
      const destination = destinationResult?.places?.[0]
      if (!origin || !destination) {
        throw new Error('Could not resolve one of the locations.')
      }

      const routeData = await fetchDirections({
        from: {
          lat: origin.location.latitude,
          lng: origin.location.longitude,
        },
        to: {
          lat: destination.location.latitude,
          lng: destination.location.longitude,
        },
        profile: genericProfile,
      })

      const route = routeData?.routes?.[0]
      if (!route) {
        throw new Error('No route returned by GrabMaps.')
      }

      setGenericPlan({
        origin,
        destination,
        profile: genericProfile,
        distanceMeters: route.distance,
        durationSeconds: route.duration,
        durationMinutes: route.duration / 60,
      })
    } catch (error) {
      console.error(error)
      setGenericErrorMessage(
        'Could not calculate a latest departure. Check GrabMaps API key and inputs.',
      )
    } finally {
      setGenericLoading(false)
    }
  }

  async function handleConciergeSubmit(event) {
    event.preventDefault()
    const startKeyword = conciergeStartText.trim()

    if (!startKeyword) {
      setConciergeErrorMessage('Add a starting location before declaring a minor emergency.')
      return
    }

    setConciergeLoading(true)
    setLoadingIndex(0)
    setConciergeErrorMessage('')
    setConciergePlan(null)
    setSelectedConciergeId(null)

    try {
      const originResult = await searchPlaces(startKeyword, { limit: 1 })
      const originPlace = originResult?.places?.[0]
      const originCoords = getPlaceCoordinates(originPlace)
      if (!originPlace || !originCoords) {
        throw new Error('Could not resolve the starting location.')
      }

      const location = `${originCoords.lat},${originCoords.lng}`
      const searchResponses = await Promise.all(
        selectedCrisis.keywords.map((keyword) =>
          searchPlaces(keyword, { location, limit: 5 }).catch((error) => {
            console.warn('[DisasterConcierge] search failed', { keyword, error })
            return { places: [] }
          }),
        ),
      )
      const candidates = buildConciergeCandidates(searchResponses, selectedCrisis.keywords)
        .slice(0, CONCIERGE_ROUTE_LIMIT)

      if (!candidates.length) {
        throw new Error('No nearby rescue points found.')
      }

      const routeResponses = await Promise.all(
        candidates.map((candidate) =>
          fetchDirections({
            from: originCoords,
            to: candidate.coords,
            profile: 'driving',
          }).catch((error) => {
            console.warn('[DisasterConcierge] route failed', {
              candidate: candidate.name,
              error,
            })
            return null
          }),
        ),
      )
      const options = candidates
        .map((candidate, index) =>
          scoreConciergeCandidate(candidate, originCoords, routeResponses[index]),
        )
        .sort((first, second) => (
          second.score - first.score || first.durationMinutes - second.durationMinutes
        ))
        .slice(0, CONCIERGE_RESULT_LIMIT)
        .map((option, index) => ({ ...option, rank: index + 1 }))

      setConciergePlan({
        mode: conciergeMode,
        origin: {
          id: getPlaceIdentity(originPlace, originCoords),
          name: getPlaceName(originPlace),
          lat: originCoords.lat,
          lng: originCoords.lng,
        },
        options,
      })
      setSelectedConciergeId(options[0].id)
    } catch (error) {
      console.error(error)
      setConciergeErrorMessage(
        'Could not summon the disaster concierge. Check GrabMaps API key and inputs.',
      )
    } finally {
      setConciergeLoading(false)
    }
  }

  const activeConciergeCrisis = CRISIS_MODES[conciergePlan?.mode ?? conciergeMode] ?? selectedCrisis

  return (
    <main className="fairly-shell">
      <MapPanel
        participants={activeTab === 'meetup' ? resolvedParticipants : []}
        candidates={activeTab === 'meetup' ? plan?.candidates ?? [] : []}
        selectedCandidateId={
          activeTab === 'meetup'
            ? selectedCandidate?.candidate.id ?? null
            : activeTab === 'concierge'
              ? selectedConciergeOption?.id ?? null
              : null
        }
        midpoint={activeTab === 'meetup' ? plan?.midpoint : null}
        loading={
          activeTab === 'meetup'
            ? loading
            : activeTab === 'generic'
              ? genericLoading
              : conciergeLoading
        }
        loadingMessage={LOADING_TEXTS[loadingIndex]}
        onSelectCandidate={
          activeTab === 'meetup'
            ? handleMeetupCandidateSelect
            : activeTab === 'concierge'
              ? handleConciergeSelect
              : undefined
        }
        pinsOverride={
          activeTab === 'generic'
            ? genericPins
            : activeTab === 'concierge'
              ? conciergePins
              : null
        }
        overlayLabel={
          activeTab === 'generic'
            ? 'Generic route pins'
            : activeTab === 'concierge'
              ? 'Disaster Concierge map pins'
              : 'Friendship Damage Control map pins'
        }
      />

      <aside className="control-panel">
        <div className="mode-tabs" role="tablist" aria-label="Planner mode">
          {Object.entries(TAB_ITEMS).map(([tabKey, item]) => (
            <button
              key={tabKey}
              type="button"
              role="tab"
              aria-selected={activeTab === tabKey}
              className={activeTab === tabKey ? 'active' : ''}
              onClick={() => setActiveTab(tabKey)}
            >
              <span>{item.label}</span>
              <small>{item.copy}</small>
            </button>
          ))}
        </div>

        <header className="brand-block">
          <p>{BRAND_COPY[activeTab]}</p>
        </header>

        {activeTab === 'meetup' ? (
          <>
            <form className="planner-form" onSubmit={handleSubmit}>
              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <p className="section-kicker">Step 1</p>
                    <h2>People</h2>
                  </div>
                  <button type="button" className="icon-text-button" onClick={addParticipant}>
                    <span aria-hidden="true">+</span>
                    Add
                  </button>
                </div>
                <div className="participant-list">
                  {participants.map((participant) => (
                    <div className="participant-row" key={participant.id}>
                      <span className="participant-avatar" aria-hidden="true">
                        {getInitial(participant.name)}
                      </span>
                      <label className="compact-field name-field">
                        <span>Name</span>
                        <input
                          aria-label="Name"
                          value={participant.name}
                          onChange={(event) =>
                            updateParticipant(participant.id, 'name', event.target.value)
                          }
                        />
                      </label>
                      <label className="compact-field origin-field">
                        <span>Starts from</span>
                        <input
                          aria-label="Starting location"
                          value={participant.originText}
                          placeholder="Starting point"
                          onChange={(event) =>
                            updateParticipant(participant.id, 'originText', event.target.value)
                          }
                        />
                      </label>
                      <label className="compact-field weight-field">
                        <span>Priority</span>
                        <select
                          aria-label="Fairness weight"
                          value={participant.weightLabel}
                          onChange={(event) =>
                            updateParticipant(participant.id, 'weightLabel', event.target.value)
                          }
                        >
                          <option value="normal">Normal</option>
                          <option value="vip">VIP</option>
                          <option value="can-suffer">Flexible</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${participant.name}`}
                        onClick={() => removeParticipant(participant.id)}
                        disabled={participants.length <= 2}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <p className="section-kicker">Step 2</p>
                    <h2>Meetup</h2>
                  </div>
                </div>
                <div className="chip-row" aria-label="Popular meetup categories">
                  {CATEGORY_SUGGESTIONS.map((keyword) => (
                    <button
                      key={keyword}
                      type="button"
                      className={categoryKeyword.toLowerCase() === keyword ? 'active' : ''}
                      onClick={() => setCategoryKeyword(keyword)}
                    >
                      {keyword}
                    </button>
                  ))}
                </div>
                <label className="field-label">
                  Target arrival
                  <input
                    type="time"
                    value={arrivalTime}
                    onChange={(event) => setArrivalTime(event.target.value)}
                  />
                </label>
              </section>

              <button type="submit" className="primary-button" disabled={loading}>
                {loading ? LOADING_TEXTS[loadingIndex] : 'Find Least Unfair Meetup'}
              </button>
            </form>

            {errorMessage && <p className="message error">{errorMessage}</p>}
            {plan?.warnings?.length > 0 && (
              <p className="message warning">{Array.from(new Set(plan.warnings)).join(' ')}</p>
            )}
          </>
        ) : activeTab === 'generic' ? (
          <>
            <form className="planner-form" onSubmit={handleGenericSubmit}>
              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <p className="section-kicker">Route planner</p>
                    <h2>Route</h2>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={swapGenericRoute}
                    aria-label="Swap start and destination"
                    title="Swap start and destination"
                  >
                    ⇄
                  </button>
                </div>
                <label className="field-label">
                  Start location
                  <input
                    value={genericOriginText}
                    placeholder="Tampines MRT"
                    onChange={(event) => setGenericOriginText(event.target.value)}
                  />
                </label>
                <label className="field-label">
                  Destination
                  <input
                    value={genericDestinationText}
                    placeholder="Marina Bay Sands"
                    onChange={(event) => setGenericDestinationText(event.target.value)}
                  />
                </label>
                <label className="field-label">
                  Arrival time
                  <input
                    type="time"
                    value={genericArrivalTime}
                    onChange={(event) => setGenericArrivalTime(event.target.value)}
                  />
                </label>
                <label className="field-label">
                  Mode of transport
                  <select
                    value={genericProfile}
                    onChange={(event) => setGenericProfile(event.target.value)}
                  >
                    {Object.entries(TRAVEL_PROFILES).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </section>

              <button type="submit" className="primary-button" disabled={genericLoading}>
                {genericLoading ? LOADING_TEXTS[loadingIndex] : 'Calculate Latest Departure'}
              </button>
            </form>

            {genericErrorMessage && <p className="message error">{genericErrorMessage}</p>}
          </>
        ) : (
          <>
            <form className="planner-form" onSubmit={handleConciergeSubmit}>
              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <h2>Emergency type</h2>
                  </div>
                </div>
                <div className="crisis-grid" aria-label="Disaster Concierge crisis modes">
                  {Object.entries(CRISIS_MODES).map(([modeKey, mode]) => (
                    <button
                      key={modeKey}
                      type="button"
                      className={conciergeMode === modeKey ? 'active' : ''}
                      aria-pressed={conciergeMode === modeKey}
                      onClick={() => setConciergeMode(modeKey)}
                    >
                      <strong>{mode.shortLabel}</strong>
                      <span>{mode.keywords.join(' / ')}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <h2>Where are you?</h2>
                  </div>
                </div>
                <label className="field-label">
                  Start location
                  <input
                    value={conciergeStartText}
                    placeholder="Orchard"
                    onChange={(event) => setConciergeStartText(event.target.value)}
                  />
                </label>
              </section>

              <button type="submit" className="primary-button" disabled={conciergeLoading}>
                {conciergeLoading ? LOADING_TEXTS[loadingIndex] : 'Summon Disaster Concierge'}
              </button>
            </form>

            {conciergeErrorMessage && (
              <p className="message error">{conciergeErrorMessage}</p>
            )}
          </>
        )}
      </aside>

      <section
        className={[
          'results-panel',
          (activeTab === 'meetup' && !selectedCandidate) ||
          (activeTab === 'generic' && !genericPlan) ||
          (activeTab === 'concierge' && !selectedConciergeOption)
            ? 'results-panel--empty'
            : '',
          activeTab === 'generic' && genericPlan ? 'results-panel--center-result' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-live="polite"
      >

        {activeTab === 'meetup' && selectedCandidate ? (
          <>
            <div className="best-card">
              <div className="best-card-header">
                <div>
                  <p className="eyebrow">Best current venue</p>
                  <h2>{selectedCandidate.candidate.name}</h2>
                </div>
                <span className="rank-pill">#{selectedCandidate.rank}</span>
              </div>
              <p>{currentExplanation}</p>
              <div className="metric-grid">
                <span>
                  <strong>{formatMinutes(selectedCandidate.meanMinutes)}</strong>
                  average
                </span>
                <span>
                  <strong>{formatMinutes(selectedCandidate.rangeMinutes)}</strong>
                  spread
                </span>
                <span>
                  <strong>{Math.round(selectedCandidate.fairnessScore)}</strong>
                  unfairness
                </span>
              </div>
              {mostSufferingName && (
                <p className="suffering-callout">{mostSufferingName} is suffering most. Be nice.</p>
              )}
              {hasEstimatedRoutes && <p className="estimate-chip">Estimated route times</p>}
            </div>

            <div className="candidate-list">
              <div className="list-heading">
                <h3>Other strong options</h3>
                <span>{plan.candidates.length} checked</span>
              </div>
              {plan.candidates.slice(0, 6).map((candidate) => (
                <button
                  type="button"
                  key={candidate.candidate.id}
                  className={
                    candidate.candidate.id === selectedCandidate.candidate.id
                      ? 'candidate-row active'
                      : 'candidate-row'
                  }
                  onClick={() => handleMeetupCandidateSelect(candidate.candidate.id, 'options-panel')}
                >
                  <span>#{candidate.rank}</span>
                  <strong>{candidate.candidate.name}</strong>
                  <small>
                    {formatMinutes(candidate.meanMinutes)} avg / {formatMinutes(candidate.rangeMinutes)} spread
                  </small>
                </button>
              ))}
            </div>

            <div className="departure-table departure-table--friendship">
              <div className="table-title">
                <h3>When everyone should leave</h3>
                <span>{formatClock(getArrivalDate(arrivalTime))} arrival</span>
              </div>
              <div className="table-head">
                <span>Person</span>
                <span>Responsible</span>
                <span>Bold</span>
                <span>Career-ending</span>
              </div>
              {departureRows.map((row) => (
                <div className="table-row" key={row.participantId}>
                  <span>{getParticipantName(resolvedParticipants, row.participantId)}</span>
                  <span>{formatClock(row.departures.responsible)}</span>
                  <span>{formatClock(row.departures.bold)}</span>
                  <span>{formatClock(row.departures['career-ending'])}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {activeTab === 'meetup' && !selectedCandidate ? (
          <div className="empty-results">
            <p className="eyebrow">Singapore Group Chat Tribunal</p>
            <h2>Where Everyone Loses Equally, But With Reservations</h2>
            <p>
              Add your squad, pick a vibe, and let the algorithm decide who gets mildly inconvenienced
              for the greater good.
            </p>
            <div className="empty-steps">
              <span>1. Add friends who type "omw" at home</span>
              <span>2. Pick a category worthy of group chat debate</span>
              <span>3. Compare departures and assign emotional damages</span>
            </div>
            <div className="map-legend" aria-label="Map legend">
              <span><i className="origin" />Start</span>
              <span><i className="candidate" />Venue</span>
              <span><i className="winner" />Selected</span>
            </div>
          </div>
        ) : null}

        {activeTab === 'generic' && genericPlan && genericDepartures ? (
          <>
            <div className="best-card">
              <div className="best-card-header">
                <div>
                  <p className="eyebrow">Departure options</p>
                  <h2>Pick your acceptable panic</h2>
                </div>
                <span className="rank-pill">{TRAVEL_PROFILES[genericPlan.profile] ?? genericPlan.profile}</span>
              </div>
              <div className="departure-timing-strip" aria-label="Departure timings">
                {DEPARTURE_TIMING_OPTIONS.map((option) => (
                  <span className={`departure-timing ${option.key}`} key={option.key}>
                    <strong>{formatClock(genericDepartures[option.key])}</strong>
                    <em>{option.label}</em>
                    <small>{option.quip}</small>
                  </span>
                ))}
              </div>
              <p>
                Leave from {genericPlan.origin.name} to reach {genericPlan.destination.name} by{' '}
                {formatClock(getArrivalDate(genericArrivalTime))}.
              </p>
              <div className="metric-grid">
                <span>
                  <strong>{formatMinutes(genericPlan.durationMinutes)}</strong>
                  travel time
                </span>
                <span>
                  <strong>{formatDistance(genericPlan.distanceMeters)}</strong>
                  distance
                </span>
                <span>
                  <strong>{TRAVEL_PROFILES[genericPlan.profile] ?? genericPlan.profile}</strong>
                  mode
                </span>
              </div>
            </div>
          </>
        ) : null}

        {activeTab === 'generic' && !genericPlan ? (
          <div className="empty-results">
            <p className="eyebrow">The Procrastination Control Tower</p>
            <h2>Leave Late With the Confidence of Someone Who Has Learned Nothing</h2>
            <p>
              Enter any two places and we will calculate the exact minute you can leave before your
              life choices catch up with you.
            </p>
            <div className="empty-steps route-preview">
              <span>{genericOriginText || 'Start'}</span>
              <span>→</span>
              <span>{genericDestinationText || 'Destination'}</span>
            </div>
            <div className="map-legend" aria-label="Map legend">
              <span><i className="origin" />Start</span>
              <span><i className="candidate" />Venue</span>
              <span><i className="winner" />Selected</span>
            </div>
          </div>
        ) : null}

        {activeTab === 'concierge' && selectedConciergeOption ? (
          <>
            <div className="best-card mission-card">
              <div className="best-card-header">
                <div>
                  <p className="eyebrow">Mission briefing</p>
                  <h2>{selectedConciergeOption.name}</h2>
                </div>
                <span className="rank-pill score-pill">{selectedConciergeOption.score}%</span>
              </div>
              <p>
                {activeConciergeCrisis.briefing} Dispatching from {conciergePlan.origin.name}.
              </p>
              <div className="metric-grid">
                <span>
                  <strong>{selectedConciergeOption.score}%</strong>
                  confidence
                </span>
                <span>
                  <strong>{formatMinutes(selectedConciergeOption.durationMinutes)}</strong>
                  response time
                </span>
                <span>
                  <strong>{formatDistance(selectedConciergeOption.distanceMeters)}</strong>
                  distance
                </span>
              </div>
              {!selectedConciergeOption.routeAvailable && (
                <p className="estimate-chip">Estimated route time</p>
              )}
            </div>

            <div className="candidate-list">
              <div className="list-heading">
                <h3>Alternative rescue points</h3>
                <span>{conciergePlan.options.length} ranked</span>
              </div>
              {conciergePlan.options.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={
                    option.id === selectedConciergeOption.id
                      ? 'candidate-row active'
                      : 'candidate-row'
                  }
                  onClick={() => handleConciergeSelect(option.id, 'options-panel')}
                >
                  <span>{option.rank === 1 ? '!' : option.rank}</span>
                  <strong>{option.name}</strong>
                  <small>
                    {option.score}% confidence / {formatMinutes(option.durationMinutes)}
                  </small>
                </button>
              ))}
            </div>

            <div className="mission-protocol">
              <div className="table-title">
                <h3>{activeConciergeCrisis.shortLabel} protocol</h3>
                <span>{selectedConciergeOption.keywords.join(', ')}</span>
              </div>
              {activeConciergeCrisis.protocols.map((protocol) => (
                <p key={protocol}>{protocol}</p>
              ))}
            </div>
          </>
        ) : null}

        {activeTab === 'concierge' && !selectedConciergeOption ? (
          <div className="empty-results">
            <p className="eyebrow">Disaster Concierge</p>
            <h2>Declare the Crisis. Outsource the Panic.</h2>
            <p>
              Pick a questionable emergency and the concierge will rank nearby rescue points with
              Grab search, route ETAs, and a deeply unserious survival score.
            </p>
            <div className="empty-steps">
              <span>1. Choose a crisis mode</span>
              <span>2. Start from {conciergeStartText || 'somewhere real'}</span>
              <span>3. Follow the least chaotic pin</span>
            </div>
            <div className="map-legend" aria-label="Map legend">
              <span><i className="origin" />Start</span>
              <span><i className="candidate" />Option</span>
              <span><i className="winner" />Best</span>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  )
}

export default App
