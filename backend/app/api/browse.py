"""Browse-mode router.

Browse mode is a separate destination from the normal project workflow. An
investigator scopes a bbox on the map, this router returns:

* :http:post:`/api/browse/inventory` — per-domain summary of every feature in
  the bbox (Amenities, Buildings, Landuse, Historic, Military, Highways,
  Natural, Manmade, Other). Above the area cap the response degrades to
  counts-only.
* :http:get:`/api/browse/items` — paginated list of features for one
  ``key=value`` scope within the bbox.
* :http:get:`/api/browse/item` — full detail (geometry + wiki links) for one
  OSM element id.
* :http:post:`/api/browse/bake` — handoff back into project workflow. Bakes
  either a single feature or a whole bbox+QL query into a SourceFile on the
  destination project (creating the project if ``project_id`` is None).

Every endpoint that touches Overpass is opt-in (per the privacy contract — the
investigator clicked something to get here) and rate-limited via the shared
lock in :mod:`app.enrichment.overpass`. Results are cached on disk for 24h.

This router is intentionally **not registered in ``main.py``** — the
integrator wires it in once all parallel A-phase agents have landed.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.projects import (
    _ingest_kml_bytes,
    _load_project,
    _substitute_bbox,
)
from app.api.schemas import SourceFileSummary
from app.db.models import Project
from app.db.session import get_session
from app.enrichment import area_inventory, overpass
from app.kml.from_overpass import synthesize_kml

router = APIRouter(prefix="/browse", tags=["browse"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class _BBox(BaseModel):
    """Tiny wrapper around the WSEN tuple so error messages talk about bbox."""

    bbox: list[float] = Field(
        ..., min_length=4, max_length=4,
        description="[west, south, east, north] in EPSG:4326 degrees.",
    )


class DomainTopTag(BaseModel):
    key: str
    value: str
    count: int


class DomainSummary(BaseModel):
    name: str
    count: int
    top_tags: list[DomainTopTag] = Field(default_factory=list)


class InventorySummary(BaseModel):
    bbox: list[float]
    total_count: int


class InventoryResponse(BaseModel):
    """Domain-partitioned summary of an Overpass bbox query.

    ``area_capped`` is True when the bbox exceeded the size cap and Overpass
    was queried for counts only. In that mode ``domain_counts`` is populated
    and ``domains`` is omitted; in the normal mode it's the other way round.
    """

    area_capped: bool
    area_km2: float
    area_cap_km2: float
    total_count: int
    summary: InventorySummary | None = None
    domains: list[DomainSummary] | None = None
    domain_counts: dict[str, int] | None = None


class ItemSummary(BaseModel):
    """One row in the domain drill-down list."""

    osm_id: str
    name: str | None
    tags: dict[str, str]
    geometry_kind: str
    center: list[float] | None


class ItemsResponse(BaseModel):
    items: list[ItemSummary]
    has_more: bool
    next_offset: int
    total: int


class WikiLink(BaseModel):
    kind: str
    label: str
    url: str


class FeatureGeometry(BaseModel):
    """Loose geometry payload — shape depends on element kind."""

    kind: str
    point: list[float] | None = None
    coordinates: list[list[float]] | None = None
    members: list[dict] | None = None


class FeatureDetail(BaseModel):
    osm_id: str
    name: str | None
    tags: dict[str, str]
    geometry: FeatureGeometry
    wiki_links: list[WikiLink]


class BakeRequest(BaseModel):
    """One of three modes:

    * ``single_osm_id`` set — fetch + bake just that feature.
    * ``bbox`` and ``query`` set — run the QL against the bbox and bake the result.
    * Else 400.

    ``project_id`` is optional — when None we mint a fresh project named
    ``name`` (or a date-stamped fallback).
    """

    project_id: int | None = None
    name: str | None = None
    bbox: list[float] | None = None
    query: str | None = None
    single_osm_id: str | None = None


class BakeResponse(BaseModel):
    project_id: int
    source_file: SourceFileSummary


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _bbox_tuple(bbox: list[float]) -> tuple[float, float, float, float]:
    if len(bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox must be [west, south, east, north]")
    west, south, east, north = bbox
    return float(west), float(south), float(east), float(north)


def _parse_bbox_query(raw: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise HTTPException(
            status_code=400,
            detail="bbox query param must be 'west,south,east,north'",
        )
    try:
        return tuple(float(p) for p in parts)  # type: ignore[return-value]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"invalid bbox: {exc}") from exc


def _domain_summary_to_schema(d: dict) -> DomainSummary:
    return DomainSummary(
        name=d["name"],
        count=int(d["count"]),
        top_tags=[
            DomainTopTag(key=t["key"], value=t["value"], count=int(t["count"]))
            for t in d.get("top_tags") or []
        ],
    )


def _ensure_project(
    db: Session,
    *,
    project_id: int | None,
    name: str | None,
) -> Project:
    """Either load ``project_id`` or mint a fresh Browse-mode project."""
    if project_id is not None:
        return _load_project(db, project_id)
    project_name = name or f"Browse — {date.today().isoformat()}"
    proj = Project(name=project_name)
    db.add(proj)
    db.flush()
    return _load_project(db, proj.id)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/inventory", response_model=InventoryResponse)
async def post_inventory(req: _BBox) -> InventoryResponse:
    """Return the per-domain summary of an OSM bbox.

    Cached on disk for 24h. May return ``area_capped=True`` if the bbox
    exceeds the area cap — in that mode only counts are returned.
    """
    bbox = _bbox_tuple(req.bbox)
    try:
        result = await area_inventory.fetch_area_summary(bbox)
    except overpass.OverpassError as exc:
        raise HTTPException(status_code=502, detail=f"Overpass call failed: {exc}") from exc

    if result.get("area_capped"):
        return InventoryResponse(
            area_capped=True,
            area_km2=float(result.get("area_km2", 0.0)),
            area_cap_km2=float(result.get("area_cap_km2", 0.0)),
            total_count=int(result.get("total_count", 0)),
            domain_counts={k: int(v) for k, v in (result.get("domain_counts") or {}).items()},
        )

    return InventoryResponse(
        area_capped=False,
        area_km2=float(result.get("area_km2", 0.0)),
        area_cap_km2=float(result.get("area_cap_km2", 0.0)),
        total_count=int(result.get("total_count", 0)),
        summary=InventorySummary(
            bbox=list(result["summary"]["bbox"]),
            total_count=int(result["summary"]["total_count"]),
        ),
        domains=[_domain_summary_to_schema(d) for d in result.get("domains") or []],
    )


@router.get("/items", response_model=ItemsResponse)
async def get_items(
    bbox: str = Query(..., description="west,south,east,north"),
    key: str = Query(..., min_length=1),
    value: str = Query(..., min_length=1),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> ItemsResponse:
    """Drill into one ``key=value`` scope inside the bbox. Offset-paginated."""
    bbox_t = _parse_bbox_query(bbox)
    try:
        result = await area_inventory.fetch_domain_items(
            bbox_t, key, value, limit=limit, offset=offset
        )
    except overpass.OverpassError as exc:
        raise HTTPException(status_code=502, detail=f"Overpass call failed: {exc}") from exc
    return ItemsResponse(
        items=[ItemSummary(**it) for it in result["items"]],
        has_more=bool(result["has_more"]),
        next_offset=int(result["next_offset"]),
        total=int(result["total"]),
    )


@router.get("/item", response_model=FeatureDetail)
async def get_item(
    osm_id: str = Query(..., description="e.g. 'node/123', 'way/456', 'relation/789'"),
) -> FeatureDetail:
    """Full detail for one OSM element — geometry + tags + derived wiki links."""
    try:
        result = await area_inventory.fetch_single_feature(osm_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except overpass.OverpassError as exc:
        raise HTTPException(status_code=502, detail=f"Overpass call failed: {exc}") from exc

    geom_payload = result.get("geometry") or {}
    return FeatureDetail(
        osm_id=result["osm_id"],
        name=result.get("name"),
        tags={str(k): str(v) for k, v in (result.get("tags") or {}).items()},
        geometry=FeatureGeometry(
            kind=str(geom_payload.get("kind", "Unknown")),
            point=geom_payload.get("point"),
            coordinates=geom_payload.get("coordinates"),
            members=geom_payload.get("members"),
        ),
        wiki_links=[WikiLink(**link) for link in result.get("wiki_links") or []],
    )


@router.post("/bake", response_model=BakeResponse, status_code=201)
async def post_bake(
    req: BakeRequest,
    db: Session = Depends(get_session),
) -> BakeResponse:
    """Bake an OSM feature (or a whole bbox+query) into a project SourceFile.

    Three modes:

    1. ``single_osm_id`` set — refetch the feature, wrap as a one-element KML,
       ingest. Uses the same ingest pipeline as a normal upload so the result
       is byte-comparable for byte-identical inputs.
    2. ``bbox`` + ``query`` set — same path as
       :http:post:`/api/projects/{id}/overpass-queries`.
    3. Anything else — 400.

    ``project_id`` may be None — we'll mint a fresh project named ``name`` or
    ``Browse — YYYY-MM-DD``.
    """
    if not req.single_osm_id and not (req.bbox and req.query):
        raise HTTPException(
            status_code=400,
            detail="bake requires either single_osm_id, or both bbox and query",
        )

    proj = _ensure_project(db, project_id=req.project_id, name=req.name)

    if req.single_osm_id:
        try:
            feature = await area_inventory.fetch_single_feature(req.single_osm_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except overpass.OverpassError as exc:
            raise HTTPException(status_code=502, detail=f"Overpass call failed: {exc}") from exc

        element = feature.get("raw")
        if not isinstance(element, dict):
            raise HTTPException(status_code=502, detail="Overpass returned no usable element")

        layer_name = req.name or feature.get("name") or req.single_osm_id
        raw_kml = synthesize_kml(layer_name, {"elements": [element]})
        filename = f"{layer_name}.overpass.kml"
        summary = _ingest_kml_bytes(
            db,
            proj,
            filename,
            raw_kml,
            overpass_query=None,
            bbox=None,
        )
        return BakeResponse(project_id=proj.id, source_file=summary)

    # bbox + query mode. We re-use the projects router's bbox-substitution
    # helper so the two endpoints behave identically (placeholder syntax,
    # WSEN→SWNE conversion, error shape).
    layer_name = req.name or f"bbox-{date.today().isoformat()}"
    substituted = _substitute_bbox(req.query or "", req.bbox)
    try:
        result = await overpass.execute_query(substituted)
    except overpass.OverpassError as exc:
        raise HTTPException(status_code=502, detail=f"Overpass call failed: {exc}") from exc

    raw_kml = synthesize_kml(layer_name, result)
    filename = f"{layer_name}.overpass.kml"
    summary = _ingest_kml_bytes(
        db,
        proj,
        filename,
        raw_kml,
        overpass_query=req.query,
        bbox=req.bbox,
    )
    return BakeResponse(project_id=proj.id, source_file=summary)
