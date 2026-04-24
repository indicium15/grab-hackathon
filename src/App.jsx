import { useEffect, useMemo, useState } from 'react'
import MapPanel from './components/MapPanel.jsx'
import { planFairlyLate } from './services/backendApi.js'
import { fetchDirections, searchPlaces } from './services/grabMapsApi.js'

const RISK_BUFFERS = {
  responsible: 15,
  bold: 5,
  'career-ending': -2,
}

const RISK_LABELS = {
  responsible: 'Responsible',
  bold: 'Bold',
  'career-ending': 'Career-ending',
}

const RISK_OPTIONS = Object.entries(RISK_LABELS)

const WEIGHTS = {
  'can-suffer': 0.75,
  normal: 1,
  vip: 1.35,
}

const LOADING_TEXTS = [
  'Finding places...',
  'Routing everyone...',
  'Calculating emotional damage...',
]

const DEMO_PARTICIPANTS = [
  { id: 'alice', name: 'Alice', originText: 'Tampines', weightLabel: 'normal' },
  { id: 'ben', name: 'Ben', originText: 'Jurong East', weightLabel: 'normal' },
  { id: 'chloe', name: 'Chloe', originText: 'Orchard', weightLabel: 'normal' },
  { id: 'deepak', name: 'Deepak', originText: 'One North', weightLabel: 'normal' },
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
}

const TRAVEL_PROFILES = {
  driving: 'Driving',
  motorcycle: 'Motorcycle',
  tricycle: 'Tricycle',
  cycling: 'Cycling',
  walking: 'Walking',
}

const CATEGORY_SUGGESTIONS = ['restaurant', 'cafe', 'hawker', 'bar']

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

function formatRiskBuffer(risk) {
  const buffer = RISK_BUFFERS[risk] ?? 0
  if (buffer > 0) {
    return `${buffer} min buffer`
  }
  if (buffer < 0) {
    return `${Math.abs(buffer)} min after ideal`
  }
  return 'No buffer'
}

