"""Overpass API client. Stateless, rate-limited at ~1 req/sec per the public
endpoint's etiquette."""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

import httpx

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "overpass-styler/0.1 (human rights mapping tool; one-off enrichment)"
TIMEOUT_SECONDS = 30.0

# HTTP-level read timeouts. Browse/preflight callers can scale the server-side
# Overpass timeout up to 180s for very large areas, so the HTTP socket needs
# enough headroom to outlast it. The default 30s above is fine for the small
# enrichment refetch path.
_HTTP_TIMEOUT_FOR_LONG_QUERY_S = 240.0

_last_call_ts: float = 0.0
_lock = asyncio.Lock()
_MIN_INTERVAL_S = 1.0

# Adaptive-timeout bounds. Investigators driving the count endpoint over a
# tiny city block want quick failure; the Browse "all of Mariupol" case
# tolerates Overpass thinking for a while. The clamp keeps both sane.
_TIMEOUT_MIN_S = 25
_TIMEOUT_MAX_S = 180

# Detects a leading "[out:...][timeout:...];" settings line so we don't double-stamp it.
_SETTINGS_LINE_RE = re.compile(r"^\s*(?:\[[^\]]+\]\s*)+;")


class OverpassError(RuntimeError):
    """Raised when an Overpass call fails (HTTP error, timeout, malformed body)."""


async def _rate_limit() -> None:
    global _last_call_ts
    async with _lock:
        now = time.monotonic()
        wait = max(0.0, _MIN_INTERVAL_S - (now - _last_call_ts))
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call_ts = time.monotonic()


def _adaptive_timeout(area_hint_km2: float | None) -> int:
    """Pick an Overpass server-side timeout based on the bbox area hint.

    The rule of thumb: every 100 km² of bbox adds ~1s to Overpass's processing
    budget on top of the 25s baseline. Clamped between 25s (the historical
    default — never make small queries slower) and 180s (above this, Overpass
    is more likely to refuse than to actually return).
    """
    if area_hint_km2 is None or area_hint_km2 <= 0:
        return _TIMEOUT_MIN_S
    proposed = int(area_hint_km2 / 100 + _TIMEOUT_MIN_S)
    return max(_TIMEOUT_MIN_S, min(_TIMEOUT_MAX_S, proposed))


def _parse_osm_id(osm_id: str) -> tuple[str, int]:
    # Overpass Turbo emits "node/123", "way/123", "relation/123".
    kind, _, num = osm_id.partition("/")
    if kind not in {"node", "way", "relation"} or not num.isdigit():
        raise ValueError(f"unrecognised OSM id: {osm_id!r}")
    return kind, int(num)


