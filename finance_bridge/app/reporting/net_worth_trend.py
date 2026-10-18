"""净资产趋势计算（report-web 专用，只读）。

口径（实施文档 §5.3）：
- months 允许 1–60，每个点使用相应月份月末，最后一个点使用 as_of；
- 历史账户余额使用 Firefly date 参数，历史汇率取该日期有效汇率；
- 单点汇率不完整时该点总额为 null 并附缺失币种，不影响整条曲线；
- 进程内 5 分钟 TTL 缓存，缓存键含接口、日期、月份、基础币种与 Berlin 业务日
  （REL-04）；不新增数据库表。
"""
from __future__ import annotations

import calendar
from collections.abc import Callable
from datetime import date
from typing import Any

from finance_bridge.app.reporting.cache import TTLFlightCache
from finance_bridge.app.reporting.personal_balance_sheet import value_personal_scope
from finance_bridge.app.reporting.tools import business_today
from finance_bridge.app.storage.fx_rates import FXRateRepository

CACHE_TTL_SECONDS = 300  # 5 分钟


def month_end_points(as_of: str, months: int) -> list[str]:
    """生成趋势点日期：最近 months 个月的月末，最后一个点替换为 as_of。"""
    as_of_date = date.fromisoformat(as_of)
    # 起点月份 = as_of 所在月往前推 months-1 个月
    start_index = as_of_date.year * 12 + (as_of_date.month - 1) - (months - 1)
    points: list[date] = []
    for i in range(months):
        idx = start_index + i
        year, month0 = divmod(idx, 12)
        month = month0 + 1
        points.append(date(year, month, calendar.monthrange(year, month)[1]))
    points[-1] = as_of_date  # 最后一个点使用 as_of（而非月末）
    return [d.isoformat() for d in points]


def compute_net_worth_trend(
    as_of: str,
    months: int,
    base_currency: str,
    fetch_accounts: Callable[[str], list[dict[str, Any]]],
    repository: FXRateRepository,
) -> list[dict[str, Any]]:
    """逐点计算净资产趋势。

    fetch_accounts(point_date) 返回该日期 Firefly 账户列表（含历史余额）。
    每个点独立计算；单点缺失汇率只影响该点。
    """
    points: list[dict[str, Any]] = []
    for point_date in month_end_points(as_of, months):
        accounts = fetch_accounts(point_date)
        points.append(_point_totals(accounts, point_date, base_currency, repository))
    return points


def _point_totals(
    accounts: list[dict[str, Any]],
    point_date: str,
    base_currency: str,
    repository: FXRateRepository,
) -> dict[str, Any]:
    # 与个人口径资产负债表同一套规则（排除 include_net_worth=false、负债取绝对值）
    valuation = value_personal_scope(accounts, point_date, base_currency, repository)
    return {
        "date": point_date,
        "total_assets_base": valuation["total_assets_base"],
        "total_liabilities_base": valuation["total_liabilities_base"],
        "net_worth_base": valuation["net_worth_base"],
        "fx_complete": valuation["fx_complete"],
        "missing_currencies": valuation["missing_currencies"],
    }


_cache = TTLFlightCache(ttl_seconds=CACHE_TTL_SECONDS)


def get_net_worth_trend_cached(
    as_of: str,
    months: int,
    base_currency: str,
    fetch_accounts: Callable[[str], list[dict[str, Any]]],
    repository: FXRateRepository,
) -> list[dict[str, Any]]:
    """带 5 分钟缓存的趋势计算；缓存键 = (接口, as_of, months, base_currency, 业务日)。

    REL-04：第 5 元取 `business_today()`（Europe/Berlin，Batch 02 单点）——命中只
    在写入时的同一业务日内成立，同一 as_of 字符串跨业务日即失配，旧业务日算出的
    聚合不会在午夜后再供满 300s TTL。该元素保护的对象：缺省 as_of 已由入口
    `_valuation_date()` 解析覆盖、本不受益，真正受保护的是显式传入的 as_of（浏览器
    的「今天」可能滞后于柏林业务日）与入口解析未来退化的情况；同族的支出趋势缓存
    （`reporting/tools.py`）不变量相同而机制不同：解析后的 resolved_as_of 入键，
    且一次请求只读一次钟。

    `as_of` 必须是已解析的 `YYYY-MM-DD`：缺省日由入口 `_valuation_date()`（同一
    `business_today()` 实现）单点解析后传入，本层不参与日期兜底。跨午夜的边界竞态
    只会让该条目多失配一次：业务日元素本身不进计算，值只由 as_of、months、
    base_currency 与实时数据源决定（300s TTL 正因数据源会变才存在），因此不会把
    某业务日的聚合挂到另一个 as_of 的键下。
    """
    key = ("net-worth-trend", as_of, months, base_currency.upper(), business_today())
    return _cache.get_or_compute(
        key,
        lambda: compute_net_worth_trend(as_of, months, base_currency, fetch_accounts, repository),
    )


def clear_trend_cache() -> None:
    """测试/运维用：清空趋势缓存。"""
    _cache.clear()
