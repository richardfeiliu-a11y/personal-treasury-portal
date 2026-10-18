"""Firefly API client tests with mocked transport.

Tests the client without a real Firefly instance.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import pytest
from httpx import Response

import httpx

try:
    import respx
    HAS_RESPX = True
except ImportError:
    HAS_RESPX = False

from finance_bridge.app.config import Settings
from finance_bridge.app.firefly.client import FireflyClient
from finance_bridge.app.firefly.errors import (
    FireflyAuthError,
    FireflyServerError,
    FireflyTimeoutError,
    FireflyValidationError,
)


pytestmark = pytest.mark.skipif(not HAS_RESPX, reason="respx not installed")


@pytest.fixture
def mock_settings():
    """Settings with a mock Firefly URL and token."""
    return Settings(
        firefly_api_url="http://localhost:18080/api/v1",
        firefly_token="test-token-123",
    )


class TestFireflyClientCreateTransaction:
    @respx.mock
    def test_create_transaction_success(self, mock_settings):
        """Creating a transaction should return the created transaction."""
        mock_response = {
            "data": {
                "id": "42",
                "type": "withdrawal",
                "attributes": {
                    "amount": "45.00",
                    "currency_code": "EUR",
                }
            }
        }
        respx.post("http://localhost:18080/api/v1/transactions").mock(
            return_value=Response(200, json=mock_response)
        )

        with FireflyClient(mock_settings) as client:
            payload = {
                "type": "withdrawal",
                "date": "2026-07-16",
                "amount": "45.00",
                "currency_code": "EUR",
                "description": "Test",
            }
            result = client.create_transaction(payload)
            assert result["id"] == "42"

    @respx.mock
    def test_create_transaction_validation_error(self, mock_settings):
        """Invalid transaction should raise validation error."""
        respx.post("http://localhost:18080/api/v1/transactions").mock(
            return_value=Response(422, json={"message": "Validation failed"})
        )

        with FireflyClient(mock_settings) as client:
            with pytest.raises(FireflyValidationError):
                client.create_transaction({"invalid": "payload"})

    @respx.mock
    def test_create_transaction_server_error(self, mock_settings):
        """Server errors should raise server error."""
        respx.post("http://localhost:18080/api/v1/transactions").mock(
            return_value=Response(500, text="Internal Server Error")
        )

        with FireflyClient(mock_settings) as client:
            with pytest.raises(FireflyServerError):
                client.create_transaction({})


class TestFireflyClientNoCredentials:
    def test_is_configured_with_credentials(self, mock_settings):
        """Client should be configured when token is present."""
        with FireflyClient(mock_settings) as client:
            assert client.is_configured is True
    @respx.mock
    def test_is_configured_without_credentials(self):
        """Client should not be configured without token."""
        settings = Settings(firefly_token="", firefly_api_url="")
        with FireflyClient(settings) as client:
            assert client.is_configured is False


class TestGetTransactionByExternalId:
    @respx.mock
    def test_uses_external_id_is_query_operator(self, mock_settings):
        """Idempotency recovery must search with query=external_id_is:<id>.

        Firefly's /search/transactions filters via the ``query`` param using
        operator syntax; a bare top-level ``?external_id=`` param is not a
        search filter and would silently return no match, defeating the
        posting_unknown recovery path.
        """
        eid = "bridge-draft-1-v1"
        route = respx.get(
            "http://localhost:18080/api/v1/search/transactions",
            params={"query": f"external_id_is:{eid}"},
        ).mock(return_value=Response(200, json={
            "data": [{"id": "100", "attributes": {"transactions": [{"transaction_journal_id": "99"}]}}]
        }))

        with FireflyClient(mock_settings) as client:
            result = client.get_transaction_by_external_id(eid)

        assert route.called
        url = str(route.calls[0].request.url)
        assert f"query=external_id_is%3A{eid}" in url
        assert "external_id=" not in url
        assert result["id"] == "100"


class TestPaginatedAccountBalances:
    @respx.mock
    def test_single_page(self, mock_settings):
        """Single page of accounts returns correctly."""
        respx.get("http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50").mock(
            return_value=Response(200, json={
                "data": [{"id": "1", "attributes": {"name": "Bank A", "type": "asset"}}],
                "meta": {"pagination": {"total_pages": 1}},
            })
        )
        with FireflyClient(mock_settings) as client:
            result = client.get_account_balances(["asset"])
            assert len(result) == 1
            assert result[0]["id"] == "1"

    @respx.mock
    def test_multi_page(self, mock_settings):
        """Multiple pages are concatenated."""
        for page in [1, 2]:
            respx.get(
                f"http://localhost:18080/api/v1/accounts?type=asset&page={page}&limit=50"
            ).mock(
                return_value=Response(200, json={
                    "data": [{"id": str(page), "attributes": {"name": f"Account {page}", "type": "asset"}}],
                    "meta": {"pagination": {"total_pages": 2}},
                })
            )
        with FireflyClient(mock_settings) as client:
            result = client.get_account_balances(["asset"])
            assert len(result) == 2

    @respx.mock
    def test_multiple_types(self, mock_settings):
        """Multiple account types return combined results."""
        respx.get("http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50").mock(
            return_value=Response(200, json={
                "data": [{"id": "1", "attributes": {"name": "Asset", "type": "asset"}}],
                "meta": {"pagination": {"total_pages": 1}},
            })
        )
        respx.get("http://localhost:18080/api/v1/accounts?type=liabilities&page=1&limit=50").mock(
            return_value=Response(200, json={
                "data": [{"id": "2", "attributes": {"name": "Liability", "type": "liabilities"}}],
                "meta": {"pagination": {"total_pages": 1}},
            })
        )
        with FireflyClient(mock_settings) as client:
            result = client.get_account_balances(["asset", "liabilities"])
            assert len(result) == 2

    @respx.mock
    def test_include_net_worth_only_filters(self, mock_settings):
        """include_net_worth_only=True 过滤掉 include_net_worth=false 的账户。"""
        respx.get("http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50").mock(
            return_value=Response(200, json={
                "data": [
                    {"id": "1", "attributes": {"name": "Bank", "type": "asset", "include_net_worth": True}},
                    {"id": "2", "attributes": {"name": "迁移清算 · CNY", "type": "asset", "include_net_worth": False}},
                    {"id": "3", "attributes": {"name": "Cash", "type": "asset"}},  # 缺省视为 True
                ],
                "meta": {"pagination": {"total_pages": 1}},
            })
        )
        with FireflyClient(mock_settings) as client:
            # 默认不过滤
            all_accts = client.get_account_balances(["asset"])
            assert len(all_accts) == 3
            # 过滤后只剩 include_net_worth 非 false 的
            filtered = client.get_account_balances(["asset"], include_net_worth_only=True)
            assert [a["id"] for a in filtered] == ["1", "3"]

    @respx.mock
    def test_raises_on_failure(self, mock_settings):
        """API error raises — no silent skip."""
        respx.get("http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50").mock(
            return_value=Response(500, text="Server Error")
        )
        with FireflyClient(mock_settings) as client:
            with pytest.raises(Exception):
                client.get_account_balances(["asset"])


class TestAccountBalancesDateParam:
    """Balance sheet needs historical balances via the accounts date param."""

    @respx.mock
    def test_date_param_in_url(self, mock_settings):
        route = respx.get(
            "http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50&date=2026-01-31"
        ).mock(return_value=Response(200, json={
            "data": [{"id": "1", "attributes": {}}],
            "meta": {"pagination": {"total_pages": 1}},
        }))
        with FireflyClient(mock_settings) as client:
            accounts = client.get_account_balances(["asset"], date="2026-01-31")
        assert route.called
        assert len(accounts) == 1

    @respx.mock
    def test_no_date_param_by_default(self, mock_settings):
        route = respx.get(
            "http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50"
        ).mock(return_value=Response(200, json={
            "data": [], "meta": {"pagination": {"total_pages": 1}},
        }))
        with FireflyClient(mock_settings) as client:
            client.get_account_balances(["asset"])
        assert route.called
        assert "date=" not in str(route.calls[0].request.url)
