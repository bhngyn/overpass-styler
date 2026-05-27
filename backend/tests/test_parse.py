"""Parser tests against the real Chad fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.kml.parse import parse_kml


def test_parse_prisons_structure(prisons_path: Path):
    doc = parse_kml(str(prisons_path))
    assert doc.document_name == "overpass-turbo.eu export"
    assert len(doc.placemarks) == 6

    # Mix of geometry types.
    kinds = [p.geometry.kind for p in doc.placemarks if p.geometry]
    assert "Polygon" in kinds
    assert "Point" in kinds

    # All prisons should carry amenity=prison.
    for p in doc.placemarks:
        assert p.extended_data["amenity"] == "prison"
        assert p.osm_id is not None
        assert p.osm_id.startswith(("way/", "node/", "relation/"))


def test_parse_cemeteries_volume(cemeteries_path: Path):
    doc = parse_kml(str(cemeteries_path))
    assert len(doc.placemarks) > 90
    assert all(
        p.extended_data.get("landuse") == "cemetery" for p in doc.placemarks
    ), "every cemetery placemark should carry landuse=cemetery"


def test_extended_data_order_preserved(prisons_path: Path):
    doc = parse_kml(str(prisons_path))
    # First placemark in chad_prisons.kml has multilingual names; order matters
    # for the inspector UI.
    first_with_names = next(
        (p for p in doc.placemarks if "name:fr" in p.extended_data),
        None,
    )
    assert first_with_names is not None
    keys = first_with_names.extended_data_order
    assert keys.index("@id") < keys.index("amenity")
    assert keys.index("name") < keys.index("name:ar")


def test_polygon_coordinates_intact(prisons_path: Path):
    doc = parse_kml(str(prisons_path))
    poly_placemark = next(p for p in doc.placemarks if p.geometry and p.geometry.kind == "Polygon")
    coords = poly_placemark.geometry.polygon.outer
    # Tokens should look like "lon,lat".
    tokens = coords.split()
    assert len(tokens) >= 4
    for tok in tokens:
        parts = tok.split(",")
        assert len(parts) in (2, 3)
        lon, lat = float(parts[0]), float(parts[1])
        # Chad fits roughly in this box.
        assert 13.0 < lon < 25.0
        assert 7.0 < lat < 24.0


def test_representative_point(prisons_path: Path):
    doc = parse_kml(str(prisons_path))
    for p in doc.placemarks:
        if p.geometry is None:
            continue
        rep = p.geometry.representative_lonlat()
        assert rep is not None
        lon, lat = rep
        assert 13.0 < lon < 25.0 and 7.0 < lat < 24.0


def test_parse_accepts_bytes(prisons_path: Path):
    raw = prisons_path.read_bytes()
    doc = parse_kml(raw)
    assert len(doc.placemarks) == 6


@pytest.mark.parametrize("count_field", ["placemarks"])
def test_no_data_loss(fixture_path: Path, count_field: str):
    """Every <Placemark> in the file must end up in the parsed model."""
    raw = fixture_path.read_text()
    file_count = raw.count("<Placemark")
    doc = parse_kml(raw)
    assert len(doc.placemarks) == file_count
