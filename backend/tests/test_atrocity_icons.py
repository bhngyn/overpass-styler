"""Sanity checks for the bundled atrocity-investigations icon set.

This palette is the *default* the picker surfaces — it ships first in the
combined catalogue and supplies the default ``icon_href`` on new
``FeatureStyle`` blocks. The tests below pin those invariants in place so a
later refactor can't silently bury the palette behind another group.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path

import pytest

from app.kml.atrocity_icons import (
    ATROCITY_HREF_PREFIX,
    ATROCITY_ICONS,
    atrocity_icon_path,
    data_uri_for,
)
from app.kml.icons import _BY_ID, ALL_ICONS, DEFAULT_ICON, palette_catalogue

ICON_DIR = Path(__file__).resolve().parent.parent / "app" / "kml" / "atrocity_icons"

# kebab-case: lowercase ASCII letters, digits, hyphens. No leading/trailing
# hyphens, no doubles. Mirrors the URL-safety contract investigators rely on
# when these ids round-trip through KML <styleUrl> and the REST layer.
_KEBAB_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def test_atrocity_registry_is_non_empty():
    assert len(ATROCITY_ICONS) > 0


def test_atrocity_subgroups_match_the_seven_intended_buckets():
    expected = {
        "Detention",
        "Mortality",
        "Destruction",
        "Military",
        "Displacement",
        "Civilian",
        "Evidence",
    }
    actual = {i.subgroup for i in ATROCITY_ICONS}
    assert actual == expected


def test_every_atrocity_icon_resolves_to_a_png_file():
    for icon in ATROCITY_ICONS:
        path = ICON_DIR / f"{icon.id}.png"
        assert path.is_file(), f"missing {path}"
        size = path.stat().st_size
        assert 0 < size <= 16_384, f"{icon.id} is {size} bytes — outside sanity range"


def test_every_atrocity_icon_id_is_kebab_case():
    for icon in ATROCITY_ICONS:
        assert _KEBAB_RE.match(icon.id), (
            f"{icon.id!r} is not URL-safe kebab-case (no underscores, no spaces, "
            f"lowercase letters/digits separated by single hyphens)"
        )


def test_every_atrocity_icon_is_in_the_combined_catalogue():
    for icon in ATROCITY_ICONS:
        assert icon.id in _BY_ID, f"{icon.id} missing from ALL_ICONS index"
        record = _BY_ID[icon.id]
        assert record.group == "atrocity"
        assert record.subgroup == icon.subgroup
        assert record.href == f"{ATROCITY_HREF_PREFIX}{icon.id}.png"


def test_catalogue_response_includes_atrocity_group_in_subgroup_order():
    cat = palette_catalogue()
    assert "atrocity" in cat
    entries = cat["atrocity"]
    assert len(entries) == len(ATROCITY_ICONS)
    # Subgroup order preserved exactly as declared in ATROCITY_ICONS.
    assert [e["subgroup"] for e in entries] == [i.subgroup for i in ATROCITY_ICONS]


def test_atrocity_group_is_the_first_group_in_the_catalogue():
    """Frontend tab strip iterates ``Object.keys(catalogue)`` in insertion order;
    atrocity must come first so it's the default tab."""
    cat = palette_catalogue()
    assert next(iter(cat.keys())) == "atrocity"


def test_atrocity_appears_before_other_groups_in_all_icons():
    first_atrocity = next(
        i for i, ic in enumerate(ALL_ICONS) if ic.group == "atrocity"
    )
    first_other = next(
        i for i, ic in enumerate(ALL_ICONS) if ic.group != "atrocity"
    )
    assert first_atrocity < first_other


def test_default_icon_is_atrocity_incident_marker():
    assert DEFAULT_ICON.group == "atrocity"
    assert DEFAULT_ICON.id == "incident-marker"
    assert DEFAULT_ICON.href == f"{ATROCITY_HREF_PREFIX}incident-marker.png"


def test_atrocity_icon_path_validates_against_registry():
    assert atrocity_icon_path("incident-marker.png") is not None
    assert atrocity_icon_path("incident-marker") is not None  # filename w/o extension
    assert atrocity_icon_path("does-not-exist.png") is None
    # Traversal attempts must not resolve.
    assert atrocity_icon_path("../../etc/passwd") is None
    assert atrocity_icon_path("/etc/passwd") is None
    assert atrocity_icon_path("..") is None


@pytest.mark.parametrize("icon_id", [i.id for i in ATROCITY_ICONS])
def test_data_uri_round_trips_to_png_bytes(icon_id: str):
    href = f"{ATROCITY_HREF_PREFIX}{icon_id}.png"
    uri = data_uri_for(href)
    assert uri is not None
    m = re.match(r"^data:image/png;base64,(.+)$", uri)
    assert m, "expected base64 PNG data URI"
    decoded = base64.b64decode(m.group(1))
    # PNG magic.
    assert decoded.startswith(b"\x89PNG\r\n\x1a\n")
    # Equals the on-disk file.
    assert decoded == (ICON_DIR / f"{icon_id}.png").read_bytes()


def test_data_uri_for_non_atrocity_href_is_none():
    # HR-palette URLs and Google URLs must NOT resolve through atrocity's
    # ``data_uri_for`` — each palette only inlines its own icons. The
    # serializer composes palettes; one palette doesn't shadow another.
    assert data_uri_for("/api/icons/hr/hr-src-video.png") is None
    assert (
        data_uri_for("http://maps.google.com/mapfiles/kml/paddle/red-blank.png")
        is None
    )
    assert data_uri_for("") is None
