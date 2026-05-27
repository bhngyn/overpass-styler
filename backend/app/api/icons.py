"""Expose the Earth Pro icon palette to the frontend, plus serve the bundled
human-rights / OSINT PNG assets."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.kml.atrocity_icons import atrocity_icon_path
from app.kml.hr_icons import hr_icon_path
from app.kml.icons import palette_catalogue

router = APIRouter(prefix="/icons", tags=["icons"])


@router.get("")
def list_icons() -> dict[str, list[dict[str, str | None]]]:
    return palette_catalogue()


@router.get("/hr/{filename}")
def hr_icon(filename: str) -> FileResponse:
    """Serve one bundled HR icon PNG. Filename is validated against the
    registry, so traversal segments like `..` resolve to 404."""
    path = hr_icon_path(filename)
    if path is None:
        raise HTTPException(status_code=404, detail="unknown icon")
    # Long cache: bytes are content-addressed by the registry; redeploys
    # change the asset hash via filename if we ever version them.
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/atrocity/{filename}")
def atrocity_icon(filename: str) -> FileResponse:
    """Serve one bundled atrocity-palette icon PNG. Filename is validated
    against the registry, so traversal segments like `..` resolve to 404."""
    path = atrocity_icon_path(filename)
    if path is None:
        raise HTTPException(status_code=404, detail="unknown icon")
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
