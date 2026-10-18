"""report-web 端点契约测试：personal-balance-sheet / net-worth-trend（§9.1/§9.3）。"""
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
    # 日期取 2026-06-01：effective_rate 前向填充，可同时覆盖 6/7/8 月趋势点
    repo.upsert_market("EUR", "7.5", "2026-06-01")


def _accounts_url(atype: str, date: str) -> str:
    return f"http://localhost:18080/api/v1/accounts?type={atype}&page=1&limit=50&date={date}"


def _page(payload: list[dict], total_pages: int = 1) -> Response:
    return Response(200, json={"data": payload, "meta": {"pagination": {"total_pages": total_pages}}})


ASSET_ACCOUNTS = [
    {"id": "10", "attributes": {
        "name": "Broker A", "type": "asset", "currency_code": "EUR",
        "current_balance": "100.00", "active": True, "include_net_worth": True,
    }},
    {"id": "105", "attributes": {
        "name": "银行甲存款", "type": "asset", "currency_code": "CNY",
        "current_balance": "1000.00", "active": True, "include_net_worth": True,
    }},
]

LIABILITY_ACCOUNTS = [
    {"id": "4", "attributes": {
        "name": "Card A", "type": "liabilities", "currency_code": "EUR",
        "current_balance": "-30.00", "active": True, "include_net_worth": True,
    }},
]


