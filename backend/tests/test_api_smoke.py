"""End-to-end smoke test of the JSON API against a SQLite-in-tempdir."""

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

    # Force fresh import so the engine binds to the env-overridden URL.
    for mod_name in list(sys.modules):
        if mod_name.startswith("app.db") or mod_name.startswith("app.main") or mod_name.startswith("app.api"):
            del sys.modules[mod_name]

    from app.main import app  # noqa: WPS433 (intentional reimport)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def style_payload() -> dict:
    return {
        "style": {
            "polygon": {
                "fill": True,
                "fill_color": {"r": 255, "g": 0, "b": 0, "a": 127},
                "outline": True,
                "outline_color": {"r": 0, "g": 0, "b": 0, "a": 255},
                "outline_width": 2.0,
            },
            "icon": {
                "icon_href": "http://maps.google.com/mapfiles/kml/paddle/red-blank.png",
                "color": {"r": 255, "g": 255, "b": 255, "a": 255},
                "scale": 1.0,
                "heading": 0.0,
            },
            "label": {
                "show": True,
                "color": {"r": 255, "g": 255, "b": 255, "a": 255},
                "scale": 1.0,
            },
        }
    }


def test_health(client: TestClient):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_full_round_trip(client: TestClient, prisons_path: Path, style_payload: dict):
    # 1. Create project
    r = client.post("/api/projects", json={"name": "Chad — Detention sites"})
    assert r.status_code == 201, r.text
    proj = r.json()
    pid = proj["id"]
    assert proj["category_key"] is None

    # 2. Import KML
    with prisons_path.open("rb") as f:
        r = client.post(
            f"/api/projects/{pid}/source-files",
            files={"file": ("chad_prisons.kml", f, "application/vnd.google-earth.kml+xml")},
        )
    assert r.status_code == 201, r.text
    sf = r.json()
    sfid = sf["id"]
    assert sf["placemark_count"] == 6

    # 3. Category key auto-detected — both project-wide hint and per-file value.
    proj = client.get(f"/api/projects/{pid}").json()
    assert proj["category_key"] == "amenity"
    assert proj["source_files"][0]["category_key"] == "amenity"

    # 4. Source-file detail surfaces its own category key + counts.
    sf_detail = client.get(f"/api/projects/{pid}/source-files/{sfid}").json()
    assert sf_detail["category_key"] == "amenity"
    assert sf_detail["category_counts"]["prison"] == 6
    assert len(sf_detail["placemarks"]) == 6
    assert sf_detail["placemarks"][0]["category_value"] == "prison"

    # 5. Set a category style.
    r = client.put(f"/api/projects/{pid}/styles/prison", json=style_payload)
    assert r.status_code == 200, r.text

    # 6. Annotate one placemark.
    r = client.put(
        f"/api/projects/{pid}/source-files/{sfid}/placemarks/0/annotations",
        json={"fields": {"note": "field-verified", "confidence": "medium"}},
    )
    assert r.status_code == 200, r.text

    # 7. Export
    r = client.get(f"/api/projects/{pid}/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/vnd.google-earth.kml+xml")
    body = r.content
    assert b"<Style id=\"cat-prison\">" in body
    assert b"<styleUrl>#cat-prison</styleUrl>" in body
    assert b"7f0000ff" in body                # AABBGGRR for red 50%
    assert b"hr:note" in body                  # annotation namespaced
    assert b"field-verified" in body


def test_export_includes_folder_per_source_file(
    client: TestClient, prisons_path: Path, cemeteries_path: Path, style_payload: dict
):
    pid = client.post("/api/projects", json={"name": "Mixed"}).json()["id"]
    with prisons_path.open("rb") as f:
        prisons_sf = client.post(
            f"/api/projects/{pid}/source-files",
            files={"file": ("chad_prisons.kml", f, "application/vnd.google-earth.kml+xml")},
        ).json()
    with cemeteries_path.open("rb") as f:
        cemeteries_sf = client.post(
            f"/api/projects/{pid}/source-files",
            files={"file": ("chad_cemeteries.kml", f, "application/vnd.google-earth.kml+xml")},
        ).json()
    # Each source file keeps its own category key, so both categories surface
    # in the tree and both can be styled independently.
    assert prisons_sf["category_key"] == "amenity"
    assert cemeteries_sf["category_key"] == "landuse"

    prisons_detail = client.get(
        f"/api/projects/{pid}/source-files/{prisons_sf['id']}"
    ).json()
    cemeteries_detail = client.get(
        f"/api/projects/{pid}/source-files/{cemeteries_sf['id']}"
    ).json()
    assert prisons_detail["category_counts"].get("prison", 0) > 0
    assert cemeteries_detail["category_counts"].get("cemetery", 0) > 0

    client.put(f"/api/projects/{pid}/styles/prison", json=style_payload)
    client.put(f"/api/projects/{pid}/styles/cemetery", json=style_payload)

    body = client.get(f"/api/projects/{pid}/export").content
    assert body.count(b"<Folder>") == 2
    assert b"chad_prisons" in body
    assert b"chad_cemeteries" in body
    # Both categories' Style blocks were emitted and both folders reference them.
    assert b'<Style id="cat-prison">' in body
    assert b'<Style id="cat-cemetery">' in body
    assert b"<styleUrl>#cat-prison</styleUrl>" in body
    assert b"<styleUrl>#cat-cemetery</styleUrl>" in body


