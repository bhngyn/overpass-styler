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

import asyncio
import logging
import math
from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.api.projects import (
    _bbox_area_km2,
    _ingest_kml_bytes,
    _load_project,
    _substitute_bbox,
)
from app.api.schemas import SourceFileSummary, TruncationReportSchema
from app.db.models import Project
from app.db.session import get_session
from app.enrichment import area_inventory, overpass, overpass_tile, tiling
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
# Per-tile area cap for the inventory-tiled path. Larger than
# DEFAULT_AREA_CAP_KM2 because the caller has already split a large bbox
# into ≤3000-feature chunks via preflight; we trust those chunks to be
# fetchable with geometry/centers (out tags center) even at ~1000 km².
# Without this bump tiles silently degrade into the counts-only path,
# returning domain counts but empty top_tags — drill-ins then open onto
# "No features in this scope". Set conservatively: a 6266 km² source
# bbox tiles to ~700 km²/tile at 3×3, which fits comfortably under 1500.
TILED_AREA_CAP_KM2 = 1500.0


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
    """One domain's slice of an inventory response.

    ``top_tags`` is the first 5 of ``tags`` — kept separate so the rail's
    domain-card chip rail can read it directly without slicing. ``tags``
    is the full categorical-tag breakdown for this domain, capped at
    :data:`area_inventory.DOMAIN_TAG_CAP` and sorted by count desc. The
    rail's drill view exposes it with a filter input so the operator can
    answer "what tags actually exist in this area?" without scanning a
    spreadsheet by eye.
    """

    name: str
    count: int
    top_tags: list[DomainTopTag] = Field(default_factory=list)
    tags: list[DomainTopTag] = Field(default_factory=list)


class InventorySummary(BaseModel):
    bbox: list[float]
    total_count: int


class CenterPoint(BaseModel):
    """Lightweight per-feature marker for the Browse map.

    Returned in non-area-capped responses so the map can render every
    fetched feature as a muted dot (clustered above ~200 on the frontend
    for render budget). ``domain`` is the same partition label used in the
    inventory rail, so we can colour-code later without re-classifying on
    the client. Geometry is intentionally one ``[lon, lat]`` per feature —
    full geometry comes from :http:get:`/api/browse/item` on click.
    """

    osm_id: str
    lon: float
    lat: float
    domain: str


