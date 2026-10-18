"""Tests for Firefly mapper — H2 direction matrix and refund handling.

Test matrix:
| Source type | Dest type | Intent  | Firefly type | Ref |
|---|---|---|---|---|
| asset       | asset     | transfer | transfer     | id  |
| liability   | liability | transfer | transfer     | id  |
| asset       | liability | transfer | transfer     | id  |
| liability   | asset     | transfer | transfer     | id  |
| asset       | expense   | expense  | withdrawal   | id/name |
| liability   | expense   | expense  | withdrawal   | id/name |
| revenue     | asset     | income   | deposit      | name/id |
| expense     | asset     | refund   | deposit      | name/id |
| expense     | liability | refund   | deposit      | name/id |
"""
from __future__ import annotations

import pytest

from finance_bridge.app.firefly.mapper import map_to_firefly_payload


def _make_acct(alias, acct_type, currency="EUR", firefly_account_id=None):
    return {
        "alias": alias,
        "account_type": acct_type,
        "currency": currency,
        "firefly_account_id": firefly_account_id,
    }


class TestDirectionMatrix:
    """H2: Four account direction pairs for transfer intent."""

    def test_asset_to_asset_transfer(self):
        """asset→asset with transfer intent → Firefly type=transfer, both IDs."""
        draft = {"id": 1, "draft_version": 1, "transaction_intent": "transfer",
                 "occurred_at": "2026-07-16", "amount": "100.00", "currency": "EUR",
                 "source_account_alias": "Bank D", "destination_account_alias": "Bank E",
                 "description": "Move money"}
        src = _make_acct("Bank D", "asset", firefly_account_id=10)
        dst = _make_acct("Bank E", "asset", firefly_account_id=11)
        payload = map_to_firefly_payload(draft, src, dst)

        assert payload["type"] == "transfer"
        assert payload["source_id"] == "10"
        assert payload["destination_id"] == "11"
        assert "source_name" not in payload
        assert "destination_name" not in payload

    def test_liability_to_liability_transfer(self):
        """liability→liability with transfer → Firefly type=transfer, both IDs."""
        draft = {"id": 2, "draft_version": 1, "transaction_intent": "transfer",
                 "occurred_at": "2026-07-16", "amount": "200.00", "currency": "CNY",
                 "source_account_alias": "银行甲CNY", "destination_account_alias": "银行乙CNY",
                 "description": "Card transfer"}
        src = _make_acct("银行甲CNY", "liability", "CNY", firefly_account_id=90)
        dst = _make_acct("银行乙CNY", "liability", "CNY", firefly_account_id=55)
        payload = map_to_firefly_payload(draft, src, dst)

        assert payload["type"] == "transfer"
        assert payload["source_id"] == "90"
        assert payload["destination_id"] == "55"

    def test_asset_to_liability_transfer(self):
        """asset→liability → withdrawal, both IDs."""
        draft = {"id": 3, "draft_version": 1, "transaction_intent": "transfer",
                 "occurred_at": "2026-07-16", "amount": "500.00", "currency": "CNY",
                 "source_account_alias": "Demo EUR Bank", "destination_account_alias": "银行甲CNY",
                 "description": "Pay credit card"}
        src = _make_acct("Demo EUR Bank", "asset", "EUR", firefly_account_id=42)
        dst = _make_acct("银行甲CNY", "liability", "CNY", firefly_account_id=90)
        payload = map_to_firefly_payload(draft, src, dst)

        assert payload["type"] == "withdrawal"
        assert payload["source_id"] == "42"
        assert payload["destination_id"] == "90"

    def test_liability_to_asset_transfer(self):
        """liability→asset → deposit, both IDs."""
        draft = {"id": 4, "draft_version": 1, "transaction_intent": "transfer",
                 "occurred_at": "2026-07-16", "amount": "300.00", "currency": "EUR",
                 "source_account_alias": "Card A", "destination_account_alias": "Bank D",
                 "description": "Credit refund"}
        src = _make_acct("Card A", "liability", firefly_account_id=4)
        dst = _make_acct("Bank D", "asset", firefly_account_id=11)
        payload = map_to_firefly_payload(draft, src, dst)

        assert payload["type"] == "deposit"
        assert payload["source_id"] == "4"
        assert payload["destination_id"] == "11"


