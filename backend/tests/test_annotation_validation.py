"""Annotation input validation — guard against unsafe URLs and giant payloads.

The exported KML balloon emits investigator-supplied annotation values as
substitution tokens (``$[hr:source_url]``) wrapped in HTML anchors. Earth Pro
doesn't execute JS, but the file flows downstream to browser previews and
re-import tools that *do* render HTML — so we reject unsafe URL schemes at
write-time, where we still control the value.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Local client fixture — mirrors the pattern in test_api_smoke.py."""
    monkeypatch.setenv("OVERPASS_STYLER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv(
        "OVERPASS_STYLER_DB_URL", f"sqlite:///{tmp_path / 'test.sqlite'}"
    )
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
def setup(client: TestClient, prisons_path: Path) -> tuple[int, int]:
    pid = client.post("/api/projects", json={"name": "ann-validation"}).json()["id"]
    with prisons_path.open("rb") as f:
        sf = client.post(
            f"/api/projects/{pid}/source-files",
            files={"file": ("chad_prisons.kml", f, "application/vnd.google-earth.kml+xml")},
        ).json()
    return pid, sf["id"]


def _url(pid: int, sfid: int) -> str:
    return f"/api/projects/{pid}/source-files/{sfid}/placemarks/0/annotations"


def test_safe_url_scheme_accepted(client: TestClient, setup: tuple[int, int]):
    pid, sfid = setup
    r = client.put(_url(pid, sfid), json={"fields": {"source_url": "https://bellingcat.com/x"}})
    assert r.status_code == 200, r.text


def test_relative_url_accepted(client: TestClient, setup: tuple[int, int]):
    """A bare path with no scheme is allowed — investigators sometimes paste
    a wiki-style reference. urlparse returns empty scheme; we let that through."""
    pid, sfid = setup
    r = client.put(_url(pid, sfid), json={"fields": {"source_url": "internal-report.pdf"}})
    assert r.status_code == 200, r.text


def test_javascript_scheme_rejected(client: TestClient, setup: tuple[int, int]):
    pid, sfid = setup
    r = client.put(
        _url(pid, sfid),
        json={"fields": {"source_url": "javascript:alert(1)"}},
    )
    assert r.status_code == 400
    assert "javascript" in r.json()["detail"]


def test_data_scheme_rejected(client: TestClient, setup: tuple[int, int]):
    pid, sfid = setup
    r = client.put(
        _url(pid, sfid),
        json={"fields": {"source_url": "data:text/html,<script>alert(1)</script>"}},
    )
    assert r.status_code == 400


def test_field_value_length_capped(client: TestClient, setup: tuple[int, int]):
    pid, sfid = setup
    # 10 KB note — well past the 8000-char cap.
    r = client.put(_url(pid, sfid), json={"fields": {"note": "x" * 10_000}})
    assert r.status_code == 400
    assert "too long" in r.json()["detail"]


def test_arbitrary_url_suffix_keys_also_validated(client: TestClient, setup: tuple[int, int]):
    """Investigators may add custom *_url fields. We validate by suffix so
    they're protected by default without having to enumerate every name."""
    pid, sfid = setup
    r = client.put(
        _url(pid, sfid),
        json={"fields": {"witness_url": "javascript:steal()"}},
    )
    assert r.status_code == 400
