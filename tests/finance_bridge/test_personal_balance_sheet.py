"""个人口径资产负债表计算测试（实施文档 §5.2 / §9.1）。"""
from __future__ import annotations

from decimal import Decimal

import pytest

from finance_bridge.app.account_groups import load_account_groups
from finance_bridge.app.reporting.personal_balance_sheet import compute_personal_balance_sheet
from finance_bridge.app.storage.fx_rates import FXRateRepository


def _acct(account_id: str, name: str, acct_type: str, currency: str, balance: str,
          active: bool = True, include_net_worth: bool = True) -> dict:
    return {
        "id": account_id,
        "attributes": {
            "name": name,
            "type": acct_type,
            "currency_code": currency,
            "current_balance": balance,
            "active": active,
            "include_net_worth": include_net_worth,
        },
    }


def _groups():
    return load_account_groups()


@pytest.fixture
def repo(temp_storage):
    """带基础汇率（EUR 7.5 / USD 6.8）的汇率仓库。"""
    r = FXRateRepository(temp_storage)
    r.upsert_market("EUR", "7.5", "2026-08-07")
    r.upsert_market("USD", "6.8", "2026-08-07")
    return r


def test_asset_liability_signs_and_net_worth_tie_out(repo):
    """资产原符号、负债展示为正、净资产勾稽：资产 - 负债展示 = 净资产。"""
    accounts = [
        _acct("10", "Broker A", "asset", "EUR", "100.00"),          # bank group
        _acct("7", "Bank A", "asset", "EUR", "50.00"),
        _acct("105", "银行甲存款", "asset", "CNY", "1000.00"),
        _acct("4", "Card A", "liabilities", "EUR", "-30.00"),     # 负债为负
    ]
    result = compute_personal_balance_sheet(accounts, "2026-08-07", "CNY", repo, _groups())

    assert result["fx_complete"] is True
    assert result["missing_currencies"] == []
    # EUR 100 + EUR 50 + CNY 1000 = 150*7.5 + 1000 = 2125
    assert result["summary"]["total_assets_base"] == "2125"
    # 负债展示正数：30 * 7.5 = 225
    assert result["summary"]["total_liabilities_base"] == "225"
    assert result["summary"]["net_worth_base"] == "1900"  # 2125 - 225
    # 账户行检查：负债原币与折算均为正
    card_group = [g for g in result["groups"] if g["key"] == "credit_cards"][0]
    card_row = card_group["accounts"][0]
    assert card_row["balance_native"] == "30"
    assert card_row["balance_base"] == "225"


def test_include_net_worth_false_excluded_from_report(repo):
    """include_net_worth=false 的账户不进入总额，也不出现在分组。"""
    accounts = [
        _acct("10", "Broker A", "asset", "EUR", "100.00"),
        _acct("126", "迁移清算 · CNY", "asset", "CNY", "1000.00", include_net_worth=False),
    ]
    result = compute_personal_balance_sheet(accounts, "2026-08-07", "CNY", repo, _groups())
    assert result["summary"]["total_assets_base"] == "750"
    assert result["summary"]["included_account_count"] == 1
    all_ids = {a["id"] for g in result["groups"] for a in g["accounts"]}
    assert "126" not in all_ids


def test_inactive_zero_excluded_inactive_nonzero_kept_with_warning(repo):
    accounts = [
        _acct("6", "Bank C", "asset", "EUR", "0.00", active=False),      # 停用零余额：剔除
        _acct("51", "其他eur债权", "asset", "EUR", "10.00", active=False),  # 停用非零：保留
    ]
    result = compute_personal_balance_sheet(accounts, "2026-08-07", "CNY", repo, _groups())
    assert result["summary"]["included_account_count"] == 1
    assert result["summary"]["total_assets_base"] == "75"
    assert any("停用但余额非零" in w for w in result["warnings"])


def test_missing_rate_returns_null_totals_and_keeps_native(repo):
    """EUR 有汇率、HKD 无汇率：受影响账户 balance_base=null，总额为 null，原币保留。"""
    accounts = [
        _acct("9", "Bank B", "asset", "HKD", "12000.25"),
        _acct("10", "Broker A", "asset", "EUR", "100.00"),
    ]
    result = compute_personal_balance_sheet(accounts, "2026-08-07", "CNY", repo, _groups())
    assert result["fx_complete"] is False
    assert result["missing_currencies"] == ["HKD"]
    assert result["summary"]["total_assets_base"] is None
    assert result["summary"]["net_worth_base"] is None
    hkd_row = [a for g in result["groups"] for a in g["accounts"] if a["id"] == "9"][0]
    assert hkd_row["balance_base"] is None
    assert hkd_row["balance_native"] == "12000.25"
    eur_row = [a for g in result["groups"] for a in g["accounts"] if a["id"] == "10"][0]
    assert eur_row["balance_base"] == "750"


