from typing import Literal

from pydantic import BaseModel, Field


TransportMode = Literal["walking", "cycling"]
FairlyLateRiskMode = Literal["responsible", "bold", "career-ending"]
FairlyLateTransportMode = Literal["drive", "walk", "two_wheeler", "transit"]


class Neighbourhood(BaseModel):
    name: str
    lat: float
    lng: float


class Stop(BaseModel):
    id: str
    name: str
    categoryLabel: str
    businessType: str
    lat: float
    lng: float
    rationale: str = ""
    distanceLabel: str


class ItineraryRequest(BaseModel):
    transportMode: TransportMode = "walking"
    neighbourhoodName: str | None = None


class AnotherItineraryRequest(BaseModel):
    transportMode: TransportMode = "walking"
    previousNeighbourhood: str | None = None


class ItineraryResponse(BaseModel):
    neighbourhood: Neighbourhood
    stops: list[Stop]
    routeGeometry: str = ""
    warnings: list[str] = Field(default_factory=list)


class ProfileResponse(BaseModel):
    profile: dict


class ClientConfigResponse(BaseModel):
    tileProvider: Literal["grab", "google"]
    googleTilesUrlTemplate: str
    googleTilesAttribution: str


class FairlyLateParticipantRequest(BaseModel):
    id: str
    name: str
    originText: str
    weight: float = 1


class FairlyLatePlanRequest(BaseModel):
    participants: list[FairlyLateParticipantRequest]
    categoryKeyword: str = "restaurant"
    targetArrivalTime: str = "19:00"
    riskMode: FairlyLateRiskMode = "bold"
    mode: FairlyLateTransportMode = "drive"


class FairlyLatePlanResponse(BaseModel):
    participants: list[dict]
    candidates: list[dict]
    selectedCandidateId: str
    departurePlans: list[dict]
    explanation: str
    mostSufferingParticipantId: str | None = None
    leastBurdenedParticipantId: str | None = None
    midpoint: dict
    warnings: list[str] = Field(default_factory=list)
