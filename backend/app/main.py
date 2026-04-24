import asyncio
import logging
from pathlib import Path
from collections import defaultdict
from time import monotonic
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware

from app.config import USER_PROFILE, settings
from app.schemas import (
    AnotherItineraryRequest,
    ClientConfigResponse,
    FairlyLatePlanRequest,
    FairlyLatePlanResponse,
    ItineraryRequest,
    ItineraryResponse,
    ProfileResponse,
)
from app.services.fairly_late_service import FairlyLateService
from app.services.grabmaps_client import GrabMapsClient
from app.services.itinerary_service import ItineraryService, pick_target_neighbourhood

app = FastAPI(title="Uncharted API", version="0.1.0")
logs_dir = Path(__file__).resolve().parents[1] / "logs"
logs_dir.mkdir(parents=True, exist_ok=True)
log_file = logs_dir / "backend.log"
LOCAL_DEV_ORIGIN_REGEX = r"^http://(localhost|127\.0\.0\.1|\[::1\]):\d+$"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    handlers=[
        logging.FileHandler(log_file, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.allowed_origin],
    allow_origin_regex=LOCAL_DEV_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

maps_client = GrabMapsClient()
service = ItineraryService(maps_client)
fairly_late_service = FairlyLateService(maps_client)
SDK_PROXY_SOURCES = (
    "https://maps.grab.com/developer/assets/js/grabmaps.es.js",
    "https://maps.grab.com/assets/js/grabmaps.es.js",
)
GRABMAPS_ALLOWED_PROXY_HOSTS = {"maps.grab.com"}
GOOGLE_TILE_ALLOWED_PROXY_HOSTS = {
    "mt0.google.com",
    "mt1.google.com",
    "mt2.google.com",
    "mt3.google.com",
}
PROXY_SUMMARY_EVERY_REQUESTS = 250
PROXY_SUMMARY_MIN_INTERVAL_SECONDS = 30.0
proxy_request_counts = defaultdict(int)
proxy_request_total = 0
proxy_summary_last_logged_at = monotonic()

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def normalize_grabmaps_proxy_url(url: str) -> str:
    normalized_url = url.strip()
    if normalized_url.startswith("/http://") or normalized_url.startswith("/https://"):
        normalized_url = normalized_url[1:]

    while True:
        parsed = urlparse(normalized_url)
        nested_url = parse_qs(parsed.query).get("url", [None])[0]
        if (
            parsed.hostname in GRABMAPS_ALLOWED_PROXY_HOSTS
            and parsed.path == "/api/grabmaps/proxy"
            and nested_url
        ):
            normalized_url = nested_url.strip()
            if normalized_url.startswith("/http://") or normalized_url.startswith("/https://"):
                normalized_url = normalized_url[1:]
            continue
        break

    if "://maps.grab.com/maps/" in normalized_url:
        # GrabMaps may emit legacy "/maps/*" asset paths; upstream tile endpoints expect "/api/maps/*".
        normalized_url = normalized_url.replace("://maps.grab.com/maps/", "://maps.grab.com/api/maps/", 1)
    return normalized_url


def classify_grabmaps_asset(path: str) -> str:
    normalized_path = path.lower()
    if normalized_path.endswith(".pbf") or "/tiles/" in normalized_path:
        return "tile"
    if "/api/style.json" in normalized_path:
        return "style"
    if "/api/v1/maps/poi/v1/search" in normalized_path:
        return "search"
    if "/api/v1/maps/place/v2/nearby" in normalized_path:
        return "nearby"
    if "/api/v1/maps/eta/v1/direction" in normalized_path:
        return "directions"
    return "asset"


def log_proxy_summary_if_due() -> None:
    global proxy_summary_last_logged_at

    now = monotonic()
    enough_requests = proxy_request_total % PROXY_SUMMARY_EVERY_REQUESTS == 0
    enough_time_elapsed = (now - proxy_summary_last_logged_at) >= PROXY_SUMMARY_MIN_INTERVAL_SECONDS
    if not enough_requests and not enough_time_elapsed:
        return

    proxy_summary_last_logged_at = now
    summary = ", ".join(
        f"{category}={count}" for category, count in sorted(proxy_request_counts.items())
    )
    logging.getLogger(__name__).info(
        "GrabMaps proxy summary total=%s breakdown=%s",
        proxy_request_total,
        summary or "none",
    )


def get_grabmaps_auth_headers() -> dict[str, str]:
    api_key = settings.grab_api_key.strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="GRAB_API_KEY is missing on the backend; cannot call GrabMaps upstream.",
        )
    return {"Authorization": f"Bearer {api_key}"}


