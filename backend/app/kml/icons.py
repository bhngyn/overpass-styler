"""Google Earth Pro built-in icon palette.

These URLs are stable, hosted by Google, and Earth Pro renders them without any extra
configuration. Surfacing them as a typed catalogue lets the frontend show a thumbnail
grid instead of asking investigators to paste URLs.

The palette is grouped — investigators in the field tend to want either a coloured
paddle (categorical labelling) or a coloured shape (severity / type). The pal2..pal5
sheets each contain 16 thematic glyphs at the same URL base.
"""

from __future__ import annotations

from dataclasses import dataclass

from .hr_icons import HR_ICONS, HR_HREF_PREFIX

_BASE = "http://maps.google.com/mapfiles/kml/"


@dataclass(frozen=True)
class Icon:
    id: str
    label: str
    href: str
    group: str
    subgroup: str | None = None
    """Optional grouping label rendered inside a group's grid in the UI."""


def _paddle(color: str) -> Icon:
    return Icon(
        id=f"paddle-{color}",
        label=f"Paddle ({color})",
        href=f"{_BASE}paddle/{color}-blank.png",
        group="paddle",
    )


def _shape(name: str) -> Icon:
    return Icon(
        id=f"shape-{name}",
        label=name.replace("_", " ").title(),
        href=f"{_BASE}shapes/{name}.png",
        group="shapes",
    )


def _pal(sheet: int, index: int) -> Icon:
    return Icon(
        id=f"pal{sheet}-{index}",
        label=f"Palette {sheet} · {index}",
        href=f"{_BASE}pal{sheet}/icon{index}.png",
        group=f"pal{sheet}",
    )


PADDLES: tuple[Icon, ...] = tuple(
    _paddle(c)
    for c in (
        "red", "orange", "ylw", "grn", "ltblu", "blu", "purple", "pink", "wht",
    )
)

SHAPES: tuple[Icon, ...] = tuple(
    _shape(n)
    for n in (
        "placemark_circle", "placemark_square",
        "triangle", "square", "diamond", "star", "cross-hairs",
        "open-diamond", "donut", "forbidden",
        "info", "info-i", "caution", "flag",
    )
)

PAL2: tuple[Icon, ...] = tuple(_pal(2, i) for i in range(64))
PAL3: tuple[Icon, ...] = tuple(_pal(3, i) for i in range(64))
PAL4: tuple[Icon, ...] = tuple(_pal(4, i) for i in range(64))
PAL5: tuple[Icon, ...] = tuple(_pal(5, i) for i in range(64))

# Curated human-rights / OSINT set. White-silhouette PNGs bundled with the
# backend; surfaced to the UI under /api/icons/hr/ and inlined as data: URIs
# in exported KMLs.
HR: tuple[Icon, ...] = tuple(
    Icon(
        id=h.id,
        label=h.label,
        href=f"{HR_HREF_PREFIX}{h.id}.png",
        group="hr",
        subgroup=h.subgroup,
    )
    for h in HR_ICONS
)

ALL_ICONS: tuple[Icon, ...] = HR + PADDLES + SHAPES + PAL2 + PAL3 + PAL4 + PAL5

DEFAULT_ICON: Icon = next(i for i in PADDLES if i.id == "paddle-ylw")

_BY_ID: dict[str, Icon] = {i.id: i for i in ALL_ICONS}


def icon_by_id(icon_id: str) -> Icon:
    try:
        return _BY_ID[icon_id]
    except KeyError as exc:
        raise KeyError(f"unknown icon id: {icon_id!r}") from exc


def palette_catalogue() -> dict[str, list[dict[str, str | None]]]:
    """Shape suitable for sending to the frontend icon picker.

    Each entry carries `id`, `label`, `href`, and an optional `subgroup`
    (used by the picker to render dividers inside a single group's grid).
    """
    grouped: dict[str, list[dict[str, str | None]]] = {}
    for icon in ALL_ICONS:
        grouped.setdefault(icon.group, []).append(
            {
                "id": icon.id,
                "label": icon.label,
                "href": icon.href,
                "subgroup": icon.subgroup,
            }
        )
    return grouped
