"""净资产趋势计算与缓存测试（实施文档 §5.3 / §9.1）。"""
from __future__ import annotations

import pytest

from finance_bridge.app.reporting import net_worth_trend
from finance_bridge.app.reporting.net_worth_trend import (
    clear_trend_cache,
    compute_net_worth_trend,
    get_net_worth_trend_cached,
    month_end_points,
)
from finance_bridge.app.reporting.personal_balance_sheet import compute_personal_balance_sheet
from finance_bridge.app.storage.fx_rates import FXRateRepository
from finance_bridge.app.account_groups import load_account_groups


def _acct(account_id: str, acct_type: str, currency: str, balance: str) -> dict:
    return {
        "id": account_id,
        "attributes": {
            "name": f"acc-{account_id}",
            "type": acct_type,
            "currency_code": currency,
            "current_balance": balance,
            "active": True,
            "include_net_worth": True,
        },
    }


@pytest.fixture(autouse=True)
def _clear_cache():
    clear_trend_cache()
    yield
    clear_trend_cache()


def test_month_end_points_basic():
    points = month_end_points("2026-08-07", 12)
    assert len(points) == 12
    assert points[0] == "2025-09-30"
    assert points[-2] == "2026-07-31"
    assert points[-1] == "2026-08-07"  # 最后一个点使用 as_of
    # 升序
    assert points == sorted(points)


def test_month_end_points_boundaries():
    # months=1：单点即 as_of
    assert month_end_points("2026-08-07", 1) == ["2026-08-07"]
    # months=60：60 个点，升序，最后为 as_of
    points = month_end_points("2026-08-07", 60)
    assert len(points) == 60
    assert points[-1] == "2026-08-07"
    assert points[0] == "2021-09-30"
    # 月末日为 31 日的月份
    assert month_end_points("2026-03-15", 2) == ["2026-02-28", "2026-03-15"]
    # as_of 恰好是月末：最后一个点等于月末
    assert month_end_points("2026-08-31", 3) == ["2026-06-30", "2026-07-31", "2026-08-31"]


def test_trend_points_with_rates(temp_storage):
    repo = FXRateRepository(temp_storage)
    repo.upsert_market("EUR", "7.5", "2026-07-01")
    repo.upsert_market("EUR", "8.0", "2026-08-01")

    def fetch(point_date: str):
        # 7 月末余额 100 EUR，8 月 100 EUR + 50 CNY 负债
        if point_date <= "2026-07-31":
            return [_acct("5110", "asset", "EUR", "100.00")]
        return [
            _acct("5110", "asset", "EUR", "100.00"),
            _acct("5201", "liabilities", "CNY", "-50.00"),
        ]

    points = compute_net_worth_trend("2026-08-07", 2, "CNY", fetch, repo)
    assert [p["date"] for p in points] == ["2026-07-31", "2026-08-07"]
    assert points[0]["net_worth_base"] == "750"       # 100 * 7.5
    assert points[0]["total_liabilities_base"] == "0"
    assert points[1]["total_assets_base"] == "800"    # 100 * 8.0
    assert points[1]["total_liabilities_base"] == "50"
    assert points[1]["net_worth_base"] == "750"
    assert all(p["fx_complete"] is True for p in points)


def test_single_point_fx_incomplete_does_not_fail_curve(temp_storage):
    repo = FXRateRepository(temp_storage)
    repo.upsert_market("EUR", "8.0", "2026-08-01")  # HKD 无汇率

    def fetch(point_date: str):
        if point_date == "2026-07-31":
            return [_acct("5104", "asset", "HKD", "100.00")]  # 该点缺汇率
        return [_acct("5110", "asset", "EUR", "100.00")]

    points = compute_net_worth_trend("2026-08-07", 2, "CNY", fetch, repo)
    assert points[0]["fx_complete"] is False
    assert points[0]["missing_currencies"] == ["HKD"]
    assert points[0]["net_worth_base"] is None
    assert points[1]["fx_complete"] is True
    assert points[1]["net_worth_base"] == "800"


def test_empty_data_yields_zero_totals(temp_storage):
    repo = FXRateRepository(temp_storage)

    def fetch(point_date: str):
        return []

    points = compute_net_worth_trend("2026-08-07", 3, "CNY", fetch, repo)
    assert len(points) == 3
    assert all(p["net_worth_base"] == "0" for p in points)
    assert all(p["fx_complete"] is True for p in points)


