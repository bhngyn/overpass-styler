"""Compose-mode auto-tiling for Overpass queries.

When an investigator's bbox-anchored Compose query is too big for a single
Overpass round-trip (over ~5000 features), this module splits the bbox into
an NxN grid, substitutes each tile's coordinates into the user's QL, runs
the tiles in parallel across the mirror pool, and merges the results
back into the standard Overpass-shaped ``{"elements": [...]}`` dict.

Browse mode tiles inventory queries the same way (see
:mod:`app.api.browse`), but it aggregates *summary* counts; here we need
the actual element bodies, deduplicated across tile-boundary overlap.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any
from urllib.parse import urlparse

from app.enrichment import overpass, tiling
from app.kml.from_overpass import DEFAULT_MAX_ELEMENTS

logger = logging.getLogger(__name__)

# Single-shot threshold. Below this we don't bother tiling — the round-trip
# cost dominates the win from splitting.
COMPOSE_SINGLE_SHOT_CAP = 5000

# Above this we refuse; the synthesizer's cap would drop the rest anyway,
# and tiling 50,000+ features balloons memory inside the request handler.
COMPOSE_HARD_CAP = DEFAULT_MAX_ELEMENTS

_BBOX_PLACEHOLDER_RE = re.compile(r"\{\{\s*bbox\s*\}\}")

# Re-used from projects.py via local copy so this module doesn't import the
# API router (which would create a cycle). The substitution shape is
# load-bearing: Overpass expects ``south,west,north,east``.
def _substitute_tile_bbox(query: str, tile: list[float]) -> str:
    west, south, east, north = tile
    return _BBOX_PLACEHOLDER_RE.sub(f"{south},{west},{north},{east}", query)


# Strip a leading ``[out:...][timeout:...];`` + trailing ``out body;`` etc.
# Mirrors projects.py._strip_outer_statements; duplicated here to avoid the
# import cycle. The trailing-out regex makes the args optional so that the
# bare ``out;`` idiom (most common form in Overpass Turbo exports) is also
# stripped — otherwise execute_count wraps it as ``(...;out;);out count;``
# which Overpass rejects with a parse error.
_LEADING_SETTINGS_RE = re.compile(r"^\s*(?:\[[^\]]+\]\s*)+;")
_TRAILING_OUT_RE = re.compile(r"\bout(?:\s+[^;]*)?;\s*$", re.IGNORECASE)


def _strip_outer_statements(ql: str) -> str:
    stripped = _LEADING_SETTINGS_RE.sub("", ql).strip()
    while True:
        new = _TRAILING_OUT_RE.sub("", stripped).strip()
        if new == stripped:
            break
        stripped = new
    return stripped.rstrip(";").strip()


async def _fetch_one(
    tile_query: str,
    *,
    area_hint_km2: float | None,
) -> tuple[dict[str, Any] | None, str | None, BaseException | None]:
    """Wrapper so ``asyncio.gather`` doesn't abort the whole batch on a tile
    error. Returns ``(data, served_by_url, exception)``."""
    try:
        data, url = await overpass.execute_query_ex(
            tile_query, area_hint_km2=area_hint_km2
        )
        return data, url, None
    except overpass.OverpassError as exc:
        return None, None, exc


def _merge_elements(tile_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Concatenate ``elements`` arrays from each tile result, deduping by
    ``(type, id)``. Overpass returns the same node at a tile boundary
    multiple times; deduping by id keeps the resulting KML clean.

    Order: first-write-wins on duplicates. We keep the *first* tile's copy
    so any per-tile ordering the user might rely on stays stable.
    """
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for result in tile_results:
        for el in result.get("elements") or []:
            t = el.get("type")
            i = el.get("id")
            if not isinstance(t, str) or not isinstance(i, int):
                # Some elements (count, area) don't have an integer id; keep
                # them as-is, they don't appear in geometry queries we tile.
                out.append(el)
                continue
            key = (t, i)
            if key in seen:
                continue
            seen.add(key)
            out.append(el)
    return out


