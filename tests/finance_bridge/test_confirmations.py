"""Confirmation flow tests — H2 idempotency and posting_unknown recovery.

Tests at the HTTP endpoint level using TestClient (FastAPI),
mocking Firefly with respx. All writes go through the global
state singletons so the FastAPI handlers see the same data.
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from httpx import Response
from fastapi.testclient import TestClient

try:
    import respx
    HAS_RESPX = True
except ImportError:
    HAS_RESPX = False

from finance_bridge.app.main import app
from finance_bridge.app.domain.models import DraftStatus, TransactionIntent
from finance_bridge.app.state import reset_state, get_storage
from finance_bridge.app.storage.drafts import drafts
from finance_bridge.app.storage.aliases import aliases

pytestmark = pytest.mark.skipif(not HAS_RESPX, reason="respx not installed")


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

def _setup_draft(draft_id=1, status="ready_for_confirmation", txn_intent="expense"):
    """Insert a draft and its aliases through the global state singletons."""
    # Create aliases first (fail-safe: ignore if already exist)
    try:
        aliases.upsert_safe("Demo EUR Bank", "asset", "EUR", firefly_account_id=42)
    except Exception:
        pass
    try:
        aliases.upsert_safe("餐饮", "expense", "EUR")
    except Exception:
        pass

    storage = get_storage()
    with storage._connection() as conn:
        conn.execute("""INSERT OR IGNORE INTO drafts
            (id, channel, source_message_id, occurred_at, amount,
             currency, transaction_intent, source_account_alias,
             destination_account_alias, description, status, draft_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (draft_id, "test", f"msg-{draft_id}", "2026-07-16", "45.00",
             "EUR", txn_intent, "Demo EUR Bank", "餐饮",
             "Test lunch", status, 1))
        conn.commit()


def _set_bridge_token(monkeypatch):
    """Set BRIDGE_INTERNAL_TOKEN so requests pass auth."""
    import finance_bridge.app.config as cfg
    cfg.settings.bridge_internal_token = "test-bridge-token"
    # Also set Firefly credentials so confirm tries real Firefly path
    cfg.settings.firefly_token = "test-ff-token"
    cfg.settings.firefly_api_url = "http://localhost:18080/api/v1"


# -------------------------------------------------------------------
# Fixtures
# -------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _auto_reset(monkeypatch):
    reset_state()
    _set_bridge_token(monkeypatch)


@pytest.fixture
def client():
    return TestClient(app)


# -------------------------------------------------------------------
# First confirmation success
# -------------------------------------------------------------------

class TestFirstConfirm:
    @respx.mock
    def test_first_confirm_success(self, client, monkeypatch):
        """First-time confirm posts to Firefly and returns posted."""
        _setup_draft()
        eid = "bridge-draft-1-v1"

        respx.get(
            "http://localhost:18080/api/v1/search/transactions",
            params={"query": f"external_id_is:{eid}"},
        ).mock(return_value=Response(200, json={"data": []}))
        respx.post("http://localhost:18080/api/v1/transactions").mock(
            return_value=Response(200, json={
                "data": {
                    "id": "100",
                    "attributes": {
                        "transactions": [{"transaction_journal_id": "99"}],
                    },
                }
            })
        )

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "posted"
        assert data["firefly_transaction_id"] == "99"

    @respx.mock
    def test_no_credentials_returns_503(self, client, monkeypatch):
        """Without Firefly credentials (any env), confirm fails closed with 503 (A24)."""
        _setup_draft()
        import finance_bridge.app.config as cfg
        cfg.settings.firefly_token = ""
        cfg.settings.firefly_api_url = ""
        cfg.settings.app_env = "development"

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 503, resp.text

    @respx.mock
    def test_no_credentials_production_returns_503(self, client, monkeypatch):
        """Without Firefly credentials in production, confirm returns 503 and draft stays unchanged."""
        _setup_draft()
        import finance_bridge.app.config as cfg
        cfg.settings.firefly_token = ""
        cfg.settings.firefly_api_url = ""
        cfg.settings.app_env = "production"

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 503, resp.text
        assert "Firefly credentials not configured" in resp.json()["detail"]

        # Verify draft status unchanged (still ready_for_confirmation)
        draft = drafts.get(1)
        assert draft["status"] == "ready_for_confirmation"


# -------------------------------------------------------------------
# Idempotency
# -------------------------------------------------------------------

