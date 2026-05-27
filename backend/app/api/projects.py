"""Project CRUD + import + export routes."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
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
from app.kml.category import detect_category_key
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
    UpdateProjectRequest,
)

router = APIRouter(prefix="/projects", tags=["projects"])


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


@router.post("/{project_id}/source-files", response_model=SourceFileSummary, status_code=201)
async def import_kml(
    project_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> SourceFileSummary:
    proj = _load_project(session, project_id)
    raw = await file.read()
    try:
        cache = _build_parsed_cache(raw)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"failed to parse KML: {exc}") from exc

    # Detect this file's own category key from its placemarks. A project may
    # legitimately mix files that group by different OSM tags (prisons →
    # amenity, cemeteries → landuse).
    sf_category_key = detect_category_key(
        pm["extended_data"] for pm in cache["placemarks"]
    )

    sf = SourceFile(
        project_id=proj.id,
        filename=file.filename or "import.kml",
        raw_kml=raw,
        parsed_cache=cache,
        category_key=sf_category_key,
    )
    session.add(sf)
    session.flush()

    # Keep project.category_key as a denormalised "most-populous across the
    # project" hint for the project picker. Recompute on every import so adding
    # a new file can promote a different primary key when it dominates. The
    # relationship collection isn't auto-refreshed after the flush, so include
    # the freshly-added row explicitly.
    sources = list(proj.source_files)
    if sf not in sources:
        sources.append(sf)
    all_data: list[dict[str, str]] = []
    for source in sources:
        for pm in (source.parsed_cache or {}).get("placemarks", []):
            all_data.append(pm["extended_data"])
    proj.category_key = detect_category_key(all_data)

    return _source_file_summary(sf)


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