async def run_overpass_maybe_tiled(
    query: str,
    bbox: list[float],
    *,
    area_hint_km2: float | None = None,
) -> tuple[dict[str, Any], str | None]:
    """Run ``query`` against the bbox, auto-tiling if the element count is
    large.

    Returns ``(overpass_response_dict, served_by_url_or_None)``. The dict
    shape matches a normal Overpass JSON body so the existing
    ``synthesize_kml`` path doesn't change.

    ``served_by_url`` is the URL of the mirror that served the (last) call,
    or None if it was the primary endpoint. Raises ``OverpassError`` for
    non-retryable failures, transport errors after all mirrors fail, and
    the explicit too-large refusal.
    """
    # Single-shot fast path — no count probe needed if there's no bbox
    # placeholder to substitute.
    if not _BBOX_PLACEHOLDER_RE.search(query):
        data, url = await overpass.execute_query_ex(
            query, area_hint_km2=area_hint_km2
        )
        return data, overpass.served_by_label(url)

    # Probe count first. This is one fast Overpass round-trip that lets us
    # decide between single-shot and tiling.
    base_query = _BBOX_PLACEHOLDER_RE.sub(
        f"{bbox[1]},{bbox[0]},{bbox[3]},{bbox[2]}", query
    )
    body = _strip_outer_statements(base_query)
    total = await overpass.execute_count(body, area_hint_km2=area_hint_km2)

    if total > COMPOSE_HARD_CAP:
        raise overpass.OverpassError(
            f"Query would return {total:,} features, above the {COMPOSE_HARD_CAP:,} cap. "
            "Narrow the bounding box or add a more specific tag filter."
        )

    if total <= COMPOSE_SINGLE_SHOT_CAP:
        data, url = await overpass.execute_query_ex(
            base_query, area_hint_km2=area_hint_km2
        )
        return data, overpass.served_by_label(url)

    # Tile and fetch in parallel across the mirror pool.
    bbox_tuple = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
    dim, tiles = tiling.plan_tile_bboxes(bbox_tuple, total)
    logger.info(
        "compose auto-tiling: %s features into %dx%d=%d tiles",
        total,
        dim,
        dim,
        len(tiles),
    )

    parallelism = max(1, len(overpass.endpoint_pool_snapshot()))
    tile_results: list[dict[str, Any]] = []
    failures: list[str] = []
    served_urls: list[str] = []

    for chunk_start in range(0, len(tiles), parallelism):
        chunk = tiles[chunk_start : chunk_start + parallelism]
        chunk_queries = [_substitute_tile_bbox(query, t) for t in chunk]
        chunk_outcomes = await asyncio.gather(
            *(
                _fetch_one(q, area_hint_km2=area_hint_km2 and area_hint_km2 / len(tiles))
                for q in chunk_queries
            )
        )
        for tile, (data, url, exc) in zip(chunk, chunk_outcomes, strict=True):
            if exc is not None:
                logger.warning("compose tile failed: %s — %s", tile, exc)
                failures.append(f"tile {tile}: {exc}")
                continue
            assert data is not None
            tile_results.append(data)
            if url:
                served_urls.append(url)

    if not tile_results:
        raise overpass.OverpassError(
            f"All {len(tiles)} tiles failed; first error: {failures[0] if failures else 'unknown'}"
        )
    if failures:
        # Soft-fail: we got some tiles, but log loudly so investigators can
        # see this in the response error banner if they want to retry.
        logger.warning(
            "compose tiling partial: %d/%d tiles failed", len(failures), len(tiles)
        )

    merged = _merge_elements(tile_results)
    # Borrow the generator metadata from the first tile result, then
    # overwrite the elements list. Overpass clients expect a ``version`` and
    # ``generator`` key on the top-level dict.
    first = tile_results[0]
    response: dict[str, Any] = {**first, "elements": merged}

    served_by = None
    if served_urls:
        # Report the last mirror that served — if it's not the primary, the
        # UI will show a "routed via" footnote.
        served_by = overpass.served_by_label(served_urls[-1])
    return response, served_by


__all__ = [
    "run_overpass_maybe_tiled",
    "COMPOSE_SINGLE_SHOT_CAP",
    "COMPOSE_HARD_CAP",
    "_merge_elements",
    "_substitute_tile_bbox",
]
