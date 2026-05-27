"""Curated icon set for war-crimes / atrocity investigations.

Hand-drawn 96x96 white-silhouette PNGs organised around the documentation
vocabulary investigators actually use in the field: where people were held,
where they died, what was destroyed, who was there, where civilians fled,
which protected civilian objects were affected, and what evidence anchors
each placemark.

The PNGs are bundled bytes — built once via ``scripts/build_atrocity_icons.py``
and committed. At runtime the file-serving route streams them for the UI, and
the KML serializer inlines them as ``data:image/png;base64,…`` so exported
KMLs remain self-contained.

This palette is the *default* for new categories; the older ``hr_icons``
palette is preserved alongside it for back-compat.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path

_HERE = Path(__file__).resolve().parent


@dataclass(frozen=True)
class AtrocityIcon:
    id: str
    label: str
    subgroup: str
    """One of: Detention | Mortality | Destruction | Military |
    Displacement | Civilian | Evidence."""


# Ordered list — preserves intended subgroup grouping in the picker grid.
ATROCITY_ICONS: tuple[AtrocityIcon, ...] = (
    # Detention — where people are held against their will.
    AtrocityIcon("detention-facility", "Detention facility", "Detention"),
    AtrocityIcon("prison", "Prison", "Detention"),
    AtrocityIcon("secret-detention", "Secret detention site", "Detention"),
    AtrocityIcon("holding-cell", "Holding cell", "Detention"),
    AtrocityIcon("interrogation-site", "Interrogation site", "Detention"),
    # Mortality — graves, recovery, and morgues.
    AtrocityIcon("mass-grave", "Mass grave", "Mortality"),
    AtrocityIcon("individual-grave", "Individual grave", "Mortality"),
    AtrocityIcon("body-recovery", "Body recovery", "Mortality"),
    AtrocityIcon("mortuary", "Mortuary", "Mortality"),
    AtrocityIcon("cemetery", "Cemetery", "Mortality"),
    # Destruction — physical damage to the built environment.
    AtrocityIcon("destroyed-building", "Destroyed building", "Destruction"),
    AtrocityIcon("damaged-infra", "Damaged infrastructure", "Destruction"),
    AtrocityIcon("burnt-structure", "Burnt structure", "Destruction"),
    AtrocityIcon("shelled-site", "Shelled site", "Destruction"),
    AtrocityIcon("demolished", "Demolished", "Destruction"),
    # Military — armed-forces presence and materiel.
    AtrocityIcon("military-base", "Military base", "Military"),
    AtrocityIcon("checkpoint", "Checkpoint", "Military"),
    AtrocityIcon("weapons-cache", "Weapons cache", "Military"),
    AtrocityIcon("artillery", "Artillery position", "Military"),
    AtrocityIcon("blast-crater", "Blast crater", "Military"),
    AtrocityIcon("munitions", "Munitions / ordnance", "Military"),
    # Displacement — civilian movement away from harm.
    AtrocityIcon("idp-camp", "IDP camp", "Displacement"),
    AtrocityIcon("refugee-camp", "Refugee camp", "Displacement"),
    AtrocityIcon("evacuation-point", "Evacuation point", "Displacement"),
    AtrocityIcon("border-crossing", "Border crossing", "Displacement"),
    AtrocityIcon("transit-route", "Transit route", "Displacement"),
    # Civilian — protected objects under IHL.
    AtrocityIcon("school", "School", "Civilian"),
    AtrocityIcon("hospital", "Hospital", "Civilian"),
    AtrocityIcon("religious-site", "Religious site", "Civilian"),
    AtrocityIcon("market", "Market", "Civilian"),
    AtrocityIcon("water-source", "Water source", "Civilian"),
    AtrocityIcon("power-station", "Power station", "Civilian"),
    # Evidence — the kind of confirmation pinned to a placemark.
    AtrocityIcon("witness", "Witness testimony", "Evidence"),
    AtrocityIcon("photo-video", "Photo / video", "Evidence"),
    AtrocityIcon("satellite-confirmed", "Satellite confirmed", "Evidence"),
    AtrocityIcon("suspected", "Suspected / unconfirmed", "Evidence"),
    AtrocityIcon("incident-marker", "Incident marker", "Evidence"),
)


ATROCITY_HREF_PREFIX = "/api/icons/atrocity/"
"""URL prefix the UI and stored styles use. Serializer detects this to inline."""


def _png_path(icon_id: str) -> Path:
    return _HERE / f"{icon_id}.png"


def atrocity_icon_path(filename: str) -> Path | None:
    """Resolve a request like 'detention-facility.png' to a real file, or None.

    Validates against the registry to block path-traversal (``..``) and
    arbitrary filename lookups.
    """
    stem = filename[:-4] if filename.endswith(".png") else filename
    if stem not in _BY_ID:
        return None
    path = _png_path(stem)
    return path if path.is_file() else None


_BY_ID: dict[str, AtrocityIcon] = {i.id: i for i in ATROCITY_ICONS}


# Pre-encoded data URIs for the export path — built once at import.
def _build_data_uris() -> dict[str, str]:
    out: dict[str, str] = {}
    for icon in ATROCITY_ICONS:
        path = _png_path(icon.id)
        if not path.is_file():
            continue
        b64 = base64.b64encode(path.read_bytes()).decode("ascii")
        out[f"{ATROCITY_HREF_PREFIX}{icon.id}.png"] = f"data:image/png;base64,{b64}"
    return out


_DATA_URI_BY_HREF: dict[str, str] = _build_data_uris()


def data_uri_for(href: str) -> str | None:
    """If ``href`` is an atrocity-icon URL, return its embed-ready data: URI.

    Returns None for any other href, including hrefs from the older
    ``hr_icons`` palette or Google's hosted icons.
    """
    if not href.startswith(ATROCITY_HREF_PREFIX):
        return None
    return _DATA_URI_BY_HREF.get(href)
