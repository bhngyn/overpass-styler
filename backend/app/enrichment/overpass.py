"""Overpass API client with health-aware mirror failover.

Investigators see Overpass outages all the time — a node is slow, a 504 lands
mid-query, a 429 says "back off". Rather than re-raise the first failure, this
module keeps a small pool of public Overpass mirrors and rotates through them
on retryable errors. Each mirror gets its own 1 req/sec rate-limit lock so
multiple mirrors can run in parallel from a single host.

The public surface is unchanged: ``execute_query``, ``execute_count``, and
``refetch_osm_tags`` all keep the signatures their callers depended on.
``execute_query_ex`` is the new variant that returns ``(data, served_by)`` for
the few callsites that want to surface "routed via …" to the user.

The pool is configured via the env var ``OVERPASS_STYLER_OVERPASS_URLS``
(comma-separated). Default is three well-known public mirrors taken from the
OSM wiki public-mirror list.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

USER_AGENT = "overpass-styler/0.1 (human rights mapping tool; one-off enrichment)"
TIMEOUT_SECONDS = 30.0

# HTTP-level read timeouts. Browse/preflight callers can scale the server-side
# Overpass timeout up to 180s for very large areas, so the HTTP socket needs
# enough headroom to outlast it. The default 30s is fine for the small
# enrichment refetch path.
_HTTP_TIMEOUT_FOR_LONG_QUERY_S = 240.0

_MIN_INTERVAL_S = 1.0

# Adaptive-timeout bounds. Investigators driving the count endpoint over a
# tiny city block want quick failure; the Browse "all of Mariupol" case
# tolerates Overpass thinking for a while. The clamp keeps both sane.
_TIMEOUT_MIN_S = 25
_TIMEOUT_MAX_S = 180

# Detects a leading "[out:...][timeout:...];" settings line so we don't double-stamp it.
_SETTINGS_LINE_RE = re.compile(r"^\s*(?:\[[^\]]+\]\s*)+;")

# Cooldown after a failure grows like exponential backoff, capped at 10 min so
# a transient outage doesn't permanently exile a mirror.
_COOLDOWN_BASE_S = 60.0
_COOLDOWN_MAX_S = 600.0

# Default mirror list. The first is the canonical bonn instance; the others
# are the two most widely cited up-to-date public mirrors on the OSM wiki.
_DEFAULT_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)

# Overpass returns 400 for both QL syntax errors *and* server-side overload
# ("runtime error: Query timed out"). We need to tell them apart so a bad
# query doesn't burn the whole mirror pool.
_OVERLOAD_400_RE = re.compile(
    r"(runtime error|query timed out|timeout|too many requests|gateway)",
    re.IGNORECASE,
)


class OverpassError(RuntimeError):
    """Raised when an Overpass call fails (HTTP error, timeout, malformed body)."""


# Threaded through every successful call so wrappers can report which mirror
# served the request. ``None`` after a call means "test monkeypatch — no
# real network was hit, so we don't know" — callers treat that as primary.
_served_by_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "overpass_served_by", default=None
)


@dataclass
class _EndpointHealth:
    """In-memory health state for a single Overpass mirror."""

    url: str
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_call_ts: float = 0.0
    consecutive_failures: int = 0
    cooldown_until: float = 0.0  # monotonic time; 0 means healthy
    # Synchronously bumped in ``_select_endpoint`` before any await so that
    # concurrent ``asyncio.gather`` callers see distinct selection states and
    # fan out across mirrors instead of all queueing behind whichever mirror
    # happened to sort first. Decremented in ``_execute_with_failover`` once
    # the call finishes (success or failure).
    in_flight: int = 0

    def cooldown_seconds(self) -> float:
        if self.consecutive_failures <= 0:
            return 0.0
        exp = min(self.consecutive_failures - 1, 8)  # cap exponent so we don't overflow
        return min(_COOLDOWN_BASE_S * (2.0**exp), _COOLDOWN_MAX_S)

    def mark_failure(self) -> None:
        self.consecutive_failures += 1
        self.cooldown_until = time.monotonic() + self.cooldown_seconds()

    def mark_success(self) -> None:
        self.consecutive_failures = 0
        self.cooldown_until = 0.0


def _parse_endpoint_env(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return _DEFAULT_ENDPOINTS
    urls = tuple(u.strip() for u in raw.split(",") if u.strip())
    return urls or _DEFAULT_ENDPOINTS


def _build_pool() -> list[_EndpointHealth]:
    urls = _parse_endpoint_env(os.environ.get("OVERPASS_STYLER_OVERPASS_URLS"))
    return [_EndpointHealth(url=u) for u in urls]


_POOL: list[_EndpointHealth] = _build_pool()


def _select_endpoint(exclude: set[str]) -> _EndpointHealth | None:
    """Pick the next mirror to try, skipping any already-tried in this call.

    Selection: prefer healthy endpoints (cooldown expired), sorted by
    (in_flight, consecutive_failures, last_call_ts). Sorting on
    ``in_flight`` first guarantees that when ``asyncio.gather`` fans out N
    concurrent tile fetches, each task picks a different mirror — without
    it they all see the same pool state before any await and queue behind
    the same per-mirror rate-limit lock, collapsing parallelism to 1.

    ``in_flight`` is bumped synchronously here and decremented in
    ``_execute_with_failover`` once the call finishes. If none are healthy
    we fall back to the soonest-expiring cooldown.
    """
    candidates = [e for e in _POOL if e.url not in exclude]
    if not candidates:
        return None
    now = time.monotonic()
    healthy = [e for e in candidates if e.cooldown_until <= now]
    if healthy:
        healthy.sort(
            key=lambda e: (e.in_flight, e.consecutive_failures, e.last_call_ts)
        )
        ep = healthy[0]
    else:
        candidates.sort(key=lambda e: (e.in_flight, e.cooldown_until))
        ep = candidates[0]
    ep.in_flight += 1
    return ep


def _primary_host() -> str | None:
    """Host of the first configured endpoint — used to suppress the
    ``routed via`` footnote when we used the primary mirror."""
    if not _POOL:
        return None
    return urlparse(_POOL[0].url).hostname


def served_by_label(url: str) -> str | None:
    """Return the hostname for ``url`` only if it isn't the primary mirror."""
    host = urlparse(url).hostname
    primary = _primary_host()
    if host and primary and host != primary:
        return host
    return None


