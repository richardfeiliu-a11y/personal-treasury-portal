"""Web 报表金额契约专项测试 (TASK-5 / TEST-001)。

验证所有 /v1/reports/* 及 /v1/reports/web/* 端点响应中：
1. 所有金额字段统一为 Decimal 字符串 (str) 或 None。
2. 比率/百分比/汇率白名单字段允许 float/int 或 None。
3. 若出现 float 金额字段，测试立即报错（防止退化为 float）。
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

from finance_bridge.app.main import app
from finance_bridge.app.config import settings as cfg_settings
from finance_bridge.app.reporting.net_worth_trend import clear_trend_cache
from finance_bridge.app.storage.fx_rates import FXRateRepository

pytestmark = pytest.mark.skipif(not HAS_RESPX, reason="respx not installed")

MONEY_FIELDS = {
    "balance_native",
    "balance_base",
    "total_assets_base",
    "total_liabilities_base",
    "net_worth_base",
    "subtotal_base",
    "amount",
    "amount_native",
    "amount_base",
    "current_balance",
    "monthly_avg_income",
    "monthly_avg_expense",
    "net_daily_drift",
    "min_projected_balance",
    "net_change",
    "projected_balance",
    "start_balance",
    "end_balance",
    "savings_contribution_cny",
    "fx_contribution_cny",
    "net_change_cny",
    "total_net_worth_change_cny",
    "total_savings_contribution_cny",
    "total_fx_contribution_cny",
    "current_month_amount",
    "historical_monthly_average",
    "balance",
    "cny_value",
    "total_net_worth_cny",
}

FLOAT_WHITELIST_FIELDS = {
    "percentage",
    "deviation",
    "deviation_percentage",
    "change_rate",
    "fx_contribution_percentage",
    "start_rate",
    "end_rate",
}


def assert_decimal_string_contract(obj: dict | list | str | int | float | None) -> None:
    """递归遍历响应 JSON，断言所有金额字段为 str|None、白名单字段为 float/int|None。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in MONEY_FIELDS:
                assert v is None or isinstance(v, str), (
                    f"Money field '{k}' must be str or None, got {type(v).__name__}: {v!r}"
                )
            elif k in FLOAT_WHITELIST_FIELDS:
                assert v is None or isinstance(v, (int, float)), (
                    f"Float whitelist field '{k}' must be float/int or None, got {type(v).__name__}: {v!r}"
                )
            assert_decimal_string_contract(v)
    elif isinstance(obj, list):
        for item in obj:
            assert_decimal_string_contract(item)


@pytest.fixture(autouse=True)
def _setup():
    from finance_bridge.app.state import reset_state
    reset_state()
    clear_trend_cache()
    cfg_settings.bridge_internal_token = "test-token"
    cfg_settings.firefly_token = "test-ff-token"
    cfg_settings.firefly_api_url = "http://localhost:18080/api/v1"
    cfg_settings.base_currency = "CNY"
    yield
    clear_trend_cache()


@pytest.fixture
def client():
    return TestClient(app)


def _seed_rates():
    repo = FXRateRepository()
    repo.upsert_market("EUR", "7.5", "2026-06-01")


def _accounts_url(atype: str, date: str) -> str:
    return f"http://localhost:18080/api/v1/accounts?type={atype}&page=1&limit=50&date={date}"


def _page(payload: list[dict], total_pages: int = 1) -> Response:
    return Response(200, json={"data": payload, "meta": {"pagination": {"total_pages": total_pages}}})


ASSET_ACCOUNTS = [
    {"id": "5110", "attributes": {
        "name": "Broker A", "type": "asset", "currency_code": "EUR",
        "current_balance": "100.00", "active": True, "include_net_worth": True,
    }},
    {"id": "5105", "attributes": {
        "name": "银行甲存款", "type": "asset", "currency_code": "CNY",
        "current_balance": "1000.00", "active": True, "include_net_worth": True,
    }},
]

LIABILITY_ACCOUNTS = [
    {"id": "5201", "attributes": {
        "name": "Card A", "type": "liabilities", "currency_code": "EUR",
        "current_balance": "-30.00", "active": True, "include_net_worth": True,
    }},
]


