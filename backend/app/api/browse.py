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

import logging
import math
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/browse", tags=["browse"])


# ---------------------------------------------------------------------------
# Preflight / tiling thresholds
#
# These numbers are tuned for the human-rights investigator use case: the
# upper bound of "wait time" the workflow tolerates is roughly 2-3 minutes,
# which at the Overpass rate-limit floor of 1 req/sec puts us at ~144 tiles.
# Inside that envelope, the count thresholds split into:
#   * <= 5000 features: just fetch (one request, ~3-10s)
#   * 5000..200000 features: tile into ~3000-feature chunks
#   * >  200000 features: refuse — the result wouldn't be useful even if we
#     could fetch it (the inventory rail would be unreadable).
# Area-only refuse path catches "all of Europe" style accidents where the
# bbox is so large that even tiling 144 ways won't help.
# ---------------------------------------------------------------------------

PREFLIGHT_SINGLE_CAP = 5000
PREFLIGHT_REFUSE_COUNT = 200_000
PREFLIGHT_REFUSE_AREA_KM2 = 50_000.0
PREFLIGHT_TINY_AREA_KM2 = 1.0
PREFLIGHT_TARGET_TILE_COUNT = 3000
PREFLIGHT_MAX_TILE_DIM = 12  # 12x12 = 144 tiles ≈ 2.5min at 1 req/sec
TILED_INVENTORY_TIMEOUT_S = 90


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


def _validate_bbox_floats(bbox: list[float]) -> list[float]:
    """Reject NaN / Infinity / wrong-length bboxes early.

    Pydantic's float coercion is happy to round-trip ``inf`` and ``nan`` —
    those values then poison every downstream calculation (area, Overpass
    SWNE string, cache key). Catch them at the boundary.
    """
    if len(bbox) != 4:
        raise ValueError("bbox must have exactly 4 components [w, s, e, n]")
    for i, v in enumerate(bbox):
        if not math.isfinite(v):
            raise ValueError(f"bbox component {i} is not finite ({v!r})")
    return bbox


class _BBox(BaseModel):
    """Tiny wrapper around the WSEN tuple so error messages talk about bbox."""

    bbox: list[float] = Field(
        ..., min_length=4, max_length=4,
        description="[west, south, east, north] in EPSG:4326 degrees.",
    )

    @field_validator("bbox")
    @classmethod
    def _check_bbox(cls, v: list[float]) -> list[float]:
        return _validate_bbox_floats(v)


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
    name: str | None = Field(default=None, max_length=200)
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    query: str | None = Field(default=None, max_length=20_000)
    single_osm_id: str | None = Field(default=None, max_length=64)

    @field_validator("bbox")
    @classmethod
    def _check_bbox(cls, v: list[float] | None) -> list[float] | None:
        if v is None:
            return v
        return _validate_bbox_floats(v)


# ---------------------------------------------------------------------------
# Preflight + tiled inventory schemas
# ---------------------------------------------------------------------------


PreflightStrategy = str  # "single" | "tiled" | "refuse"


class TileGrid(BaseModel):
    rows: int
    cols: int


class PreflightResponse(BaseModel):
    total_count: int
    area_km2: float
    strategy: PreflightStrategy
    tile_grid: TileGrid | None = None
    tiles: list[list[float]] | None = None
    reason: str | None = None


class TiledInventoryRequest(BaseModel):
    tiles: list[list[float]] = Field(..., min_length=1, max_length=PREFLIGHT_MAX_TILE_DIM ** 2)

    @field_validator("tiles")
    @classmethod
    def _check_tiles(cls, v: list[list[float]]) -> list[list[float]]:
        for i, bbox in enumerate(v):
            try:
                _validate_bbox_floats(bbox)
            except ValueError as exc:
                raise ValueError(f"tile {i}: {exc}") from exc
        return v


class TiledInventoryResponse(BaseModel):
    """Aggregate of fetch_area_summary across all tiles.

    Same domain-summary shape as :class:`InventoryResponse` but always
    populated (no area-cap path) and decorated with ``partial`` / ``failed_tiles``
    so the UI can warn the investigator if any tile failed.
    """

    total_count: int
    domains: list[DomainSummary]
    tile_count: int
    partial: bool
    failed_tiles: list[list[float]] = Field(default_factory=list)


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


