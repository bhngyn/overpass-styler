"""Tests for the Tag Library backend (Phase A4).

Covers:

* Curated glossary integrity (size, uniqueness, non-empty field notes).
* Taginfo client cache write-then-read (no network on second call).
* Router endpoints — curated passthrough + merged ``/tag`` shape.

Network is mocked via :class:`httpx.MockTransport`; tests never hit the real
Taginfo endpoint.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.enrichment import taginfo
from app.kml.atrocity_icons import ATROCITY_ICONS
from app.kml.tag_glossary import all_entries, find

# ---------------------------------------------------------------------------
# Glossary
# ---------------------------------------------------------------------------


def test_glossary_has_enough_entries():
    assert len(all_entries()) >= 30


def test_every_entry_has_substantial_field_note():
    for entry in all_entries():
        assert len(entry.field_note) >= 30, (
            f"{entry.id}: field_note too short ({len(entry.field_note)} chars)"
        )


def test_every_glossary_icon_id_resolves_in_atrocity_palette():
    """Catches drift between glossary's `default_icon_id` and the atrocity palette.

    Either field may be `None` (some entries are general-purpose and don't
    suggest a specific icon), but if specified it must exist.
    """
    palette = {icon.id for icon in ATROCITY_ICONS}
    for entry in all_entries():
        if entry.default_icon_id is None:
            continue
        assert entry.default_icon_id in palette, (
            f"glossary entry {entry.id!r} points at icon "
            f"{entry.default_icon_id!r} which is not in ATROCITY_ICONS"
        )


def test_every_entry_has_unique_id():
    ids = [e.id for e in all_entries()]
    assert len(set(ids)) == len(ids), f"duplicate glossary ids: {ids}"


def test_find_amenity_prison():
    matches = find("amenity", "prison")
    assert matches, "expected at least one curated entry for amenity=prison"
    assert any(e.id == "amenity-prison" for e in matches)


def test_find_returns_wildcard_for_unmatched_value():
    """``find(key, value)`` on a key with only a wildcard entry returns it."""
    matches = find("note", "some-random-text")
    assert matches, "expected the note=* wildcard entry to match any value"
    assert all(e.key == "note" for e in matches)


def test_seven_domains_covered():
    domains = {e.domain for e in all_entries()}
    assert domains >= {
        "detention",
        "mortality",
        "destruction",
        "military",
        "displacement",
        "civilian",
        "evidence",
    }


# ---------------------------------------------------------------------------
# Taginfo client (cache + mocked network)
# ---------------------------------------------------------------------------


@pytest.fixture
def _isolated_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the taginfo cache + DB dir at a tmpdir and reset the rate-limit."""
    monkeypatch.setenv("OVERPASS_STYLER_DATA_DIR", str(tmp_path))
    # Reset the module-level rate-limit floor so prior tests can't bleed in.
    taginfo._LAST_CALL = 0.0
    return tmp_path


def _make_mock_client(handler) -> None:
    """Patch httpx.AsyncClient inside taginfo to use a MockTransport."""
    transport = httpx.MockTransport(handler)

    class _Patched(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):
            kwargs.setdefault("transport", transport)
            super().__init__(*args, **kwargs)

    return _Patched


