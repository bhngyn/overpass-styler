"""Overpass API client. Stateless, rate-limited at ~1 req/sec per the public
endpoint's etiquette."""

from __future__ import annotations

import asyncio
import time

import httpx

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "overpass-styler/0.1 (human rights mapping tool; one-off enrichment)"
TIMEOUT_SECONDS = 30.0

_last_call_ts: float = 0.0
_lock = asyncio.Lock()
_MIN_INTERVAL_S = 1.0


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
