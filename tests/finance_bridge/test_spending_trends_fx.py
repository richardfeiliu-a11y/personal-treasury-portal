"""Tests for Spending Trends v2: multi-currency FX conversion and MTD same-day-of-month logic."""
from decimal import Decimal
from unittest.mock import MagicMock, patch
import pytest

from finance_bridge.app.config import settings as cfg_settings
from finance_bridge.app.reporting.tools import clear_spending_trends_cache, compute_spending_trends


def _clear_caches():
    clear_spending_trends_cache()


@pytest.fixture(autouse=True)
def _pin_cny_base_currency():
    """v2 契约以 CNY 为本位币。

    test_reports_endpoints 的 autouse fixture 会把 settings.base_currency 泄漏为
    EUR 且不恢复，导致本文件在完整套件中顺序依赖。此处显式钉住并恢复。
    """
    original = cfg_settings.base_currency
    cfg_settings.base_currency = "CNY"
    yield
    cfg_settings.base_currency = original


def test_spending_trends_converts_multi_currency_to_cny():
    """Verify withdrawal transactions in foreign currency are converted to CNY using effective_rate."""
    _clear_caches()
    mock_txns_current = [
        {"attributes": {"transactions": [
            {"type": "withdrawal", "category_name": "餐饮", "amount": "100.00", "currency_code": "EUR", "date": "2026-08-05"}
        ]}},
        {"attributes": {"transactions": [
            {"type": "withdrawal", "category_name": "餐饮", "amount": "500.00", "currency_code": "CNY", "date": "2026-08-10"}
        ]}},
    ]
    mock_txns_past = [
        {"attributes": {"transactions": [
            {"type": "withdrawal", "category_name": "餐饮", "amount": "100.00", "currency_code": "EUR", "date": "2026-07-05"}
        ]}}
    ]

    with patch("finance_bridge.app.reporting.tools.FireflyClient") as mock_client_cls, \
         patch("finance_bridge.app.reporting.tools.FXRateRepository") as mock_repo_cls:
        
        mock_client = MagicMock()
        mock_client_cls.return_value.__enter__.return_value = mock_client
        mock_client.get_transactions_in_range.return_value = mock_txns_current + mock_txns_past

        mock_repo = MagicMock()
        mock_repo_cls.return_value = mock_repo
        # Rate EUR -> CNY = 7.85
        mock_repo.effective_rate.side_effect = lambda curr, dt: {"rate": "7.85"} if curr == "EUR" else None

        result = compute_spending_trends(months=1, as_of="2026-08-16")

        assert result["as_of"] == "2026-08-16"
        assert result["base_currency"] == "CNY"
        assert result["fx_complete"] is True
        assert len(result["trends"]) == 1
        
        trend = result["trends"][0]
        assert trend["category"] == "餐饮"
        # 100 EUR * 7.85 + 500 CNY = 785 + 500 = 1285.00
        assert trend["current_month_amount"] == "1285.00"
        # Past: 100 EUR * 7.85 = 785.00
        assert trend["historical_monthly_average"] == "785.00"
        assert trend["fx_complete"] is True


def test_spending_trends_missing_fx_yields_null():

    """Verify that if any non-zero transaction lacks FX rate, the category amounts become null and fx_complete is False."""
    _clear_caches()
    mock_txns_current = [
        {"attributes": {"transactions": [
            {"type": "withdrawal", "category_name": "旅行", "amount": "200.00", "currency_code": "USD", "date": "2026-08-05"}
        ]}}
    ]

    with patch("finance_bridge.app.reporting.tools.FireflyClient") as mock_client_cls, \
         patch("finance_bridge.app.reporting.tools.FXRateRepository") as mock_repo_cls:
        
        mock_client = MagicMock()
        mock_client_cls.return_value.__enter__.return_value = mock_client
        mock_client.get_transactions_in_range.side_effect = [mock_txns_current, []]

        mock_repo = MagicMock()
        mock_repo_cls.return_value = mock_repo
        mock_repo.effective_rate.return_value = None  # Missing USD rate

        result = compute_spending_trends(months=1, as_of="2026-08-16")

        assert result["fx_complete"] is False
        assert "USD" in result["missing_currencies"]
        trend = result["trends"][0]
        assert trend["fx_complete"] is False
        assert trend["current_month_amount"] is None
        assert trend["deviation_percentage"] is None
        assert trend["anomaly"] is False


def test_spending_trends_mtd_boundary_handling():

    """Verify that on month-end date (e.g. 2026-03-31, DOM=31), historical queries clamp to month last day (e.g. Feb 28, Apr 30)."""
    _clear_caches()
    with patch("finance_bridge.app.reporting.tools.FireflyClient") as mock_client_cls, \
         patch("finance_bridge.app.reporting.tools.FXRateRepository") as mock_repo_cls:
        
        mock_client = MagicMock()
        mock_client_cls.return_value.__enter__.return_value = mock_client
        mock_client.get_transactions_in_range.return_value = []
        mock_repo = MagicMock()
        mock_repo_cls.return_value = mock_repo

        result = compute_spending_trends(months=2, as_of="2026-03-31")

        # Single covering range: earliest historical window start ~ as_of
        calls = mock_client.get_transactions_in_range.call_args_list
        assert len(calls) == 1
        assert calls[0][0] == ("2026-01-01", "2026-03-31")
