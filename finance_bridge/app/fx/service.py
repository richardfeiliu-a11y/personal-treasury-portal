# See docs/operations/fx-policy.md for exchange rate policies
"""Small orchestration layer for refreshing and valuing FX rates."""
from __future__ import annotations

from collections.abc import Iterable

from finance_bridge.app.fx.ecb import ECBProvider, ECBProviderError
from finance_bridge.app.reporting.tools import business_today
from finance_bridge.app.storage.fx_rates import FXRateRepository


def refresh_ecb_rates(currencies: Iterable[str], as_of: str | None,
                      repository: FXRateRepository, provider: ECBProvider) -> dict:
    """抓取并写入 ECB 参考汇率（AUD-28：逐币种部分成功）。

    返回结构（向后兼容，新增字段）：
      success            bool —— 是否至少写入了一条**或**无需抓取
      written            int  —— 实际写入条数
      failed_currencies  list —— 本轮未写入的币种（保持既有类型：请求失败时
                                 仍列出全部请求币种，便于既有消费方不变）
      partial            bool —— 新增：成功与失败并存
      rate_date          str  —— 新增语义：实际写入中最新的一条参考日；无写入时
                                 回报请求的估值日（保持 DATA-02 的「业务日同源」）
      reasons            dict —— 新增：失败币种 → 原因（脱敏后上报用）

    语义边界（刻意保留，勿"顺手放宽"）：
    - 单币种失败**不**影响其他币种写入，也不清空既有数据；
    - 失败币种不写任何行 → 其估值仍走 fail-closed（``effective_rate`` 回 None 或
      前向填充到更早日期），绝不按 1:1 伪造；
    - ``success`` 只在「一条都没写成」时为 False，与「部分写入」区分开，
      便于 refresh 脚本与巡检各自决定如何处置。
    """
    requested = sorted({currency.upper() for currency in currencies if currency.upper() != "CNY"})
    if not requested:
        # 无需抓 ECB 时也报 Berlin 业务日（DATA-02 收口）：不抓汇率不等于没有估值日。
        return {"success": True, "rate_date": as_of or business_today(), "written": 0,
                "failed_currencies": [], "partial": False, "reasons": {}}
    try:
        rate_set = provider.get_rates_to_cny(requested, as_of)
    except ECBProviderError as exc:
        # 整体失败：CNY 锚或「除 CNY 外无一可取」。
        return {"success": False, "written": 0, "failed_currencies": requested,
                "partial": False, "error": str(exc), "reasons": {}}

    written = 0
    written_dates: list[str] = []
    for currency in requested:
        rate = rate_set.rates_to_cny.get(currency)
        if rate is None:
            continue
        rate_date = rate_set.rate_dates.get(currency, rate_set.rate_date)
        repository.upsert_market(currency, rate, rate_date, "ECB")
        written += 1
        written_dates.append(rate_date)

    failed = sorted(rate_set.failed_currencies)
    return {
        "success": written > 0,
        "rate_date": max(written_dates) if written_dates else (as_of or business_today()),
        "written": written,
        "failed_currencies": failed,
        "partial": bool(written and failed),
        "reasons": dict(rate_set.failed_currencies),
    }