async def _rate_limit_endpoint(ep: _EndpointHealth) -> None:
    """Enforce the 1 req/sec floor for a single endpoint."""
    async with ep.lock:
        now = time.monotonic()
        wait = max(0.0, _MIN_INTERVAL_S - (now - ep.last_call_ts))
        if wait > 0:
            await asyncio.sleep(wait)
        ep.last_call_ts = time.monotonic()


def _adaptive_timeout(area_hint_km2: float | None) -> int:
    """Pick an Overpass server-side timeout based on the bbox area hint."""
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


def _classify_failure(
    *, status: int | None, body: str | None, exc: BaseException | None
) -> tuple[bool, str]:
    """Decide whether to fail over to another mirror.

    Returns ``(retryable, summary)``. ``retryable=True`` means we should try
    another endpoint; ``False`` means raise immediately (e.g. a real QL
    syntax error — burning mirrors on it is pointless).
    """
    if isinstance(exc, (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError)):
        return True, f"{type(exc).__name__}: {exc}"
    if isinstance(exc, httpx.HTTPError):
        return True, f"{type(exc).__name__}: {exc}"
    if status is None:
        return False, "unknown failure with no status"
    if status in (429, 500, 502, 503, 504):
        return True, f"HTTP {status}"
    if status == 400:
        # Overpass uses 400 for both syntax errors and server-side timeouts.
        # We only retry the latter, identified by characteristic strings in
        # the body. Anything else is a real client-side bug — fail fast.
        if body and _OVERLOAD_400_RE.search(body):
            return True, f"HTTP 400 (server overload signal): {body[:200]}"
        return False, f"HTTP 400: {(body or '')[:200]}"
    return False, f"HTTP {status}: {(body or '')[:200]}"


