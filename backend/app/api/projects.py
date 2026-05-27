"""Project CRUD + import + export routes."""

from __future__ import annotations

import json
import logging
import math
import os
import re

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.db.models import (
    CategoryStyle,
    PlacemarkAnnotation,
    PlacemarkStyleOverride,
    Project,
    SourceFile,
)
from app.db.session import get_session
from app.enrichment import overpass, overpass_tile
from app.kml.category import detect_category_key
from app.kml.from_overpass import DEFAULT_MAX_ELEMENTS, synthesize_kml
from app.kml.parse import parse_kml
from app.kml.serialize import SourceLayer, StyledDocument, serialize
from app.kml.style import FeatureStyle

from .convert import (
    placemark_to_preview,
    style_from_schema,
    style_to_schema,
)
from .schemas import (
    CreateProjectRequest,
    ProjectDetail,
    ProjectSummary,
    SetCategoryStyleRequest,
    SourceFileDetail,
    SourceFileSummary,
    TruncationReportSchema,
    UpdateProjectRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])


def _bbox_area_km2(bbox: list[float] | None) -> float | None:
    """Approximate area of a [W, S, E, N] bbox in km².

    Uses a simple equirectangular approximation — accurate to within a few
    percent for the bbox sizes investigators draw (≤ continent-scale). The
    Overpass adaptive-timeout consumer only needs the order of magnitude.
    """
    if bbox is None or len(bbox) != 4:
        return None
    west, south, east, north = bbox
    if east <= west or north <= south:
        return None
    mean_lat_rad = math.radians((south + north) / 2.0)
    width_km = (east - west) * 111.320 * math.cos(mean_lat_rad)
    height_km = (north - south) * 110.574
    return max(0.0, width_km * height_km)


def _safe_style_id(category_value: str) -> str:
    """Make a category value safe to use as a KML style id."""
    return "cat-" + re.sub(r"[^a-zA-Z0-9_-]", "_", category_value.lower())


def _project_summary(p: Project) -> ProjectSummary:
    return ProjectSummary(
        id=p.id,
        name=p.name,
        category_key=p.category_key,
        source_file_count=len(p.source_files),
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


def _source_file_category_key(sf: SourceFile) -> str | None:
    """Return the stored per-file category key, detecting on the fly for legacy rows."""
    if sf.category_key:
        return sf.category_key
    placemarks = (sf.parsed_cache or {}).get("placemarks", [])
    if not placemarks:
        return None
    return detect_category_key(pm.get("extended_data", {}) for pm in placemarks)


def _source_file_summary(sf: SourceFile) -> SourceFileSummary:
    return SourceFileSummary(
        id=sf.id,
        filename=sf.filename,
        placemark_count=len((sf.parsed_cache or {}).get("placemarks", [])),
        category_key=_source_file_category_key(sf),
        created_at=sf.created_at,
        overpass_query=sf.overpass_query,
        bbox_json=sf.bbox_json,
    )


def _project_detail(p: Project) -> ProjectDetail:
    styles_by_value = {
        cs.category_value: style_to_schema(
            style_from_schema(
                __import__("app.api.schemas", fromlist=["FeatureStyleSchema"]).FeatureStyleSchema(
                    **cs.style_json
                )
            )
        )
        for cs in p.category_styles
    }
    return ProjectDetail(
        id=p.id,
        name=p.name,
        category_key=p.category_key,
        created_at=p.created_at,
        updated_at=p.updated_at,
        source_files=[_source_file_summary(sf) for sf in p.source_files],
        category_styles=styles_by_value,
    )


def _load_project(session: Session, project_id: int) -> Project:
    proj = session.execute(
        select(Project)
        .where(Project.id == project_id)
        .options(
            selectinload(Project.source_files),
            selectinload(Project.category_styles),
        )
    ).scalar_one_or_none()
    if proj is None:
        raise HTTPException(status_code=404, detail="project not found")
    return proj


@router.get("", response_model=list[ProjectSummary])
def list_projects(session: Session = Depends(get_session)) -> list[ProjectSummary]:
    projs = session.execute(
        select(Project)
        .options(selectinload(Project.source_files))
        .order_by(Project.updated_at.desc())
    ).scalars().all()
    return [_project_summary(p) for p in projs]


@router.post("", response_model=ProjectDetail, status_code=201)
def create_project(
    req: CreateProjectRequest, session: Session = Depends(get_session)
) -> ProjectDetail:
    proj = Project(name=req.name)
    session.add(proj)
    session.flush()
    return _project_detail(_load_project(session, proj.id))


@router.get("/{project_id}", response_model=ProjectDetail)
def get_project(project_id: int, session: Session = Depends(get_session)) -> ProjectDetail:
    return _project_detail(_load_project(session, project_id))


@router.patch("/{project_id}", response_model=ProjectDetail)
def update_project(
    project_id: int,
    req: UpdateProjectRequest,
    session: Session = Depends(get_session),
) -> ProjectDetail:
    proj = _load_project(session, project_id)
    if req.name is not None:
        proj.name = req.name
    if req.category_key is not None:
        proj.category_key = req.category_key
    session.flush()
    return _project_detail(proj)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, session: Session = Depends(get_session)) -> Response:
    proj = _load_project(session, project_id)
    session.delete(proj)
    return Response(status_code=204)


