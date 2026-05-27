"""Serialize a parsed KML + styling configuration into a styled KML document.

The output structure:

    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document>
        <name>...</name>
        <Style id="...">...</Style>
        <Folder>                       <-- one per source file
          <name>...</name>
          <Placemark>
            <name>...</name>
            <styleUrl>#...</styleUrl>
            <ExtendedData>
              ... original OSM tags, preserved verbatim ...
              <Data name="hr:note">...</Data>   <-- user annotations under hr: namespace
            </ExtendedData>
            <Polygon>...</Polygon>
          </Placemark>
        </Folder>
      </Document>
    </kml>

Per the design: we re-parse our own output as a sanity check before returning it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from lxml import etree

from .balloon import render_balloon
from .color import rgba_to_kml
from .hr_icons import data_uri_for
from .parse import KML_NS, ParsedKml, Placemark
from .style import FeatureStyle

# Default investigator annotation fields surfaced in the Evidence section of
# every balloon. Keep in sync with the frontend PlacemarkInspector.
DEFAULT_ANNOTATION_KEYS: tuple[str, ...] = ("source_url", "date", "confidence", "note")

# User-annotation namespace prefix on ExtendedData Data names. Keeps OSM tags and
# investigator-added fields visually separated in Earth Pro popups.
ANNOTATION_PREFIX = "hr:"


@dataclass
class SourceLayer:
    """One imported KML, becoming a <Folder> in the export."""

    folder_name: str
    parsed: ParsedKml
    # Maps placemark index (within self.parsed.placemarks) -> style id.
    placemark_style_ids: dict[int, str] = field(default_factory=dict)
    # Maps placemark index -> annotations to inject as <Data name="hr:..."> entries.
    placemark_annotations: dict[int, dict[str, str]] = field(default_factory=dict)


@dataclass
class StyledDocument:
    document_name: str
    styles: list[FeatureStyle]
    layers: list[SourceLayer]


def _qname(tag: str) -> str:
    return f"{{{KML_NS}}}{tag}"


def _sub(parent: etree._Element, tag: str, text: str | None = None) -> etree._Element:
    el = etree.SubElement(parent, _qname(tag))
    if text is not None:
        el.text = text
    return el


def _resolve_export_href(href: str) -> str:
    """Inline bundled HR icons as `data:image/png;base64,…` so exported KMLs
    are self-contained and render in Earth Pro without our server reachable.
    Non-HR hrefs (Google's hosted KML icons, custom HTTP URLs) pass through."""
    data = data_uri_for(href)
    return data if data is not None else href


def _category_label_from_style_id(style_id: str) -> str:
    """Best-effort human-readable label derived from a style id.

    Style ids look like ``cat-amenity-prison`` or ``cat-landuse-cemetery``.
    Strip the ``cat-`` prefix and titlecase what's left; callers can override
    with a friendlier label via `_build_style(..., category_label=...)`.
    """
    stem = style_id.removeprefix("cat-") if style_id.startswith("cat-") else style_id
    return stem.replace("-", " ").replace("_", " ").strip().title() or "Feature"


def _build_style(
    style: FeatureStyle,
    *,
    category_label: str | None = None,
    annotation_keys: list[str] | None = None,
) -> etree._Element:
    el = etree.Element(_qname("Style"), attrib={"id": style.id})

    icon_style = _sub(el, "IconStyle")
    _sub(icon_style, "color", rgba_to_kml(style.icon.color))
    _sub(icon_style, "scale", f"{style.icon.scale:g}")
    if style.icon.heading:
        _sub(icon_style, "heading", f"{style.icon.heading:g}")
    icon = _sub(icon_style, "Icon")
    resolved_icon_href = _resolve_export_href(style.icon.icon_href)
    _sub(icon, "href", resolved_icon_href)

    label_style = _sub(el, "LabelStyle")
    _sub(label_style, "color", rgba_to_kml(style.label.color))
    _sub(label_style, "scale", f"{style.label.scale if style.label.show else 0:g}")

    line_style = _sub(el, "LineStyle")
    _sub(line_style, "color", rgba_to_kml(style.polygon.outline_color))
    _sub(line_style, "width", f"{style.polygon.outline_width:g}")

    poly_style = _sub(el, "PolyStyle")
    _sub(poly_style, "color", rgba_to_kml(style.polygon.fill_color))
    _sub(poly_style, "fill", "1" if style.polygon.fill else "0")
    _sub(poly_style, "outline", "1" if style.polygon.outline else "0")

    # BalloonStyle — gives Earth Pro a styled HTML popup instead of its default
    # ExtendedData table. The template uses KML substitution tokens so a single
    # block serves every placemark in this category.
    balloon_style = _sub(el, "BalloonStyle")
    balloon_html = render_balloon(
        category_label or _category_label_from_style_id(style.id),
        resolved_icon_href,
        list(annotation_keys) if annotation_keys is not None else list(DEFAULT_ANNOTATION_KEYS),
    )
    balloon_text = _sub(balloon_style, "text")
    balloon_text.text = etree.CDATA(balloon_html)

    return el


def _build_geometry(placemark: Placemark) -> etree._Element | None:
    g = placemark.geometry
    if g is None:
        return None
    if g.kind == "Point":
        el = etree.Element(_qname("Point"))
        _sub(el, "coordinates", g.point or "")
        return el
    if g.kind == "LineString":
        el = etree.Element(_qname("LineString"))
        _sub(el, "coordinates", g.line or "")
        return el
    if g.kind == "Polygon" and g.polygon is not None:
        el = etree.Element(_qname("Polygon"))
        outer = _sub(el, "outerBoundaryIs")
        ring = _sub(outer, "LinearRing")
        _sub(ring, "coordinates", g.polygon.outer)
        for inner_coords in g.polygon.inners:
            inner = _sub(el, "innerBoundaryIs")
            inner_ring = _sub(inner, "LinearRing")
            _sub(inner_ring, "coordinates", inner_coords)
        return el
    return None


def _build_extended_data(
    placemark: Placemark, annotations: dict[str, str]
) -> etree._Element | None:
    keys_in_order = list(placemark.extended_data_order)
    # Always emit annotations after OSM tags, in the order they were given.
    annotation_items = [(f"{ANNOTATION_PREFIX}{k}", v) for k, v in annotations.items() if v != ""]

    if not keys_in_order and not annotation_items:
        return None

    el = etree.Element(_qname("ExtendedData"))
    for key in keys_in_order:
        data = etree.SubElement(el, _qname("Data"), attrib={"name": key})
        _sub(data, "value", placemark.extended_data.get(key, ""))
    for name, value in annotation_items:
        data = etree.SubElement(el, _qname("Data"), attrib={"name": name})
        _sub(data, "value", value)
    return el


def _build_placemark(
    placemark: Placemark,
    style_id: str | None,
    annotations: dict[str, str],
) -> etree._Element:
    el = etree.Element(_qname("Placemark"))
    if placemark.name:
        _sub(el, "name", placemark.name)
    if style_id:
        _sub(el, "styleUrl", f"#{style_id}")
    ext = _build_extended_data(placemark, annotations)
    if ext is not None:
        el.append(ext)
    geom = _build_geometry(placemark)
    if geom is not None:
        el.append(geom)
    return el


def serialize(doc: StyledDocument) -> bytes:
    """Build the KML document and return UTF-8 bytes. Self-validates by re-parsing."""
    kml = etree.Element(_qname("kml"), nsmap={None: KML_NS})
    document = _sub(kml, "Document")
    _sub(document, "name", doc.document_name)

    for style in doc.styles:
        document.append(_build_style(style))

    for layer in doc.layers:
        folder = _sub(document, "Folder")
        _sub(folder, "name", layer.folder_name)
        for idx, placemark in enumerate(layer.parsed.placemarks):
            style_id = layer.placemark_style_ids.get(idx)
            annotations = layer.placemark_annotations.get(idx, {})
            folder.append(_build_placemark(placemark, style_id, annotations))

    body = etree.tostring(
        kml, xml_declaration=True, encoding="UTF-8", standalone=False, pretty_print=True
    )

    # Self-check: re-parse what we just emitted so we never hand back broken XML.
    reparsed = etree.fromstring(body)
    # Every <Style> we emitted must have a BalloonStyle/text with non-empty
    # content. CDATA round-trip bugs would silently lose the HTML template.
    for style_el in reparsed.findall(f".//{{{KML_NS}}}Style"):
        balloon_text = style_el.find(f"{{{KML_NS}}}BalloonStyle/{{{KML_NS}}}text")
        if balloon_text is None or not (balloon_text.text or "").strip():
            raise RuntimeError(
                f"BalloonStyle/text missing or empty on Style id={style_el.get('id')!r}"
            )
    return body
