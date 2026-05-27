"""Tests for synthesizing KML from raw Overpass JSON.

The synthesizer's contract: produce bytes that the existing parser ingests
without error, preserve OSM tags and their order, never lose the ``@id``, and
never round coordinates.
"""

from __future__ import annotations

import pytest

from app.kml.from_overpass import synthesize_kml
from app.kml.parse import parse_kml


# A high-precision coordinate we use to assert no rounding happens anywhere.
HIGH_PRECISION_LON = 12.3456789
HIGH_PRECISION_LAT = 45.9876543


@pytest.fixture
def overpass_result() -> dict:
    return {
        "version": 0.6,
        "generator": "Overpass API 0.7.62",
        "elements": [
            # 1. A node with name + amenity tag.
            {
                "type": "node",
                "id": 100,
                "lon": HIGH_PRECISION_LON,
                "lat": HIGH_PRECISION_LAT,
                "tags": {
                    "name": "Test Node",
                    "amenity": "prison",
                },
            },
            # 2. An open way (a road segment).
            {
                "type": "way",
                "id": 200,
                "tags": {"highway": "residential"},
                "geometry": [
                    {"lon": 1.0, "lat": 2.0},
                    {"lon": 1.5, "lat": 2.5},
                    {"lon": 2.0, "lat": 3.0},
                ],
            },
            # 3. A closed way (a polygon).
            {
                "type": "way",
                "id": 300,
                "tags": {
                    "amenity": "prison",
                    "name": "Closed Site",
                    "source": "field-survey",
                },
                "geometry": [
                    {"lon": 10.0, "lat": 20.0},
                    {"lon": 10.0, "lat": 20.1},
                    {"lon": 10.1, "lat": 20.1},
                    {"lon": 10.1, "lat": 20.0},
                    {"lon": 10.0, "lat": 20.0},
                ],
            },
            # 4. A multipolygon relation with one inner ring (a courtyard).
            {
                "type": "relation",
                "id": 400,
                "tags": {
                    "type": "multipolygon",
                    "landuse": "cemetery",
                    "name": "Cemetery with courtyard",
                },
                "members": [
                    {
                        "type": "way",
                        "ref": 401,
                        "role": "outer",
                        "geometry": [
                            {"lon": 0.0, "lat": 0.0},
                            {"lon": 0.0, "lat": 1.0},
                            {"lon": 1.0, "lat": 1.0},
                            {"lon": 1.0, "lat": 0.0},
                            {"lon": 0.0, "lat": 0.0},
                        ],
                    },
                    {
                        "type": "way",
                        "ref": 402,
                        "role": "inner",
                        "geometry": [
                            {"lon": 0.3, "lat": 0.3},
                            {"lon": 0.3, "lat": 0.7},
                            {"lon": 0.7, "lat": 0.7},
                            {"lon": 0.7, "lat": 0.3},
                            {"lon": 0.3, "lat": 0.3},
                        ],
                    },
                ],
            },
        ],
    }


def test_synthesized_kml_parses_cleanly(overpass_result: dict):
    raw = synthesize_kml("smoke test", overpass_result)
    parsed = parse_kml(raw)
    assert parsed.document_name == "smoke test"
    assert len(parsed.placemarks) == 4


def test_geometry_kinds_match_overpass_shape(overpass_result: dict):
    parsed = parse_kml(synthesize_kml("k", overpass_result))
    kinds = [pm.geometry.kind for pm in parsed.placemarks if pm.geometry]
    assert kinds == ["Point", "LineString", "Polygon", "Polygon"]


def test_polygon_with_inner_ring_round_trips(overpass_result: dict):
    parsed = parse_kml(synthesize_kml("k", overpass_result))
    relation_pm = parsed.placemarks[-1]
    assert relation_pm.geometry is not None
    assert relation_pm.geometry.kind == "Polygon"
    assert relation_pm.geometry.polygon is not None
    assert len(relation_pm.geometry.polygon.inners) == 1


def test_osm_tags_preserved_with_insertion_order(overpass_result: dict):
    parsed = parse_kml(synthesize_kml("k", overpass_result))
    closed_way_pm = parsed.placemarks[2]
    # `@id` is emitted first, then the OSM tags in the order Overpass sent them.
    assert closed_way_pm.extended_data_order == [
        "@id",
        "amenity",
        "name",
        "source",
    ]
    assert closed_way_pm.extended_data["amenity"] == "prison"
    assert closed_way_pm.extended_data["source"] == "field-survey"


def test_atid_present_and_matches_type_id(overpass_result: dict):
    parsed = parse_kml(synthesize_kml("k", overpass_result))
    expected = ["node/100", "way/200", "way/300", "relation/400"]
    assert [pm.extended_data["@id"] for pm in parsed.placemarks] == expected


def test_placemark_name_falls_back_to_type_slash_id():
    # No "name" tag → name should be "way/200".
    result = {
        "elements": [
            {
                "type": "way",
                "id": 200,
                "tags": {"highway": "residential"},
                "geometry": [
                    {"lon": 0.0, "lat": 0.0},
                    {"lon": 1.0, "lat": 1.0},
                ],
            }
        ]
    }
    parsed = parse_kml(synthesize_kml("k", result))
    assert parsed.placemarks[0].name == "way/200"


def test_placemark_name_uses_name_tag_when_present(overpass_result: dict):
    parsed = parse_kml(synthesize_kml("k", overpass_result))
    assert parsed.placemarks[0].name == "Test Node"
    assert parsed.placemarks[2].name == "Closed Site"
    assert parsed.placemarks[3].name == "Cemetery with courtyard"


def test_coordinate_precision_preserved(overpass_result: dict):
    parsed = parse_kml(synthesize_kml("k", overpass_result))
    node_pm = parsed.placemarks[0]
    assert node_pm.geometry is not None
    assert node_pm.geometry.point == f"{HIGH_PRECISION_LON},{HIGH_PRECISION_LAT}"
    # The literal high-precision token should appear in the serialised bytes too.
    raw = synthesize_kml("k", overpass_result)
    assert str(HIGH_PRECISION_LON).encode() in raw
    assert str(HIGH_PRECISION_LAT).encode() in raw


def test_non_multipolygon_relation_is_skipped():
    result = {
        "elements": [
            {
                "type": "relation",
                "id": 500,
                "tags": {"type": "route", "route": "bus"},
                "members": [],
            },
            {
                "type": "node",
                "id": 501,
                "lon": 0.0,
                "lat": 0.0,
                "tags": {"amenity": "prison"},
            },
        ]
    }
    parsed = parse_kml(synthesize_kml("k", result))
    # Only the node survived.
    assert len(parsed.placemarks) == 1
    assert parsed.placemarks[0].extended_data["@id"] == "node/501"


def test_empty_elements_yields_valid_empty_document():
    raw = synthesize_kml("empty", {"elements": []})
    parsed = parse_kml(raw)
    assert parsed.document_name == "empty"
    assert parsed.placemarks == []
