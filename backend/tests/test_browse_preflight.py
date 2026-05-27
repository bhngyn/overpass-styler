"""Tests for the Browse preflight endpoint + tile-grid math.

The preflight endpoint is the cheap "how big is this region?" probe that
decides whether an investigator's bbox is small enough to fetch in one
round-trip, big enough to require tiling, or hopeless. These tests cover:

* The strategy decision tree (single / tiled / refuse).
* The tile-subdivision math (NxN grid sized for ~3000 features per tile,
  capped at 12x12).
* Bbox-validation rejecting NaN / Infinity / wrong length.

Overpass is never hit for real — we monkey-patch ``execute_count`` /
``execute_query`` with canned responses, same pattern as ``test_browse.py``.
"""

from __future__ import annotations

import math
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


def _patch_count(monkeypatch: pytest.MonkeyPatch, value: int) -> list[str]:
    """Patch ``execute_count`` everywhere it's referenced; return call log."""
    calls: list[str] = []

    async def fake_count(ql_body: str, *, timeout: int | None = None, area_hint_km2: float | None = None) -> int:
        calls.append(ql_body)
        return value

    from app.api import browse as browse_module
    from app.enrichment import overpass

    monkeypatch.setattr(overpass, "execute_count", fake_count)
    monkeypatch.setattr(browse_module.overpass, "execute_count", fake_count)
    return calls


# ---------------------------------------------------------------------------
# Tile-grid math (pure)
# ---------------------------------------------------------------------------


def test_tile_grid_2x2_for_9000_features():
    """sqrt(9000 / 3000) ≈ 1.73 → ceil → 2 → 2x2 grid."""
    from app.api.browse import _plan_tile_grid

    grid, tiles = _plan_tile_grid((0.0, 0.0, 1.0, 1.0), 9000)
    assert grid.rows == 2 and grid.cols == 2
    assert len(tiles) == 4
    # Tiles tile the source bbox exactly.
    assert tiles[0] == [0.0, 0.0, 0.5, 0.5]
    assert tiles[-1] == [0.5, 0.5, 1.0, 1.0]


def test_tile_grid_4x4_for_50000_features():
    """sqrt(50000 / 3000) ≈ 4.08 → ceil → 5; should not exceed 5 but does exceed 4."""
    from app.api.browse import _plan_tile_grid

    grid, tiles = _plan_tile_grid((0.0, 0.0, 1.0, 1.0), 50000)
    # 50000 -> ceil(sqrt(50000/3000)) = ceil(4.08) = 5
    assert grid.rows == grid.cols == 5
    assert len(tiles) == 25


def test_tile_grid_caps_at_12x12():
    """Even at huge counts the grid never exceeds 12x12 = 144 tiles."""
    from app.api.browse import _plan_tile_grid

    grid, tiles = _plan_tile_grid((0.0, 0.0, 1.0, 1.0), 5_000_000)
    assert grid.rows == 12 and grid.cols == 12
    assert len(tiles) == 144


def test_tile_grid_handles_zero_count():
    """Zero count shouldn't divide-by-zero or produce a 0-dim grid."""
    from app.api.browse import _plan_tile_grid

    grid, tiles = _plan_tile_grid((0.0, 0.0, 1.0, 1.0), 0)
    assert grid.rows == 1 and grid.cols == 1
    assert len(tiles) == 1


def test_tile_grid_tiles_cover_bbox_exactly():
    """Edges of a tile grid must meet — no gaps, no overlap."""
    from app.api.browse import _plan_tile_grid

    _, tiles = _plan_tile_grid((10.0, 20.0, 14.0, 24.0), 9000)
    # 2x2 grid → 4 tiles. Last tile's east/north should equal the bbox.
    assert tiles[-1][2] == 14.0
    assert tiles[-1][3] == 24.0
    # Coverage check: the union of tiles' areas equals the source bbox.
    total = sum((t[2] - t[0]) * (t[3] - t[1]) for t in tiles)
    assert math.isclose(total, (14.0 - 10.0) * (24.0 - 20.0))


# ---------------------------------------------------------------------------
# Strategy decision (endpoint)
# ---------------------------------------------------------------------------


def test_preflight_tiny_area_short_circuits_to_single(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """Tiny bboxes skip the count call — single strategy is the cheap default."""
    calls = _patch_count(monkeypatch, value=99999)  # would-be-refuse, but ignored

    r = client.post(
        "/api/browse/preflight",
        # ~0.001° square ≈ 0.01 km² at the equator
        json={"bbox": [10.000, 10.000, 10.001, 10.001]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["strategy"] == "single"
    # Count was never called for tiny areas.
    assert calls == []


def test_preflight_small_count_is_single(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    _patch_count(monkeypatch, value=2500)

    r = client.post(
        "/api/browse/preflight",
        json={"bbox": [10.0, 10.0, 10.5, 10.5]},  # ~3000 km²
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["strategy"] == "single"
    assert body["total_count"] == 2500


def test_preflight_medium_count_triggers_tiling(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """9000 features in a normal bbox → 2x2 tile grid."""
    _patch_count(monkeypatch, value=9000)

    r = client.post(
        "/api/browse/preflight",
        json={"bbox": [10.0, 10.0, 10.5, 10.5]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["strategy"] == "tiled"
    assert body["tile_grid"] == {"rows": 2, "cols": 2}
    assert len(body["tiles"]) == 4


def test_preflight_refuses_above_count_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """> 200_000 features is refused regardless of area."""
    _patch_count(monkeypatch, value=300_000)

    r = client.post(
        "/api/browse/preflight",
        json={"bbox": [10.0, 10.0, 10.5, 10.5]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["strategy"] == "refuse"
    assert "200,000" in body["reason"] or "200000" in body["reason"]


def test_preflight_refuses_above_area_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """> 50_000 km² is refused before we even count — count call would time out."""
    calls = _patch_count(monkeypatch, value=1000)

    # ~5° square near the equator ≈ 309,000 km² — way past the area cap.
    r = client.post(
        "/api/browse/preflight",
        json={"bbox": [-5.0, -5.0, 5.0, 5.0]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["strategy"] == "refuse"
    # Count was never called — refuse-by-area short-circuits the probe.
    assert calls == []


# ---------------------------------------------------------------------------
# Bbox validation
# ---------------------------------------------------------------------------


def test_preflight_rejects_nan():
    """Validator must reject NaN at the Pydantic boundary so it never reaches
    the area / bbox math (where it would silently poison every output).
    """
    from pydantic import ValidationError
    from app.api.browse import _BBox

    with pytest.raises(ValidationError) as exc:
        _BBox(bbox=[float("nan"), 0.0, 1.0, 1.0])
    assert "not finite" in str(exc.value)


def test_preflight_rejects_infinity():
    from pydantic import ValidationError
    from app.api.browse import _BBox

    with pytest.raises(ValidationError) as exc:
        _BBox(bbox=[float("inf"), 0.0, 1.0, 1.0])
    assert "not finite" in str(exc.value)


def test_preflight_rejects_negative_infinity():
    from pydantic import ValidationError
    from app.api.browse import _BBox

    with pytest.raises(ValidationError):
        _BBox(bbox=[0.0, 0.0, 1.0, float("-inf")])


def test_preflight_rejects_wrong_length(client: TestClient):
    r = client.post("/api/browse/preflight", json={"bbox": [1.0, 2.0, 3.0]})
    assert r.status_code == 422
