"""AUD-26 / AUD-28（2026-09-22 生产静默失败后补）—— 汇率刷新可观测性与部分成功。

背景（生产实测 2026-09-22）：
  fx-refresh 于 18:00 Berlin 启动，18:00:41 以 "ECB does not support:
  CHF, CZK, DKK, EUR, TWD" 失败并写 0 条；而 patrol 同为 18:00 触发、在
  18:00:04 读完 freshness，读到的是刷新**之前**的状态 → 当天判 OK。
  根因两处：①`ecb.get_rates_to_cny` 要求全币种共同参考日（一个坏币种毁整批）；
  ②refresh 脚本在写入**之前**就因"非零币种缺失"提前 return 1。

本文件锁定三个不变量：
  A. 部分成功：能取到的币种必须照写，失败的单独上报（AUD-28）。
  B. 作业状态是独立信号：库暂时"新"也必须能报出作业失败（AUD-26）。
  C. 逐币种停滞只针对非零余额币种；零余额币种长期停滞不算故障（AUD-26）。
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest

from finance_bridge.app.fx import ecb as ecb_mod
from finance_bridge.app.fx import service as fx_service
from finance_bridge.app.reporting import tools
from finance_bridge.app.state import close_storage, init_storage
from finance_bridge.app.storage.fx_rates import FXRateRepository
from finance_bridge.app.storage.job_runs import JobRunRepository

REF_TODAY = date(2026, 9, 21)


class _CsvResp:
    status_code = 200

    def __init__(self, text: str):
        self.text = text

    def raise_for_status(self):
        return None


class _PerCurrencyECB:
    """按币种返回不同覆盖度：可精确模拟 09-22 的 "部分币种取不到"。"""

    def __init__(self, available: dict[str, list[str]]):
        self.available = available
        self.calls: list[str] = []

    def get(self, url, params=None):
        # URL 形如 .../EXR/D.<CUR>.EUR.SP00.A —— 币种是 "D." 之后、".EUR." 之前那段
        currency = url.split("/D.", 1)[1].split(".", 1)[0]
        self.calls.append(currency)
        rows = ["TIME_PERIOD,OBS_VALUE"]
        for d in self.available.get(currency, []):
            rows.append(f"{d},1.0")
        return _CsvResp("\n".join(rows) + "\n")


# ---------------------------------------------------------------------------
# AUD-28 A：部分成功
# ---------------------------------------------------------------------------

class TestPartialSuccess:
    def test_one_bad_currency_does_not_discard_the_others(self):
        """EUR 取不到时，USD/GBP 仍应被换算出来并返回（不再整批失败）。"""
        client = _PerCurrencyECB({
            "CNY": ["2026-09-21"],
            "USD": ["2026-09-21"],
            "GBP": ["2026-09-21"],
            # EUR 缺数据（EUR 走合成序列，用 CNY 的日期，故这里改测一个真发请求的币种）
        })
        rate_set = ecb_mod.ECBProvider(client=client).get_rates_to_cny(
            ["USD", "GBP", "CHF"], "2026-09-21")

        assert set(rate_set.rates_to_cny) == {"CNY", "USD", "GBP"}
        assert "CHF" in rate_set.failed_currencies
        assert rate_set.rate_dates["USD"] == "2026-09-21"

    def test_cny_anchor_missing_is_total_failure(self):
        """CNY 是锚定币种：取不到就无法三角换算 → 必须整体失败，不伪造汇率。"""
        client = _PerCurrencyECB({"USD": ["2026-09-21"]})  # 无 CNY
        with pytest.raises(ecb_mod.ECBProviderError):
            ecb_mod.ECBProvider(client=client).get_rates_to_cny(["USD"], "2026-09-21")

    def test_all_currencies_failing_is_total_failure(self):
        client = _PerCurrencyECB({"CNY": ["2026-09-21"]})  # 只有锚，其余全空
        with pytest.raises(ecb_mod.ECBProviderError):
            ecb_mod.ECBProvider(client=client).get_rates_to_cny(["USD", "GBP"], "2026-09-21")


class TestServiceWritesPartialResults:
    def test_partial_write_reports_written_and_failed(self, tmp_path):
        init_storage(f"sqlite:///{tmp_path}/partial.db")
        try:
            client = _PerCurrencyECB({"CNY": ["2026-09-21"], "USD": ["2026-09-21"]})
            out = fx_service.refresh_ecb_rates(
                ["USD", "CHF"], "2026-09-21", FXRateRepository(),
                ecb_mod.ECBProvider(client=client))

            assert out["success"] is True          # 至少写了一条
            assert out["partial"] is True          # 成功与失败并存
            assert out["written"] == 1
            assert out["failed_currencies"] == ["CHF"]
            assert out["rate_date"] == "2026-09-21"
            # 成功的那个币种确实落库；失败的没有落库（fail-closed，不伪造）
            assert FXRateRepository().latest_rate_date_for("USD") == "2026-09-21"
            assert FXRateRepository().latest_rate_date_for("CHF") is None
        finally:
            close_storage()

    def test_missing_currency_never_written_as_one_to_one(self, tmp_path):
        """失败币种不得留下任何行 —— 缺率必须保持 fail-closed。"""
        init_storage(f"sqlite:///{tmp_path}/no-fake.db")
        try:
            client = _PerCurrencyECB({"CNY": ["2026-09-21"], "USD": ["2026-09-21"]})
            fx_service.refresh_ecb_rates(["USD", "CHF"], "2026-09-21", FXRateRepository(),
                                         ecb_mod.ECBProvider(client=client))
            repo = FXRateRepository()
            assert repo.effective_rate("CHF", "2026-09-21") is None
        finally:
            close_storage()


# ---------------------------------------------------------------------------
# AUD-26 C：必需币种停滞是**独立**检查项（不并入表级 fx_freshness）
# ---------------------------------------------------------------------------

class TestRequiredCurrencyStaleness:
    """AUD-26：单币种停滞在既有两套裁决下都不可见，需独立检查。

    刻意与表级 `fx_freshness` 分离：runbook「分工边界」明确该表级裁决不分币种，
    且 `test_health_fx_freshness.py` 有用例钉住该不变量。本检查项承担
    「参与估值的币种有没有跟上」这一正交问题。
    """

    @pytest.fixture(autouse=True)
    def _env(self, monkeypatch, tmp_path):
        init_storage(f"sqlite:///{tmp_path}/percur.db")
        monkeypatch.setattr(tools, "business_today", lambda now=None: REF_TODAY.isoformat())
        monkeypatch.setattr(tools, "task_status_projection", list)
        monkeypatch.setattr(tools.settings, "firefly_token", "t")
        monkeypatch.setattr(tools.settings, "firefly_api_url", "http://x/api/v1")
        JobRunRepository().record_success("backup")
        yield
        close_storage()

    def _check(self):
        return tools.compute_health_check()["checks"]["fx_required_currency_staleness"]

    def test_zero_balance_currency_stagnation_is_not_a_fault(self, monkeypatch):
        """生产实测：7 个零余额币种停滞 53 天属正常 —— 不得因此报警。"""
        monkeypatch.setattr(tools, "_nonzero_balance_currencies", lambda: {"CNY", "USD"})
        repo = FXRateRepository()
        repo.upsert_market("USD", "7.5", REF_TODAY.isoformat())
        repo.upsert_market("CHF", "8.1", (REF_TODAY - timedelta(days=53)).isoformat())

        check = self._check()
        assert check["status"] == "ok"
        assert "CHF" not in check["detail"]["per_currency"]

    def test_nonzero_balance_currency_stagnation_is_critical(self, monkeypatch):
        """持有非零余额的币种停滞 53 天 → critical（表级 MAX 会掩盖它）。"""
        monkeypatch.setattr(tools, "_nonzero_balance_currencies", lambda: {"CNY", "CHF"})
        repo = FXRateRepository()
        repo.upsert_market("USD", "7.5", REF_TODAY.isoformat())   # 让表级 MAX 保持新鲜
        repo.upsert_market("CHF", "8.1", (REF_TODAY - timedelta(days=53)).isoformat())

        check = self._check()
        assert check["status"] == "critical"
        assert check["detail"]["per_currency"]["CHF"]["stale_days"] == 53
        assert check["detail"]["stale_currencies"] == ["CHF"]

    def test_nonzero_currency_with_no_rate_at_all_is_critical(self, monkeypatch):
        monkeypatch.setattr(tools, "_nonzero_balance_currencies", lambda: {"CNY", "CHF"})
        FXRateRepository().upsert_market("USD", "7.5", REF_TODAY.isoformat())
        check = self._check()
        assert check["detail"]["per_currency"]["CHF"]["latest_rate_date"] is None
        assert check["status"] == "critical"

    def test_table_level_fx_freshness_is_not_polluted(self, monkeypatch):
        """关键回归：本检查不得改变表级 fx_freshness 的既有语义。"""
        monkeypatch.setattr(tools, "_nonzero_balance_currencies", lambda: {"CNY", "CHF"})
        repo = FXRateRepository()
        repo.upsert_market("USD", "7.5", REF_TODAY.isoformat())
        repo.upsert_market("CHF", "8.1", (REF_TODAY - timedelta(days=53)).isoformat())

        checks = tools.compute_health_check()["checks"]
        # 表级裁决仍判 ok（只关心全表 MAX），与 runbook 分工边界一致
        assert checks["fx_freshness"]["status"] == "ok"
        # 新的正交检查负责发现单币种停滞
        assert checks["fx_required_currency_staleness"]["status"] == "critical"

    def test_firefly_unavailable_is_explicitly_not_applicable(self, monkeypatch):
        """取不到非零币种集合时不得静默通过，也不得常红：必须显式声明不适用。"""
        monkeypatch.setattr(tools.settings, "firefly_token", "")
        monkeypatch.setattr(tools.settings, "firefly_api_url", "")
        check = self._check()
        assert check["detail"]["applicable"] is False
        assert "reason" in check["detail"]

    def test_firefly_configured_but_unreachable_degrades_to_warning(self, monkeypatch):
        """已配置但取不到账户（Firefly 挂/网络故障）→ 如实 warning + 错误留痕。

        与"未配置"刻意区分：未配置是 applicable=false（本地/测试环境不该常红），
        已配置却失败是**真实故障**，必须冒泡而不是静默通过。
        """
        def _boom():
            raise RuntimeError("Firefly server error: 500")
        monkeypatch.setattr(tools, "_nonzero_balance_currencies", _boom)

        out = tools.compute_health_check()
        check = out["checks"]["fx_required_currency_staleness"]
        assert check["status"] == "warning"
        assert "Firefly server error" in check["detail"]
