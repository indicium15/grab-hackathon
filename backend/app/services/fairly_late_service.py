import asyncio
import logging
import math
from datetime import datetime, time, timedelta
from statistics import pstdev
from typing import Any
from zoneinfo import ZoneInfo

from app.config import settings
from app.services.grabmaps_client import GrabMapsClient

logger = logging.getLogger(__name__)

SINGAPORE_CENTER = {"lat": 1.3521, "lng": 103.8198}
SG_TZ = ZoneInfo("Asia/Singapore")
RISK_BUFFERS = {
    "responsible": 15,
    "bold": 5,
    "career-ending": -2,
}
RISK_COPY = {
    "responsible": "You may remain employed and respected.",
    "bold": "You are trusting the city a little too much.",
    "career-ending": "This is a legal departure time, not a wise one.",
}
FALLBACK_ORIGINS = {
    "tampines mrt": {"name": "Tampines MRT", "lat": 1.3532, "lng": 103.9452},
    "tampines": {"name": "Tampines", "lat": 1.3547, "lng": 103.9437},
    "jurong east": {"name": "Jurong East", "lat": 1.3331, "lng": 103.7423},
    "orchard": {"name": "Orchard", "lat": 1.3048, "lng": 103.8318},
    "one north": {"name": "One North", "lat": 1.2996, "lng": 103.7878},
    "one-north": {"name": "One North", "lat": 1.2996, "lng": 103.7878},
    "clementi": {"name": "Clementi", "lat": 1.3151, "lng": 103.7651},
    "bugis": {"name": "Bugis", "lat": 1.3008, "lng": 103.8558},
    "chinatown": {"name": "Chinatown", "lat": 1.2836, "lng": 103.8435},
}
FALLBACK_VENUES = [
    {"name": "Lau Pa Sat", "business_type": "food_centre", "lat": 1.2806, "lng": 103.8504},
    {"name": "CHIJMES", "business_type": "restaurant", "lat": 1.2950, "lng": 103.8521},
    {"name": "Bugis Junction", "business_type": "mall", "lat": 1.2991, "lng": 103.8558},
    {"name": "Tiong Bahru Market", "business_type": "food_centre", "lat": 1.2851, "lng": 103.8325},
    {"name": "Plaza Singapura", "business_type": "mall", "lat": 1.3007, "lng": 103.8450},
    {"name": "Capitol Singapore", "business_type": "restaurant", "lat": 1.2933, "lng": 103.8518},
    {"name": "Holland Village", "business_type": "restaurant", "lat": 1.3110, "lng": 103.7964},
    {"name": "Raffles City", "business_type": "mall", "lat": 1.2931, "lng": 103.8520},
    {"name": "Great World", "business_type": "mall", "lat": 1.2938, "lng": 103.8319},
]


def _normalize(value: str | None) -> str:
    return (value or "").strip().lower()


def _haversine_km(origin: dict, destination: dict) -> float:
    earth_radius_km = 6371
    lat1 = math.radians(origin["lat"])
    lat2 = math.radians(destination["lat"])
    dlat = lat2 - lat1
    dlng = math.radians(destination["lng"] - origin["lng"])
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    )
    return earth_radius_km * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _place_id(prefix: str, place: dict, index: int) -> str:
    name = _normalize(place.get("name", "place")).replace(" ", "-")[:40] or "place"
    lat = round(float(place.get("lat", 0)), 5)
    lng = round(float(place.get("lng", 0)), 5)
    return f"{prefix}-{index}-{name}-{lat}-{lng}"


def _place_payload(place: dict, place_id: str | None = None) -> dict:
    return {
        "id": place_id or _place_id("place", place, 0),
        "name": place.get("name", "Unknown place"),
        "address": place.get("address"),
        "location": {
            "lat": float(place["lat"]),
            "lng": float(place["lng"]),
        },
        "category": place.get("category") or place.get("category_label"),
        "businessType": place.get("business_type") or place.get("businessType") or "place",
    }


