"""Tests for deterministic active-alias candidate search."""
from __future__ import annotations

from fastapi.testclient import TestClient

from finance_bridge.app.main import app
from finance_bridge.app.state import get_storage, reset_state
from finance_bridge.app.config import settings
from finance_bridge.app.domain.account_search import find_account_candidates


def _seed() -> None:
    reset_state()
    settings.bridge_internal_token = "test-token"
    storage = get_storage()
    storage.create_alias("工商银行信用卡", "liability", "CNY", 1)
    storage.create_alias("工商银行储蓄卡", "asset", "CNY", 2)
    storage.create_alias("Wallet A EUR", "asset", "EUR", 3)
    storage.create_alias("餐饮", "expense", "CNY", 4)
    storage.create_alias("演示 inactive 工行卡", "asset", "CNY", 5)
    storage.deactivate_alias("演示 inactive 工行卡")


def test_common_bank_abbreviation_returns_active_candidates_only():
    _seed()
    rows = find_account_candidates(get_storage().list_aliases(), "工行卡")
    assert [row["alias"] for row in rows] == ["工商银行信用卡", "工商银行储蓄卡"]
    assert all(row["alias"] != "演示 inactive 工行卡" for row in rows)


def test_currency_and_type_filters_are_deterministic():
    _seed()
    rows = find_account_candidates(
        get_storage().list_aliases(), "工行", account_types=["liability"], currency="CNY"
    )
    assert [row["alias"] for row in rows] == ["工商银行信用卡"]
    assert find_account_candidates(get_storage().list_aliases(), "Wallet A", currency="CNY") == []


def test_candidates_endpoint_is_read_only_and_excludes_inactive():
    _seed()
    client = TestClient(app)
    before = len(get_storage().list_aliases(include_inactive=True))
    response = client.get(
        "/v1/accounts/candidates",
        params=[("query", "工行"), ("account_types", "asset")],
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert [item["alias"] for item in body["candidates"]] == ["工商银行储蓄卡"]
    assert len(get_storage().list_aliases(include_inactive=True)) == before


def test_empty_query_is_rejected():
    _seed()
    response = TestClient(app).get(
        "/v1/accounts/candidates?query=%20",
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 422
