"""Refresh ECB FX rates, or safely preview the refresh with --dry-run."""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from decimal import Decimal

from finance_bridge.app.config import settings
from finance_bridge.app.firefly.client import FireflyClient
from finance_bridge.app.fx.ecb import ECBProvider, ECBProviderError
from finance_bridge.app.fx.service import refresh_ecb_rates
from finance_bridge.app.reporting.tools import business_today
from finance_bridge.app.state import get_storage, init_storage
from finance_bridge.app.storage.fx_rates import FXRateRepository
from finance_bridge.app.storage.job_runs import JobRunRepository


def _date(value: str | None) -> str:
    """缺省估值日 = Berlin 业务日（DATA-02 收口，原为 UTC 日）；显式入参仍校验格式。"""
    date_value = value or business_today()
    datetime.strptime(date_value, "%Y-%m-%d")
    return date_value


def current_balance_currencies() -> dict[str, Decimal]:
    if not settings.has_firefly_credentials:
        raise RuntimeError("Firefly is not configured")
    with FireflyClient(settings) as client:
        accounts = client.get_account_balances(
            ["asset", "liabilities"], include_net_worth_only=True)
    balances: dict[str, Decimal] = defaultdict(Decimal)
    for account in accounts:
        attrs = account.get("attributes", {})
        currency = (attrs.get("currency_code") or settings.base_currency).upper()
        balances[currency] += Decimal(attrs.get("current_balance", "0"))
    return dict(balances)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refresh official ECB CNY valuation rates")
    parser.add_argument("--as-of", help="Requested valuation date, YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and validate only; never write SQLite")
    args = parser.parse_args(argv)

    # Ensure storage is initialized even in standalone script run
    try:
        get_storage()
    except RuntimeError:
        init_storage()

    try:
        as_of = _date(args.as_of)
        balances = current_balance_currencies()
        all_non_cny = sorted(currency for currency in balances if currency != "CNY")
        non_cny = sorted(currency for currency in all_non_cny if balances[currency] != 0)
        provider = ECBProvider()
        covered: dict[str, str] = {"CNY": "1"}
        missing: list[str] = []
        actual_dates: set[str] = set()
        # Query one currency at a time so dry-run can report an unsupported
        # currency instead of losing the whole operational diagnosis.
        for currency in all_non_cny:
            try:
                rate_set = provider.get_rates_to_cny([currency], as_of)
                covered[currency] = str(rate_set.rates_to_cny[currency])
                actual_dates.add(rate_set.rate_date)
            except ECBProviderError:
                missing.append(currency)
        report = {
            "dry_run": args.dry_run, "base_currency": "CNY", "as_of": as_of,
            "nonzero_balance_currencies": sorted(c for c, total in balances.items() if total != 0),
            "zero_balance_currencies": sorted(c for c, total in balances.items() if total == 0),
            "ecb_rate_date": sorted(actual_dates),
            "ecb_covered_currencies": sorted(covered),
            "missing_currencies": missing, "would_write": len(non_cny),
            "cny_net_worth_possible": not any(balances.get(currency, Decimal(0)) != 0
                                                for currency in missing),
        }
        if args.dry_run:
            print(json.dumps(report, ensure_ascii=False, sort_keys=True))
            return 0

        # AUD-28：先尝试写入「取得到的」币种，再依据**非零余额**币种的失败情况
        # 决定退出码。原实现在此之前就 `return 1`，导致已成功取到的
        # USD/GBP/HKD 等一同被丢弃（生产 2026-09-22：written=0）。
        # 现在：部分写入 + 如实失败上报，两者同时成立。
        result = refresh_ecb_rates(non_cny, as_of, FXRateRepository(), ECBProvider())
        report.update(result)
        still_missing = sorted({c for c in result.get("failed_currencies", [])
                                if balances.get(c, Decimal(0)) != 0})
        report["failed_nonzero_balance_currencies"] = still_missing

        if still_missing:
            # 非零余额币种缺率是**实质**问题：数据照写，但任务按失败记录并退出非 0，
            # 让巡检/日报如实告警（不再像 09-22 那样静默）。
            err_msg = "ECB does not support: " + ", ".join(still_missing)
            JobRunRepository().record_failure("fx_rate_refresh", err_msg)
            print(json.dumps({**report, "success": False, "error": err_msg},
                             ensure_ascii=False, sort_keys=True), file=sys.stderr)
            return 1

        if not result["success"]:
            JobRunRepository().record_failure("fx_rate_refresh", str(result.get("error", "refresh failed")))
            print(json.dumps(report, ensure_ascii=False, sort_keys=True), file=sys.stderr)
            return 1

        JobRunRepository().record_success("fx_rate_refresh")
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return 0
    except (RuntimeError, ValueError, ECBProviderError) as exc:
        if not args.dry_run:
            try:
                JobRunRepository().record_failure("fx_rate_refresh", str(exc))
            except Exception:
                pass
        print(json.dumps({"dry_run": args.dry_run, "success": False, "error": str(exc)}, ensure_ascii=False),
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
