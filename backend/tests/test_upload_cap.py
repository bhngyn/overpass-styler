"""KML upload size cap — verifies that oversized uploads return 413 rather
than allowing an uncapped ``await file.read()`` to exhaust worker memory."""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("OVERPASS_STYLER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OVERPASS_STYLER_DB_URL", f"sqlite:///{tmp_path / 'test.sqlite'}")
    # Force a very low cap so tests don't have to send a real 100 MB blob.
    monkeypatch.setenv("OVERPASS_STYLER_MAX_KML_BYTES", "1024")
    for mod_name in list(sys.modules):
        if mod_name.startswith(("app.db", "app.main", "app.api")):
            del sys.modules[mod_name]
    from app.main import app  # noqa: WPS433
    with TestClient(app) as c:
        yield c


def _make_project(client: TestClient) -> int:
    return client.post("/api/projects", json={"name": "cap test"}).json()["id"]


def test_oversized_upload_returns_413(client: TestClient) -> None:
    pid = _make_project(client)
    # Build a body that's well over the configured cap.
    blob = b"<?xml version='1.0'?><kml>" + b"x" * 4096 + b"</kml>"
    r = client.post(
        f"/api/projects/{pid}/source-files",
        files={"file": ("big.kml", blob, "application/vnd.google-earth.kml+xml")},
    )
    assert r.status_code == 413, r.text
    assert "cap" in r.json()["detail"].lower()


def test_undersized_upload_passes_through(client: TestClient) -> None:
    """The cap is a ceiling, not a fixed gate — legitimate KMLs still
    succeed."""
    pid = _make_project(client)
    small_kml = (
        b"<?xml version='1.0' encoding='UTF-8'?>"
        b"<kml xmlns='http://www.opengis.net/kml/2.2'>"
        b"<Document><name>tiny</name><Placemark><name>p</name>"
        b"<Point><coordinates>15.0,12.0</coordinates></Point>"
        b"</Placemark></Document></kml>"
    )
    r = client.post(
        f"/api/projects/{pid}/source-files",
        files={"file": ("tiny.kml", small_kml, "application/vnd.google-earth.kml+xml")},
    )
    assert r.status_code == 201, r.text
