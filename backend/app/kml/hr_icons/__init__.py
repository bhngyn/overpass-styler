"""Curated human-rights / OSINT icon set.

Hand-drawn 96x96 white-silhouette PNGs designed around the Berkeley Protocol's
workflow vocabulary: investigators tag each placemark with *what kind of source
produced it*, *what IHL event it depicts*, *what protected object is involved*,
*which actor*, and *what verification state it sits in*.

The PNGs are bundled bytes — built once via `scripts/build_hr_icons.py` and
committed. At runtime the file-serving route streams them for the UI, and the
KML serializer inlines them as `data:image/png;base64,…` so exported KMLs
remain self-contained.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path

_HERE = Path(__file__).resolve().parent


@dataclass(frozen=True)
class HrIcon:
    id: str
    label: str
    subgroup: str  # "Source" | "IHL event" | "Protected" | "Forces" | "Verification"


# Ordered list — preserves intended subgroup grouping in the picker grid.
HR_ICONS: tuple[HrIcon, ...] = (
    # Source — what kind of OSINT artefact placed this point.
    HrIcon("hr-src-video", "UGC video", "Source"),
    HrIcon("hr-src-photo", "UGC photo", "Source"),
    HrIcon("hr-src-satellite", "Satellite imagery", "Source"),
    HrIcon("hr-src-drone", "Drone / aerial", "Source"),
    HrIcon("hr-src-social", "Social-media post", "Source"),
    HrIcon("hr-src-broadcast", "News / broadcast", "Source"),
    HrIcon("hr-src-document", "Official document", "Source"),
    HrIcon("hr-src-witness", "Witness testimony", "Source"),
    # IHL event / violation.
    HrIcon("hr-evt-shelling", "Shelling impact", "IHL event"),
    HrIcon("hr-evt-airstrike", "Airstrike", "IHL event"),
    HrIcon("hr-evt-casualty", "Civilian casualty", "IHL event"),
    HrIcon("hr-evt-mass-grave", "Mass grave", "IHL event"),
    HrIcon("hr-evt-detention", "Detention site", "IHL event"),
    HrIcon("hr-evt-displacement", "Forced displacement", "IHL event"),
    HrIcon("hr-evt-attack-civilian", "Attack on civilians", "IHL event"),
    HrIcon("hr-evt-indiscriminate", "Indiscriminate weapon", "IHL event"),
    # Protected object — under Geneva Conventions / 1954 Hague.
    HrIcon("hr-prot-medical", "Medical facility", "Protected"),
    HrIcon("hr-prot-school", "School", "Protected"),
    HrIcon("hr-prot-religious", "Religious site", "Protected"),
    HrIcon("hr-prot-heritage", "Cultural heritage", "Protected"),
    HrIcon("hr-prot-water", "Water / sanitation", "Protected"),
    HrIcon("hr-prot-press", "Press / journalist", "Protected"),
    # Forces & arms.
    HrIcon("hr-force-military", "Military position", "Forces"),
    HrIcon("hr-force-checkpoint", "Checkpoint", "Forces"),
    HrIcon("hr-force-armor", "Armoured vehicle", "Forces"),
    HrIcon("hr-force-weapon", "Weapon / munition", "Forces"),
    HrIcon("hr-force-border", "Border crossing", "Forces"),
    # Verification status — Berkeley Protocol's verification dimension.
    HrIcon("hr-ver-verified", "Verified", "Verification"),
    HrIcon("hr-ver-corroborated", "Multi-source corroborated", "Verification"),
    HrIcon("hr-ver-pending", "Pending verification", "Verification"),
    HrIcon("hr-ver-disputed", "Disputed / contradicted", "Verification"),
)


HR_HREF_PREFIX = "/api/icons/hr/"
"""URL prefix the UI and stored styles use. Serializer detects this to inline."""


def _png_path(icon_id: str) -> Path:
    return _HERE / f"{icon_id}.png"


def hr_icon_path(filename: str) -> Path | None:
    """Resolve a request like 'hr-src-video.png' to a real file, or None.

    Validates against the registry to block path-traversal (`..`) and arbitrary
    filename lookups.
    """
    stem = filename[:-4] if filename.endswith(".png") else filename
    if stem not in _BY_ID:
        return None
    path = _png_path(stem)
    return path if path.is_file() else None


_BY_ID: dict[str, HrIcon] = {i.id: i for i in HR_ICONS}


# Pre-encoded data URIs for the export path — built once at import.
def _build_data_uris() -> dict[str, str]:
    out: dict[str, str] = {}
    for icon in HR_ICONS:
        path = _png_path(icon.id)
        if not path.is_file():
            continue
        b64 = base64.b64encode(path.read_bytes()).decode("ascii")
        out[f"{HR_HREF_PREFIX}{icon.id}.png"] = f"data:image/png;base64,{b64}"
    return out


_DATA_URI_BY_HREF: dict[str, str] = _build_data_uris()


def data_uri_for(href: str) -> str | None:
    """If `href` is an HR icon URL, return its embed-ready data: URI."""
    return _DATA_URI_BY_HREF.get(href)
