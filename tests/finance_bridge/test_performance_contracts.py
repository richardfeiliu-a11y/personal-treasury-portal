"""Performance contract tests for scripts/tools/benchmark_reports.py.

通过 subprocess 运行基准脚本，校验其 JSON 输出结构符合契约：
顶层字段 schema_version/git_sha/samples/results，每个 result 包含
name/parameters/p50_ms/p95_ms/counters。
"""

import json
import subprocess
import sys

EXPECTED_NAMES = {
    "net_worth_trend_12m",
    "report_route_concurrency",
    "spending_trends_6m",
    "income_statement_10000",
    "income_statement_50000",
    "ledger_10000",
    "ledger_50000",
}

EXPECTED_RESULT_KEYS = {"name", "parameters", "p50_ms", "p95_ms", "counters"}


def test_benchmark_reports_json_contract():
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/tools/benchmark_reports.py",
            "--json",
            "--samples",
            "1",
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == 0, (
        f"benchmark script failed (exit {proc.returncode})\n"
        f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
    )

    payload = json.loads(proc.stdout)
    assert payload["schema_version"] == 1
    assert isinstance(payload["git_sha"], str)
    assert payload["samples"] == 1

    results = payload["results"]
    assert isinstance(results, list)
    names = {r["name"] for r in results}
    assert names == EXPECTED_NAMES

    for r in results:
        missing = EXPECTED_RESULT_KEYS - set(r.keys())
        assert not missing, f"result {r.get('name')} missing keys: {missing}"


class TestBlockingRouteBoundary:
    """Sync-I/O report routes must run in FastAPI threadpool (not async)."""

    def test_blocking_report_routes_are_sync_functions(self):
        import inspect

        from fastapi.routing import APIRoute

        from finance_bridge.app.main import app

        import inspect as _inspect

        all_routes = {}
        for route in app.routes:
            if isinstance(route, APIRoute):
                all_routes[route.path] = route
            elif type(route).__name__ == "_IncludedRouter":
                for sub in getattr(route.original_router, "routes", []):
                    if isinstance(sub, APIRoute):
                        prefix = getattr(route, "path", "") or ""
                        all_routes[prefix + sub.path] = sub
        routes = all_routes
        blocking_paths = {
            "/reports/personal-balance-sheet",
            "/reports/net-worth-trend",
            "/reports/income-statement",
            "/reports/web/spending-trends",
            "/reports/web/transactions",
            "/reports/web/anomalies",
        }
        assert blocking_paths <= routes.keys(), (
            f"missing routes: {blocking_paths - set(routes.keys())}"
        )
        for path in blocking_paths:
            endpoint = routes[path].endpoint
            assert not inspect.iscoroutinefunction(endpoint), (
                f"{path} must be sync def (threadpool), not async def"
            )


class TestTTLFlightCache:
    """TTLFlightCache: single-flight + TTL behavior."""

    def test_same_key_is_computed_once_under_concurrency(self):
        import time
        from concurrent.futures import ThreadPoolExecutor

        from finance_bridge.app.reporting.cache import TTLFlightCache

        cache = TTLFlightCache(ttl_seconds=60)
        calls = 0

        def factory():
            nonlocal calls
            calls += 1
            time.sleep(0.05)
            return {"value": "ok"}

        with ThreadPoolExecutor(max_workers=5) as pool:
            results = list(pool.map(lambda _: cache.get_or_compute("same", factory), range(5)))

        assert calls == 1
        assert results == [{"value": "ok"}] * 5

    def test_exception_propagates_and_not_cached(self):
        from finance_bridge.app.reporting.cache import TTLFlightCache

        cache = TTLFlightCache(ttl_seconds=60)
        calls = 0

        def factory():
            nonlocal calls
            calls += 1
            raise RuntimeError("boom")

        for _ in range(2):
            try:
                cache.get_or_compute("k", factory)
            except RuntimeError:
                pass
            else:
                raise AssertionError("expected RuntimeError")

        assert calls == 2  # not cached; recomputed each time

    def test_ttl_expiry_recomputes(self):
        import time

        from finance_bridge.app.reporting.cache import TTLFlightCache

        cache = TTLFlightCache(ttl_seconds=0)
        calls = 0

        def factory():
            nonlocal calls
            calls += 1
            return calls

        first = cache.get_or_compute("k", factory)
        time.sleep(0.01)
        second = cache.get_or_compute("k", factory)

        assert first == 1
        assert second == 2