def _plan_tile_grid(
    bbox: tuple[float, float, float, float],
    total_count: int,
    *,
    target_per_tile: int = PREFLIGHT_TARGET_TILE_COUNT,
    max_dim: int = PREFLIGHT_MAX_TILE_DIM,
) -> tuple[TileGrid, list[list[float]]]:
    """Subdivide ``bbox`` into an NxN grid sized for ``target_per_tile`` features.

    We use ``ceil(sqrt(count / target))`` as the divisor and cap at
    ``max_dim`` so the worst-case wait stays under ~2.5 minutes at the
    1 req/sec rate-limit floor. Grids are square to keep the math simple and
    the resulting tiles roughly equal in area; non-square aspect ratios from
    the source bbox carry through unchanged.
    """
    if total_count <= 0:
        dim = 1
    else:
        ideal = math.sqrt(total_count / target_per_tile)
        dim = max(1, min(max_dim, math.ceil(ideal)))
    west, south, east, north = bbox
    dx = (east - west) / dim
    dy = (north - south) / dim
    tiles: list[list[float]] = []
    for r in range(dim):
        for c in range(dim):
            w = west + c * dx
            e = west + (c + 1) * dx if c < dim - 1 else east
            s = south + r * dy
            n = south + (r + 1) * dy if r < dim - 1 else north
            tiles.append([w, s, e, n])
    return TileGrid(rows=dim, cols=dim), tiles


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


@router.post("/preflight", response_model=PreflightResponse)
async def post_preflight(req: _BBox) -> PreflightResponse:
    """Cheap probe: "how big is this bbox?" — used before committing to an inventory fetch.

    Decision tree (tuned for the human-rights investigator's tolerance for
    wait time):

    * Tiny bbox (< 1 km²): always ``single`` — counting would cost more than
      just fetching.
    * Area or count above the refuse thresholds: ``refuse`` with a reason
      the UI can surface. The investigator narrows their box.
    * Count ≤ 5000: ``single``. One round-trip is fine.
    * Anything else: ``tiled`` with an NxN grid sized for ~3000 features per
      tile, capped at 12x12 = 144 tiles (~2.5min worst case at the rate-limit
      floor).
    """
    bbox = _bbox_tuple(req.bbox)
    area_km2 = area_inventory._bbox_area_km2(bbox)

    # Tiny areas skip the count probe entirely. The count call would add ~1s
    # of rate-limit penalty for no benefit.
    if area_km2 < PREFLIGHT_TINY_AREA_KM2:
        return PreflightResponse(
            total_count=0,
            area_km2=area_km2,
            strategy="single",
        )

    # Refuse-by-area before we even count — huge bboxes risk Overpass timing
    # out on the count call itself.
    if area_km2 > PREFLIGHT_REFUSE_AREA_KM2:
        return PreflightResponse(
            total_count=0,
            area_km2=area_km2,
            strategy="refuse",
            reason=(
                f"Area is {area_km2:,.0f} km² (cap {PREFLIGHT_REFUSE_AREA_KM2:,.0f} km²). "
                "Narrow the bounding box, or run several smaller browses."
            ),
        )

    bbox_tok = area_inventory._overpass_bbox(bbox)
    ql_body = f"nwr({bbox_tok})"
    try:
        total = await overpass.execute_count(ql_body, area_hint_km2=area_km2)
    except overpass.OverpassError as exc:
        raise HTTPException(status_code=502, detail=f"Overpass call failed: {exc}") from exc

    if total > PREFLIGHT_REFUSE_COUNT:
        return PreflightResponse(
            total_count=total,
            area_km2=area_km2,
            strategy="refuse",
            reason=(
                f"{total:,} features exceeds the {PREFLIGHT_REFUSE_COUNT:,} hard cap. "
                "Narrow the bounding box, or run several smaller browses."
            ),
        )

    if total <= PREFLIGHT_SINGLE_CAP:
        return PreflightResponse(
            total_count=total,
            area_km2=area_km2,
            strategy="single",
        )

    grid, tiles = _plan_tile_grid(bbox, total)
    return PreflightResponse(
        total_count=total,
        area_km2=area_km2,
        strategy="tiled",
        tile_grid=grid,
        tiles=tiles,
    )


