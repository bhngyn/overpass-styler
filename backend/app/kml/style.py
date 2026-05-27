"""In-memory style model. The frontend sends these; the serializer turns them into
KML ``<Style>`` blocks.

A *category style* is the look applied to every placemark sharing a (category_key,
category_value) — e.g. all features with ``amenity=prison``. A placemark can override
the category style with a per-placemark style; the inspector exposes that escape hatch.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .color import RGBA, rgba_to_kml


@dataclass
class PolygonStyle:
    fill: bool = True
    fill_color: RGBA = field(default_factory=lambda: RGBA(127, 127, 127, 127))
    outline: bool = True
    outline_color: RGBA = field(default_factory=lambda: RGBA(0, 0, 0, 255))
    outline_width: float = 1.5


@dataclass
class IconStyle:
    icon_href: str = "http://maps.google.com/mapfiles/kml/paddle/ylw-blank.png"
    color: RGBA = field(default_factory=lambda: RGBA(255, 255, 255, 255))
    scale: float = 1.0
    heading: float = 0.0


@dataclass
class LabelStyle:
    show: bool = True
    color: RGBA = field(default_factory=lambda: RGBA(255, 255, 255, 255))
    scale: float = 1.0


@dataclass
class FeatureStyle:
    """One assembled style block. Always emit all three sub-styles — KML tolerates
    them on any geometry, and it means a single style block works for mixed-geometry
    categories (e.g. amenity=prison has both points and polygons in Chad)."""

    id: str
    polygon: PolygonStyle = field(default_factory=PolygonStyle)
    icon: IconStyle = field(default_factory=IconStyle)
    label: LabelStyle = field(default_factory=LabelStyle)

    def to_kml_color_dict(self) -> dict[str, str]:
        """Convenience for tests / serialization — all colours as AABBGGRR hex."""
        return {
            "poly_fill": rgba_to_kml(self.polygon.fill_color),
            "poly_outline": rgba_to_kml(self.polygon.outline_color),
            "icon": rgba_to_kml(self.icon.color),
            "label": rgba_to_kml(self.label.color),
        }
