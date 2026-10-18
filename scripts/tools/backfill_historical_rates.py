#!/usr/bin/env python3
"""Backfill historical ECB exchange rates from 2021-10-01 to present into Bridge SQLite.

Calculates rates based on ECB EUR benchmark rates:
  X/CNY = X/EUR * EUR/CNY  (1 quote_currency = rate CNY)
Rates are saved to fx_rates with rate_type='historical'.
The default upper bound of the ECB window is ``business_today()``
(Europe/Berlin), i.e. the same source as the report valuation date.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import sys
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import httpx

from finance_bridge.app.reporting.tools import business_today
from finance_bridge.app.state import get_storage, init_storage
from finance_bridge.app.storage.fx_rates import FXRateRepository

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("backfill_historical_rates")

ECB_BASE_URL = "https://data-api.ecb.europa.eu/service/data/EXR"

TARGET_CURRENCIES = [
    "CNY", "GBP", "CHF", "HKD", "USD", "NOK", "DKK",
    "SEK", "CZK", "HUF", "TRY", "ISK", "MYR", "TWD", "SGD"
]


def fetch_ecb_series(currency: str, start_date: str = "2021-10-01", end_date: str | None = None) -> dict[str, Decimal]:
    if currency == "EUR":
        return {}
    # 缺省窗口上界 = Europe/Berlin 业务日 business_today()（DATA-02 收口，原为 UTC 日）；
    # 显式 end_date 原样透传。本脚本写入 fx_rates，上界与报表估值日必须同源。
    end = end_date or business_today()
    url = f"{ECB_BASE_URL}/D.{currency}.EUR.SP00.A"
    params = {"startPeriod": start_date, "endPeriod": end, "format": "csvdata"}

    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(url, params=params)
            if resp.status_code != 200:
                logger.warning("ECB API returned %s for %s", resp.status_code, currency)
                return {}
            text = resp.text
    except Exception as exc:
        logger.warning("Failed to fetch %s from ECB: %s", currency, exc)
        return {}

    values: dict[str, Decimal] = {}
    for row in csv.DictReader(io.StringIO(text)):
        try:
            val = Decimal(row["OBS_VALUE"])
            period = row["TIME_PERIOD"]
        except (KeyError, InvalidOperation, ValueError):
            continue
        if val > 0:
            values[period] = val
    return values


def main() -> int:
    try:
        get_storage()
    except RuntimeError:
        init_storage()

    start_date = "2021-10-01"
    # 上界与 ECB 抓取侧同源：Berlin 业务日（DATA-02 收口，原为 UTC 日）
    end_date = business_today()

    logger.info("Fetching ECB historical series for %d currencies (%s to %s)...",
                len(TARGET_CURRENCIES), start_date, end_date)

    series_data: dict[str, dict[str, Decimal]] = {}
    missing_currencies: list[str] = []

    # EUR is benchmark (1 EUR = 1 EUR)
    series_data["EUR"] = {}

    for curr in TARGET_CURRENCIES:
        if curr == "CNY":
            cny_series = fetch_ecb_series("CNY", start_date, end_date)
            if not cny_series:
                logger.error("Failed to fetch benchmark CNY series from ECB!")
                return 1
            series_data["CNY"] = cny_series
        else:
            s = fetch_ecb_series(curr, start_date, end_date)
            if s:
                series_data[curr] = s
            else:
                missing_currencies.append(curr)

    cny_dict = series_data["CNY"]
    trading_dates = sorted(cny_dict.keys())
    logger.info("Found %d trading dates for CNY from ECB", len(trading_dates))

    repo = FXRateRepository()
    storage = repo._storage()

    now_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    rows_to_insert: list[tuple[str, str, str, str, str, str, int, str]] = []

    for d in trading_dates:
        cny_per_eur = cny_dict[d]
        if cny_per_eur <= 0:
            continue

        # 1. EUR to CNY rate (1 EUR = cny_per_eur CNY)
        eur_rate = format(cny_per_eur.quantize(Decimal("0.000000000001")), "f")
        rows_to_insert.append(("CNY", "EUR", eur_rate, d, "historical", "ECB", 0, now_ts))

        # 2. Other currencies to CNY rate (1 quote_currency = (cny_per_eur / quote_per_eur) CNY)
        for curr, curr_dict in series_data.items():
            if curr in ("CNY", "EUR"):
                continue
            if d in curr_dict:
                quote_per_eur = curr_dict[d]
                if quote_per_eur > 0:
                    rate_val = cny_per_eur / quote_per_eur
                    rate_str = format(rate_val.quantize(Decimal("0.000000000001")), "f")
                    rows_to_insert.append(("CNY", curr, rate_str, d, "historical", "ECB", 0, now_ts))

    logger.info("Writing %d historical rate rows to SQLite...", len(rows_to_insert))

    with storage._connection() as conn:
        conn.executemany("""
            INSERT INTO fx_rates (base_currency, quote_currency, rate, rate_date, rate_type,
                                  source, manual_override, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(base_currency, quote_currency, rate_date, source) DO UPDATE SET
                rate=excluded.rate, rate_type='historical', manual_override=0,
                created_at=excluded.created_at
        """, rows_to_insert)
        conn.commit()

    del rows_to_insert

    # Verification checks
    sample_eur_cny = repo.historical_rate("EUR", "2023-06-15")
    sample_usd_cny = repo.historical_rate("USD", "2023-06-15")

    with storage._connection() as conn:
        count_hist = conn.execute("SELECT COUNT(*) FROM fx_rates WHERE rate_type='historical'").fetchone()[0]

    report = {
        "success": True,
        "total_historical_rows": count_hist,
        "missing_currencies": missing_currencies,
        "covered_currencies": sorted(series_data.keys()),
        "sample_2023_06_15_EUR_CNY": sample_eur_cny,
        "sample_2023_06_15_USD_CNY": sample_usd_cny,
    }

    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