class TestSpendingTrendsSingleRead:
    """Spending trends must use one covering range read, not N+1."""

    def test_spending_trends_makes_single_range_call(self):
        from unittest.mock import MagicMock, patch

        import finance_bridge.app.reporting.tools as reporting_tools
        from finance_bridge.app.reporting.tools import clear_spending_trends_cache

        clear_spending_trends_cache()
        try:
            with patch.object(reporting_tools, "FireflyClient") as mock_client_cls, \
                 patch.object(reporting_tools, "FXRateRepository") as mock_repo_cls:
                mock_client = MagicMock()
                mock_client_cls.return_value.__enter__.return_value = mock_client
                mock_client.get_transactions_in_range.return_value = []
                mock_repo_cls.return_value = MagicMock()

                reporting_tools.compute_spending_trends(months=6, as_of="2026-08-23")

            assert mock_client.get_transactions_in_range.call_count == 1
            args = mock_client.get_transactions_in_range.call_args[0]
            assert args == ("2026-02-01", "2026-08-23")
        finally:
            clear_spending_trends_cache()


class TestLedgerFXMemoization:
    """Ledger FX lookups must be memoized per (currency, date) within one request."""

    def test_fx_lookup_is_memoized_per_currency_and_date(self):
        from unittest.mock import MagicMock, patch

        from finance_bridge.app.domain.transaction_ledger import build_ledger_rows

        groups = []
        for i in range(100):
            day = (i % 2) + 1  # only 2 unique dates
            groups.append({"attributes": {"transactions": [{
                "transaction_journal_id": str(i), "type": "withdrawal",
                "amount": "10.00", "currency_code": "EUR",
                "date": f"2026-08-{day:02d}",
                "source_type": "asset", "destination_type": "expense",
                "source_name": "Wallet", "destination_name": "Food",
                "category_name": "Test", "tags": [],
                "description": "test",
            }]}})

        repo = MagicMock()
        repo.historical_rate.return_value = {
            "rate": "7.85", "rate_date": "2026-08-01", "source": "ECB"
        }

        result = build_ledger_rows(groups, "CNY", repo)

        assert result["total"] == 100
        assert repo.historical_rate.call_count == 2  # 2 unique dates, not 100 rows


# ---------------------------------------------------------------------------
# WP10 任务 2：脱敏访问日志（route/status/duration/request_id）
# 硬边界：不记录完整 URL 参数、请求/响应正文、金额或凭据。
# ---------------------------------------------------------------------------

class TestSanitizedAccessLog:
    def test_access_log_has_required_fields_and_no_query_string(self, caplog, tmp_path):
        import logging

        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from finance_bridge.app.main import access_log_middleware

        app = FastAPI()

        @app.middleware("http")
        async def _mw(request, call_next):  # noqa: ANN001
            return await access_log_middleware(request, call_next)

        @app.get("/healthz")
        async def _healthz():  # noqa: ANN202
            return {"ok": True}

        with caplog.at_level(logging.INFO, logger="finance_bridge.access"):
            client = TestClient(app)
            resp = client.get("/healthz?internal_token=SECRET&q=amount-9999.99")
        assert resp.status_code == 200

        records = [r for r in caplog.records if r.name == "finance_bridge.access"]
        assert records, "access log middleware must emit a record"
        line = records[-1].getMessage()
        # 必含字段
        assert "route=/healthz" in line
        assert "status=200" in line
        assert "duration_ms=" in line
        assert "request_id=" in line
        # 硬边界：查询串与敏感值不得出现
        assert "SECRET" not in line
        assert "internal_token" not in line
        assert "amount-9999.99" not in line
        assert "?" not in line

    def test_request_id_format_is_uuid_like(self, caplog):
        import logging
        import re

        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from finance_bridge.app.main import access_log_middleware

        app = FastAPI()

        @app.middleware("http")
        async def _mw(request, call_next):  # noqa: ANN001
            return await access_log_middleware(request, call_next)

        @app.get("/ping")
        async def _ping():  # noqa: ANN202
            return {"ok": True}

        with caplog.at_level(logging.INFO, logger="finance_bridge.access"):
            TestClient(app).get("/ping")
        records = [r for r in caplog.records if r.name == "finance_bridge.access"]
        line = records[-1].getMessage()
        m = re.search(r"request_id=([0-9a-f-]+)", line)
        assert m and len(m.group(1)) == 36