class InventoryResponse(BaseModel):
    """Domain-partitioned summary of an Overpass bbox query.

    ``area_capped`` is True when the bbox exceeded the size cap and Overpass
    was queried for counts only. In that mode ``domain_counts`` is populated
    and ``domains`` is omitted; in the normal mode it's the other way round.
    ``centers`` is populated only when not area-capped — the counts-only
    query path doesn't ask Overpass for ``out center;``, so positions are
    unavailable.
    """

    area_capped: bool
    area_km2: float
    area_cap_km2: float
    total_count: int
    summary: InventorySummary | None = None
    domains: list[DomainSummary] | None = None
    domain_counts: dict[str, int] | None = None
    centers: list[CenterPoint] = Field(default_factory=list)


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
    so the UI can warn the investigator if any tile failed. ``centers`` is
    aggregated across all tiles up to the same INVENTORY_CENTER_CAP cap, so
    payload size stays bounded regardless of how many tiles contribute.
    """

    total_count: int
    domains: list[DomainSummary]
    centers: list[CenterPoint] = Field(default_factory=list)
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
    """Wrap the shared :func:`app.enrichment.tiling.plan_tile_bboxes` for the
    preflight response schema (which carries an explicit ``TileGrid``)."""
    dim, tiles = tiling.plan_tile_bboxes(
        bbox, total_count, target_per_tile=target_per_tile, max_dim=max_dim
    )
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
        tags=[
            DomainTopTag(key=t["key"], value=t["value"], count=int(t["count"]))
            for t in d.get("tags") or []
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
        logger.warning("browse overpass call failed: %s", exc)
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


async def _fetch_tile_safe(
    tile: list[float],
) -> tuple[list[float], dict | None, BaseException | None]:
    """Fetch a single tile, returning either the result or the exception.

    Wrapping this way lets us run multiple tiles concurrently via
    ``asyncio.gather`` without aborting the whole batch when one fails.
    """
    bbox_t = _bbox_tuple(tile)
    try:
        result = await area_inventory.fetch_area_summary(
            bbox_t,
            area_cap_km2=TILED_AREA_CAP_KM2,
        )
        return list(tile), result, None
    except overpass.OverpassError as exc:
        return list(tile), None, exc
    except Exception as exc:  # noqa: BLE001 — defensive: never let one tile abort the batch
        return list(tile), None, exc


@router.post("/inventory-tiled", response_model=TiledInventoryResponse)
async def post_inventory_tiled(req: TiledInventoryRequest) -> TiledInventoryResponse:
    """Fetch + aggregate area summaries for a list of tiles.

    Tiles are fetched in chunks of ``len(overpass_pool)`` so multiple mirrors
    run in parallel. Each mirror has its own 1 req/sec rate-limit lock, so
    we never violate the public-instance etiquette. If any tile errors we
    log it, mark ``partial=true``, and return what we have — partial
    reconnaissance is more useful than nothing.

    Domain counts are summed across tiles; top tags are merged by
    ``(key, value)`` with counts added so the same prison appearing in two
    adjacent tiles is still ``×2``.
    """
    failed_tiles: list[list[float]] = []
    domain_counts: dict[str, int] = {}
    # Per-domain (key, value) → summed count. Replaces the old top-5-only
    # merge so we can rebuild a full ``tags`` list per domain on the way
    # out, not just a chip rail's worth.
    tag_counter: dict[str, dict[tuple[str, str], int]] = defaultdict(dict)
    # Track per-domain order of first appearance to keep the response stable.
    domain_order: list[str] = []
    total_count = 0
    centers: list[CenterPoint] = []
    seen_center_ids: set[str] = set()

    parallelism = max(1, len(overpass.endpoint_pool_snapshot()))
    tiles = list(req.tiles)
    for chunk_start in range(0, len(tiles), parallelism):
        chunk = tiles[chunk_start : chunk_start + parallelism]
        chunk_results = await asyncio.gather(
            *(_fetch_tile_safe(tile) for tile in chunk)
        )
        for tile, result, exc in chunk_results:
            if exc is not None:
                if isinstance(exc, overpass.OverpassError):
                    logger.warning("tiled-inventory tile failed: %s — %s", tile, exc)
                else:
                    logger.exception(
                        "tiled-inventory tile raised: %s — %s", tile, exc
                    )
                failed_tiles.append(list(tile))
                continue
            assert result is not None  # mypy hint

            total_count += int(result.get("total_count") or 0)
            if result.get("area_capped"):
                # The tile slipped over the cap somehow (skewed aspect ratio,
                # ultra-dense urban core). Aggregate domain_counts but skip
                # top-tag merging. Centers are unavailable on this path — the
                # counts-only Overpass query doesn't ask for ``out center;``.
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
                # Merge the full per-tile tag breakdown (not just top_tags).
                # Per-tile tags is already capped at DOMAIN_TAG_CAP so this is
                # bounded; we re-cap on the way out after summing.
                per_domain = tag_counter[name]
                for tag in domain.get("tags") or domain.get("top_tags") or []:
                    key = str(tag.get("key", ""))
                    value = str(tag.get("value", ""))
                    if not key or not value:
                        continue
                    count = int(tag.get("count") or 0)
                    per_domain[(key, value)] = per_domain.get((key, value), 0) + count

            if len(centers) < area_inventory.INVENTORY_CENTER_CAP:
                for c in result.get("centers") or []:
                    oid = c.get("osm_id")
                    if not oid or oid in seen_center_ids:
                        continue
                    seen_center_ids.add(oid)
                    centers.append(CenterPoint(
                        osm_id=str(oid),
                        lon=float(c["lon"]),
                        lat=float(c["lat"]),
                        domain=str(c.get("domain", "Other")),
                    ))
                    if len(centers) >= area_inventory.INVENTORY_CENTER_CAP:
                        break

    # Assemble per-domain tag lists: sort by summed count desc, re-cap at
    # DOMAIN_TAG_CAP, then split into top_tags (first 5, drives the chip
    # rail on each domain card) and tags (the full list, drives the
    # drill-in tag-breakdown view).
    domain_tag_lists: dict[str, list[DomainTopTag]] = {}
    for name, per_domain in tag_counter.items():
        sorted_pairs = sorted(per_domain.items(), key=lambda kv: kv[1], reverse=True)
        capped = sorted_pairs[: area_inventory.DOMAIN_TAG_CAP]
        domain_tag_lists[name] = [
            DomainTopTag(key=k, value=v, count=c) for (k, v), c in capped
        ]

    domains = [
        DomainSummary(
            name=name,
            count=domain_counts[name],
            top_tags=domain_tag_lists.get(name, [])[:5],
            tags=domain_tag_lists.get(name, []),
        )
        for name in domain_order
        if domain_counts.get(name, 0) > 0
    ]

    return TiledInventoryResponse(
        total_count=total_count,
        domains=domains,
        centers=centers,
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
        logger.warning("browse overpass call failed: %s", exc)
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
        centers=[CenterPoint(**c) for c in result.get("centers") or []],
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
    except area_inventory.InvalidOsmTagError as exc:
        # Invalid OSM tag — almost certainly a malformed client request or
        # an injection attempt. 400 with the offending token surfaced.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except overpass.OverpassError as exc:
        logger.warning("browse overpass call failed: %s", exc)
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
        logger.warning("browse overpass call failed: %s", exc)
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
            logger.warning("browse overpass call failed: %s", exc)
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

    # bbox + query mode. Route through the auto-tiling helper just like
    # projects.run_overpass_query does — otherwise a large-area bake (a
    # whole city of features) either times out on a single mirror call or
    # silently drops everything past synthesize_kml's hard cap. We also
    # surface the truncation report and the serving mirror so the rail
    # banner can warn the operator that data was dropped or that we
    # failed over to a backup endpoint.
    layer_name = req.name or f"bbox-{date.today().isoformat()}"
    # Validated by the field validator already; assert for typing.
    assert req.bbox is not None and req.query is not None
    served_by: str | None = None
    try:
        if "{{bbox}}" in req.query:
            area_km2 = _bbox_area_km2(req.bbox)
            result, served_by = await overpass_tile.run_overpass_maybe_tiled(
                req.query, req.bbox, area_hint_km2=area_km2
            )
        else:
            substituted = _substitute_bbox(req.query, req.bbox)
            data, url = await overpass.execute_query_ex(substituted)
            result = data
            served_by = overpass.served_by_label(url)
    except overpass.OverpassError as exc:
        logger.warning("browse overpass call failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Overpass call failed: {exc}") from exc

    raw_kml, report = synthesize_kml(layer_name, result)
    filename = f"{layer_name}.overpass.kml"
    summary = _ingest_kml_bytes(
        db,
        proj,
        filename,
        raw_kml,
        overpass_query=req.query,
        bbox=req.bbox,
    )
    if report.truncated:
        summary.truncation = TruncationReportSchema(
            total=report.total,
            ingested=report.ingested,
            truncated=report.total - report.ingested,
        )
    summary.served_by = served_by
    return BakeResponse(project_id=proj.id, source_file=summary)