def test_category_key_is_per_source_file_regardless_of_import_order(
    client: TestClient, prisons_path: Path, cemeteries_path: Path, style_payload: dict
):
    """Regression: importing cemeteries first used to lock the project to
    ``landuse``, hiding the prison category when prisons were imported next.
    Each file now carries its own auto-detected key."""
    pid = client.post("/api/projects", json={"name": "Cemeteries first"}).json()["id"]

    with cemeteries_path.open("rb") as f:
        cemeteries_sf = client.post(
            f"/api/projects/{pid}/source-files",
            files={"file": ("chad_cemeteries.kml", f, "application/vnd.google-earth.kml+xml")},
        ).json()
    assert cemeteries_sf["category_key"] == "landuse"

    with prisons_path.open("rb") as f:
        prisons_sf = client.post(
            f"/api/projects/{pid}/source-files",
            files={"file": ("chad_prisons.kml", f, "application/vnd.google-earth.kml+xml")},
        ).json()
    assert prisons_sf["category_key"] == "amenity"

    # The tree (driven by SourceFileDetail.category_counts) must show both
    # categories — that's the user-visible bug the original report described.
    cemeteries_detail = client.get(
        f"/api/projects/{pid}/source-files/{cemeteries_sf['id']}"
    ).json()
    prisons_detail = client.get(
        f"/api/projects/{pid}/source-files/{prisons_sf['id']}"
    ).json()
    assert "cemetery" in cemeteries_detail["category_counts"]
    assert "prison" in prisons_detail["category_counts"]

    # And both categories are individually styleable end-to-end.
    client.put(f"/api/projects/{pid}/styles/prison", json=style_payload)
    client.put(f"/api/projects/{pid}/styles/cemetery", json=style_payload)
    body = client.get(f"/api/projects/{pid}/export").content
    assert b"<styleUrl>#cat-prison</styleUrl>" in body
    assert b"<styleUrl>#cat-cemetery</styleUrl>" in body


def test_preset_lifecycle(client: TestClient, style_payload: dict):
    r = client.post(
        "/api/presets",
        json={"name": "Prison red 50%", "style": style_payload["style"]},
    )
    assert r.status_code == 201
    presets = client.get("/api/presets").json()
    assert any(p["name"] == "Prison red 50%" for p in presets)


def test_icons_catalogue(client: TestClient):
    cat = client.get("/api/icons").json()
    assert "paddle" in cat
    assert any(i["id"] == "paddle-red" for i in cat["paddle"])
    # HR/OSINT group ships 31 entries, each tagged with a subgroup.
    assert "hr" in cat
    assert len(cat["hr"]) == 31
    assert all(i.get("subgroup") for i in cat["hr"])
    assert {i["subgroup"] for i in cat["hr"]} == {
        "Source",
        "IHL event",
        "Protected",
        "Forces",
        "Verification",
    }


def test_hr_icon_file_is_served(client: TestClient):
    r = client.get("/api/icons/hr/hr-evt-detention.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content.startswith(b"\x89PNG\r\n\x1a\n")


def test_hr_icon_unknown_filename_is_404(client: TestClient):
    r = client.get("/api/icons/hr/does-not-exist.png")
    assert r.status_code == 404


def test_invalid_kml_rejected(client: TestClient):
    pid = client.post("/api/projects", json={"name": "Bad"}).json()["id"]
    r = client.post(
        f"/api/projects/{pid}/source-files",
        files={"file": ("bad.kml", b"<not-kml>", "application/vnd.google-earth.kml+xml")},
    )
    assert r.status_code == 400
