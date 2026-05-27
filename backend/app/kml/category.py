"""Detect the 'primary' OSM tag for grouping Placemarks into categories.

Overpass Turbo exports use ``<Data name="...">`` fields inside ``<ExtendedData>`` to
carry OSM tags. To group features in a meaningful way, we pick the first non-meta tag
the placemark has — for prisons that's ``amenity``, for cemeteries that's ``landuse``,
etc. The investigator can override this choice in the UI.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

# Tags that describe metadata or display, not the feature itself.
_META_KEYS: frozenset[str] = frozenset(
    {"@id", "type", "source", "fixme", "name"}
)

# Prefixes we always skip when looking for the categorising tag.
_META_PREFIXES: tuple[str, ...] = (
    "name:",      # localised names
    "alt_name",   # alternative names
    "addr:",      # address detail, not category
    "project:",   # OSM survey project markers
    "note",       # editor notes
    "wikipedia",
    "wikidata",
    "ref:",
    "old_name",
    "official_name",
)

# Preference order — when multiple primary tags exist on a placemark, prefer these.
_PREFERRED_ORDER: tuple[str, ...] = (
    "amenity", "landuse", "leisure", "natural", "tourism", "historic",
    "building", "highway", "railway", "waterway", "shop", "office",
    "military", "boundary", "place", "religion", "denomination",
)


def is_meta_key(key: str) -> bool:
    if key in _META_KEYS:
        return True
    return any(key == p.rstrip(":") or key.startswith(p) for p in _META_PREFIXES)


def primary_tag(extended_data: Mapping[str, str]) -> str | None:
    """Return the categorising tag key for a placemark, or None if nothing useful."""
    candidates = [k for k in extended_data if not is_meta_key(k)]
    if not candidates:
        return None
    for preferred in _PREFERRED_ORDER:
        if preferred in candidates:
            return preferred
    # Fall back to the first candidate in document order.
    return candidates[0]


def detect_category_key(placemarks_data: Iterable[Mapping[str, str]]) -> str | None:
    """Pick the tag key most placemarks share, biased by _PREFERRED_ORDER."""
    counts: dict[str, int] = {}
    for ext in placemarks_data:
        key = primary_tag(ext)
        if key:
            counts[key] = counts.get(key, 0) + 1
    if not counts:
        return None
    # Highest count wins; ties broken by preferred order, then alphabetical.
    preferred_rank = {k: i for i, k in enumerate(_PREFERRED_ORDER)}
    return min(
        counts,
        key=lambda k: (-counts[k], preferred_rank.get(k, len(_PREFERRED_ORDER)), k),
    )
