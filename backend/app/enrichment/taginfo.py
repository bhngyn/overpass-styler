"""Taginfo API client.

Taginfo (https://taginfo.openstreetmap.org/api/4/) exposes structured OSM tag
metadata — key/value distributions, wiki summaries, search. We surface it to
the Tag Library drawer so investigators can decide *which* OSM tag to query.

Per the existing privacy contract (see ``CLAUDE.md``): all Taginfo calls are
opt-in actions, rate-limited at ~1 req/sec, and the results are cached on disk
for 7 days under ``$OVERPASS_STYLER_DATA_DIR/taginfo-cache/``. A cache hit
returns immediately without touching the network.

The module mirrors ``app.enrichment.overpass``'s rate-limit pattern (a shared
``asyncio.Lock`` + monotonic floor) so concurrent requests still honour the 1
req/sec etiquette of the public Taginfo endpoint.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

TAGINFO_BASE_URL = "https://taginfo.openstreetmap.org/api/4"
USER_AGENT = "overpass-styler/1.0 (atrocity-investigation tool)"
TIMEOUT_SECONDS = 20.0

# Cache TTL: 7 days. Tag metadata changes slowly on OSM scale and re-fetching
# every session would burn Taginfo's quota for no benefit.
_CACHE_TTL_SECONDS = 7 * 24 * 3600

# Rate-limit floor, same pattern as overpass.py.
_LAST_CALL: float = 0.0
_LOCK = asyncio.Lock()
_MIN_INTERVAL_S = 1.0


class TaginfoError(RuntimeError):
    """Raised when a Taginfo call fails (HTTP error, timeout, malformed body)."""


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------


def _data_dir() -> Path:
    """Resolve the on-disk cache root. Mirrors db.session._db_url's strategy."""
    data_dir = Path(os.environ.get("OVERPASS_STYLER_DATA_DIR", "/data"))
    if not data_dir.exists():
        # Fall back to repo-local for local non-docker runs.
        data_dir = Path(__file__).resolve().parents[3] / "data"
    return data_dir


def _cache_dir() -> Path:
    d = _data_dir() / "taginfo-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _slug(endpoint: str) -> str:
    """Filesystem-safe slug for an endpoint path."""
    return endpoint.strip("/").replace("/", "-")


def _params_hash(params: dict[str, Any]) -> str:
    """SHA-1 of sorted JSON-encoded params — stable across call ordering."""
    payload = json.dumps(sorted(params.items()), separators=(",", ":"), default=str)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _cache_path(endpoint: str, params: dict[str, Any]) -> Path:
    return _cache_dir() / f"{_slug(endpoint)}-{_params_hash(params)}.json"


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
        # Corrupt cache — fall through and re-fetch.
        return None


def _cache_write(path: Path, payload: Any) -> None:
    try:
        path.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        # Cache is best-effort. A write failure (read-only FS, full disk) must
        # not break the user-facing request.
        pass


# ---------------------------------------------------------------------------
# Rate-limited HTTP
# ---------------------------------------------------------------------------


async def _rate_limit() -> None:
    global _LAST_CALL
    async with _LOCK:
        now = time.monotonic()
        wait = max(0.0, _MIN_INTERVAL_S - (now - _LAST_CALL))
        if wait > 0:
            await asyncio.sleep(wait)
        _LAST_CALL = time.monotonic()


async def _get(endpoint: str, params: dict[str, Any]) -> Any:
    """GET ``{TAGINFO_BASE_URL}/{endpoint}`` with caching + rate-limiting.

    Returns the parsed JSON body. Cache hits skip both rate-limit and network.
    """
    cache_path = _cache_path(endpoint, params)
    cached = _cache_read(cache_path)
    if cached is not None:
        return cached

    await _rate_limit()
    url = f"{TAGINFO_BASE_URL}/{endpoint.lstrip('/')}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            resp = await client.get(
                url,
                params=params,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
    except httpx.TimeoutException as exc:
        raise TaginfoError(f"Taginfo request timed out after {TIMEOUT_SECONDS}s") from exc
    except httpx.HTTPError as exc:
        raise TaginfoError(f"Taginfo request failed: {exc}") from exc

    if resp.status_code >= 400:
        snippet = resp.text.strip().splitlines()
        detail = " ".join(snippet[:3])[:500] if snippet else ""
        raise TaginfoError(
            f"Taginfo returned HTTP {resp.status_code}" + (f": {detail}" if detail else "")
        )

    try:
        data = resp.json()
    except ValueError as exc:
        raise TaginfoError("Taginfo returned a non-JSON body") from exc

    _cache_write(cache_path, data)
    return data


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------


def _data_list(payload: Any) -> list[dict[str, Any]]:
    """Taginfo wraps result rows under ``data``; this unwraps defensively."""
    if isinstance(payload, dict):
        rows = payload.get("data")
        if isinstance(rows, list):
            return [r for r in rows if isinstance(r, dict)]
    return []


async def get_keys(*, min_count: int = 1000) -> list[dict[str, Any]]:
    """Return popular OSM keys, sorted by usage count desc.

    Wraps ``/api/4/keys/all?sortname=count&sortorder=desc``. ``min_count`` is
    enforced client-side (Taginfo's API has no minimum-count filter on the
    keys endpoint); callers asking for ``min_count=1000`` get back only keys
    used on at least 1000 OSM features.
    """
    payload = await _get(
        "keys/all",
        {"sortname": "count_all", "sortorder": "desc", "page": 1, "rp": 500},
    )
    rows = _data_list(payload)
    if min_count > 0:
        rows = [r for r in rows if int(r.get("count_all", 0)) >= min_count]
    return rows


async def get_values(key: str, *, limit: int = 100) -> list[dict[str, Any]]:
    """Return the top values for ``key``, sorted by usage count desc.

    Wraps ``/api/4/key/values?key=...&sortname=count&sortorder=desc``.
    """
    payload = await _get(
        "key/values",
        {
            "key": key,
            "sortname": "count",
            "sortorder": "desc",
            "page": 1,
            "rp": int(limit),
        },
    )
    return _data_list(payload)


async def get_tag(key: str, value: str) -> dict[str, Any]:
    """Return wiki-page metadata for a specific ``key=value`` pair.

    Wraps ``/api/4/tag/wiki_pages?key=...&value=...``. The response shape
    is Taginfo's standard ``{url, data_until, data: [...]}`` envelope; the
    caller (router) decides what to pass through.
    """
    payload = await _get("tag/wiki_pages", {"key": key, "value": value})
    if not isinstance(payload, dict):
        raise TaginfoError("Taginfo tag/wiki_pages returned a non-object body")
    return payload


async def search_by_keyword(q: str) -> list[dict[str, Any]]:
    """Free-text search across OSM tags. Wraps ``/api/4/search/by_keyword``."""
    payload = await _get(
        "search/by_keyword",
        {"query": q, "page": 1, "rp": 50},
    )
    return _data_list(payload)
