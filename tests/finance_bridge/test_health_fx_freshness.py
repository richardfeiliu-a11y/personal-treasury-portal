"""Batch 05（REL-02）— 健康检查新增 fx_freshness：汇率库整体新鲜度。

三层用例（新率 → ok / 8 天前 → warning / 空表 → critical）外加：
  - 边界：恰好 4 天仍 ok、恰好 10 天仍 warning（>10 天才 critical）
  - 检查内部异常 → critical（与 freshness/draft_backlog/backup 同模式）
  - 单币种缺率 **不**触发该项（那是 fx_complete 的行级裁决）
  - 币种混合陈旧（USD 今日 + EUR 40 天前）仍判 ok：裁决是表级、与币种无关
  - 表级 MAX 不按 rate_type/source 过滤：最新行是历史回填行也算新鲜
  - 未来日期行（手工预填）→ stale_days 为负，仍判 ok（runbook 已登记）
  - GET /v1/reports/health-check 输出含 checks.fx_freshness

口径：与 `business_today()`（Europe/Berlin 业务日）比较 `MAX(rate_date)`，
容忍度依据 docs/operations/fx-policy.md §降级策略（周末/ECB 休市日向前填充）。
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from finance_bridge.app.main import app as bridge_app
from finance_bridge.app.reporting import tools
from finance_bridge.app.state import close_storage, init_storage
from finance_bridge.app.storage.fx_rates import FXRateRepository
from finance_bridge.app.storage.job_runs import JobRunRepository

# 钉住业务日，使阈值判定与宿主机时钟无关
REF_TODAY = date(2026, 6, 15)


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch, tmp_path):
    """临时库 + 无 Firefly 凭据 + 其余检查项收敛为 ok。

    `overall_status` 的断言因此只反映 fx_freshness 一项的贡献：
    freshness 走空投影、backup 刚成功、草稿积压为 0、Firefly 两项跳过。
    """
    init_storage(f"sqlite:///{tmp_path}/fx-freshness.db")
    monkeypatch.setattr(tools.settings, "firefly_token", "")
    monkeypatch.setattr(tools.settings, "firefly_api_url", "")
    monkeypatch.setattr(tools.settings, "bridge_internal_token", "test-token")
    monkeypatch.setattr(tools, "task_status_projection", list)
    JobRunRepository().record_success("backup")
    yield
    close_storage()


@pytest.fixture
def ref_today(monkeypatch):
    """把健康检查的业务日钉为 REF_TODAY（生产路径由 app_tz() 读钟）。"""
    monkeypatch.setattr(tools, "business_today", lambda now=None: REF_TODAY.isoformat())
    return REF_TODAY


def _seed(rate_date: str, currency: str = "USD") -> None:
    FXRateRepository().upsert_market(currency, "7.5", rate_date)


def _ago(days: int) -> str:
    return (REF_TODAY - timedelta(days=days)).isoformat()


# -------------------------------------------------------------------
# repo 层：latest_rate_date() 与已有 earliest_rate_date() 对称
# -------------------------------------------------------------------

def test_latest_rate_date_returns_max_and_none_when_empty():
    assert FXRateRepository().latest_rate_date() is None      # 空表 → None，不抛异常

    _seed(_ago(30), "USD")
    _seed(_ago(2), "EUR")
    FXRateRepository().set_manual("USD", "7.2", _ago(60), "历史覆盖")
    assert FXRateRepository().latest_rate_date() == _ago(2)   # MAX 而非 MIN
    assert FXRateRepository().earliest_rate_date() == _ago(60)


# -------------------------------------------------------------------
# 三层用例 + 边界
# -------------------------------------------------------------------

@pytest.mark.parametrize("days", [0, 1, 4])
def test_fresh_rate_within_tolerance_is_ok(ref_today, days):
    _seed(_ago(days))
    check = tools.compute_health_check()["checks"]["fx_freshness"]

    assert check["status"] == "ok"
    assert check["detail"]["latest_rate_date"] == _ago(days)
    assert check["detail"]["stale_days"] == days
    assert check["detail"]["business_today"] == ref_today.isoformat()
    # 恰好 4 天是 ok/warning 的分界，必须留在 ok 侧
    assert tools.compute_health_check()["status"] == "ok"


@pytest.mark.parametrize("days", [5, 8, 10])
def test_normal_holiday_gap_is_warning_and_surfaces(ref_today, days):
    _seed(_ago(days))
    out = tools.compute_health_check()

    assert out["checks"]["fx_freshness"]["status"] == "warning"
    assert out["checks"]["fx_freshness"]["detail"]["stale_days"] == days
    # warning 必须冒泡到 overall_status（可观测性即本批目的）
    assert out["status"] == "warning"


@pytest.mark.parametrize("days", [11, 30])
def test_stale_rate_library_is_critical(ref_today, days):
    _seed(_ago(days))
    out = tools.compute_health_check()

    assert out["checks"]["fx_freshness"]["status"] == "critical"
    assert out["checks"]["fx_freshness"]["detail"]["stale_days"] == days
    assert out["status"] == "critical"


def test_empty_rate_library_is_critical(ref_today):
    out = tools.compute_health_check()

    check = out["checks"]["fx_freshness"]
    assert check["status"] == "critical"
    assert check["detail"]["latest_rate_date"] is None
    assert check["detail"]["stale_days"] is None
    assert out["status"] == "critical"


def test_real_clock_fresh_rate_is_ok():
    """不钉时钟：生产读钟路径下写入「业务今天的率」必须判 ok。"""
    _seed(tools.business_today())
    assert tools.compute_health_check()["checks"]["fx_freshness"]["status"] == "ok"


# -------------------------------------------------------------------
# Invariant：单币种缺率不触发该项（行级裁决由 fx_complete 承担）
# -------------------------------------------------------------------

def test_missing_single_currency_does_not_trigger_fx_freshness(ref_today):
    _seed(ref_today.isoformat(), "USD")     # USD 新鲜；EUR 从未有率

    check = tools.compute_health_check()["checks"]["fx_freshness"]
    assert check["status"] == "ok"
    assert check["detail"]["latest_rate_date"] == ref_today.isoformat()


def test_mixed_currency_staleness_is_judged_table_level(ref_today):
    """表级裁决与币种无关：只要全表 MAX 跟上业务日就 ok。

    混入一条严重过期的 EUR 率（40 天，远超 critical 阈值）。若实现被改写成
    「按币种分别取最新率再比较」，EUR 会把判定拉到 critical，本用例随之失败。
    """
    _seed(ref_today.isoformat(), "USD")     # 新鲜币种
    _seed(_ago(40), "EUR")                  # 过期币种：属 fx_complete 的行级裁决面

    check = tools.compute_health_check()["checks"]["fx_freshness"]
    assert check["status"] == "ok"
    assert check["detail"]["latest_rate_date"] == ref_today.isoformat()
    assert check["detail"]["stale_days"] == 0
    assert tools.compute_health_check()["status"] == "ok"


# -------------------------------------------------------------------
# Invariant：表级 MAX 不按 rate_type/source 过滤（见 latest_rate_date docstring）
# -------------------------------------------------------------------

def test_newest_row_being_historical_still_counts_as_fresh(ref_today):
    """最新一条是历史回填行（rate_type='historical'）也算新鲜。

    市场价停在 20 天前本应 critical，但回填行证明库里有更可用的日期；
    加 `WHERE rate_type='market'` 的实现会在此失败。
    """
    _seed(_ago(20), "USD")
    FXRateRepository().upsert_historical("USD", "7.4", _ago(1))

    check = tools.compute_health_check()["checks"]["fx_freshness"]
    assert check["detail"]["latest_rate_date"] == _ago(1)
    assert check["detail"]["stale_days"] == 1
    assert check["status"] == "ok"
    assert tools.compute_health_check()["status"] == "ok"


def test_future_dated_manual_row_is_ok_with_negative_stale_days(ref_today):
    """已接受语义：库内最新日期晚于业务日（手工预填）→ stale_days 为负数。

    `_ago(-2)` = REF_TODAY + 2 天。本检查只回答「库是否太旧」，不裁决日期是否
    超前，故为 ok；取绝对值或加 `rate_date <= 业务日` 过滤的实现都会在此失败。
    """
    FXRateRepository().set_manual("USD", "7.5", _ago(-2), "手工预填未来日汇率")

    check = tools.compute_health_check()["checks"]["fx_freshness"]
    assert check["status"] == "ok"
    assert check["detail"]["latest_rate_date"] == _ago(-2)
    assert check["detail"]["stale_days"] == -2
    assert tools.compute_health_check()["status"] == "ok"


# -------------------------------------------------------------------
# 检查内部异常 → critical（与其他检查项一致）
# -------------------------------------------------------------------

def test_repository_failure_becomes_critical(ref_today, monkeypatch):
    def boom(self):
        raise RuntimeError("fx_rates table unreadable")

    monkeypatch.setattr(FXRateRepository, "latest_rate_date", boom)
    out = tools.compute_health_check()

    check = out["checks"]["fx_freshness"]
    assert check["status"] == "critical"
    assert "fx_rates table unreadable" in str(check["detail"])
    assert out["status"] == "critical"


# -------------------------------------------------------------------
# Acceptance：端点输出含 checks.fx_freshness
# -------------------------------------------------------------------

def test_health_check_endpoint_emits_fx_freshness_key(ref_today):
    _seed(_ago(8))
    client = TestClient(bridge_app)
    resp = client.get("/v1/reports/health-check",
                      headers={"Authorization": "Bearer test-token"})

    assert resp.status_code == 200
    body = resp.json()
    assert "fx_freshness" in body["checks"]
    assert body["checks"]["fx_freshness"]["status"] == "warning"
    assert body["checks"]["fx_freshness"]["detail"]["latest_rate_date"] == _ago(8)
    # 门户 API 错误语义不变：仍是 200 + 检查项，不引入 503/error_class
    assert body["status"] == "warning"
