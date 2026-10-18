"""Read-only report API endpoints.

H3: Real balance/queries from Firefly API with multi-currency support.
- Account balances with per-currency grouping
- Net worth: fx_complete flag, per-currency breakdowns, null totals when FX incomplete
- Period P&L: journal-level iteration (not group-level), multi-currency aware
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from finance_bridge.app.config import settings
from finance_bridge.app.domain.account_search import find_account_candidates
from finance_bridge.app.domain.web_reports import WebAccountBalancesResponse
from finance_bridge.app.fx.ecb import ECBProvider
from finance_bridge.app.fx.service import refresh_ecb_rates
from finance_bridge.app.reporting.balance_sheet import compute_balance_sheet
from finance_bridge.app.reporting.contracts import ReportEnvelope, decimal_text
from finance_bridge.app.reporting.expense_breakdown import compute_expense_breakdown
from finance_bridge.app.reporting.income_statement import compute_income_statement
from finance_bridge.app.reporting.tools import business_today
from finance_bridge.app.storage.aliases import aliases
from finance_bridge.app.storage.drafts import drafts
from finance_bridge.app.storage.fx_rates import FXRateRepository
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

def _valuation_date(as_of: str | None) -> str:
    """估值日：显式入参原样校验，缺省取 Europe/Berlin 业务今天。"""
    value = as_of or business_today()
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="as_of must be YYYY-MM-DD")
    return value


def _validate_range(start_date: str, end_date: str) -> None:
    try:
        datetime.strptime(start_date, "%Y-%m-%d")
        datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be YYYY-MM-DD")
    if start_date > end_date:
        raise HTTPException(status_code=422, detail="start_date must be before end_date")


# -------------------------------------------------------------------
# v1 unified reports — thin routes over app.reporting services
# -------------------------------------------------------------------

@router.get("/reports/balance-sheet", response_model=ReportEnvelope)
def balance_sheet(
    as_of: str | None = Query(None, description="Balance date YYYY-MM-DD（默认 Europe/Berlin 今天）"),
) -> ReportEnvelope:
    """资产负债快照 — historical balances via Firefly date param."""
    if not settings.has_firefly_credentials:
        raise HTTPException(status_code=503, detail="Firefly not configured.")
    valuation_date = _valuation_date(as_of)
    from finance_bridge.app.firefly.client import FireflyClient
    try:
        with FireflyClient(settings) as client:
            accounts = client.get_account_balances(
                account_types=["asset", "liabilities"], date=valuation_date,
                include_net_worth_only=True,
            )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch accounts: {exc}")
    return compute_balance_sheet(accounts, valuation_date, FXRateRepository())


@router.get("/reports/income-statement", response_model=ReportEnvelope)
def income_statement(
    start_date: str = Query(..., description="Start date YYYY-MM-DD"),
    end_date: str = Query(..., description="End date YYYY-MM-DD"),
    accounting_view: str = Query("management", pattern="^(native|management)$"),
) -> ReportEnvelope:
    """期间收支表 — native/management views, transaction-date FX."""
    _validate_range(start_date, end_date)
    if not settings.has_firefly_credentials:
        raise HTTPException(status_code=503, detail="Firefly not configured.")
    from finance_bridge.app.firefly.client import FireflyClient
    try:
        with FireflyClient(settings) as client:
            groups = client.get_transactions_in_range(start_date, end_date)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch transactions: {exc}")
    return compute_income_statement(
        groups, start_date, end_date, accounting_view, FXRateRepository())


@router.get("/reports/expense-breakdown", response_model=ReportEnvelope)
def expense_breakdown(
    start_date: str = Query(..., description="Start date YYYY-MM-DD"),
    end_date: str = Query(..., description="End date YYYY-MM-DD"),
    compare_start_date: str | None = Query(None),
    compare_end_date: str | None = Query(None),
    top_n: int = Query(10, ge=1, le=20),
    accounting_view: str = Query("management", pattern="^(native|management)$"),
) -> ReportEnvelope:
    """费用分析表 — Top N with optional comparison period."""
    _validate_range(start_date, end_date)
    if (compare_start_date is None) != (compare_end_date is None):
        raise HTTPException(
            status_code=422,
            detail="compare_start_date and compare_end_date must be provided together")
    if compare_start_date and compare_end_date:
        _validate_range(compare_start_date, compare_end_date)
    if not settings.has_firefly_credentials:
        raise HTTPException(status_code=503, detail="Firefly not configured.")
    from finance_bridge.app.firefly.client import FireflyClient
    try:
        with FireflyClient(settings) as client:
            current_groups = client.get_transactions_in_range(start_date, end_date)
            compare_groups = (
                client.get_transactions_in_range(compare_start_date, compare_end_date)
                if compare_start_date and compare_end_date else None
            )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch transactions: {exc}")
    return compute_expense_breakdown(
        current_groups, start_date, end_date, FXRateRepository(),
        compare_groups=compare_groups,
        compare_start_date=compare_start_date,
        compare_end_date=compare_end_date,
        top_n=top_n, accounting_view=accounting_view,
    )


class ManualFXRateRequest(BaseModel):
    currency: str
    rate_to_cny: str
    rate_date: str
    reason: str


# -------------------------------------------------------------------
# Special P&L tags — identified at transaction level (not by account name)
# -------------------------------------------------------------------
@router.get("/accounts")
async def list_accounts(include_inactive: bool = False) -> dict[str, Any]:
    """List Bridge aliases for Hermes and the account-sync dry-run.

    Normal Hermes calls see active aliases only. The explicit query flag lets
    the sync tool compare inactive aliases without treating them as new.
    """
    return {
        "base_currency": settings.base_currency,
        "accounts": aliases.list_all(include_inactive=include_inactive),
    }


@router.get("/accounts/candidates")
def account_candidates(
    query: str,
    account_types: list[str] | None = Query(None),
    currency: str | None = Query(None),
    limit: int = Query(10, ge=1, le=20),
) -> dict[str, Any]:
    """Find active aliases only; this endpoint never chooses or mutates one."""
    normalized_query = query.strip()
    if not normalized_query:
        raise HTTPException(status_code=422, detail="query must not be empty")
    candidates = find_account_candidates(
        aliases.list_all(include_inactive=False),
        normalized_query,
        account_types=account_types,
        currency=currency,
        limit=limit,
    )
    return {
        "query": normalized_query,
        "account_types": account_types or [],
        "currency": currency.upper() if currency else None,
        "candidates": candidates,
    }


@router.get("/fx/status")
def fx_status(as_of: str | None = Query(None, description="Valuation date YYYY-MM-DD（默认 Europe/Berlin 今天）")) -> dict[str, Any]:
    """Read-only status of FX availability for current non-zero net-worth balances."""
    if not settings.has_firefly_credentials:
        raise HTTPException(status_code=503, detail="Firefly not configured.")
    valuation_date = _valuation_date(as_of)
    from finance_bridge.app.firefly.client import FireflyClient
    try:
        with FireflyClient(settings) as client:
            accounts = client.get_account_balances(
                ["asset", "liabilities"], include_net_worth_only=True)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch accounts: {exc}")
    balances: dict[str, Decimal] = defaultdict(Decimal)
    for account in accounts:
        attrs = account.get("attributes", {})
        currency = (attrs.get("currency_code") or settings.base_currency).upper()
        try:
            balances[currency] += Decimal(attrs.get("current_balance", "0"))
        except Exception:
            continue
    repository = FXRateRepository()
    rates = {currency: repository.effective_rate(currency, valuation_date) for currency in sorted(balances)}
    missing = [currency for currency, rate in rates.items() if rate is None and balances[currency] != 0]
    zero_missing = [currency for currency, rate in rates.items() if rate is None and balances[currency] == 0]
    return {"base_currency": settings.base_currency.upper(), "as_of": valuation_date,
            "required_currencies": sorted(currency for currency, amount in balances.items() if amount != 0),
            "missing_currencies": missing, "zero_balance_missing_currencies": zero_missing,
            "rates_used": {currency: {key: rate[key] for key in ("rate", "rate_date", "source", "manual_override")}
                           for currency, rate in rates.items() if rate}}


@router.post("/fx/refresh")
def refresh_fx(as_of: str | None = Query(None, description="Requested ECB date YYYY-MM-DD")) -> dict[str, Any]:
    """Refresh ECB market rates only; it never calls Firefly write APIs."""
    valuation_date = _valuation_date(as_of)
    if not settings.has_firefly_credentials:
        raise HTTPException(status_code=503, detail="Firefly not configured.")
    from finance_bridge.app.firefly.client import FireflyClient
    try:
        with FireflyClient(settings) as client:
            accounts = client.get_account_balances(
                ["asset", "liabilities"], include_net_worth_only=True)
        currencies = {
            (a.get("attributes", {}).get("currency_code") or settings.base_currency).upper()
            for a in accounts
            if Decimal(a.get("attributes", {}).get("current_balance", "0")) != 0
        }
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch accounts: {exc}")
    result = refresh_ecb_rates(currencies, valuation_date, FXRateRepository(), ECBProvider())
    if not result["success"]:
        raise HTTPException(status_code=502, detail=result)
    return result


@router.post("/fx/manual")
def set_manual_fx_rate(request: ManualFXRateRequest) -> dict[str, Any]:
    """Set an auditable manual override. This is FX metadata only."""
    _valuation_date(request.rate_date)
    try:
        row = FXRateRepository().set_manual(
            request.currency, request.rate_to_cny, request.rate_date, request.reason,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {key: row[key] for key in ("id", "base_currency", "quote_currency", "rate", "rate_date",
                                      "rate_type", "source", "manual_override", "created_at")}


# -------------------------------------------------------------------
# H3: Account Balances
# -------------------------------------------------------------------

@router.get("/reports/account-balances", response_model=WebAccountBalancesResponse)
def account_balances() -> WebAccountBalancesResponse:
    """Return all account balances from Firefly, grouped by type and currency.

    report-web 账户页需要按业务分组筛选；这里仅增加 group/group_title/
    include_net_worth/account_role 字段，不改变既有字段含义与顺序。
    """
    base = settings.base_currency.upper()
    if base != "CNY":
        raise HTTPException(
            status_code=503,
            detail="Account balance valuation requires BASE_CURRENCY=CNY.",
        )
    if not settings.has_firefly_credentials:
        raise HTTPException(status_code=503, detail="Firefly not configured.")

    from finance_bridge.app.account_groups import get_account_groups
    from finance_bridge.app.firefly.client import FireflyClient

    try:
        with FireflyClient(settings) as client:
            all_accounts = client.get_account_balances(
                account_types=["asset", "liabilities", "expense", "revenue"],
                # 账户页需展示全部账户（含 include_net_worth=false 的迁移清算，
                # 以便前端按该字段展示/隐藏），故不传 include_net_worth_only。
            )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch balances: {e}")

    as_of = business_today()
    repository = FXRateRepository()
    group_config = get_account_groups()
    balances = []
    missing: set[str] = set()
    for acct in all_accounts:
        attrs = acct.get("attributes", {})
        account_id = str(acct.get("id", ""))
        group = group_config.group_for(account_id)
        balance = Decimal(str(attrs.get("current_balance", "0")))
        currency = str(attrs.get("currency_code") or base).upper()

        if balance == 0:
            balance_base = "0"
            fx_rate_date = as_of if currency == base else None
            fx_source = "fixed" if currency == base else None
        else:
            rate_info = repository.effective_rate(currency, as_of)
            if rate_info is None:
                balance_base = None
                missing.add(currency)
                fx_rate_date = None
                fx_source = None
            else:
                balance_base = decimal_text(balance * Decimal(str(rate_info["rate"])))
                fx_rate_date = str(rate_info["rate_date"])
                fx_source = str(rate_info["source"])

        balances.append({
            "id": account_id,
            "name": attrs.get("name", "unknown"),
            "type": attrs.get("type", "unknown"),
            "currency": currency,
            "balance": decimal_text(balance),
            "balance_base": balance_base,
            "active": attrs.get("active", True),
            "account_role": attrs.get("account_role"),
            "include_net_worth": bool(attrs.get("include_net_worth", True)),
            "group": group.key if group else None,
            "group_title": group.title if group else None,
            "fx_rate_date": fx_rate_date,
            "fx_source": fx_source,
        })

    return WebAccountBalancesResponse(
        base_currency=base,
        as_of=as_of,
        fx_complete=not missing,
        missing_currencies=sorted(missing),
        accounts=sorted(balances, key=lambda a: (a["type"], a["name"])),
    )


@router.get("/reports/recent-drafts")
def recent_drafts(limit: int = 20) -> dict[str, Any]:
    """List recent drafts for review."""
    recent = drafts.list_recent(min(limit, 100))
    return {"drafts": recent}


@router.get("/reports/health-check")
def health_check() -> dict[str, Any]:
    """月度健康检查工具（F1 核心版）."""
    from finance_bridge.app.reporting.tools import compute_health_check
    return compute_health_check()


@router.get("/reports/currency-exposure")
def currency_exposure(
    as_of: str | None = Query(None, description="Valuation date YYYY-MM-DD（默认 Europe/Berlin 今天）"),
) -> dict[str, Any]:
    """多币种敞口工具（F2）."""
    from finance_bridge.app.reporting.tools import compute_currency_exposure
    val_date = _valuation_date(as_of) if as_of else None
    return compute_currency_exposure(val_date)


@router.get("/reports/fx-attribution")
def fx_attribution(
    from_date: str | None = Query(None, description="Period start YYYY-MM-DD（默认最早 FX 汇率日）"),
    to_date: str | None = Query(None, description="Period end YYYY-MM-DD（默认 Europe/Berlin 今天）"),
) -> dict[str, Any]:
    """FX 贡献拆解 — 净资产变动分解为储蓄贡献与汇率贡献（只读）."""
    from finance_bridge.app.reporting.fx_attribution import compute_fx_attribution
    try:
        return compute_fx_attribution(from_date=from_date, to_date=to_date)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/reports/spending-trends")
def spending_trends(
    months: int = Query(6, ge=1, le=24, description="Comparison window in months"),
    as_of: str | None = Query(None, description="As-of date YYYY-MM-DD（默认 Europe/Berlin 今天）"),
) -> dict[str, Any]:
    """支出趋势工具（F5）— v2：MTD 同期对比 + 交易日汇率折算 CNY。"""
    if not settings.has_firefly_credentials:
        raise HTTPException(status_code=503, detail="Firefly not configured.")
    if as_of:
        try:
            datetime.strptime(as_of, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=422, detail="as_of must be YYYY-MM-DD")
    from finance_bridge.app.reporting.tools import compute_spending_trends
    return compute_spending_trends(months=months, as_of=as_of)