class TestPersonalBalanceSheetEndpoint:
    @respx.mock
    def test_contract_shape(self, client):
        """响应契约：schema_version/summary/groups/折算/符号与文档示例一致。"""
        _seed_rates()
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page(ASSET_ACCOUNTS))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page(LIABILITY_ACCOUNTS))

        resp = client.get(
            "/v1/reports/personal-balance-sheet?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["schema_version"] == "1.0"
        assert data["source"] == "firefly_live"
        assert data["base_currency"] == "CNY"
        assert data["balance_as_of"] == "2026-08-07"
        assert data["fx_complete"] is True
        assert data["missing_currencies"] == []
        assert data["generated_at"].endswith("+00:00")

        summary = data["summary"]
        assert summary["total_assets_base"] == "1750"     # 100*7.5 + 1000
        assert summary["total_liabilities_base"] == "225"  # 30*7.5
        assert summary["net_worth_base"] == "1525"
        assert summary["included_account_count"] == 3
        assert summary["pending_mapping_count"] == 0

        keys = [g["key"] for g in data["groups"]]
        assert keys == ["bank", "investments", "credit_cards"]
        credit = [g for g in data["groups"] if g["key"] == "credit_cards"][0]
        assert credit["side"] == "liability"
        assert credit["accounts"][0]["balance_native"] == "30"
        assert credit["accounts"][0]["balance_base"] == "225"

    @respx.mock
    def test_missing_rate_nulls_totals(self, client):
        """HKD 无汇率：fx_complete=false、总额 null、原币保留。"""
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page([
            {"id": "9", "attributes": {
                "name": "Bank B", "type": "asset", "currency_code": "HKD",
                "current_balance": "12000.25", "active": True, "include_net_worth": True,
            }},
        ]))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page([]))

        resp = client.get(
            "/v1/reports/personal-balance-sheet?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["fx_complete"] is False
        assert data["missing_currencies"] == ["HKD"]
        assert data["summary"]["total_assets_base"] is None
        assert data["summary"]["net_worth_base"] is None
        row = data["groups"][0]["accounts"][0]
        assert row["balance_native"] == "12000.25"
        assert row["balance_base"] is None

    @respx.mock
    def test_bad_as_of_422(self, client):
        resp = client.get(
            "/v1/reports/personal-balance-sheet?as_of=2026/08/07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 422

    @respx.mock
    def test_firefly_error_502(self, client):
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=Response(500, text="boom"))
        resp = client.get(
            "/v1/reports/personal-balance-sheet?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 502

    def test_no_firefly_credentials_503(self, client):
        old = cfg_settings.firefly_token
        cfg_settings.firefly_token = ""
        try:
            resp = client.get(
                "/v1/reports/personal-balance-sheet?as_of=2026-08-07",
                headers={"Authorization": "Bearer test-token"},
            )
        finally:
            cfg_settings.firefly_token = old
        assert resp.status_code == 503

    def test_requires_bearer_token(self, client):
        resp = client.get("/v1/reports/personal-balance-sheet?as_of=2026-08-07")
        assert resp.status_code == 401


class TestNetWorthTrendEndpoint:
    @respx.mock
    def test_points_ascending_with_last_as_of(self, client):
        """months=3：三个点，月末 + 最后为 as_of，均折算正确。"""
        _seed_rates()
        for d in ("2026-06-30", "2026-07-31", "2026-08-07"):
            respx.get(_accounts_url("asset", d)).mock(return_value=_page(ASSET_ACCOUNTS))
            respx.get(_accounts_url("liabilities", d)).mock(return_value=_page(LIABILITY_ACCOUNTS))

        resp = client.get(
            "/v1/reports/net-worth-trend?as_of=2026-08-07&months=3",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["schema_version"] == "1.0"
        assert data["months"] == 3
        assert [p["date"] for p in data["points"]] == ["2026-06-30", "2026-07-31", "2026-08-07"]
        assert data["points"][0]["net_worth_base"] == "1525"
        assert data["points"][-1]["total_liabilities_base"] == "225"
        assert all(p["fx_complete"] for p in data["points"])

    @respx.mock
    def test_per_point_fx_incomplete(self, client):
        """单点缺汇率只影响该点。"""
        _seed_rates()
        respx.get(_accounts_url("asset", "2026-07-31")).mock(return_value=_page([
            {"id": "9", "attributes": {
                "name": "Bank B", "type": "asset", "currency_code": "HKD",
                "current_balance": "100.00", "active": True, "include_net_worth": True,
            }},
        ]))
        respx.get(_accounts_url("liabilities", "2026-07-31")).mock(return_value=_page([]))
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page(ASSET_ACCOUNTS))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page(LIABILITY_ACCOUNTS))

        resp = client.get(
            "/v1/reports/net-worth-trend?as_of=2026-08-07&months=2",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["points"][0]["fx_complete"] is False
        assert data["points"][0]["net_worth_base"] is None
        assert data["points"][0]["missing_currencies"] == ["HKD"]
        assert data["points"][1]["fx_complete"] is True

    @respx.mock
    def test_months_bounds(self, client):
        resp = client.get(
            "/v1/reports/net-worth-trend?as_of=2026-08-07&months=61",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 422
        resp = client.get(
            "/v1/reports/net-worth-trend?as_of=2026-08-07&months=0",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 422

    @respx.mock
    def test_firefly_error_502(self, client):
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=Response(500, text="boom"))
        resp = client.get(
            "/v1/reports/net-worth-trend?as_of=2026-08-07&months=1",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 502



class TestFxAttributionEndpoint:
    @respx.mock
    def test_contract_shape(self, client):
        """响应契约：period / by_currency / 汇总字段。"""
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
        assert data["schema_version"] == "1.0"
        assert data["period_from"] == "2026-01-01"
        assert data["period_to"] == "2026-08-07"
        assert "total_net_worth_change_cny" in data
        assert "total_savings_contribution_cny" in data
        assert "total_fx_contribution_cny" in data
        assert len(data["by_currency"]) >= 1
        row = data["by_currency"][0]
        assert set(row) == {
            "currency", "start_balance", "end_balance", "start_rate", "end_rate",
            "savings_contribution_cny", "fx_contribution_cny", "net_change_cny",
        }


class TestTrendsEndpoints:
    @respx.mock
    def test_spending_trends_contract(self, client):
        """响应契约（v2）：as_of/base_currency/fx_complete + 行含行级汇率完整性字段。"""
        respx.get(url__regex=r"http://localhost:18080/api/v1/transactions\?start=.*&end=.*&page=1&limit=50").mock(
            return_value=_page([]))
        resp = client.get(
            "/v1/reports/web/spending-trends?months=6&as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["schema_version"] == "1.0"
        assert data["as_of"] == "2026-08-07"
        assert data["base_currency"] == "CNY"
        assert data["comparison_window_months"] == 6
        assert isinstance(data["fx_complete"], bool)
        assert isinstance(data["missing_currencies"], list)
        assert isinstance(data["trends"], list)
        if data["trends"]:
            row = data["trends"][0]
            assert set(row) == {
                "category", "current_month_amount", "historical_monthly_average",
                "deviation_percentage", "fx_complete", "missing_currencies", "anomaly",
            }

    @respx.mock
    def test_currency_exposure_contract(self, client):
        """响应契约：exposures 含占比与折 CNY。"""
        _seed_rates()
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page(ASSET_ACCOUNTS))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page(LIABILITY_ACCOUNTS))
        resp = client.get(
            "/v1/reports/web/currency-exposure?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["schema_version"] == "1.0"
        assert data["base_currency"] == "CNY"
        assert data["fx_complete"] is True
        assert data["missing_currencies"] == []
        # 资产 EUR 100 + 负债 EUR -30 → 净敞口 70
        eur = next(e for e in data["exposures"] if e["currency"] == "EUR")
        assert eur["balance"] == "70.00"
        assert eur["cny_value"] == "525.00"  # _seed_rates 注入 7.5 (70 * 7.5)
        assert eur["percentage"] is not None
        row = data["exposures"][0]
        assert set(row) == {"currency", "balance", "cny_value", "percentage"}

    @respx.mock
    def test_currency_exposure_missing_rate(self, client):
        """P1 修复：缺汇率时 fx_complete=False，总额/单币种 cny_value 为 None（不可用 0 掩盖）。"""
        # 必须先播种 EUR 汇率：本测试自带 EUR 账户，不能依赖前一条测试的数据库残留
        _seed_rates()
        # HKD 无汇率
        hkd_accts = ASSET_ACCOUNTS + [
            {"id": "999", "attributes": {
                "name": "港币账户", "type": "asset", "currency_code": "HKD",
                "current_balance": "100.00", "active": True, "include_net_worth": True,
            }},
        ]
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page(hkd_accts))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page(LIABILITY_ACCOUNTS))
        resp = client.get(
            "/v1/reports/web/currency-exposure?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["fx_complete"] is False
        assert data["missing_currencies"] == ["HKD"]
        assert data["total_net_worth_cny"] is None
        hkd = next(e for e in data["exposures"] if e["currency"] == "HKD")
        assert hkd["cny_value"] is None
        assert hkd["percentage"] is None

    @respx.mock
    def test_currency_exposure_zero_balance_missing_rate_not_blocking(self, client):
        """P2 修复：余额为 0 的币种缺汇率时，不阻塞全局总额（fx_complete 仍为 True）。"""
        _seed_rates()
        # TWD 余额为 0 且无汇率；EUR 有汇率
        twd_accts = ASSET_ACCOUNTS + [
            {"id": "998", "attributes": {
                "name": "台币账户", "type": "asset", "currency_code": "TWD",
                "current_balance": "0.00", "active": True, "include_net_worth": True,
            }},
        ]
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page(twd_accts))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page(LIABILITY_ACCOUNTS))
        resp = client.get(
            "/v1/reports/web/currency-exposure?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        # 0 余额缺汇率不阻塞：fx_complete=True，总额有值，missing 不含 TWD
        assert data["fx_complete"] is True
        assert data["missing_currencies"] == []
        assert data["total_net_worth_cny"] is not None
        twd = next(e for e in data["exposures"] if e["currency"] == "TWD")
        assert twd["balance"] == "0.00"
        assert twd["cny_value"] is None
        assert twd["percentage"] is None

    @respx.mock
    def test_currency_exposure_excludes_include_net_worth_false(self, client):
        """P2 修复：include_net_worth=false 的账户（迁移清算）不计入敞口总额。"""
        _seed_rates()
        # EUR 资产 100（计入）+ EUR 迁移清算 50000（不计入）
        accts = ASSET_ACCOUNTS + [
            {"id": "997", "attributes": {
                "name": "迁移清算 · EUR", "type": "asset", "currency_code": "EUR",
                "current_balance": "50000.00", "active": True, "include_net_worth": False,
            }},
        ]
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page(accts))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page(LIABILITY_ACCOUNTS))
        resp = client.get(
            "/v1/reports/web/currency-exposure?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        # 资产 EUR 100 + 负债 EUR -30 = 70（迁移清算 50000 被排除）
        eur = next(e for e in data["exposures"] if e["currency"] == "EUR")
        assert eur["balance"] == "70.00"
        assert eur["cny_value"] == "525.00"


class TestTransactionsEndpoint:
    @respx.mock
    def test_contract_shape(self, client):
        """响应契约：分页字段与行字段。"""
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
        assert data["total"] == 1
        assert data["offset"] == 0
        assert data["limit"] == 10
        # fx_notes 现在是 list[str]
        assert isinstance(data["fx_notes"], list)
        assert data["fx_notes"] == []  # CNY 交易无汇率说明
        row = data["rows"][0]
        assert set(row) == {
            "date", "type", "description", "category", "source", "destination",
            "amount_native", "currency", "amount_base", "fx_exact", "tags", "journal_id",
        }
        assert row["amount_native"] == "35.00"
        assert row["currency"] == "CNY"

    @respx.mock
    def test_fx_notes_fallback_and_missing(self, client):
        """第 8 项：两类汇率口径分别产生准确的 fx_notes，并可同时存在。"""
        _seed_rates()  # 播种 EUR 在 2026-06-01 的汇率（前向填充可用）
        # EUR 交易 1：2026-06-15（无当日汇率，但 <=6-01 前向填充 → 回填，fx_exact=False）
        # EUR 交易 2：2026-01-15（早于 6-01 → 交易日前无汇率 → amount_base=None）
        respx.get(url__regex=r"http://localhost:18080/api/v1/transactions\?start=.*&end=.*&page=1&limit=50").mock(
            return_value=_page([
                {"id": "g1", "attributes": {"transactions": [{
                    "type": "withdrawal", "date": "2026-06-15", "description": "回填交易",
                    "category_name": "购物", "source_name": "Wallet A", "destination_name": "商店",
                    "amount": "-10.00", "currency_code": "EUR", "tags": [],
                    "transaction_journal_id": "j1",
                }]}},
                {"id": "g2", "attributes": {"transactions": [{
                    "type": "withdrawal", "date": "2026-01-15", "description": "无汇率交易",
                    "category_name": "购物", "source_name": "Wallet A", "destination_name": "商店",
                    "amount": "-10.00", "currency_code": "EUR", "tags": [],
                    "transaction_journal_id": "j2",
                }]}},
            ]))
        resp = client.get(
            "/v1/reports/web/transactions?start=2026-01-01&end=2026-08-07&limit=10&offset=0",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        # 两种说明同时存在
        assert "部分交易无当日汇率，已使用交易日前最近可用汇率折算。" in data["fx_notes"]
        assert "部分交易在交易日前没有可用汇率，未进行基础币种折算。" in data["fx_notes"]
        by_id = {r["journal_id"]: r for r in data["rows"]}
        # 回填：有 amount_base、fx_exact=False
        assert by_id["j1"]["amount_base"] is not None
        assert by_id["j1"]["fx_exact"] is False
        # 完全缺汇率：amount_base=None
        assert by_id["j2"]["amount_base"] is None

    @respx.mock
    def test_report_filter_wiring_and_total_before_pagination(self, client):
        """WP1：report_side/report_category 进入 ledger 筛选；total 为过滤后总数（分页前）。"""
        journals = [
            {"type": "withdrawal", "date": "2026-08-01", "description": "咖啡",
             "category_name": "餐饮", "source_name": "银行甲存款", "source_type": "Asset account",
             "destination_name": "咖啡店", "destination_type": "Expense account",
             "amount": "-35.00", "currency_code": "CNY", "tags": [],
             "transaction_journal_id": f"j{i}"}
            for i in range(1, 4)  # 3 笔命中
        ] + [
            {"type": "withdrawal", "date": "2026-08-02", "description": "房租",
             "category_name": "住房", "source_name": "银行甲存款", "source_type": "Asset account",
             "destination_name": "房东", "destination_type": "Expense account",
             "amount": "-3000.00", "currency_code": "CNY", "tags": [],
             "transaction_journal_id": "j9"},
        ]
        respx.get(url__regex=r"http://localhost:18080/api/v1/transactions\?start=.*&end=.*&page=1&limit=50").mock(
            return_value=_page([{"id": "g1", "attributes": {"transactions": journals}}]))
        resp = client.get(
            "/v1/reports/web/transactions",
            headers={"Authorization": "Bearer test-token"},
            params={
                "start": "2026-08-01", "end": "2026-08-07",
                "report_side": "expense", "report_category": "咖啡店",
                "limit": 2, "offset": 0,
            },
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["total"] == 3          # 过滤后总数，在 pagination slice 前计算
        assert len(data["rows"]) == 2      # 当前页
        assert all(r["category"] == "餐饮" for r in data["rows"])  # raw category 输出不变
        # response shape 不变
        assert set(data["rows"][0]) == {
            "date", "type", "description", "category", "source", "destination",
            "amount_native", "currency", "amount_base", "fx_exact", "tags", "journal_id",
        }

    @respx.mock
    def test_report_filter_partial_pair_ignored(self, client):
        """只传 report_side 时不启用 report filter（冻结契约）。"""
        respx.get(url__regex=r"http://localhost:18080/api/v1/transactions\?start=.*&end=.*&page=1&limit=50").mock(
            return_value=_page([
                {"id": "g1", "attributes": {"transactions": [{
                    "type": "withdrawal", "date": "2026-08-01", "description": "咖啡",
                    "category_name": "餐饮", "source_name": "银行甲存款", "source_type": "Asset account",
                    "destination_name": "咖啡店", "destination_type": "Expense account",
                    "amount": "-35.00", "currency_code": "CNY", "tags": [],
                    "transaction_journal_id": "j1",
                }]}},
            ]))
        resp = client.get(
            "/v1/reports/web/transactions",
            headers={"Authorization": "Bearer test-token"},
            params={"start": "2026-08-01", "end": "2026-08-07", "report_side": "expense"},
        )
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

    @respx.mock
    def test_report_filter_invalid_side_422(self, client):
        """非法 report_side 由 FastAPI Literal 校验拒绝。"""
        resp = client.get(
            "/v1/reports/web/transactions",
            headers={"Authorization": "Bearer test-token"},
            params={"start": "2026-08-01", "end": "2026-08-07",
                    "report_side": "asset", "report_category": "咖啡店"},
        )
        assert resp.status_code == 422


class TestAnomaliesEndpoint:
    @pytest.mark.parametrize("path", ["/v1/reports/web/cashflow-forecast", "/v1/reports/cashflow-forecast"])
    def test_cashflow_forecast_removed(self, client, path):
        """Cashflow capability 已下线：endpoint 不得返回 200。"""
        resp = client.get(path, headers={"Authorization": "Bearer test-token"})
        assert resp.status_code != 200

    @respx.mock
    def test_contract_shape(self, client):
        """响应契约：count/anomalies 形状（含结构化金额字段）。"""
        # compute_anomalies 内部会调用 health/trends 两个来源
        respx.get(url__regex=r"http://localhost:18080/api/v1/accounts.*").mock(return_value=_page(ASSET_ACCOUNTS))
        respx.get(url__regex=r"http://localhost:18080/api/v1/transactions.*").mock(return_value=_page([]))
        resp = client.get(
            "/v1/reports/web/anomalies",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["schema_version"] == "1.0"
        assert "count" in data and "anomalies" in data
        if data["anomalies"]:
            row = data["anomalies"][0]
            # v2 契约：确定性 id + 结构化类别/金额字段（可能为 None）
            assert set(row) >= {"id", "source", "severity", "message", "category", "amount", "currency"}

    @respx.mock
    def test_currency_exposure_future_rate_not_used(self, client):
        """P1 修复（第 5 项）：as_of 之后的汇率不得用于历史敞口（前视偏差）。

        数据库只存在 HKD 在 2026-08-08（晚于 as_of=2026-08-07）的汇率；
        historical_rate 按 as_of 过滤，HKD 仍应视为缺汇率。
        """
        from finance_bridge.app.storage.fx_rates import FXRateRepository
        # 先播种 EUR 汇率：ASSET_ACCOUNTS 含 EUR 账户，本测试只针对 HKD 缺汇率
        _seed_rates()
        # 在当前测试内播种：仅 HKD 的未来汇率
        FXRateRepository().upsert_market("HKD", "0.91", "2026-08-08")
        hkd_accts = ASSET_ACCOUNTS + [
            {"id": "999", "attributes": {
                "name": "港币账户", "type": "asset", "currency_code": "HKD",
                "current_balance": "100.00", "active": True, "include_net_worth": True,
            }},
        ]
        respx.get(_accounts_url("asset", "2026-08-07")).mock(return_value=_page(hkd_accts))
        respx.get(_accounts_url("liabilities", "2026-08-07")).mock(return_value=_page(LIABILITY_ACCOUNTS))
        resp = client.get(
            "/v1/reports/web/currency-exposure?as_of=2026-08-07",
            headers={"Authorization": "Bearer test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        # HKD 无 as_of 当日或之前的汇率 → 缺汇率
        assert data["fx_complete"] is False
        assert data["missing_currencies"] == ["HKD"]
        assert data["total_net_worth_cny"] is None
        hkd = next(e for e in data["exposures"] if e["currency"] == "HKD")
        assert hkd["cny_value"] is None
        assert hkd["percentage"] is None
