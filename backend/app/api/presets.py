"""Reusable style presets."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import StylePreset
from app.db.session import get_session

from .schemas import CreatePresetRequest, FeatureStyleSchema, PresetSummary

router = APIRouter(prefix="/presets", tags=["presets"])


@router.get("", response_model=list[PresetSummary])
def list_presets(session: Session = Depends(get_session)) -> list[PresetSummary]:
    presets = session.execute(select(StylePreset).order_by(StylePreset.name)).scalars().all()
    return [
        PresetSummary(
            id=p.id,
            name=p.name,
            style=FeatureStyleSchema(**p.style_json),
            is_builtin=p.is_builtin,
        )
        for p in presets
    ]


@router.post("", response_model=PresetSummary, status_code=201)
def create_preset(
    req: CreatePresetRequest, session: Session = Depends(get_session)
) -> PresetSummary:
    if session.execute(select(StylePreset).where(StylePreset.name == req.name)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="preset name already exists")
    preset = StylePreset(name=req.name, style_json=req.style.model_dump(), is_builtin=False)
    session.add(preset)
    session.flush()
    return PresetSummary(
        id=preset.id, name=preset.name, style=req.style, is_builtin=False
    )


@router.delete("/{preset_id}", status_code=204)
def delete_preset(preset_id: int, session: Session = Depends(get_session)) -> Response:
    p = session.get(StylePreset, preset_id)
    if p is None:
        raise HTTPException(status_code=404, detail="preset not found")
    if p.is_builtin:
        raise HTTPException(status_code=400, detail="cannot delete built-in preset")
    session.delete(p)
    return Response(status_code=204)
