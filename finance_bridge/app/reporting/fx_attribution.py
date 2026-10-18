"""Task 4.1 — FX contribution attribution.

Decomposes the net worth change over a period into:
  - savings contribution: balance change valued at the end rate
  - FX contribution: unchanged balances revalued between start/end rates

Convention: savings + fx ≈ end_cny - start_cny (identity up to the
per-row 0.01 rounding applied to the reported values; unrounded math is
exact). Rates follow FX_CONVENTION.md: CNY base, ECB historical rates with
forward-fill of the most recent available rate (rate_type='historical').
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from typing import Any

from finance_bridge.app.config import settings
from finance_bridge.app.firefly.client import FireflyClient
from finance_bridge.app.reporting.tools import business_today
from finance_bridge.app.storage.fx_rates import FXRateRepository

logger = logging.getLogger(__name__)


def _parse_date(value: str, field: str) -> str:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"{field} must be YYYY-MM-DD")
    return value


def _balances_by_currency(accounts: list[dict[str, Any]]) -> dict[str, Decimal]:
    """Aggregate balances per currency (asset + liability, net worth semantics).

    Firefly stores liabilities as negative balances; net worth is the direct
    sum. Accounts that did not exist at the query date come back with a null
    balance and are treated as zero (opened mid-period).
    """
    out: dict[str, Decimal] = defaultdict(Decimal)
    for acct in accounts:
        attrs = acct.get("attributes") or {}
        atype = str(attrs.get("type") or "").lower()
        curr = (attrs.get("currency_code") or "CNY").upper()
        bal = attrs.get("current_balance")
        if bal is None:
            continue  # account did not exist at that date -> balance 0
        try:
            value = Decimal(str(bal))
        except Exception:
            logger.warning("Unparseable balance %r for account %s", bal, attrs.get("name"))
            continue
        if atype == "asset" or atype in ("liability", "liabilities"):
            out[curr] += value
    return out


def compute_fx_attribution(
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict[str, Any]:
    """Compute savings vs FX contribution to net worth change.

    Period defaults to the earliest stored FX date through the business
    today (`business_today()`, Europe/Berlin).
    """
    if not settings.has_firefly_credentials:
        raise RuntimeError("Firefly not configured")

    repo = FXRateRepository()
    earliest = repo.earliest_rate_date()
    # 只读一次钟：起止同时缺省时若各读一次，跨午夜会得到 start > end（下游报 422）
    today = business_today()
    start = _parse_date(from_date, "from_date") if from_date else (earliest or today)
    end = _parse_date(to_date, "to_date") if to_date else today
    if start > end:
        raise ValueError("from_date must be on or before to_date")

    with FireflyClient(settings) as client:
        accounts_start = client.get_account_balances(
            ["asset", "liabilities"], date=start, include_net_worth_only=True)
        accounts_end = client.get_account_balances(
            ["asset", "liabilities"], date=end, include_net_worth_only=True)

    bal_start = _balances_by_currency(accounts_start)
    bal_end = _balances_by_currency(accounts_end)

    notes: list[str] = []
    by_currency: list[dict[str, Any]] = []
    total_start_cny = Decimal(0)
    total_end_cny = Decimal(0)

    for curr in sorted(set(bal_start) | set(bal_end)):
        s_bal = bal_start.get(curr, Decimal(0))
        e_bal = bal_end.get(curr, Decimal(0))
        if s_bal == 0 and e_bal == 0:
            continue

        if curr == "CNY":
            s_rate = Decimal(1)
            e_rate = Decimal(1)
        else:
            s_info = repo.historical_rate(curr, start)
            e_info = repo.historical_rate(curr, end)
            if not s_info or not e_info:
                notes.append(f"{curr} excluded: no ECB historical rates available")
                continue
            s_rate = Decimal(str(s_info["rate"]))
            e_rate = Decimal(str(e_info["rate"]))

        start_cny = s_bal * s_rate
        end_cny = e_bal * e_rate
        savings = (e_bal - s_bal) * e_rate
        fx_contrib = s_bal * (e_rate - s_rate)
        net_change = end_cny - start_cny

        # Prevent Decimal("-0.00") formatting for zero values
        if savings == Decimal(0):
            savings = Decimal(0)
        if fx_contrib == Decimal(0):
            fx_contrib = Decimal(0)
        if net_change == Decimal(0):
            net_change = Decimal(0)

        total_start_cny += start_cny
        total_end_cny += end_cny

        by_currency.append({
            "currency": curr,
            "start_balance": str(s_bal.quantize(Decimal("0.01"))),
            "end_balance": str(e_bal.quantize(Decimal("0.01"))),
            "start_rate": float(s_rate),
            "end_rate": float(e_rate),
            "savings_contribution_cny": str(savings.quantize(Decimal("0.01"))),
            "fx_contribution_cny": str(fx_contrib.quantize(Decimal("0.01"))),
            "net_change_cny": str(net_change.quantize(Decimal("0.01"))),
        })

    total_change = total_end_cny - total_start_cny
    total_savings = sum((Decimal(str(c["savings_contribution_cny"])) for c in by_currency), Decimal(0))
    total_fx = sum((Decimal(str(c["fx_contribution_cny"])) for c in by_currency), Decimal(0))
    if total_change != 0:
        fx_pct = float((total_fx / total_change * Decimal(100)).quantize(Decimal("0.1")))
    else:
        fx_pct = 0.0

    return {
        "period": {"from": start, "to": end},
        "total_net_worth_change_cny": str(total_change.quantize(Decimal("0.01"))),
        "total_savings_contribution_cny": str(total_savings.quantize(Decimal("0.01"))),
        "total_fx_contribution_cny": str(total_fx.quantize(Decimal("0.01"))),
        "fx_contribution_percentage": fx_pct,
        "by_currency": by_currency,
        "notes": notes,
    }