@pytest.mark.asyncio
async def test_taginfo_cache_write_then_read(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """First call hits the (mocked) network and writes to disk; second call
    returns the cached payload without invoking the transport."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(
            200,
            json={
                "url": "https://taginfo.openstreetmap.org/api/4/key/values",
                "data": [
                    {"value": "prison", "count": 12345, "fraction": 0.01},
                    {"value": "school", "count": 67890, "fraction": 0.05},
                ],
            },
        )

    monkeypatch.setattr(taginfo.httpx, "AsyncClient", _make_mock_client(handler))

    first = await taginfo.get_values("amenity", limit=10)
    assert len(first) == 2
    assert first[0]["value"] == "prison"
    assert len(calls) == 1, "first call should hit the mocked transport"

    # Second call: cache hit, no transport invocation.
    second = await taginfo.get_values("amenity", limit=10)
    assert second == first
    assert len(calls) == 1, "second call should NOT hit the network"

    # And the cache file exists on disk under the configured data dir.
    cache_dir = _isolated_data_dir / "taginfo-cache"
    assert cache_dir.exists()
    cache_files = list(cache_dir.glob("key-values-*.json"))
    assert cache_files, "expected a cache file to be written"


@pytest.mark.asyncio
async def test_taginfo_get_tag_returns_dict(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "url": "https://taginfo.openstreetmap.org/api/4/tag/wiki_pages",
                "data": [
                    {
                        "lang": "en",
                        "title": "Tag:amenity=prison",
                        "description": "A place where people are held against their will.",
                    }
                ],
            },
        )

    monkeypatch.setattr(taginfo.httpx, "AsyncClient", _make_mock_client(handler))

    payload = await taginfo.get_tag("amenity", "prison")
    assert isinstance(payload, dict)
    assert payload["data"][0]["title"] == "Tag:amenity=prison"


@pytest.mark.asyncio
async def test_taginfo_http_error_raises(
    _isolated_data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="service down")

    monkeypatch.setattr(taginfo.httpx, "AsyncClient", _make_mock_client(handler))

    with pytest.raises(taginfo.TaginfoError):
        await taginfo.get_keys(min_count=0)


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


@pytest.fixture
def client(_isolated_data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Mount the tag_library router on a clean FastAPI app under /api."""
    # Force a fresh import so the router picks up the patched taginfo module
    # (the route handlers import the helpers at call-time, but being defensive
    # here matches the smoke-test fixture and keeps test isolation strong).
    for mod_name in list(sys.modules):
        if mod_name.startswith("app.api.tag_library"):
            del sys.modules[mod_name]

    from app.api import tag_library  # noqa: WPS433 (intentional reimport)

    app = FastAPI()
    app.include_router(tag_library.router, prefix="/api")
    with TestClient(app) as c:
        yield c


def test_curated_endpoint_returns_full_glossary(client: TestClient):
    r = client.get("/api/tag-library/curated")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "entries" in body
    assert len(body["entries"]) == len(all_entries())
    # Spot-check the prison entry round-trips its field note + related tags.
    prison = next(e for e in body["entries"] if e["id"] == "amenity-prison")
    assert prison["key"] == "amenity"
    assert prison["value"] == "prison"
    assert prison["domain"] == "detention"
    assert "landuse=military" in prison["related_tags"]
    assert len(prison["field_note"]) >= 30


def test_tag_endpoint_merges_curated_and_taginfo(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """``/tag?key=amenity&value=prison`` should pack the Taginfo payload, the
    matching curated entry, and the canonical wiki URL into one response."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "url": "https://taginfo.openstreetmap.org/api/4/tag/wiki_pages",
                "data": [
                    {
                        "lang": "en",
                        "title": "Tag:amenity=prison",
                        "description": "A place where people are held against their will.",
                    }
                ],
            },
        )

    monkeypatch.setattr(taginfo.httpx, "AsyncClient", _make_mock_client(handler))

    r = client.get("/api/tag-library/tag", params={"key": "amenity", "value": "prison"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["key"] == "amenity"
    assert body["value"] == "prison"
    assert body["wiki_url"] == "https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dprison"
    assert body["curated"] is not None
    assert body["curated"]["id"] == "amenity-prison"
    assert body["taginfo"]["data"][0]["title"] == "Tag:amenity=prison"


def test_tag_endpoint_curated_none_for_unknown_pair(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": []})

    monkeypatch.setattr(taginfo.httpx, "AsyncClient", _make_mock_client(handler))

    r = client.get(
        "/api/tag-library/tag",
        params={"key": "amenity", "value": "definitely-not-a-real-tag"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["curated"] is None


def test_keys_endpoint_filters_by_min_count(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": [
                    {"key": "building", "count_all": 1_000_000_000},
                    {"key": "noise", "count_all": 10},
                ]
            },
        )

    monkeypatch.setattr(taginfo.httpx, "AsyncClient", _make_mock_client(handler))

    r = client.get("/api/tag-library/keys", params={"min_count": 1000})
    assert r.status_code == 200, r.text
    keys = [row["key"] for row in r.json()["data"]]
    assert "building" in keys
    assert "noise" not in keys


def test_search_endpoint_prefers_curated(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """A search for 'detention' should surface the curated detention entries
    above any Taginfo hit, because curated rows carry a +100 score boost."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": [
                    {"key": "amenity", "value": "prison", "count_all": 50000},
                    {"key": "fictional", "value": "thing", "count_all": 1},
                ]
            },
        )

    monkeypatch.setattr(taginfo.httpx, "AsyncClient", _make_mock_client(handler))

    r = client.get("/api/tag-library/search", params={"q": "detention"})
    assert r.status_code == 200, r.text
    hits = r.json()["hits"]
    assert hits, "expected at least one hit for 'detention'"
    # The top hit should be a curated row.
    assert hits[0]["source"] == "curated"
