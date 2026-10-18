"""Task 4.1 tests: FX attribution (savings vs FX contribution)."""
from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest

from finance_bridge.app.reporting import fx_attribution
from finance_bridge.app.state import init_storage, close_storage
from finance_bridge.app.storage.fx_rates import FXRateRepository


@pytest.fixture(autouse=True)
def _storage(tmp_path):
    init_storage(f"sqlite:///{tmp_path}/fx_attr.db")
    repo = FXRateRepository()
    repo.upsert_market("EUR", "7.2000", "2023-01-01", source="ECB")
    repo.upsert_market("EUR", "7.7500", "2024-01-01", source="ECB")
    repo.upsert_market("CNY", "1.0000", "2023-01-01", source="ECB")
    repo.upsert_market("CNY", "1.0000", "2024-01-01", source="ECB")
    yield
    close_storage()


def _accounts_variant(date: str) -> list[dict]:
    if date == "2023-01-01":
        return [
            {"attributes": {"type": "asset", "name": "EUR账", "currency_code": "EUR", "current_balance": "1000"}},
            {"attributes": {"type": "liability", "name": "信用卡", "currency_code": "CNY", "current_balance": "-500"}},
            {"attributes": {"type": "asset", "name": "TWD账", "currency_code": "TWD", "current_balance": "100"}},
            # 中间开户：期初不存在 → balance null → 按 0
            {"attributes": {"type": "asset", "name": "USD账", "currency_code": "USD", "current_balance": None}},
        ]
    return [
        {"attributes": {"type": "asset", "name": "EUR账", "currency_code": "EUR", "current_balance": "2000"}},
        {"attributes": {"type": "liability", "name": "信用卡", "currency_code": "CNY", "current_balance": "-300"}},
        {"attributes": {"type": "asset", "name": "TWD账", "currency_code": "TWD", "current_balance": "100"}},
        {"attributes": {"type": "asset", "name": "USD账", "currency_code": "USD", "current_balance": "500"}},
    ]


class _FakeClient:
    def __init__(self, settings):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get_account_balances(self, account_types, date=None, include_net_worth_only=False):
        accounts = _accounts_variant(date)
        if include_net_worth_only:
            accounts = [
                a for a in accounts
                if bool((a.get("attributes") or {}).get("include_net_worth", True))
            ]
        return accounts


def _patch(monkeypatch):
    monkeypatch.setattr(fx_attribution, "settings", SimpleNamespace(has_firefly_credentials=True))
    monkeypatch.setattr(fx_attribution, "FireflyClient", _FakeClient)


def test_identity_savings_plus_fx_equals_net_change(monkeypatch):
    _patch(monkeypatch)
    out = fx_attribution.compute_fx_attribution(from_date="2023-01-01", to_date="2024-01-01")
    assert out["period"] == {"from": "2023-01-01", "to": "2024-01-01"}
    currencies = {c["currency"] for c in out["by_currency"]}
    # USD 无历史汇率（中间开户且无汇率数据）→ 与 TWD 一样被跳过
    assert currencies == {"EUR", "CNY"}

    for c in out["by_currency"]:
        savings = Decimal(str(c["savings_contribution_cny"]))
        fx = Decimal(str(c["fx_contribution_cny"]))
        net = Decimal(str(c["net_change_cny"]))
        assert abs(savings + fx - net) < Decimal("0.02"), c

    # EUR: savings=(2000-1000)*7.75=7750; fx=1000*(7.75-7.2)=550; net=8300
    eur = next(c for c in out["by_currency"] if c["currency"] == "EUR")
    assert eur["savings_contribution_cny"] == "7750.00"
    assert eur["fx_contribution_cny"] == "550.00"
    assert eur["net_change_cny"] == "8300.00"

    # CNY: no FX contribution, savings == balance change
    cny = next(c for c in out["by_currency"] if c["currency"] == "CNY")
    assert cny["fx_contribution_cny"] == "0.00"
    assert cny["savings_contribution_cny"] == "200.00"  # -300 - (-500)

    # TWD/USD: no ECB historical rates -> excluded with note
    assert "TWD" not in currencies
    assert any("TWD" in n for n in out["notes"])
    assert any("USD" in n for n in out["notes"])


def test_totals_and_percentage(monkeypatch):
    _patch(monkeypatch)
    out = fx_attribution.compute_fx_attribution(from_date="2023-01-01", to_date="2024-01-01")
    total = Decimal(str(out["total_net_worth_change_cny"]))
    savings = Decimal(str(out["total_savings_contribution_cny"]))
    fx = Decimal(str(out["total_fx_contribution_cny"]))
    assert abs(savings + fx - total) < Decimal("0.05")
    assert out["fx_contribution_percentage"] > 0


def test_invalid_dates(monkeypatch):
    _patch(monkeypatch)
    with pytest.raises(ValueError):
        fx_attribution.compute_fx_attribution(from_date="2024-01-01", to_date="2023-01-01")
    with pytest.raises(ValueError):
        fx_attribution.compute_fx_attribution(from_date="not-a-date")


def test_defaults_to_earliest_fx_date(monkeypatch):
    _patch(monkeypatch)
    out = fx_attribution.compute_fx_attribution()
    assert out["period"]["from"] == "2023-01-01"
