"""Unit tests for normalization module."""
import pytest
from decimal import Decimal

from finance_bridge.app.domain.normalization import (
    compute_normalized_hash,
    normalize_currency,
    normalize_date,
    normalize_decimal,
    normalize_description,
)


class TestNormalizeDecimal:
    def test_valid_amount(self):
        assert normalize_decimal("38.50") == Decimal("38.50")

    def test_integer_amount(self):
        assert normalize_decimal("100") == Decimal("100")

    def test_negative_amount_raises(self):
        with pytest.raises(ValueError, match="must be positive"):
            normalize_decimal("-10.00")

    def test_zero_amount_raises(self):
        with pytest.raises(ValueError, match="must be positive"):
            normalize_decimal("0")

    def test_invalid_amount_raises(self):
        with pytest.raises(ValueError):
            normalize_decimal("not-a-number")

    def test_empty_amount_raises(self):
        with pytest.raises(ValueError):
            normalize_decimal("")

    def test_comma_separated_amount(self):
        assert normalize_decimal("1,234.56") == Decimal("1234.56")

    def test_whitespace_stripped(self):
        assert normalize_decimal("  42.00  ") == Decimal("42.00")


class TestNormalizeDate:
    def test_valid_iso_date(self):
        d = normalize_date("2026-07-16")
        assert d.year == 2026
        assert d.month == 7
        assert d.day == 16

    def test_valid_european_date(self):
        d = normalize_date("16.07.2026")
        assert d.year == 2026
        assert d.month == 7
        assert d.day == 16

    def test_invalid_date_raises(self):
        with pytest.raises(ValueError, match="Cannot parse date"):
            normalize_date("not-a-date")

    def test_empty_date_raises(self):
        with pytest.raises(ValueError):
            normalize_date("")


class TestNormalizeCurrency:
    def test_valid_currency(self):
        assert normalize_currency("EUR") == "EUR"

    def test_lowercase_converted(self):
        assert normalize_currency("eur") == "EUR"

    def test_whitespace_stripped(self):
        assert normalize_currency("  USD  ") == "USD"

    def test_invalid_currency_raises(self):
        with pytest.raises(ValueError, match="3-letter ISO code"):
            normalize_currency("US")

    def test_numeric_raises(self):
        with pytest.raises(ValueError):
            normalize_currency("123")

    def test_mixed_case_normalized(self):
        """Mixed case should be normalized to uppercase."""
        assert normalize_currency("Eur") == "EUR"
        assert normalize_currency("eUr") == "EUR"


class TestNormalizeDescription:
    def test_valid_description(self):
        result = normalize_description("Lunch at restaurant")
        assert result == "Lunch at restaurant"

    def test_strips_whitespace(self):
        result = normalize_description("  Lunch  ")
        assert result == "Lunch"

    def test_empty_returns_none(self):
        assert normalize_description("") is None

    def test_none_returns_none(self):
        assert normalize_description(None) is None

    def test_whitespace_only_returns_none(self):
        assert normalize_description("   ") is None


class TestComputeNormalizedHash:
    def test_same_inputs_same_hash(self):
        h1 = compute_normalized_hash("2026-07-16", "38.50", "EUR", "Demo EUR Bank", "餐饮", "expense")
        h2 = compute_normalized_hash("2026-07-16", "38.50", "EUR", "Demo EUR Bank", "餐饮", "expense")
        assert h1 == h2

    def test_different_amounts_different_hash(self):
        h1 = compute_normalized_hash("2026-07-16", "38.50", "EUR", "Demo EUR Bank", "餐饮", "expense")
        h2 = compute_normalized_hash("2026-07-16", "38.51", "EUR", "Demo EUR Bank", "餐饮", "expense")
        assert h1 != h2

    def test_case_insensitive_account(self):
        h1 = compute_normalized_hash("2026-07-16", "38.50", "EUR", "Demo EUR Bank", "餐饮", "expense")
        h2 = compute_normalized_hash("2026-07-16", "38.50", "EUR", "demo eur bank", "餐饮", "expense")
        assert h1 == h2

    def test_hash_is_64_char_hex(self):
        h = compute_normalized_hash("2026-07-16", "38.50", "EUR", "Demo EUR Bank", "餐饮", "expense")
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)
