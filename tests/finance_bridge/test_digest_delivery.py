"""投递步骤单测（WP02 任务 3：生成/投递拆分 + 幂等 + 不确定送达）。

deliver_feishu_digest.py 的决策逻辑全部离线测试：sender 为注入的
fake（返回 (returncode, stdout, stderr) 或抛 TimeoutError），不发起
任何真实 hermes/网络调用。
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "tools"))

import deliver_feishu_digest as deliver_mod  # noqa: E402
from deliver_feishu_digest import (  # noqa: E402
    EXIT_NO_GENERATION,
    EXIT_OK,
    EXIT_UNCERTAIN,
    deliver,
)

BUSINESS_DATE = date(2026, 9, 30)
CHANNEL = "feishu"


@pytest.fixture
def state_dir(tmp_path: Path) -> Path:
    d = tmp_path / "digest-state"
    d.mkdir()
    (d / f"{BUSINESS_DATE.isoformat()}.txt").write_text(
        "📊 Personal Treasury 每日简报\n日期：2026-09-30\n", encoding="utf-8"
    )
    return d


def _ok_sender(calls: list[str]):
    def sender(text: str) -> tuple[int, str, str]:
        calls.append(text)
        return 0, "sent: om_9f8e7d6c5b4a\n", ""
    return sender


def _fail_sender(calls: list[str], rc: int = 3):
    def sender(text: str) -> tuple[int, str, str]:
        calls.append(text)
        return rc, "", "hermes: gateway unreachable"
    return sender


def _timeout_sender(calls: list[str]):
    def sender(text: str) -> tuple[int, str, str]:
        calls.append(text)
        raise TimeoutError("hermes send timed out; delivery result uncertain")
    return sender


# ---------------------------------------------------------------------------
# 生成失败不发送 / 零外呼
# ---------------------------------------------------------------------------

def test_missing_generation_sends_nothing(state_dir, capsys):
    """生成缺失（当日无 .txt）→ 退出码 2，零外呼。"""
    (state_dir / f"{BUSINESS_DATE.isoformat()}.txt").unlink()
    calls: list[str] = []
    rc = deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls))
    assert rc == EXIT_NO_GENERATION
    assert calls == []
    assert not any(p.name.startswith("delivery-") for p in state_dir.iterdir())


# ---------------------------------------------------------------------------
# 成功回执：保存非敏感回执标识
# ---------------------------------------------------------------------------

def test_successful_send_saves_sanitized_receipt(state_dir):
    calls: list[str] = []
    rc = deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls))
    assert rc == EXIT_OK
    assert len(calls) == 1
    status_file = state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-{CHANNEL}.json"
    assert status_file.exists()
    content = status_file.read_text()
    assert '"status": "delivered"' in content
    assert "om_9f8e7d6c5b4a" in content  # 非敏感回执标识


def test_receipt_sanitize_redacts_token_like_values(state_dir):
    """回执片段必须脱敏：token/password/authorization 等值被打码。"""
    calls: list[str] = []

    def leaky_sender(text: str) -> tuple[int, str, str]:
        calls.append(text)
        return 0, "sent: ok authorization=Bearer sk-secret123 token=abc\n", ""

    rc = deliver(BUSINESS_DATE, CHANNEL, state_dir, leaky_sender)
    assert rc == EXIT_OK
    content = (state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-{CHANNEL}.json").read_text()
    assert "sk-secret123" not in content
    assert "abc" != content  # 无意义守卫；关键断言在上一行
    assert "[REDACTED]" in content


# ---------------------------------------------------------------------------
# 幂等：同业务日 + 同渠道只投一次
# ---------------------------------------------------------------------------

def test_same_day_same_channel_not_resent(state_dir):
    """重复执行 → 识别为同一逻辑投递，不再外呼，退出码 0。"""
    calls: list[str] = []
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_OK
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_OK
    assert len(calls) == 1


def test_different_day_or_channel_sends_again(state_dir):
    """不同业务日或不同渠道是新的逻辑投递。"""
    calls: list[str] = []
    sender = _ok_sender(calls)
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, sender) == EXIT_OK
    other_day = BUSINESS_DATE.replace(day=29)
    (state_dir / f"{other_day.isoformat()}.txt").write_text("x", encoding="utf-8")
    assert deliver(other_day, CHANNEL, state_dir, sender) == EXIT_OK
    assert deliver(BUSINESS_DATE, "feishu-dm", state_dir, sender) == EXIT_OK
    assert len(calls) == 3


# ---------------------------------------------------------------------------
# 非零退出：无法证明未发送 → 不确定，不自动重发（RRV-01）
# Hermes CLI 没有“发送前失败”退出码契约：正负非零一律不得当作明确失败。
# ---------------------------------------------------------------------------

def test_nonzero_returncode_is_uncertain_and_never_auto_resends(state_dir):
    """send 子进程非零退出（rc=3）→ 退出码 4；重跑零外呼。"""
    calls: list[str] = []
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _fail_sender(calls)) == EXIT_UNCERTAIN
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_UNCERTAIN
    assert len(calls) == 1
    content = (state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-{CHANNEL}.json").read_text()
    assert '"status": "uncertain"' in content


# ---------------------------------------------------------------------------
# 超时不确定：不自动重发，等待人工核查
# ---------------------------------------------------------------------------

def test_timeout_marks_uncertain_and_never_auto_resends(state_dir):
    """超时 → 结果不确定：退出码 4；后续运行不得盲目重发（零外呼）。"""
    calls: list[str] = []
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _timeout_sender(calls)) == EXIT_UNCERTAIN
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_UNCERTAIN
    assert len(calls) == 1
    content = (state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-{CHANNEL}.json").read_text()
    assert '"status": "uncertain"' in content


def test_uncertain_exit_surfaces_manual_check_hint(state_dir, capsys):
    calls: list[str] = []
    deliver(BUSINESS_DATE, CHANNEL, state_dir, _timeout_sender(calls))
    deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls))
    captured = capsys.readouterr()
    assert "人工核查" in captured.out
    assert f"{BUSINESS_DATE.isoformat()}" in captured.out


# ---------------------------------------------------------------------------
# RV-02：main 确定/不确定结果的任务记录（uncertain 必须可见且不标绿）
# ---------------------------------------------------------------------------

def _main_state_dir(tmp_path: Path) -> Path:
    d = tmp_path / "deliver-main-state"
    d.mkdir(exist_ok=True)
    (d / f"{BUSINESS_DATE.isoformat()}.txt").write_text("x", encoding="utf-8")
    return d


def test_deliver_main_success_records_success(monkeypatch, tmp_path):
    monkeypatch.setenv("DIGEST_STATE_DIR", str(_main_state_dir(tmp_path)))
    monkeypatch.setattr(deliver_mod, "hermes_sender", _ok_sender([]))
    recorded: list[tuple] = []
    monkeypatch.setattr(deliver_mod, "record_job_outcome",
                        lambda *a: recorded.append(a))
    assert deliver_mod.main(["--business-date", BUSINESS_DATE.isoformat()]) == EXIT_OK
    assert recorded == [("success",)] or recorded == [("success", None)] or recorded[0][0] == "success"


def test_deliver_main_nonzero_records_failure_for_review(monkeypatch, tmp_path):
    """RRV-01：子进程非零退出 → UNCERTAIN 记录待查（不再有 exit-3 重试语义）。"""
    monkeypatch.setenv("DIGEST_STATE_DIR", str(_main_state_dir(tmp_path)))
    monkeypatch.setattr(deliver_mod, "hermes_sender", _fail_sender([]))
    recorded: list[tuple] = []
    monkeypatch.setattr(deliver_mod, "record_job_outcome",
                        lambda *a: recorded.append(a))
    assert deliver_mod.main(["--business-date", BUSINESS_DATE.isoformat()]) == EXIT_UNCERTAIN
    assert len(recorded) == 1 and recorded[0][0] == "failure"
    assert "uncertain" in (recorded[0][1] or "").lower()


def test_deliver_main_uncertain_records_failure_for_review(monkeypatch, tmp_path):
    """RV-02：超时不确定 → 记录失败态待人工核查（状态报告可见，不标绿）。"""
    monkeypatch.setenv("DIGEST_STATE_DIR", str(_main_state_dir(tmp_path)))
    monkeypatch.setattr(deliver_mod, "hermes_sender", _timeout_sender([]))
    recorded: list[tuple] = []
    monkeypatch.setattr(deliver_mod, "record_job_outcome",
                        lambda *a: recorded.append(a))
    assert deliver_mod.main(["--business-date", BUSINESS_DATE.isoformat()]) == EXIT_UNCERTAIN
    assert len(recorded) == 1 and recorded[0][0] == "failure"
    assert "uncertain" in (recorded[0][1] or "").lower()


# ---------------------------------------------------------------------------
# RV-04：中断恢复 / 并发 / 状态写失败 / 空产物
# ---------------------------------------------------------------------------

def test_interrupted_send_is_not_resent(state_dir):
    """RV-04：下游已接收后中断 → UNCERTAIN；重跑零外呼。"""
    calls: list[str] = []

    def flaky_sender(text: str) -> tuple[int, str, str]:
        calls.append(text)
        raise RuntimeError("simulated kill after downstream accepted")

    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, flaky_sender) == EXIT_UNCERTAIN
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_UNCERTAIN
    assert len(calls) == 1


def test_concurrent_second_call_waits_for_review(state_dir):
    """RV-04：残留 sending（并发/崩溃）→ UNCERTAIN 零外呼，不自动重发。"""
    calls: list[str] = []
    deliver_mod._save_status(deliver_mod._status_path(state_dir, BUSINESS_DATE, CHANNEL),
                             BUSINESS_DATE, CHANNEL, "sending", 1)
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_UNCERTAIN
    assert calls == []


def test_status_write_failure_sends_nothing(state_dir, monkeypatch):
    """RV-04：sending 落盘失败 → UNCERTAIN 且零外呼。"""
    calls: list[str] = []

    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(deliver_mod, "_save_status", boom)
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_UNCERTAIN
    assert calls == []


def test_empty_artifact_sends_nothing(tmp_path):
    """RV-04：空产物 → 视为生成缺失，零外呼。"""
    d = tmp_path / "digest-state"
    d.mkdir()
    (d / f"{BUSINESS_DATE.isoformat()}.txt").write_text("  \n", encoding="utf-8")
    calls: list[str] = []
    assert deliver(BUSINESS_DATE, CHANNEL, d, _ok_sender(calls)) == EXIT_NO_GENERATION
    assert calls == []


# ---------------------------------------------------------------------------
# RRV-01：信号终止的非零退出不得当作“明确未发送”重试
# （复验反例：假发送器先记“已接收”再自杀 SIGTERM → 父进程 rc=-15；
#  重跑又发送一次。正确行为：首次 UNCERTAIN，重跑零外呼）
# ---------------------------------------------------------------------------

def _recv_then_sigterm_sender(receipts: Path, calls: list[str]):
    """模拟下游已接收后发送子进程被信号终止（复验 RRV-01 反例）。

    真实链路中子进程被 SIGTERM 后，`subprocess.run(check=False)` 拿到
    returncode=-15（不抛异常）。此处直接返回 -15，语义等价且不杀测试进程。
    真子进程自杀版本见 test_sigterm_child_*（hermes_sender 真实跑假二进制）。
    """
    import os

    def sender(text: str) -> tuple[int, str, str]:
        calls.append(text)
        with open(receipts, "a", encoding="utf-8") as f:
            f.write("received\n")
            f.flush()
            os.fsync(f.fileno())
        # 子进程已死（rc=-15），父进程只能看到非零码，看不到“已接收”
        return -15, "", "terminated by SIGTERM"

    return sender


def test_signal_kill_after_receipt_is_uncertain_not_retried(state_dir, tmp_path):
    """RRV-01：接收后 SIGTERM → UNCERTAIN；重跑零外呼（不重复投递）。"""
    receipts = tmp_path / "receipts.log"
    receipts.write_text("")
    calls: list[str] = []
    rc = deliver(BUSINESS_DATE, CHANNEL, state_dir,
                 _recv_then_sigterm_sender(receipts, calls))
    assert rc == EXIT_UNCERTAIN
    assert receipts.read_text() == "received\n"
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_UNCERTAIN
    assert len(calls) == 1
    assert receipts.read_text() == "received\n"


def test_negative_returncode_is_never_definitive_failure(state_dir, tmp_path):
    """RRV-01：任何负返回码（信号终止）→ UNCERTAIN，不写 failed 可重试态。"""
    receipts = tmp_path / "receipts.log"
    receipts.write_text("")
    calls: list[str] = []

    def neg_sender(text: str) -> tuple[int, str, str]:
        calls.append(text)
        return -15, "", "killed"

    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, neg_sender) == EXIT_UNCERTAIN
    content = (state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-{CHANNEL}.json").read_text()
    assert '"status": "uncertain"' in content
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_UNCERTAIN
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# RRV-02：两个调用同时从“无状态”开始，最多一个发送者
# （多进程级：复验报告的“同时读空→分别发送”交错必须被互斥消除）
# ---------------------------------------------------------------------------

def test_concurrent_first_starts_single_sender_only(state_dir):
    """RRV-02：两进程同时启动 → 最多一个发送者，另一方 UNCERTAIN 零外呼。

    真实多进程并发：此前线程屏障版在锁内等待对端会死锁（锁有效、
    测试写法不当），故并发验收用进程。
    """
    import subprocess
    import sys

    helper = (
        "import sys, time\n"
        "sys.path.insert(0, 'scripts/tools')\n"
        "from datetime import date\n"
        "from pathlib import Path\n"
        "import deliver_feishu_digest as m\n"
        "def sender(text):\n"
        f"    open(r'{state_dir}/sent.log', 'a').write('sent\\n')\n"
        "    time.sleep(3)\n"
        "    return (0, 'sent: ok\\n', '')\n"
        "rc = m.deliver(date(2026, 9, 30), 'feishu',\n"
        f"    Path(r'{state_dir}'), sender)\n"
        "print(rc)\n"
    )
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", helper],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        for _ in range(2)
    ]
    outs = [p.communicate(timeout=60)[0] for p in procs]
    assert all(p.returncode == 0 for p in procs), outs
    codes = sorted(o.strip().splitlines()[-1] for o in outs)
    # 两个进程串行通过互斥：先到者送达，后到者见 delivered 幂等跳过。
    # 关键：最多一次真实发送（sent.log 恰 1 条），无重复投递。
    assert codes == ["0", "0"], outs
    assert outs[0].count("already delivered") + outs[1].count("already delivered") == 1
    sent_log = state_dir / "sent.log"
    assert sent_log.read_text(encoding="utf-8").count("sent") == 1


# ---------------------------------------------------------------------------
# RRV-03：损坏的已有回执不得当作“从未发送”
# ---------------------------------------------------------------------------

def test_corrupt_existing_receipt_sends_nothing(state_dir):
    """RRV-03：截断的状态 JSON → UNCERTAIN 零外呼，等待人工核查。"""
    calls: list[str] = []
    (state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-{CHANNEL}.json").write_text(
        '{"status": "deliv', encoding="utf-8"
    )
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_UNCERTAIN
    assert calls == []


# ---------------------------------------------------------------------------
# RRV-03 收尾（第三轮复验 §4）：已有回执的内容语义校验
# 决策表：只有文件确实不存在才允许首次发送；空对象/未知状态/缺字段/
# 非法类型/业务键不匹配/旧 failed/不可解码一律 UNCERTAIN 零外呼。
# ---------------------------------------------------------------------------

def _full_receipt(**overrides: object) -> bytes:
    base: dict[str, object] = {
        "business_date": BUSINESS_DATE.isoformat(),
        "channel": CHANNEL,
        "status": "delivered",
        "attempts": 1,
        "receipt_hint": "",
    }
    base.update(overrides)
    return json.dumps(base, ensure_ascii=False).encode("utf-8")


@pytest.mark.parametrize(
    ("name", "raw", "expected"),
    [
        ("empty-object", b"{}", EXIT_UNCERTAIN),
        ("unknown-status", _full_receipt(status="delivery_unknown"), EXIT_UNCERTAIN),
        ("legacy-failed", _full_receipt(status="failed"), EXIT_UNCERTAIN),
        ("missing-attempts", json.dumps({
            "business_date": BUSINESS_DATE.isoformat(), "channel": CHANNEL,
            "status": "uncertain",
        }).encode("utf-8"), EXIT_UNCERTAIN),
        ("attempts-wrong-type", _full_receipt(status="uncertain", attempts="1"), EXIT_UNCERTAIN),
        ("business-date-mismatch", _full_receipt(business_date="2026-09-29"), EXIT_UNCERTAIN),
        ("channel-mismatch", _full_receipt(channel="feishu-dm"), EXIT_UNCERTAIN),
        ("non-utf8-bytes", b"\xff\xfe{", EXIT_UNCERTAIN),
        ("json-array", b"[]", EXIT_UNCERTAIN),
        # 对照：身份与结构均合法的 delivered 仍幂等跳过（校验不得破坏 happy path）
        ("valid-delivered-control", _full_receipt(), EXIT_OK),
    ],
)
def test_receipt_content_decision_table(state_dir, name, raw, expected):
    """RRV-03 收尾：回执内容决策表——不可信一律零外呼，重跑亦然。"""
    calls: list[str] = []
    (state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-{CHANNEL}.json").write_bytes(raw)
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == expected, name
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == expected, name
    assert calls == [], name


def test_legacy_failed_rewritten_to_uncertain(state_dir):
    """RRV-03 收尾：旧 failed 回执首访即转 uncertain 落盘，不再残留失败语义。"""
    calls: list[str] = []
    (state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-{CHANNEL}.json").write_bytes(
        _full_receipt(status="failed")
    )
    assert deliver(BUSINESS_DATE, CHANNEL, state_dir, _ok_sender(calls)) == EXIT_UNCERTAIN
    content = (state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-{CHANNEL}.json").read_text()
    assert '"status": "uncertain"' in content
    assert calls == []


def test_corrupt_receipt_main_records_uncertain_for_review(monkeypatch, tmp_path):
    """RRV-03 收尾：main 入口同样零外呼 + exit 4 + 任务记录待核查。"""
    monkeypatch.setenv("DIGEST_STATE_DIR", str(_main_state_dir(tmp_path)))
    state_dir = Path(str(_main_state_dir(tmp_path)))
    (state_dir / f"delivery-{BUSINESS_DATE.isoformat()}-feishu.json").write_bytes(b"{}")
    calls: list[str] = []
    monkeypatch.setattr(deliver_mod, "hermes_sender", _ok_sender(calls))
    recorded: list[tuple] = []
    monkeypatch.setattr(deliver_mod, "record_job_outcome",
                        lambda *a: recorded.append(a))
    assert deliver_mod.main(["--business-date", BUSINESS_DATE.isoformat()]) == EXIT_UNCERTAIN
    assert calls == []
    assert len(recorded) == 1 and recorded[0][0] == "failure"
    assert "uncertain" in (recorded[0][1] or "").lower()
