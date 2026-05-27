"""KML color helpers.

KML colors are ``AABBGGRR`` hex strings (alpha first, then blue/green/red — note the
order is *not* RGB). Opacity is the high byte, so a 50%-transparent red is ``7f0000ff``.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RGBA:
    r: int
    g: int
    b: int
    a: int = 255

    def __post_init__(self) -> None:
        for name, value in (("r", self.r), ("g", self.g), ("b", self.b), ("a", self.a)):
            if not 0 <= value <= 255:
                raise ValueError(f"{name} out of range 0..255: {value}")


def rgba_to_kml(color: RGBA) -> str:
    return f"{color.a:02x}{color.b:02x}{color.g:02x}{color.r:02x}"


def kml_to_rgba(kml_color: str) -> RGBA:
    s = kml_color.strip().lower()
    if len(s) != 8 or any(c not in "0123456789abcdef" for c in s):
        raise ValueError(f"not a KML color (expected 8 hex chars AABBGGRR): {kml_color!r}")
    return RGBA(
        a=int(s[0:2], 16),
        b=int(s[2:4], 16),
        g=int(s[4:6], 16),
        r=int(s[6:8], 16),
    )


def hex_rgb_to_rgba(hex_rgb: str, alpha: int = 255) -> RGBA:
    s = hex_rgb.strip().lstrip("#").lower()
    if len(s) != 6 or any(c not in "0123456789abcdef" for c in s):
        raise ValueError(f"not a 6-digit hex RGB: {hex_rgb!r}")
    return RGBA(r=int(s[0:2], 16), g=int(s[2:4], 16), b=int(s[4:6], 16), a=alpha)


def rgba_to_hex_rgb(color: RGBA) -> str:
    return f"#{color.r:02x}{color.g:02x}{color.b:02x}"


def opacity_to_alpha(opacity: float) -> int:
    """0.0 = transparent, 1.0 = opaque."""
    if not 0.0 <= opacity <= 1.0:
        raise ValueError(f"opacity must be 0..1: {opacity}")
    return round(opacity * 255)


def alpha_to_opacity(alpha: int) -> float:
    if not 0 <= alpha <= 255:
        raise ValueError(f"alpha must be 0..255: {alpha}")
    return alpha / 255
