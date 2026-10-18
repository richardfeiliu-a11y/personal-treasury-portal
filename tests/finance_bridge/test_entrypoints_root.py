"""RV-08：入口检查器对旧仓库根路径必须失败（不能只警告返回 CLEAN）。

清单已声明某入口必须运行仓库脚本（exec/exec_post），实际 unit 指向声明
根之外（如旧根 /opt/personal-erp）→ error + exit 1。
确属系统命令的入口（清单无 exec 声明）→ 仍 warn，不判错。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "tools"))

import check_runtime_entrypoints as checker  # noqa: E402


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_wrong_repo_root_is_error(tmp_path: Path):
    """RV-08 复现：清单声明 exec，实际指向旧根 → error + exit 1。"""
    _write(tmp_path / "infra/systemd/x.service",
           "[Service]\nExecStart=/usr/bin/python3.11 /opt/personal-erp/scripts/tools/feishu_digest.py\n")
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"repo_root": "/opt/personal-treasury",
                                    "units": {"x.service": {"exec": "scripts/tools/feishu_digest.py"}}}))
    code, findings = checker.run_check(manifest, tmp_path)
    assert code == 1
    assert any(f["severity"] == "error" and f["kind"] == "exec_root_mismatch"
               for f in findings)


def test_wrong_repo_root_exec_post_is_error(tmp_path: Path):
    """RV-08：ExecStartPost 错根同样 error。"""
    _write(tmp_path / "infra/systemd/x.service",
           "[Service]\n"
           "ExecStart=/usr/bin/python3.11 /opt/personal-treasury/scripts/tools/feishu_digest.py\n"
           "ExecStartPost=/usr/bin/python3.11 /opt/personal-erp/scripts/tools/deliver_feishu_digest.py\n")
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"repo_root": "/opt/personal-treasury",
                                    "units": {"x.service": {
                                        "exec": "scripts/tools/feishu_digest.py",
                                        "exec_post": "scripts/tools/deliver_feishu_digest.py"}}}))
    code, findings = checker.run_check(manifest, tmp_path)
    assert code == 1
    assert any(f["severity"] == "error" and f["kind"] == "exec_root_mismatch"
               and f["directive"] == "ExecStartPost" for f in findings)


def test_undeclared_system_command_stays_warn(tmp_path: Path):
    """确属系统命令（清单无 exec 声明）→ warn，不判错。"""
    _write(tmp_path / "infra/systemd/y.service",
           "[Service]\nExecStart=/usr/bin/systemctl restart foo\n")
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"repo_root": "/opt/personal-treasury",
                                    "units": {"y.service": {}}}))
    code, findings = checker.run_check(manifest, tmp_path)
    assert code == 0
    assert any(f["kind"] == "exec_outside_repo" for f in findings)


# ---------------------------------------------------------------------------
# AUD-27（2026-09-22）：生产存在未入仓的调度入口 → 漂移检查器失明
# ---------------------------------------------------------------------------

def test_fx_refresh_unit_is_declared_and_present():
    """fx-refresh 曾只存在于生产 /etc/systemd/system，未入仓 → 检查器看不到它。

    它恰是 2026-09-22 静默失败的那个任务（审计 F-00）。本用例把「必须入仓并被
    清单覆盖」钉住，防止再次退化为"生产有、仓库无"。
    """
    repo_root = REPO_ROOT
    manifest = json.loads((repo_root / "infra/runtime-entrypoints.json").read_text(encoding="utf-8"))
    units = manifest["units"]

    assert "personal-treasury-fx-refresh.service" in units, "fx-refresh 必须登记在运行时入口清单"
    spec = units["personal-treasury-fx-refresh.service"]
    assert spec.get("timer") == "personal-treasury-fx-refresh.timer"

    # unit 与 timer 文件都必须真实存在于仓库
    assert (repo_root / "infra/systemd/personal-treasury-fx-refresh.service").is_file()
    assert (repo_root / "infra/systemd/personal-treasury-fx-refresh.timer").is_file()


def test_fx_refresh_timer_does_not_collide_with_patrol():
    """AUD-26 根因：两者同为 18:00 Berlin 触发，patrol 必然读到刷新**之前**的状态。

    2026-09-22 实测：refresh 18:00:41 失败，patrol 18:00:04 已判 OK。
    这里钉住"不得再次同刻触发"。
    """
    repo_root = REPO_ROOT
    fx = (repo_root / "infra/systemd/personal-treasury-fx-refresh.timer").read_text(encoding="utf-8")
    manifest = json.loads((repo_root / "infra/runtime-entrypoints.json").read_text(encoding="utf-8"))
    fx_cal = manifest["units"]["personal-treasury-fx-refresh.service"]["on_calendar"]

    # 清单声明与 unit 文件必须一致（检查器会核这条）
    assert fx_cal in fx
    # patrol 在 00/6 点整触发；fx-refresh 必须错开整点
    assert "00/6:00:00" not in fx_cal
    assert not fx_cal.endswith("18:00:00 Europe/Berlin"), (
        "fx-refresh 不得与 patrol 的 18:00 Berlin 同刻触发，否则巡检会系统性读到刷新前的状态"
    )


def test_retired_units_are_recorded_not_silently_absent():
    """已退役但仍装在生产（watchdog）：必须显式登记，与"忘记登记"区分。"""
    repo_root = REPO_ROOT
    manifest = json.loads((repo_root / "infra/runtime-entrypoints.json").read_text(encoding="utf-8"))
    retired = manifest.get("retired_units") or {}
    assert "personal-treasury-watchdog.service" in retired
    assert (repo_root / "scripts/ops/watchdog.sh").exists() is False, (
        "watchdog.sh 已随 D02 退役；若它回归，退役登记应同步更新"
    )
