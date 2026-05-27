"""Render the HTML body of `<BalloonStyle><text>` for a category style.

Earth Pro's balloon renderer is roughly a 2008-era HTML+CSS engine: no JS, no
flexbox, no CSS variables, no media queries. The template here uses KML
substitution tokens (`$[name]`, `$[hr:source_url]`, `$[amenity]`, …) so a
single per-category balloon HTML serves every placemark in that category.
Missing substitutions render as empty strings — acceptable for v1.

Design goals (evidence-document feel):

  * Serif title, sans-serif body. Restrained ink-on-paper palette.
  * Clear visual separation between investigator annotations (the *evidence*
    block under the ``hr:`` namespace) and raw OSM tags pulled from Overpass.
  * Category badge (icon + small-caps label) acts as eyebrow text.
  * Footer pointer back to OpenStreetMap for provenance.

The returned string is the **inner HTML** — the serializer wraps it in CDATA.
"""

from __future__ import annotations

from html import escape

# The OSM tag keys most frequently relevant to investigator workflows. The
# balloon emits a row for each one. Earth Pro only substitutes `$[KEY]` when
# the placemark has a matching `<Data name="KEY">` entry — otherwise the
# token renders literally. The serializer leans on ``DEFAULT_OSM_TAG_KEYS``
# to inject empty stubs so every token resolves, even when the underlying
# placemark is missing that tag.
DEFAULT_OSM_TAG_KEYS: tuple[str, ...] = (
    "amenity",
    "landuse",
    "building",
    "operator",
    "name:en",
    "addr:city",
    "addr:country",
    "start_date",
    "wikipedia",
)
# Backward-compat alias — keep the private name a reachable export so any
# existing import keeps working. Newer code should use the public name.
_DEFAULT_OSM_TAG_KEYS = DEFAULT_OSM_TAG_KEYS

# Inline stylesheet. Earth Pro tolerates a `<style>` block at the top of the
# balloon body — keep selectors simple (tag + class), no descendant combinators
# beyond a single level, and no modern features.
_STYLE_BLOCK = """\
<style type="text/css">
  body, .hr-balloon {
    font-family: -apple-system, "system-ui", "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    background: #fafaf6;
    padding: 14px 16px;
    max-width: 380px;
    line-height: 1.4;
  }
  .hr-eyebrow {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #2a5d6b;
    margin: 0 0 4px 0;
  }
  .hr-eyebrow img {
    width: 12px;
    height: 12px;
    vertical-align: -2px;
    margin-right: 4px;
  }
  .hr-title {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 20px;
    font-weight: 600;
    margin: 6px 0 4px 0;
    color: #1a1a1a;
  }
  .hr-rule {
    border: none;
    border-top: 1px solid #d8d2c0;
    margin: 8px 0 10px 0;
  }
  .hr-section {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #2a5d6b;
    margin: 14px 0 6px 0;
    padding-bottom: 3px;
    border-bottom: 1px solid #e0d8c0;
  }
  table.hr-kv {
    border-collapse: collapse;
    font-size: 12px;
    width: 100%;
    margin: 0;
  }
  table.hr-kv td {
    padding: 3px 0;
    vertical-align: top;
  }
  table.hr-kv td.hr-k {
    color: #6a6a6a;
    padding-right: 12px;
    width: 40%;
    white-space: nowrap;
  }
  table.hr-kv tr.hr-alt td {
    background: #f4f1e8;
  }
  .hr-footer {
    font-size: 10px;
    color: #8a8a8a;
    margin-top: 14px;
    border-top: 1px solid #e0d8c0;
    padding-top: 6px;
  }
  .hr-footer a {
    color: #2a5d6b;
    text-decoration: none;
  }
  a {
    color: #2a5d6b;
  }
</style>"""


def _humanize_key(key: str) -> str:
    """`source_url` -> `Source`, `start_date` -> `Start date`.

    Special-cases the common `hr:*` annotation keys so they read naturally in
    the balloon. Falls back to a title-case-with-spaces transform.
    """
    overrides = {
        "source_url": "Source",
        "source": "Source",
        "source_url": "Source",
        "date": "Date",
        "date_observed": "Date observed",
        "confidence": "Confidence",
        "note": "Note",
        "field_notes": "Field notes",
        "name:en": "Name (en)",
        "addr:city": "City",
        "addr:country": "Country",
        "start_date": "Start date",
    }
    if key in overrides:
        return overrides[key]
    cleaned = key.replace("_", " ").replace(":", " ").strip()
    return cleaned[:1].upper() + cleaned[1:] if cleaned else key


