"""Tests for the /v1/jobs/record endpoint (firefly_cron freshness tracking)."""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from finance_bridge.app.api.jobs import router
from finance_bridge.app.state import init_storage, close_storage
from finance_bridge.app.storage.job_runs import JobRunRepository

app = FastAPI()
app.include_router(router, prefix="/v1")


@pytest.fixture(autouse=True)
def _storage(tmp_path):
    init_storage(f"sqlite:///{tmp_path}/test.db")
    yield
    close_storage()


def _job_row(repo: JobRunRepository, name: str):
    report = repo.get_freshness_report()
    return next((j for j in report["jobs"] if j["job_name"] == name), None)


def test_record_success():
    client = TestClient(app)
    resp = client.post("/v1/jobs/record", json={"job_name": "firefly_cron", "status": "success"})
    assert resp.status_code == 200
    assert resp.json() == {"job_name": "firefly_cron", "status": "success", "recorded": True}
    row = _job_row(JobRunRepository(), "firefly_cron")
    assert row is not None
    assert row["last_success_at"] is not None
    assert row["last_failure_at"] is None


def test_record_failure():
    client = TestClient(app)
    resp = client.post("/v1/jobs/record", json={
        "job_name": "firefly_cron", "status": "failure", "reason": "cron endpoint failed"})
    assert resp.status_code == 200
    row = _job_row(JobRunRepository(), "firefly_cron")
    assert row is not None
    assert row["last_failure_at"] is not None
    assert row["last_failure_reason"] == "cron endpoint failed"


def test_record_invalid_status():
    client = TestClient(app)
    resp = client.post("/v1/jobs/record", json={"job_name": "firefly_cron", "status": "bogus"})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# WP04 任务 2：公网不暴露任务写入入口（内部认证），健康 GET 零写入
# ---------------------------------------------------------------------------

def test_record_requires_internal_token(monkeypatch, tmp_path):
    """真实 app 中间件下：未带/错带内部令牌的 POST /v1/jobs/record → 401。

    不进入 lifespan（存储由 autouse 临时库夹具提供，绝不触碰真实 DB 文件）。
    """
    from fastapi.testclient import TestClient as TC
    from finance_bridge.app.main import app as bridge_app
    from finance_bridge.app.config import settings

    monkeypatch.setattr(settings, "bridge_internal_token", "test-token-123")
    client = TC(bridge_app)  # 不用 context manager：不触发 lifespan
    resp = client.post("/v1/jobs/record",
                       json={"job_name": "firefly_cron", "status": "success"})
    assert resp.status_code == 401
    resp = client.post("/v1/jobs/record",
                       headers={"Authorization": "Bearer wrong"},
                       json={"job_name": "firefly_cron", "status": "success"})
    assert resp.status_code == 401
    resp = client.post("/v1/jobs/record",
                       headers={"Authorization": "Bearer test-token-123"},
                       json={"job_name": "firefly_cron", "status": "success"})
    assert resp.status_code == 200


def test_health_freshness_get_has_no_side_effects(monkeypatch, tmp_path):
    """健康 GET 不提交事务、不注册任务：GET 前后 job_runs 行集不变。"""
    from fastapi.testclient import TestClient as TC
    from finance_bridge.app.main import app as bridge_app
    from finance_bridge.app.config import settings
    from finance_bridge.app.storage.job_runs import JobRunRepository

    monkeypatch.setattr(settings, "bridge_internal_token", "test-token-123")
    repo = JobRunRepository()
    repo.register_job("firefly_cron", stale_after_hours=26)
    before = repo.get_freshness_report()
    names_before = sorted(j["job_name"] for j in before["jobs"])

    client = TC(bridge_app)
    resp = client.get("/health/freshness")
    assert resp.status_code == 200
    client.get("/healthz")

    after = repo.get_freshness_report()
    names_after = sorted(j["job_name"] for j in after["jobs"])
    assert names_before == names_after
    # GET 未创建任何新任务行（未注册 required 之外的任务）
    assert set(names_after) - set(names_before) == set()


def test_investment_snapshot_not_started_by_health_surface(tmp_path):
    """disabled 任务只输出状态，健康面不触发/注册它。"""
    repo = JobRunRepository()
    job = _job_row(repo, "investment_snapshot")
    assert job is not None
    assert job["state"] == "disabled"
