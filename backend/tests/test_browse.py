"""Tests for the Browse-mode backend (Phase A5).

Covers two layers:

* :mod:`app.enrichment.area_inventory` — domain partitioning, area-cap, the
  pagination/caching contract for items, single-feature lookup with wiki link
  derivation.
* :mod:`app.api.browse` — the four router endpoints + the three modes of
  ``POST /api/browse/bake`` (single feature, bbox+query, error).

Overpass is never hit for real. We monkey-patch
``app.enrichment.overpass.execute_query`` with a recorder that returns canned
JSON fixtures keyed off the query text — same pattern as
``tests/test_api_overpass.py``.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.enrichment import area_inventory, overpass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def _isolated_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the browse cache + DB dir at a tmpdir."""
    monkeypatch.setenv("OVERPASS_STYLER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OVERPASS_STYLER_DB_URL", f"sqlite:///{tmp_path / 'test.sqlite'}")
    return tmp_path


@pytest.fixture
def small_bbox() -> tuple[float, float, float, float]:
    """A ~0.02° square around N'Djamena — well under any reasonable area cap."""
    return (15.04, 12.10, 15.06, 12.12)


@pytest.fixture
def huge_bbox() -> tuple[float, float, float, float]:
    """A bbox spanning ~5° square — comfortably above the default 200 km² cap."""
    return (10.0, 10.0, 15.0, 15.0)


@pytest.fixture
def small_area_elements() -> list[dict]:
    """A canned Overpass element set covering several domains."""
    return [
        {
            "type": "node",
            "id": 1,
            "lon": 15.045,
            "lat": 12.110,
            "tags": {"amenity": "prison", "name": "Detention A"},
        },
        {
            "type": "node",
            "id": 2,
            "lon": 15.046,
            "lat": 12.111,
            "tags": {"amenity": "prison", "name": "Detention B"},
        },
        {
            "type": "way",
            "id": 3,
            "center": {"lon": 15.05, "lat": 12.115},
            "tags": {"building": "yes"},
            "geometry": [
                {"lon": 15.05, "lat": 12.115},
                {"lon": 15.051, "lat": 12.115},
                {"lon": 15.051, "lat": 12.116},
                {"lon": 15.05, "lat": 12.115},
            ],
        },
        {
            "type": "way",
            "id": 4,
            "center": {"lon": 15.052, "lat": 12.116},
            "tags": {"building": "yes"},
            "geometry": [],
        },
        {
            "type": "way",
            "id": 5,
            "center": {"lon": 15.053, "lat": 12.117},
            "tags": {"landuse": "cemetery", "name": "Cemetery East"},
        },
        {
            "type": "node",
            "id": 6,
            "lon": 15.054,
            "lat": 12.118,
            "tags": {"highway": "stop"},
        },
        {
            "type": "way",
            "id": 7,
            "center": {"lon": 15.055, "lat": 12.119},
            "tags": {"highway": "residential"},
        },
        {
            "type": "node",
            "id": 8,
            "lon": 15.056,
            "lat": 12.120,
            "tags": {"name": "Unclassified thing"},
        },
        {
            "type": "node",
            "id": 9,
            "lon": 15.057,
            "lat": 12.121,
            "tags": {"historic": "memorial"},
        },
    ]


def _fake_query_dispatcher(call_log: list[str], responses: dict[str, dict]):
    """Build a fake ``execute_query`` that matches calls against substrings.

    ``responses`` is a dict mapping substring → JSON-ish body. The first key
    whose substring appears in the QL text wins; an unmatched query raises so
    tests don't silently swallow bugs.
    """

    async def _fake(ql: str, *, timeout: int = 25) -> dict:
        call_log.append(ql)
        for needle, body in responses.items():
            if needle in ql:
                return body
        raise AssertionError(f"unexpected Overpass query: {ql!r}")

    return _fake