# ---- Source files (KML imports) ----------------------------------------------------


def _build_parsed_cache(raw: bytes) -> dict:
    parsed = parse_kml(raw)
    return {
        "document_name": parsed.document_name,
        "document_description": parsed.document_description,
        "placemarks": [
            {
                "name": p.name,
                "extended_data": p.extended_data,
                "extended_data_order": p.extended_data_order,
                "geometry": (
                    {
                        "kind": p.geometry.kind,
                        "point": p.geometry.point,
                        "line": p.geometry.line,
                        "polygon": (
                            {"outer": p.geometry.polygon.outer, "inners": p.geometry.polygon.inners}
                            if p.geometry.polygon
                            else None
                        ),
                    }
                    if p.geometry
                    else None
                ),
            }
            for p in parsed.placemarks
        ],
    }


def _ingest_kml_bytes(
    db: Session,
    project: Project,
    file_name: str,
    raw_kml: bytes,
    *,
    overpass_query: str | None = None,
    bbox: list[float] | None = None,
) -> SourceFileSummary:
    """Ingest a KML byte string into a project as a SourceFile row.

    Shared by the upload endpoint and the Overpass-query endpoint so they
    produce byte-identical rows for byte-identical inputs. The two
    Overpass-specific fields (``overpass_query``, ``bbox``) are stored
    alongside the layer so the UI can show "this layer was generated by
    this QL against this bbox" and offer a re-run.

    Raises HTTPException(400) if the bytes don't parse as KML.
    """
    try:
        cache = _build_parsed_cache(raw_kml)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"failed to parse KML: {exc}") from exc

    sf_category_key = detect_category_key(
        pm["extended_data"] for pm in cache["placemarks"]
    )

    sf = SourceFile(
        project_id=project.id,
        filename=file_name,
        raw_kml=raw_kml,
        parsed_cache=cache,
        category_key=sf_category_key,
        overpass_query=overpass_query,
        bbox_json=json.dumps(bbox) if bbox is not None else None,
    )
    db.add(sf)
    db.flush()

    # Recompute the project-wide "most-populous primary tag" hint. The freshly
    # added row isn't yet on the relationship collection so we include it
    # explicitly. This is just a denormalised summary for the picker.
    sources = list(project.source_files)
    if sf not in sources:
        sources.append(sf)
    all_data: list[dict[str, str]] = []
    for source in sources:
        for pm in (source.parsed_cache or {}).get("placemarks", []):
            all_data.append(pm["extended_data"])
    project.category_key = detect_category_key(all_data)

    return _source_file_summary(sf)


# 100 MB ceiling on KML uploads — Earth Pro itself stutters on KMLs much
# bigger than this, and uncapped reads invite an OOM via a malicious or
# accidental huge file. Override per-deployment via env var.
_MAX_KML_UPLOAD_BYTES = int(
    os.environ.get("OVERPASS_STYLER_MAX_KML_BYTES", str(100 * 1024 * 1024))
)


