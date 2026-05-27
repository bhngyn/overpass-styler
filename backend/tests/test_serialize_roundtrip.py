"""End-to-end round-trip: parse fixture -> serialize styled -> re-parse and verify
that all original data survived intact and styling was injected correctly."""

from __future__ import annotations

from pathlib import Path

from lxml import etree

from app.kml.color import RGBA
from app.kml.hr_icons import HR_HREF_PREFIX
from app.kml.parse import KML_NS, parse_kml
from app.kml.serialize import (
    ANNOTATION_PREFIX,
    SourceLayer,
    StyledDocument,
    serialize,
)
from app.kml.style import FeatureStyle, IconStyle, PolygonStyle

NSMAP = {"k": KML_NS}


def _round_trip(fixture: Path, *, with_annotations: bool = False) -> tuple[bytes, "object"]:
    parsed = parse_kml(str(fixture))
    style = FeatureStyle(
        id="cat-test",
        polygon=PolygonStyle(
            fill=True,
            fill_color=RGBA(255, 0, 0, 127),       # red 50%
            outline=True,
            outline_color=RGBA(0, 0, 0, 255),
            outline_width=2.0,
        ),
    )
    layer = SourceLayer(folder_name=fixture.stem, parsed=parsed)
    for i in range(len(parsed.placemarks)):
        layer.placemark_style_ids[i] = "cat-test"
    if with_annotations:
        layer.placemark_annotations[0] = {
            "note": "field-verified",
            "source_url": "https://example.org/report",
            "confidence": "medium",
        }

    doc = StyledDocument(
        document_name=f"styled-{fixture.stem}",
        styles=[style],
        layers=[layer],
    )
    body = serialize(doc)
    reparsed = etree.fromstring(body)
    return body, reparsed


def test_round_trip_prisons_preserves_extended_data(prisons_path: Path):
    body, root = _round_trip(prisons_path)

    pmarks = root.findall(".//k:Placemark", NSMAP)
    assert len(pmarks) == 6

    # Every placemark should now have a styleUrl pointing at our category style.
    for pm in pmarks:
        style_url = pm.find("k:styleUrl", NSMAP)
        assert style_url is not None
        assert style_url.text == "#cat-test"

    # ExtendedData on every placemark must include amenity=prison from the source.
    for pm in pmarks:
        amenity = pm.find("k:ExtendedData/k:Data[@name='amenity']/k:value", NSMAP)
        assert amenity is not None
        assert amenity.text == "prison"


def test_round_trip_cemeteries_preserves_count(cemeteries_path: Path):
    original = parse_kml(str(cemeteries_path))
    _, root = _round_trip(cemeteries_path)
    pmarks = root.findall(".//k:Placemark", NSMAP)
    assert len(pmarks) == len(original.placemarks)


def test_styled_polygon_color_is_kml_format(prisons_path: Path):
    _, root = _round_trip(prisons_path)
    poly_color = root.find(".//k:Style/k:PolyStyle/k:color", NSMAP)
    assert poly_color is not None
    # Red 50% transparent: alpha=7f, blue=00, green=00, red=ff
    assert poly_color.text == "7f0000ff"
    fill = root.find(".//k:Style/k:PolyStyle/k:fill", NSMAP)
    assert fill is not None and fill.text == "1"


def test_geometry_coordinates_unchanged(prisons_path: Path):
    original = parse_kml(str(prisons_path))
    _, root = _round_trip(prisons_path)
    pmarks = root.findall(".//k:Placemark", NSMAP)

    # Build a coordinate lookup from the round-tripped doc.
    new_coords: list[str] = []
    for pm in pmarks:
        for tag in ("Point/k:coordinates", "Polygon/k:outerBoundaryIs/k:LinearRing/k:coordinates"):
            for el in pm.findall(f"k:{tag}", NSMAP):
                if el.text:
                    new_coords.append(el.text.strip())

    original_coords: list[str] = []
    for p in original.placemarks:
        if not p.geometry:
            continue
        if p.geometry.kind == "Point" and p.geometry.point:
            original_coords.append(p.geometry.point)
        elif p.geometry.kind == "Polygon" and p.geometry.polygon:
            original_coords.append(p.geometry.polygon.outer)

    # Same set of coordinate strings, byte-identical.
    assert sorted(new_coords) == sorted(original_coords)


