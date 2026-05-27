"""Per-placemark annotations and style overrides."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import PlacemarkAnnotation, PlacemarkStyleOverride, SourceFile
from app.db.session import get_session

from .schemas import AnnotationUpdate, OverrideUpdate

router = APIRouter(prefix="/projects/{project_id}/source-files/{source_file_id}", tags=["annotations"])


def _verify_source_file(session: Session, project_id: int, source_file_id: int) -> SourceFile:
    sf = session.execute(
        select(SourceFile).where(
            SourceFile.id == source_file_id, SourceFile.project_id == project_id
        )
    ).scalar_one_or_none()
    if sf is None:
        raise HTTPException(status_code=404, detail="source file not found in project")
    return sf


@router.put("/placemarks/{index}/annotations")
def upsert_annotations(
    project_id: int,
    source_file_id: int,
    index: int,
    req: AnnotationUpdate,
    session: Session = Depends(get_session),
) -> dict[str, str]:
    sf = _verify_source_file(session, project_id, source_file_id)
    cleaned = {k: v for k, v in req.fields.items() if v != ""}

    existing = session.execute(
        select(PlacemarkAnnotation).where(
            PlacemarkAnnotation.source_file_id == sf.id,
            PlacemarkAnnotation.placemark_index == index,
        )
    ).scalar_one_or_none()

    if not cleaned:
        if existing is not None:
            session.delete(existing)
        return {}
    if existing is None:
        session.add(
            PlacemarkAnnotation(
                source_file_id=sf.id, placemark_index=index, fields=cleaned
            )
        )
    else:
        existing.fields = cleaned
    return cleaned


@router.put("/placemarks/{index}/override")
def upsert_override(
    project_id: int,
    source_file_id: int,
    index: int,
    req: OverrideUpdate,
    session: Session = Depends(get_session),
) -> Response:
    sf = _verify_source_file(session, project_id, source_file_id)
    existing = session.execute(
        select(PlacemarkStyleOverride).where(
            PlacemarkStyleOverride.source_file_id == sf.id,
            PlacemarkStyleOverride.placemark_index == index,
        )
    ).scalar_one_or_none()

    if req.style is None:
        if existing is not None:
            session.delete(existing)
        return Response(status_code=204)

    if existing is None:
        session.add(
            PlacemarkStyleOverride(
                source_file_id=sf.id,
                placemark_index=index,
                style_json=req.style.model_dump(),
            )
        )
    else:
        existing.style_json = req.style.model_dump()
    return Response(status_code=204)
