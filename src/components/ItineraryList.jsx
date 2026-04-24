const CIRCLE_NUMBERS = ['①', '②', '③', '④']

function ItineraryList({ stops, selectedStopId, onSelectStop }) {
  if (!stops.length) {
    return (
      <section className="itinerary-shell">
        <p className="placeholder">
          Hit <strong>Find My Uncharted</strong> to generate a stretch itinerary.
        </p>
      </section>
    )
  }

  return (
    <section className="itinerary-shell">
      {stops.map((stop, index) => {
        const isSelected = stop.id === selectedStopId

        return (
          <article
            key={stop.id}
            className={`stop-card ${isSelected ? 'selected' : ''}`}
            onClick={() => onSelectStop(stop.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelectStop(stop.id)
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="stop-top">
              <span className="stop-badge">{CIRCLE_NUMBERS[index] ?? `${index + 1}`}</span>
              <div>
                <h3>{stop.name}</h3>
                <span className="stop-tag">{stop.categoryLabel}</span>
              </div>
            </div>
            {stop.rationale ? <p className="stop-rationale">{stop.rationale}</p> : null}
            <p className="stop-distance">{stop.distanceLabel || 'Starting point'}</p>
          </article>
        )
      })}
    </section>
  )
}

export default ItineraryList
