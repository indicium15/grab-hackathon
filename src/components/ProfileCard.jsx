import { useState } from 'react'

function asList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function ProfileCard({ profile, onProfileChange }) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(profile)

  function handleSave() {
    onProfileChange({
      ...profile,
      name: draft.name.trim() || profile.name,
      homeArea: {
        ...profile.homeArea,
        name: draft.homeArea.name.trim() || profile.homeArea.name,
      },
      frequentNeighbourhoods: draft.frequentNeighbourhoods,
      preferredCuisines: draft.preferredCuisines,
      visitedPOIKeywords: draft.visitedPOIKeywords,
    })
    setIsEditing(false)
  }

  function handleToggleEdit() {
    if (isEditing) {
      setIsEditing(false)
      return
    }

    setDraft(profile)
    setIsEditing(true)
  }

  return (
    <section className="profile-card">
      <div className="profile-header">
        <div className="avatar-circle">{profile.name[0]}</div>
        <div>
          <p className="eyebrow">Mock Grab Profile</p>
          <h2>{profile.name}</h2>
          <p className="subtle">Home base: {profile.homeArea.name}</p>
        </div>
        <button
          type="button"
          className="profile-edit-toggle"
          onClick={handleToggleEdit}
        >
          {isEditing ? 'Close' : 'Edit'}
        </button>
      </div>

      {isEditing ? (
        <div className="profile-editor">
          <label className="editor-field">
            Name
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          <label className="editor-field">
            Home area
            <input
              value={draft.homeArea.name}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  homeArea: { ...draft.homeArea, name: event.target.value },
                })
              }
            />
          </label>

          <label className="editor-field">
            Comfort zones (comma-separated)
            <input
              value={draft.frequentNeighbourhoods.join(', ')}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  frequentNeighbourhoods: asList(event.target.value),
                })
              }
            />
          </label>

          <label className="editor-field">
            Preferred cuisines (comma-separated)
            <input
              value={draft.preferredCuisines.join(', ')}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  preferredCuisines: asList(event.target.value),
                })
              }
            />
          </label>

          <label className="editor-field">
            Already visited keywords (comma-separated)
            <input
              value={draft.visitedPOIKeywords.join(', ')}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  visitedPOIKeywords: asList(event.target.value),
                })
              }
            />
          </label>

          <div className="profile-editor-actions">
            <button type="button" className="editor-action save" onClick={handleSave}>
              Save profile
            </button>
            <button
              type="button"
              className="editor-action cancel"
              onClick={() => {
                setDraft(profile)
                setIsEditing(false)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="profile-section">
            <p className="label">Comfort zone areas</p>
            <div className="tag-wrap">
              {profile.frequentNeighbourhoods.map((place) => (
                <span key={place} className="tag">
                  {place}
                </span>
              ))}
            </div>
          </div>

          <div className="profile-section">
            <p className="label">Usually eats</p>
            <div className="tag-wrap">
              {profile.preferredCuisines.map((cuisine) => (
                <span key={cuisine} className="tag tag-cuisine">
                  {cuisine}
                </span>
              ))}
            </div>
          </div>

        </>
      )}

      {!isEditing && (
        <div className="profile-section">
          <p className="label">Visited keywords</p>
          <div className="tag-wrap">
            {profile.visitedPOIKeywords.map((keyword) => (
              <span key={keyword} className="tag">
                {keyword}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

export default ProfileCard
