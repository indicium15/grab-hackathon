# Friendship Damage Control

Friendship Damage Control is a GrabMaps hackathon app for group meetup planning. It finds the least unfair place for a group to meet, ranks candidate venues by collective travel pain, and tells each person the latest they can leave for a shared arrival time.

## Stack

- Frontend: React + Vite
- Backend: FastAPI + `uv`
- Maps: Backend-toggled tile provider (`grab` or `google`), with GrabMaps SDK kept for rollback
- Mobility: GrabMaps place search and route ETA, with a clearly marked haversine fallback for demos

## Core Flow

1. Add at least two friends and their starting locations.
2. Choose a meetup category, target arrival time, and lateness risk.
3. Click **Find least unfair meetup**.
4. Review the winning venue, ranked alternatives, travel spread, most burdened friend, and departure deadlines.

## Environment Setup

Frontend `.env`:

```bash
VITE_BACKEND_BASE_URL=http://localhost:8000
# Optional: override SDK proxy endpoint.
# VITE_GRAB_SDK_URL=http://localhost:8000/api/grabmaps/sdk
# Optional: override map asset proxy prefix (must include the ?url= key).
# VITE_GRAB_CORS_PROXY_URL=http://localhost:8000/api/grabmaps/proxy?url=
# Optional: only needed for direct browser-side GrabMaps API calls in the generic tab.
# VITE_GRAB_API_KEY=your_grabmaps_key
```

Backend `backend/.env`:

```bash
GRAB_API_KEY=your_grabmaps_key
GRAB_BASE_URL=https://maps.grab.com
GRAB_COUNTRY_CODE=SGP
ALLOWED_ORIGIN=http://localhost:5173
TILE_PROVIDER=google
# Optional: upstream template used by /api/tiles/google/{z}/{x}/{y}.png
# GOOGLE_TILES_URL_TEMPLATE=https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}
# Optional: attribution string sent to the frontend map style
# GOOGLE_TILES_ATTRIBUTION=Google
```

Notes:
- `GET /api/client-config` is the backend source of truth for tile provider selection.
- `TILE_PROVIDER=google` uses backend Google tile proxying at `GET /api/tiles/google/{z}/{x}/{y}.png`.
- `TILE_PROVIDER=grab` preserves the original Grab SDK + `GET /api/grabmaps/proxy` path.
- `GRAB_API_KEY` is still required whenever `TILE_PROVIDER=grab`.
- If proxy responses return 401/403, verify that backend `GRAB_API_KEY` is valid and has tile/SDK entitlement.

## Run Locally

Frontend:

```bash
npm install
npm run dev
```

Backend:

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

## Demo Defaults

- Alice: Tampines
- Ben: Jurong East
- Chloe: Orchard
- Deepak: One North
- Category: restaurant
- Arrival: 7:00 PM
- Risk: Bold

## API

The frontend calls:

```txt
POST /api/fairly-late/plan
```

The route composes the existing backend GrabMaps client methods for origin search, candidate venue search, and route ETA. If live routing or search is unavailable, the service returns estimated demo data and the UI labels those route times as estimated.