async def execute_query(
    ql: str,
    *,
    timeout: int | None = None,
    area_hint_km2: float | None = None,
) -> dict[str, Any]:
    """Run a user-supplied Overpass QL query and return the parsed JSON body.

    Behaviour notes:
    - Auto-prepends ``[out:json][timeout:N];`` if the query doesn't already start
      with a settings line (``[...]...;``). Investigators typing ad-hoc queries
      shouldn't have to remember the JSON output mode.
    - Shares the module-level lock so query execution honours the same ~1 req/sec
      etiquette as ``refetch_osm_tags``.
    - Raises :class:`OverpassError` on any HTTP / transport / parse failure with a
      message suitable for surfacing back to the investigator.

    Parameters
    ----------
    ql:
        The Overpass QL body. May start with its own settings line; if not
        we'll prepend one.
    timeout:
        Server-side Overpass timeout in seconds. If None and ``area_hint_km2``
        is provided we scale it via :func:`_adaptive_timeout`; otherwise we
        fall back to the historical 25s default.
    area_hint_km2:
        Optional bbox area in km². Browse/preflight callers pass this so that
        a 30,000 km² query gets ~180s on the Overpass side. The single-element
        refetch path leaves it None and inherits the snappy default.
    """
    chosen_timeout = (
        timeout if timeout is not None else _adaptive_timeout(area_hint_km2)
    )
    stripped = ql.lstrip()
    if not _SETTINGS_LINE_RE.match(stripped):
        body = f"[out:json][timeout:{chosen_timeout}];{stripped}"
    else:
        body = stripped

    # The HTTP socket has to outlast the server-side timeout, otherwise we
    # cut the connection right when Overpass would have returned. We pad by
    # ~30s for transport.
    http_timeout = (
        TIMEOUT_SECONDS
        if chosen_timeout <= 25
        else min(_HTTP_TIMEOUT_FOR_LONG_QUERY_S, float(chosen_timeout) + 30.0)
    )

    await _rate_limit()
    try:
        async with httpx.AsyncClient(timeout=http_timeout) as client:
            resp = await client.post(
                OVERPASS_URL,
                data={"data": body},
                headers={"User-Agent": USER_AGENT},
            )
    except httpx.TimeoutException as exc:
        raise OverpassError(f"Overpass request timed out after {http_timeout}s") from exc
    except httpx.HTTPError as exc:
        raise OverpassError(f"Overpass request failed: {exc}") from exc

    if resp.status_code >= 400:
        # Overpass returns useful diagnostics in the body for 400/429/504; surface
        # a trimmed copy so investigators can fix syntax errors / rate limits.
        snippet = resp.text.strip().splitlines()
        detail = " ".join(snippet[:3])[:500] if snippet else ""
        raise OverpassError(
            f"Overpass returned HTTP {resp.status_code}"
            + (f": {detail}" if detail else "")
        )

    try:
        data = resp.json()
    except ValueError as exc:
        raise OverpassError("Overpass returned a non-JSON body") from exc
    if not isinstance(data, dict) or "elements" not in data:
        raise OverpassError("Overpass response missing 'elements' list")
    return data


async def execute_count(
    ql_body: str,
    *,
    timeout: int | None = None,
    area_hint_km2: float | None = None,
) -> int:
    """Run a count-only Overpass query and return the total element count.

    ``ql_body`` is the *body* of the query — just the set selection, no
    ``[out:json]`` settings line and no trailing ``out`` statement. We wrap it
    as ``[out:json][timeout:N];({body}); out count;`` and parse Overpass's
    well-known count response shape:

        {"elements": [{"type": "count",
                       "tags": {"total": "N", "nodes": "...", ...}}]}

    Preflight callers use this to decide whether a region is small enough to
    fetch in one shot, large enough to need tiling, or hopeless. The query
    runs ~10x faster than a real geometry fetch — Overpass short-circuits
    once it knows the cardinality.

    Parameters mirror :func:`execute_query`. The default timeout is the
    snappy 25s; pass ``area_hint_km2`` to scale up for huge bboxes.
    """
    chosen_timeout = (
        timeout if timeout is not None else _adaptive_timeout(area_hint_km2)
    )
    body = ql_body.strip().rstrip(";")
    wrapped = f"[out:json][timeout:{chosen_timeout}];({body};);out count;"

    # Re-use execute_query so we get the same rate-limit, error-handling, and
    # HTTP-timeout logic. We pass the settings line already, so execute_query
    # won't double-stamp.
    data = await execute_query(wrapped, timeout=chosen_timeout)
    elements = data.get("elements") or []
    for el in elements:
        if el.get("type") != "count":
            continue
        tags = el.get("tags") or {}
        total = tags.get("total")
        if total is None:
            continue
        try:
            return int(total)
        except (TypeError, ValueError):
            continue
    # Older Overpass implementations have been seen to emit the count as a
    # bare integer in ``tags``. We tolerate any element that has a numeric
    # ``total``; if nothing matched we fall back to the element count.
    return len(elements)


async def refetch_osm_tags(osm_id: str) -> dict[str, str]:
    """Return the current set of tags for the given OSM element id."""
    kind, num = _parse_osm_id(osm_id)
    query = f"[out:json][timeout:25];{kind}({num});out tags;"
    await _rate_limit()
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        resp = await client.post(
            OVERPASS_URL,
            data={"data": query},
            headers={"User-Agent": USER_AGENT},
        )
    resp.raise_for_status()
    data = resp.json()
    elements = data.get("elements") or []
    if not elements:
        return {}
    tags = elements[0].get("tags") or {}
    # Always re-include the @id so the frontend can preserve it.
    return {"@id": osm_id, **{str(k): str(v) for k, v in tags.items()}}
