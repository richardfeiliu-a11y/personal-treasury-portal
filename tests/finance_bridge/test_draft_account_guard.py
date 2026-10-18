"""Draft creation must fail closed before a record exists."""
from __future__ import annotations

from fastapi.testclient import TestClient

from finance_bridge.app.config import settings
from finance_bridge.app.main import app
from finance_bridge.app.state import get_storage, reset_state


def _request(source: str, destination: str, intent: str = "expense") -> dict:
    return {
        "channel": "test", "source_message_id": f"message-{source}-{destination}",
        "occurred_at": "2026-07-18", "amount": "12.50", "currency": "CNY",
        "transaction_intent": intent, "source_account_alias": source,
        "destination_account_alias": destination,
    }


def _reset_with_aliases() -> TestClient:
    reset_state()
    settings.bridge_internal_token = "test-token"
    store = get_storage()
    store.create_alias("有效工行卡", "asset", "CNY", 1)
    store.create_alias("餐饮", "expense", "CNY", 2)
    store.create_alias("停用工行卡", "asset", "CNY", 3)
    store.deactivate_alias("停用工行卡")
    return TestClient(app)


def test_unknown_or_inactive_alias_creates_no_draft():
    client = _reset_with_aliases()
    for source in ("不存在账户", "停用工行卡"):
        response = client.post("/v1/drafts", json=_request(source, "餐饮"),
                               headers={"Authorization": "Bearer test-token"})
        assert response.status_code == 422
    with get_storage()._connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM drafts").fetchone()[0] == 0


def test_wrong_account_roles_create_no_draft():
    client = _reset_with_aliases()
    response = client.post("/v1/drafts", json=_request("有效工行卡", "有效工行卡"),
                           headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 422
    with get_storage()._connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM drafts").fetchone()[0] == 0
