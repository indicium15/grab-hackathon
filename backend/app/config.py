from typing import Literal

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    grab_api_key: str = ""
    anthropic_api_key: str = ""
    grab_base_url: str = "https://maps.grab.com"
    grab_search_mode: str = "keyword"
    grab_country_code: str = "SGP"
    anthropic_base_url: str = "https://api.anthropic.com/v1"
    allowed_origin: str = "http://localhost:5173"
    tile_provider: Literal["grab", "google"] = "google"
    google_tiles_url_template: str = "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}"
    google_tiles_attribution: str = "Google"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


class LatLng(BaseModel):
    name: str
    lat: float
    lng: float


USER_PROFILE = {
    "name": "Chaitanya",
    "homeArea": {"name": "Clementi", "lat": 1.3162, "lng": 103.7649},
    "frequentNeighbourhoods": ["Orchard", "Bugis", "one-north"],
    "visitedPOIKeywords": ["Japanese", "ramen", "sushi", "bubble tea", "Starbucks"],
    "preferredCuisines": ["Japanese", "Western"],
    "adventureScore": 0.7,
}

EXCLUDED_BUSINESS_TYPES = {
    "bank",
    "commercial building",
    "residential",
    "shopping mall/shops",
    "utilities",
}


CANDIDATE_NEIGHBOURHOODS = [
    {"name": "Tiong Bahru", "lat": 1.2865410007860378, "lng": 103.8271198473584},
    {"name": "Joo Chiat", "lat": 1.3059, "lng": 103.9022},
    {"name": "Kampong Glam", "lat": 1.303555475372452, "lng": 103.86072100541254},
    {"name": "Geylang", "lat": 1.3198903900098864, "lng": 103.891582548347},
    {"name": "Tanjong Pagar", "lat": 1.2778234962666686, "lng": 103.84216815594849},
    {"name": "Katong", "lat": 1.3056374137526792, "lng": 103.90371722365376},
    {"name": "Chinatown", "lat": 1.2812699094864066, "lng": 103.84450924430693},
    {"name": "Little India", "lat": 1.3074796986801194, "lng": 103.85179263121103},
]


settings = Settings()
