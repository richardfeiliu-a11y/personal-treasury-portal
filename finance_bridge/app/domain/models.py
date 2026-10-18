"""Pydantic domain models for Finance Bridge.

H3: NetWorthSummary now includes fx_complete, missing_currencies,
per-currency breakdowns, and nullable totals when FX is incomplete.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TransactionIntent(str, Enum):
    """Transaction type intent from LLM or user input."""
    EXPENSE = "expense"
    INCOME = "income"
    TRANSFER = "transfer"
    REFUND = "refund"


class DraftStatus(str, Enum):
    """Draft lifecycle states."""
    RECEIVED = "received"
    NORMALIZED = "normalized"
    NEEDS_CLARIFICATION = "needs_clarification"
    READY_FOR_CONFIRMATION = "ready_for_confirmation"
    CONFIRMING = "confirming"
    CONFIRMED = "confirmed"
    POSTING = "posting"
    POSTED = "posted"
    POSTING_UNKNOWN = "posting_unknown"
    POSTING_FAILED = "posting_failed"
    CANCELLED = "cancelled"


class CreateDraftRequest(BaseModel):
    """Request to create a transaction draft."""
    model_config = ConfigDict(str_strip_whitespace=True)

    channel: str = Field(..., description="Source channel: feishu, manual, api")
    source_message_id: str = Field(..., description="Opaque message/request ID for dedup")
    attachment_sha256: str | None = Field(None, description="SHA-256 of attachment if any")
    occurred_at: str = Field(..., description="Transaction date YYYY-MM-DD")
    amount: str = Field(..., description="Amount as string Decimal")
    currency: str = Field(..., description="ISO 4217 currency code")
    transaction_intent: TransactionIntent = Field(..., description="Type of transaction")
    source_account_alias: str = Field(..., description="Source account alias")
    destination_account_alias: str = Field(..., description="Destination account or category")
    description: str | None = Field(None, description="Human-readable description")
    merchant: str | None = Field(None, description="Merchant name")
    fx_rate: str | None = Field(None, description="FX rate to base currency")
    settlement_amount: str | None = Field(None, description="Actual amount received by the destination account")
    settlement_currency: str | None = Field(None, description="Currency of the actual received amount")
    confidence: float | None = Field(None, ge=0.0, le=1.0, description="LLM confidence 0-1")
    # 历史说明：`tags` 曾在此声明但从不落库（草稿表无该列），接口回显空数组，
    # 属「收下即弃」契约。2026-10-16 从契约移除。交易标签仍由 Firefly 侧维护，
    # 见 firefly/mapper.py（refund）与 reporting/income_statement.py（分类标签）。

    @field_validator("occurred_at")
    @classmethod
    def validate_date(cls, v: str) -> str:
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError("occurred_at must be YYYY-MM-DD")
        return v

    @field_validator("currency")
    @classmethod
    def validate_currency(cls, v: str) -> str:
        if len(v) != 3 or not v.isalpha() or not v.isupper():
            raise ValueError("currency must be 3-letter ISO 4217 code (e.g. EUR)")
        return v

    @field_validator("amount")
    @classmethod
    def validate_amount(cls, v: str) -> str:
        try:
            d = Decimal(v)
            if d <= 0:
                raise ValueError("amount must be positive")
        except Exception:
            raise ValueError("amount must be a valid positive decimal string")
        return v

    @field_validator("fx_rate")
    @classmethod
    def validate_fx_rate(cls, v: str | None) -> str | None:
        if v is not None:
            try:
                d = Decimal(v)
                if d <= 0:
                    raise ValueError("fx_rate must be positive")
            except Exception:
                raise ValueError("fx_rate must be a valid positive decimal string")
        return v


class AmendDraftRequest(BaseModel):
    """Request to amend a draft before confirmation."""
    description: str | None = None
    amount: str | None = None
    currency: str | None = None
    occurred_at: str | None = None
    source_account_alias: str | None = None
    destination_account_alias: str | None = None
    merchant: str | None = None
    fx_rate: str | None = None
    settlement_amount: str | None = None
    settlement_currency: str | None = None


class DraftResponse(BaseModel):
    """Draft data returned by API (may be masked)."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: DraftStatus
    transaction_intent: TransactionIntent
    occurred_at: str
    amount: str
    currency: str
    source_account_alias: str
    destination_account_alias: str
    description: str | None = None
    merchant: str | None = None
    fx_rate: str | None = None
    foreign_amount: str | None = None
    foreign_currency: str | None = None
    fx_rate_date: str | None = None
    fx_rate_source: str | None = None
    confidence: float | None = None
    draft_version: int
    firefly_transaction_id: str | None = None
    is_duplicate: bool = False
    clarification_message: str | None = None
    created_at: datetime
    updated_at: datetime








