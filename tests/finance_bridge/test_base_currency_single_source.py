"""Batch 13（ARCH-03）— 记账本位币单一来源：BASE 硬编码改读 ``settings.base_currency``。

断言边界（与计划 §Batch 13 一致，别读成「USD 本位已可用」）：
- 这里只钉「计算层把配置的本位币**传下去/报出去**」，不校验非 CNY 本位下的端到端
  折算正确性 —— FX 库存约定是 `1 quote = rate CNY`（`storage/fx_rates.py` 模块
  docstring，`effective_rate` 亦按 base_currency='CNY' 过滤且对 CNY 恒回 1），
  所以 USD 本位今天的折算语义本就不完整，本批次只消除常量复制。
- web 面对非 CNY 的**拒绝**是产品事实（`/v1/reports/account-balances` 直接 503），
  由 `test_reports_endpoints.py::test_rejects_non_cny_base_currency_before_fetching_firefly`
  守着；本文件不放宽也不重复它。
- 默认（settings.base_currency="CNY"）下所有输出必须逐字不变：既有全量断言
  就是「行为零变化」的证据，故此处不另设 CNY 正例。

settings 用 monkeypatch 改（与 `test_business_clock.py` 同法）：模块级
`from ... import settings` 拿到的是同一个单例对象，autouse 夹具的赋值会跨文件泄漏，
monkeypatch 才能保证本文件跑完把值还原。
"""
from __future__ import annotations

import pytest

from finance_bridge.app.config import settings as cfg_settings
from finance_bridge.app.reporting import balance_sheet as hermes_balance_sheet
from finance_bridge.app.reporting import tools
from finance_bridge.app.reporting.balance_sheet import compute_balance_sheet
from finance_bridge.app.storage.fx_rates import FXRateRepository

AS_OF = "2026-08-07"
CONFIGURED_BASE = "USD"


@pytest.fixture
def configured_base(monkeypatch):
    """只改配置，不改代码：断言的正是「计算层读不读配置」这件事。"""
    monkeypatch.setattr(cfg_settings, "base_currency", CONFIGURED_BASE)


def _acct(account_id: str, name: str, acct_type: str, currency: str | None,
          balance: str) -> dict:
    attributes: dict = {
        "name": name,
        "type": acct_type,
        "current_balance": balance,
        "active": True,
        "include_net_worth": True,
    }
    if currency is not None:
        attributes["currency_code"] = currency
    return {"id": account_id, "attributes": attributes}


class _AccountsClient:
    """FireflyClient 替身：只回一页账户（其中一条刻意无 currency_code）。"""

    def __init__(self, settings):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get_account_balances(self, account_types, date=None, include_net_worth_only=False):
        return [
            _acct("1", "现金", "asset", None, "100.00"),
        ]


# -------------------------------------------------------------------
# Hermes 面资产负债表：三总额的聚合点参数 + envelope 字段 + 展示桶兜底
# -------------------------------------------------------------------

def test_balance_sheet_passes_configured_base_to_unified_aggregate(
    monkeypatch, configured_base, temp_storage
):
    """唯一聚合点 `value_personal_scope` 必须收到配置的本位币（原为 BASE 常量）。"""
    calls: list[str] = []
    real = hermes_balance_sheet.value_personal_scope

    def spy(accounts, as_of, base_currency, repository):
        calls.append(base_currency)
        return real(accounts, as_of, base_currency, repository)

    monkeypatch.setattr(hermes_balance_sheet, "value_personal_scope", spy)
    hermes = compute_balance_sheet(
        [_acct("5110", "Broker A", "asset", "USD", "100.00")], AS_OF, FXRateRepository(temp_storage)
    )

    assert calls == [CONFIGURED_BASE], (
        f"聚合点收到 {calls}，期望 settings.base_currency={CONFIGURED_BASE!r}"
        "（BASE 常量的唯一来源应是 settings）"
    )
    assert hermes.base_currency == CONFIGURED_BASE


def test_balance_sheet_display_bucket_fallback_uses_configured_base(configured_base, temp_storage):
    """无 currency_code 的账户落进「本位币」桶：桶名同样跟着 settings 走。"""
    hermes = compute_balance_sheet(
        [_acct("1", "现金", "asset", None, "100.00")], AS_OF, FXRateRepository(temp_storage)
    )

    assert [row.currency for row in hermes.sections[0].rows] == [CONFIGURED_BASE]


def test_balance_sheet_missing_rate_warning_names_configured_base(configured_base, temp_storage):
    """缺率警示语是全仓唯一把本位币拼进**用户可见文案**的地方（`balance_sheet.py`
    的「…；{base} 总数不可用」），所以它也必须读 settings 而不是硬编码 "CNY"。

    账户币种刻意用 EUR（与配置本位币不同），这样「文案里出现的币种」只剩本位币
    一个来源；把该行改回硬编码 CNY 时本用例即红（变异验证过）。
    """
    hermes = compute_balance_sheet(
        [_acct("20", "EUR 证券户", "asset", "EUR", "100.00")],
        AS_OF,
        FXRateRepository(temp_storage),
    )

    assert f"{CONFIGURED_BASE} 总数不可用" in " ".join(hermes.warnings), (
        f"警示语未带上配置本位币 {CONFIGURED_BASE!r}：{hermes.warnings}"
    )


# -------------------------------------------------------------------
# tools.compute_currency_exposure：回传字段 + 原币桶兜底
# -------------------------------------------------------------------

def test_currency_exposure_reports_configured_base_currency(monkeypatch, configured_base):
    """无凭据分支（不查 Firefly）也必须把配置的本位币回传给调用方。"""
    monkeypatch.setattr(tools.settings, "firefly_token", "")

    out = tools.compute_currency_exposure(as_of=AS_OF)

    assert out["base_currency"] == CONFIGURED_BASE


def test_currency_exposure_bucket_fallback_uses_configured_base(
    monkeypatch, configured_base
):
    """`currency_code` 缺失时的兜底币种 = 配置本位币（原为写死的 "CNY"）。

    只断言行标签，不断言折算：本位币那一行按定义不查汇率，标签即参数证据。
    """
    monkeypatch.setattr(tools.settings, "firefly_token", "test-ff-token")
    monkeypatch.setattr(tools.settings, "firefly_api_url", "http://test/api/v1")
    monkeypatch.setattr(tools, "FireflyClient", _AccountsClient)

    out = tools.compute_currency_exposure(as_of=AS_OF)

    assert [exp["currency"] for exp in out["exposures"]] == [CONFIGURED_BASE]