# ---------------------------------------------------------------------------
# area_inventory: domain partitioning
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_area_summary_partitions_domains(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    small_bbox,
    small_area_elements,
):
    calls: list[str] = []
    fake = _fake_query_dispatcher(
        calls,
        {"out tags center;": {"elements": small_area_elements}},
    )
    monkeypatch.setattr(area_inventory.overpass, "execute_query", fake)

    result = await area_inventory.fetch_area_summary(small_bbox, area_cap_km2=1000.0)

    assert result["area_capped"] is False
    domains_by_name = {d["name"]: d for d in result["domains"]}

    # Amenities: two prisons.
    assert "Amenities" in domains_by_name
    amenities = domains_by_name["Amenities"]
    assert amenities["count"] == 2
    assert amenities["top_tags"][0] == {"key": "amenity", "value": "prison", "count": 2}

    # Buildings: two `building=yes` features.
    assert domains_by_name["Buildings"]["count"] == 2
    assert domains_by_name["Buildings"]["top_tags"][0] == {
        "key": "building",
        "value": "yes",
        "count": 2,
    }

    # Highways: a node + a way, different values.
    highways = domains_by_name["Highways"]
    assert highways["count"] == 2
    # top_tags sorted by frequency — both appear once, so just check both
    # values are present.
    assert {t["value"] for t in highways["top_tags"]} == {"stop", "residential"}

    # Landuse + Historic each have one entry.
    assert domains_by_name["Landuse"]["count"] == 1
    assert domains_by_name["Historic"]["count"] == 1

    # The unclassified element with only `name` lands in Other.
    assert domains_by_name["Other"]["count"] == 1
    # And Other carries no top_tags (no recognised domain key).
    assert domains_by_name["Other"]["top_tags"] == []

    assert result["total_count"] == len(small_area_elements)


@pytest.mark.asyncio
async def test_fetch_area_summary_top_tags_sorted_by_frequency(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    small_bbox,
):
    elements = [
        {"type": "node", "id": i, "lon": 1.0, "lat": 1.0, "tags": {"amenity": "prison"}}
        for i in range(5)
    ] + [
        {"type": "node", "id": 100 + i, "lon": 1.0, "lat": 1.0, "tags": {"amenity": "school"}}
        for i in range(2)
    ] + [
        {"type": "node", "id": 200, "lon": 1.0, "lat": 1.0, "tags": {"amenity": "police"}},
    ]
    calls: list[str] = []
    monkeypatch.setattr(
        area_inventory.overpass,
        "execute_query",
        _fake_query_dispatcher(calls, {"out tags center;": {"elements": elements}}),
    )
    result = await area_inventory.fetch_area_summary(small_bbox, area_cap_km2=1000.0)
    amenities = next(d for d in result["domains"] if d["name"] == "Amenities")
    # Sorted descending by count.
    counts = [t["count"] for t in amenities["top_tags"]]
    assert counts == sorted(counts, reverse=True)
    # And the top of the list is prison=5.
    assert amenities["top_tags"][0] == {"key": "amenity", "value": "prison", "count": 5}


@pytest.mark.asyncio
async def test_fetch_area_summary_caps_oversized_bbox(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    huge_bbox,
):
    """An area > the cap returns counts-only, no geometry, no domains list."""
    elements = [
        {"type": "node", "id": 1, "tags": {"amenity": "prison"}},
        {"type": "node", "id": 2, "tags": {"building": "yes"}},
        {"type": "node", "id": 3, "tags": {"name": "ungrouped"}},
    ]
    calls: list[str] = []
    fake = _fake_query_dispatcher(
        calls,
        {"out tags;": {"elements": elements}},
    )
    monkeypatch.setattr(area_inventory.overpass, "execute_query", fake)

    result = await area_inventory.fetch_area_summary(huge_bbox, area_cap_km2=200.0)
    assert result["area_capped"] is True
    assert result["total_count"] == 3
    assert result["domain_counts"]["Amenities"] == 1
    assert result["domain_counts"]["Buildings"] == 1
    assert result["domain_counts"]["Other"] == 1
    # No geometry should have been requested — make sure we sent the counts-only QL.
    assert any("out tags;" in q for q in calls)
    assert not any("center" in q for q in calls)