def test_annotations_emitted_with_namespace(prisons_path: Path):
    _, root = _round_trip(prisons_path, with_annotations=True)
    annotated = root.findall(".//k:Placemark", NSMAP)[0]
    # The three annotations should appear as hr:-namespaced Data entries.
    note = annotated.find(
        f"k:ExtendedData/k:Data[@name='{ANNOTATION_PREFIX}note']/k:value", NSMAP
    )
    assert note is not None and note.text == "field-verified"
    src = annotated.find(
        f"k:ExtendedData/k:Data[@name='{ANNOTATION_PREFIX}source_url']/k:value", NSMAP
    )
    assert src is not None and src.text == "https://example.org/report"
    # Original OSM tags must still be there.
    amenity = annotated.find("k:ExtendedData/k:Data[@name='amenity']/k:value", NSMAP)
    assert amenity is not None and amenity.text == "prison"


def test_balloon_token_keys_get_empty_stub_when_missing(cemeteries_path: Path):
    """Earth Pro renders ``$[KEY]`` literally when the placemark has no
    matching ``<Data name="KEY">`` element. Cemeteries don't carry an
    ``amenity`` tag, so the balloon's ``$[amenity]`` token used to leak
    through as literal text in the popup. Verify the serializer now emits
    an empty stub so substitution resolves to an empty string."""
    _, root = _round_trip(cemeteries_path)
    placemarks = root.findall(".//k:Placemark", NSMAP)
    assert placemarks, "fixture should have placemarks"

    for pm in placemarks:
        # Every OSM key the balloon template references must be present so
        # `$[KEY]` substitutes — even when the underlying tag is absent.
        for key in (
            "amenity", "landuse", "building", "operator", "name:en",
            "addr:city", "addr:country", "start_date", "wikipedia",
        ):
            data = pm.find(
                f"k:ExtendedData/k:Data[@name='{key}']", NSMAP
            )
            assert data is not None, f"missing stub for OSM key {key!r}"

        # And every hr:* annotation key the balloon template references
        # must also be present, even if the user hasn't annotated anything.
        for key in ("note", "source_url", "date_observed", "confidence", "field_notes"):
            data = pm.find(
                f"k:ExtendedData/k:Data[@name='{ANNOTATION_PREFIX}{key}']", NSMAP
            )
            assert data is not None, f"missing stub for annotation key {key!r}"


def test_existing_tag_values_are_not_overwritten_by_stubs(cemeteries_path: Path):
    """The stub-emission pass must not clobber a real OSM tag value with an
    empty string. Cemeteries do carry ``landuse=cemetery`` — ensure that
    survives untouched after the serializer adds stubs for the missing
    keys."""
    _, root = _round_trip(cemeteries_path)
    placemarks = root.findall(".//k:Placemark", NSMAP)
    for pm in placemarks:
        landuse = pm.find("k:ExtendedData/k:Data[@name='landuse']/k:value", NSMAP)
        assert landuse is not None and landuse.text == "cemetery"


def test_real_annotation_values_take_priority_over_stubs(prisons_path: Path):
    """If the user has filled in an annotation, the real value must be
    emitted — the stub-pass must not also emit an empty duplicate."""
    _, root = _round_trip(prisons_path, with_annotations=True)
    annotated = root.findall(".//k:Placemark", NSMAP)[0]
    note_entries = annotated.findall(
        f"k:ExtendedData/k:Data[@name='{ANNOTATION_PREFIX}note']", NSMAP
    )
    assert len(note_entries) == 1, "stub pass duplicated a real annotation"
    note_value = note_entries[0].find("k:value", NSMAP)
    assert note_value is not None and note_value.text == "field-verified"