class TestExpenseIncome:
    """H2: expense and income with mixed account types."""

    def test_asset_to_expense(self):
        """asset→expense → withdrawal, source_id, dest_name."""
        draft = {"id": 10, "draft_version": 1, "transaction_intent": "expense",
                 "occurred_at": "2026-07-16", "amount": "45.00", "currency": "EUR",
                 "source_account_alias": "Bank D", "destination_account_alias": "食品酒水 > 正餐",
                 "description": "Lunch"}
        src = _make_acct("Bank D", "asset", firefly_account_id=11)
        dst = _make_acct("食品酒水 > 正餐", "expense", "CNY")
        payload = map_to_firefly_payload(draft, src, dst)

        assert payload["type"] == "withdrawal"
        assert payload["source_id"] == "11"
        assert "source_name" not in payload
        assert payload["destination_name"] == "食品酒水 > 正餐"
        assert "destination_id" not in payload

    def test_liability_to_expense(self):
        """liability→expense → withdrawal, source_id, dest_name."""
        draft = {"id": 11, "draft_version": 1, "transaction_intent": "expense",
                 "occurred_at": "2026-07-16", "amount": "30.00", "currency": "CNY",
                 "source_account_alias": "银行甲CNY", "destination_account_alias": "餐饮",
                 "description": "Dinner"}
        src = _make_acct("银行甲CNY", "liability", "CNY", firefly_account_id=90)
        dst = _make_acct("餐饮", "expense", "CNY")
        payload = map_to_firefly_payload(draft, src, dst)

        assert payload["type"] == "withdrawal"
        assert payload["source_id"] == "90"
        assert payload["destination_name"] == "餐饮"

    def test_revenue_to_asset_income(self):
        """revenue→asset → deposit, src_name, dest_id."""
        draft = {"id": 12, "draft_version": 1, "transaction_intent": "income",
                 "occurred_at": "2026-07-16", "amount": "3000.00", "currency": "CNY",
                 "source_account_alias": "工资收入", "destination_account_alias": "Bank D",
                 "description": "Salary"}
        src = _make_acct("工资收入", "revenue", "CNY")
        dst = _make_acct("Bank D", "asset", "EUR", firefly_account_id=11)
        payload = map_to_firefly_payload(draft, src, dst)

        assert payload["type"] == "deposit"
        assert payload["source_name"] == "工资收入"
        assert "source_id" not in payload
        assert payload["destination_id"] == "11"
        assert "destination_name" not in payload


class TestRefund:
    """H2: Refund must be treated as reversal, not income."""

    def test_refund_expense_to_asset(self):
        """expense→asset refund → deposit + refund tag + no source_id."""
        draft = {"id": 20, "draft_version": 1, "transaction_intent": "refund",
                 "occurred_at": "2026-07-16", "amount": "45.00", "currency": "EUR",
                 "source_account_alias": "退款", "destination_account_alias": "Bank D",
                 "description": "Store refund"}
        src = _make_acct("退款", "expense", "EUR")
        dst = _make_acct("Bank D", "asset", "EUR", firefly_account_id=11)
        payload = map_to_firefly_payload(draft, src, dst)

        assert payload["type"] == "deposit"
        # Expense source → use name (not id)
        assert payload["source_name"] == "退款"
        assert "source_id" not in payload
        # Asset destination → use id
        assert payload["destination_id"] == "11"
        assert "destination_name" not in payload
        # Must have refund tag
        assert "refund" in payload.get("tags", [])
        # Notes must mention refund/accounting
        assert "Accounting" in payload.get("notes", "")

    def test_refund_expense_to_liability(self):
        """expense→liability refund → deposit + refund tag."""
        draft = {"id": 21, "draft_version": 1, "transaction_intent": "refund",
                 "occurred_at": "2026-07-16", "amount": "100.00", "currency": "CNY",
                 "source_account_alias": "退款", "destination_account_alias": "银行甲CNY",
                 "description": "Card refund"}
        src = _make_acct("退款", "expense", "CNY")
        dst = _make_acct("银行甲CNY", "liability", "CNY", firefly_account_id=90)
        payload = map_to_firefly_payload(draft, src, dst)

        assert payload["type"] == "deposit"
        assert payload["source_name"] == "退款"
        assert payload["destination_id"] == "90"
        assert "refund" in payload.get("tags", [])


class TestFallback:
    """H2: Without account info, fall back to name-based refs."""

    def test_no_account_info(self):
        """Without account info objects, use name-only references."""
        draft = {"id": 30, "draft_version": 1, "transaction_intent": "expense",
                 "occurred_at": "2026-07-16", "amount": "50.00", "currency": "EUR",
                 "source_account_alias": "Bank", "destination_account_alias": "Food"}
        payload = map_to_firefly_payload(draft)

        assert payload["external_id"] == "bridge-draft-30-v1"
        assert payload["source_name"] == "Bank"
        assert payload["destination_name"] == "Food"
        assert "source_id" not in payload
        assert "destination_id" not in payload

    def test_merchant_in_notes(self):
        draft = {"id": 31, "draft_version": 1, "transaction_intent": "expense",
                 "occurred_at": "2026-07-16", "amount": "30.00", "currency": "EUR",
                 "source_account_alias": "Bank", "destination_account_alias": "Food",
                 "merchant": "Starbucks"}
        payload = map_to_firefly_payload(draft)
        assert "Starbucks" in payload["notes"]

    def test_confidence_in_notes(self):
        draft = {"id": 32, "draft_version": 1, "transaction_intent": "expense",
                 "occurred_at": "2026-07-16", "amount": "30.00", "currency": "EUR",
                 "source_account_alias": "Bank", "destination_account_alias": "Food",
                 "confidence": 0.85}
        payload = map_to_firefly_payload(draft)
        assert "85%" in payload["notes"]