async def _post_once(
    ep: _EndpointHealth,
    body: str,
    *,
    http_timeout: float,
) -> tuple[int, str]:
    """POST ``body`` to ``ep.url`` and return ``(status_code, text_body)``.

    Raises whatever ``httpx`` raises — the caller classifies the failure.
    """
    await _rate_limit_endpoint(ep)
    async with httpx.AsyncClient(timeout=http_timeout) as client:
        resp = await client.post(
            ep.url,
            data={"data": body},
            headers={"User-Agent": USER_AGENT},
        )
    return resp.status_code, resp.text


async def _execute_with_failover(body: str, *, http_timeout: float) -> tuple[dict[str, Any], str]:
    """Run ``body`` against the mirror pool with retry-on-failover.

    Returns ``(parsed_json, url_of_serving_endpoint)`` on success. Raises
    :class:`OverpassError` if every healthy mirror fails or a non-retryable
    error was returned.
    """
    if not _POOL:
        raise OverpassError("no Overpass endpoints configured")

    tried: set[str] = set()
    last_error: str = ""

    for _ in range(len(_POOL)):
        ep = _select_endpoint(exclude=tried)
        if ep is None:
            break
        tried.add(ep.url)

        # ``_select_endpoint`` bumps ``ep.in_flight``; release in finally so
        # an exception path doesn't leak a permanent reservation and lock the
        # mirror out of future selection rounds.
        try:
            try:
                status, text = await _post_once(ep, body, http_timeout=http_timeout)
            except httpx.HTTPError as exc:
                retryable, summary = _classify_failure(status=None, body=None, exc=exc)
                ep.mark_failure()
                last_error = f"{urlparse(ep.url).hostname}: {summary}"
                logger.warning("overpass failover: %s", last_error)
                if not retryable:
                    raise OverpassError(last_error) from exc
                continue

            if status >= 400:
                retryable, summary = _classify_failure(status=status, body=text, exc=None)
                if not retryable:
                    # Real QL error — surface immediately, don't burn the pool.
                    snippet = text.strip().splitlines()[:3]
                    detail = " ".join(snippet)[:500] if snippet else ""
                    raise OverpassError(
                        f"Overpass returned HTTP {status}"
                        + (f": {detail}" if detail else "")
                    )
                ep.mark_failure()
                last_error = f"{urlparse(ep.url).hostname}: {summary}"
                logger.warning("overpass failover: %s", last_error)
                continue

            # success — but Overpass can still return malformed bodies on a
            # degraded node. Treat a parse failure as retryable.
            try:
                data = json.loads(text)
            except ValueError:
                ep.mark_failure()
                last_error = f"{urlparse(ep.url).hostname}: non-JSON body"
                logger.warning("overpass failover: %s", last_error)
                continue
            if not isinstance(data, dict) or "elements" not in data:
                ep.mark_failure()
                last_error = f"{urlparse(ep.url).hostname}: missing 'elements'"
                logger.warning("overpass failover: %s", last_error)
                continue

            ep.mark_success()
            return data, ep.url
        finally:
            if ep.in_flight > 0:
                ep.in_flight -= 1

    raise OverpassError(
        f"All Overpass mirrors failed (last error: {last_error or 'no attempts made'})"
    )


