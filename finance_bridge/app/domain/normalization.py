"""Normalization utilities for Finance Bridge.

Converts raw LLM output and user input into canonical internal format.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

# Regex patterns
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
AMOUNT_RE = re.compile(r"^[+-]?\d+(?:\.\d+)?$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def normalize_decimal(value: str) -> Decimal:
    """Normalize a string to Decimal, handling common formats."""
    if not value or not isinstance(value, str):
        raise ValueError("Amount must be a non-empty string")

    cleaned = value.strip().replace(",", "").replace(" ", "")
    if not cleaned:
        raise ValueError("Amount string is empty after cleaning")

    try:
        d = Decimal(cleaned)
    except InvalidOperation:
        raise ValueError(f"Cannot parse '{value}' as decimal")

    if d <= 0:
        raise ValueError(f"Amount must be positive, got {d}")

    return d


def normalize_date(value: str) -> date:
    """Normalize a date string to date object."""
    if not value or not isinstance(value, str):
        raise ValueError("Date must be a non-empty string")

    value = value.strip()

    # Try ISO format first
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        pass

    # Try common European format DD.MM.YYYY
    try:
        return datetime.strptime(value, "%d.%m.%Y").date()
    except ValueError:
        pass

    raise ValueError(f"Cannot parse date '{value}'. Expected YYYY-MM-DD or DD.MM.YYYY")


def normalize_currency(value: str) -> str:
    """Normalize currency to uppercase 3-letter ISO code."""
    if not value or not isinstance(value, str):
        raise ValueError("Currency must be a non-empty string")

    currency = value.strip().upper()

    if not CURRENCY_RE.match(currency):
        raise ValueError(f"Invalid currency code '{value}'. Expected 3-letter ISO code.")

    return currency


def normalize_description(value: str | None) -> str | None:
    """Normalize description: strip whitespace, truncate if needed."""
    if not value:
        return None

    desc = value.strip()
    if not desc:
        return None

    # Truncate to reasonable length
    if len(desc) > 500:
        desc = desc[:497] + "..."

    return desc


def compute_normalized_hash(
    occurred_at: str,
    amount: str,
    currency: str,
    source_account: str,
    destination_account: str,
    transaction_intent: str,
) -> str:
    """Compute a hash for duplicate detection.

    This hash is computed from the normalized/canonical transaction data,
    not the raw input, so equivalent transactions produce the same hash.
    """
    import hashlib

    components = "|".join([
        occurred_at,
        str(Decimal(amount)),
        currency.upper(),
        source_account.strip().lower(),
        destination_account.strip().lower(),
        transaction_intent.lower().strip(),
    ])

    return hashlib.sha256(components.encode()).hexdigest()
