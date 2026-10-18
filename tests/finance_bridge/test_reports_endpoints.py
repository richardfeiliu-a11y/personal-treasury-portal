"""End-to-end endpoint tests for H3 reports — using TestClient + respx.

Covers:
- GET /v1/reports/account-balances

Each test mocks Firefly API with respx and asserts the Bridge response.
"""
from __future__ import annotations

import pytest
from httpx import Response
from fastapi.testclient import TestClient

FF = "http://localhost:18080/api/v1"


def _accounts_page(data):
    return Response(200, json={
        "data": data, "meta": {"pagination": {"total_pages": 1}}})


def _txn_page(journals):
    return Response(200, json={
        "data": [{"attributes": {"transactions": journals}}] if journals else [],
        "meta": {"pagination": {"total_pages": 1}}})

try:
    import respx
    HAS_RESPX = True
except ImportError:
    HAS_RESPX = False

from finance_bridge.app.main import app
from finance_bridge.app.config import settings as cfg_settings

pytestmark = pytest.mark.skipif(not HAS_RESPX, reason="respx not installed")


@pytest.fixture(autouse=True)
def _setup():
    """Ensure credentials are set so endpoints don't 503."""
    from finance_bridge.app.state import reset_state
    reset_state()
    cfg_settings.bridge_internal_token = "test-token"
    cfg_settings.firefly_token = "test-ff-token"
    cfg_settings.firefly_api_url = "http://localhost:18080/api/v1"
    cfg_settings.base_currency = "EUR"


@pytest.fixture
def client():
    return TestClient(app)


# -------------------------------------------------------------------
# Account Balances
# -------------------------------------------------------------------

