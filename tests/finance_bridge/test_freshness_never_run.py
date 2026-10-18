"""任务健康六态语义回归（WP04）。

状态枚举：healthy / failed / stale / never_succeeded / disabled / unknown。
硬规则（R04 核心）：最近失败时间晚于最后成功时，即使成功尚未超期
也不得标 healthy；无记录显示 never_succeeded/disabled/unknown，
不借用当前时间冒充。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from finance_bridge.app.state import init_storage, close_storage
from finance_bridge.app.storage.job_runs import JobRunRepository, REQUIRED_TASKS


@pytest.fixture(autouse=True)
def _storage(tmp_path):
    init_storage(f"sqlite:///{tmp_path}/test.db")
    yield
    close_storage()


def _job(repo, name):
    report = repo.get_freshness_report()
    return next(j for j in report["jobs"] if j["job_name"] == name)


# ---------------------------------------------------------------------------
# 六值状态矩阵
# ---------------------------------------------------------------------------

def test_disabled_job_reports_disabled():
    """当前产品态停用（investment_snapshot）→ disabled，即使有过成功。"""
    repo = JobRunRepository()
    repo.record_success("investment_snapshot")
    job = _job(repo, "investment_snapshot")
    assert job["state"] == "disabled"


def test_never_registered_required_task_appears_as_never_succeeded():
    """必需任务集合中的任务即使无行也必须出现在报告中（R04：日报链不可隐身）。"""
    repo = JobRunRepository()
    job = _job(repo, "feishu_digest_generate")
    assert job["state"] == "never_succeeded"
    assert job["required"] is True
    report = repo.get_freshness_report()
    assert report["status"] == "degraded"


def test_registered_never_run_required_task_never_succeeded():
    repo = JobRunRepository()
    repo.register_job("patrol_health_check", stale_after_hours=8)
    job = _job(repo, "patrol_health_check")
    assert job["state"] == "never_succeeded"
    assert job["never_run"] is True  # legacy 兼容


def test_recent_success_is_healthy():
    repo = JobRunRepository()
    repo.record_success("firefly_cron")
    job = _job(repo, "firefly_cron")
    assert job["state"] == "healthy"


def test_old_success_without_failure_is_stale():
    repo = JobRunRepository()
    repo.record_success("firefly_cron", "2026-07-28T00:00:00Z")
    job = _job(repo, "firefly_cron")
    assert job["state"] == "stale"
    assert job["hours_since_last_success"] is not None


def test_failure_only_is_failed():
    repo = JobRunRepository()
    repo.record_failure("firefly_cron", "boom")
    job = _job(repo, "firefly_cron")
    assert job["state"] == "failed"


def test_failure_later_than_success_is_failed_not_healthy():
    """硬规则：失败晚于成功 → failed（即使成功未超期）。"""
    repo = JobRunRepository()
    repo.record_success("firefly_cron")  # 刚刚成功
    repo.record_failure("firefly_cron", "later boom")  # 更晚失败
    job = _job(repo, "firefly_cron")
    assert job["state"] == "failed"


def test_success_later_than_failure_is_healthy():
    """恢复链：失败在前、最近一次为成功且未超期 → healthy。"""
    repo = JobRunRepository()
    repo.record_failure("firefly_cron", "old boom")
    repo.record_success("firefly_cron")
    job = _job(repo, "firefly_cron")
    assert job["state"] == "healthy"


def test_unreadable_timestamp_is_unknown_not_now():
    """记录不可读 → unknown；不得借用当前时间冒充成功/新鲜。"""
    repo = JobRunRepository()
    with repo._storage()._connection() as conn:
        conn.execute(
            "INSERT INTO job_runs (job_name, last_success_at, stale_after_hours)"
            " VALUES ('weird_job', 'not-a-timestamp', 36)"
        )
        conn.commit()
    job = _job(repo, "weird_job")
    assert job["state"] == "unknown"
    assert job["hours_since_last_success"] is None


def test_next_planned_at_known_for_declared_schedules():
    """已声明调度的任务给出下次计划时间；未声明的为 None（unknown 语义）。"""
    repo = JobRunRepository()
    repo.record_success("feishu_digest_generate")
    job = _job(repo, "feishu_digest_generate")
    assert job["next_planned_at"] is not None
    assert job["next_planned_at"].endswith("+01:00") or job["next_planned_at"].endswith("+02:00")
    row = _job(repo, "fx_rate_refresh")
    assert row["next_planned_at"] is None  # 未声明调度 → unknown，不猜测


def test_overall_status_counts_required_and_never_succeeded():
    repo = JobRunRepository()
    report = repo.get_freshness_report()
    assert report["status"] == "degraded"  # feishu_digest_* / patrol 从未成功
    assert "checked_at" in report


# ---------------------------------------------------------------------------
# 兼容字段（health-check/patrol 现有消费方）
# ---------------------------------------------------------------------------

def test_legacy_fields_keep_semantics():
    repo = JobRunRepository()
    repo.record_success("firefly_cron", "2026-07-28T00:00:00Z")
    job = _job(repo, "firefly_cron")
    assert job["is_stale"] is True          # legacy：过期未再成功
    assert job["never_run"] is False

    repo.record_failure("some_job", "boom")
    job = _job(repo, "some_job")
    assert job["is_stale"] is True          # legacy：仅失败也视为不新鲜
    assert job["never_run"] is False

    never = _job(repo, "feishu_digest_deliver")
    assert never["never_run"] is True       # legacy：从未运行


def test_required_task_registry_shape():
    assert REQUIRED_TASKS["investment_snapshot"].get("enabled") is False
    for name in ("feishu_digest_generate", "feishu_digest_deliver", "patrol_health_check"):
        assert name in REQUIRED_TASKS, name


# ---------------------------------------------------------------------------
# RV-06：阈值权威与调度解析
# ---------------------------------------------------------------------------

def test_first_success_uses_registered_threshold():
    """RV-06：首次成功记录遵守注册表阈值（巡检 8h，非表默认 36）。"""
    repo = JobRunRepository()
    repo.record_success("patrol_health_check")
    assert _job(repo, "patrol_health_check")["stale_after_hours"] == 8


def test_first_failure_uses_registered_threshold():
    """RV-06：首次失败记录同样遵守注册表阈值。"""
    repo = JobRunRepository()
    repo.record_failure("patrol_health_check", "boom")
    assert _job(repo, "patrol_health_check")["stale_after_hours"] == 8


def test_legacy_default_row_defers_to_registry():
    """RV-06：遗留默认行（无阈值列）→ 报告按注册表 8h 呈现。"""
    repo = JobRunRepository()
    with repo._storage()._connection() as conn:
        conn.execute(
            "INSERT INTO job_runs (job_name, last_success_at)"
            " VALUES ('patrol_health_check', '2026-09-07T00:00:00Z')"
        )
        conn.commit()
    assert _job(repo, "patrol_health_check")["stale_after_hours"] == 8


def test_patrol_success_10h_ago_is_stale_with_next_planned():
    """RV-06 复现：巡检上次成功 10h 前 → stale（8h 阈值）且有下次计划。"""
    repo = JobRunRepository()
    ten_h = (datetime.now(timezone.utc) - timedelta(hours=10)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    repo.record_success("patrol_health_check", ten_h)
    job = _job(repo, "patrol_health_check")
    assert job["state"] == "stale"
    assert job["next_planned_at"] is not None


def test_every_6h_and_daily_schedules_parse():
    """RV-06：每 6 小时与每日调度均解析出下次计划（不返回 None）。"""
    repo = JobRunRepository()
    repo.record_success("patrol_health_check")
    assert _job(repo, "patrol_health_check")["next_planned_at"] is not None
    repo.record_success("feishu_digest_generate")
    assert _job(repo, "feishu_digest_generate")["next_planned_at"] is not None
