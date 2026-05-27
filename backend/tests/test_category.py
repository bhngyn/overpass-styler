from __future__ import annotations

from pathlib import Path

from app.kml.category import detect_category_key, is_meta_key, primary_tag
from app.kml.parse import parse_kml


def test_meta_keys_recognised():
    for k in ["@id", "name", "name:ar", "addr:city", "source", "fixme", "project:eurosha_2012"]:
        assert is_meta_key(k), f"{k} should be meta"
    for k in ["amenity", "landuse", "religion", "denomination"]:
        assert not is_meta_key(k), f"{k} should NOT be meta"


def test_primary_tag_prefers_amenity():
    data = {"@id": "node/1", "name": "X", "religion": "christian", "amenity": "prison"}
    assert primary_tag(data) == "amenity"


def test_primary_tag_falls_back_to_only_candidate():
    data = {"@id": "node/1", "religion": "christian"}
    assert primary_tag(data) == "religion"


def test_primary_tag_returns_none_when_only_meta():
    assert primary_tag({"@id": "node/1", "name": "X", "addr:city": "Y"}) is None


def test_detect_category_key_prisons(prisons_path: Path):
    doc = parse_kml(str(prisons_path))
    key = detect_category_key(p.extended_data for p in doc.placemarks)
    assert key == "amenity"


def test_detect_category_key_cemeteries(cemeteries_path: Path):
    doc = parse_kml(str(cemeteries_path))
    key = detect_category_key(p.extended_data for p in doc.placemarks)
    assert key == "landuse"
