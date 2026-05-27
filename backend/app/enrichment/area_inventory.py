"""Area-inventory client for the Browse-mode workflow.

Browse-mode lets an investigator scope a bbox on the map and asks "what does
OSM know is here?". This module wraps three escalating Overpass calls:

* :func:`fetch_area_summary` — counts + top tags per domain (8 fixed domains:
  Amenities, Buildings, Landuse, Historic, Military, Highways, Natural,
  Manmade, Other). Used to render the domain picker. For oversized bboxes
  geometry is skipped entirely and only counts are returned.
* :func:`fetch_domain_items` — full per-feature listing for one ``key=value``
  scope within the bbox, with pagination via offset/limit. Powers the domain
  drill-down list.
* :func:`fetch_single_feature` — a precise lookup for one ``node/way/relation``
  with full geometry. Powers the feature detail pane and the "bake single
  feature into a layer" handoff.

Per the privacy contract these calls are opt-in (each request is an explicit
investigator action) and rate-limited by the shared lock in
:mod:`app.enrichment.overpass`. Results are cached on disk for 24 hours under
``$OVERPASS_STYLER_DATA_DIR/browse-cache/`` so repeated drill-downs into the
same area don't burn the Overpass quota.

Cache helper note: this duplicates the SHA-1/JSON-payload cache pattern from
:mod:`app.enrichment.taginfo`. They're close enough that a follow-up could
extract a shared ``CacheDir`` helper (TODO: see issue tracker — both modules
would benefit and the TTL is the only meaningful divergence).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from . import overpass


# Allowed character set for OSM tag keys and values when interpolated into
# Overpass QL. Real OSM tags are restricted to letters, digits, underscore,
# colon, hyphen, dot, and forward slash (the last for path-like values like
# "construction:railway"). Anything else is either a malformed tag or an
# injection attempt — reject before it hits Overpass.
#
# D1 review caught this: `fetch_domain_items` interpolated `key` and `value`
# straight into the QL string, so a value like `x"];out:csv(...);//` would
# escape the literal and reshape the query server-side.
_OSM_TAG_TOKEN = re.compile(r"^[A-Za-z0-9_:./-]+$")


class InvalidOsmTagError(ValueError):
    """Raised when a key/value pair can't be safely interpolated into QL."""


def _validate_osm_token(name: str, token: str) -> None:
    if not _OSM_TAG_TOKEN.match(token):
        raise InvalidOsmTagError(
            f"OSM {name} {token!r} contains characters that aren't safe to "
            f"interpolate into an Overpass query"
        )

# Cache TTL: 24 hours. Browse results are reconnaissance — investigators
# repeatedly drill in/out of the same area in one session, but a day-old
# snapshot of OSM is fine for almost every workflow.
_CACHE_TTL_SECONDS = 24 * 3600

# Default area cap for the summary endpoint. 200 km² is roughly a small city /
# a single Khartoum-sized district — large enough for most "what's in this
# neighbourhood" reconnaissance, small enough that Overpass returns in well
# under 60s. Above the cap, we fall back to a counts-only query (no center,
# no geometry) so the investigator still gets the domain breakdown.
DEFAULT_AREA_CAP_KM2 = 200.0

# Overpass server-side timeout (seconds). Generous because Browse callers run
# nwr({{bbox}}) queries that can legitimately take 30-50s on dense urban areas.
_QUERY_TIMEOUT = 60

# The 8 named domains plus "Other". Order matters — first match wins so we
# get a stable partition (a single feature with both ``amenity`` and
# ``building`` lands in Amenities).
DOMAINS: tuple[tuple[str, str], ...] = (
    ("Amenities", "amenity"),
    ("Buildings", "building"),
    ("Landuse", "landuse"),
    ("Historic", "historic"),
    ("Military", "military"),
    ("Highways", "highway"),
    ("Natural", "natural"),
    ("Manmade", "man_made"),
)
_DOMAIN_KEYS: tuple[str, ...] = tuple(k for _, k in DOMAINS)
OTHER_DOMAIN = "Other"