def test_folder_wraps_source_layer(prisons_path: Path):
    _, root = _round_trip(prisons_path)
    folder = root.find(".//k:Folder", NSMAP)
    assert folder is not None
    folder_name = folder.find("k:name", NSMAP)
    assert folder_name is not None and folder_name.text == "chad_prisons"


def test_hr_icon_href_is_inlined_as_data_uri(prisons_path: Path):
    """Bundled HR icons must be embedded so exported KMLs render without the
    backend being reachable from the colleague who opens the file."""
    parsed = parse_kml(str(prisons_path))
    style = FeatureStyle(
        id="cat-test",
        icon=IconStyle(icon_href=f"{HR_HREF_PREFIX}hr-evt-detention.png"),
    )
    layer = SourceLayer(folder_name=prisons_path.stem, parsed=parsed)
    for i in range(len(parsed.placemarks)):
        layer.placemark_style_ids[i] = "cat-test"
    body = serialize(
        StyledDocument(document_name="styled-hr", styles=[style], layers=[layer])
    )

    root = etree.fromstring(body)
    href_el = root.find(".//k:Style/k:IconStyle/k:Icon/k:href", NSMAP)
    assert href_el is not None and href_el.text is not None
    assert href_el.text.startswith("data:image/png;base64,")
    # Round-trip the base64 back to PNG magic bytes.
    import base64
    payload = href_el.text.removeprefix("data:image/png;base64,")
    assert base64.b64decode(payload).startswith(b"\x89PNG\r\n\x1a\n")
    # Sanity: the original /api/icons/hr path must NOT appear in the export.
    assert HR_HREF_PREFIX.encode() not in body


def test_non_hr_icon_href_passes_through(prisons_path: Path):
    parsed = parse_kml(str(prisons_path))
    custom = "http://maps.google.com/mapfiles/kml/paddle/red-blank.png"
    style = FeatureStyle(id="cat-test", icon=IconStyle(icon_href=custom))
    layer = SourceLayer(folder_name=prisons_path.stem, parsed=parsed)
    for i in range(len(parsed.placemarks)):
        layer.placemark_style_ids[i] = "cat-test"
    body = serialize(
        StyledDocument(document_name="styled", styles=[style], layers=[layer])
    )
    root = etree.fromstring(body)
    href_el = root.find(".//k:Style/k:IconStyle/k:Icon/k:href", NSMAP)
    assert href_el is not None and href_el.text == custom


def test_balloon_style_survives_cdata_round_trip(prisons_path: Path):
    """The BalloonStyle/text holds KML substitution tokens inside CDATA.
    If anything in the serialize pipeline strips or escapes them, Earth Pro
    will render literal '$[name]' strings instead of substituting them."""
    _, root = _round_trip(prisons_path)
    balloon_text = root.find(".//k:Style/k:BalloonStyle/k:text", NSMAP)
    assert balloon_text is not None
    assert balloon_text.text is not None
    # Substitution syntax must survive verbatim — neither HTML-escaped
    # ($&#91;name&#93;) nor stripped.
    assert "$[name]" in balloon_text.text
    # And the inline stylesheet must be intact so the balloon renders as the
    # evidence-document layout, not Earth Pro's raw ExtendedData table.
    assert "<style" in balloon_text.text


def test_emit_then_reparse_via_our_parser(prisons_path: Path):
    """The most important contract: our own serializer's output must be parsable by
    our own parser without loss, so the import-export cycle is closed."""
    body, _ = _round_trip(prisons_path)
    second_pass = parse_kml(body)
    original = parse_kml(str(prisons_path))
    assert len(second_pass.placemarks) == len(original.placemarks)
    for a, b in zip(second_pass.placemarks, original.placemarks):
        # Original keys all survived.
        for key in b.extended_data_order:
            assert a.extended_data.get(key) == b.extended_data.get(key)
