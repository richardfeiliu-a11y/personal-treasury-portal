"""Unified report contract models (schema_version 1.0).

Every v1 report shares the same top-level envelope so Hermes and the
Feishu presenter can treat reports uniformly. Amounts are strings
produced from Decimal; incomplete data must never yield a fake total.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0"

ReportType = Literal["balance_sheet", "income_statement", "expense_breakdown"]
AccountingView = Literal["native", "management"]
FXMethod = Literal["closing_rate", "transaction_date"]


def new_report_id(report_type: str) -> str:
    """Opaque tracking ID — carries no user or account information."""
    return f"{report_type}-{uuid.uuid4().hex[:12]}"


def generated_now() -> str:
    """Timezone-aware ISO 8601 generation timestamp (UTC)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def decimal_text(value: Decimal) -> str:
    """Plain (non-scientific) text for a Decimal amount."""
    return format(value.normalize(), "f") if value != 0 else "0"


def quantize_2(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def format_amount(value: Decimal, currency: str) -> str:
    """Pre-formatted display amount, e.g. '1,234.56 CNY'."""
    q = quantize_2(value)
    return f"{q:,.2f} {currency}"


def format_pct(value: Decimal) -> str:
    """Pre-formatted percentage with 1 decimal, e.g. '12.3%'."""
    return f"{value.quantize(Decimal('0.1'), rounding=ROUND_HALF_UP)}%"


class ReportSectionRow(BaseModel):
    """One computed row inside a section (machine-readable)."""
    label: str
    currency: str
    amount: str                     # original-currency amount (Decimal text)
    amount_base: str | None = None  # CNY-converted amount, None when FX missing
    count: int | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class ReportSection(BaseModel):
    """A logical block of the report (assets, liabilities, income, ...)."""
    key: str
    title: str
    rows: list[ReportSectionRow] = Field(default_factory=list)
    subtotal_base: str | None = None


class Presentation(BaseModel):
    """Feishu-ready display payload. All amounts pre-formatted by Bridge.

    Hermes must copy these fields verbatim into send_feishu_card /
    send_feishu_table and must not recompute or reformat anything.
    """
    title: str
    template: str = "blue"
    summary_markdown: str = ""
    table_headers: list[str] = Field(default_factory=list)
    table_rows: list[list[str]] = Field(default_factory=list)
    footer_markdown: str = ""


class ReportEnvelope(BaseModel):
    """Common top-level contract for all v1 read-only reports."""
    schema_version: str = SCHEMA_VERSION
    report_id: str
    report_type: ReportType
    source: Literal["firefly_live"] = "firefly_live"
    generated_at: str = Field(default_factory=generated_now)
    base_currency: str = "CNY"
    balance_as_of: str | None = None
    period: dict[str, str] | None = None
    accounting_view: AccountingView = "management"
    fx_method: FXMethod = "closing_rate"
    fx_complete: bool = True
    data_complete: bool = True
    warnings: list[str] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    sections: list[ReportSection] = Field(default_factory=list)
    presentation: Presentation
