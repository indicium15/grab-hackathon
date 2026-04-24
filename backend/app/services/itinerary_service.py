import asyncio
import logging
import math
import random
import re
from typing import Any

from app.config import CANDIDATE_NEIGHBOURHOODS, EXCLUDED_BUSINESS_TYPES, USER_PROFILE
from app.services.grabmaps_client import GrabMapsClient

logger = logging.getLogger(__name__)
MIN_REQUIRED_STOPS = 1
FOOD_AND_DRINK_TYPES = {
    "restaurant",
    "cafe",
    "bar",
    "fast_food",
    "food_and_beverage",
    "food_beverage",
}
FOOD_AND_DRINK_KEYWORDS = {"coffee", "restaurant", "dessert"}


def _normalize(text: str | None) -> str:
    if text is None:
        return ""
    return text.strip().lower()


def _normalize_place_token(value: str | None) -> str:
    if value is None:
        return ""
    normalized = re.sub(r"[^a-z0-9]+", "_", value.strip().lower())
    return normalized.strip("_")


def novelty_filter(places: list[dict], profile: dict) -> list[dict]:
    keywords = [kw.lower() for kw in profile["visitedPOIKeywords"]]
    filtered = []
    for place in places:
        name = place["name"].lower()
        if any(keyword in name for keyword in keywords):
            continue
        filtered.append(place)
    return filtered


def business_type_filter(
    places: list[dict], excluded_business_types: set[str]
) -> tuple[list[dict], list[dict]]:
    kept = []
    excluded = []
    normalized_excluded_types = {_normalize(value) for value in excluded_business_types}

    for place in places:
        business_type = _normalize(place.get("business_type", ""))
        if business_type in normalized_excluded_types:
            excluded.append(place)
            continue
        kept.append(place)

    return kept, excluded


def food_and_drink_filter(places: list[dict]) -> tuple[list[dict], list[dict]]:
    kept = []
    excluded = []
    for place in places:
        business_type = _normalize_place_token(place.get("business_type"))
        category_tokens = {
            _normalize_place_token(token) for token in (place.get("category_tokens") or [])
        }
        if business_type in FOOD_AND_DRINK_TYPES or category_tokens.intersection(
            FOOD_AND_DRINK_TYPES
        ):
            kept.append(place)
            continue
        excluded.append(place)
    return kept, excluded


def _place_identity_key(place: dict) -> tuple[str, float, float]:
    return (
        _normalize(place.get("name", "")),
        round(float(place.get("lat", 0.0)), 6),
        round(float(place.get("lng", 0.0)), 6),
    )


def _pick_unique_place(
    candidates: list[dict], used_place_keys: set[tuple[str, float, float]]
) -> dict | None:
    for candidate in candidates:
        key = _place_identity_key(candidate)
        if key in used_place_keys:
            continue
        used_place_keys.add(key)
        return candidate
    return None


def pick_target_neighbourhood(
    previous_neighbourhood: str | None = None, shuffle: bool = False
) -> dict:
    frequent = {_normalize(name) for name in USER_PROFILE["frequentNeighbourhoods"]}
    available = [
        n for n in CANDIDATE_NEIGHBOURHOODS if _normalize(n["name"]) not in frequent
    ]

    if previous_neighbourhood:
        previous_norm = _normalize(previous_neighbourhood)
        available = [n for n in available if _normalize(n["name"]) != previous_norm] or available

    if not available:
        return CANDIDATE_NEIGHBOURHOODS[0]
    if shuffle:
        return random.choice(available)
    return available[0]


def _haversine_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    earth_radius = 6371000
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlng / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return earth_radius * c


def _distance_label(previous: dict | None, current: dict, mode: str) -> str:
    if previous is None:
        return "Starting point"
    meters = _haversine_meters(previous["lat"], previous["lng"], current["lat"], current["lng"])
    speed = 1.4 if mode == "walking" else 4.3
    minutes = max(1, round((meters / speed) / 60))
    return f"{minutes} min {mode}"


def _dedupe_route_coordinates(stops: list[dict[str, Any]]) -> list[tuple[float, float]]:
    deduped: list[tuple[float, float]] = []
    seen: set[tuple[float, float]] = set()
    for stop in stops:
        key = (round(float(stop["lng"]), 6), round(float(stop["lat"]), 6))
        if key in seen:
            continue
        seen.add(key)
        deduped.append((float(stop["lng"]), float(stop["lat"])))
    return deduped