# ---------------------------------------------------------------------------
# area_inventory: items
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_domain_items_shape(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    small_bbox,
    small_area_elements,
):
    # Only return the two prisons for the `amenity=prison` query.
    prisons = [e for e in small_area_elements if e.get("tags", {}).get("amenity") == "prison"]
    calls: list[str] = []
    monkeypatch.setattr(
        area_inventory.overpass,
        "execute_query",
        _fake_query_dispatcher(calls, {'nwr["amenity"="prison"]': {"elements": prisons}}),
    )

    result = await area_inventory.fetch_domain_items(small_bbox, "amenity", "prison")
    assert result["total"] == 2
    assert result["has_more"] is False
    assert result["next_offset"] == 2
    assert {it["osm_id"] for it in result["items"]} == {"node/1", "node/2"}
    item = result["items"][0]
    assert set(item.keys()) >= {"osm_id", "name", "tags", "geometry_kind", "center"}
    assert item["geometry_kind"] == "Point"
    assert item["center"] is not None


@pytest.mark.asyncio
async def test_fetch_domain_items_paginates(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    small_bbox,
):
    elements = [
        {
            "type": "node",
            "id": i,
            "lon": 15.05,
            "lat": 12.11,
            "tags": {"amenity": "prison"},
        }
        for i in range(10)
    ]
    calls: list[str] = []
    monkeypatch.setattr(
        area_inventory.overpass,
        "execute_query",
        _fake_query_dispatcher(calls, {'nwr["amenity"="prison"]': {"elements": elements}}),
    )

    page1 = await area_inventory.fetch_domain_items(
        small_bbox, "amenity", "prison", limit=3, offset=0
    )
    assert len(page1["items"]) == 3
    assert page1["has_more"] is True
    assert page1["next_offset"] == 3

    page_last = await area_inventory.fetch_domain_items(
        small_bbox, "amenity", "prison", limit=3, offset=9
    )
    assert len(page_last["items"]) == 1
    assert page_last["has_more"] is False


# ---------------------------------------------------------------------------
# area_inventory: cache
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summary_cache_skips_second_network_call(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    small_bbox,
    small_area_elements,
):
    calls: list[str] = []
    monkeypatch.setattr(
        area_inventory.overpass,
        "execute_query",
        _fake_query_dispatcher(calls, {"out tags center;": {"elements": small_area_elements}}),
    )

    await area_inventory.fetch_area_summary(small_bbox, area_cap_km2=1000.0)
    await area_inventory.fetch_area_summary(small_bbox, area_cap_km2=1000.0)
    assert len(calls) == 1, "second call should be served from disk cache"


