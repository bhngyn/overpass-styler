"""Verify that the hardened KML parser rejects or neutralises external entities.

XXE attacks come in several flavours:
  * DTD external entity reads a local file
  * "Billion laughs" entity expansion (DoS)
  * SSRF via http: entity reference

The investigator's KML supply is untrusted (mostly Overpass Turbo exports,
but anything claiming to be ``application/vnd.google-earth.kml+xml`` is
fair game). The parser must not resolve any of them.
"""

from __future__ import annotations

import pytest
from lxml.etree import XMLSyntaxError

from app.kml.parse import parse_kml


def test_external_entity_to_file_is_not_resolved(tmp_path) -> None:
    """A classic XXE payload pointing at /etc/passwd. The parser MUST NOT
    return the file's contents — either reject the document or leave the
    entity unexpanded as the empty string."""
    secret = tmp_path / "secret.txt"
    secret.write_text("THIS IS A SECRET")

    payload = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE kml [
  <!ENTITY xxe SYSTEM "file://{secret}">
]>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>&xxe;</name>
    <Placemark>
      <name>test</name>
    </Placemark>
  </Document>
</kml>
"""
    try:
        result = parse_kml(payload)
    except XMLSyntaxError:
        # Acceptable: lxml refused to parse the DTD entirely. Either path
        # achieves the goal — the secret never reaches the model.
        return

    name = (result.document_name or "")
    assert "THIS IS A SECRET" not in name, (
        f"XXE payload was expanded into the document name: {name!r}"
    )


def test_billion_laughs_is_not_expanded() -> None:
    """``entity_recursion`` style amplification — if the parser expands
    each entity, memory blows up. With ``resolve_entities=False`` the
    expansion never happens."""
    payload = """<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
]>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>&lol2;</name>
  </Document>
</kml>
"""
    try:
        result = parse_kml(payload)
    except XMLSyntaxError:
        return
    # Either rejected or the entity stayed as a literal (empty string after
    # the parser dropped the unresolved reference). What MUST NOT happen
    # is a 1000-character expansion landing in the model.
    name = (result.document_name or "")
    assert len(name) < 100, (
        "Billion-laughs entity was expanded — XXE hardening regressed"
    )


def test_normal_kml_still_parses() -> None:
    """Sanity check: hardening didn't break the happy path."""
    payload = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Smoke</name>
    <Placemark>
      <name>p1</name>
      <ExtendedData>
        <Data name="amenity"><value>prison</value></Data>
      </ExtendedData>
      <Point><coordinates>15.0,12.0</coordinates></Point>
    </Placemark>
  </Document>
</kml>
"""
    result = parse_kml(payload)
    assert result.document_name == "Smoke"
    assert len(result.placemarks) == 1
    assert result.placemarks[0].extended_data.get("amenity") == "prison"
