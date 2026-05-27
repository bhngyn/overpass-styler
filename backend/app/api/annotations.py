"""Per-placemark annotations and style overrides."""

from __future__ import annotations

from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import PlacemarkAnnotation, PlacemarkStyleOverride, SourceFile
from app.db.session import get_session

from .schemas import AnnotationUpdate, OverrideUpdate

router = APIRouter(prefix="/projects/{project_id}/source-files/{source_file_id}", tags=["annotations"])

# Annotation keys whose value is rendered as a clickable link in the exported
# KML balloon HTML. Their values must be validated against a safe-URL allowlist
# so a malicious `javascript:` href can't ride an exported KML into a browser
# preview, Google My Maps re-import, or any other tool that renders HTML
# anchors (Earth Pro itself doesn't execute JS, but the exported file is no
# longer under our control).
_URL_ANNOTATION_KEYS = frozenset({"source", "source_url", "link"})
_SAFE_URL_SCHEMES = frozenset({"http", "https", "mailto"})

# Individual annotation values are user-supplied text that ends up in the DB
# (LargeBinary parsed_cache + a TEXT fields column) and in every export. A
# multi-MB note bloats SQLite and every subsequent export — cap it at
# something generous-but-bounded.
_MAX_FIELD_LENGTH = 8_000


def _validate_annotations(fields: dict[str, str]) -> None:
    """Reject obviously unsafe annotation payloads with a 400."""
    for key, value in fields.items():
        if len(value) > _MAX_FIELD_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"annotation {key!r} is too long "
                    f"({len(value)} chars; max {_MAX_FIELD_LENGTH})"
                ),
            )
        if key.lower() in _URL_ANNOTATION_KEYS or key.lower().endswith("_url"):
            try:
                parsed = urlparse(value)
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"annotation {key!r} is not a parseable URL: {exc}",
                ) from exc
            # Empty url → empty annotation, already filtered by the caller.
            if parsed.scheme and parsed.scheme.lower() not in _SAFE_URL_SCHEMES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"annotation {key!r} uses scheme {parsed.scheme!r}; "
                        f"only {sorted(_SAFE_URL_SCHEMES)} are allowed"
                    ),
                )


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
    _validate_annotations(cleaned)

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