async def _read_upload_capped(file: UploadFile, *, max_bytes: int) -> bytes:
    """Stream ``file`` into memory in 1 MiB chunks, refusing past ``max_bytes``.

    Raises ``HTTPException(413)`` rather than allowing an unbounded ``read``
    to exhaust the worker's memory. The ceiling is checked after each chunk
    so a single oversized chunk can't slip through.
    """
    buf = bytearray()
    while True:
        chunk = await file.read(1 << 20)  # 1 MiB
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"KML upload exceeds the {max_bytes // 1024 // 1024} MB cap. "
                    "Set OVERPASS_STYLER_MAX_KML_BYTES higher if you trust the source."
                ),
            )
    return bytes(buf)


@router.post("/{project_id}/source-files", response_model=SourceFileSummary, status_code=201)
async def import_kml(
    project_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> SourceFileSummary:
    # Read the body before touching the DB so we don't hold a SQLite writer
    # lock across the await.
    raw = await _read_upload_capped(file, max_bytes=_MAX_KML_UPLOAD_BYTES)

    # Run the sync DB work on the threadpool. Two concurrent uploads to the
    # same project previously deadlocked: B's blocking ``session.execute``
    # (waiting on A's writer lock) ran on the event loop thread, so A's
    # coroutine couldn't resume to commit, and B then exhausted its 5s
    # ``busy_timeout``. Pushing the sync work to a worker thread lets the
    # event loop schedule A's commit while B sits in pysqlite's busy_wait,
    # so B picks up the lock as soon as A releases it.
    def _do_ingest() -> SourceFileSummary:
        proj = _load_project(session, project_id)
        return _ingest_kml_bytes(
            session,
            proj,
            file.filename or "import.kml",
            raw,
        )

    return await run_in_threadpool(_do_ingest)


def _check_finite_bbox(v: list[float] | None) -> list[float] | None:
    """Reject NaN / Infinity / wrong-length bboxes at the Pydantic boundary."""
    if v is None:
        return v
    if len(v) != 4:
        raise ValueError("bbox must have exactly 4 components [w, s, e, n]")
    for i, x in enumerate(v):
        if not math.isfinite(x):
            raise ValueError(f"bbox component {i} is not finite ({x!r})")
    return v


class _OverpassQueryRequest(BaseModel):
    name: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="Layer name shown in the tree + KML Document name.",
    )
    query: str = Field(
        ...,
        min_length=1,
        max_length=20_000,
        description="Overpass QL. May contain {{bbox}} placeholders.",
    )
    bbox: list[float] | None = Field(
        default=None,
        min_length=4,
        max_length=4,
        description="[west, south, east, north]. Required if the query uses {{bbox}}.",
    )
    region_label: str | None = Field(
        default=None,
        max_length=200,
        description="Human-readable region name for UI display (e.g. 'N'Djamena'). "
        "Stored alongside the bbox; not used during query execution.",
    )

    @field_validator("bbox")
    @classmethod
    def _bbox_finite(cls, v: list[float] | None) -> list[float] | None:
        return _check_finite_bbox(v)


class _OverpassPreflightRequest(BaseModel):
    """Cheap probe before committing to an Overpass-query layer ingest.

    Mirrors :class:`_OverpassQueryRequest` so the frontend can reuse the
    same form payload — the only difference is that ``name`` is optional
    (the user hasn't picked a layer name yet at preflight time).
    """

    query: str = Field(..., min_length=1, max_length=20_000)
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)

    @field_validator("bbox")
    @classmethod
    def _bbox_finite(cls, v: list[float] | None) -> list[float] | None:
        return _check_finite_bbox(v)


class OverpassPreflightResponse(BaseModel):
    total_count: int
    estimated_kml_bytes: int
    too_large: bool
    hard_cap: int
    # Hostname of the Overpass mirror that served this probe, only when it
    # isn't the primary endpoint. Same semantics as ``SourceFileSummary.served_by``.
    served_by: str | None = None


_BBOX_PLACEHOLDER_RE = re.compile(r"\{\{\s*bbox\s*\}\}")


