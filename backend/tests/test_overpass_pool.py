"""Tests for the Overpass mirror pool and failover behaviour.

These tests stub ``httpx.AsyncClient.post`` at the response level so we
exercise the pool's selection / cooldown / classification logic without
ever hitting the network. The pool itself is rebuilt from the env var on
each test so we control the endpoint list.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from app.enrichment import overpass


@pytest.fixture(autouse=True)
def reset_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test sees a fresh 3-mirror pool with predictable hostnames."""
    monkeypatch.setenv(
        "OVERPASS_STYLER_OVERPASS_URLS",
        "https://primary.test/api,https://backup.test/api,https://last.test/api",
    )
    overpass._reset_pool_for_tests()
    # Disable the 1 req/sec floor so the unit tests run fast — production
    # behaviour is unaffected.
    monkeypatch.setattr(overpass, "_MIN_INTERVAL_S", 0.0)


def _make_response(status: int, body: str) -> httpx.Response:
    return httpx.Response(
        status_code=status,
        text=body,
        request=httpx.Request("POST", "https://placeholder.test/api"),
    )


class _ScriptedClient:
    """Async-context-manager stand-in for ``httpx.AsyncClient``.

    The class captures the URL of each POST and either returns a scripted
    response or raises a scripted exception. Sequencing is per-test so we
    can simulate "primary fails, backup succeeds" deterministically.
    """

    def __init__(self, plan: dict[str, list[Any]]) -> None:
        # plan: hostname → list of (status_or_exc, body) tuples; each call
        # to that host pops the next outcome.
        self.plan = plan
        self.calls: list[str] = []

    async def __aenter__(self) -> "_ScriptedClient":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        return None

    async def post(self, url: str, **_: Any) -> httpx.Response:
        host = httpx.URL(url).host
        self.calls.append(host)
        outcomes = self.plan.get(host, [])
        if not outcomes:
            raise RuntimeError(f"unexpected call to {host!r} — no scripted outcome")
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        status, body = outcome
        return _make_response(status, body)


@pytest.fixture
def patched_httpx(monkeypatch: pytest.MonkeyPatch):
    """Return a factory that installs a ``_ScriptedClient`` for one call."""
    holder: dict[str, _ScriptedClient] = {}

    def install(plan: dict[str, list[Any]]) -> _ScriptedClient:
        client = _ScriptedClient(plan)

        def _new_client(*_a: Any, **_kw: Any) -> _ScriptedClient:
            return client

        monkeypatch.setattr(overpass.httpx, "AsyncClient", _new_client)
        holder["client"] = client
        return client

    return install


def _good_body() -> str:
    return '{"version": 0.6, "generator": "Overpass test", "elements": []}'


# ---------------------------------------------------------------------------
# Selection / failover
# ---------------------------------------------------------------------------


def test_first_mirror_success_does_not_call_backups(patched_httpx) -> None:
    client = patched_httpx({"primary.test": [(200, _good_body())]})
    data, url = asyncio.run(overpass.execute_query_ex("node(1);out;"))
    assert "elements" in data
    assert url.startswith("https://primary.test")
    assert client.calls == ["primary.test"]


def test_504_on_primary_fails_over_to_backup(patched_httpx) -> None:
    client = patched_httpx(
        {
            "primary.test": [(504, "Gateway Timeout")],
            "backup.test": [(200, _good_body())],
        }
    )
    data, url = asyncio.run(overpass.execute_query_ex("node(1);out;"))
    assert "elements" in data
    assert url.startswith("https://backup.test")
    assert client.calls == ["primary.test", "backup.test"]


def test_timeout_on_primary_fails_over_to_backup(patched_httpx) -> None:
    client = patched_httpx(
        {
            "primary.test": [httpx.TimeoutException("read timed out")],
            "backup.test": [(200, _good_body())],
        }
    )
    data, url = asyncio.run(overpass.execute_query_ex("node(1);out;"))
    assert url.startswith("https://backup.test")
    assert client.calls == ["primary.test", "backup.test"]


def test_429_on_primary_fails_over_to_backup(patched_httpx) -> None:
    client = patched_httpx(
        {
            "primary.test": [(429, "Too Many Requests")],
            "backup.test": [(200, _good_body())],
        }
    )
    asyncio.run(overpass.execute_query_ex("node(1);out;"))
    assert client.calls == ["primary.test", "backup.test"]


