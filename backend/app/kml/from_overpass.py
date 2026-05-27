"""Synthesize a KML document from an Overpass API JSON result.

The output is shaped to be byte-compatible with what the existing parser at
``app/kml/parse.py`` already ingests for Overpass Turbo's KML exports:

- one ``<Placemark>`` per element
- ``<ExtendedData>`` holds the OSM tags in insertion order, plus an ``@id``
  entry (``"node/123"`` / ``"way/123"`` / ``"relation/123"``) — the enrichment
  endpoint depends on this id being present
- ``<Point>`` for nodes, ``<LineString>`` for open ways, ``<Polygon>`` for
  closed ways and ``type=multipolygon`` relations
- coordinates emitted verbatim — no rounding, no precision normalisation

We use lxml directly (no fancy KML library) so we never silently reorder fields.
"""

from __future__ import annotations

from typing import Any

from lxml import etree

from .parse import KML_NS

__all__ = ["synthesize_kml"]


def _qname(tag: str) -> str:
    return f"{{{KML_NS}}}{tag}"


def _sub(parent: etree._Element, tag: str, text: str | None = None) -> etree._Element:
    el = etree.SubElement(parent, _qname(tag))
    if text is not None:
        el.text = text
    return el


def _coord(lon: Any, lat: Any) -> str:
    """Render a single Overpass (lat, lon) pair as KML's ``lon,lat`` token.

    Values are stringified with ``str()`` so int-vs-float and trailing-zero
    behaviour matches Overpass exactly — investigators staring at coordinates
    in Google Earth should see what OSM serves.
    """
    return f"{lon},{lat}"


def _coords_from_geometry(geom: list[dict[str, Any]]) -> list[str]:
    return [_coord(p["lon"], p["lat"]) for p in geom]


def _is_closed(tokens: list[str]) -> bool:
    return len(tokens) >= 4 and tokens[0] == tokens[-1]


def _append_extended_data(
    placemark: etree._Element, element: dict[str, Any]
) -> None:
    """Emit ``<ExtendedData>`` with ``@id`` first, then the OSM tags in
    Overpass's insertion order. The ``@id`` entry is mandatory — the existing
    enrichment endpoint (see ``app/api/enrich.py``) reads it to know which
    OSM element a placemark came from."""
    ext = _sub(placemark, "ExtendedData")

    osm_id = f"{element['type']}/{element['id']}"
    id_data = etree.SubElement(ext, _qname("Data"), {"name": "@id"})
    _sub(id_data, "value", osm_id)

    tags = element.get("tags") or {}
    for key, value in tags.items():
        if key == "@id":
            # Some pipelines stuff @id into tags; we've already emitted it.
            continue
        data = etree.SubElement(ext, _qname("Data"), {"name": str(key)})
        _sub(data, "value", "" if value is None else str(value))


def _placemark_name(element: dict[str, Any]) -> str:
    tags = element.get("tags") or {}
    name = tags.get("name")
    if isinstance(name, str) and name:
        return name
    return f"{element['type']}/{element['id']}"


def _emit_node(parent: etree._Element, element: dict[str, Any]) -> bool:
    if "lon" not in element or "lat" not in element:
        return False
    pm = _sub(parent, "Placemark")
    _sub(pm, "name", _placemark_name(element))
    _append_extended_data(pm, element)
    point = _sub(pm, "Point")
    _sub(point, "coordinates", _coord(element["lon"], element["lat"]))
    return True


def _emit_way(parent: etree._Element, element: dict[str, Any]) -> bool:
    geom = element.get("geometry")
    if not geom:
        return False
    tokens = _coords_from_geometry(geom)
    if len(tokens) < 2:
        return False

    pm = _sub(parent, "Placemark")
    _sub(pm, "name", _placemark_name(element))
    _append_extended_data(pm, element)

    coord_text = " ".join(tokens)
    if _is_closed(tokens):
        poly = _sub(pm, "Polygon")
        outer = _sub(poly, "outerBoundaryIs")
        ring = _sub(outer, "LinearRing")
        _sub(ring, "coordinates", coord_text)
    else:
        line = _sub(pm, "LineString")
        _sub(line, "coordinates", coord_text)
    return True


def _emit_multipolygon(parent: etree._Element, element: dict[str, Any]) -> bool:
    """A multipolygon relation: collect outer/inner rings from members.

    Overpass with ``out geom`` puts each way-member's coordinates under
    ``member['geometry']`` and labels its ring with ``member['role']``
    (``outer`` / ``inner`` / sometimes empty). We only emit a Placemark if at
    least one outer ring is present and closed; investigators can fix the
    upstream relation rather than us silently inventing closure.
    """
    members = element.get("members") or []
    outers: list[list[str]] = []
    inners: list[list[str]] = []
    for m in members:
        if m.get("type") != "way":
            continue
        geom = m.get("geometry")
        if not geom:
            continue
        toks = _coords_from_geometry(geom)
        if not _is_closed(toks):
            # Skip non-closed component ways — emitting a Polygon with an open
            # ring would silently corrupt the geometry in Earth Pro.
            continue
        role = (m.get("role") or "").lower()
        (inners if role == "inner" else outers).append(toks)

    if not outers:
        return False

    pm = _sub(parent, "Placemark")
    _sub(pm, "name", _placemark_name(element))
    _append_extended_data(pm, element)
    poly = _sub(pm, "Polygon")
    outer_el = _sub(poly, "outerBoundaryIs")
    outer_ring = _sub(outer_el, "LinearRing")
    _sub(outer_ring, "coordinates", " ".join(outers[0]))
    # Earth Pro accepts only one outer ring per Polygon. Extra outers are dropped
    # here; the multipolygon-of-multipolygons case is rare enough in OSM that
    # surfacing it would muddy the common path.
    for ring_tokens in inners:
        inner_el = _sub(poly, "innerBoundaryIs")
        inner_ring = _sub(inner_el, "LinearRing")
        _sub(inner_ring, "coordinates", " ".join(ring_tokens))
    return True


def synthesize_kml(name: str, overpass_result: dict[str, Any]) -> bytes:
    """Build a KML byte string from an Overpass JSON response.

    Parameters
    ----------
    name:
        Used as ``<Document><name>`` so the resulting layer is labelled in the
        UI and in Earth Pro.
    overpass_result:
        A parsed Overpass JSON body (i.e. what :func:`execute_query` returns).
        Expected shape: ``{"elements": [...]}``. Unrecognised element types are
        skipped silently — Overpass occasionally adds metadata elements.
    """
    root = etree.Element(_qname("kml"), nsmap={None: KML_NS})
    doc = _sub(root, "Document")
    _sub(doc, "name", name)

    for element in overpass_result.get("elements", []):
        kind = element.get("type")
        if kind == "node":
            _emit_node(doc, element)
        elif kind == "way":
            _emit_way(doc, element)
        elif kind == "relation":
            tags = element.get("tags") or {}
            if tags.get("type") == "multipolygon":
                _emit_multipolygon(doc, element)
            else:
                # TODO: non-multipolygon relations (routes, boundaries) need
                # bespoke geometry assembly we haven't designed yet.
                continue
        else:
            continue

    return etree.tostring(root, xml_declaration=True, encoding="UTF-8")
