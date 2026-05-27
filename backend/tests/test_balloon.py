"""Tests for the BalloonStyle HTML renderer.

The balloon module emits a single per-category template; Earth Pro substitutes
`$[name]` / `$[hr:…]` / `$[<osmkey>]` tokens at render time. These tests assert
that the substitution syntax survives and that the output is well-formed HTML
the way Earth Pro's 2008-era renderer expects.
"""

from __future__ import annotations

from html.parser import HTMLParser

import pytest

from app.kml.balloon import render_balloon


class _Validator(HTMLParser):
    """Minimal sanity check: counts unmatched tags and records parse errors.

    Earth Pro is forgiving, but if our generator is emitting mismatched tags
    we'd rather know up front.
    """

    VOID_TAGS = {"br", "hr", "img", "meta", "link", "input"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.errors: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in self.VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # Self-closing — fine.
        return

    def handle_endtag(self, tag: str) -> None:
        if not self.stack:
            self.errors.append(f"closing </{tag}> with empty stack")
            return
        if self.stack[-1] != tag:
            self.errors.append(f"closing </{tag}> while top is <{self.stack[-1]}>")
            return
        self.stack.pop()


def _parse(html: str) -> _Validator:
    v = _Validator()
    v.feed(html)
    return v


def test_render_balloon_contains_name_token():
    html = render_balloon(
        "Detention facility",
        "data:image/png;base64,AAA",
        ["source_url", "date", "confidence", "note"],
    )
    assert "$[name]" in html


def test_render_balloon_contains_hr_substitution_tokens():
    html = render_balloon(
        "Detention facility",
        None,
        ["source_url", "date", "confidence", "note"],
    )
    assert "$[hr:source_url]" in html
    assert "$[hr:date]" in html
    assert "$[hr:confidence]" in html
    assert "$[hr:note]" in html


def test_render_balloon_includes_inline_style_block():
    html = render_balloon("Prison", None, ["note"])
    assert "<style" in html
    # Body styling — the load-bearing CSS that makes the balloon feel like a
    # printed page rather than Earth Pro's default table.
    assert "Georgia" in html
    assert "max-width" in html


def test_render_balloon_is_parseable_html():
    html = render_balloon(
        "Detention facility",
        "data:image/png;base64,AAA",
        ["source_url", "date", "confidence", "note"],
    )
    validator = _parse(html)
    assert validator.errors == []
    # Every opened tag closed.
    assert validator.stack == []


def test_render_balloon_empty_annotation_keys_still_valid():
    html = render_balloon("Misc", None, [])
    validator = _parse(html)
    assert validator.errors == []
    assert validator.stack == []
    # No EVIDENCE section header when there are no annotation fields.
    assert "Evidence" not in html
    # But the OSM tags section is always emitted.
    assert "OSM tags" in html


def test_render_balloon_source_url_renders_as_anchor():
    """An investigator's `source_url` should be clickable in the balloon."""
    html = render_balloon("Prison", None, ["source_url"])
    # The href and the visible text both use the substitution token so Earth
    # Pro replaces both on render.
    assert '<a href="$[hr:source_url]">$[hr:source_url]</a>' in html


def test_render_balloon_emits_osm_tag_rows():
    """The static template surfaces a small palette of common OSM keys so the
    balloon is useful even when the investigator hasn't added annotations."""
    html = render_balloon("Prison", None, [])
    for key in ("amenity", "landuse", "operator", "name:en"):
        assert f"$[{key}]" in html


def test_render_balloon_includes_osm_provenance_footer():
    html = render_balloon("Prison", None, [])
    assert "OpenStreetMap" in html
    # Provenance link uses the `@id` substitution to deep-link into OSM.
    assert "$[@id]" in html


def test_render_balloon_escapes_category_label():
    """Investigator-supplied category labels can contain HTML metacharacters
    (e.g. `<unknown>` or `Cafe & deli`); they must be escaped in the output."""
    html = render_balloon("Cafe & <deli>", None, [])
    assert "Cafe &amp; &lt;deli&gt;" in html
    # And not raw.
    assert "<deli>" not in html


def test_render_balloon_icon_href_omitted_when_none():
    html = render_balloon("Prison", None, [])
    # No <img> tag in the eyebrow when no icon was supplied.
    assert "<img" not in html


def test_render_balloon_icon_href_emitted_when_provided():
    href = "data:image/png;base64,iVBORw0KGgo="
    html = render_balloon("Prison", href, [])
    assert f'src="{href}"' in html


@pytest.mark.parametrize("missing", [None, ""])
def test_render_balloon_handles_empty_icon_href(missing):
    html = render_balloon("Prison", missing, ["note"])
    assert "<img" not in html