def format_proxy_upstream_error(
    status_code: int | None,
    asset_class: str,
    parsed_url,
    cause: str,
) -> str:
    safe_status = status_code if status_code is not None else "unknown"
    hint = ""
    if status_code in {401, 403}:
        hint = (
            " hint=Verify backend GRAB_API_KEY is valid and has GrabMaps SDK/tile entitlement."
        )
    return (
        f"GrabMaps upstream failed status={safe_status} asset_class={asset_class} "
        f"host={parsed_url.hostname} path={parsed_url.path} cause={cause}{hint}"
    )


def build_google_tile_url(z: int, x: int, y: int) -> str:
    tile_template = settings.google_tiles_url_template.strip()
    if not tile_template:
        raise HTTPException(
            status_code=503,
            detail="GOOGLE_TILES_URL_TEMPLATE is missing on the backend.",
        )
    return (
        tile_template
        .replace("{z}", str(z))
        .replace("{x}", str(x))
        .replace("{y}", str(y))
    )


@app.get("/api/profile", response_model=ProfileResponse)
async def get_profile() -> ProfileResponse:
    return ProfileResponse(profile=USER_PROFILE)


@app.get("/api/client-config", response_model=ClientConfigResponse)
async def get_client_config() -> ClientConfigResponse:
    return ClientConfigResponse(
        tileProvider=settings.tile_provider,
        googleTilesUrlTemplate="/api/tiles/google/{z}/{x}/{y}.png",
        googleTilesAttribution=settings.google_tiles_attribution.strip() or "Google",
    )


@app.post("/api/itinerary/generate", response_model=ItineraryResponse)
async def generate_itinerary(payload: ItineraryRequest) -> ItineraryResponse:
    try:
        data = await service.generate(
            transport_mode=payload.transportMode,
            neighbourhood_name=payload.neighbourhoodName,
            shuffle=False,
        )
        return ItineraryResponse(**data)
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/api/itinerary/another", response_model=ItineraryResponse)
async def another_itinerary(payload: AnotherItineraryRequest) -> ItineraryResponse:
    try:
        next_neighbourhood = pick_target_neighbourhood(
            previous_neighbourhood=payload.previousNeighbourhood,
            shuffle=True,
        )
        data = await service.generate(
            transport_mode=payload.transportMode,
            neighbourhood_name=next_neighbourhood["name"],
        )
        return ItineraryResponse(**data)
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/api/fairly-late/plan", response_model=FairlyLatePlanResponse)
async def plan_fairly_late(payload: FairlyLatePlanRequest) -> FairlyLatePlanResponse:
    try:
        data = await fairly_late_service.plan(
            participants=[participant.model_dump() for participant in payload.participants],
            category_keyword=payload.categoryKeyword,
            target_arrival_time=payload.targetArrivalTime,
            risk_mode=payload.riskMode,
            mode=payload.mode,
        )
        return FairlyLatePlanResponse(**data)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.get("/api/grabmaps/sdk")
async def get_grabmaps_sdk() -> Response:
    headers = get_grabmaps_auth_headers()
    last_error = None

    for sdk_url in SDK_PROXY_SOURCES:
        try:
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
                upstream = await client.get(sdk_url, headers=headers)
                upstream.raise_for_status()
                return Response(
                    content=upstream.content,
                    media_type="application/javascript",
                    headers={
                        "Cache-Control": "public, max-age=300",
                    },
                )
        except Exception as error:  # pragma: no cover - defensive proxy fallback
            last_error = error
            logging.getLogger(__name__).warning(
                "GrabMaps SDK proxy failed for %s: %s",
                sdk_url,
                error,
            )

    raise HTTPException(
        status_code=502,
        detail=f"Unable to fetch GrabMaps SDK from upstream sources. Last error: {last_error}",
    )