def test_zero_balance_currency_does_not_require_rate(repo):
    """余额为零的币种不需要汇率，不影响 fx_complete。"""
    accounts = [
        _acct("33", "Card B ISK", "liabilities", "ISK", "0.00"),
        _acct("105", "银行甲存款", "asset", "CNY", "100.00"),
    ]
    result = compute_personal_balance_sheet(accounts, "2026-08-07", "CNY", repo, _groups())
    assert result["fx_complete"] is True
    assert result["missing_currencies"] == []
    assert result["summary"]["net_worth_base"] == "100"


def test_pending_mapping_warns_and_counts(repo):
    """未配置分组的启用净资产账户进入 pending，产生 warning 并计入 pending_mapping_count。"""
    accounts = [_acct("7777", "新账户", "asset", "CNY", "5.00")]
    result = compute_personal_balance_sheet(accounts, "2026-08-07", "CNY", repo, _groups())
    assert result["summary"]["pending_mapping_count"] == 1
    assert any("待分类" in w for w in result["warnings"])
    pending = [g for g in result["groups"] if g["key"] == "pending_asset"]
    assert pending and pending[0]["accounts"][0]["name"] == "新账户"


def test_type_group_mismatch_routes_to_pending_and_stays_visible(repo):
    """Firefly 类型与 YAML 分组 side 不一致时，账户不得从展示里消失。

    这类账户落进「标题表里没有的桶键」：改前既不出组、也不出行，但三总额照常计入
    它（实测总额与页面列出的待分类行不勾稽 —— 展示与总额勾稽断裂）。
    现在并入对应 side 的待分类组并点名告警。
    """
    accounts = [
        _acct("105", "银行甲存款", "asset", "CNY", "1000.00"),
        _acct("4", "Card A 类型漂移", "asset", "EUR", "-30.00"),     # 配置里是负债侧 credit_cards
        _acct("7", "Bank A 类型漂移", "liabilities", "EUR", "-100.00"),  # 配置里是资产侧 bank
        _acct("7777", "新账户", "asset", "CNY", "10.00"),           # 真正的未配置分组
    ]
    result = compute_personal_balance_sheet(accounts, "2026-08-07", "CNY", repo, _groups())

    displayed = {a["id"] for g in result["groups"] for a in g["accounts"]}
    assert displayed == {"105", "4", "7", "7777"}
    by_key = {g["key"]: g for g in result["groups"]}
    assert {a["id"] for a in by_key["pending_asset"]["accounts"]} == {"7777", "4"}
    assert {a["id"] for a in by_key["pending_liability"]["accounts"]} == {"7"}

    # 展示与总额勾稽：可见行相加 == 统一聚合点的三总额。
    # assets 1000 + 10 + (-30*7.5) = 785；liabilities abs(-100)*7.5 = 750
    assert result["summary"]["total_assets_base"] == "785"
    assert result["summary"]["total_liabilities_base"] == "750"
    assert result["summary"]["net_worth_base"] == "35"
    asset_rows_sum = sum(
        Decimal(a["balance_base"])
        for g in result["groups"] if g["side"] == "asset" for a in g["accounts"]
    )
    liability_rows_sum = sum(
        Decimal(a["balance_base"])
        for g in result["groups"] if g["side"] == "liability" for a in g["accounts"]
    )
    assert asset_rows_sum == Decimal("785")
    assert liability_rows_sum == Decimal("750")

    mismatch = [w for w in result["warnings"] if "分组配置与账户类型不一致" in w]
    assert len(mismatch) == 2, result["warnings"]
    assert any("Card A 类型漂移" in w and "credit_cards" in w for w in mismatch)
    assert any("Bank A 类型漂移" in w and "bank" in w for w in mismatch)
    # 待分类计数仍只表示「未配置分组」，类型漂移不冒充它。
    assert result["summary"]["pending_mapping_count"] == 1


def test_historical_as_of_uses_that_dates_rate(repo):
    """历史截止日：折算使用该日期有效的汇率（早期汇率）。"""
    repo.upsert_market("EUR", "7.0", "2026-07-01")
    accounts = [_acct("10", "Broker A", "asset", "EUR", "100.00")]
    result = compute_personal_balance_sheet(accounts, "2026-07-15", "CNY", repo, _groups())
    assert result["fx_complete"] is True
    assert result["summary"]["total_assets_base"] == "700"


def test_decimal_strings_not_floats(repo):
    """金额必须是 Decimal 字符串，不允许浮点误差。"""
    accounts = [_acct("10", "Broker A", "asset", "EUR", "0.10")]
    result = compute_personal_balance_sheet(accounts, "2026-08-07", "CNY", repo, _groups())
    row = [a for g in result["groups"] for a in g["accounts"] if a["id"] == "10"][0]
    assert row["balance_base"] == "0.75"
    assert Decimal(row["balance_base"]) == Decimal("0.75")
