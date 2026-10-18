"""Validation rules for Finance Bridge.

Account/transaction intent validation for the confirm path.
（clarification 流与按账户名猜测类型的分类器从未接线，A07 消融删除。）
"""
from __future__ import annotations

from finance_bridge.app.domain.models import TransactionIntent


def validate_transaction_accounts(
    intent: TransactionIntent,
    source_type: str,
    dest_type: str,
) -> tuple[bool, str | None]:
    """Validate that source/destination account types match the transaction intent.

    Returns (is_valid, error_message).
    """
    # Expense: source must be asset, dest must be expense
    if intent == TransactionIntent.EXPENSE:
        if source_type not in ("asset", "liability"):
            return False, f"Expense source account must be asset/liability, got '{source_type}'"
        if dest_type != "expense":
            return False, f"Expense destination must be expense account, got '{dest_type}'"
        return True, None

    # Income: source must be revenue/expense, dest must be asset
    if intent == TransactionIntent.INCOME:
        if source_type != "revenue":
            return False, f"Income source account must be revenue, got '{source_type}'"
        if dest_type not in ("asset", "liability"):
            return False, f"Income destination must be asset/liability, got '{dest_type}'"
        return True, None

    # Transfer: both must be asset or liability
    if intent == TransactionIntent.TRANSFER:
        valid_types = ("asset", "liability")
        if source_type not in valid_types:
            return False, f"Transfer source must be asset/liability, got '{source_type}'"
        if dest_type not in valid_types:
            return False, f"Transfer destination must be asset/liability, got '{dest_type}'"
        return True, None

    # Refund: source must be expense, dest must be asset or liability
    if intent == TransactionIntent.REFUND:
        if source_type not in ("expense",):
            return False, f"Refund source must be expense, got '{source_type}'"
        if dest_type not in ("asset", "liability"):
            return False, f"Refund destination must be asset/liability, got '{dest_type}'"
        return True, None

    return False, f"Unknown transaction intent: {intent}"


def validate_currency_pair(base: str, quote: str, fx_rate: str | None = None) -> tuple[bool, str | None]:
    """Validate a currency pair and optional FX rate."""
    if base == quote and fx_rate is not None:
        try:
            rate = float(fx_rate)
            if abs(rate - 1.0) > 0.0001:
                return False, f"Same-currency transaction should have FX rate ~1.0, got {fx_rate}"
        except ValueError:
            return False, f"Invalid FX rate format: {fx_rate}"
    return True, None
