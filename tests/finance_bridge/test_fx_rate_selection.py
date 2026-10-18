"""FX 汇率选择优先级回归测试（审计发现 FX-1/FX-2）。

政策口径（docs/operations/fx-policy.md）：
- 报表展示使用报表日的 ECB 参考中间价 —— 即取 rate_date <= as_of 中**最新**的一条；
- 手工汇率优先于市场汇率 —— 仅在同一天存在多条记录时生效；
- 交易入账使用交易当天的 ECB 参考中间价（historical_rate 同理按日期优先）。

原实现 `ORDER BY manual_override DESC, rate_date DESC` 把 manual_override 放在
日期之前：任意一条历史手工汇率会永久遮蔽所有更新的市场汇率（估值被冻结）。
historical_rate 的 rate_type='historical' 过滤优先于日期同理导致回填数据
遮蔽更新的市场汇率。以下测试锁定修正后的语义。
"""
from __future__ import annotations

from finance_bridge.app.storage.fx_rates import FXRateRepository


def test_manual_rate_on_older_date_must_not_shadow_newer_market_rate(temp_storage):
    repository = FXRateRepository(temp_storage)
    repository.set_manual("USD", "6.90", "2026-07-16", "bank settlement")
    repository.upsert_market("USD", "6.80", "2026-07-17")

    chosen = repository.effective_rate("USD", "2026-07-17")
    assert chosen["rate"] == "6.80"
    assert chosen["manual_override"] is False

    # as_of 落在手工汇率当天（尚无更新的市场汇率）时仍应使用手工汇率
    same_day = repository.effective_rate("USD", "2026-07-16")
    assert same_day["rate"] == "6.90"
    assert same_day["manual_override"] is True


def test_latest_rate_prefers_newest_date_over_manual_flag(temp_storage):
    repository = FXRateRepository(temp_storage)
    repository.set_manual("USD", "6.90", "2026-07-16", "bank settlement")
    repository.upsert_market("USD", "6.80", "2026-07-17")

    chosen = repository.latest_rate("USD")
    assert chosen["rate"] == "6.80"
    assert chosen["manual_override"] is False


def test_manual_rate_wins_on_same_date_as_market(temp_storage):
    repository = FXRateRepository(temp_storage)
    repository.upsert_market("USD", "6.80", "2026-07-17")
    repository.set_manual("USD", "6.90", "2026-07-17", "bank settlement")

    chosen = repository.effective_rate("USD", "2026-07-17")
    assert chosen["rate"] == "6.90"
    assert chosen["manual_override"] is True


def test_historical_rate_type_must_not_shadow_newer_market_rate(temp_storage):
    """回填的 historical 记录不得遮蔽更新的市场记录（政策：用交易当日 ECB 价）。"""
    repository = FXRateRepository(temp_storage)
    repository.upsert_historical("EUR", "7.50", "2026-01-01")
    repository.upsert_market("EUR", "7.80", "2026-08-01")

    chosen = repository.historical_rate("EUR", "2026-08-15")
    assert chosen["rate"] == "7.80"

    # 交易发生在回填区间内时仍取 <= as_of 的最新记录
    in_range = repository.historical_rate("EUR", "2026-06-01")
    assert in_range["rate"] == "7.50"