def _substitute_bbox(query: str, bbox: list[float] | None) -> str:
    """Replace ``{{bbox}}`` with the Overpass-flavoured ``south,west,north,east``
    token. Note Overpass uses (S,W,N,E), not the GeoJSON-ish (W,S,E,N) we accept
    from the client — investigators paste WSEN from common bbox tools."""
    if not _BBOX_PLACEHOLDER_RE.search(query):
        return query
    if bbox is None or len(bbox) != 4:
        raise HTTPException(
            status_code=400,
            detail="query contains {{bbox}} but no bbox was provided",
        )
    west, south, east, north = bbox
    return _BBOX_PLACEHOLDER_RE.sub(f"{south},{west},{north},{east}", query)


# Strip a leading ``[out:...][timeout:...];`` settings line + any trailing
# ``out body;`` / ``out geom;`` / etc. so execute_count can wrap a clean body.
# The trailing-out regex makes args optional so the bare ``out;`` idiom
# (most common Overpass Turbo export shape) is stripped too — without
# ``(?:\s+[^;]*)?`` execute_count would wrap ``(...;out;);out count;`` which
# Overpass rejects with a parse error.
_LEADING_SETTINGS_RE = re.compile(r"^\s*(?:\[[^\]]+\]\s*)+;")
_TRAILING_OUT_RE = re.compile(r"\bout(?:\s+[^;]*)?;\s*$", re.IGNORECASE)


def _strip_outer_statements(ql: str) -> str:
    """Reduce a user-authored QL to the bare set-selection body.

    ``execute_count`` wraps the body in its own ``[out:json]...; out count;``
    so the user's settings line + trailing ``out`` statement would otherwise
    fight for control. This best-effort cleanup catches the common patterns;
    pathological inputs fall through to Overpass which surfaces a syntax
    error the investigator can fix.
    """
    stripped = _LEADING_SETTINGS_RE.sub("", ql).strip()
    while True:
        new = _TRAILING_OUT_RE.sub("", stripped).strip()
        if new == stripped:
            break
        stripped = new
    return stripped.rstrip(";").strip()


