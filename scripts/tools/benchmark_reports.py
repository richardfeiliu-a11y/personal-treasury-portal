#!/usr/bin/env python3
"""报表性能基准（进程内 fake，不访问网络/生产环境）。

用法：
    python scripts/tools/benchmark_reports.py            # 紧凑表格
    python scripts/tools/benchmark_reports.py --json     # JSON 到 stdout

所有基准都使用内存假对象（fake/mock），只测量计算与调度开销，
不触发任何真实 API、数据库或网络调用。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import time
import typing
from collections.abc import Callable
from dataclasses import asdict, dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from finance_bridge.app.domain.transaction_ledger import build_ledger_rows
from finance_bridge.app.reporting import tools as reporting_tools
from finance_bridge.app.reporting.income_statement import compute_income_statement
from finance_bridge.app.reporting.net_worth_trend import (
    clear_trend_cache,
    get_net_worth_trend_cached,
)

# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BenchmarkResult:
    """单个基准的结果；counters 为整型逻辑计数（如快照调用次数）。"""

    name: str
    parameters: dict[str, Any]
    samples_ms: list[float]
    p50_ms: float
    p95_ms: float
    counters: dict[str, int]


def _percentile(values: list[float], pct: float) -> float:
    """最近秩分位数（样本量小时比线性插值更稳定）。"""
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, round(pct / 100 * (len(ordered) - 1))))
    return ordered[idx]


def _run_samples(
    name: str,
    parameters: dict[str, Any],
    fn: Callable[[], dict[str, int]],
    samples: int,
) -> BenchmarkResult:
    """fn() 返回本样本的计数器增量；计时只包住 fn 本身。"""
    timings: list[float] = []
    total_counters: dict[str, int] = {}
    for _ in range(samples):
        start = time.perf_counter()
        delta = fn()
        elapsed_ms = (time.perf_counter() - start) * 1000
        timings.append(elapsed_ms)
        for key, value in delta.items():
            total_counters[key] = total_counters.get(key, 0) + value
    return BenchmarkResult(
        name=name,
        parameters=parameters,
        samples_ms=[round(t, 3) for t in timings],
        p50_ms=round(_percentile(timings, 50), 3),
        p95_ms=round(_percentile(timings, 95), 3),
        counters=total_counters,
    )


# ---------------------------------------------------------------------------
# 共享 fakes
# ---------------------------------------------------------------------------


class FakeFXRepo:
    """假汇率仓库：CNY=1，其他币种固定汇率，可统计调用次数。"""

    RATES: typing.ClassVar[dict[str, Decimal]] = {
        "USD": Decimal("7.16"), "HKD": Decimal("0.92"), "EUR": Decimal("7.85"),
    }

    def __init__(self) -> None:
        self.effective_calls = 0
        self.historical_calls = 0

    def effective_rate(self, currency: str, as_of: str) -> dict[str, Any] | None:
        self.effective_calls += 1
        code = currency.upper()
        if code == "CNY":
            return {"currency": "CNY", "rate": "1", "rate_date": as_of}
        rate = self.RATES.get(code)
        return None if rate is None else {
            "currency": code, "rate": str(rate), "rate_date": as_of,
        }

    def historical_rate(self, currency: str, as_of: str) -> dict[str, Any] | None:
        # 台账口径用 historical_rate；这里与 effective 同源便于统一计数。
        self.historical_calls += 1
        return self.effective_rate(currency, as_of)


def _fake_account(currency: str = "USD", balance: str = "-12000.00") -> dict[str, Any]:
    return {
        "attributes": {
            "type": "asset",
            "currency_code": currency,
            "current_balance": balance,
            "include_net_worth": True,
        }
    }


def _synthetic_groups(n_groups: int) -> list[dict[str, Any]]:
    """n 组合成交易组：约 9 成 CNY 支出、1 成 USD 支出。"""
    groups: list[dict[str, Any]] = []
    for i in range(n_groups):
        foreign = i % 10 == 0
        journal = {
            "transaction_journal_id": str(i + 1),
            "type": "withdrawal",
            "amount": "25.40",
            "currency_code": "USD" if foreign else "CNY",
            "category_name": "Groceries",
            "source_name": "Checking",
            "destination_name": "Supermarket",
            "description": f"txn-{i}",
            "date": "2026-06-15T12:00:00+00:00",
            "tags": [],
        }
        groups.append({"attributes": {"transactions": [journal]}})
    return groups


# ---------------------------------------------------------------------------
# 各基准实现（每个函数返回一个样本的计数器增量）
# ---------------------------------------------------------------------------


def bench_net_worth_trend() -> dict[str, int]:
    """缓存清空后重算 12 个月趋势；计数器 = 逻辑快照(fetch_accounts)调用数。"""
    repo = FakeFXRepo()
    snapshot_calls = 0

    def fetch_accounts(point_date: str) -> list[dict[str, Any]]:
        nonlocal snapshot_calls
        snapshot_calls += 1
        return [
            _fake_account("USD", "-15000.00"),
            _fake_account("CNY", "80000.00"),
            _fake_account("HKD", "-5000.00"),
        ]

    clear_trend_cache()
    get_net_worth_trend_cached(
        as_of="2026-06-30", months=12, base_currency="CNY",
        fetch_accounts=fetch_accounts, repository=repo,
    )
    return {"logical_snapshot_calls": snapshot_calls}


class MockBalanceClient:
    """模拟 FireflyClient.get_account_balances 的异步客户端（每次 10ms）。"""

    def __init__(self) -> None:
        self.calls = 0

    async def get_account_balances(self) -> list[dict[str, Any]]:
        self.calls += 1
        await asyncio.sleep(0.01)
        return [_fake_account()]


def bench_report_route_concurrency() -> dict[str, int]:
    """单请求 vs 5 个并发请求(asyncio.gather)；计数器 = 并发加速比(x1000)。"""

    async def scenario() -> tuple[float, float]:
        client = MockBalanceClient()
        start = time.perf_counter()
        await client.get_account_balances()
        single_ms = time.perf_counter() - start

        start = time.perf_counter()
        await asyncio.gather(*(client.get_account_balances() for _ in range(5)))
        concurrent_ms = time.perf_counter() - start
        return single_ms, concurrent_ms

    single_s, concurrent_s = asyncio.run(scenario())
    ratio_x1000 = round(single_s / concurrent_s * 1000) if concurrent_s > 0 else 0
    return {"single_vs_concurrent_x1000": ratio_x1000}


def bench_spending_trends() -> dict[str, int]:
    """monkeypatch 报表工具模块的客户端/汇率仓库；计数器 = 逻辑区间拉取次数。"""
    range_fetches = 0

    class FakeSpendingClient:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        def __enter__(self) -> FakeSpendingClient:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def get_transactions_in_range(self, start: str, end: str) -> list[dict[str, Any]]:
            nonlocal range_fetches
            range_fetches += 1
            # 在请求区间内造一笔交易，保证各月都有数据。
            day = min(int(start[8:10]) + 2, 28)
            tx_date = f"{start[:8]}{day:02d}"
            return [{
                "attributes": {"created_at": tx_date, "transactions": [{
                    "type": "withdrawal", "amount": "18.90",
                    "currency_code": "CNY", "category_name": "Dining",
                    "date": tx_date,
                }]},
            }]

    original_client = reporting_tools.FireflyClient
    original_repo = reporting_tools.FXRateRepository
    reporting_tools.FireflyClient = FakeSpendingClient  # type: ignore[misc]
    reporting_tools.FXRateRepository = FakeFXRepo  # type: ignore[misc]
    try:
        reporting_tools.compute_spending_trends(months=6, as_of="2026-06-30")
    finally:
        reporting_tools.FireflyClient = original_client  # type: ignore[misc]
        reporting_tools.FXRateRepository = original_repo  # type: ignore[misc]
    # 当月 1 次 + 历史 6 次 = 7 次区间拉取
    return {"logical_range_fetches": range_fetches}


def _bench_income_statement(n_groups: int) -> dict[str, int]:
    groups = _synthetic_groups(n_groups)
    compute_income_statement(
        groups, "2026-01-01", "2026-12-31", "management", FakeFXRepo(),
    )
    return {"journal_count": n_groups}


def _bench_ledger_rows(n_groups: int) -> dict[str, int]:
    groups = _synthetic_groups(n_groups)
    repo = FakeFXRepo()
    rows = build_ledger_rows(groups, "CNY", repo)["rows"]
    if len(rows) != n_groups:
        raise RuntimeError(f"ledger row mismatch: {len(rows)} != {n_groups}")
    return {
        "row_count": len(rows),
        "fx_lookups": repo.effective_calls,
    }


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def run_benchmarks(samples: int = 7) -> list[BenchmarkResult]:
    if samples < 1:
        raise ValueError("samples must be at least 1")
    specs: list[tuple[str, dict[str, Any], Callable[[], dict[str, int]]]] = [
        ("net_worth_trend_12m", {"months": 12}, bench_net_worth_trend),
        ("report_route_concurrency", {"requests": 5}, bench_report_route_concurrency),
        ("spending_trends_6m", {"months": 6}, bench_spending_trends),
        ("income_statement_10000", {"groups": 10_000}, lambda: _bench_income_statement(10_000)),
        ("income_statement_50000", {"groups": 50_000}, lambda: _bench_income_statement(50_000)),
        ("ledger_10000", {"groups": 10_000}, lambda: _bench_ledger_rows(10_000)),
        ("ledger_50000", {"groups": 50_000}, lambda: _bench_ledger_rows(50_000)),
    ]
    return [
        _run_samples(name, params, fn, samples) for name, params, fn in specs
    ]


def _git_sha() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT,
            capture_output=True, text=True, timeout=10, check=False,
        ).stdout.strip()
    except Exception:
        return "unknown"


def _print_table(results: list[BenchmarkResult]) -> None:
    print(f"{'benchmark':<28} {'p50(ms)':>10} {'p95(ms)':>10}  counters")
    print("-" * 88)
    for r in results:
        counters = ", ".join(f"{k}={v}" for k, v in r.counters.items())
        print(f"{r.name:<28} {r.p50_ms:>10.2f} {r.p95_ms:>10.2f}  {counters}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="报表性能基准（进程内 fake）")
    parser.add_argument("--json", action="store_true", help="输出 JSON 到 stdout")
    parser.add_argument("--samples", type=int, default=7, help="每项采样次数（>=1）")
    args = parser.parse_args(argv)
    if args.samples < 1:
        parser.error("--samples 必须 >= 1")

    results = run_benchmarks(samples=args.samples)
    if args.json:
        payload = {
            "schema_version": 1,
            "git_sha": _git_sha(),
            "python_version": sys.version,
            "samples": args.samples,
            "results": [asdict(r) for r in results],
        }
        print(json.dumps(payload, ensure_ascii=False))
    else:
        _print_table(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