class TestIdempotency:
    @respx.mock
    def test_duplicate_confirm_rejected(self, client):
        """Already posted draft cannot be confirmed again."""
        _setup_draft()
        eid = "bridge-draft-1-v1"

        # First confirm
        respx.get(
            "http://localhost:18080/api/v1/search/transactions",
            params={"query": f"external_id_is:{eid}"},
        ).mock(return_value=Response(200, json={"data": []}))
        respx.post("http://localhost:18080/api/v1/transactions").mock(
            return_value=Response(200, json={
                "data": {"id": "100", "attributes": {"transactions": [{"transaction_journal_id": "99"}]}}
            })
        )
        resp1 = client.post("/v1/drafts/1/confirm",
                            headers={"Authorization": "Bearer test-bridge-token"})
        assert resp1.status_code == 200

        # Second confirm on posted draft → 422
        resp2 = client.post("/v1/drafts/1/confirm",
                            headers={"Authorization": "Bearer test-bridge-token"})
        assert resp2.status_code == 422

    @respx.mock
    def test_external_id_already_exists_recovers(self, client):
        """external_id exists → recover without re-posting."""
        _setup_draft()
        eid = "bridge-draft-1-v1"

        respx.get(
            "http://localhost:18080/api/v1/search/transactions",
            params={"query": f"external_id_is:{eid}"},
        ).mock(return_value=Response(200, json={
            "data": [{
                "id": "100",
                "attributes": {"transactions": [{"transaction_journal_id": "99"}]},
            }]
        }))
        # Should NOT call create_transaction

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "posted"
        assert data["firefly_transaction_id"] == "99"

    @respx.mock
    def test_external_id_query_fails_keeps_posting_unknown(self, client):
        """Query failure → stay posting_unknown."""
        _setup_draft()
        eid = "bridge-draft-1-v1"

        respx.get(
            "http://localhost:18080/api/v1/search/transactions",
            params={"query": f"external_id_is:{eid}"},
        ).mock(return_value=Response(500, text="Internal Server Error"))

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "posting_unknown"
        assert "External ID query failed" in data["message"]

    @respx.mock
    def test_found_no_journal_id_keeps_posting_unknown(self, client):
        """Found by external_id but no journal ID → keep posting_unknown."""
        _setup_draft()
        eid = "bridge-draft-1-v1"

        respx.get(
            "http://localhost:18080/api/v1/search/transactions",
            params={"query": f"external_id_is:{eid}"},
        ).mock(return_value=Response(200, json={
            "data": [{"id": "100", "type": "transactions", "attributes": {}}]
        }))

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # The outer transaction-group ID is not a journal ID. Keep the draft
        # recoverable instead of claiming an unverified posting succeeded.
        assert data["status"] == "posting_unknown"
        assert data["firefly_transaction_id"] is None

    @respx.mock
    def test_create_without_journal_id_keeps_posting_unknown(self, client):
        """A create response without a journal ID must not be marked posted."""
        _setup_draft()
        eid = "bridge-draft-1-v1"

        respx.get(
            "http://localhost:18080/api/v1/search/transactions",
            params={"query": f"external_id_is:{eid}"},
        ).mock(return_value=Response(200, json={"data": []}))
        respx.post("http://localhost:18080/api/v1/transactions").mock(
            return_value=Response(200, json={
                "data": {"id": "100", "attributes": {}}
            })
        )

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "posting_unknown"
        assert data["firefly_transaction_id"] is None


# -------------------------------------------------------------------
# posting_unknown recovery
# -------------------------------------------------------------------

class TestPostingUnknown:
    @respx.mock
    def test_recovery_found(self, client):
        """posting_unknown → external_id found → posted."""
        _setup_draft(status="posting_unknown")
        eid = "bridge-draft-1-v1"

        respx.get(
            "http://localhost:18080/api/v1/search/transactions",
            params={"query": f"external_id_is:{eid}"},
        ).mock(return_value=Response(200, json={
            "data": [{
                "id": "200",
                "attributes": {"transactions": [{"transaction_journal_id": "199"}]},
            }]
        }))

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "posted"
        assert data["firefly_transaction_id"] == "199"

    @respx.mock
    def test_recovery_not_found_then_posts(self, client):
        """posting_unknown → external_id not found → re-post."""
        _setup_draft(status="posting_unknown")
        eid = "bridge-draft-1-v1"

        respx.get(
            "http://localhost:18080/api/v1/search/transactions",
            params={"query": f"external_id_is:{eid}"},
        ).mock(return_value=Response(200, json={"data": []}))
        respx.post("http://localhost:18080/api/v1/transactions").mock(
            return_value=Response(200, json={
                "data": {"id": "300", "attributes": {"transactions": [{"transaction_journal_id": "299"}]}}
            })
        )

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "posted"
        assert data["firefly_transaction_id"] == "299"


# -------------------------------------------------------------------
# Status validation
# -------------------------------------------------------------------

class TestStatusValidation:
    def test_received_cannot_confirm(self, client):
        """received draft → cannot confirm."""
        _setup_draft(status="received")
        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 422, resp.text

    def test_posted_cannot_confirm(self, client):
        """posted draft → cannot confirm."""
        _setup_draft(status="posted")
        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 422, resp.text

    def test_cancelled_cannot_confirm(self, client):
        """cancelled draft → cannot confirm."""
        _setup_draft(status="cancelled")
        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 422, resp.text


# -------------------------------------------------------------------
# No credentials handling (TASK-1)
# -------------------------------------------------------------------

class TestNoCredentials:
    def test_no_credentials_development_returns_503(self, client, monkeypatch):
        """No Firefly credentials in development also fails closed with 503 (A24)."""
        import finance_bridge.app.config as cfg
        monkeypatch.setattr(cfg.settings, "firefly_token", None)
        monkeypatch.setattr(cfg.settings, "app_env", "development")
        _setup_draft()

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 503, resp.text

    def test_no_credentials_production_returns_503(self, client, monkeypatch):
        """No Firefly credentials in production returns 503 fail-closed."""
        import finance_bridge.app.config as cfg
        monkeypatch.setattr(cfg.settings, "firefly_token", None)
        monkeypatch.setattr(cfg.settings, "app_env", "production")
        _setup_draft()

        resp = client.post("/v1/drafts/1/confirm",
                           headers={"Authorization": "Bearer test-bridge-token"})
        assert resp.status_code == 503, resp.text
        assert "Firefly credentials not configured" in resp.json()["detail"]

        # Assert draft status remains ready_for_confirmation
        draft = drafts.get(1)
        assert draft["status"] == "ready_for_confirmation"