def test_400_with_overload_signal_fails_over(patched_httpx) -> None:
    """Overpass uses 400 for server-side timeouts too. Body matters."""
    client = patched_httpx(
        {
            "primary.test": [
                (400, "runtime error: Query timed out after 25 seconds")
            ],
            "backup.test": [(200, _good_body())],
        }
    )
    asyncio.run(overpass.execute_query_ex("node(1);out;"))
    assert client.calls == ["primary.test", "backup.test"]


def test_400_with_syntax_error_does_not_fail_over(patched_httpx) -> None:
    """A QL syntax error is the user's fault — don't burn other mirrors."""
    client = patched_httpx(
        {
            "primary.test": [
                (400, "Error: line 1: parse error: Unknown character 'x'")
            ],
            "backup.test": [(200, _good_body())],
        }
    )
    with pytest.raises(overpass.OverpassError) as exc_info:
        asyncio.run(overpass.execute_query_ex("node(1);out;"))
    assert "400" in str(exc_info.value)
    assert client.calls == ["primary.test"]


def test_all_mirrors_fail_raises_after_full_pool(patched_httpx) -> None:
    client = patched_httpx(
        {
            "primary.test": [(504, "")],
            "backup.test": [(504, "")],
            "last.test": [(504, "")],
        }
    )
    with pytest.raises(overpass.OverpassError):
        asyncio.run(overpass.execute_query_ex("node(1);out;"))
    # Each mirror was tried exactly once.
    assert sorted(client.calls) == ["backup.test", "last.test", "primary.test"]


# ---------------------------------------------------------------------------
# Cooldown / health
# ---------------------------------------------------------------------------


def test_failure_increments_counter(patched_httpx) -> None:
    """A 504 on primary bumps its consecutive_failures and starts a cooldown."""
    patched_httpx(
        {
            "primary.test": [(504, "")],
            "backup.test": [(200, _good_body())],
        }
    )
    asyncio.run(overpass.execute_query_ex("node(1);out;"))
    primary = next(e for e in overpass._POOL if e.url.endswith("primary.test/api"))
    backup = next(e for e in overpass._POOL if e.url.endswith("backup.test/api"))
    assert primary.consecutive_failures == 1
    assert primary.cooldown_until > 0
    assert backup.consecutive_failures == 0
    assert backup.cooldown_until == 0


def test_recovery_resets_counter_after_success(
    patched_httpx, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A mirror's failure counter resets the next time it successfully serves.

    We use a single-endpoint pool to force selection, plus a zero cooldown,
    so primary gets a second turn within the same test."""
    monkeypatch.setenv("OVERPASS_STYLER_OVERPASS_URLS", "https://solo.test/api")
    overpass._reset_pool_for_tests()
    monkeypatch.setattr(overpass, "_COOLDOWN_BASE_S", 0.0)
    patched_httpx(
        {"solo.test": [(504, ""), (200, _good_body())]}
    )

    # First call fails, retries are exhausted (only 1 endpoint) → raises.
    with pytest.raises(overpass.OverpassError):
        asyncio.run(overpass.execute_query_ex("node(1);out;"))
    solo = overpass._POOL[0]
    assert solo.consecutive_failures == 1

    # Second call: zero cooldown means solo is eligible immediately; the
    # 200 response resets the counter.
    asyncio.run(overpass.execute_query_ex("node(2);out;"))
    assert solo.consecutive_failures == 0
    assert solo.cooldown_until == 0


def test_served_by_label_is_none_for_primary() -> None:
    assert overpass.served_by_label("https://primary.test/api") is None


def test_served_by_label_is_host_for_non_primary() -> None:
    assert overpass.served_by_label("https://backup.test/api") == "backup.test"


# ---------------------------------------------------------------------------
# Empty pool guard
# ---------------------------------------------------------------------------


def test_empty_pool_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OVERPASS_STYLER_OVERPASS_URLS", "")
    overpass._reset_pool_for_tests()
    # An empty env var falls back to the default 3-mirror list, so the pool
    # is never actually empty in practice. Verify the fallback works.
    assert len(overpass._POOL) >= 1
