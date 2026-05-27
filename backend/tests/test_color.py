"""Color helper tests. The TypeScript mirror in frontend/src/lib/kmlColor.ts must
produce the same outputs for these inputs — keep this table in sync."""

from __future__ import annotations

import pytest

from app.kml.color import (
    RGBA,
    alpha_to_opacity,
    hex_rgb_to_rgba,
    kml_to_rgba,
    opacity_to_alpha,
    rgba_to_hex_rgb,
    rgba_to_kml,
)

# Shared test vectors. Keep in sync with frontend test.
VECTORS = [
    # (R,  G,  B,  A,   KML hex,   #RRGGBB)
    (255,   0,   0, 255, "ff0000ff", "#ff0000"),
    (  0, 255,   0, 255, "ff00ff00", "#00ff00"),
    (  0,   0, 255, 255, "ffff0000", "#0000ff"),
    (255, 165,   0, 127, "7f00a5ff", "#ffa500"),  # 50% transparent orange
    (  0,   0,   0,   0, "00000000", "#000000"),
    (255, 255, 255, 255, "ffffffff", "#ffffff"),
]


@pytest.mark.parametrize("r,g,b,a,kml_hex,rgb_hex", VECTORS)
def test_rgba_to_kml(r, g, b, a, kml_hex, rgb_hex):
    assert rgba_to_kml(RGBA(r, g, b, a)) == kml_hex


@pytest.mark.parametrize("r,g,b,a,kml_hex,rgb_hex", VECTORS)
def test_kml_to_rgba(r, g, b, a, kml_hex, rgb_hex):
    assert kml_to_rgba(kml_hex) == RGBA(r, g, b, a)


@pytest.mark.parametrize("r,g,b,a,kml_hex,rgb_hex", VECTORS)
def test_hex_rgb_round_trip(r, g, b, a, kml_hex, rgb_hex):
    assert hex_rgb_to_rgba(rgb_hex, a) == RGBA(r, g, b, a)
    assert rgba_to_hex_rgb(RGBA(r, g, b, a)) == rgb_hex


def test_opacity_alpha_round_trip():
    for opacity in [0.0, 0.25, 0.5, 0.75, 1.0]:
        alpha = opacity_to_alpha(opacity)
        assert 0 <= alpha <= 255
        # Lossy round-trip; allow rounding within 1/255.
        assert abs(alpha_to_opacity(alpha) - opacity) < (1 / 255)


def test_invalid_rejected():
    with pytest.raises(ValueError):
        RGBA(300, 0, 0)
    with pytest.raises(ValueError):
        kml_to_rgba("notahex!")
    with pytest.raises(ValueError):
        hex_rgb_to_rgba("#zzz")
    with pytest.raises(ValueError):
        opacity_to_alpha(1.5)