@router.post(
    "/{project_id}/overpass-queries/preflight",
    response_model=OverpassPreflightResponse,
)
async def preflight_overpass_query(
    project_id: int,
    req: _OverpassPreflightRequest,
    session: Session = Depends(get_session),
) -> OverpassPreflightResponse:
    """Cheap "how big would this layer be?" probe before committing.

    Wraps the user's QL body in ``out count;`` so Overpass only returns the
    element cardinality, not geometry. The frontend uses this to show
    "47 features" before the investigator clicks "Add as layer", and to
    refuse anything past the synthesizer's hard cap with a useful message.
    """
    _load_project(session, project_id)  # 404 early if project doesn't exist

    substituted = _substitute_bbox(req.query, req.bbox)
    body = _strip_outer_statements(substituted)

    served_by: str | None = None
    try:
        # Use the contextvar-based ex wrapper so the preflight can also tell
        # the UI when the primary mirror was down — investigators see the
        # "routed via …" footnote even before they bake.
        token = overpass._served_by_ctx.set(None)
        try:
            total = await overpass.execute_count(body)
            served_url = overpass._served_by_ctx.get()
            if served_url:
                served_by = overpass.served_by_label(served_url)
        finally:
            overpass._served_by_ctx.reset(token)
    except overpass.OverpassError as exc:
        logger.warning("overpass preflight failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Rough KML size estimate: each placemark serialises to ~150-300 bytes
    # (extended data is the bulk), plus a ~5KB document overhead. The
    # frontend shows this so investigators with slow disks notice big
    # downloads coming.
    estimated_bytes = total * 200 + 5_000
    return OverpassPreflightResponse(
        total_count=total,
        estimated_kml_bytes=estimated_bytes,
        too_large=total > DEFAULT_MAX_ELEMENTS,
        hard_cap=DEFAULT_MAX_ELEMENTS,
        served_by=served_by,
    )


@router.post(
    "/{project_id}/overpass-queries",
    response_model=SourceFileSummary,
    status_code=201,
)
async def run_overpass_query(
    project_id: int,
    req: _OverpassQueryRequest,
    session: Session = Depends(get_session),
) -> SourceFileSummary:
    """Run an Overpass QL query and ingest the result as a layer.

    The original (un-substituted) query is stored on the resulting SourceFile
    so the UI can show what the investigator typed, not the bbox-expanded
    payload Overpass actually saw.

    When the synthesizer's hard cap kicks in we still ingest the truncated
    result (the investigator gets *some* output), and the response's
    ``truncation`` field surfaces ``{total, ingested, truncated}`` so the
    UI can warn that data was dropped.
    """
    proj = _load_project(session, project_id)

    substituted = _substitute_bbox(req.query, req.bbox)
    served_by: str | None = None
    try:
        if req.bbox and "{{bbox}}" in req.query:
            # Bbox-anchored query: route through the auto-tiling helper, which
            # probes the count and either single-shots, tiles in parallel
            # across the mirror pool, or refuses if past the hard cap.
            area_km2 = _bbox_area_km2(req.bbox)
            result, served_by = await overpass_tile.run_overpass_maybe_tiled(
                req.query, req.bbox, area_hint_km2=area_km2
            )
        else:
            # Free-form query (no bbox placeholder, e.g. area_name lookups):
            # fall through to a single-shot. The mirror pool still gives us
            # failover.
            data, url = await overpass.execute_query_ex(substituted)
            result = data
            served_by = overpass.served_by_label(url)
    except overpass.OverpassError as exc:
        logger.exception("overpass query failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    raw_kml, report = synthesize_kml(req.name, result)
    filename = f"{req.name}.overpass.kml"
    summary = _ingest_kml_bytes(
        session,
        proj,
        filename,
        raw_kml,
        overpass_query=req.query,
        bbox=req.bbox,
    )
    if report.truncated:
        # L2's TruncationReport uses ``truncated`` as the count of dropped
        # elements (display sugar), not a bool. Compute the diff here.
        summary.truncation = TruncationReportSchema(
            total=report.total,
            ingested=report.ingested,
            truncated=report.total - report.ingested,
        )
    summary.served_by = served_by
    return summary


@router.get("/{project_id}/source-files/{source_file_id}", response_model=SourceFileDetail)
def get_source_file(
    project_id: int,
    source_file_id: int,
    session: Session = Depends(get_session),
) -> SourceFileDetail:
    proj = _load_project(session, project_id)
    sf = next((s for s in proj.source_files if s.id == source_file_id), None)
    if sf is None:
        raise HTTPException(status_code=404, detail="source file not found")

    annotations_by_idx = {
        a.placemark_index: a.fields
        for a in session.execute(
            select(PlacemarkAnnotation).where(PlacemarkAnnotation.source_file_id == sf.id)
        ).scalars().all()
    }
    overrides_by_idx = {
        o.placemark_index
        for o in session.execute(
            select(PlacemarkStyleOverride).where(PlacemarkStyleOverride.source_file_id == sf.id)
        ).scalars().all()
    }

    sf_category_key = _source_file_category_key(sf)
    parsed = parse_kml(sf.raw_kml)  # always re-parse for the live UI
    category_counts: dict[str, int] = {}
    previews = []
    for idx, pm in enumerate(parsed.placemarks):
        cat = pm.extended_data.get(sf_category_key) if sf_category_key else None
        if cat:
            category_counts[cat] = category_counts.get(cat, 0) + 1
        previews.append(
            placemark_to_preview(
                pm,
                idx,
                sf_category_key,
                annotations_by_idx.get(idx, {}),
                idx in overrides_by_idx,
            )
        )

    return SourceFileDetail(
        id=sf.id,
        filename=sf.filename,
        placemark_count=len(previews),
        category_key=sf_category_key,
        category_counts=category_counts,
        placemarks=previews,
        overpass_query=sf.overpass_query,
        bbox_json=sf.bbox_json,
    )


@router.delete("/{project_id}/source-files/{source_file_id}", status_code=204)
def delete_source_file(
    project_id: int,
    source_file_id: int,
    session: Session = Depends(get_session),
) -> Response:
    proj = _load_project(session, project_id)
    sf = next((s for s in proj.source_files if s.id == source_file_id), None)
    if sf is None:
        raise HTTPException(status_code=404, detail="source file not found")
    session.delete(sf)
    return Response(status_code=204)


# ---- Category styles ----------------------------------------------------------------


@router.put("/{project_id}/styles/{category_value}", response_model=ProjectDetail)
def upsert_category_style(
    project_id: int,
    category_value: str,
    req: SetCategoryStyleRequest,
    session: Session = Depends(get_session),
) -> ProjectDetail:
    proj = _load_project(session, project_id)
    existing = next(
        (cs for cs in proj.category_styles if cs.category_value == category_value),
        None,
    )
    if existing is None:
        proj.category_styles.append(
            CategoryStyle(
                project_id=proj.id,
                category_value=category_value,
                style_json=req.style.model_dump(),
            )
        )
    else:
        existing.style_json = req.style.model_dump()
    session.flush()
    return _project_detail(proj)


@router.delete("/{project_id}/styles/{category_value}", response_model=ProjectDetail)
def delete_category_style(
    project_id: int,
    category_value: str,
    session: Session = Depends(get_session),
) -> ProjectDetail:
    proj = _load_project(session, project_id)
    proj.category_styles = [
        cs for cs in proj.category_styles if cs.category_value != category_value
    ]
    session.flush()
    return _project_detail(proj)


# ---- Export -------------------------------------------------------------------------


@router.get("/{project_id}/export")
def export_styled_kml(project_id: int, session: Session = Depends(get_session)) -> Response:
    proj = _load_project(session, project_id)

    # Collect styles keyed by category value.
    style_objs: dict[str, FeatureStyle] = {}
    for cs in proj.category_styles:
        style_objs[cs.category_value] = style_from_schema(
            __import__("app.api.schemas", fromlist=["FeatureStyleSchema"]).FeatureStyleSchema(
                **cs.style_json
            ),
            style_id=_safe_style_id(cs.category_value),
        )

    # Track per-placemark overrides as additional style blocks with unique ids.
    override_styles: list[FeatureStyle] = []
    layers: list[SourceLayer] = []

    for sf in proj.source_files:
        sf_category_key = _source_file_category_key(sf)
        parsed = parse_kml(sf.raw_kml)
        annotations_by_idx = {
            a.placemark_index: a.fields
            for a in session.execute(
                select(PlacemarkAnnotation).where(PlacemarkAnnotation.source_file_id == sf.id)
            ).scalars().all()
        }
        overrides_by_idx = {
            o.placemark_index: o.style_json
            for o in session.execute(
                select(PlacemarkStyleOverride).where(
                    PlacemarkStyleOverride.source_file_id == sf.id
                )
            ).scalars().all()
        }

        layer = SourceLayer(folder_name=sf.filename.rsplit(".", 1)[0], parsed=parsed)
        for idx, pm in enumerate(parsed.placemarks):
            if idx in overrides_by_idx:
                ov_id = f"override-sf{sf.id}-{idx}"
                override_styles.append(
                    style_from_schema(
                        __import__(
                            "app.api.schemas", fromlist=["FeatureStyleSchema"]
                        ).FeatureStyleSchema(**overrides_by_idx[idx]),
                        style_id=ov_id,
                    )
                )
                layer.placemark_style_ids[idx] = ov_id
            elif sf_category_key:
                cat = pm.extended_data.get(sf_category_key)
                if cat and cat in style_objs:
                    layer.placemark_style_ids[idx] = style_objs[cat].id
            if idx in annotations_by_idx:
                layer.placemark_annotations[idx] = annotations_by_idx[idx]
        layers.append(layer)

    doc = StyledDocument(
        document_name=proj.name,
        styles=list(style_objs.values()) + override_styles,
        layers=layers,
    )
    try:
        body = serialize(doc)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"failed to build KML: {exc}") from exc

    safe = re.sub(r"[^a-zA-Z0-9_-]+", "-", proj.name).strip("-") or f"project-{proj.id}"
    return Response(
        content=body,
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": f'attachment; filename="{safe}.styled.kml"'},
    )
