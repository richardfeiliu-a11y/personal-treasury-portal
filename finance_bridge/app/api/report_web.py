"""report-web 专用只读接口（个人口径财务报表门户）。

与 Hermes/飞书接口相互独立：响应模型不复用现有 ReportType，仅复用
Firefly Client、FXRateRepository 与 Decimal 计算逻辑（实施文档 §5.1）。
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from finance_bridge.app.account_groups import get_account_groups
from finance_bridge.app.config import settings
from finance_bridge.app.domain.web_reports import (
    SCHEMA_VERSION,
    AnomaliesResponse,
    AnomalyRow,
    BalanceSheetSummary,
    CurrencyExposureResponse,
    CurrencyExposureRow,
    FxAttributionCurrency,
    FxAttributionResponse,
    NetWorthTrendResponse,
    PersonalBalanceSheetResponse,
    SpendingTrendRow,
    SpendingTrendsResponse,
    TransactionRow,
    TransactionsResponse,
)
from finance_bridge.app.reporting.contracts import generated_now
from finance_bridge.app.reporting.net_worth_trend import get_net_worth_trend_cached
from finance_bridge.app.reporting.personal_balance_sheet import compute_personal_balance_sheet
from finance_bridge.app.reporting.tools import business_today
from finance_bridge.app.storage.fx_rates import FXRateRepository

logger = logging.getLogger(__name__)
router = APIRouter()


def _valuation_date(as_of: str | None) -> str:
    """估值日：显式入参原样校验，缺省取 Europe/Berlin 业务今天。

    本门面此前已按 Berlin 解析默认值；DATA-02 把该默认值实现收敛到
    reporting.tools.business_today()，与 Hermes 面 api/reports.py 同源，
    消除的是两面对同一「今天」各算一次的跨面偏差。
    """
    if as_of:
        try:
            datetime.strptime(as_of, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=422, detail="as_of must be YYYY-MM-DD")
        return as_of
    return business_today()


def _require_firefly() -> None:
    if not settings.has_firefly_credentials:
        raise HTTPException(status_code=503, detail="Firefly not configured.")


@router.get("/reports/personal-balance-sheet", response_model=PersonalBalanceSheetResponse)
def personal_balance_sheet(
    as_of: str | None = Query(None, description="Balance date YYYY-MM-DD（默认 Europe/Berlin 今天）"),
) -> PersonalBalanceSheetResponse:
    """个人口径资产负债表（只读）。

    使用 Firefly 历史余额（date 参数），分组按 account_groups.yaml 的 ID 映射。
    """
    _require_firefly()
    valuation_date = _valuation_date(as_of)
    base = settings.base_currency.upper()

    from finance_bridge.app.firefly.client import FireflyClient

    try:
        with FireflyClient(settings) as client:
            accounts = client.get_account_balances(
                account_types=["asset", "liabilities"], date=valuation_date,
                include_net_worth_only=True,
            )
    except Exception as exc:
        logger.error(f"personal-balance-sheet fetch failed: {exc}")
        raise HTTPException(status_code=502, detail=f"Failed to fetch accounts: {exc}")

    computed = compute_personal_balance_sheet(
        accounts, valuation_date, base, FXRateRepository(), get_account_groups()
    )
    return PersonalBalanceSheetResponse(
        schema_version=SCHEMA_VERSION,
        source="firefly_live",
        generated_at=generated_now(),
        base_currency=base,
        balance_as_of=valuation_date,
        fx_complete=computed["fx_complete"],
        missing_currencies=computed["missing_currencies"],
        warnings=computed["warnings"],
        summary=BalanceSheetSummary(**computed["summary"]),
        groups=computed["groups"],
    )


@router.get("/reports/net-worth-trend", response_model=NetWorthTrendResponse)
def net_worth_trend(
    as_of: str | None = Query(None, description="End date YYYY-MM-DD（默认 Europe/Berlin 今天）"),
    months: int = Query(12, ge=1, le=60, description="趋势月数 1-60，默认 12"),
) -> NetWorthTrendResponse:
    """净资产趋势：每月月末一个点，最后一个点为 as_of；带 5 分钟缓存。"""
    _require_firefly()
    valuation_date = _valuation_date(as_of)
    base = settings.base_currency.upper()

    from finance_bridge.app.firefly.client import FireflyClient

    try:
        with FireflyClient(settings) as client:
            def fetch_accounts(point_date: str) -> list[dict[str, Any]]:
                return client.get_account_balances(
                    account_types=["asset", "liabilities"], date=point_date,
                    include_net_worth_only=True,
                )

            points = get_net_worth_trend_cached(
                valuation_date, months, base, fetch_accounts, FXRateRepository()
            )
    except Exception as exc:
        logger.error(f"net-worth-trend fetch failed: {exc}")
        raise HTTPException(status_code=502, detail=f"Failed to fetch trend data: {exc}")

    return NetWorthTrendResponse(
        schema_version=SCHEMA_VERSION,
        base_currency=base,
        as_of=valuation_date,
        months=months,
        points=points,
    )


@router.get("/reports/web/fx-attribution", response_model=FxAttributionResponse)
def fx_attribution(
    from_date: str | None = Query(None, description="Period start YYYY-MM-DD"),
    to_date: str | None = Query(None, description="Period end YYYY-MM-DD"),
) -> FxAttributionResponse:
    """净资产变动拆解：储蓄贡献 + 汇率贡献（report-web 专用，只读）。"""
    _require_firefly()
    from finance_bridge.app.reporting.fx_attribution import compute_fx_attribution
    try:
        computed = compute_fx_attribution(from_date=from_date, to_date=to_date)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.error(f"fx-attribution failed: {exc}")
        raise HTTPException(status_code=502, detail=f"Failed to compute attribution: {exc}")
    period = computed["period"]
    return FxAttributionResponse(
        schema_version=SCHEMA_VERSION,
        period_from=period["from"],
        period_to=period["to"],
        total_net_worth_change_cny=computed["total_net_worth_change_cny"],
        total_savings_contribution_cny=computed["total_savings_contribution_cny"],
        total_fx_contribution_cny=computed["total_fx_contribution_cny"],
        fx_contribution_percentage=computed["fx_contribution_percentage"],
        by_currency=[FxAttributionCurrency(**r) for r in computed["by_currency"]],
        notes=computed["notes"],
    )


@router.get("/reports/web/spending-trends", response_model=SpendingTrendsResponse)
def spending_trends(
    months: int = Query(6, ge=1, le=24, description="Comparison window in months"),
    as_of: str | None = Query(None, description="As-of date YYYY-MM-DD（默认 Europe/Berlin 今天）"),
) -> SpendingTrendsResponse:
    """支出趋势 v2：本月 1-N 日 vs 历史各月 1-N 日（MTD 同期），交易日汇率折算 CNY（report-web 专用，只读）。"""
    _require_firefly()
    val_date = _valuation_date(as_of)
    from finance_bridge.app.reporting.tools import compute_spending_trends
    try:
        computed = compute_spending_trends(months=months, as_of=val_date)
    except Exception as exc:
        logger.error(f"spending-trends failed: {exc}")
        raise HTTPException(status_code=502, detail=f"Failed to compute trends: {exc}")
    return SpendingTrendsResponse(
        schema_version=SCHEMA_VERSION,
        as_of=computed["as_of"],
        current_month=computed["current_month"],
        comparison_window_months=computed["comparison_window_months"],
        base_currency=computed["base_currency"],
        fx_complete=computed["fx_complete"],
        missing_currencies=computed["missing_currencies"],
        categories_count=computed["categories_count"],
        anomalies_count=computed["anomalies_count"],
        trends=[SpendingTrendRow(**t) for t in computed["trends"]],
    )


@router.get("/reports/web/currency-exposure", response_model=CurrencyExposureResponse)
def currency_exposure(
    as_of: str | None = Query(None, description="Valuation date YYYY-MM-DD"),
) -> CurrencyExposureResponse:
    """多币种敞口（report-web 专用，只读）。"""
    _require_firefly()
    from finance_bridge.app.reporting.tools import compute_currency_exposure
    val_date = _valuation_date(as_of)
    try:
        computed = compute_currency_exposure(as_of=val_date)
    except Exception as exc:
        logger.error(f"currency-exposure failed: {exc}")
        raise HTTPException(status_code=502, detail=f"Failed to compute exposure: {exc}")
    return CurrencyExposureResponse(
        schema_version=SCHEMA_VERSION,
        base_currency=computed["base_currency"],
        total_net_worth_cny=computed["total_net_worth_cny"],
        fx_rates_date=computed["fx_rates_date"],
        fx_complete=computed["fx_complete"],
        missing_currencies=computed["missing_currencies"],
        exposures=[CurrencyExposureRow(**e) for e in computed["exposures"]],
    )


@router.get("/reports/web/transactions", response_model=TransactionsResponse)
def transactions(
    start: str = Query(..., description="Start date YYYY-MM-DD"),
    end: str = Query(..., description="End date YYYY-MM-DD"),
    account: str | None = Query(None, description="Filter by source/destination account name"),
    category: str | None = Query(None, description="Filter by category name"),
    txn_type: str | None = Query(None, description="withdrawal | deposit | transfer"),
    report_side: Literal["expense", "income"] | None = Query(
        None, description="Management report side filter（需与 report_category 成对）"),
    report_category: str | None = Query(
        None, description="Management report category filter（需与 report_side 成对）"),
    limit: int = Query(100, ge=1, le=500, description="Page size"),
    offset: int = Query(0, ge=0, description="Page offset"),
) -> TransactionsResponse:
    """交易明细（report-web 专用，只读）：journal 展开 + 交易日期汇率折算。

    ``report_side`` + ``report_category`` 复用 income statement 的
    ``classify_journal()`` management 口径；仅成对提供时生效，与既有
    ``category``/``account``/``txn_type`` 筛选交集。响应 schema 不变。
    """
    _require_firefly()
    # P1 修复：日期格式与区间校验
    from datetime import date as _date
    try:
        start_d = _date.fromisoformat(start)
        end_d = _date.fromisoformat(end)
    except ValueError:
        raise HTTPException(status_code=422, detail="start/end must be YYYY-MM-DD")
    if start_d > end_d:
        raise HTTPException(status_code=422, detail="start must be on or before end")
    MAX_DAYS = 366
    if (end_d - start_d).days > MAX_DAYS:
        raise HTTPException(status_code=422, detail=f"period exceeds {MAX_DAYS} days")
    base = settings.base_currency.upper()
    from finance_bridge.app.domain.transaction_ledger import build_ledger_rows
    from finance_bridge.app.firefly.client import FireflyClient
    try:
        with FireflyClient(settings) as client:
            groups = client.get_transactions_in_range(start, end)
    except Exception as exc:
        logger.error(f"transactions fetch failed: {exc}")
        raise HTTPException(status_code=502, detail=f"Failed to fetch transactions: {exc}")

    ledger = build_ledger_rows(
        groups, base, FXRateRepository(), account, category, txn_type,
        report_side=report_side, report_category=report_category,
    )
    rows = ledger["rows"][offset:offset + limit]
    # 第 8 项：区分两类汇率口径，生成准确说明（可能两条同时存在）
    fx_notes: list[str] = []
    has_fallback = any(r["amount_base"] is not None and r["fx_exact"] is False for r in rows)
    has_missing = any(r["amount_base"] is None for r in rows)
    if has_fallback:
        fx_notes.append("部分交易无当日汇率，已使用交易日前最近可用汇率折算。")
    if has_missing:
        fx_notes.append("部分交易在交易日前没有可用汇率，未进行基础币种折算。")
    return TransactionsResponse(
        schema_version=SCHEMA_VERSION,
        period_from=start,
        period_to=end,
        total=ledger["total"],
        offset=offset,
        limit=limit,
        rows=[TransactionRow(**r) for r in rows],
        fx_notes=fx_notes,
    )


@router.get("/reports/web/anomalies", response_model=AnomaliesResponse)
def anomalies() -> AnomaliesResponse:
    """异常聚合：健康检查 + 支出异常（report-web 专用，只读）。"""
    _require_firefly()
    from finance_bridge.app.reporting.anomaly_detection import compute_anomalies
    try:
        computed = compute_anomalies()
    except Exception as exc:
        logger.error(f"anomalies failed: {exc}")
        raise HTTPException(status_code=502, detail=f"Failed to compute anomalies: {exc}")
    return AnomaliesResponse(
        schema_version=SCHEMA_VERSION,
        checked_at=computed["checked_at"],
        count=computed["count"],
        anomalies=[AnomalyRow(**r) for r in computed["anomalies"]],
    )
