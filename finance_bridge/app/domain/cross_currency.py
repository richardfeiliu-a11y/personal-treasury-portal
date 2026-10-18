"""Deterministic cross-currency rules for transaction drafts.

The model may describe a transaction, but this module decides whether the
Bridge has enough auditable data to create a cross-currency draft.
"""
from __future__ import annotations

from collections.abc import Callable
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

FINANCIAL_TYPES = {"asset", "liability"}


class CrossCurrencyValidationError(ValueError):
    """Raised when a cross-currency draft lacks an authoritative amount."""


def _money(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP), "f")


def resolve_cross_currency(
    *,
    amount: Decimal,
    currency: str,
    intent: str,
    source_account: dict[str, Any],
    destination_account: dict[str, Any],
    base_currency: str,
    occurred_at: str,
    settlement_amount: str | None,
    settlement_currency: str | None,
    explicit_fx_rate: str | None,
    rate_lookup: Callable[[str], dict[str, Any] | None],
) -> dict[str, str | None]:
    """Return fields using the latest effective stored rate at draft creation.

    This is an explicit accounting policy: every cross-currency posting uses
    the newest stored effective rate, independent of the transaction date.
    Any caller-supplied settlement amount or rate is deliberately not used to
    preserve one consistent, auditable rule.
    """
    currency = currency.upper()
    base_currency = base_currency.upper()
    src_type = source_account["account_type"].lower()
    dst_type = destination_account["account_type"].lower()
    src_currency = source_account["currency"].upper()
    dst_currency = destination_account["currency"].upper()

    financial_account = None
    if src_type in FINANCIAL_TYPES:
        financial_account = source_account
    elif dst_type in FINANCIAL_TYPES:
        financial_account = destination_account

    if financial_account and currency != financial_account["currency"].upper():
        raise CrossCurrencyValidationError(
            f"Transaction currency {currency} conflicts with financial account "
            f"currency {financial_account['currency']}. Ask for the actual charged/received currency."
        )

    if intent == "transfer" and src_type in FINANCIAL_TYPES and dst_type in FINANCIAL_TYPES:
        if src_currency == dst_currency:
            if currency != src_currency:
                raise CrossCurrencyValidationError(
                    f"Transfer currency {currency} conflicts with both account currency {src_currency}."
                )
            return _empty_fx()
        if currency != src_currency:
            raise CrossCurrencyValidationError(
                f"Transfer amount must use source account currency {src_currency}, not {currency}."
            )
        return _latest_conversion(amount, currency, dst_currency, rate_lookup)

    # Expense/income/refund: category currency is not a currency conflict.
    if currency == base_currency:
        return _empty_fx()

    return _latest_conversion(amount, currency, base_currency, rate_lookup)


def _latest_conversion(
    amount: Decimal,
    source_currency: str,
    destination_currency: str,
    rate_lookup: Callable[[str], dict[str, Any] | None],
) -> dict[str, str | None]:
    """Convert source amount via CNY using the newest stored effective rates."""
    source_row = rate_lookup(source_currency)
    destination_row = rate_lookup(destination_currency)
    if not source_row or not destination_row:
        missing = source_currency if not source_row else destination_currency
        raise CrossCurrencyValidationError(
            f"No latest stored FX rate for {missing}; do not create a cross-currency draft."
        )
    try:
        effective_rate = Decimal(str(source_row["rate"])) / Decimal(str(destination_row["rate"]))
        converted = amount * effective_rate
    except Exception as exc:
        raise CrossCurrencyValidationError("Stored FX rate must be a positive decimal.") from exc
    if effective_rate <= 0 or converted <= 0:
        raise CrossCurrencyValidationError("Stored FX rate must be a positive decimal.")
    source_date = str(source_row.get("rate_date") or "unknown")
    destination_date = str(destination_row.get("rate_date") or "unknown")
    rate_dates = source_date if source_date == destination_date or destination_currency == "CNY" else f"{source_date}/{destination_date}"
    return {
        "foreign_amount": _money(converted),
        "foreign_currency": destination_currency,
        "fx_rate": format(effective_rate, "f"),
        "fx_rate_date": rate_dates,
        "fx_rate_source": "latest_stored_rate",
    }


def _empty_fx() -> dict[str, None]:
    return {
        "foreign_amount": None,
        "foreign_currency": None,
        "fx_rate": None,
        "fx_rate_date": None,
        "fx_rate_source": None,
    }
