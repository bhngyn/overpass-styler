"""Parse an Overpass Turbo KML export into a lossless in-memory model.

The hard constraint: every ``ExtendedData/Data`` field and every coordinate value must
survive a round-trip parse → model → serialize unchanged. We use lxml directly because
higher-level KML libraries normalise namespaces and reorder elements.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from lxml import etree

KML_NS = "http://www.opengis.net/kml/2.2"
NSMAP = {"k": KML_NS}


# Investigator-supplied KMLs are untrusted input. lxml's default parser
# resolves external entities and DTDs, which opens the door to XXE
# (file: schemes, billion-laughs amplification, SSRF via http: entities).
# The KML format doesn't legitimately use any of that, so we lock it down.
def _make_safe_parser() -> etree.XMLParser:
    return etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        dtd_validation=False,
        huge_tree=False,
    )

GeometryKind = Literal["Point", "LineString", "Polygon"]


@dataclass
class Polygon:
    outer: str
    inners: list[str] = field(default_factory=list)


@dataclass
class Geometry:
    kind: GeometryKind
    # Exactly one of these is populated based on `kind`.
    point: str | None = None
    line: str | None = None
    polygon: Polygon | None = None

    def representative_lonlat(self) -> tuple[float, float] | None:
        """A single (lon, lat) for marking the feature on a map."""
        coord_str: str | None = None
        if self.kind == "Point":
            coord_str = self.point
        elif self.kind == "LineString":
            coord_str = (self.line or "").split()[0] if self.line else None
        elif self.kind == "Polygon" and self.polygon is not None:
            coord_str = self.polygon.outer.split()[0] if self.polygon.outer else None
        if not coord_str:
            return None
        parts = coord_str.split(",")
        if len(parts) < 2:
            return None
        try:
            return (float(parts[0]), float(parts[1]))
        except ValueError:
            return None


@dataclass
class Placemark:
    name: str | None
    extended_data: dict[str, str]
    # Preserve insertion order of ExtendedData so we round-trip faithfully.
    extended_data_order: list[str] = field(default_factory=list)
    geometry: Geometry | None = None

    @property
    def osm_id(self) -> str | None:
        return self.extended_data.get("@id")


@dataclass
class ParsedKml:
    document_name: str | None
    document_description: str | None
    placemarks: list[Placemark]


def _local(tag: str) -> str:
    """Strip namespace from an lxml tag.

    Returns ``""`` for anything that isn't a string tag — under
    ``resolve_entities=False`` lxml emits ``Entity`` / ``ProcessingInstruction``
    nodes during ``iter()`` whose ``tag`` attribute is a callable, not a
    string. We don't want to surface those into the parsed model.
    """
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _findtext(elem: etree._Element, name: str) -> str | None:
    child = elem.find(f"k:{name}", NSMAP)
    if child is None:
        # Some KMLs omit the namespace declaration on individual tags.
        child = elem.find(name)
    return child.text if child is not None else None


def _parse_extended_data(elem: etree._Element) -> tuple[dict[str, str], list[str]]:
    data: dict[str, str] = {}
    order: list[str] = []
    ext = elem.find("k:ExtendedData", NSMAP)
    if ext is None:
        ext = elem.find("ExtendedData")
    if ext is None:
        return data, order
    for d in ext.iter():
        if _local(d.tag) != "Data":
            continue
        key = d.get("name")
        if key is None:
            continue
        value_el = d.find("k:value", NSMAP)
        if value_el is None:
            value_el = d.find("value")
        value = value_el.text if value_el is not None else ""
        # First occurrence wins; record key order.
        if key not in data:
            data[key] = value or ""
            order.append(key)
    return data, order


def _parse_geometry(elem: etree._Element) -> Geometry | None:
    for child in elem:
        tag = _local(child.tag)
        if tag == "Point":
            coords = _findtext(child, "coordinates")
            if coords is None:
                return None
            return Geometry(kind="Point", point=coords.strip())
        if tag == "LineString":
            coords = _findtext(child, "coordinates")
            if coords is None:
                return None
            return Geometry(kind="LineString", line=coords.strip())
        if tag == "Polygon":
            outer_el = child.find("k:outerBoundaryIs/k:LinearRing/k:coordinates", NSMAP)
            if outer_el is None:
                outer_el = child.find("outerBoundaryIs/LinearRing/coordinates")
            if outer_el is None or outer_el.text is None:
                return None
            outer = outer_el.text.strip()
            inners: list[str] = []
            for inner_el in child.findall("k:innerBoundaryIs/k:LinearRing/k:coordinates", NSMAP):
                if inner_el.text:
                    inners.append(inner_el.text.strip())
            return Geometry(kind="Polygon", polygon=Polygon(outer=outer, inners=inners))
    return None


def parse_kml(source: str | bytes) -> ParsedKml:
    """Parse a KML document. `source` may be a path or raw bytes/str content."""
    parser = _make_safe_parser()
    if isinstance(source, str) and "<" not in source[:200]:
        tree = etree.parse(source, parser=parser)
        root = tree.getroot()
    else:
        if isinstance(source, str):
            source = source.encode("utf-8")
        root = etree.fromstring(source, parser=parser)

    document = root.find("k:Document", NSMAP)
    if document is None:
        document = root.find("Document")
    if document is None:
        document = root

    doc_name = _findtext(document, "name")
    doc_desc = _findtext(document, "description")

    placemarks: list[Placemark] = []
    for pm in document.iter():
        if _local(pm.tag) != "Placemark":
            continue
        name = _findtext(pm, "name")
        ext_data, order = _parse_extended_data(pm)
        geometry = _parse_geometry(pm)
        placemarks.append(
            Placemark(
                name=name,
                extended_data=ext_data,
                extended_data_order=order,
                geometry=geometry,
            )
        )

    return ParsedKml(
        document_name=doc_name,
        document_description=doc_desc,
        placemarks=placemarks,
    )
