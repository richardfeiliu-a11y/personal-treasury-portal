"""入口检查器单测（WP03 任务 3：漂移检测 + 只读性）。

三个必测场景（WP03 计划指定）：
① Git 已无引用但「生产 timer」仍调用缺文件脚本 → 检查器报缺失、退出非 0；
② systemd unit 引用与仓库脚本路径一致 → 通过、退出 0；
③ 检查器自身无写操作（运行前后目录树哈希不变）。

全部在 tmp_path 沙箱内进行，不触网、不读生产。
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "tools"))

import check_runtime_entrypoints as checker  # noqa: E402


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


UNIT_CLEAN = """\
[Unit]
Description=clean unit

[Service]
Type=oneshot
ExecStart=/usr/bin/python3.11 {repo_root}/scripts/tools/feishu_digest.py
ExecStartPost=/usr/bin/python3.11 {repo_root}/scripts/tools/deliver_feishu_digest.py
"""

UNIT_DRIFT = """\
[Unit]
Description=drifted unit

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash {repo_root}/scripts/ops/watchdog.sh
"""

TIMER_CLEAN = """\
[Unit]
Description=clean timer

[Timer]
OnCalendar=*-*-* 18:00:00 Europe/Berlin
Persistent=true

[Install]
WantedBy=timers.target
"""


@pytest.fixture
def sandbox(tmp_path: Path) -> Path:
    """伪造仓库布局：infra/systemd + scripts 产物。"""
    _write(tmp_path / "infra/systemd/personal-treasury-digest.service",
           UNIT_CLEAN.format(repo_root=str(tmp_path)))
    _write(tmp_path / "infra/systemd/personal-treasury-digest.timer", TIMER_CLEAN)
    _write(tmp_path / "scripts/tools/feishu_digest.py", "# generator\n")
    _write(tmp_path / "scripts/tools/deliver_feishu_digest.py", "# deliver\n")
    return tmp_path


def _manifest(repo_root: Path, exec_value: str, unit: str = "personal-treasury-digest.service") -> str:
    return json.dumps({
        "repo_root": str(repo_root),
        "units": {
            unit: {
                "timer": "personal-treasury-digest.timer",
                "on_calendar": "*-*-* 18:00:00 Europe/Berlin",
                "exec": exec_value,
            }
        },
    })


def _tree_hash(root: Path) -> list[tuple[str, str]]:
    out = []
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out.append((str(p.relative_to(root)),
                        hashlib.sha256(p.read_bytes()).hexdigest()))
        else:
            out.append((str(p.relative_to(root)) + "/", "dir"))
    return out


def test_drift_deleted_script_reported(tmp_path: Path):
    """①Git 无引用但 unit 仍调用 watchdog.sh（a28c299 已删）→ 报缺失、非 0。"""
    _write(tmp_path / "infra/systemd/personal-treasury-digest.service",
           UNIT_DRIFT.format(repo_root=str(tmp_path)))
    _write(tmp_path / "infra/systemd/personal-treasury-digest.timer", TIMER_CLEAN)
    manifest = tmp_path / "manifest.json"
    _write(manifest, _manifest(tmp_path, "scripts/ops/watchdog.sh"))
    code, findings = checker.run_check(manifest, tmp_path)
    assert code == 1
    assert any(f["kind"] == "missing_exec_file" and "watchdog.sh" in f["path"] for f in findings)


def test_consistent_layout_passes(sandbox: Path):
    """②unit 引用与仓库脚本一致 → 退出 0，无 ERROR 级 finding。"""
    manifest = sandbox / "manifest.json"
    _write(manifest, _manifest(sandbox, "scripts/tools/feishu_digest.py"))
    code, findings = checker.run_check(manifest, sandbox)
    errors = [f for f in findings if f["severity"] == "error"]
    assert code == 0
    assert errors == []


def test_checker_is_read_only(sandbox: Path):
    """③检查器运行前后目录树逐文件哈希不变（无写操作）。"""
    manifest = sandbox / "manifest.json"
    _write(manifest, _manifest(sandbox, "scripts/tools/feishu_digest.py"))
    before = _tree_hash(sandbox)
    checker.run_check(manifest, sandbox)
    checker.run_check(manifest, sandbox)
    after = _tree_hash(sandbox)
    assert before == after


def test_missing_timer_declaration_flagged(sandbox: Path):
    """service 声明了 timer 但 unit 文件不存在 → error（调度归属缺失）。"""
    (sandbox / "infra/systemd/personal-treasury-digest.timer").unlink()
    manifest = sandbox / "manifest.json"
    _write(manifest, _manifest(sandbox, "scripts/tools/feishu_digest.py"))
    code, findings = checker.run_check(manifest, sandbox)
    assert code == 1
    assert any(f["kind"] == "missing_timer_file" for f in findings)


def test_real_repo_manifest_clean():
    """仓库自检：真实 manifest 与真实 infra/systemd 一致（防 manifest 腐化）。"""
    manifest = REPO_ROOT / "infra" / "runtime-entrypoints.json"
    code, findings = checker.run_check(manifest, REPO_ROOT)
    errors = [f for f in findings if f["severity"] == "error"]
    assert errors == [], errors
    assert code == 0


# ---------------------------------------------------------------------------
# WP03 任务 2：health-check.sh 探测语义（bash 经 fake PATH 二进制驱动测试）
# 误报源修正：未认证 Firefly 401 ≠ API 不可用；Hermes 服务存活 ≠ MCP 可用
# ---------------------------------------------------------------------------

import os
import subprocess

HEALTH_CHECK = REPO_ROOT / "scripts" / "ops" / "health-check.sh"

# RV-07：fake curl 支持 -f 语义（HTTP>=400 → exit 22；连接失败 → exit 7），
# URL 提取跳过 -X/-H/-d 等选项的值，避免把 header 误判为 URL。
CURL_FAKE = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
mapping = json.loads(os.environ["FAKE_CURL_MAP"])
OPT_WITH_VALUE = ("-o", "-w", "--max-time", "-X", "-H", "-d", "--data")
url = None
for i, a in enumerate(args):
    if a.startswith("-"):
        continue
    prev = args[i - 1] if i > 0 else ""
    if prev in OPT_WITH_VALUE or prev == "Bearer":
        continue
    url = a
spec = mapping.get(url) or {"code": 0, "body": ""}
code = spec["code"]
# 模拟 Bridge main.py 中间件：/v1/* 无 Bearer token 一律 401（RV-07：
# 巡检脚本漏发认证头必须在这里暴露，而不是被 fake curl 放行成假绿）。
if url and url.startswith("http://127.0.0.1:18711/v1/") and not any(
        a.startswith("Authorization: Bearer ") for a in args):
    code = 401
# 模拟 Firefly III 真实行为：/api/v1/about 缺 Accept: application/json 头
# 返回 302 重定向（2026-09 生产实测），带上才得到 401/200 的 API 语义。
if url and code != 0 and url.startswith("http://127.0.0.1:18080/api/") and not any(
        a.startswith("Accept: application/json") for a in args):
    code = 302
if "-w" in args:
    print(f"{code:03d}")
    sys.exit(0)
fail_on_error = "-f" in args or any(a.startswith("-") and "f" in a[1:] for a in args)
sf_mode = "-sf" in args or any(a.startswith("-") and set("sf") <= set(a[1:]) for a in args)
if code == 0:
    sys.exit(7)
if fail_on_error and code >= 400:
    sys.exit(22)
if sf_mode and code != 200:
    sys.exit(22)
print(spec.get("body", ""))
'''

DOCKER_FAKE = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if args[:1] == ["compose"]:
    if "exec" in args:
        sys.exit(0)
    print("NAMES TABLE")
    sys.exit(0)
if args[:1] == ["ps"]:
    print(os.environ.get("FAKE_DOCKER_PS", ""))
sys.exit(0)
'''

SYSTEMCTL_FAKE = r'''#!/bin/bash
if [ "${FAKE_SYSTEMCTL_ACTIVE:-1}" = "1" ]; then exit 0; else exit 3; fi
'''

JOURNALCTL_FAKE = '#!/bin/bash\nexit 0\n'
DF_FAKE = '#!/bin/bash\necho "Filesystem 512000000 414720000 97280000 45% /"\n'
FREE_FAKE = '#!/bin/bash\necho "Mem: 4 Gi"\n'
SWAPON_FAKE = '#!/bin/bash\nexit 0\n'
HERMES_FAKE = '#!/usr/bin/env python3\nimport os, sys\nopen(os.environ["FAKE_HERMES_LOG"], "a").write(" ".join(sys.argv[1:]) + "\\n")\n'


def _make_fakebin(tmp_path: Path) -> Path:
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    scripts = {
        "curl": CURL_FAKE, "docker": DOCKER_FAKE, "systemctl": SYSTEMCTL_FAKE,
        "journalctl": JOURNALCTL_FAKE, "df": DF_FAKE, "free": FREE_FAKE,
        "swapon": SWAPON_FAKE, "hermes": HERMES_FAKE,
    }
    for name, body in scripts.items():
        p = fakebin / name
        p.write_text(body)
        p.chmod(0o755)
    os.symlink(sys.executable, fakebin / "python3")
    return fakebin


RECORD_URL = "http://127.0.0.1:18711/v1/jobs/record"


def _healthy_fresh() -> dict:
    return {"status": "healthy",
            "jobs": [{"job_name": "firefly_cron", "state": "healthy", "is_stale": False}]}


def _fx_health_body(status: str, req_status: str = "ok",
                    stale: list[str] | None = None) -> dict:
    """真实 Bridge 响应形态：fx_freshness + fx_required_currency_staleness（AUD-26）。

    后者是独立检查项，巡检会单独消费它；测试替身必须一并提供，否则巡检按
    「无法核验」判 FAIL（这正是生产上"检查项存在但巡检没消费"缺口的镜像）。
    """
    return {"status": status if status != "ok" else "ok",
            "checks": {
                "fx_freshness": {"status": status, "detail": {"stale_days": 0}},
                "fx_required_currency_staleness": {
                    "status": req_status,
                    "detail": {"applicable": True, "stale_currencies": stale or []},
                },
            }}


def _run_health_check(tmp_path: Path, *, firefly_code: int, fresh: dict,
                      hermes_active: int = 1, docker_ps: str | None = None,
                      alert_enabled: str = "1", fresh_code: int = 200,
                      record_token: str | None = "test-token", record_code: int = 200,
                      fx_report: dict | None = "default", fx_code: int = 200):
    fakebin = _make_fakebin(tmp_path)
    hermes_log = tmp_path / "hermes-alerts.log"
    hermes_log.write_text("")
    containers = "\n".join([
        "personal-treasury-bridge-1", "personal-treasury-cron-1",
        "personal-treasury-firefly-1", "personal-treasury-db-1",
        "personal-treasury-report-web-1", "personal-treasury-cloudflared-1",
    ]) if docker_ps is None else docker_ps
    env = os.environ.copy()
    # RV-01：先清除可影响投递/记录路径的继承变量，再固定测试替身。
    for _k in ("HERMES_BIN", "BRIDGE_INTERNAL_TOKEN", "BRIDGE_BASE_URL",
               "HERMES_HOME", "FEISHU_DIGEST_CHANNEL", "DIGEST_STATE_DIR"):
        env.pop(_k, None)
    env.update({
        "PATH": f"{fakebin}:{env['PATH']}",
        "REPO_ROOT": str(REPO_ROOT),
        "HERMES_BIN": str(fakebin / "hermes"),
        "FAKE_HERMES_LOG": str(hermes_log),
        "FAKE_SYSTEMCTL_ACTIVE": str(hermes_active),
        "FAKE_DOCKER_PS": containers,
        "PATROL_ALERT_ENABLED": alert_enabled,
        "BRIDGE_BASE_URL": "http://127.0.0.1:18711/v1",
    })
    if record_token is not None:
        env["BRIDGE_INTERNAL_TOKEN"] = record_token
    fx_url = "http://127.0.0.1:18711/v1/reports/health-check"
    curl_map = {
        "http://127.0.0.1:18080/api/v1/about": {"code": firefly_code, "body": "{}"},
        "http://127.0.0.1:18711/healthz": {"code": 200, "body": '{"status":"ok"}'},
        "http://127.0.0.1:18711/health/freshness": {"code": fresh_code, "body": json.dumps(fresh)},
        RECORD_URL: {"code": record_code, "body": "{}"},
    }
    if fx_report == "default":
        curl_map[fx_url] = {"code": 200, "body": json.dumps(_fx_health_body("ok"))}
    elif fx_report is not None:
        curl_map[fx_url] = {"code": fx_code, "body": json.dumps(fx_report)}
    env["FAKE_CURL_MAP"] = json.dumps(curl_map)
    proc = subprocess.run(["bash", str(HEALTH_CHECK)], env=env,
                          capture_output=True, text=True, timeout=60)
    return proc, hermes_log.read_text()


def test_firefly_unauthenticated_401_is_reachable_not_fail(tmp_path):
    """未认证 401 → API 可达（OK），不产生 FAIL/告警。"""
    proc, alerts = _run_health_check(tmp_path, firefly_code=401,
                                     fresh={"status": "healthy", "jobs": []})
    assert "OK: Firefly API 可达（未认证探测 401" in proc.stdout
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Firefly" not in alerts


def test_firefly_genuine_302_still_fails(tmp_path):
    """带正确 Accept 头仍返回 302（非 API 语义）→ RV-07 兜底 FAIL + 告警。
    缺头场景由 fake curl 的 Accept 强制规则覆盖：脚本一旦漏发该头，
    Firefly 探测整体退化为 302 FAIL（生产实测行为）。"""
    proc, alerts = _run_health_check(tmp_path, firefly_code=302,
                                     fresh={"status": "healthy", "jobs": []})
    assert "FAIL: Firefly API 异常 302" in proc.stdout, proc.stdout
    assert proc.returncode != 0
    assert "Firefly API unhealthy (HTTP 302)" in alerts


def test_firefly_unreachable_000_fails_with_alert(tmp_path):
    """连接失败 000 → FAIL + 告警（与未认证语义区分）。"""
    proc, alerts = _run_health_check(tmp_path, firefly_code=0,
                                     fresh={"status": "healthy", "jobs": []})
    assert "FAIL: Firefly 不可达" in proc.stdout
    assert proc.returncode != 0
    assert "Firefly unreachable" in alerts


def test_hermes_active_does_not_claim_mcp_usable(tmp_path):
    """Hermes 服务存活 → OK 但显式注明不判定 MCP 可用（不冒充验证）。"""
    proc, _ = _run_health_check(tmp_path, firefly_code=401,
                                fresh={"status": "healthy", "jobs": []})
    assert "OK: Hermes service active" in proc.stdout
    assert "MCP 工具可用性不由此判定" in proc.stdout
    assert proc.returncode == 0


def test_hermes_inactive_fails_with_alert(tmp_path):
    proc, alerts = _run_health_check(tmp_path, firefly_code=401,
                                     fresh={"status": "healthy", "jobs": []},
                                     hermes_active=0)
    assert "FAIL: Hermes not active" in proc.stdout
    assert proc.returncode != 0
    assert "Hermes gateway service not active" in alerts


def test_freshness_degraded_lists_stale_jobs_and_alerts(tmp_path):
    """原 watchdog 职责：freshness 非 healthy → 列出 stale 任务并告警。"""
    proc, alerts = _run_health_check(
        tmp_path, firefly_code=401,
        fresh={"status": "degraded", "jobs": [{"job_name": "daily_digest", "is_stale": True}]})
    assert proc.returncode != 0
    assert "daily_digest" in proc.stdout
    assert "Stale jobs: daily_digest" in alerts


def test_missing_required_container_fails_with_alert(tmp_path):
    proc, alerts = _run_health_check(
        tmp_path, firefly_code=401, fresh={"status": "healthy", "jobs": []},
        docker_ps="\n".join([
            "personal-treasury-bridge-1", "personal-treasury-cron-1",
            "personal-treasury-firefly-1", "personal-treasury-db-1",
            "personal-treasury-cloudflared-1",
        ]))
    assert "personal-treasury-report-web-1 NOT running" in proc.stdout
    assert proc.returncode != 0
    assert "personal-treasury-report-web-1 is NOT running" in alerts


def test_alerts_not_sent_without_explicit_enable(tmp_path):
    """回归锁定：未显式设 PATROL_ALERT_ENABLED=1 时零真实投递
    （WP03 教训：本地手工执行曾误经本机 hermes 凭据发真实飞书消息）。"""
    proc, alerts = _run_health_check(tmp_path, firefly_code=0,
                                     fresh={"status": "healthy", "jobs": []},
                                     alert_enabled="0")
    assert "PATROL_ALERT_ENABLED!=1" in proc.stderr
    assert alerts == ""  # RV-01：未启用时发送次数为零


def test_parent_hermes_bin_cannot_escape_fakebin(tmp_path, monkeypatch):
    """RV-01：父环境 HERMES_BIN 指向外部假程序 → 仍只能调用测试替身。"""
    outside_log = tmp_path / "outside-hermes.log"
    outside_log.write_text("")
    outside = tmp_path / "outside-hermes"
    outside.write_text(
        '#!/usr/bin/env python3\nimport sys\n'
        f'open(r"{outside_log}", "a").write(" ".join(sys.argv[1:]) + "\\n")\n'
    )
    outside.chmod(0o755)
    monkeypatch.setenv("HERMES_BIN", str(outside))
    proc, alerts = _run_health_check(tmp_path, firefly_code=0,
                                     fresh={"status": "healthy", "jobs": []})
    assert proc.returncode != 0
    assert outside_log.read_text() == ""       # 外部程序零调用
    assert "Firefly unreachable" in alerts     # 测试替身仍被调用


# ---------------------------------------------------------------------------
# RV-07：故障判定矩阵（401/403 可达；500/超时/非200 FAIL；记录检错）
# ---------------------------------------------------------------------------

def test_firefly_500_fails(tmp_path):
    """RV-07：Firefly 500 → FAIL + 告警（业务端点错误≠可达）。"""
    proc, alerts = _run_health_check(tmp_path, firefly_code=500,
                                     fresh=_healthy_fresh())
    assert proc.returncode != 0
    assert "500" in proc.stdout
    assert "Firefly" in alerts


def test_firefly_403_is_reachable(tmp_path):
    """RV-07：403 与 401 同义 → 可达，不 FAIL（不恢复旧误判）。"""
    proc, _ = _run_health_check(tmp_path, firefly_code=403,
                                fresh=_healthy_fresh())
    assert proc.returncode == 0


def test_freshness_non200_fails(tmp_path):
    """RV-07：freshness 端点 500 → FAIL + 告警（无法核验≠健康）。"""
    proc, alerts = _run_health_check(tmp_path, firefly_code=401,
                                     fresh=_healthy_fresh(), fresh_code=500)
    assert proc.returncode != 0
    assert "Freshness" in alerts


def test_record_post_http_error_reported_not_fatal(tmp_path):
    """RV-07：记录 POST 500 → 报告记录失败但不改变巡检退出码。"""
    proc, _ = _run_health_check(tmp_path, firefly_code=401,
                                fresh=_healthy_fresh(),
                                record_token="t", record_code=500)
    assert proc.returncode == 0
    assert "failed to record" in proc.stdout


def test_record_post_success_logged(tmp_path):
    """RV-07 对照：记录 POST 200 → 成功日志，退出码仍 0。"""
    proc, _ = _run_health_check(tmp_path, firefly_code=401,
                                fresh=_healthy_fresh(),
                                record_token="t", record_code=200)
    assert proc.returncode == 0
    assert "PATROL RECORD: success" in proc.stdout


# ---------------------------------------------------------------------------
# RV-03：巡检自身结果不成为自身判定的循环输入
# ---------------------------------------------------------------------------

def _fresh_with_self(self_state: str | None):
    jobs = [{"job_name": "firefly_cron", "state": "healthy", "is_stale": False}]
    if self_state is not None:
        jobs.append({"job_name": "patrol_health_check", "state": self_state,
                     "is_stale": self_state in ("stale", "failed")})
    status = "healthy" if all(j["state"] == "healthy" for j in jobs) else "degraded"
    return {"status": status, "jobs": jobs}


def test_patrol_first_run_without_self_record_passes(tmp_path):
    """RV-03 链1：首次上线无自身记录 → 本轮 PASS。"""
    proc, _ = _run_health_check(tmp_path, firefly_code=401,
                                fresh=_fresh_with_self(None))
    assert proc.returncode == 0, proc.stdout


def test_patrol_recovers_after_self_failure(tmp_path):
    """RV-03 链2：自身 failed + 其他健康 → PASS（失败后可恢复）。"""
    proc, _ = _run_health_check(tmp_path, firefly_code=401,
                                fresh=_fresh_with_self("failed"))
    assert proc.returncode == 0, proc.stdout


def test_patrol_stale_self_fails(tmp_path):
    """RV-03 链3：自身 stale → FAIL（保留停跑过期检测）。"""
    proc, _ = _run_health_check(tmp_path, firefly_code=401,
                                fresh=_fresh_with_self("stale"))
    assert proc.returncode != 0
    assert "self stale" in proc.stdout


# ---------------------------------------------------------------------------
# F4：巡检消费 fx_freshness（REL-02 收尾）——critical→FAIL，warning→WARN 不
# 计 FAIL（ECB 长假间隙属常态，digest 已有 ⚠ 入口），取不到/无法核验→FAIL
# （RV-07 口径），ok→OK。
# ---------------------------------------------------------------------------

def test_patrol_fx_freshness_ok_passes(tmp_path):
    proc, alerts = _run_health_check(tmp_path, firefly_code=401,
                                     fresh=_healthy_fresh(),
                                     fx_report=_fx_health_body("ok"))
    assert "OK: fx_freshness" in proc.stdout
    assert proc.returncode == 0, proc.stdout
    assert "fx" not in alerts.lower()


def test_patrol_fx_freshness_warning_does_not_fail(tmp_path):
    """warning（5–10 天，如圣诞连休）→ 记录 WARN 但本轮巡检 PASS。"""
    proc, alerts = _run_health_check(tmp_path, firefly_code=401,
                                     fresh=_healthy_fresh(),
                                     fx_report=_fx_health_body("warning"))
    assert "WARN: fx_freshness" in proc.stdout
    assert proc.returncode == 0, proc.stdout
    assert alerts == ""


def test_patrol_fx_freshness_critical_fails_with_alert(tmp_path):
    proc, alerts = _run_health_check(tmp_path, firefly_code=401,
                                     fresh=_healthy_fresh(),
                                     fx_report=_fx_health_body("critical"))
    assert "FAIL: fx_freshness" in proc.stdout
    assert proc.returncode != 0
    assert "fx_freshness" in alerts


def test_patrol_fx_freshness_endpoint_unreachable_fails(tmp_path):
    """RV-07 口径：无法核验不得记成巡检成功 → FAIL + 告警。"""
    proc, alerts = _run_health_check(tmp_path, firefly_code=401,
                                     fresh=_healthy_fresh(), fx_report=None)
    assert "FAIL" in proc.stdout and "fx" in proc.stdout.lower()
    assert proc.returncode != 0
    assert "fx" in alerts.lower()


def test_patrol_fx_freshness_missing_check_fails(tmp_path):
    """200 但响应缺 fx_freshness 项 → 无法核验，FAIL。"""
    proc, _ = _run_health_check(tmp_path, firefly_code=401,
                                fresh=_healthy_fresh(),
                                fx_report={"status": "ok", "checks": {}})
    assert proc.returncode != 0


def test_patrol_fx_freshness_skipped_without_token(tmp_path):
    """BRIDGE_INTERNAL_TOKEN 未设置（本地/开发）→ NOTE 显式跳过，不冒充核验、不计 FAIL。"""
    proc, _ = _run_health_check(tmp_path, firefly_code=401,
                                fresh=_healthy_fresh(), record_token=None)
    assert "NOTE: BRIDGE_INTERNAL_TOKEN 未设置" in proc.stdout
    assert "OK: fx_freshness" not in proc.stdout
    assert "FAIL" not in proc.stdout
    assert proc.returncode == 0, proc.stdout + proc.stderr