@pytest.mark.asyncio
async def test_items_cache_skips_second_network_call(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    small_bbox,
):
    elements = [
        {"type": "node", "id": 1, "lon": 1.0, "lat": 1.0, "tags": {"amenity": "prison"}},
    ]
    calls: list[str] = []
    monkeypatch.setattr(
        area_inventory.overpass,
        "execute_query",
        _fake_query_dispatcher(calls, {'nwr["amenity"="prison"]': {"elements": elements}}),
    )
    await area_inventory.fetch_domain_items(small_bbox, "amenity", "prison")
    await area_inventory.fetch_domain_items(small_bbox, "amenity", "prison")
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_feature_cache_skips_second_network_call(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    element = {
        "type": "node",
        "id": 42,
        "lon": 15.0,
        "lat": 12.0,
        "tags": {"amenity": "prison", "name": "Test"},
    }
    calls: list[str] = []
    monkeypatch.setattr(
        area_inventory.overpass,
        "execute_query",
        _fake_query_dispatcher(calls, {"node(42)": {"elements": [element]}}),
    )

    a = await area_inventory.fetch_single_feature("node/42")
    b = await area_inventory.fetch_single_feature("node/42")
    assert a == b
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# area_inventory: single feature wiki links
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_single_feature_builds_wiki_links(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    element = {
        "type": "way",
        "id": 99,
        "tags": {
            "amenity": "prison",
            "name": "Famous Prison",
            "wikidata": "Q12345",
            "wikipedia": "en:Famous Prison",
        },
        "geometry": [
            {"lon": 1.0, "lat": 1.0},
            {"lon": 1.1, "lat": 1.0},
            {"lon": 1.1, "lat": 1.1},
            {"lon": 1.0, "lat": 1.0},
        ],
    }
    monkeypatch.setattr(
        area_inventory.overpass,
        "execute_query",
        _fake_query_dispatcher([], {"way(99)": {"elements": [element]}}),
    )

    result = await area_inventory.fetch_single_feature("way/99")
    assert result["osm_id"] == "way/99"
    assert result["name"] == "Famous Prison"
    links_by_kind = {link["kind"]: link for link in result["wiki_links"]}
    assert "openstreetmap" in links_by_kind
    assert links_by_kind["openstreetmap"]["url"] == "https://www.openstreetmap.org/way/99"
    assert links_by_kind["wikidata"]["url"] == "https://www.wikidata.org/wiki/Q12345"
    assert links_by_kind["wikipedia"]["url"] == "https://en.wikipedia.org/wiki/Famous_Prison"
    # Geometry kind detected from the closed way.
    assert result["geometry"]["kind"] == "Polygon"


@pytest.mark.asyncio
async def test_fetch_single_feature_raises_when_not_found(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        area_inventory.overpass,
        "execute_query",
        _fake_query_dispatcher([], {"node(123)": {"elements": []}}),
    )
    with pytest.raises(overpass.OverpassError):
        await area_inventory.fetch_single_feature("node/123")


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


@pytest.fixture
def client(_isolated_data_dir: Path) -> Iterator[TestClient]:
    """Mount the browse router (+ projects, since /bake needs it) on a fresh app."""
    # Force a fresh import so the DB engine sees the env-overridden URL.
    for mod_name in list(sys.modules):
        if (
            mod_name.startswith("app.db")
            or mod_name.startswith("app.api")
            or mod_name.startswith("app.enrichment")
        ):
            del sys.modules[mod_name]

    from app.api import browse, projects  # noqa: WPS433
    from app.db.session import init_db

    init_db()

    app = FastAPI()
    app.include_router(projects.router, prefix="/api")
    app.include_router(browse.router, prefix="/api")
    with TestClient(app) as c:
        yield c


def test_inventory_endpoint(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, small_area_elements
):
    from app.enrichment import area_inventory as ai

    calls: list[str] = []
    monkeypatch.setattr(
        ai.overpass,
        "execute_query",
        _fake_query_dispatcher(calls, {"out tags center;": {"elements": small_area_elements}}),
    )

    r = client.post(
        "/api/browse/inventory",
        json={"bbox": [15.04, 12.10, 15.06, 12.12]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["area_capped"] is False
    assert body["total_count"] == len(small_area_elements)
    assert any(d["name"] == "Amenities" for d in body["domains"])


def test_items_endpoint(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    from app.enrichment import area_inventory as ai

    elements = [
        {"type": "node", "id": 1, "lon": 1.0, "lat": 1.0, "tags": {"amenity": "prison"}},
    ]
    monkeypatch.setattr(
        ai.overpass,
        "execute_query",
        _fake_query_dispatcher([], {'nwr["amenity"="prison"]': {"elements": elements}}),
    )
    r = client.get(
        "/api/browse/items",
        params={"bbox": "15.04,12.10,15.06,12.12", "key": "amenity", "value": "prison"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["osm_id"] == "node/1"


def test_item_endpoint(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    from app.enrichment import area_inventory as ai

    element = {
        "type": "node",
        "id": 1,
        "lon": 15.0,
        "lat": 12.0,
        "tags": {"amenity": "prison", "name": "Foo"},
    }
    monkeypatch.setattr(
        ai.overpass,
        "execute_query",
        _fake_query_dispatcher([], {"node(1)": {"elements": [element]}}),
    )
    r = client.get("/api/browse/item", params={"osm_id": "node/1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["osm_id"] == "node/1"
    assert body["name"] == "Foo"
    assert any(link["kind"] == "openstreetmap" for link in body["wiki_links"])


def test_bake_single_feature_matches_overpass_query_ingest(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """Single-feature bake should produce a SourceFile whose KML contains
    the same single placemark as a synthetic upload of the same element."""
    from app.enrichment import area_inventory as ai

    element = {
        "type": "node",
        "id": 1234,
        "lon": 15.05,
        "lat": 12.11,
        "tags": {"amenity": "prison", "name": "Single Feature"},
    }
    monkeypatch.setattr(
        ai.overpass,
        "execute_query",
        _fake_query_dispatcher([], {"node(1234)": {"elements": [element]}}),
    )

    # Create the destination project up-front so we can compare its layer
    # against a separately-built reference using the same synthesizer.
    proj = client.post("/api/projects", json={"name": "Bake test"}).json()
    pid = proj["id"]

    r = client.post(
        "/api/browse/bake",
        json={"project_id": pid, "name": "Single bake", "single_osm_id": "node/1234"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["project_id"] == pid
    sf_id = body["source_file"]["id"]
    assert body["source_file"]["placemark_count"] == 1

    # Inspect the underlying SourceFile and compare to a reference build.
    from app.db.models import SourceFile
    from app.db.session import SessionLocal
    from app.kml.from_overpass import synthesize_kml
    from app.kml.parse import parse_kml

    reference = synthesize_kml("Single bake", {"elements": [element]})
    ref_parsed = parse_kml(reference)
    assert len(ref_parsed.placemarks) == 1
    ref_pm = ref_parsed.placemarks[0]

    with SessionLocal() as s:
        row = s.get(SourceFile, sf_id)
        assert row is not None
        baked_parsed = parse_kml(row.raw_kml)
        assert len(baked_parsed.placemarks) == 1
        baked_pm = baked_parsed.placemarks[0]
        # Geometry + tags should match exactly (ExtendedData is the OSM tags).
        assert baked_pm.name == ref_pm.name
        assert baked_pm.extended_data == ref_pm.extended_data
        assert baked_pm.extended_data_order == ref_pm.extended_data_order
        assert baked_pm.geometry.point == ref_pm.geometry.point


def test_bake_bbox_query_creates_project_when_id_is_none(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    from app.enrichment import area_inventory as ai
    from app.api import projects as projects_module

    fake_result = {
        "elements": [
            {
                "type": "node",
                "id": 1,
                "lon": 1.0,
                "lat": 1.0,
                "tags": {"amenity": "prison"},
            }
        ]
    }

    async def fake(ql: str, *, timeout: int = 25) -> dict:
        return fake_result

    # The bake endpoint uses the projects-router's overpass binding, so patch both
    # in case the router's been re-imported into a different namespace.
    monkeypatch.setattr(ai.overpass, "execute_query", fake)
    monkeypatch.setattr(projects_module.overpass, "execute_query", fake)

    r = client.post(
        "/api/browse/bake",
        json={
            "project_id": None,
            "name": "Auto-named bake",
            "bbox": [14.0, 11.0, 16.0, 13.0],
            "query": "node[amenity=prison]({{bbox}});out geom;",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert isinstance(body["project_id"], int)
    assert body["source_file"]["placemark_count"] == 1

    # The project really exists.
    proj = client.get(f"/api/projects/{body['project_id']}").json()
    assert proj["name"] == "Auto-named bake"
    assert len(proj["source_files"]) == 1


def test_bake_without_modes_returns_400(client: TestClient):
    r = client.post(
        "/api/browse/bake",
        json={"project_id": None, "name": "nope"},
    )
    assert r.status_code == 400
    assert "single_osm_id" in r.json()["detail"] or "bbox" in r.json()["detail"]
