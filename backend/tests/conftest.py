from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def prisons_path() -> Path:
    return FIXTURES / "chad_prisons.kml"


@pytest.fixture
def cemeteries_path() -> Path:
    return FIXTURES / "chad_cemeteries.kml"


@pytest.fixture(params=["chad_prisons.kml", "chad_cemeteries.kml"])
def fixture_path(request: pytest.FixtureRequest) -> Path:
    return FIXTURES / request.param