def _dedupe_places(places: list[dict]) -> list[dict]:
    deduped = []
    seen = set()
    for place in places:
        if "lat" not in place or "lng" not in place:
            continue
        key = (
            _normalize(place.get("poi_id") or place.get("id") or place.get("name")),
            round(float(place["lat"]), 4),
            round(float(place["lng"]), 4),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(place)
    return deduped


def _extract_route_number(route: dict, names: list[str]) -> float | None:
    for name in names:
        value = route.get(name)
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    legs = route.get("legs")
    if isinstance(legs, list):
        total = 0.0
        found = False
        for leg in legs:
            if isinstance(leg, dict):
                leg_value = _extract_route_number(leg, names)
                if leg_value:
                    total += leg_value
                    found = True
        if found:
            return total
    return None


def _normalize_route(route: dict, origin: dict, destination: dict) -> dict | None:
    duration = _extract_route_number(
        route,
        ["durationMinutes", "duration_minutes", "duration", "duration_s", "time", "travel_time"],
    )
    distance = _extract_route_number(
        route,
        ["distanceKm", "distance_km", "distance", "distance_m", "length"],
    )
    if duration is None:
        return None
    if duration > 600:
        duration_minutes = duration / 60
    else:
        duration_minutes = duration

    if distance is None:
        distance_km = _haversine_km(origin, destination)
    elif distance > 100:
        distance_km = distance / 1000
    else:
        distance_km = distance

    return {
        "durationMinutes": round(duration_minutes, 1),
        "distanceKm": round(distance_km, 2),
        "geometry": route.get("geometry"),
        "estimatedFallback": False,
    }


def _fallback_route(origin: dict, destination: dict) -> dict:
    distance_km = _haversine_km(origin, destination)
    return {
        "durationMinutes": max(3, round((distance_km / 25) * 60, 1)),
        "distanceKm": round(distance_km, 2),
        "geometry": [
            {"lat": origin["lat"], "lng": origin["lng"]},
            {"lat": destination["lat"], "lng": destination["lng"]},
        ],
        "estimatedFallback": True,
    }


def _parse_arrival_time(value: str) -> tuple[datetime, str | None]:
    clean_value = (value or "19:00").strip()
    parsed_time: time
    try:
        parsed_time = time.fromisoformat(clean_value)
    except ValueError:
        try:
            parsed_time = datetime.strptime(clean_value, "%I:%M %p").time()
        except ValueError:
            parsed_time = time(19, 0)

    now = datetime.now(SG_TZ)
    arrival = datetime.combine(now.date(), parsed_time, SG_TZ)
    if arrival <= now:
        return arrival + timedelta(days=1), "Arrival time had already passed, so deadlines use tomorrow."
    return arrival, None


def _format_departure(value: datetime) -> str:
    return value.isoformat()


def _human_fairness(range_minutes: float) -> str:
    if range_minutes <= 10:
        return "shockingly democratic"
    if range_minutes <= 20:
        return "socially acceptable"
    if range_minutes <= 35:
        return "someone is making a sacrifice"
    return "this friendship has geography problems"


class FairlyLateService:
    def __init__(self, maps_client: GrabMapsClient) -> None:
        self.maps_client = maps_client

    async def plan(
        self,
        participants: list[dict],
        category_keyword: str,
        target_arrival_time: str,
        risk_mode: str,
        mode: str,
    ) -> dict:
        if len(participants) < 2:
            raise ValueError("Add at least two participants before calculating fairness.")

        warnings: list[str] = []
        resolved_participants = await self._resolve_participants(participants, warnings)
        midpoint = {
            "lat": sum(p["origin"]["location"]["lat"] for p in resolved_participants)
            / len(resolved_participants),
            "lng": sum(p["origin"]["location"]["lng"] for p in resolved_participants)
            / len(resolved_participants),
        }
        candidates = await self._find_candidates(category_keyword, midpoint, warnings)
        if len(candidates) < 5:
            warnings.append("Using demo venue estimates because live venue search returned limited results.")
            candidates = _dedupe_places(candidates + FALLBACK_VENUES)

        candidate_payloads = [
            _place_payload(candidate, _place_id("candidate", candidate, index + 1))
            for index, candidate in enumerate(candidates[:15])
        ]
        scored = await self._score_candidates(
            resolved_participants,
            candidate_payloads,
            mode,
            warnings,
        )
        if not scored:
            raise RuntimeError("Could not route any complete candidate set.")

        scored.sort(key=lambda item: item["fairnessScore"])
        for index, item in enumerate(scored):
            item["rank"] = index + 1

        winner = scored[0]
        arrival, arrival_warning = _parse_arrival_time(target_arrival_time)
        if arrival_warning:
            warnings.append(arrival_warning)
        departure_plans = self._build_departure_plans(winner, arrival, risk_mode)
        explanation, most_suffering_id, least_burdened_id = self._explain(
            winner, resolved_participants
        )

        return {
            "participants": resolved_participants,
            "candidates": scored,
            "selectedCandidateId": winner["candidate"]["id"],
            "departurePlans": departure_plans,
            "explanation": explanation,
            "mostSufferingParticipantId": most_suffering_id,
            "leastBurdenedParticipantId": least_burdened_id,
            "midpoint": midpoint,
            "warnings": warnings,
        }

    async def _resolve_participants(self, participants: list[dict], warnings: list[str]) -> list[dict]:
        tasks = [self._resolve_origin(participant, warnings) for participant in participants]
        resolved = await asyncio.gather(*tasks)
        unresolved = [item["name"] for item in resolved if not item.get("origin")]
        if unresolved:
            raise ValueError(f"Could not resolve: {', '.join(unresolved)}.")
        return resolved

    async def _resolve_origin(self, participant: dict, warnings: list[str]) -> dict:
        query = participant["originText"]
        place = None
        if settings.grab_api_key:
            try:
                results = await self.maps_client.fetch_keyword(
                    SINGAPORE_CENTER["lat"],
                    SINGAPORE_CENTER["lng"],
                    query,
                    limit=5,
                )
                place = results[0] if results else None
            except Exception as error:
                logger.warning("Origin search failed for '%s': %s", query, error)

        if place is None:
            place = FALLBACK_ORIGINS.get(_normalize(query))
            if place:
                warnings.append(f"Estimated {participant['name']}'s origin from demo coordinates.")

        return {
            "id": participant["id"],
            "name": participant["name"],
            "originText": query,
            "weight": participant.get("weight", 1),
            "origin": _place_payload(place, f"origin-{participant['id']}") if place else None,
        }

    async def _find_candidates(
        self, category_keyword: str, midpoint: dict, warnings: list[str]
    ) -> list[dict]:
        if not settings.grab_api_key:
            warnings.append("GrabMaps API key missing; using estimated demo venues.")
            return FALLBACK_VENUES

        collected: list[dict] = []
        keyword = category_keyword.strip() or "restaurant"
        try:
            collected.extend(
                await self.maps_client.fetch_keyword(
                    midpoint["lat"], midpoint["lng"], keyword, limit=20
                )
            )
        except Exception as error:
            logger.warning("Keyword venue search failed: %s", error)
            warnings.append("Venue keyword search failed; trying nearby search and demo fallback.")

        for radius in [1000, 3000, 5000]:
            if len(_dedupe_places(collected)) >= 8:
                break
            try:
                collected.extend(
                    await self.maps_client.fetch_nearby(
                        midpoint["lat"], midpoint["lng"], keyword, radius_meters=radius, limit=20
                    )
                )
            except Exception as error:
                logger.warning("Nearby venue search failed radius=%s: %s", radius, error)

        return _dedupe_places(collected)

    async def _score_candidates(
        self,
        participants: list[dict],
        candidates: list[dict],
        mode: str,
        warnings: list[str],
    ) -> list[dict]:
        tasks = [
            self._score_candidate(participants, candidate, mode, warnings)
            for candidate in candidates
        ]
        results = await asyncio.gather(*tasks)
        return [result for result in results if result is not None]

    async def _score_candidate(
        self,
        participants: list[dict],
        candidate: dict,
        mode: str,
        warnings: list[str],
    ) -> dict | None:
        route_tasks = [
            self._route_participant(participant, candidate, mode, warnings)
            for participant in participants
        ]
        routes = await asyncio.gather(*route_tasks)
        if any(route is None for route in routes):
            return None

        durations = [route["durationMinutes"] for route in routes]
        mean = sum(durations) / len(durations)
        max_minutes = max(durations)
        min_minutes = min(durations)
        range_minutes = max_minutes - min_minutes
        std_dev = pstdev(durations) if len(durations) > 1 else 0
        fairness_penalty = range_minutes * 1.2 + std_dev * 1.5
        efficiency_penalty = mean * 0.8
        worst_case_penalty = max_minutes * 0.6
        candidate_boost = -3 if candidate.get("businessType") in {"restaurant", "food_centre"} else 0
        score = fairness_penalty + efficiency_penalty + worst_case_penalty + candidate_boost

        return {
            "candidate": candidate,
            "routes": routes,
            "meanMinutes": round(mean, 1),
            "maxMinutes": round(max_minutes, 1),
            "minMinutes": round(min_minutes, 1),
            "rangeMinutes": round(range_minutes, 1),
            "stdDevMinutes": round(std_dev, 1),
            "fairnessScore": round(score, 1),
            "rank": 0,
        }

    async def _route_participant(
        self,
        participant: dict,
        candidate: dict,
        mode: str,
        warnings: list[str],
    ) -> dict:
        origin = participant["origin"]["location"]
        destination = candidate["location"]
        route_data = None
        if settings.grab_api_key:
            try:
                route = await self.maps_client.fetch_route(
                    [(origin["lng"], origin["lat"]), (destination["lng"], destination["lat"])],
                    "walking" if mode == "walk" else mode,
                )
                route_data = _normalize_route(route, origin, destination)
            except Exception as error:
                logger.warning(
                    "Route failed participant=%s candidate=%s: %s",
                    participant["name"],
                    candidate["name"],
                    error,
                )

        if route_data is None:
            route_data = _fallback_route(origin, destination)
            if len(warnings) < 6:
                warnings.append("Some route times are estimated from distance because live routing was unavailable.")

        return {
            "participantId": participant["id"],
            "candidateId": candidate["id"],
            **route_data,
        }

    def _build_departure_plans(self, winner: dict, arrival: datetime, risk_mode: str) -> list[dict]:
        plans = []
        for route in winner["routes"]:
            departures = {}
            for mode_name, buffer_minutes in RISK_BUFFERS.items():
                leave_at = arrival - timedelta(
                    minutes=route["durationMinutes"] + buffer_minutes
                )
                departures[mode_name] = _format_departure(leave_at)
            plans.append(
                {
                    "participantId": route["participantId"],
                    "durationMinutes": route["durationMinutes"],
                    "responsibleLeaveAt": departures["responsible"],
                    "boldLeaveAt": departures["bold"],
                    "careerEndingLeaveAt": departures["career-ending"],
                    "selectedLeaveAt": departures[risk_mode],
                    "riskCopy": RISK_COPY[risk_mode],
                }
            )
        return plans

    def _explain(self, winner: dict, participants: list[dict]) -> tuple[str, str | None, str | None]:
        participant_by_id = {participant["id"]: participant for participant in participants}
        most_route = max(winner["routes"], key=lambda route: route["durationMinutes"])
        least_route = min(winner["routes"], key=lambda route: route["durationMinutes"])
        most = participant_by_id.get(most_route["participantId"])
        least = participant_by_id.get(least_route["participantId"])
        mood = _human_fairness(winner["rangeMinutes"])
        explanation = (
            f"This is the least unfair option because everyone arrives within a "
            f"{winner['rangeMinutes']:.0f}-minute spread, which is {mood}. "
            f"{most['name']} has the longest trip at {most_route['durationMinutes']:.0f} minutes. "
            f"{least['name']} gets off easy at {least_route['durationMinutes']:.0f} minutes. "
            f"Average travel time is {winner['meanMinutes']:.0f} minutes."
        )
        return explanation, most_route["participantId"], least_route["participantId"]
