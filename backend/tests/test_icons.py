"""Sanity checks for the bundled human-rights / OSINT icon set."""

from __future__ import annotations

import base64
import re
from pathlib import Path

import pytest

from app.kml.hr_icons import (
    HR_HREF_PREFIX,
    HR_ICONS,
    data_uri_for,
    hr_icon_path,
)
from app.kml.icons import _BY_ID, ALL_ICONS, palette_catalogue

ICON_DIR = Path(__file__).resolve().parent.parent / "app" / "kml" / "hr_icons"


def test_hr_registry_has_31_icons():
    assert len(HR_ICONS) == 31


def test_hr_subgroups_are_exhaustive():
    expected = {"Source", "IHL event", "Protected", "Forces", "Verification"}
    actual = {h.subgroup for h in HR_ICONS}
    assert actual == expected


def test_every_hr_icon_resolves_to_a_file():
    for icon in HR_ICONS:
        path = ICON_DIR / f"{icon.id}.png"
        assert path.is_file(), f"missing {path}"
        size = path.stat().st_size
        assert 0 < size <= 16_384, f"{icon.id} is {size} bytes — outside sanity range"


def test_every_hr_icon_is_in_the_combined_catalogue():
    for icon in HR_ICONS:
        assert icon.id in _BY_ID, f"{icon.id} missing from ALL_ICONS index"
        record = _BY_ID[icon.id]
        assert record.group == "hr"
        assert record.subgroup == icon.subgroup
        assert record.href == f"{HR_HREF_PREFIX}{icon.id}.png"


def test_catalogue_response_includes_hr_group_in_subgroup_order():
    cat = palette_catalogue()
    assert "hr" in cat
    hr_entries = cat["hr"]
    assert len(hr_entries) == 31
    # Subgroup order preserved exactly as declared in HR_ICONS.
    assert [e["subgroup"] for e in hr_entries] == [h.subgroup for h in HR_ICONS]
    # Pre-existing groups still ship their entries without a subgroup field set.
    assert all(e.get("subgroup") is None for e in cat["paddle"])


def test_hr_appears_before_google_groups():
    # First HR icon should precede the first Google icon in the master tuple,
    # so the picker's tab order naturally surfaces "hr" first.
    first_hr = next(i for i, ic in enumerate(ALL_ICONS) if ic.group == "hr")
    first_paddle = next(i for i, ic in enumerate(ALL_ICONS) if ic.group == "paddle")
    assert first_hr < first_paddle


def test_hr_icon_path_validates_against_registry():
    assert hr_icon_path("hr-src-video.png") is not None
    assert hr_icon_path("hr-src-video") is not None  # filename w/o extension
    assert hr_icon_path("does-not-exist.png") is None
    # Traversal attempts must not resolve.
    assert hr_icon_path("../../etc/passwd") is None
    assert hr_icon_path("/etc/passwd") is None
    assert hr_icon_path("..") is None


@pytest.mark.parametrize("icon_id", [i.id for i in HR_ICONS])
def test_data_uri_round_trips_to_png_bytes(icon_id: str):
    href = f"{HR_HREF_PREFIX}{icon_id}.png"
    uri = data_uri_for(href)
    assert uri is not None
    m = re.match(r"^data:image/png;base64,(.+)$", uri)
    assert m, "expected base64 PNG data URI"
    decoded = base64.b64decode(m.group(1))
    # PNG magic.
    assert decoded.startswith(b"\x89PNG\r\n\x1a\n")
    # Equals the on-disk file.
    assert decoded == (ICON_DIR / f"{icon_id}.png").read_bytes()


def test_data_uri_for_non_hr_href_is_none():
    assert data_uri_for("http://maps.google.com/mapfiles/kml/paddle/red-blank.png") is None
    assert data_uri_for("") is None
