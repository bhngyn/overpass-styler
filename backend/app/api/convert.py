"""Convert between Pydantic API schemas and the internal style dataclasses, and
between the parsed-KML model and the lightweight preview payload the frontend gets."""

from __future__ import annotations

from app.kml.color import RGBA
from app.kml.parse import Geometry, Placemark
from app.kml.style import FeatureStyle, IconStyle, LabelStyle, PolygonStyle

from . import schemas as S


def rgba_to_schema(c: RGBA) -> S.RGBASchema:
    return S.RGBASchema(r=c.r, g=c.g, b=c.b, a=c.a)


def rgba_from_schema(s: S.RGBASchema) -> RGBA:
    return RGBA(r=s.r, g=s.g, b=s.b, a=s.a)


def style_to_schema(style: FeatureStyle) -> S.FeatureStyleSchema:
    return S.FeatureStyleSchema(
        polygon=S.PolygonStyleSchema(
            fill=style.polygon.fill,
            fill_color=rgba_to_schema(style.polygon.fill_color),
            outline=style.polygon.outline,
            outline_color=rgba_to_schema(style.polygon.outline_color),
            outline_width=style.polygon.outline_width,
        ),
        icon=S.IconStyleSchema(
            icon_href=style.icon.icon_href,
            color=rgba_to_schema(style.icon.color),
            scale=style.icon.scale,
            heading=style.icon.heading,
        ),
        label=S.LabelStyleSchema(
            show=style.label.show,
            color=rgba_to_schema(style.label.color),
            scale=style.label.scale,
        ),
    )


def style_from_schema(s: S.FeatureStyleSchema, style_id: str = "") -> FeatureStyle:
    return FeatureStyle(
        id=style_id,
        polygon=PolygonStyle(
            fill=s.polygon.fill,
            fill_color=rgba_from_schema(s.polygon.fill_color),
            outline=s.polygon.outline,
            outline_color=rgba_from_schema(s.polygon.outline_color),
            outline_width=s.polygon.outline_width,
        ),
        icon=IconStyle(
            icon_href=s.icon.icon_href,
            color=rgba_from_schema(s.icon.color),
            scale=s.icon.scale,
            heading=s.icon.heading,
        ),
        label=LabelStyle(
            show=s.label.show,
            color=rgba_from_schema(s.label.color),
            scale=s.label.scale,
        ),
    )


def _coords_string_to_pairs(s: str) -> list[list[float]]:
    out: list[list[float]] = []
    for tok in s.split():
        parts = tok.split(",")
        if len(parts) >= 2:
            try:
                out.append([float(parts[0]), float(parts[1])])
            except ValueError:
                continue
    return out


def geometry_to_preview(g: Geometry | None) -> S.GeometryPreview | None:
    if g is None:
        return None
    if g.kind == "Point" and g.point:
        pair = _coords_string_to_pairs(g.point)
        return S.GeometryPreview(kind="Point", coords=pair[0] if pair else [0.0, 0.0])
    if g.kind == "LineString" and g.line:
        return S.GeometryPreview(kind="LineString", coords=_coords_string_to_pairs(g.line))
    if g.kind == "Polygon" and g.polygon:
        rings = [_coords_string_to_pairs(g.polygon.outer)]
        rings.extend(_coords_string_to_pairs(r) for r in g.polygon.inners)
        return S.GeometryPreview(kind="Polygon", coords=rings)
    return None


def placemark_to_preview(
    pm: Placemark,
    index: int,
    category_key: str | None,
    annotations: dict[str, str],
    has_override: bool,
) -> S.PlacemarkPreview:
    cat_value = pm.extended_data.get(category_key) if category_key else None
    return S.PlacemarkPreview(
        index=index,
        name=pm.name,
        category_value=cat_value,
        extended_data=pm.extended_data,
        extended_data_order=pm.extended_data_order,
        geometry=geometry_to_preview(pm.geometry),
        annotations=annotations,
        has_override=has_override,
    )