@router.post("/inventory-tiled", response_model=TiledInventoryResponse)
async def post_inventory_tiled(req: TiledInventoryRequest) -> TiledInventoryResponse:
    """Fetch + aggregate area summaries for a list of tiles.

    Iterates serially (the rate-limit lock would serialise concurrent calls
    anyway, and serial control flow makes failure-handling readable). If
    any tile errors we log it, mark ``partial=true``, and return what we
    have — partial reconnaissance is more useful than nothing.

    Domain counts are summed across tiles; top tags are merged by
    ``(key, value)`` with counts added so the same prison appearing in two
    adjacent tiles is still ``×2``.
    """
    failed_tiles: list[list[float]] = []
    domain_counts: dict[str, int] = {}
    top_tag_counter: dict[tuple[str, str], dict[str, int | str]] = {}
    # Track per-domain order of first appearance to keep the response stable.
    domain_order: list[str] = []
    total_count = 0

    for tile in req.tiles:
        bbox_t = _bbox_tuple(tile)
        try:
            # Use the underlying summary fetcher with a generous cap so tiles
            # are never silently degraded to counts-only mode. The caller
            # already split the area into ~3000-feature chunks via preflight;
            # an individual tile should comfortably stay under the cap.
            result = await area_inventory.fetch_area_summary(
                bbox_t,
                area_cap_km2=area_inventory.DEFAULT_AREA_CAP_KM2,
            )
        except overpass.OverpassError as exc:
            logger.warning("tiled-inventory tile failed: %s — %s", tile, exc)
            failed_tiles.append(list(tile))
            continue
        except Exception as exc:  # noqa: BLE001 — defensive: never let one tile abort the batch
            logger.exception("tiled-inventory tile raised: %s — %s", tile, exc)
            failed_tiles.append(list(tile))
            continue

        total_count += int(result.get("total_count") or 0)
        if result.get("area_capped"):
            # The tile slipped over the cap somehow (skewed aspect ratio,
            # ultra-dense urban core). Aggregate domain_counts but skip
            # top-tag merging.
            for name, count in (result.get("domain_counts") or {}).items():
                if name not in domain_counts:
                    domain_order.append(name)
                domain_counts[name] = domain_counts.get(name, 0) + int(count)
            continue

        for domain in result.get("domains") or []:
            name = domain.get("name")
            if not isinstance(name, str):
                continue
            if name not in domain_counts:
                domain_order.append(name)
            domain_counts[name] = domain_counts.get(name, 0) + int(domain.get("count") or 0)
            for tag in domain.get("top_tags") or []:
                key = str(tag.get("key", ""))
                value = str(tag.get("value", ""))
                if not key or not value:
                    continue
                count = int(tag.get("count") or 0)
                entry = top_tag_counter.setdefault(
                    (key, value),
                    {"key": key, "value": value, "count": 0, "domain": name},
                )
                entry["count"] = int(entry["count"]) + count

    # Group top tags by domain so the response shape mirrors the single-bbox
    # inventory endpoint. Sort each domain's tags by count desc and keep
    # the top 5 to match the existing UI contract.
    tags_by_domain: dict[str, list[dict[str, int | str]]] = {}
    for entry in top_tag_counter.values():
        d = str(entry["domain"])
        tags_by_domain.setdefault(d, []).append(entry)
    for d in tags_by_domain:
        tags_by_domain[d].sort(key=lambda e: int(e["count"]), reverse=True)
        tags_by_domain[d] = tags_by_domain[d][:5]

    domains = [
        DomainSummary(
            name=name,
            count=domain_counts[name],
            top_tags=[
                DomainTopTag(key=str(e["key"]), value=str(e["value"]), count=int(e["count"]))
                for e in tags_by_domain.get(name, [])
            ],
        )
        for name in domain_order
        if domain_counts.get(name, 0) > 0
    ]

    return TiledInventoryResponse(
        total_count=total_count,
        domains=domains,
        tile_count=len(req.tiles),
        partial=bool(failed_tiles),
        failed_tiles=failed_tiles,
    )


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
        raw_kml, _truncation = synthesize_kml(layer_name, {"elements": [element]})
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

    raw_kml, _truncation = synthesize_kml(layer_name, result)
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
