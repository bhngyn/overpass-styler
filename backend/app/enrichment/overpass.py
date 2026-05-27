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

_last_call_ts: float = 0.0
_lock = asyncio.Lock()
_MIN_INTERVAL_S = 1.0

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


def _parse_osm_id(osm_id: str) -> tuple[str, int]:
    # Overpass Turbo emits "node/123", "way/123", "relation/123".
    kind, _, num = osm_id.partition("/")
    if kind not in {"node", "way", "relation"} or not num.isdigit():
        raise ValueError(f"unrecognised OSM id: {osm_id!r}")
    return kind, int(num)


async def execute_query(ql: str, *, timeout: int = 25) -> dict[str, Any]:
    """Run a user-supplied Overpass QL query and return the parsed JSON body.

    Behaviour notes:
    - Auto-prepends ``[out:json][timeout:N];`` if the query doesn't already start
      with a settings line (``[...]...;``). Investigators typing ad-hoc queries
      shouldn't have to remember the JSON output mode.
    - Shares the module-level lock so query execution honours the same ~1 req/sec
      etiquette as ``refetch_osm_tags``.
    - Raises :class:`OverpassError` on any HTTP / transport / parse failure with a
      message suitable for surfacing back to the investigator.
    """
    stripped = ql.lstrip()
    if not _SETTINGS_LINE_RE.match(stripped):
        body = f"[out:json][timeout:{timeout}];{stripped}"
    else:
        body = stripped

    await _rate_limit()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            resp = await client.post(
                OVERPASS_URL,
                data={"data": body},
                headers={"User-Agent": USER_AGENT},
            )
    except httpx.TimeoutException as exc:
        raise OverpassError(f"Overpass request timed out after {TIMEOUT_SECONDS}s") from exc
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
