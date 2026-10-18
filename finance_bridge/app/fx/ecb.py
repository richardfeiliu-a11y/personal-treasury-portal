"""ECB reference-rate provider.

The ECB CSV expresses each quote as ``1 EUR = N quote currency``.  This
module exposes the Finance Bridge convention instead: ``1 currency = X CNY``.
No rate is invented when the ECB feed is unavailable or lacks a currency.

Only the *default* reference date is resolved here, and it delegates to
``reporting.tools.business_today()`` (Europe/Berlin) so the fetch window and
the report valuation date can never land on different calendar days.  The
import direction is cycle-free: nothing under ``app/reporting`` imports
``app.fx``.

AUD-28 (2026-09-22)：汇率抓取改为**逐币种独立**解析。原实现要求所有请求币种
落在同一个「共同参考日」上，任一币种缺数据即抛错并放弃整批 —— 生产实测
（2026-09-22）因此把已成功取到的 USD/GBP/HKD 等一同丢弃，写了 0 条。现在每个
币种各自在「该币种与 CNY 都能取到的最近日期」上三角换算，成功的照常返回，失败
的记入 ``failed_currencies``，由调用方决定部分写入与告警。**估值 fail-closed
语义不变**：没有汇率的币种仍然缺率，绝不 1:1 伪造。
"""
from __future__ import annotations

import csv
import io
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

import httpx
from finance_bridge.app.reporting.tools import business_today

ECB_SDMX_URL = "https://data-api.ecb.europa.eu/service/data/EXR"


class ECBProviderError(RuntimeError):
    """The official ECB feed could not provide a safe rate."""


@dataclass(frozen=True)
class ECBRateSet:
    """一次抓取的结果。

    ``rate_date``/``rates_to_cny`` 保持既有语义（供既有调用方与测试使用）；
    ``rate_dates`` 与 ``failed_currencies`` 为 AUD-28 新增的逐币种上下文：
    每个成功币种实际使用的参考日，以及失败币种的原因（不参与估值，只用于
    如实上报与部分写入）。
    """

    rate_date: str
    rates_to_cny: dict[str, Decimal]
    rate_dates: dict[str, str] = field(default_factory=dict)
    failed_currencies: dict[str, str] = field(default_factory=dict)


class ECBProvider:
    """Fetch official ECB CSV data without credentials."""

    def __init__(self, client: httpx.Client | None = None, url: str = ECB_SDMX_URL):
        self._client = client
        self._url = url

    def get_rates_to_cny(
        self, currencies: Iterable[str], as_of: str | date | None = None
    ) -> ECBRateSet:
        """逐币种解析参考汇率（AUD-28：部分成功，不再全有全无）。

        - CNY 是本仓的锚定币种（``1 quote = rate CNY``）：它取不到就无法三角换算，
          属**真正的整体失败**，保持 fail-closed 抛错，绝不返回伪造汇率。
        - 其余币种各自独立解析：成功的进入 ``rates_to_cny``/``rate_dates``，
          失败的进入 ``failed_currencies``（附原因），**不影响**其他币种。
        - 若除 CNY 外无一成功，说明这轮没有任何可写汇率 → 抛整体错误，
          由调用方按失败处理。
        """
        requested = {currency.upper() for currency in currencies}
        requested.discard("")
        # 缺省参考日 = Berlin 业务日（DATA-02 收口）；显式 as_of 原样透传。
        target = _parse_date(as_of) if as_of else _parse_date(business_today())

        cny_series = self._series("CNY", target)

        rates: dict[str, Decimal] = {"CNY": Decimal(1)}
        rate_dates: dict[str, str] = {"CNY": max(cny_series)}
        failed: dict[str, str] = {}

        for currency in sorted(requested - {"CNY"}):
            try:
                rate, used_date = self._triangulate(currency, target, cny_series)
            except ECBProviderError as exc:
                # AUD-28：单币种失败只记录，不中断整批。
                failed[currency] = str(exc)
                continue
            rates[currency] = rate
            rate_dates[currency] = used_date

        if len(rates) == 1 and failed:
            raise ECBProviderError(
                "ECB provided no usable rate for any requested currency: "
                + "; ".join(f"{c}: {why}" for c, why in sorted(failed.items()))
            )

        return ECBRateSet(
            rate_date=max(rate_dates.values()),
            rates_to_cny=rates,
            rate_dates=rate_dates,
            failed_currencies=failed,
        )

    def _triangulate(
        self, currency: str, target: date, cny_series: dict[str, Decimal]
    ) -> tuple[Decimal, str]:
        """在「该币种与 CNY 都能取到的最近日期」上三角换算。

        两腿取同一日期，保证 ``1 currency = cny[date] / currency[date]`` 内部自洽
        （而不是把不同日期的两条腿相除）。
        """
        if currency == "EUR":
            # EUR 的合成序列覆盖 target 前 22 天，故取 CNY 的最新可用日即可；
            # 1 EUR = X CNY 直接取自 CNY 序列。
            actual = max(cny_series)
            return cny_series[actual].quantize(Decimal("0.000000000001")), actual

        series = self._series(currency, target)
        common = sorted(set(series) & set(cny_series))
        if not common:
            raise ECBProviderError(
                f"ECB has no common reference date on or before {target.isoformat()}"
            )
        actual = common[-1]
        rate = (cny_series[actual] / series[actual]).quantize(Decimal("0.000000000001"))
        return rate, actual

    def _series(self, currency: str, target: date) -> dict[str, Decimal]:
        if currency == "EUR":
            return {(target - timedelta(days=offset)).isoformat(): Decimal(1) for offset in range(22)}
        params = {"startPeriod": (target - timedelta(days=21)).isoformat(),
                  "endPeriod": target.isoformat(), "format": "csvdata"}
        try:
            client = self._client or httpx.Client(timeout=httpx.Timeout(20.0, connect=10.0))
            response = client.get(f"{self._url}/D.{currency}.EUR.SP00.A", params=params)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ECBProviderError(f"ECB does not support or cannot fetch {currency}") from exc
        finally:
            if self._client is None and 'client' in locals():
                client.close()
        values: dict[str, Decimal] = {}
        for row in csv.DictReader(io.StringIO(response.text)):
            try:
                value = Decimal(row["OBS_VALUE"])
                observed = datetime.strptime(row["TIME_PERIOD"], "%Y-%m-%d").date()
            except (KeyError, InvalidOperation, ValueError):
                continue
            if value > 0 and observed <= target:
                values[observed.isoformat()] = value
        if not values:
            raise ECBProviderError(f"ECB does not support or has no usable quote for {currency}")
        return values


def _parse_date(value: str | date) -> date:
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ECBProviderError("as_of must be YYYY-MM-DD") from exc
