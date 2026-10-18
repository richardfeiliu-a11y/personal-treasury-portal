"""P0 regression tests from CODE_ARCHITECTURE_AUDIT_FINAL.md.

Covers:
- F-01: POST must not retry (non-idempotent)
- F-02: amend rejects CONFIRMING / POSTING_UNKNOWN
- F-03: create_draft race returns existing draft, not 500
- F-04: healthz returns 503 and no raw exception text on DB error
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from httpx import Response

try:
    import respx
    HAS_RESPX = True
except ImportError:
    HAS_RESPX = False

import httpx

from finance_bridge.app.main import app
from finance_bridge.app.state import reset_state, get_storage
from finance_bridge.app.storage.aliases import aliases

pytestmark = pytest.mark.skipif(not HAS_RESPX, reason="respx not installed")


def _setup_aliases():
    try:
        aliases.upsert_safe("Demo EUR Bank", "asset", "EUR", firefly_account_id=42)
    except Exception:
        pass
    try:
        aliases.upsert_safe("餐饮", "expense", "EUR")
    except Exception:
        pass


def _draft_payload(message_id="msg-p0"):
    return {
        "channel": "test",
        "source_message_id": message_id,
        "occurred_at": "2026-07-16",
        "amount": "45.00",
        "currency": "EUR",
        "transaction_intent": "expense",
        "source_account_alias": "Demo EUR Bank",
        "destination_account_alias": "餐饮",
    }


def _set_bridge_token(monkeypatch):
    import finance_bridge.app.config as cfg
    cfg.settings.bridge_internal_token = "test-bridge-token"


@pytest.fixture(autouse=True)
def _auto_reset(monkeypatch):
    reset_state()
    _set_bridge_token(monkeypatch)


@pytest.fixture
def client():
    return TestClient(app)


_AUTH = {"Authorization": "Bearer test-bridge-token"}


class TestPostNoRetry:
    @respx.mock
    def test_post_timeout_raises_without_retry(self, mock_settings=None):
        """POST timeout raises immediately — exactly 1 HTTP attempt."""
        from finance_bridge.app.config import Settings
        from finance_bridge.app.firefly.client import FireflyClient
        from finance_bridge.app.firefly.errors import FireflyTimeoutError

        settings = Settings(
            firefly_api_url="http://localhost:18080/api/v1",
            firefly_token="test-token-123",
        )
        route = respx.post("http://localhost:18080/api/v1/transactions").mock(
            side_effect=httpx.TimeoutException("Connection timed out")
        )
        with FireflyClient(settings) as fc:
            with pytest.raises(FireflyTimeoutError):
                fc.create_transaction({"amount": "45.00"})
        assert route.call_count == 1


class TestAmendStatusGuard:
    @pytest.mark.parametrize("status", ["confirming", "posting_unknown"])
    def test_amend_rejects_in_flight_statuses(self, client, status):
        """Drafts in CONFIRMING/POSTING_UNKNOWN must not be amendable."""
        _setup_aliases()
        storage = get_storage()
        with storage._connection() as conn:
            conn.execute(
                """INSERT INTO drafts
                (id, channel, source_message_id, occurred_at, amount,
                 currency, transaction_intent, source_account_alias,
                 destination_account_alias, description, status, draft_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (901, "test", f"msg-{status}", "2026-07-16", "45.00",
                 "EUR", "expense", "Demo EUR Bank", "餐饮",
                 "Test lunch", status, 1),
            )
            conn.commit()

        resp = client.patch(
            "/v1/drafts/901",
            json={"description": "should be rejected"},
            headers=_AUTH,
        )
        assert resp.status_code == 422, resp.text
        detail = resp.json()["detail"]
        assert status in detail, detail


class TestCreateDraftRace:
    @respx.mock
    def test_unique_violation_returns_existing_draft(self, client, monkeypatch):
        """If the pre-check misses a duplicate insert, return existing, not 500."""
        import finance_bridge.app.config as cfg
        cfg.settings.base_currency = "EUR"
        _setup_aliases()
        storage = get_storage()
        with storage._connection() as conn:
            conn.execute(
                """INSERT INTO drafts
                (id, channel, source_message_id, occurred_at, amount,
                 currency, transaction_intent, source_account_alias,
                 destination_account_alias, description, status, draft_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (910, "test", "msg-race", "2026-07-16", "45.00",
                 "EUR", "expense", "Demo EUR Bank", "餐饮",
                 "Existing draft", "ready_for_confirmation", 1),
            )
            conn.commit()

        # Simulate the race window: the pre-check call returns nothing,
        # but the fallback query after INSERT conflict sees the existing row.
        from finance_bridge.app.api.drafts import drafts as drafts_repo
        original_find = drafts_repo.find_by_message
        calls = {"n": 0}

        def _flaky_find(channel, message_id):
            calls["n"] += 1
            if calls["n"] == 1:
                return None
            return original_find(channel, message_id)

        monkeypatch.setattr(drafts_repo, "find_by_message", _flaky_find)

        resp = client.post("/v1/drafts", json=_draft_payload("msg-race"), headers=_AUTH)
        assert resp.status_code in (200, 201), resp.text
        data = resp.json()
        assert data["id"] == 910


class TestHealthz:
    def test_db_error_returns_503_and_no_raw_exception(self, client, monkeypatch):
        """DB failure -> 503; response must not leak exception text."""
        def _broken_storage():
            raise RuntimeError("secret internal detail /Users/someone/db.sqlite locked")

        monkeypatch.setattr(
            "finance_bridge.app.main.get_storage", _broken_storage
        )
        resp = client.get("/healthz")
        assert resp.status_code == 503
        body = resp.text
        assert "secret internal detail" not in body
        assert "/Users/someone" not in body
