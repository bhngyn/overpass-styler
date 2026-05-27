"""Tests for the in-app Overpass query endpoint.

We monkey-patch ``app.enrichment.overpass.execute_query`` so the test never
touches the network. The fixture body is small enough to keep the test
focused on the API contract — query substitution, persistence of the
original query + bbox, response shape parity with the upload endpoint.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("OVERPASS_STYLER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OVERPASS_STYLER_DB_URL", f"sqlite:///{tmp_path / 'test.sqlite'}")

    # Force fresh module import so the engine binds to the env-overridden URL.
    for mod_name in list(sys.modules):
        if (
            mod_name.startswith("app.db")
            or mod_name.startswith("app.main")
            or mod_name.startswith("app.api")
        ):
            del sys.modules[mod_name]

    from app.main import app  # noqa: WPS433

    with TestClient(app) as c:
        yield c


@pytest.fixture
def fake_overpass_result() -> dict:
    return {
        "version": 0.6,
        "elements": [
            {
                "type": "node",
                "id": 9001,
                "lon": 15.0444,
                "lat": 12.1098,
                "tags": {"amenity": "prison", "name": "Test Prison"},
            },
            {
                "type": "way",
                "id": 9002,
                "tags": {"amenity": "prison"},
                "geometry": [
                    {"lon": 15.0, "lat": 12.0},
                    {"lon": 15.1, "lat": 12.0},
                    {"lon": 15.1, "lat": 12.1},
                    {"lon": 15.0, "lat": 12.1},
                    {"lon": 15.0, "lat": 12.0},
                ],
            },
        ],
    }


@pytest.fixture
def captured_query() -> dict:
    """Mutable shared box for the monkey-patched execute_query to record into."""
    return {}


@pytest.fixture
def patched_overpass(
    monkeypatch: pytest.MonkeyPatch,
    fake_overpass_result: dict,
    captured_query: dict,
):
    async def fake_execute_query(ql: str, *, timeout: int = 25) -> dict:
        captured_query["ql"] = ql
        captured_query["timeout"] = timeout
        return fake_overpass_result

    # Patch the binding the projects router actually uses.
    from app.api import projects as projects_module

    monkeypatch.setattr(projects_module.overpass, "execute_query", fake_execute_query)
    return fake_execute_query


def _make_project(client: TestClient, name: str = "Overpass test") -> int:
    return client.post("/api/projects", json={"name": name}).json()["id"]


def test_overpass_endpoint_response_shape_matches_upload(
    client: TestClient, patched_overpass, captured_query: dict
):
    pid = _make_project(client)
    payload = {
        "name": "prisons-in-bbox",
        "query": "node[amenity=prison]({{bbox}});out geom;",
        "bbox": [14.0, 11.0, 16.0, 13.0],
        "region_label": "Chad",
    }
    r = client.post(f"/api/projects/{pid}/overpass-queries", json=payload)
    assert r.status_code == 201, r.text
    body = r.json()
    # Same shape as the upload endpoint's SourceFileSummary response — the
    # core fields. Query-derived layers additionally surface the provenance
    # fields (overpass_query, bbox_json) so the frontend can render a
    # "re-run this query" affordance; those are null on upload-derived rows.
    core_fields = {"id", "filename", "placemark_count", "category_key", "created_at"}
    assert core_fields <= set(body.keys())
    assert body["placemark_count"] == 2
    assert body["category_key"] == "amenity"
    assert body["overpass_query"] == payload["query"]
    assert body["bbox_json"] is not None


def test_bbox_substitution_uses_overpass_south_west_north_east_order(
    client: TestClient, patched_overpass, captured_query: dict
):
    pid = _make_project(client)
    # WSEN as the client sends it.
    payload = {
        "name": "x",
        "query": "node[amenity=prison]({{bbox}});out geom;",
        "bbox": [14.0, 11.0, 16.0, 13.0],
    }
    client.post(f"/api/projects/{pid}/overpass-queries", json=payload)
    # Overpass expects S,W,N,E. So 11,14,13,16.
    assert "11.0,14.0,13.0,16.0" in captured_query["ql"]
    # And the literal placeholder should not survive.
    assert "{{bbox}}" not in captured_query["ql"]


def test_original_unsubstituted_query_is_persisted(
    client: TestClient, patched_overpass
):
    pid = _make_project(client)
    original_ql = "node[amenity=prison]({{bbox}});out geom;"
    bbox = [14.0, 11.0, 16.0, 13.0]
    r = client.post(
        f"/api/projects/{pid}/overpass-queries",
        json={"name": "x", "query": original_ql, "bbox": bbox},
    )
    sfid = r.json()["id"]

    # Read the row directly from the DB to verify storage. The detail endpoint
    # doesn't surface the query — that's deliberate (frontend will add it later).
    from app.db.models import SourceFile
    from app.db.session import SessionLocal

    with SessionLocal() as s:
        row = s.get(SourceFile, sfid)
        assert row is not None
        assert row.overpass_query == original_ql
        assert json.loads(row.bbox_json) == bbox


def test_missing_bbox_for_placeholder_query_returns_400(
    client: TestClient, patched_overpass
):
    pid = _make_project(client)
    r = client.post(
        f"/api/projects/{pid}/overpass-queries",
        json={"name": "x", "query": "node[amenity=prison]({{bbox}});out geom;"},
    )
    assert r.status_code == 400
    assert "{{bbox}}" in r.json()["detail"]


def test_query_without_bbox_placeholder_works_without_bbox(
    client: TestClient, patched_overpass, captured_query: dict
):
    pid = _make_project(client)
    r = client.post(
        f"/api/projects/{pid}/overpass-queries",
        json={
            "name": "fixed-region",
            "query": "node[amenity=prison](40.0,-75.0,41.0,-74.0);out geom;",
        },
    )
    assert r.status_code == 201, r.text
    # Auto-prepended JSON settings line is the only transformation.
    assert "{{bbox}}" not in captured_query["ql"]


def test_upstream_overpass_error_becomes_502(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    from app.api import projects as projects_module
    from app.enrichment.overpass import OverpassError

    async def boom(ql: str, *, timeout: int = 25) -> dict:
        raise OverpassError("rate-limited: try later")

    monkeypatch.setattr(projects_module.overpass, "execute_query", boom)

    pid = _make_project(client)
    r = client.post(
        f"/api/projects/{pid}/overpass-queries",
        json={"name": "x", "query": "node[amenity=prison](40,-75,41,-74);out geom;"},
    )
    assert r.status_code == 502
    assert "rate-limited" in r.json()["detail"]


def test_layer_appears_in_project_detail(
    client: TestClient, patched_overpass
):
    pid = _make_project(client)
    client.post(
        f"/api/projects/{pid}/overpass-queries",
        json={
            "name": "first",
            "query": "node[amenity=prison]({{bbox}});out geom;",
            "bbox": [14.0, 11.0, 16.0, 13.0],
        },
    )
    proj = client.get(f"/api/projects/{pid}").json()
    assert len(proj["source_files"]) == 1
    assert proj["source_files"][0]["category_key"] == "amenity"
    # The project's denormalised category hint should pick up the new layer.
    assert proj["category_key"] == "amenity"


# ---------------------------------------------------------------------------
# Compose-step preflight + synthesizer truncation
# ---------------------------------------------------------------------------


def test_preflight_endpoint_returns_count(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """The Compose-step preflight wraps execute_count and surfaces the total."""
    from app.api import projects as projects_module

    async def fake_count(ql_body: str, *, timeout: int | None = None, area_hint_km2=None) -> int:
        return 1234

    monkeypatch.setattr(projects_module.overpass, "execute_count", fake_count)

    pid = _make_project(client)
    r = client.post(
        f"/api/projects/{pid}/overpass-queries/preflight",
        json={
            "query": "node[amenity=prison]({{bbox}});out geom;",
            "bbox": [14.0, 11.0, 16.0, 13.0],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_count"] == 1234
    assert body["too_large"] is False
    assert body["hard_cap"] == 50_000
    # Size estimate is total * 200 + 5KB.
    assert body["estimated_kml_bytes"] == 1234 * 200 + 5_000


def test_preflight_endpoint_flags_too_large(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """Counts above the hard cap come back with too_large: true."""
    from app.api import projects as projects_module

    async def fake_count(ql_body: str, *, timeout: int | None = None, area_hint_km2=None) -> int:
        return 75_000

    monkeypatch.setattr(projects_module.overpass, "execute_count", fake_count)

    pid = _make_project(client)
    r = client.post(
        f"/api/projects/{pid}/overpass-queries/preflight",
        json={
            "query": "nwr({{bbox}});out;",
            "bbox": [14.0, 11.0, 16.0, 13.0],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_count"] == 75_000
    assert body["too_large"] is True


def test_preflight_endpoint_strips_outer_statements(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """The QL body handed to execute_count is stripped of settings + out."""
    from app.api import projects as projects_module

    captured: dict = {}

    async def fake_count(ql_body: str, *, timeout: int | None = None, area_hint_km2=None) -> int:
        captured["body"] = ql_body
        return 42

    monkeypatch.setattr(projects_module.overpass, "execute_count", fake_count)

    pid = _make_project(client)
    r = client.post(
        f"/api/projects/{pid}/overpass-queries/preflight",
        json={
            "query": "[out:json][timeout:25];node[amenity=prison](40,-75,41,-74);out geom;",
        },
    )
    assert r.status_code == 200, r.text
    # No leading settings line, no trailing out — execute_count will wrap.
    assert not captured["body"].startswith("[")
    assert "out geom" not in captured["body"]


def test_preflight_endpoint_rejects_oversized_query_string(
    client: TestClient
):
    pid = _make_project(client)
    r = client.post(
        f"/api/projects/{pid}/overpass-queries/preflight",
        json={"query": "x" * 20_001},
    )
    assert r.status_code == 422


def test_overpass_endpoint_surfaces_truncation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """When the synthesizer hits its cap, the response carries a truncation report."""
    from app.api import projects as projects_module

    # Return more elements than the synthesizer cap so it has to truncate.
    big_result = {
        "elements": [
            {
                "type": "node",
                "id": i,
                "lon": 15.0,
                "lat": 12.0,
                "tags": {"amenity": "prison"},
            }
            for i in range(60_000)
        ]
    }

    async def fake_query(ql: str, *, timeout: int | None = None, area_hint_km2=None) -> dict:
        return big_result

    monkeypatch.setattr(projects_module.overpass, "execute_query", fake_query)

    pid = _make_project(client)
    r = client.post(
        f"/api/projects/{pid}/overpass-queries",
        json={
            "name": "too-many",
            "query": "nwr({{bbox}});out;",
            "bbox": [14.0, 11.0, 16.0, 13.0],
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["truncation"] is not None
    assert body["truncation"]["total"] == 60_000
    assert body["truncation"]["ingested"] == 50_000
    # L2 contract: ``truncated`` is the diff (count dropped), not a bool.
    assert body["truncation"]["truncated"] == 10_000


def test_overpass_endpoint_rejects_oversized_name(client: TestClient):
    pid = _make_project(client)
    r = client.post(
        f"/api/projects/{pid}/overpass-queries",
        json={"name": "x" * 201, "query": "node;out;"},
    )
    assert r.status_code == 422


def test_overpass_endpoint_rejects_nan_bbox():
    """Pydantic validator rejects NaN in the request bbox."""
    from pydantic import ValidationError
    from app.api.projects import _OverpassQueryRequest

    with pytest.raises(ValidationError):
        _OverpassQueryRequest(
            name="x",
            query="node;out;",
            bbox=[float("nan"), 0.0, 1.0, 1.0],
        )
