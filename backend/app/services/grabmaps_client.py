import httpx
import logging
import re

from app.config import settings

logger = logging.getLogger(__name__)


def _normalize_place_token(value: str | None) -> str:
    if value is None:
        return ""
    normalized = re.sub(r"[^a-z0-9]+", "_", value.strip().lower())
    return normalized.strip("_")


class GrabMapsClient:
    def __init__(self) -> None:
        self._headers = {"Authorization": f"Bearer {settings.grab_api_key}"}
        self._base_url = settings.grab_base_url.rstrip("/")

    async def fetch_nearby(
        self, lat: float, lng: float, keyword: str, radius_meters: int, limit: int = 20
    ) -> list[dict]:
        if settings.grab_search_mode.strip().lower() == "keyword":
            return await self.fetch_keyword(lat, lng, keyword, limit=limit)

        params = {
            "location": f"{lat},{lng}",
            "keyword": keyword,
            "radius": f"{radius_meters / 1000:.3f}",
            "limit": limit,
            "rankBy": "popularity",
        }
        data = await self._get_json("/api/v1/maps/place/v2/nearby", params)
        results = self._extract_places(data)
        logger.info(
            "Nearby API response keyword='%s' radius_km=%s extracted_count=%d payload_keys=%s",
            keyword,
            params["radius"],
            len(results),
            sorted(data.keys()) if isinstance(data, dict) else [],
        )
        if results:
            return results

        retry_params = {**params, "radius": f"{(radius_meters * 2) / 1000:.3f}"}
        retry_data = await self._get_json("/api/v1/maps/place/v2/nearby", retry_params)
        retry_results = self._extract_places(retry_data)
        logger.info(
            "Nearby API retry keyword='%s' radius_km=%s extracted_count=%d payload_keys=%s",
            keyword,
            retry_params["radius"],
            len(retry_results),
            sorted(retry_data.keys()) if isinstance(retry_data, dict) else [],
        )
        return retry_results

    async def fetch_keyword(
        self, lat: float, lng: float, keyword: str, limit: int = 20
    ) -> list[dict]:
        params = {
            "keyword": keyword,
            "country": settings.grab_country_code,
            "location": f"{lat},{lng}",
            "limit": limit,
        }
        data = await self._get_json("/api/v1/maps/poi/v1/search", params)
        results = self._extract_places(data)
        logger.info(
            "Keyword API response keyword='%s' country='%s' extracted_count=%d payload_keys=%s",
            keyword,
            settings.grab_country_code,
            len(results),
            sorted(data.keys()) if isinstance(data, dict) else [],
        )
        return results

    async def fetch_route(self, coordinates: list[tuple[float, float]], mode: str) -> dict:
        params: list[tuple[str, str]] = [("profile", mode), ("overview", "full")]
        for lng, lat in coordinates:
            params.append(("coordinates", f"{lng},{lat}"))

        data = await self._get_json("/api/v1/maps/eta/v1/direction", params)
        routes = data.get("routes", []) if isinstance(data, dict) else []
        return routes[0] if routes else {}

    async def _get_json(self, path: str, params: dict | list[tuple[str, str]]) -> dict:
        if not settings.grab_api_key:
            raise RuntimeError("GRAB_API_KEY is missing.")

        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                f"{self._base_url}{path}",
                params=params,
                headers=self._headers,
            )
            response.raise_for_status()
            return response.json()

    def _extract_places(self, payload: dict) -> list[dict]:
        if not isinstance(payload, dict):
            return []

        candidates = payload.get("places") or payload.get("results")
        if candidates is None and isinstance(payload.get("data"), dict):
            candidates = payload["data"].get("places") or payload["data"].get("results")
        if not isinstance(candidates, list):
            return []

        logger.info(
            "Nearby payload status=%s raw_candidates=%d",
            payload.get("status", "unknown"),
            len(candidates),
        )
        normalized = []
        dropped_missing_coordinates = 0
        for item in candidates:
            if not isinstance(item, dict):
                continue

            location = item.get("location") or item.get("coordinate") or {}
            lat = (
                location.get("lat")
                or location.get("latitude")
                or location.get("y")
                or item.get("lat")
                or item.get("latitude")
            )
            lng = (
                location.get("lng")
                or location.get("lon")
                or location.get("long")
                or location.get("longitude")
                or location.get("x")
                or item.get("lng")
                or item.get("lon")
                or item.get("longitude")
            )
            if lat is None or lng is None:
                dropped_missing_coordinates += 1
                continue

            normalized.append(
                {
                    "name": item.get("name", "Unknown place"),
                    "business_type": item.get("business_type")
                    or item.get("businessType")
                    or "place",
                    "category_tokens": [
                        _normalize_place_token(category.get("category_name"))
                        for category in (item.get("categories") or [])
                        if isinstance(category, dict)
                    ],
                    "lat": float(lat),
                    "lng": float(lng),
                }
            )

        if candidates and normalized:
            sample_item = candidates[0]
            sample_places = normalized[:3]
            logger.info(
                "Nearby parsing success normalized=%d dropped_missing_coordinates=%d sample_keys=%s sample_places=%s",
                len(normalized),
                dropped_missing_coordinates,
                sorted(sample_item.keys()) if isinstance(sample_item, dict) else [],
                [
                    {
                        "name": place.get("name", "Unknown place"),
                        "business_type": place.get("business_type", "unknown"),
                    }
                    for place in sample_places
                ],
            )
        elif candidates:
            sample_item = candidates[0]
            sample_location = sample_item.get("location", {}) if isinstance(sample_item, dict) else {}
            logger.warning(
                "Nearby parsing dropped all candidates=%d sample_keys=%s sample_location_keys=%s",
                len(candidates),
                sorted(sample_item.keys()) if isinstance(sample_item, dict) else [],
                sorted(sample_location.keys()) if isinstance(sample_location, dict) else [],
            )
        return normalized