class TestWebReportAmountContracts:
    @respx.mock
    def test_personal_balance_sheet_amount_types(self, client):
        _seed_rates()
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page(ASSET_ACCOUNTS))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page(LIABILITY_ACCOUNTS))

        resp = client.get(
            "/v1/reports/personal-balance-sheet?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert_decimal_string_contract(data)

    @respx.mock
    def test_net_worth_trend_amount_types(self, client):
        _seed_rates()
        for d in ("2026-06-30", "2026-07-31", "2026-08-07"):
            respx.get(_accounts_url("asset", d)).mock(return_value=_page(ASSET_ACCOUNTS))
            respx.get(_accounts_url("liabilities", d)).mock(return_value=_page(LIABILITY_ACCOUNTS))

        resp = client.get(
            "/v1/reports/net-worth-trend?as_of=2026-08-07&months=3",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert_decimal_string_contract(data)


    @respx.mock
    def test_fx_attribution_amount_types(self, client):
        _seed_rates()
        for date_str in ("2026-01-01", "2026-08-07"):
            respx.get(f"http://localhost:18080/api/v1/accounts?type=asset&page=1&limit=50&date={date_str}").mock(
                return_value=_page(ASSET_ACCOUNTS))
            respx.get(f"http://localhost:18080/api/v1/accounts?type=liabilities&page=1&limit=50&date={date_str}").mock(
                return_value=_page(LIABILITY_ACCOUNTS))

        resp = client.get(
            "/v1/reports/web/fx-attribution?from_date=2026-01-01&to_date=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert_decimal_string_contract(data)

    @respx.mock
    def test_spending_trends_amount_types(self, client):
        respx.get(url__regex=r"http://localhost:18080/api/v1/transactions\?start=.*&end=.*&page=1&limit=50").mock(
            return_value=_page([]))
        resp = client.get(
            "/v1/reports/web/spending-trends?months=6",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert_decimal_string_contract(data)

    @respx.mock
    def test_currency_exposure_amount_types(self, client):
        _seed_rates()
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page(ASSET_ACCOUNTS))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page(LIABILITY_ACCOUNTS))
        resp = client.get(
            "/v1/reports/web/currency-exposure?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert_decimal_string_contract(data)

    @respx.mock
    def test_transactions_amount_types(self, client):
        respx.get(url__regex=r"http://localhost:18080/api/v1/transactions\?start=.*&end=.*&page=1&limit=50").mock(
            return_value=_page([
                {"id": "g1", "attributes": {"transactions": [{
                    "type": "withdrawal", "date": "2026-08-01", "description": "咖啡",
                    "category_name": "餐饮", "source_name": "银行甲存款",
                    "destination_name": "咖啡店", "amount": "-35.00",
                    "currency_code": "CNY", "tags": [], "transaction_journal_id": "j1",
                }]}},
            ]))
        resp = client.get(
            "/v1/reports/web/transactions?start=2026-08-01&end=2026-08-07&limit=10&offset=0",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert_decimal_string_contract(data)

    @respx.mock
    def test_anomalies_amount_types(self, client):
        respx.get(url__regex=r"http://localhost:18080/api/v1/accounts.*").mock(return_value=_page(ASSET_ACCOUNTS))
        respx.get(url__regex=r"http://localhost:18080/api/v1/transactions.*").mock(return_value=_page([]))
        resp = client.get(
            "/v1/reports/web/anomalies",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert_decimal_string_contract(data)

    @respx.mock
    def test_missing_rates_none_handling(self, client):
        """缺汇率时 amount_base / cny_value / totals 为 None，契约断言不抛错。"""
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page([
            {"id": "99", "attributes": {
                "name": "HKD 账户", "type": "asset", "currency_code": "HKD",
                "current_balance": "500.00", "active": True, "include_net_worth": True,
            }}
        ]))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page([]))

        resp = client.get(
            "/v1/reports/personal-balance-sheet?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["summary"]["total_assets_base"] is None
        assert_decimal_string_contract(data)
