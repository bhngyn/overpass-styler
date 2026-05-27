"""Tests for the tiled-inventory aggregation endpoint.

``POST /api/browse/inventory-tiled`` accepts the tile list emitted by the
preflight planner, fetches the per-tile summary for each, and rolls them
up into a single inventory response. Tile failures are tolerated and
surfaced via ``partial`` / ``failed_tiles`` so the investigator can see
which slices we couldn't reach.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def _isolated_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("OVERPASS_STYLER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OVERPASS_STYLER_DB_URL", f"sqlite:///{tmp_path / 'test.sqlite'}")
    return tmp_path


@pytest.fixture
def client(_isolated_data_dir: Path) -> Iterator[TestClient]:
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


def _patch_dispatch(monkeypatch: pytest.MonkeyPatch, dispatch):
    """Patch ``execute_query`` everywhere area_inventory looks for it."""
    from app.enrichment import area_inventory, overpass

    monkeypatch.setattr(area_inventory.overpass, "execute_query", dispatch)
    monkeypatch.setattr(overpass, "execute_query", dispatch)


# ---------------------------------------------------------------------------
# Successful aggregation across tiles
# ---------------------------------------------------------------------------


def test_tiled_inventory_aggregates_overlapping_domains(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """Two tiles, both with Amenities → counts add up across tiles."""

    # tile_a contains 2 prisons, tile_b contains 1 prison + 1 school.
    # Use small bboxes (under the 200 km² area cap) so the tile-summary
    # fetches stay on the rich-domains path, not the counts-only fallback.
    tile_a_elements = [
        {"type": "node", "id": 1, "lon": 0.001, "lat": 0.001, "tags": {"amenity": "prison"}},
        {"type": "node", "id": 2, "lon": 0.002, "lat": 0.002, "tags": {"amenity": "prison"}},
    ]
    tile_b_elements = [
        {"type": "node", "id": 3, "lon": 0.011, "lat": 0.001, "tags": {"amenity": "prison"}},
        {"type": "node", "id": 4, "lon": 0.012, "lat": 0.002, "tags": {"amenity": "school"}},
    ]

    async def dispatch(ql: str, *, timeout: int = 25, area_hint_km2=None) -> dict:
        # Route by the SWNE token embedded in the QL.
        if "0.0,0.0,0.01,0.01" in ql:
            return {"elements": tile_a_elements}
        if "0.0,0.01,0.01,0.02" in ql:
            return {"elements": tile_b_elements}
        raise AssertionError(f"unexpected QL: {ql!r}")

    _patch_dispatch(monkeypatch, dispatch)

    r = client.post(
        "/api/browse/inventory-tiled",
        json={
            "tiles": [
                [0.0, 0.0, 0.01, 0.01],   # → SWNE 0,0,0.01,0.01
                [0.01, 0.0, 0.02, 0.01],  # → SWNE 0,0.01,0.01,0.02
            ]
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["partial"] is False
    assert body["failed_tiles"] == []
    assert body["tile_count"] == 2
    assert body["total_count"] == 4

    # Aggregated Amenities should be 3 (2 prisons + 1 prison + 1 school = 4 amenities).
    by_name = {d["name"]: d for d in body["domains"]}
    assert "Amenities" in by_name
    assert by_name["Amenities"]["count"] == 4
    # Top tags: prison should outrank school (3 vs 1).
    top = by_name["Amenities"]["top_tags"]
    assert top[0]["value"] == "prison"
    assert top[0]["count"] == 3
    # School is in the list, count 1.
    assert any(t["value"] == "school" and t["count"] == 1 for t in top)


def test_tiled_inventory_handles_partial_failure(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """If a tile errors, the response still returns the successful tiles
    plus a ``partial: true`` flag and the failed bbox list."""
    from app.enrichment import overpass

    async def dispatch(ql: str, *, timeout: int = 25, area_hint_km2=None) -> dict:
        if "0.0,0.0,0.01,0.01" in ql:
            return {
                "elements": [
                    {
                        "type": "node",
                        "id": 1,
                        "lon": 0.005,
                        "lat": 0.005,
                        "tags": {"amenity": "prison"},
                    }
                ]
            }
        if "0.0,0.01,0.01,0.02" in ql:
            raise overpass.OverpassError("simulated tile failure")
        raise AssertionError(f"unexpected QL: {ql!r}")

    _patch_dispatch(monkeypatch, dispatch)

    failing_tile = [0.01, 0.0, 0.02, 0.01]
    good_tile = [0.0, 0.0, 0.01, 0.01]
    r = client.post(
        "/api/browse/inventory-tiled",
        json={"tiles": [good_tile, failing_tile]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["partial"] is True
    assert body["failed_tiles"] == [failing_tile]
    assert body["tile_count"] == 2
    # Successful tile's data still aggregated.
    assert body["total_count"] == 1
    by_name = {d["name"]: d for d in body["domains"]}
    assert by_name["Amenities"]["count"] == 1


def test_tiled_inventory_rejects_nan_in_tile():
    """Bbox validation rejects NaN at the Pydantic boundary."""
    from pydantic import ValidationError
    from app.api.browse import TiledInventoryRequest

    with pytest.raises(ValidationError):
        TiledInventoryRequest(tiles=[[float("nan"), 0.0, 1.0, 1.0]])


def test_tiled_inventory_rejects_empty_tile_list(client: TestClient):
    r = client.post("/api/browse/inventory-tiled", json={"tiles": []})
    assert r.status_code == 422


def test_tiled_inventory_caps_tile_count(client: TestClient):
    """144 tiles is the upper bound — 145 is rejected."""
    too_many = [[0.0, 0.0, 0.001, 0.001]] * 145
    r = client.post("/api/browse/inventory-tiled", json={"tiles": too_many})
    assert r.status_code == 422
