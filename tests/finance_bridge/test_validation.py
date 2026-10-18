"""Unit tests for validation module."""
import pytest

from finance_bridge.app.domain.models import TransactionIntent
from finance_bridge.app.domain.validation import (
    validate_currency_pair,
    validate_transaction_accounts,
)


class TestValidateTransactionAccounts:
    def test_expense_with_asset_source(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.EXPENSE, "asset", "expense"
        )
        assert valid is True
        assert err is None

    def test_expense_with_liability_source(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.EXPENSE, "liability", "expense"
        )
        assert valid is True
        assert err is None

    def test_expense_with_revenue_source_fails(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.EXPENSE, "revenue", "expense"
        )
        assert valid is False
        assert "source" in err

    def test_expense_with_non_expense_destination_fails(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.EXPENSE, "asset", "asset"
        )
        assert valid is False
        assert "destination" in err

    def test_income_with_asset_destination(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.INCOME, "revenue", "asset"
        )
        assert valid is True
        assert err is None

    def test_income_with_expense_destination_fails(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.INCOME, "revenue", "expense"
        )
        assert valid is False
        assert "destination" in err

    def test_income_with_non_revenue_source_fails(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.INCOME, "asset", "asset"
        )
        assert valid is False
        assert "source" in err

    def test_transfer_between_assets(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.TRANSFER, "asset", "asset"
        )
        assert valid is True
        assert err is None

    def test_transfer_between_liabilities_is_allowed(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.TRANSFER, "liability", "liability"
        )
        assert valid is True
        assert err is None

    def test_transfer_between_asset_and_liability(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.TRANSFER, "asset", "liability"
        )
        assert valid is True
        assert err is None

    def test_refund_with_expense_source(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.REFUND, "expense", "asset"
        )
        assert valid is True
        assert err is None

    def test_refund_with_invalid_destination_fails(self):
        valid, err = validate_transaction_accounts(
            TransactionIntent.REFUND, "expense", "revenue"
        )
        assert valid is False
        assert "destination" in err


class TestValidateCurrencyPair:
    def test_same_currency_no_rate_ok(self):
        valid, err = validate_currency_pair("EUR", "EUR", None)
        assert valid is True
        assert err is None

    def test_same_currency_with_correct_rate_ok(self):
        valid, err = validate_currency_pair("EUR", "EUR", "1.0000")
        assert valid is True
        assert err is None

    def test_same_currency_with_wrong_rate_fails(self):
        valid, err = validate_currency_pair("EUR", "EUR", "0.85")
        assert valid is False
        assert "1.0" in err

    def test_different_currencies_ok(self):
        valid, err = validate_currency_pair("EUR", "USD", "1.08")
        assert valid is True
        assert err is None

