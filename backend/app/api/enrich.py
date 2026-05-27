"""Opt-in enrichment endpoints (Overpass re-fetch, Nominatim reverse-geocode).

Both calls go through the backend so the browser never directly contacts external
services. The actual HTTP work lives in app/enrichment/; this module exposes thin
FastAPI surfaces and applies the result to the right placemark by mutating its
annotation row.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.session import get_session
from app.enrichment.nominatim import reverse_geocode
from app.enrichment.overpass import refetch_osm_tags
from app.kml.parse import parse_kml

from .annotations import _verify_source_file
from .schemas import EnrichOSMResponse, ReverseGeocodeResponse

router = APIRouter(prefix="/projects/{project_id}/source-files/{source_file_id}", tags=["enrich"])


@router.post("/placemarks/{index}/refetch-osm", response_model=EnrichOSMResponse)
async def refetch_osm(
    project_id: int,
    source_file_id: int,
    index: int,
    session: Session = Depends(get_session),
) -> EnrichOSMResponse:
    sf = _verify_source_file(session, project_id, source_file_id)
    parsed = parse_kml(sf.raw_kml)
    if index >= len(parsed.placemarks):
        raise HTTPException(status_code=404, detail="placemark index out of range")
    osm_id = parsed.placemarks[index].extended_data.get("@id")
    if not osm_id:
        raise HTTPException(status_code=400, detail="placemark has no @id")
    try:
        tags = await refetch_osm_tags(osm_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Overpass call failed: {exc}") from exc
    return EnrichOSMResponse(tags=tags, fetched_at=datetime.now(UTC))


@router.post("/placemarks/{index}/reverse-geocode", response_model=ReverseGeocodeResponse)
async def reverse_geocode_placemark(
    project_id: int,
    source_file_id: int,
    index: int,
    session: Session = Depends(get_session),
) -> ReverseGeocodeResponse:
    sf = _verify_source_file(session, project_id, source_file_id)
    parsed = parse_kml(sf.raw_kml)
    if index >= len(parsed.placemarks):
        raise HTTPException(status_code=404, detail="placemark index out of range")
    geom = parsed.placemarks[index].geometry
    if geom is None:
        raise HTTPException(status_code=400, detail="placemark has no geometry")
    point = geom.representative_lonlat()
    if point is None:
        raise HTTPException(status_code=400, detail="could not derive a coordinate from placemark")
    lon, lat = point
    try:
        result = await reverse_geocode(lat=lat, lon=lon)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nominatim call failed: {exc}") from exc
    return ReverseGeocodeResponse(
        address=result["address"],
        display_name=result["display_name"],
        fetched_at=datetime.now(UTC),
    )