def test_trend_excludes_include_net_worth_false_accounts(temp_storage):
    """趋势必须与个人口径资产负债表一致：排除 include_net_worth=false（迁移清算等）。"""
    repo = FXRateRepository(temp_storage)
    repo.upsert_market("EUR", "8.0", "2026-06-01")

    accounts = [
        {"id": "5110", "attributes": {
            "name": "Broker A", "type": "asset", "currency_code": "EUR",
            "current_balance": "100.00", "active": True, "include_net_worth": True,
        }},
        {"id": "5113", "attributes": {
            "name": "迁移清算 · CNY", "type": "asset", "currency_code": "CNY",
            "current_balance": "1000.00", "active": False, "include_net_worth": False,
        }},
    ]

    def fetch(point_date: str):
        return accounts

    points = compute_net_worth_trend("2026-08-07", 2, "CNY", fetch, repo)
    assert all(p["net_worth_base"] == "800" for p in points)  # 100 EUR * 8.0，不含迁移清算

    # 与资产负债表同一天的结果逐项勾稽
    bs = compute_personal_balance_sheet(accounts, "2026-08-07", "CNY", repo, load_account_groups())
    assert points[-1]["total_assets_base"] == bs["summary"]["total_assets_base"]
    assert points[-1]["total_liabilities_base"] == bs["summary"]["total_liabilities_base"]
    assert points[-1]["net_worth_base"] == bs["summary"]["net_worth_base"]


def test_trend_liability_display_positive_when_net_positive(temp_storage):
    """负债账户净额为正（历史数据）时，展示仍按绝对值转正，不出现负负债。"""
    repo = FXRateRepository(temp_storage)
    repo.upsert_market("EUR", "8.0", "2026-06-01")

    def fetch(point_date: str):
        # 该历史点负债账户余额为正（如还款溢缴），展示应为其绝对值之和
        return [
            {"id": "5110", "attributes": {
                "name": "Broker A", "type": "asset", "currency_code": "EUR",
                "current_balance": "100.00", "active": True, "include_net_worth": True,
            }},
            {"id": "5201", "attributes": {
                "name": "Card A", "type": "liabilities", "currency_code": "EUR",
                "current_balance": "50.00", "active": True, "include_net_worth": True,
            }},
        ]

    points = compute_net_worth_trend("2026-08-07", 1, "CNY", fetch, repo)
    assert points[0]["total_liabilities_base"] == "400"   # 50 * 8.0，正数展示
    assert points[0]["net_worth_base"] == "400"           # 800 - 400


def test_cache_hits_second_call_and_key_includes_params(temp_storage, monkeypatch):
    repo = FXRateRepository(temp_storage)
    repo.upsert_market("EUR", "8.0", "2026-08-01")
    calls = {"n": 0}

    def fetch(point_date: str):
        calls["n"] += 1
        return [_acct("5110", "asset", "EUR", "100.00")]

    # REL-04：键含 Berlin 业务日第 5 元，钉住业务日才能观察 TTL 内的命中
    monkeypatch.setattr(net_worth_trend, "business_today", lambda: "2026-09-19")

    first = get_net_worth_trend_cached("2026-08-07", 2, "CNY", fetch, repo)
    second = get_net_worth_trend_cached("2026-08-07", 2, "CNY", fetch, repo)
    assert first == second
    assert calls["n"] == 2  # 两个点各取一次，第二次调用全部命中缓存

    # 不同月份 -> 不同缓存键 -> 重新取数
    get_net_worth_trend_cached("2026-08-07", 3, "CNY", fetch, repo)
    assert calls["n"] == 5  # 2 + 3

    # 缓存键构成：接口 + as_of + months + base_currency + 业务日（REL-04）
    assert sorted(net_worth_trend._cache._values) == [
        ("net-worth-trend", "2026-08-07", 2, "CNY", "2026-09-19"),
        ("net-worth-trend", "2026-08-07", 3, "CNY", "2026-09-19"),
    ]


def test_cache_misses_after_business_day_rolls_over(temp_storage, monkeypatch):
    """REL-04：TTL 未到期但柏林业务日已跨日 —— 同一 as_of 字符串必须失配。

    不变式：任何命中结果的隐含业务日 == 命中时的当前业务日。缺省 as_of 由调用方
    按 business_today() 解析，跨日后即使四个入参完全相同也不得再供旧业务日的聚合。
    """
    repo = FXRateRepository(temp_storage)
    repo.upsert_market("EUR", "8.0", "2026-08-01")
    calls = {"n": 0}
    day = {"v": "2026-09-18"}

    def fetch(point_date: str):
        calls["n"] += 1
        return [_acct("5110", "asset", "EUR", "100.00")]

    monkeypatch.setattr(net_worth_trend, "business_today", lambda: day["v"])

    get_net_worth_trend_cached("2026-08-07", 2, "CNY", fetch, repo)
    assert calls["n"] == 2
    # 同一业务日内二次调用：命中缓存，不重算
    get_net_worth_trend_cached("2026-08-07", 2, "CNY", fetch, repo)
    assert calls["n"] == 2

    # 模拟柏林午夜：业务日变更，四个入参完全不变
    day["v"] = "2026-09-19"
    get_net_worth_trend_cached("2026-08-07", 2, "CNY", fetch, repo)
    assert calls["n"] == 4  # 未命中 -> 两个点重新取数
    assert ("net-worth-trend", "2026-08-07", 2, "CNY", "2026-09-19") in (
        net_worth_trend._cache._values
    )