# ---------------------------------------------------------------------------
# Cache helpers (duplicated from taginfo.py — see module docstring)
# ---------------------------------------------------------------------------


def _data_dir() -> Path:
    """Resolve the on-disk cache root. Mirrors db.session._db_url's strategy."""
    data_dir = Path(os.environ.get("OVERPASS_STYLER_DATA_DIR", "/data"))
    if not data_dir.exists():
        # Fall back to repo-local for local non-docker runs.
        data_dir = Path(__file__).resolve().parents[3] / "data"
    return data_dir


def _cache_dir() -> Path:
    d = _data_dir() / "browse-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_key_hash(parts: list[Any]) -> str:
    """SHA-1 of a stable JSON encoding of the cache-key parts."""
    payload = json.dumps(parts, separators=(",", ":"), default=str, sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _cache_path(prefix: str, parts: list[Any]) -> Path:
    return _cache_dir() / f"{prefix}-{_cache_key_hash(parts)}.json"


def _cache_read(path: Path) -> Any | None:
    if not path.exists():
        return None
    try:
        age = time.time() - path.stat().st_mtime
    except OSError:
        return None
    if age > _CACHE_TTL_SECONDS:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _cache_write(path: Path, payload: Any) -> None:
    try:
        path.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        # Cache is best-effort — never let a write failure break the request.
        pass


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def _bbox_area_km2(bbox: tuple[float, float, float, float]) -> float:
    """Approximate the area of a ``[west, south, east, north]`` bbox in km².

    Uses the equirectangular ``cos(mean_lat)`` shortcut — exact enough for the
    purpose (deciding "is this bbox too big to fetch with geometry?"). A 200km²
    cap doesn't need haversine precision.
    """
    west, south, east, north = bbox
    if east < west or north < south:
        return 0.0
    mean_lat_rad = math.radians((south + north) / 2.0)
    km_per_deg_lat = 110.574
    km_per_deg_lon = 111.320 * math.cos(mean_lat_rad)
    dy = (north - south) * km_per_deg_lat
    dx = (east - west) * km_per_deg_lon
    return max(0.0, dx * dy)


def _overpass_bbox(bbox: tuple[float, float, float, float]) -> str:
    """Render WSEN-style bbox as Overpass's S,W,N,E token."""
    west, south, east, north = bbox
    return f"{south},{west},{north},{east}"


# ---------------------------------------------------------------------------
# Domain partitioning
# ---------------------------------------------------------------------------


def _domain_for_tags(tags: dict[str, Any]) -> tuple[str, str | None, str | None]:
    """Return ``(domain_name, primary_key, primary_value)`` for one element.

    The first matching key wins, so a feature tagged ``amenity=prison`` +
    ``building=yes`` lands in Amenities (not Buildings). The primary
    ``key/value`` are returned so the caller can tally top tags per domain.
    Returns ``(OTHER_DOMAIN, None, None)`` for elements with no recognised
    domain key.
    """
    if not isinstance(tags, dict):
        return OTHER_DOMAIN, None, None
    for name, key in DOMAINS:
        val = tags.get(key)
        if isinstance(val, str) and val:
            return name, key, val
    return OTHER_DOMAIN, None, None


def _element_center(element: dict[str, Any]) -> list[float] | None:
    """Pick a representative ``[lon, lat]`` for an element.

    Nodes carry ``lon``/``lat`` directly; ``out center`` decorates ways and
    relations with a ``center: {lat, lon}`` block. Anything else returns None.
    """
    if "lon" in element and "lat" in element:
        try:
            return [float(element["lon"]), float(element["lat"])]
        except (TypeError, ValueError):
            return None
    center = element.get("center")
    if isinstance(center, dict) and "lon" in center and "lat" in center:
        try:
            return [float(center["lon"]), float(center["lat"])]
        except (TypeError, ValueError):
            return None
    return None


def _element_geometry_kind(element: dict[str, Any]) -> str:
    """Map an Overpass element to a coarse geometry kind string.

    ``"Point"`` for nodes, ``"Polygon"`` for closed ways and multipolygon
    relations, ``"LineString"`` for open ways. The caller only uses this to
    badge the row in the UI; precise geometry comes from
    :func:`fetch_single_feature`.
    """
    kind = element.get("type")
    if kind == "node":
        return "Point"
    if kind == "way":
        geom = element.get("geometry") or []
        if len(geom) >= 4:
            first = geom[0]
            last = geom[-1]
            if (
                isinstance(first, dict)
                and isinstance(last, dict)
                and first.get("lon") == last.get("lon")
                and first.get("lat") == last.get("lat")
            ):
                return "Polygon"
        return "LineString"
    if kind == "relation":
        tags = element.get("tags") or {}
        if tags.get("type") == "multipolygon":
            return "Polygon"
        return "Relation"
    return "Unknown"


def _build_domain_summary(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Partition elements into domains and emit per-domain summary rows.

    Each row: ``{name, count, top_tags: [{key, value, count}, ...]}`` with
    ``top_tags`` sorted by frequency desc, limited to 5 entries.
    """
    buckets: dict[str, list[tuple[str | None, str | None]]] = defaultdict(list)
    for el in elements:
        tags = el.get("tags") or {}
        domain, key, value = _domain_for_tags(tags)
        buckets[domain].append((key, value))

    out: list[dict[str, Any]] = []
    # Emit in the canonical DOMAINS order, then Other, so the frontend can
    # render with a stable layout regardless of which domains happen to be
    # populated.
    ordered_names = [name for name, _ in DOMAINS] + [OTHER_DOMAIN]
    for name in ordered_names:
        items = buckets.get(name) or []
        if not items:
            continue
        # Tally (key,value) frequencies; skip entries with no recognised key
        # (the Other bucket).
        tally: Counter[tuple[str, str]] = Counter()
        for k, v in items:
            if k and v:
                tally[(k, v)] += 1
        top_tags = [
            {"key": k, "value": v, "count": c}
            for (k, v), c in tally.most_common(5)
        ]
        out.append({"name": name, "count": len(items), "top_tags": top_tags})
    return out


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------


async def fetch_area_summary(
    bbox: tuple[float, float, float, float],
    *,
    area_cap_km2: float = DEFAULT_AREA_CAP_KM2,
) -> dict[str, Any]:
    """Fetch an Overpass-backed summary of the OSM features inside ``bbox``.

    Behaviour:

    * If ``bbox`` exceeds ``area_cap_km2``, runs a ``out tags;`` query (no
      geometry) and returns ``{"area_capped": True, "domain_counts": {...},
      "total_count": N}``. The caller renders an "area too large to preview —
      narrow the box" hint with per-domain counts to guide refinement.
    * Otherwise runs ``out tags center;`` (centers but no full geometry — fast)
      and returns the per-domain summary the UI uses to populate the
      Browse-mode domain picker.

    Cached on disk for 24h keyed on the bbox.
    """
    cache_path = _cache_path("summary", [list(bbox), area_cap_km2])
    cached = _cache_read(cache_path)
    if cached is not None:
        return cached

    area_km2 = _bbox_area_km2(bbox)
    bbox_tok = _overpass_bbox(bbox)

    if area_km2 > area_cap_km2:
        # Counts-only path: out tags; emits one row per element with just its
        # tags. We still get to partition by domain — we just can't draw the
        # centers on a map.
        ql = (
            f"[out:json][timeout:{_QUERY_TIMEOUT}];"
            f"(nwr({bbox_tok}););"
            "out tags;"
        )
        data = await overpass.execute_query(ql, timeout=_QUERY_TIMEOUT)
        elements = data.get("elements") or []
        domain_counts: dict[str, int] = defaultdict(int)
        for el in elements:
            domain, _key, _value = _domain_for_tags(el.get("tags") or {})
            domain_counts[domain] += 1
        result = {
            "area_capped": True,
            "area_km2": area_km2,
            "area_cap_km2": area_cap_km2,
            "domain_counts": dict(domain_counts),
            "total_count": len(elements),
        }
        _cache_write(cache_path, result)
        return result

    ql = (
        f"[out:json][timeout:{_QUERY_TIMEOUT}];"
        f"(nwr({bbox_tok}););"
        "out tags center;"
    )
    data = await overpass.execute_query(ql, timeout=_QUERY_TIMEOUT)
    elements = data.get("elements") or []
    domains = _build_domain_summary(elements)
    result = {
        "area_capped": False,
        "area_km2": area_km2,
        "area_cap_km2": area_cap_km2,
        "summary": {
            "bbox": list(bbox),
            "total_count": len(elements),
        },
        "domains": domains,
        "total_count": len(elements),
    }
    _cache_write(cache_path, result)
    return result


async def fetch_domain_items(
    bbox: tuple[float, float, float, float],
    key: str,
    value: str,
    *,
    limit: int = 200,
    offset: int = 0,
) -> dict[str, Any]:
    """Fetch the items for one ``key=value`` scope inside ``bbox``.

    Returns ``{items: [...], has_more: bool, next_offset: int, total: N}``.
    Each item has the shape ``{osm_id, name, tags, geometry_kind, center}``.

    Pagination is offset-based and applied client-side: Overpass doesn't
    paginate, so we fetch the full set, cache it, and slice. ``has_more`` is
    True when more items exist beyond ``offset + limit``.
    """
    # Reject anything that wouldn't survive a strict OSM-tag character class
    # before interpolating into QL. The router does its own validation but
    # this is defence-in-depth — any future caller that bypasses the router
    # still can't reshape the Overpass query.
    _validate_osm_token("key", key)
    _validate_osm_token("value", value)

    cache_path = _cache_path("items", [list(bbox), key, value])
    cached = _cache_read(cache_path)
    if cached is None:
        bbox_tok = _overpass_bbox(bbox)
        # Use full body+geom so the detail pane and bake handoff get the data
        # they need without a second round-trip. Geometry is per-element, which
        # keeps lxml downstream simple.
        ql = (
            f"[out:json][timeout:{_QUERY_TIMEOUT}];"
            f'nwr["{key}"="{value}"]({bbox_tok});'
            "out body geom;"
        )
        data = await overpass.execute_query(ql, timeout=_QUERY_TIMEOUT)
        elements = data.get("elements") or []
        items: list[dict[str, Any]] = []
        for el in elements:
            kind = el.get("type")
            ident = el.get("id")
            if not isinstance(kind, str) or ident is None:
                continue
            osm_id = f"{kind}/{ident}"
            tags = el.get("tags") or {}
            name = tags.get("name") if isinstance(tags.get("name"), str) else None
            items.append(
                {
                    "osm_id": osm_id,
                    "name": name,
                    "tags": {str(k): str(v) for k, v in tags.items()},
                    "geometry_kind": _element_geometry_kind(el),
                    "center": _element_center(el),
                }
            )
        cached = {"items": items}
        _cache_write(cache_path, cached)

    items = cached.get("items", [])
    total = len(items)
    window = items[offset : offset + limit]
    next_offset = offset + len(window)
    has_more = next_offset < total
    return {
        "items": window,
        "has_more": has_more,
        "next_offset": next_offset,
        "total": total,
    }


def _parse_osm_id(osm_id: str) -> tuple[str, int]:
    """Validate + split a ``node/123`` / ``way/123`` / ``relation/123`` id."""
    kind, _, num = osm_id.partition("/")
    if kind not in {"node", "way", "relation"} or not num.isdigit():
        raise ValueError(f"unrecognised OSM id: {osm_id!r}")
    return kind, int(num)


def _wiki_links_for_tags(osm_id: str, tags: dict[str, Any]) -> list[dict[str, str]]:
    """Build the ``wiki_links`` payload for a single feature.

    Always includes the canonical openstreetmap.org element page; appends a
    Wikidata link if ``tags.wikidata`` is present, and a Wikipedia link if
    ``tags.wikipedia`` matches the standard ``lang:Title`` shape.
    """
    kind, num = _parse_osm_id(osm_id)
    links: list[dict[str, str]] = [
        {
            "kind": "openstreetmap",
            "label": f"OSM {kind}/{num}",
            "url": f"https://www.openstreetmap.org/{kind}/{num}",
        }
    ]
    wikidata = tags.get("wikidata")
    if isinstance(wikidata, str) and wikidata.strip():
        qid = wikidata.strip()
        links.append(
            {
                "kind": "wikidata",
                "label": qid,
                "url": f"https://www.wikidata.org/wiki/{qid}",
            }
        )
    wikipedia = tags.get("wikipedia")
    if isinstance(wikipedia, str) and ":" in wikipedia:
        lang, _, title = wikipedia.partition(":")
        if lang and title:
            # OSM convention: spaces stay as spaces in the tag, Wikipedia
            # normalises them to underscores in the URL path.
            slug = title.replace(" ", "_")
            links.append(
                {
                    "kind": "wikipedia",
                    "label": wikipedia,
                    "url": f"https://{lang}.wikipedia.org/wiki/{slug}",
                }
            )
    return links


async def fetch_single_feature(osm_id: str) -> dict[str, Any]:
    """Look up one OSM element by id (e.g. ``node/123``) with full geometry.

    Returns ``{osm_id, name, tags, geometry, raw, wiki_links}``. ``raw`` is
    the unmodified Overpass element dict so callers (especially the bake
    handoff) can hand it straight to :func:`app.kml.from_overpass.synthesize_kml`
    without a second network call.
    """
    kind, num = _parse_osm_id(osm_id)
    cache_path = _cache_path("feature", [osm_id])
    cached = _cache_read(cache_path)
    if cached is None:
        ql = (
            f"[out:json][timeout:{_QUERY_TIMEOUT}];"
            f"{kind}({num});"
            "out body geom;"
        )
        data = await overpass.execute_query(ql, timeout=_QUERY_TIMEOUT)
        elements = data.get("elements") or []
        if not elements:
            raise overpass.OverpassError(f"no element found for {osm_id}")
        element = elements[0]
        tags = element.get("tags") or {}
        name = tags.get("name") if isinstance(tags.get("name"), str) else None
        geometry_kind = _element_geometry_kind(element)
        # Pull a compact geometry payload for the UI — full geom for ways,
        # center+lonlat for nodes, members for relations.
        geometry: dict[str, Any] = {"kind": geometry_kind}
        if kind == "node":
            geometry["point"] = _element_center(element)
        elif kind == "way":
            coords = [
                [float(p["lon"]), float(p["lat"])]
                for p in (element.get("geometry") or [])
                if isinstance(p, dict) and "lon" in p and "lat" in p
            ]
            geometry["coordinates"] = coords
        elif kind == "relation":
            members = []
            for m in element.get("members") or []:
                if not isinstance(m, dict):
                    continue
                coords = [
                    [float(p["lon"]), float(p["lat"])]
                    for p in (m.get("geometry") or [])
                    if isinstance(p, dict) and "lon" in p and "lat" in p
                ]
                members.append(
                    {
                        "type": m.get("type"),
                        "ref": m.get("ref"),
                        "role": m.get("role"),
                        "coordinates": coords,
                    }
                )
            geometry["members"] = members
        cached = {
            "osm_id": osm_id,
            "name": name,
            "tags": {str(k): str(v) for k, v in tags.items()},
            "geometry": geometry,
            "raw": element,
            "wiki_links": _wiki_links_for_tags(osm_id, tags),
        }
        _cache_write(cache_path, cached)
    return cached