function getInitial(name) {
  return (name.trim().slice(0, 1) || '?').toUpperCase()
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
  const [genericOriginText, setGenericOriginText] = useState('Tampines')
  const [genericDestinationText, setGenericDestinationText] = useState('Marina Bay Sands')
  const [genericArrivalTime, setGenericArrivalTime] = useState('09:00')
  const [genericProfile, setGenericProfile] = useState('driving')
  const [genericPlan, setGenericPlan] = useState(null)
  const [genericLoading, setGenericLoading] = useState(false)
  const [genericErrorMessage, setGenericErrorMessage] = useState('')

  useEffect(() => {
    if (!loading && !genericLoading) {
      return undefined
    }
    const intervalId = window.setInterval(() => {
      setLoadingIndex((index) => (index + 1) % LOADING_TEXTS.length)
    }, 850)
    return () => window.clearInterval(intervalId)
  }, [loading, genericLoading])

  const selectedCandidate = useMemo(() => {
    if (!plan?.candidates?.length) {
      return null
    }
    return (
      plan.candidates.find((candidate) => candidate.candidate.id === selectedCandidateId) ??
      plan.candidates[0]
    )
  }, [plan, selectedCandidateId])

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

  return (
    <main className="fairly-shell">
      <MapPanel
        participants={activeTab === 'meetup' ? resolvedParticipants : []}
        candidates={activeTab === 'meetup' ? plan?.candidates ?? [] : []}
        selectedCandidateId={activeTab === 'meetup' ? selectedCandidate?.candidate.id ?? null : null}
        midpoint={activeTab === 'meetup' ? plan?.midpoint : null}
        loading={activeTab === 'meetup' ? loading : genericLoading}
        loadingMessage={LOADING_TEXTS[loadingIndex]}
        onSelectCandidate={activeTab === 'meetup' ? setSelectedCandidateId : undefined}
        pinsOverride={activeTab === 'generic' ? genericPins : null}
        statusTitle={
          activeTab === 'generic'
            ? genericPlan?.destination?.name ?? 'Generic departure planner'
            : null
        }
        statusDescription={
          activeTab === 'generic'
            ? genericPlan
              ? `Route from ${genericPlan.origin.name} to ${genericPlan.destination.name}`
              : 'Search any two locations and compute how late you can leave.'
            : null
        }
        overlayLabel={
          activeTab === 'generic'
            ? 'Generic route pins'
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
          <p>
            {activeTab === 'meetup'
              ? 'Find the least unfair place to meet, then see exactly how late everyone can leave.'
              : 'Calculate the latest safe departure time between any two places.'}
          </p>
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
                <label className="field-label">
                  Category keyword
                  <input value={categoryKeyword} readOnly aria-readonly="true" />
                </label>
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
                {loading ? LOADING_TEXTS[loadingIndex] : 'Find least unfair meetup'}
              </button>
            </form>

            {errorMessage && <p className="message error">{errorMessage}</p>}
            {plan?.warnings?.length > 0 && (
              <p className="message warning">{Array.from(new Set(plan.warnings)).join(' ')}</p>
            )}
          </>
        ) : (
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
                    placeholder="Tampines"
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
                {genericLoading ? LOADING_TEXTS[loadingIndex] : 'Calculate latest departure'}
              </button>
            </form>

            {genericErrorMessage && <p className="message error">{genericErrorMessage}</p>}
          </>
        )}
      </aside>

      <section className="results-panel" aria-live="polite">
        <div className="results-header">
          <p className="eyebrow">{activeTab === 'meetup' ? 'Decision board' : 'Departure board'}</p>
          <h2>{activeTab === 'meetup' ? 'Latest fair plan' : 'Latest route plan'}</h2>
        </div>

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
                  onClick={() => setSelectedCandidateId(candidate.candidate.id)}
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
            <p className="eyebrow">Ready when Grab is</p>
            <h2>Build a fair meetup plan</h2>
            <p>
              Waiting for ranked venues, fairness metrics, and departure times.
            </p>
            <div className="empty-steps">
              <span>1. Confirm friends</span>
              <span>2. Pick category</span>
              <span>3. Compare departures</span>
            </div>
          </div>
        ) : null}

        {activeTab === 'generic' && genericPlan && genericDepartures ? (
          <>
            <div className="best-card">
              <div className="best-card-header">
                <div>
                  <p className="eyebrow">Departure options</p>
                  <h2>{formatClock(genericDepartures.bold)} bold</h2>
                </div>
                <span className="rank-pill">3 timings</span>
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

            <div className="departure-table">
              <div className="table-title">
                <h3>Departure options</h3>
                <span>{TRAVEL_PROFILES[genericPlan.profile] ?? genericPlan.profile}</span>
              </div>
              <div className="table-head">
                <span>Mode</span>
                <span>Travel</span>
                <span>Responsible</span>
                <span>Bold</span>
                <span>Career-ending</span>
              </div>
              <div className="table-row">
                <span>{TRAVEL_PROFILES[genericPlan.profile] ?? genericPlan.profile}</span>
                <span>{formatMinutes(genericPlan.durationMinutes)}</span>
                <span>{formatClock(genericDepartures.responsible)}</span>
                <span>{formatClock(genericDepartures.bold)}</span>
                <span>{formatClock(genericDepartures['career-ending'])}</span>
              </div>
            </div>
          </>
        ) : null}

        {activeTab === 'generic' && !genericPlan ? (
          <div className="empty-results">
            <p className="eyebrow">Route ready</p>
            <h2>Find your latest departure</h2>
            <p>
              Waiting for a route timing breakdown.
            </p>
            <div className="empty-steps route-preview">
              <span>{genericOriginText || 'Start'}</span>
              <span>→</span>
              <span>{genericDestinationText || 'Destination'}</span>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  )
}

export default App