async def execute_query(
    ql: str,
    *,
    timeout: int | None = None,
    area_hint_km2: float | None = None,
) -> dict[str, Any]:
    """Run a user-supplied Overpass QL query and return the parsed JSON body.

    Behaviour notes:
    - Auto-prepends ``[out:json][timeout:N];`` if the query doesn't already start
      with a settings line.
    - Iterates through configured mirrors on retryable failures (504, 429,
      timeout, connection error, "Query timed out"). Each mirror has its own
      1 req/sec rate-limit lock, so two simultaneous calls to different
      mirrors don't queue behind each other.
    - Stores the URL of the mirror that served the response in a contextvar
      so callers using :func:`execute_query_ex` can surface it as a
      "routed via" footnote.
    - Raises :class:`OverpassError` only when every mirror has been tried,
      or when the failure is non-retryable (e.g. a QL syntax error).
    """
    chosen_timeout = (
        timeout if timeout is not None else _adaptive_timeout(area_hint_km2)
    )
    stripped = ql.lstrip()
    if not _SETTINGS_LINE_RE.match(stripped):
        body = f"[out:json][timeout:{chosen_timeout}];{stripped}"
    else:
        body = stripped

    http_timeout = (
        TIMEOUT_SECONDS
        if chosen_timeout <= 25
        else min(_HTTP_TIMEOUT_FOR_LONG_QUERY_S, float(chosen_timeout) + 30.0)
    )

    data, url = await _execute_with_failover(body, http_timeout=http_timeout)
    _served_by_ctx.set(url)
    return data


async def execute_query_ex(
    ql: str,
    *,
    timeout: int | None = None,
    area_hint_km2: float | None = None,
) -> tuple[dict[str, Any], str | None]:
    """Like :func:`execute_query` but also returns the URL that served the
    response so callers can surface a "routed via …" footnote.

    Tests that monkeypatch :func:`execute_query` without going through the
    pool will see ``served_by`` as ``None`` — that's fine; the UI footnote
    only shows for non-primary mirrors anyway.
    """
    token = _served_by_ctx.set(None)
    try:
        data = await execute_query(ql, timeout=timeout, area_hint_km2=area_hint_km2)
        return data, _served_by_ctx.get()
    finally:
        _served_by_ctx.reset(token)


async def execute_count(
    ql_body: str,
    *,
    timeout: int | None = None,
    area_hint_km2: float | None = None,
) -> int:
    """Run a count-only Overpass query and return the total element count.

    Same wrap-and-failover semantics as :func:`execute_query`.
    """
    chosen_timeout = (
        timeout if timeout is not None else _adaptive_timeout(area_hint_km2)
    )
    body = ql_body.strip().rstrip(";")
    wrapped = f"[out:json][timeout:{chosen_timeout}];({body};);out count;"

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
    return len(elements)


async def refetch_osm_tags(osm_id: str) -> dict[str, str]:
    """Return the current set of tags for the given OSM element id.

    Uses the same pool-failover path as :func:`execute_query` so transient
    mirror outages don't break single-element refetches either.
    """
    kind, num = _parse_osm_id(osm_id)
    query = f"[out:json][timeout:25];{kind}({num});out tags;"
    data = await execute_query(query)
    elements = data.get("elements") or []
    if not elements:
        return {}
    tags = elements[0].get("tags") or {}
    return {"@id": osm_id, **{str(k): str(v) for k, v in tags.items()}}


# ---------------------------------------------------------------------------
# Test / introspection helpers
# ---------------------------------------------------------------------------


def _reset_pool_for_tests() -> None:
    """Recreate the pool from current env. Tests that swap
    ``OVERPASS_STYLER_OVERPASS_URLS`` mid-run use this to pick up the change."""
    global _POOL
    _POOL = _build_pool()


def endpoint_pool_snapshot() -> list[dict[str, Any]]:
    """Return a copy of the current health state (read-only, for telemetry)."""
    return [
        {
            "url": e.url,
            "consecutive_failures": e.consecutive_failures,
            "cooldown_until": e.cooldown_until,
            "last_call_ts": e.last_call_ts,
            "in_flight": e.in_flight,
        }
        for e in _POOL
    ]
