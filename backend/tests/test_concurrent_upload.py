"""Concurrent KML upload regression — two uploads to the same project must
both succeed.

The bug: ``import_kml`` was ``async def`` and called sync SQLAlchemy
operations directly on the event loop. When two uploads arrived at the
same time, the second one's blocking ``BEGIN`` (waiting on the first's
writer lock) starved the event loop, so the first's commit never ran. The
second eventually timed out on SQLite's 5 s ``busy_timeout`` and returned
HTTP 500.

The fix pushes the sync DB work into a threadpool via
``run_in_threadpool``, so the event loop stays free to schedule the first
upload's commit while the second sits in ``pysqlite``'s busy_wait.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("OVERPASS_STYLER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OVERPASS_STYLER_DB_URL", f"sqlite:///{tmp_path / 'test.sqlite'}")
    for mod_name in list(sys.modules):
        if mod_name.startswith(("app.db", "app.main", "app.api")):
            del sys.modules[mod_name]
    from app.main import app  # noqa: WPS433

    with TestClient(app) as c:
        yield c


_TINY_KML = (
    b"<?xml version='1.0' encoding='UTF-8'?>"
    b"<kml xmlns='http://www.opengis.net/kml/2.2'>"
    b"<Document><name>tiny</name><Placemark><name>p</name>"
    b"<Point><coordinates>15.0,12.0</coordinates></Point>"
    b"</Placemark></Document></kml>"
)


def test_two_concurrent_uploads_both_succeed(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "concurrent"}).json()["id"]

    def _upload(name: str):
        return client.post(
            f"/api/projects/{pid}/source-files",
            files={"file": (name, _TINY_KML, "application/vnd.google-earth.kml+xml")},
        )

    # Two threads driving the TestClient concurrently mirrors the
    # drop-two-files browser scenario closely enough to catch the deadlock.
    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(_upload, "first.kml")
        f2 = pool.submit(_upload, "second.kml")
        r1 = f1.result(timeout=15)
        r2 = f2.result(timeout=15)

    assert r1.status_code == 201, r1.text
    assert r2.status_code == 201, r2.text

    files = client.get(f"/api/projects/{pid}").json()["source_files"]
    filenames = sorted(f["filename"] for f in files)
    assert filenames == ["first.kml", "second.kml"]