class TestAccountBalancesEndpoint:
    def test_rejects_non_cny_base_currency_before_fetching_firefly(self, client):
        cfg_settings.base_currency = "EUR"
        response = client.get(
            "/v1/reports/account-balances",
            headers={"Authorization": "Bearer test-token"},
        )
        assert response.status_code == 503
        assert response.json()["detail"] == "Account balance valuation requires BASE_CURRENCY=CNY."

    @respx.mock
    def test_basic(self, client):
        """GET /v1/reports/account-balances returns structured data."""
        cfg_settings.base_currency = "CNY"
        respx.get(
            "http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50"
        ).mock(return_value=Response(200, json={
            "data": [
                {"id": "1", "attributes": {
                    "name": "Bank", "type": "asset",
                    "currency_code": "CNY", "current_balance": "5000", "active": True,
                }},
                {"id": "2", "attributes": {
                    "name": "Wallet", "type": "asset",
                    "currency_code": "CNY", "current_balance": "200", "active": True,
                }},
            ],
            "meta": {"pagination": {"total_pages": 1}},
        }))
        respx.get(
            "http://localhost:18080/api/v1/accounts?type=liabilities&page=1&limit=50"
        ).mock(return_value=Response(200, json={
            "data": [
                {"id": "3", "attributes": {
                    "name": "Card", "type": "liabilities",
                    "currency_code": "CNY", "current_balance": "-1200", "active": True,
                }},
            ],
            "meta": {"pagination": {"total_pages": 1}},
        }))
        respx.get(
            "http://localhost:18080/api/v1/accounts?type=expense&page=1&limit=50"
        ).mock(return_value=Response(200, json={
            "data": [],
            "meta": {"pagination": {"total_pages": 1}},
        }))
        respx.get(
            "http://localhost:18080/api/v1/accounts?type=revenue&page=1&limit=50"
        ).mock(return_value=Response(200, json={
            "data": [],
            "meta": {"pagination": {"total_pages": 1}},
        }))

        resp = client.get("/v1/reports/account-balances",
                          headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["base_currency"] == "CNY"
        assert len(data["accounts"]) == 3
        assert data["accounts"][0]["name"] == "Bank"
        assert data["accounts"][0]["balance"] == "5000"

    @respx.mock
    def test_account_balances_converts_cny_at_fixed_rate(self, client):
        cfg_settings.base_currency = "CNY"
        for account_type in ("asset", "liabilities", "expense", "revenue"):
            data = []
            if account_type == "asset":
                data = [{"id": "1", "attributes": {
                    "name": "Bank", "type": "asset",
                    "currency_code": "CNY", "current_balance": "5000", "active": True,
                }}]
            respx.get(
                f"http://localhost:18080/api/v1/accounts?type={account_type}&page=1&limit=50"
            ).mock(return_value=Response(200, json={
                "data": data,
                "meta": {"pagination": {"total_pages": 1}},
            }))

        response = client.get(
            "/v1/reports/account-balances",
            headers={"Authorization": "Bearer test-token"},
        )
        assert response.status_code == 200
        payload = response.json()
        row = next(a for a in payload["accounts"] if a["currency"] == "CNY")
        assert row["balance_base"] == row["balance"]
        assert row["fx_rate_date"] == payload["as_of"]
        assert row["fx_source"] == "fixed"
        assert payload["fx_complete"] is True
        assert payload["missing_currencies"] == []

    @respx.mock
    def test_account_balances_handles_foreign_missing_and_zero_balances(
        self, client, monkeypatch,
    ):
        from finance_bridge.app.state import get_storage
        from finance_bridge.app.storage.fx_rates import FXRateRepository

        cfg_settings.base_currency = "CNY"
        monkeypatch.setattr("finance_bridge.app.api.reports.business_today", lambda: "2026-08-09")
        FXRateRepository(get_storage()).upsert_market("EUR", "8", "2026-08-08")

        accounts = [
            {"id": "1", "attributes": {
                "name": "EUR Bank", "type": "asset",
                "currency_code": "EUR", "current_balance": "5000", "active": True,
            }},
            {"id": "2", "attributes": {
                "name": "CHF Wallet", "type": "asset",
                "currency_code": "CHF", "current_balance": "10", "active": True,
            }},
            {"id": "3", "attributes": {
                "name": "JPY Wallet", "type": "asset",
                "currency_code": "JPY", "current_balance": "0", "active": True,
            }},
        ]
        for account_type in ("asset", "liabilities", "expense", "revenue"):
            respx.get(
                f"http://localhost:18080/api/v1/accounts?type={account_type}&page=1&limit=50"
            ).mock(return_value=Response(200, json={
                "data": accounts if account_type == "asset" else [],
                "meta": {"pagination": {"total_pages": 1}},
            }))

        response = client.get(
            "/v1/reports/account-balances",
            headers={"Authorization": "Bearer test-token"},
        )
        assert response.status_code == 200
        payload = response.json()
        by_currency = {row["currency"]: row for row in payload["accounts"]}
        eur = by_currency["EUR"]
        chf = by_currency["CHF"]
        zero_balance = by_currency["JPY"]

        assert eur["balance_base"] == "40000"
        assert eur["fx_rate_date"] == "2026-08-08"
        assert eur["fx_source"] == "ECB"
        assert chf["balance_base"] is None
        assert payload["missing_currencies"] == ["CHF"]
        assert payload["fx_complete"] is False
        assert zero_balance["balance_base"] == "0"
        assert zero_balance["currency"] not in payload["missing_currencies"]

    @respx.mock
    def test_api_error_returns_502(self, client):
        """Firefly error → 502."""
        cfg_settings.base_currency = "CNY"
        respx.get(
            "http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50"
        ).mock(return_value=Response(500, text="Server Error"))

        resp = client.get("/v1/reports/account-balances",
                          headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 502

    @respx.mock
    def test_middle_page_failure(self, client):
        """Second page fails → overall request fails (no partial results)."""
        cfg_settings.base_currency = "CNY"
        # First page OK
        respx.get(
            "http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50"
        ).mock(return_value=Response(200, json={
            "data": [{"id": "1", "attributes": {"name": "A", "type": "asset"}}],
            "meta": {"pagination": {"total_pages": 2}},
        }))
        # Second page fails
        respx.get(
            "http://localhost:18080/api/v1/accounts?type=asset&page=2&limit=50"
        ).mock(return_value=Response(500, text="Server Error"))

        resp = client.get("/v1/reports/account-balances",
                          headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 502


# -------------------------------------------------------------------
# Net Worth
# -------------------------------------------------------------------

class TestBalanceSheetEndpoint:
    @respx.mock
    def test_date_param_reaches_firefly(self, client):
        """请求历史日期时，Firefly URL 必须包含 date=YYYY-MM-DD。"""
        asset_route = respx.get(
            f"{FF}/accounts?type=asset&page=1&limit=50&date=2026-01-31"
        ).mock(return_value=_accounts_page([
            {"id": "1", "attributes": {
                "name": "Bank", "type": "asset", "currency_code": "CNY",
                "current_balance": "1000", "active": True,
                "include_net_worth": True}},
        ]))
        respx.get(
            f"{FF}/accounts?type=liabilities&page=1&limit=50&date=2026-01-31"
        ).mock(return_value=_accounts_page([
            {"id": "2", "attributes": {
                "name": "Card", "type": "liabilities", "currency_code": "CNY",
                "current_balance": "-400", "active": True,
                "include_net_worth": True}},
        ]))
        resp = client.get("/v1/reports/balance-sheet?as_of=2026-01-31",
                          headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 200, resp.text
        assert asset_route.called
        assert "date=2026-01-31" in str(asset_route.calls[0].request.url)
        data = resp.json()
        assert data["source"] == "firefly_live"
        assert data["report_type"] == "balance_sheet"
        assert data["balance_as_of"] == "2026-01-31"
        assert data["fx_method"] == "closing_rate"
        assert data["summary"]["net_worth_cny"] == "600"
        assert data["presentation"]["table_headers"] == ["类别", "原币", "CNY 折算", "占比"]

    def test_invalid_date_422(self, client):
        resp = client.get("/v1/reports/balance-sheet?as_of=bad-date",
                          headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 422

    @respx.mock
    def test_firefly_error_502(self, client):
        respx.get(url__regex=r".*accounts.*").mock(
            return_value=Response(500, text="boom"))
        resp = client.get("/v1/reports/balance-sheet",
                          headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 502


class TestIncomeStatementEndpoint:
    @respx.mock
    def test_management_view(self, client):
        respx.get(url__regex=r".*transactions.*").mock(
            return_value=_txn_page([
                {"type": "deposit", "amount": "1000", "currency_code": "CNY",
                 "date": "2026-07-05T00:00:00+08:00", "tags": [],
                 "source_name": "工资", "source_type": "Revenue account",
                 "transaction_journal_id": "1"},
                {"type": "withdrawal", "amount": "400", "currency_code": "CNY",
                 "date": "2026-07-06T00:00:00+08:00", "tags": [],
                 "destination_name": "餐饮", "destination_type": "Expense account",
                 "transaction_journal_id": "2"},
            ]))
        resp = client.get(
            "/v1/reports/income-statement?start_date=2026-07-01&end_date=2026-07-31",
            headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["report_type"] == "income_statement"
        assert data["accounting_view"] == "management"
        assert data["fx_method"] == "transaction_date"
        assert data["summary"]["total_income_cny"] == "1000"
        assert data["summary"]["total_expenses_cny"] == "400"
        assert data["summary"]["net_result_cny"] == "600"

    def test_bad_range_422(self, client):
        resp = client.get(
            "/v1/reports/income-statement?start_date=2026-07-31&end_date=2026-07-01",
            headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 422

    def test_bad_view_422(self, client):
        resp = client.get(
            "/v1/reports/income-statement?start_date=2026-07-01"
            "&end_date=2026-07-31&accounting_view=creative",
            headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 422


class TestExpenseBreakdownEndpoint:
    @respx.mock
    def test_with_comparison(self, client):
        respx.get(url__regex=r".*transactions.*start=2026-07-01.*").mock(
            return_value=_txn_page([
                {"type": "withdrawal", "amount": "150", "currency_code": "CNY",
                 "date": "2026-07-06T00:00:00+08:00", "tags": [],
                 "destination_name": "餐饮", "destination_type": "Expense account",
                 "transaction_journal_id": "1"},
            ]))
        respx.get(url__regex=r".*transactions.*start=2026-06-01.*").mock(
            return_value=_txn_page([
                {"type": "withdrawal", "amount": "100", "currency_code": "CNY",
                 "date": "2026-06-06T00:00:00+08:00", "tags": [],
                 "destination_name": "餐饮", "destination_type": "Expense account",
                 "transaction_journal_id": "2"},
            ]))
        resp = client.get(
            "/v1/reports/expense-breakdown?start_date=2026-07-01&end_date=2026-07-31"
            "&compare_start_date=2026-06-01&compare_end_date=2026-06-30",
            headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 200, resp.text
        row = resp.json()["sections"][0]["rows"][0]
        assert row["extra"]["change"] == "50"
        assert row["extra"]["change_pct"] == "50.0"

    def test_compare_dates_must_pair_422(self, client):
        resp = client.get(
            "/v1/reports/expense-breakdown?start_date=2026-07-01"
            "&end_date=2026-07-31&compare_start_date=2026-06-01",
            headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 422

    def test_top_n_bounds_422(self, client):
        resp = client.get(
            "/v1/reports/expense-breakdown?start_date=2026-07-01"
            "&end_date=2026-07-31&top_n=50",
            headers={"Authorization": "Bearer test-token"})
        assert resp.status_code == 422


# -------------------------------------------------------------------
# WP04 任务 3：任务状态脱敏投影（不得泄露 reason/堆栈/路径/内部细节）
# -------------------------------------------------------------------

class TestTaskStatusProjection:
    def _projection(self):
        from finance_bridge.app.state import init_storage, close_storage
        import tempfile, os
        from finance_bridge.app.reporting.tools import task_status_projection
        from finance_bridge.app.storage.job_runs import JobRunRepository

        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        init_storage(f"sqlite:///{path}")
        try:
            repo = JobRunRepository()
            repo.record_success("firefly_cron")
            repo.record_failure("firefly_cron", "FireflyError: stack /opt/secret/path token=abc")
            return task_status_projection()
        finally:
            close_storage()
            os.unlink(path)

    def test_fields_limited_to_allowlist(self):
        proj = self._projection()
        assert proj, "projection must not be empty"
        allowed = {"job_name", "state", "required",
                   "last_success_at", "last_failure_at", "next_planned_at"}
        for job in proj:
            assert set(job) <= allowed, set(job) - allowed
            assert job["state"] in {"healthy", "failed", "stale",
                                    "never_succeeded", "disabled", "unknown"}

    def test_no_reason_stack_path_or_credentials(self):
        proj = self._projection()
        text = repr(proj)
        for leak in ("FireflyError", "stack", "/opt/secret", "token", "reason"):
            assert leak not in text, leak

    def test_failure_after_success_shows_failed_in_projection(self):
        proj = self._projection()
        fc = next(j for j in proj if j["job_name"] == "firefly_cron")
        assert fc["state"] == "failed"
        assert fc["required"] is True
