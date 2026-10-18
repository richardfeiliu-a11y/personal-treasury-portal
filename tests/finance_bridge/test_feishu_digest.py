"""飞书日报生成单测（WP02：入口契约 + Berlin 业务日期，全程 mock 不触网）。

personal-balance-sheet 真实 summary 结构来源：
finance_bridge/app/reporting/personal_balance_sheet.py::compute_personal_balance_sheet
（total_*_base / net_worth_base 为 Decimal 字符串，缺汇率 fail-closed 时为 null）
与 finance_bridge/app/api/report_web.py::PersonalBalanceSheetResponse。
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "tools"))

import feishu_digest  # noqa: E402
from feishu_digest import build_digest, generate_digest, resolve_business_date  # noqa: E402

BERLIN = ZoneInfo("Europe/Berlin")
UTC = timezone.utc


def _balance() -> dict:
    """personal-balance-sheet 真实响应结构（fx 完整）。"""
    return {
        "schema_version": "1",
        "source": "firefly_live",
        "generated_at": "2026-09-30T18:00:02+02:00",
        "base_currency": "CNY",
        "balance_as_of": "2026-09-30",
        "fx_complete": True,
        "missing_currencies": [],
        "warnings": [],
        "summary": {
            "total_assets_base": "1750.00",
            "total_liabilities_base": "225.00",
            "net_worth_base": "1525.00",
            "included_account_count": 5,
            "pending_mapping_count": 0,
        },
        "groups": [],
    }


def _balance_fx_missing() -> dict:
    """缺汇率 fail-closed：非零外币缺率 → 折算汇总为 null（禁止 1:1 回退）。"""
    data = _balance()
    data["fx_complete"] = False
    data["missing_currencies"] = ["USD"]
    data["warnings"] = ["存在非零余额币种缺少汇率，相关折算金额与汇总总额为 null。"]
    data["summary"] = {
        "total_assets_base": None,
        "total_liabilities_base": None,
        "net_worth_base": None,
        "included_account_count": 5,
        "pending_mapping_count": 0,
    }
    return data


def _pnl() -> dict:
    return {
        "summary": {
            "total_income_cny": "5000.00",
            "total_expenses_cny": "3000.00",
            "net_result_cny": "2000.00",
            "savings_rate_pct": "40.0",
        }
    }


def _drafts() -> dict:
    return {"drafts": [
        {"id": 1, "status": "pending"},
        {"id": 2, "status": "posted"},
        {"id": 3, "status": "pending"},
    ]}


def _health() -> dict:
    return {
        "status": "warning",
        "checks": {
            "draft_backlog": {"status": "ok"},
            "suspected_duplicates": {"status": "warning", "detail": {"duplicate_groups_count": 1}},
        },
    }


# ---------------------------------------------------------------------------
# build_digest：金额/日期渲染（缺失语义，不造零）
# ---------------------------------------------------------------------------

def test_digest_contains_core_figures():
    text = build_digest(_balance(), _pnl(), _drafts(), _health(), date(2026, 9, 30))
    assert "Personal Treasury 每日简报" in text
    assert "日期：2026-09-30" in text
    assert "净资产 1,525.00 CNY" in text
    assert "收入 5,000.00" in text
    assert "支出 3,000.00" in text
    assert "结余 2,000.00" in text
    assert "储蓄率 40.0%" in text
    assert "待确认草稿 2" in text
    assert "suspected_duplicates" in text


def test_digest_healthy_has_no_alerts():
    health = {"status": "ok", "checks": {}}
    text = build_digest(_balance(), _pnl(), _drafts(), health, date(2026, 9, 30))
    assert "健康检查：ok" in text
    assert "待确认草稿 2" in text


def test_digest_missing_fields_render_missing_not_zero():
    """金额字段缺失 → 缺失语义「—」，禁止造零（R02/测试矩阵）。"""
    empty_pnl = {"summary": {}}
    text = build_digest(_balance(), empty_pnl, {"drafts": []}, _health(), date(2026, 9, 30))
    assert "收入 —" in text
    assert "支出 —" in text
    assert "结余 —" in text
    assert "储蓄率 —%" in text


def test_digest_fx_missing_fail_closed():
    """缺汇率 → 折算汇总 null 显示为「—」且标注不完整；不得出现 1:1 或 0 替代。"""
    text = build_digest(_balance_fx_missing(), _pnl(), _drafts(), _health(), date(2026, 9, 30))
    assert "⚠️" in text
    assert "净资产 —" in text
    assert "USD" in text  # 缺失币种列出，便于人工补率
    assert "1,525.00" not in text


# ---------------------------------------------------------------------------
# resolve_business_date：Europe/Berlin 业务日矩阵（WP02 测试矩阵硬性用例）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("utc_moment", "expected"),
    [
        # 夏季：2026-09-30T16:00:00Z → 柏林 18:00 → 09-30（UTC 尚未跨日）
        (datetime(2026, 9, 30, 16, 0, tzinfo=UTC), date(2026, 9, 30)),
        # 冬季：2026-12-31T17:00:00Z → 柏林 18:00 CET → 12-31
        (datetime(2026, 12, 31, 17, 0, tzinfo=UTC), date(2026, 12, 31)),
        # 月末漂移防护：22:30Z 柏林已次日 → 10-01（服务器 +08:00 亦为 10-01 次日晨场景）
        (datetime(2026, 9, 30, 22, 30, tzinfo=UTC), date(2026, 10, 1)),
        # 夏令时切换日 2026-03-29（01:00 UTC 进入 CEST）：00:30Z 仍 CET(+1) → 01:30 → 03-29
        (datetime(2026, 3, 29, 0, 30, tzinfo=UTC), date(2026, 3, 29)),
        # 夏令时结束日 2026-10-25（01:00 UTC 回 CET）：00:30Z 仍 CEST(+2) → 02:30 → 10-25
        (datetime(2026, 10, 25, 0, 30, tzinfo=UTC), date(2026, 10, 25)),
        # naive 输入按 UTC 解释（禁止误用服务器本地时区）
        (datetime(2026, 9, 30, 16, 0), date(2026, 9, 30)),
    ],
)
def test_resolve_business_date_matrix(utc_moment, expected):
    assert resolve_business_date(utc_moment) == expected


def test_resolve_business_date_defaults_to_now_utc():
    now = datetime.now(UTC)
    assert resolve_business_date(now) == now.astimezone(BERLIN).date()


# ---------------------------------------------------------------------------
# generate_digest：入口请求契约（mock fetch，断言现行接口、显式业务日期、
# 不再调用 net-worth）
# ---------------------------------------------------------------------------

def _fake_fetch(calls: list[str]):
    def fetch(path: str) -> dict:
        calls.append(path)
        if path.startswith("/reports/personal-balance-sheet"):
            return _balance()
        if path.startswith("/reports/income-statement"):
            return _pnl()
        if path.startswith("/reports/recent-drafts"):
            return _drafts()
        if path.startswith("/reports/health-check"):
            return _health()
        raise AssertionError(f"unexpected fetch path: {path}")
    return fetch


def test_generate_digest_requests_current_contract():
    calls: list[str] = []
    text = generate_digest(date(2026, 9, 30), fetch_fn=_fake_fetch(calls))
    assert calls == [
        "/reports/personal-balance-sheet?as_of=2026-09-30",
        "/reports/income-statement?start_date=2026-09-01&end_date=2026-09-30&accounting_view=management",
        "/reports/recent-drafts?limit=100",
        "/reports/health-check",
    ]
    # 旧接口不得回归（R02 的 404 根因）
    assert not any("net-worth" in c for c in calls)
    # 报告业务日与请求业务日一致
    assert "日期：2026-09-30" in text
    assert "2026-09-30" in text.split("本月收支：")[0]


def test_generate_digest_month_boundary_follows_business_date():
    """月初由业务日推导（柏林 10 月初），非服务器 date.today()。"""
    calls: list[str] = []
    generate_digest(date(2026, 10, 1), fetch_fn=_fake_fetch(calls))
    assert calls[1] == (
        "/reports/income-statement?start_date=2026-10-01&end_date=2026-10-01&accounting_view=management"
    )
    assert calls[0] == "/reports/personal-balance-sheet?as_of=2026-10-01"


def test_generate_digest_propagates_fetch_failure():
    """HTTP 404/超时（任何 fetch 异常）→ 生成失败向上传播，禁止发送分支。"""
    def failing_fetch(path: str) -> dict:
        if path.startswith("/reports/personal-balance-sheet"):
            raise RuntimeError("HTTP Error 404: Not Found")
        raise AssertionError("must not continue after first failure")

    with pytest.raises(RuntimeError, match="404"):
        generate_digest(date(2026, 9, 30), fetch_fn=failing_fetch)


# ---------------------------------------------------------------------------
# main：生成写状态文件、失败退码可区分、--dry-run 不写
# ---------------------------------------------------------------------------

def test_main_writes_state_and_returns_zero(monkeypatch, tmp_path, capsys):
    calls: list[str] = []
    monkeypatch.setattr(feishu_digest, "fetch", _fake_fetch(calls))
    monkeypatch.setenv("DIGEST_STATE_DIR", str(tmp_path))
    rc = feishu_digest.main(["--business-date", "2026-09-30"])
    assert rc == 0
    out = (tmp_path / "2026-09-30.txt").read_text()
    assert "日期：2026-09-30" in out
    assert "Personal Treasury 每日简报" in capsys.readouterr().out


def test_main_generation_failure_returns_nonzero_and_writes_nothing(monkeypatch, tmp_path):
    def failing_fetch(path: str) -> dict:
        raise RuntimeError("HTTP Error 404")

    monkeypatch.setattr(feishu_digest, "fetch", failing_fetch)
    monkeypatch.setenv("DIGEST_STATE_DIR", str(tmp_path))
    rc = feishu_digest.main(["--business-date", "2026-09-30"])
    assert rc == 1
    assert list(tmp_path.iterdir()) == []


def test_main_dry_run_prints_without_state(monkeypatch, tmp_path, capsys):
    calls: list[str] = []
    monkeypatch.setattr(feishu_digest, "fetch", _fake_fetch(calls))
    monkeypatch.setenv("DIGEST_STATE_DIR", str(tmp_path))
    rc = feishu_digest.main(["--business-date", "2026-09-30", "--dry-run"])
    assert rc == 0
    assert "Personal Treasury 每日简报" in capsys.readouterr().out
    assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# RV-02：main 成功/失败必须记录任务结果；dry-run 不记录
# ---------------------------------------------------------------------------

def test_main_success_records_generate_outcome(monkeypatch, tmp_path):
    calls: list[str] = []
    monkeypatch.setattr(feishu_digest, "fetch", _fake_fetch(calls))
    monkeypatch.setenv("DIGEST_STATE_DIR", str(tmp_path))
    recorded: list[tuple] = []
    monkeypatch.setattr(feishu_digest, "record_job_outcome",
                        lambda *a: recorded.append(a))
    assert feishu_digest.main(["--business-date", "2026-09-30"]) == 0
    assert recorded == [("feishu_digest_generate", "success")]


def test_main_failure_records_generate_failure(monkeypatch, tmp_path):
    def failing_fetch(path: str) -> dict:
        raise RuntimeError("HTTP Error 404")

    monkeypatch.setattr(feishu_digest, "fetch", failing_fetch)
    monkeypatch.setenv("DIGEST_STATE_DIR", str(tmp_path))
    recorded: list[tuple] = []
    monkeypatch.setattr(feishu_digest, "record_job_outcome",
                        lambda *a: recorded.append(a))
    assert feishu_digest.main(["--business-date", "2026-09-30"]) == 1
    assert len(recorded) == 1 and recorded[0][1] == "failure" and recorded[0][2]


def test_main_dry_run_does_not_record(monkeypatch, tmp_path, capsys):
    calls: list[str] = []
    monkeypatch.setattr(feishu_digest, "fetch", _fake_fetch(calls))
    monkeypatch.setenv("DIGEST_STATE_DIR", str(tmp_path))
    recorded: list[tuple] = []
    monkeypatch.setattr(feishu_digest, "record_job_outcome",
                        lambda *a: recorded.append(a))
    assert feishu_digest.main(["--business-date", "2026-09-30", "--dry-run"]) == 0
    assert recorded == []
