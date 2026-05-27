"""Tests for the Compose-mode auto-tiling helper.

We monkey-patch ``execute_count`` to drive the count-based branching and
``execute_query_ex`` to return canned tile responses. The helper itself
owns the bbox substitution, dedupe, and merge logic — those are what we
verify here.
"""

from __future__ import annotations

import asyncio

import pytest

from app.enrichment import overpass, overpass_tile


def _make_element(node_id: int) -> dict:
    return {
        "type": "node",
        "id": node_id,
        "lon": 15.0 + node_id * 0.001,
        "lat": 12.0,
        "tags": {"amenity": "prison"},
    }


# ---------------------------------------------------------------------------
# Branching: single-shot vs tile vs refuse
# ---------------------------------------------------------------------------


def test_small_count_single_shots(monkeypatch: pytest.MonkeyPatch) -> None:
    """Counts under COMPOSE_SINGLE_SHOT_CAP take the non-tiled path."""
    seen_calls: list[str] = []

    async def fake_count(*_a, **_kw) -> int:
        return 100

    async def fake_query_ex(ql: str, **_kw):
        seen_calls.append(ql)
        return {"elements": [_make_element(1)]}, "https://primary.test/api"

    monkeypatch.setattr(overpass, "execute_count", fake_count)
    monkeypatch.setattr(overpass, "execute_query_ex", fake_query_ex)

    data, _served = asyncio.run(
        overpass_tile.run_overpass_maybe_tiled(
            "node[amenity=prison]({{bbox}});out geom;",
            [14.0, 11.0, 16.0, 13.0],
        )
    )
    assert len(data["elements"]) == 1
    # Exactly one query — no tiling.
    assert len(seen_calls) == 1


def test_huge_count_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    """Counts over COMPOSE_HARD_CAP raise so the user sees a clear refusal
    instead of a runaway fetch."""

    async def fake_count(*_a, **_kw) -> int:
        return 200_000

    monkeypatch.setattr(overpass, "execute_count", fake_count)

    with pytest.raises(overpass.OverpassError) as exc:
        asyncio.run(
            overpass_tile.run_overpass_maybe_tiled(
                "nwr({{bbox}});out;",
                [14.0, 11.0, 16.0, 13.0],
            )
        )
    assert "200,000" in str(exc.value)


def test_mid_count_tiles_and_dedupes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Counts above the single-shot cap but under the hard cap fan out
    into tiles. Tile-boundary duplicates dedupe by (type, id)."""

    async def fake_count(*_a, **_kw) -> int:
        return 10_000  # well above the 5000 single-shot cap

    seen_queries: list[str] = []

    async def fake_query_ex(ql: str, **_kw):
        seen_queries.append(ql)
        # Return overlapping elements: each tile reports nodes 1, 2, 3 but
        # only some are "real" to that tile. Dedup should collapse to 3.
        return {"elements": [_make_element(1), _make_element(2), _make_element(3)]}, (
            "https://primary.test/api"
        )

    monkeypatch.setattr(overpass, "execute_count", fake_count)
    monkeypatch.setattr(overpass, "execute_query_ex", fake_query_ex)

    data, _ = asyncio.run(
        overpass_tile.run_overpass_maybe_tiled(
            "node[amenity=prison]({{bbox}});out geom;",
            [14.0, 11.0, 16.0, 13.0],
        )
    )
    # Multiple tile queries fired (≥ 4 for 10k features at 3000/tile target).
    assert len(seen_queries) >= 4
    # But the element list is deduped to just nodes 1, 2, 3.
    ids = sorted(el["id"] for el in data["elements"])
    assert ids == [1, 2, 3]


# ---------------------------------------------------------------------------
# Bbox substitution
# ---------------------------------------------------------------------------


def test_tile_bbox_substitution_preserves_query_shape() -> None:
    """Each tile gets ``south,west,north,east`` substituted; the rest of
    the QL is untouched."""
    out = overpass_tile._substitute_tile_bbox(
        "node[amenity=prison]({{bbox}});out geom;",
        [14.0, 11.0, 16.0, 13.0],
    )
    # Overpass order: S,W,N,E
    assert "11.0,14.0,13.0,16.0" in out
    assert "{{bbox}}" not in out
    # Surrounding QL intact.
    assert out.startswith("node[amenity=prison](")
    assert out.endswith("out geom;")


# ---------------------------------------------------------------------------
# Dedupe correctness
# ---------------------------------------------------------------------------


def test_merge_elements_dedupes_by_type_and_id() -> None:
    a = {"elements": [_make_element(1), _make_element(2)]}
    b = {"elements": [_make_element(2), _make_element(3)]}
    merged = overpass_tile._merge_elements([a, b])
    ids = [el["id"] for el in merged]
    assert ids == [1, 2, 3]  # 2 deduped, first-write-wins


def test_merge_elements_keeps_first_occurrence_data() -> None:
    """First write wins for duplicates so per-tile tag order stays stable."""
    a = {"elements": [{"type": "node", "id": 1, "tags": {"v": "from_a"}}]}
    b = {"elements": [{"type": "node", "id": 1, "tags": {"v": "from_b"}}]}
    merged = overpass_tile._merge_elements([a, b])
    assert len(merged) == 1
    assert merged[0]["tags"]["v"] == "from_a"


# ---------------------------------------------------------------------------
# Outer-statement stripping
# ---------------------------------------------------------------------------


def test_strip_outer_statements_handles_bare_out() -> None:
    """The bare ``out;`` idiom — most common Overpass Turbo export shape —
    must be stripped so ``execute_count`` doesn't wrap it as
    ``(...;out;);out count;`` which Overpass rejects with a parse error.
    Regression test for the regex that previously required whitespace after
    ``out``."""
    assert overpass_tile._strip_outer_statements("nwr({{bbox}});out;") == "nwr({{bbox}})"
    assert overpass_tile._strip_outer_statements("nwr;out;") == "nwr"
    # Multi-arg ``out body;`` / ``out geom;`` still work.
    assert overpass_tile._strip_outer_statements("nwr;out body;") == "nwr"
    assert overpass_tile._strip_outer_statements("nwr;out geom;") == "nwr"
    # Leading settings line stripped too.
    assert (
        overpass_tile._strip_outer_statements("[out:json][timeout:25];nwr;out;")
        == "nwr"
    )
    # ``[out=yes]`` is a *tag filter*, not an output directive — must NOT
    # be eaten by the trailing-out regex. (The trailing ``out;`` is.)
    assert (
        overpass_tile._strip_outer_statements("node[out=yes];out;")
        == "node[out=yes]"
    )
