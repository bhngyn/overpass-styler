"""Nominatim reverse-geocoding client. Same rate-limit etiquette as Overpass."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
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


async def reverse_geocode(lat: float, lon: float) -> dict[str, Any]:
    await _rate_limit()
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        resp = await client.get(
            NOMINATIM_URL,
            params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18, "addressdetails": 1},
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en"},
        )
    resp.raise_for_status()
    payload = resp.json()
    if "error" in payload:
        raise RuntimeError(payload["error"])
    return {
        "address": {str(k): str(v) for k, v in (payload.get("address") or {}).items()},
        "display_name": str(payload.get("display_name") or ""),
    }