class ItineraryService:
    def __init__(self, maps_client: GrabMapsClient) -> None:
        self.maps_client = maps_client

    async def generate(
        self, transport_mode: str, neighbourhood_name: str | None = None, shuffle: bool = False
    ) -> dict:
        neighbourhood = self._pick_neighbourhood(neighbourhood_name, shuffle=shuffle)
        warnings: list[str] = []

        categories = [
            ("coffee", "Cafe", 600),
            ("restaurant", "Restaurant", 800),
            ("dessert", "Dessert", 500),
        ]
        if USER_PROFILE["adventureScore"] > 0.6:
            categories.append(("activity", "Activity", 800))

        nearby_results = await asyncio.gather(
            *[
                self.maps_client.fetch_nearby(
                    neighbourhood["lat"], neighbourhood["lng"], keyword, radius
                )
                for keyword, _, radius in categories
            ],
            return_exceptions=True,
        )

        selected_stops: list[dict[str, Any]] = []
        used_place_keys: set[tuple[str, float, float]] = set()
        for index, result in enumerate(nearby_results):
            keyword, label, _ = categories[index]
            if isinstance(result, Exception):
                logger.exception(
                    "Nearby fetch failed for keyword '%s' in neighbourhood '%s'.",
                    keyword,
                    neighbourhood["name"],
                    exc_info=result,
                )
                warnings.append(f"Could not fetch {keyword} suggestions.")
                continue

            logger.info(
                "Nearby results for '%s' in '%s': count=%d sample_names=%s",
                keyword,
                neighbourhood["name"],
                len(result),
                [place.get("name", "Unknown place") for place in result[:3]],
            )

            type_filtered, excluded_by_type = business_type_filter(
                result, EXCLUDED_BUSINESS_TYPES
            )
            if excluded_by_type:
                logger.info(
                    "Excluded by business_type for '%s' in '%s': count=%d samples=%s",
                    keyword,
                    neighbourhood["name"],
                    len(excluded_by_type),
                    [
                        {
                            "name": place.get("name", "Unknown place"),
                            "business_type": place.get("business_type", "unknown"),
                        }
                        for place in excluded_by_type[:3]
                    ],
                )

            filtered_candidates = type_filtered
            if keyword in FOOD_AND_DRINK_KEYWORDS:
                filtered_candidates, excluded_non_food = food_and_drink_filter(type_filtered)
                if excluded_non_food:
                    logger.info(
                        "Excluded non-food matches for '%s' in '%s': count=%d samples=%s",
                        keyword,
                        neighbourhood["name"],
                        len(excluded_non_food),
                        [
                            {
                                "name": place.get("name", "Unknown place"),
                                "business_type": place.get("business_type", "unknown"),
                            }
                            for place in excluded_non_food[:3]
                        ],
                    )

            novelty_filtered = novelty_filter(filtered_candidates, USER_PROFILE)
            chosen = _pick_unique_place(novelty_filtered, used_place_keys)
            is_novel = chosen is not None
            if chosen is None:
                chosen = _pick_unique_place(filtered_candidates, used_place_keys)
            if chosen is None:
                if keyword in FOOD_AND_DRINK_KEYWORDS:
                    warnings.append(
                        f"No nearby {keyword} spots matched the food-and-drink type filters."
                    )
                else:
                    # Fallback: allow excluded business types so sparse neighbourhoods still get suggestions.
                    fallback_novelty = novelty_filter(result, USER_PROFILE)
                    chosen = _pick_unique_place(fallback_novelty, used_place_keys)
                    if chosen is not None:
                        warnings.append(
                            f"Used a broader match for {keyword} due to limited nearby options."
                        )
            if chosen is None and keyword not in FOOD_AND_DRINK_KEYWORDS:
                chosen = _pick_unique_place(result, used_place_keys)
                if chosen is not None:
                    warnings.append(
                        f"Used a broader match for {keyword} due to limited nearby options."
                    )
            if not chosen:
                warnings.append(f"No unique nearby {keyword} spots found.")
                continue

            selected_stops.append(
                {
                    **chosen,
                    "category_label": label,
                    "is_novel": is_novel,
                }
            )

        if len(selected_stops) < MIN_REQUIRED_STOPS:
            logger.warning(
                "Insufficient stops for itinerary in '%s': selected=%d categories=%s",
                neighbourhood["name"],
                len(selected_stops),
                [keyword for keyword, _, _ in categories],
            )
            raise RuntimeError("Insufficient nearby results to build itinerary.")
        if len(selected_stops) < 3:
            warnings.append(
                "Limited nearby matches found for this neighbourhood; showing partial itinerary."
            )

        route_geometry = ""
        if len(selected_stops) >= 2:
            coordinates = _dedupe_route_coordinates(selected_stops)
            if len(coordinates) < 2:
                warnings.append("Selected stops overlap heavily. Showing stops without path.")
            else:
                if len(coordinates) < len(selected_stops):
                    logger.info(
                        "Deduped itinerary route coordinates from %d to %d.",
                        len(selected_stops),
                        len(coordinates),
                    )
                try:
                    route = await self.maps_client.fetch_route(coordinates, transport_mode)
                    route_geometry = route.get("geometry", "")
                except Exception:
                    warnings.append("Route service unavailable. Showing stops without path.")

        stops_payload = []
        previous = None
        for index, stop in enumerate(selected_stops):
            stops_payload.append(
                {
                    "id": f"stop-{index + 1}",
                    "name": stop["name"],
                    "categoryLabel": stop["category_label"],
                    "businessType": stop["business_type"],
                    "lat": stop["lat"],
                    "lng": stop["lng"],
                    "rationale": "",
                    "distanceLabel": _distance_label(previous, stop, transport_mode),
                }
            )
            previous = stop

        return {
            "neighbourhood": neighbourhood,
            "stops": stops_payload,
            "routeGeometry": route_geometry,
            "warnings": warnings,
        }

    def _pick_neighbourhood(self, neighbourhood_name: str | None, shuffle: bool) -> dict:
        if neighbourhood_name:
            requested = _normalize(neighbourhood_name)
            for neighbourhood in CANDIDATE_NEIGHBOURHOODS:
                if _normalize(neighbourhood["name"]) == requested:
                    return neighbourhood
        return pick_target_neighbourhood(shuffle=shuffle)