def _render_kv_row(label: str, value_html: str, *, alt: bool) -> str:
    cls = ' class="hr-alt"' if alt else ""
    return (
        f"  <tr{cls}><td class=\"hr-k\">{escape(label)}</td>"
        f"<td>{value_html}</td></tr>"
    )


def _render_evidence_value(field: str) -> str:
    """Build the right-hand cell for an annotation field.

    The values are emitted as KML substitution tokens (`$[hr:source_url]`)
    so Earth Pro replaces them at render time. We wrap `source_url`-like
    fields in an `<a>` so investigators get a clickable link.
    """
    token = f"$[hr:{field}]"
    lowered = field.lower()
    if "url" in lowered or lowered in {"source", "link"}:
        return f'<a href="{token}">{token}</a>'
    return token


def render_balloon(
    category_label: str,
    category_icon_href: str | None,
    annotation_keys: list[str],
) -> str:
    """Return the inner HTML (no CDATA wrapper) for a category's BalloonStyle.

    Parameters
    ----------
    category_label:
        Human-readable category name, e.g. "Detention facility" or
        "amenity=prison". Rendered in the small-caps eyebrow.
    category_icon_href:
        URL or `data:` URI for the badge icon. Pass the already-resolved value
        from `_resolve_export_href` so bundled icons embed cleanly. May be
        ``None`` to omit the badge.
    annotation_keys:
        Ordered list of `hr:*` annotation field names to surface in the
        EVIDENCE section, e.g. ``["source_url", "date", "confidence", "note"]``.
        Empty list is allowed; the section is omitted.

    Returns
    -------
    A string of HTML safe for injection inside ``<![CDATA[…]]>``. The string
    contains KML substitution tokens that Earth Pro fills in per-placemark.
    """
    parts: list[str] = [_STYLE_BLOCK, '<div class="hr-balloon">']

    # Eyebrow: badge icon + category label, small-caps.
    eyebrow_inner: list[str] = []
    if category_icon_href:
        eyebrow_inner.append(f'<img src="{escape(category_icon_href, quote=True)}" alt="">')
    eyebrow_inner.append(escape(category_label or "Feature"))
    parts.append(f'<div class="hr-eyebrow">{"".join(eyebrow_inner)}</div>')

    # Serif title — Earth Pro substitutes the placemark name.
    parts.append('<h1 class="hr-title">$[name]</h1>')
    parts.append('<hr class="hr-rule"/>')

    # NOTES section — investigator annotations under hr:* namespace.
    if annotation_keys:
        parts.append('<div class="hr-section">Notes</div>')
        parts.append('<table class="hr-kv">')
        for idx, key in enumerate(annotation_keys):
            parts.append(
                _render_kv_row(
                    _humanize_key(key),
                    _render_evidence_value(key),
                    alt=(idx % 2 == 1),
                )
            )
        parts.append("</table>")

    # OSM TAGS section — emit rows for the most-common keys. Earth Pro fills
    # in missing ones as empty strings; the alternating shading still reads.
    parts.append('<div class="hr-section">OSM tags</div>')
    parts.append('<table class="hr-kv">')
    for idx, key in enumerate(_DEFAULT_OSM_TAG_KEYS):
        parts.append(
            _render_kv_row(
                _humanize_key(key),
                f"$[{key}]",
                alt=(idx % 2 == 1),
            )
        )
    parts.append("</table>")

    # Footer — provenance pointer back to OSM. `$[@id]` is e.g. `node/12345`.
    parts.append(
        '<div class="hr-footer">'
        "<i>OSM data &copy; OpenStreetMap contributors</i>"
        ' &middot; <a href="https://www.openstreetmap.org/$[@id]">view on OSM &#8599;</a>'
        "</div>"
    )

    parts.append("</div>")
    return "\n".join(parts)