@app.get("/api/grabmaps/proxy")
async def proxy_grabmaps_asset(url: str) -> Response:
    global proxy_request_total

    normalized_url = normalize_grabmaps_proxy_url(url)

    parsed = urlparse(normalized_url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Invalid URL scheme for proxy request.")
    if parsed.hostname not in GRABMAPS_ALLOWED_PROXY_HOSTS:
        raise HTTPException(status_code=400, detail="Proxy host is not allowed.")

    headers = get_grabmaps_auth_headers()
    transient_statuses = {429, 500, 502, 503, 504}
    asset_class = classify_grabmaps_asset(parsed.path)
    max_attempts = 3
    upstream = None
    last_error = None

    proxy_request_total += 1
    proxy_request_counts[asset_class] += 1
    log_proxy_summary_if_due()

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        for attempt in range(1, max_attempts + 1):
            try:
                upstream = await client.get(normalized_url, headers=headers)
                if upstream.status_code in transient_statuses and attempt < max_attempts:
                    logging.getLogger(__name__).warning(
                        "GrabMaps proxy transient upstream status=%s attempt=%s/%s url=%s",
                        upstream.status_code,
                        attempt,
                        max_attempts,
                        normalized_url,
                    )
                    await asyncio.sleep(0.15 * attempt)
                    continue
                upstream.raise_for_status()
                break
            except httpx.HTTPStatusError as error:
                last_error = error
                status = error.response.status_code if error.response else None
                if status in transient_statuses and attempt < max_attempts:
                    logging.getLogger(__name__).warning(
                        "GrabMaps proxy retrying after upstream HTTP %s attempt=%s/%s url=%s",
                        status,
                        attempt,
                        max_attempts,
                        normalized_url,
                    )
                    await asyncio.sleep(0.15 * attempt)
                    continue
                raise HTTPException(
                    status_code=status or 502,
                    detail=format_proxy_upstream_error(
                        status,
                        asset_class,
                        parsed,
                        str(error),
                    ),
                ) from error
            except Exception as error:
                last_error = error
                if attempt < max_attempts:
                    logging.getLogger(__name__).warning(
                        "GrabMaps proxy network retry attempt=%s/%s url=%s error=%s",
                        attempt,
                        max_attempts,
                        normalized_url,
                        error,
                    )
                    await asyncio.sleep(0.15 * attempt)
                    continue
                raise HTTPException(
                    status_code=502,
                    detail=format_proxy_upstream_error(
                        None,
                        asset_class,
                        parsed,
                        str(error),
                    ),
                ) from error

    if upstream is None:
        raise HTTPException(
            status_code=502,
            detail=format_proxy_upstream_error(
                None,
                asset_class,
                parsed,
                f"failed after retries: {last_error}",
            ),
        )

    content_type = upstream.headers.get("content-type", "application/octet-stream")
    proxy_headers = {
        "Cache-Control": upstream.headers.get("cache-control", "public, max-age=300"),
    }
    if upstream.headers.get("etag"):
        proxy_headers["ETag"] = upstream.headers["etag"]

    return Response(
        content=upstream.content,
        media_type=content_type.split(";")[0],
        headers=proxy_headers,
    )


@app.get("/api/tiles/google/{z}/{x}/{y}.png")
async def proxy_google_tile(z: int, x: int, y: int) -> Response:
    upstream_url = build_google_tile_url(z, x, y)
    parsed = urlparse(upstream_url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=500, detail="Invalid Google tile URL configuration.")
    if parsed.hostname not in GOOGLE_TILE_ALLOWED_PROXY_HOSTS:
        raise HTTPException(status_code=500, detail="Google tile host is not allowed.")

    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            upstream = await client.get(upstream_url)
            upstream.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise HTTPException(
            status_code=error.response.status_code,
            detail=f"Google tile upstream returned HTTP {error.response.status_code}.",
        ) from error
    except Exception as error:  # pragma: no cover - defensive proxy fallback
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch Google tile upstream: {error}",
        ) from error

    content_type_header = upstream.headers.get("content-type", "")
    content_type = content_type_header.split(";", 1)[0].strip().lower()
    content_length = upstream.headers.get("content-length", str(len(upstream.content)))
    logging.debug(
        "Google tile upstream response z=%s x=%s y=%s status=%s content_type=%s content_length=%s",
        z,
        x,
        y,
        upstream.status_code,
        content_type_header or "<missing>",
        content_length,
    )
    if not content_type.startswith("image/"):
        logging.warning(
            "Rejecting non-image Google tile response z=%s x=%s y=%s status=%s content_type=%s content_length=%s url=%s",
            z,
            x,
            y,
            upstream.status_code,
            content_type_header or "<missing>",
            content_length,
            upstream_url,
        )
        raise HTTPException(
            status_code=502,
            detail="Google tile upstream returned non-image content.",
        )

    proxy_headers = {
        "Cache-Control": upstream.headers.get("cache-control", "public, max-age=300"),
    }
    if upstream.headers.get("etag"):
        proxy_headers["ETag"] = upstream.headers["etag"]

    return Response(
        content=upstream.content,
        media_type=content_type,
        headers=proxy_headers,
    )
