"""Hermes stdio MCP adapter for the Finance Bridge REST API.

This process holds only the Bridge internal token. Firefly credentials remain
inside the Bridge container and are never exposed to Hermes or the model.
"""
from __future__ import annotations

import os
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://127.0.0.1:18711").rstrip("/")
BRIDGE_TOKEN = os.environ.get("BRIDGE_INTERNAL_TOKEN", "")

mcp = FastMCP("personal_finance")


def _request(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    if not BRIDGE_TOKEN:
        raise RuntimeError("BRIDGE_INTERNAL_TOKEN is not configured")
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    headers.setdefault("Content-Type", "application/json")
    with httpx.Client(base_url=BRIDGE_URL, headers=headers, timeout=30.0) as client:
        response = client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()


@mcp.tool()
def finance_list_accounts() -> dict[str, Any]:
    """List configured account aliases and currencies."""
    return _request("GET", "/v1/accounts")


@mcp.tool()
def finance_find_account_candidates(
    query: str,
    account_types: list[str] | None = None,
    currency: str | None = None,
    limit: int = 10,
) -> dict[str, Any]:
    """(READ ONLY) Search existing active aliases; never creates or chooses one.

    Returned aliases are the only strings eligible for a later draft. If more
    than one plausible candidate remains, ask the user instead of selecting.
    """
    params: dict[str, Any] = {"query": query, "limit": min(max(limit, 1), 20)}
    if account_types:
        params["account_types"] = account_types
    if currency:
        params["currency"] = currency
    return _request("GET", "/v1/accounts/candidates", params=params)


@mcp.tool()
def finance_create_draft(
    source_message_id: str,
    occurred_at: str,
    amount: str,
    currency: str,
    transaction_intent: str,
    source_account_alias: str,
    destination_account_alias: str,
    description: str | None = None,
    merchant: str | None = None,
    confidence: float | None = None,
) -> dict[str, Any]:
    """Create a transaction draft; this never posts to Firefly."""
    payload = {
        "channel": "hermes-feishu",
        "source_message_id": source_message_id,
        "occurred_at": occurred_at,
        "amount": amount,
        "currency": currency,
        "transaction_intent": transaction_intent,
        "source_account_alias": source_account_alias,
        "destination_account_alias": destination_account_alias,
        "description": description,
        "merchant": merchant,
        "confidence": confidence,
    }
    return _request("POST", "/v1/drafts", json=payload)


@mcp.tool()
def finance_get_draft(draft_id: int) -> dict[str, Any]:
    """Read one transaction draft."""
    return _request("GET", f"/v1/drafts/{draft_id}")


@mcp.tool()
def finance_amend_draft(
    draft_id: int,
    amount: str | None = None,
    occurred_at: str | None = None,
    currency: str | None = None,
    source_account_alias: str | None = None,
    destination_account_alias: str | None = None,
    description: str | None = None,
    merchant: str | None = None,
) -> dict[str, Any]:
    """Amend a draft before confirmation."""
    payload = {
        key: value
        for key, value in {
            "amount": amount,
            "occurred_at": occurred_at,
            "currency": currency,
            "source_account_alias": source_account_alias,
            "destination_account_alias": destination_account_alias,
            "description": description,
            "merchant": merchant,
        }.items()
        if value is not None
    }
    return _request("PATCH", f"/v1/drafts/{draft_id}", json=payload)


@mcp.tool()
def finance_cancel_draft(draft_id: int) -> dict[str, Any]:
    """Cancel a draft without touching Firefly."""
    return _request("POST", f"/v1/drafts/{draft_id}/cancel")


@mcp.tool()
def finance_confirm_draft(draft_id: int) -> dict[str, Any]:
    """Post a ready draft to Firefly after explicit user confirmation."""
    return _request("POST", f"/v1/drafts/{draft_id}/confirm")


@mcp.tool()
def finance_get_recent_drafts(limit: int = 20) -> dict[str, Any]:
    """List recent drafts for review."""
    return _request("GET", "/v1/reports/recent-drafts", params={"limit": min(limit, 100)})


@mcp.tool()
def finance_get_fx_status(as_of: str | None = None) -> dict[str, Any]:
    """Read required currencies, effective rate dates, sources and missing FX."""
    params = {"as_of": as_of} if as_of else None
    return _request("GET", "/v1/fx/status", params=params)


@mcp.tool()
def finance_refresh_fx_rates(as_of: str | None = None) -> dict[str, Any]:
    """Write ECB market-rate metadata only; it never changes Firefly transactions."""
    params = {"as_of": as_of} if as_of else None
    return _request("POST", "/v1/fx/refresh", params=params)


@mcp.tool()
def finance_set_manual_fx_rate(
    currency: str, rate_to_cny: str, rate_date: str, reason: str,
) -> dict[str, Any]:
    """Write one audited manual CNY rate override; a reason is mandatory."""
    return _request("POST", "/v1/fx/manual", json={
        "currency": currency, "rate_to_cny": rate_to_cny,
        "rate_date": rate_date, "reason": reason,
    })


# ---------------------------------------------------------------------------
# H3: Read-only report tools — no Firefly writes, no Firefly token exposure
# ---------------------------------------------------------------------------


@mcp.tool()
def finance_get_account_balances() -> dict[str, Any]:
    """(READ ONLY) Get real account balances from Firefly, grouped by type and currency.

    Proxy through Bridge — never calls Firefly directly.
    Returns asset, liability, expense, and revenue balances.
    """
    return _request("GET", "/v1/reports/account-balances")


# ---------------------------------------------------------------------------
# v1 unified read-only reports (只读报表 v1) — balance sheet / income
# statement / expense breakdown. MCP only proxies to Bridge and never
# recomputes amounts; Hermes must render the returned `presentation` verbatim.
# ---------------------------------------------------------------------------


@mcp.tool()
def finance_get_balance_sheet(as_of: str | None = None) -> dict[str, Any]:
    """(READ ONLY) 个人资产负债快照 — assets, liabilities, net worth.

    Args:
        as_of: Optional balance date YYYY-MM-DD (defaults to today). The
            date controls the real historical balances via Firefly's
            date parameter, not only the FX date.

    Uses closing-rate FX. When any non-zero currency lacks a rate,
    fx_complete=false and CNY totals are null — never a fake 1:1 sum.
    The response carries a Feishu-ready `presentation` block that must
    be displayed verbatim. Proxy through Bridge — never calls Firefly directly.
    """
    params = {"as_of": as_of} if as_of else None
    return _request("GET", "/v1/reports/balance-sheet", params=params)


@mcp.tool()
def finance_get_income_statement(
    start_date: str,
    end_date: str,
    accounting_view: str = "management",
) -> dict[str, Any]:
    """(READ ONLY) 期间收支表 — income, expenses, net result, savings rate.

    Args:
        start_date: Start date YYYY-MM-DD
        end_date: End date YYYY-MM-DD
        accounting_view: 'management' (default; excludes migration and
            adjustments, refunds reduce expenses) or 'native' (raw
            Firefly reconciliation view).

    Uses transaction-date FX. Missing FX for non-zero foreign journals
    fails closed (null CNY totals, per-currency figures kept).
    The response carries a Feishu-ready `presentation` block that must
    be displayed verbatim. Proxy through Bridge — never calls Firefly directly.
    """
    return _request("GET", "/v1/reports/income-statement", params={
        "start_date": start_date, "end_date": end_date,
        "accounting_view": accounting_view,
    })


@mcp.tool()
def finance_get_expense_breakdown(
    start_date: str,
    end_date: str,
    compare_start_date: str | None = None,
    compare_end_date: str | None = None,
    top_n: int = 10,
) -> dict[str, Any]:
    """(READ ONLY) 费用分析表 — Top N expenses with optional comparison.

    Args:
        start_date: Start date YYYY-MM-DD
        end_date: End date YYYY-MM-DD
        compare_start_date: Optional comparison period start YYYY-MM-DD
        compare_end_date: Optional comparison period end YYYY-MM-DD
        top_n: Number of top categories (1-20, default 10)

    Returns per category: current amount, comparison amount, change,
    change rate (null + new_spend=true when comparison is zero), share
    of current expenses and count. Never emits Infinity or NaN.
    The response carries a Feishu-ready `presentation` block that must
    be displayed verbatim. Proxy through Bridge — never calls Firefly directly.
    """
    params: dict[str, Any] = {
        "start_date": start_date, "end_date": end_date,
        "top_n": max(1, min(top_n, 20)),
    }
    if compare_start_date and compare_end_date:
        params["compare_start_date"] = compare_start_date
        params["compare_end_date"] = compare_end_date
    return _request("GET", "/v1/reports/expense-breakdown", params=params)


@mcp.tool()
def finance_get_health_check() -> dict[str, Any]:
    """(READ ONLY) 月度健康检查 — freshness, draft backlog, duplicate detection, negative balance accounts, backup status, FX rate-library freshness (fx_freshness).

    检查项与 `compute_health_check` 的 `checks` 键一一对应。容器健康由部署层
    负责，本端点不含 container 检查（见 `app/reporting/anomaly_detection.py`）。
    """
    return _request("GET", "/v1/reports/health-check")


@mcp.tool()
def finance_get_currency_exposure(as_of: str | None = None) -> dict[str, Any]:
    """(READ ONLY) 多币种敞口 — account balances grouped by currency with CNY conversion and net worth percentages.

    Args:
        as_of: Optional valuation date YYYY-MM-DD.
    """
    params = {"as_of": as_of} if as_of else None
    return _request("GET", "/v1/reports/currency-exposure", params=params)


@mcp.tool()
def finance_get_spending_trends(
    months: int = 6,
    as_of: str | None = None,
) -> dict[str, Any]:
    """(READ ONLY) 支出趋势 — compare current month-to-date category expenses (1..as_of day) against the same-day historical average, converted to CNY at transaction-date FX. Anomaly threshold: >100% deviation and >=500 CNY absolute diff over a >=3 month window.

    Args:
        months: Comparison window in months (default 6).
        as_of: Optional as-of date YYYY-MM-DD (defaults to Europe/Berlin today).
    """
    params = {"months": months}
    if as_of:
        params["as_of"] = as_of
    return _request("GET", "/v1/reports/spending-trends", params=params)


@mcp.tool()
def finance_get_fx_attribution(
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict[str, Any]:
    """(READ ONLY) 净资产 FX 贡献拆解（历史区间）— 将净资产变动分解为储蓄贡献与汇率贡献。

    Args:
        from_date: Period start YYYY-MM-DD (default: earliest FX record).
        to_date: Period end YYYY-MM-DD (default: today).

    For each non-CNY currency: savings = balance change valued at the end
    rate; fx = unchanged balance revalued between start/end rates;
    savings + fx == net change (exact identity). Currencies without ECB
    historical rates (e.g. TWD) are skipped and listed in notes.
    """
    params = {}
    if from_date:
        params["from_date"] = from_date
    if to_date:
        params["to_date"] = to_date
    return _request("GET", "/v1/reports/fx-attribution", params=params)


if __name__ == "__main__":
    mcp.run()
