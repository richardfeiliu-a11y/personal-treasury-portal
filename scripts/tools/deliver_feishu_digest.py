#!/usr/bin/env python3
"""Personal Treasury 每日飞书日报 —— 投递步骤（WP02 任务 3）。

职责（D01：systemd 唯一调度者；生成与投递可单独失败）：
  读取生成步骤落盘的 `<DIGEST_STATE_DIR>/<业务日>.txt`，经
  `$HERMES_BIN send --to feishu -q <文本>`（与 scripts/ops/notify.sh
  相同的既有投递能力）送达，并按「业务日 + 目标渠道」保存非敏感
  回执记录，实现一次逻辑投递的幂等识别。

退出码语义（可读的人工核查出口；RRV-01 后无自动重试语义）：
  0  已送达（本次发送成功，或同业务日同渠道此前已送达——幂等跳过）
  2  生成缺失：当日无生成产物，零外呼（生成失败不发送）
  3  历史保留：Hermes CLI 无“发送前失败”契约，非零退出无法证明未送达，
     deliver() 永不返回 3（旧“明确失败可重试”语义已删除，见 RRV-01）
  4  结果不确定（发送超时、子进程非零退出、已有回执不可信、并发冲突）：
     不自动重发，等待人工核查
     （人工确认送达后按 runbook 处置状态文件；禁止盲目重发造成重复日报）

环境变量（只读名称，值由 /etc/personal-treasury/feishu-digest.env 提供）：
  HERMES_BIN          hermes 可执行文件绝对路径（必需）
  DIGEST_STATE_DIR    状态目录（默认 /var/lib/personal-treasury-digest）
  FEISHU_DIGEST_CHANNEL  目标渠道标识（默认 feishu）
  HERMES_SEND_TIMEOUT 发送超时秒数（默认 60）
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from feishu_digest import DEFAULT_STATE_DIR, resolve_business_date

EXIT_OK = 0
EXIT_NO_GENERATION = 2
# RRV-01：Hermes CLI 没有“发送前失败”的退出码契约（非零码无法证明下游
# 未接收），退出码 3 的“明确失败可重试”语义已删除。常量保留供历史状态
# 文件兼容读取，但 deliver() 永不返回它。
EXIT_SEND_FAILED = 3
EXIT_UNCERTAIN = 4

DEFAULT_CHANNEL = "feishu"
DEFAULT_SEND_TIMEOUT = 60.0
RECEIPT_HINT_MAX = 200

Sender = Callable[[str], tuple[int, str, str]]


def sanitize_receipt(text: str) -> str:
    """回执片段脱敏：常见凭据键值打码 + 凭据形态字符串打码，截断到有限长度。

    键值对打码只覆盖到第一个空白（如 `authorization=Bearer sk-...` 的
    值尾部），因此另需按形态打码：sk-/pk- 前缀令牌、长十六进制、
    长 base64 形态串一律 [REDACTED]。
    """
    redacted = text
    for word in ("token", "password", "authorization", "bearer", "secret", "key"):
        redacted = re.sub(rf"(?i){word}[=:]\s*\S+", f"{word}=[REDACTED]", redacted)
    redacted = re.sub(r"\b(?:sk|pk)[-_][A-Za-z0-9]+", "[REDACTED]", redacted)
    redacted = re.sub(r"\b[0-9a-fA-F]{16,}\b", "[REDACTED]", redacted)
    redacted = re.sub(r"\b[A-Za-z0-9+/]{24,}={0,2}\b", "[REDACTED]", redacted)
    return redacted.strip()[-RECEIPT_HINT_MAX:]


def _status_path(state_dir: Path, business_date: date, channel: str) -> Path:
    return state_dir / f"delivery-{business_date.isoformat()}-{channel}.json"


class _CorruptStatusError(Exception):
    """已有回执存在但不可读/不可解析（RRV-03：不得当作从未发送）。"""


def _load_status(path: Path) -> dict[str, Any] | None:
    """读取回执：不存在→None；存在但坏→抛 _CorruptStatusError。

    RRV-03：“文件不存在”和“已有文件损坏或不可读”必须区分；后者停止
    自动发送，等待人工核查。
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            return None
        raise _CorruptStatusError(f"status unreadable: {exc}") from exc
    except ValueError as exc:  # UnicodeDecodeError 是 ValueError 子类
        raise _CorruptStatusError(f"status undecodable: {exc}") from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise _CorruptStatusError(f"status unparsable: {exc}") from exc
    if not isinstance(data, dict):
        raise _CorruptStatusError(f"status not an object: {type(data).__name__}")
    return data


# 回执语义可信集合（RRV-03 收尾）：只有这三种状态才参与决策；
# 旧 failed 来自“任意非零退出即失败”的已删除语义，不得自动重发。
_TRUSTED_STATUSES = ("delivered", "uncertain", "sending")


def _receipt_problem(
    prior: dict[str, Any], business_date: date, channel: str
) -> str | None:
    """校验已有回执的内容语义；返回问题描述，None 表示可信。

    只有文件确实不存在才允许首次发送；空对象/未知状态（含旧 failed）/
    缺字段/非法类型/业务键不匹配一律不可信。
    """
    status = prior.get("status")
    if status not in _TRUSTED_STATUSES:
        return f"untrusted status: {status!r}"
    for key in ("business_date", "channel", "attempts"):
        if key not in prior:
            return f"missing field: {key}"
    if prior["business_date"] != business_date.isoformat():
        return f"business_date mismatch: {prior['business_date']!r}"
    if prior["channel"] != channel:
        return f"channel mismatch: {prior['channel']!r}"
    attempts = prior["attempts"]
    if isinstance(attempts, bool) or not isinstance(attempts, int):
        return f"bad attempts type: {type(attempts).__name__}"
    return None


@contextmanager
def _delivery_lock(state_dir: Path) -> Iterator[None]:
    """单机互斥：覆盖“读取→判定→占用→发送→结果写入”全程（RRV-02）。

    systemd 同一 timer 不会并发，但手工重跑/ExecStartPost 与手工调用可能
    重叠；锁文件与状态目录同盘，保证 flock 有效。锁为阻塞等待（无超时
    计时；等待时长受外层 systemd TimeoutStartSec 约束），锁文件打开失败等
    OSError → 由调用方按 uncertain 处理，不抛穿透。
    """
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / ".delivery.lock"
    with open(lock_path, "a+b") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _save_status(
    path: Path,
    business_date: date,
    channel: str,
    status: str,
    attempts: int,
    receipt_hint: str = "",
) -> None:
    """状态记录非敏感：仅状态/计数/回执片段；回滚不删除幂等记录。

    不写本地时间戳（避免服务器时区歧义），幂等以业务日+渠道为键。
    """
    payload = {
        "business_date": business_date.isoformat(),
        "channel": channel,
        "status": status,
        "attempts": attempts,
        "receipt_hint": receipt_hint,
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    path.chmod(0o600)


def hermes_sender(text: str) -> tuple[int, str, str]:
    """真实发送：复用 notify.sh 验证过的 hermes send 调用方式。"""
    hermes_bin = os.environ.get("HERMES_BIN", "hermes")
    timeout = float(os.environ.get("HERMES_SEND_TIMEOUT", str(DEFAULT_SEND_TIMEOUT)))
    try:
        proc = subprocess.run(
            [hermes_bin, "send", "--to", "feishu", "-q", text],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError("hermes send timed out; delivery result uncertain") from exc
    return proc.returncode, proc.stdout, proc.stderr


def deliver(
    business_date: date,
    channel: str,
    state_dir: Path,
    sender: Sender,
) -> int:
    """一次逻辑投递决策（纯决策 + 注入 sender，离线可测）。

    RV-04 + RRV-01/02/03：
    - 全程持单机文件锁（读取→判定→占用→发送→结果写入），锁内重读状态，
      同业务日同渠道同时最多一个发送者。
    - 发送前先持久化 ``sending``；发送已被下游接受后进程中断、中断遗留、
      并发二次调用一律进入人工核查（UNCERTAIN，零外呼），绝不自动变回未发送。
    - Hermes CLI 无“发送前失败”契约：子进程任何非零退出（含负返回码的
      信号终止）都无法证明下游未接收，一律 UNCERTAIN，不自动重发。
    - 已有回执损坏/不可读/内容不可信（旧 failed、未知状态、缺字段、
      非法类型、业务键不匹配、不可解码）→ UNCERTAIN 零外呼
      （不按从未发送处理；只有文件确实不存在才允许首次发送）。
    - CLI exit 0 只代表本次调用完成，不代表下游收达。
    """
    generated = state_dir / f"{business_date.isoformat()}.txt"
    if not generated.is_file():
        print(f"delivery skipped: no generation for {business_date.isoformat()}（生成失败不发送）")
        return EXIT_NO_GENERATION
    try:
        text = generated.read_text(encoding="utf-8")
    except OSError:
        print(
            f"delivery uncertain: {business_date.isoformat()}/{channel} "
            "生成产物不可读——未发送，等待人工核查"
        )
        return EXIT_UNCERTAIN
    if not text.strip():
        print(f"delivery skipped: empty generation for {business_date.isoformat()}（空产物零发送）")
        return EXIT_NO_GENERATION

    status_path = _status_path(state_dir, business_date, channel)
    try:
        with _delivery_lock(state_dir):
            try:
                prior = _load_status(status_path)
            except _CorruptStatusError as exc:
                print(
                    f"delivery uncertain: {business_date.isoformat()}/{channel} "
                    f"已有回执不可信（{exc}）——停止自动发送，等待人工核查"
                )
                return EXIT_UNCERTAIN
            if prior is not None:
                # RRV-03 收尾：已有回执先验内容语义；不可信（旧 failed/
                # 未知状态/缺字段/非法类型/键不匹配）→ 统一 uncertain 零外呼。
                # 旧 failed 首访即改写为 uncertain 落盘，不残留失败可重试语义。
                problem = _receipt_problem(prior, business_date, channel)
                if problem is not None:
                    try:
                        _save_status(status_path, business_date, channel, "uncertain",
                                     attempts=1, receipt_hint=f"untrusted prior: {problem}"[:RECEIPT_HINT_MAX])
                    except OSError:
                        pass
                    print(
                        f"delivery uncertain: {business_date.isoformat()}/{channel} "
                        f"已有回执不可信（{problem}）——停止自动发送，等待人工核查"
                    )
                    return EXIT_UNCERTAIN
            prior_status = (prior or {}).get("status")

            if prior_status == "delivered":
                print(f"delivery idempotent-skip: {business_date.isoformat()}/{channel} already delivered")
                return EXIT_OK
            if prior_status in ("uncertain", "sending"):
                try:
                    _save_status(status_path, business_date, channel, "uncertain",
                                 int((prior or {}).get("attempts") or 1))
                except OSError:
                    pass
                print(
                    f"delivery uncertain: {business_date.isoformat()}/{channel} "
                    "此前发送结果不确定——按 runbook 人工核查后处置，禁止自动重发"
                )
                return EXIT_UNCERTAIN

            attempts = int((prior or {}).get("attempts") or 0) + 1
            try:
                _save_status(status_path, business_date, channel, "sending", attempts)
            except OSError as exc:
                print(
                    f"delivery uncertain: {business_date.isoformat()}/{channel} "
                    f"状态落盘失败（{exc}）——未发送，等待人工核查"
                )
                return EXIT_UNCERTAIN
            try:
                returncode, stdout, _stderr = sender(text)
            except TimeoutError:
                _save_status(status_path, business_date, channel, "uncertain", attempts)
                print(
                    f"delivery uncertain: {business_date.isoformat()}/{channel} "
                    "发送超时，结果不确定——等待人工核查，不自动重发"
                )
                return EXIT_UNCERTAIN
            except (KeyboardInterrupt, SystemExit):
                # 中断语义保留，但先落 uncertain 再重抛，避免下次盲目重发
                try:
                    _save_status(status_path, business_date, channel, "uncertain", attempts)
                finally:
                    raise
            except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
                # 未知发送异常：是否送达无法判定 → 进人工核查，不自动重发
                _save_status(status_path, business_date, channel, "uncertain", attempts)
                print(
                    f"delivery uncertain: {business_date.isoformat()}/{channel} "
                    f"发送中断（{type(exc).__name__}）——等待人工核查，不自动重发"
                )
                return EXIT_UNCERTAIN

            if returncode == 0:
                _save_status(status_path, business_date, channel, "delivered", attempts,
                             receipt_hint=sanitize_receipt(stdout))
                print(f"delivery delivered: {business_date.isoformat()}/{channel} (attempt {attempts})")
                return EXIT_OK

            # RRV-01：非零退出无法证明未送达（含信号终止的负返回码）。
            # Hermes CLI 无阶段化契约，只能按不确定处理。
            _save_status(status_path, business_date, channel, "uncertain", attempts)
            print(
                f"delivery uncertain: {business_date.isoformat()}/{channel} "
                f"发送子进程非零退出（rc={returncode}）——无法证明未送达，等待人工核查，不自动重发"
            )
            return EXIT_UNCERTAIN
    except OSError as exc:
        print(
            f"delivery uncertain: {business_date.isoformat()}/{channel} "
            f"互斥保护失败（{exc}）——未发送，等待人工核查"
        )
        return EXIT_UNCERTAIN


def record_job_outcome(status: str, reason: str | None = None) -> None:
    """best-effort 向 Bridge 记录 feishu_digest_deliver 任务结果（WP04 接入）。"""
    import json
    import urllib.error
    import urllib.request

    token = os.environ.get("BRIDGE_INTERNAL_TOKEN", "")
    base = os.environ.get("BRIDGE_BASE_URL", "http://127.0.0.1:18711/v1")
    if not token:
        print("job record skipped: BRIDGE_INTERNAL_TOKEN not set", file=sys.stderr)
        return
    body = json.dumps({"job_name": "feishu_digest_deliver",
                       "status": status, "reason": reason}).encode()
    req = urllib.request.Request(
        f"{base.rstrip('/')}/jobs/record",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception:  # 记录失败不掩盖主流程结果（BLE001 见 finance_bridge/pyproject.toml 豁免）
        print("job record failed（见上游日志，不回显异常原文防凭据形态）", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Personal Treasury 每日飞书日报（投递步骤）")
    parser.add_argument("--business-date", help="YYYY-MM-DD（默认按柏林时区解析当前时刻）")
    args = parser.parse_args(argv)

    business_date = date.fromisoformat(args.business_date) if args.business_date else resolve_business_date()
    channel = os.environ.get("FEISHU_DIGEST_CHANNEL", DEFAULT_CHANNEL)
    state_dir = Path(os.environ.get("DIGEST_STATE_DIR", DEFAULT_STATE_DIR))
    rc = deliver(business_date, channel, state_dir, hermes_sender)
    # WP04 记录源（RV-02 + RRV-01）：送达记 success；不确定的「待核查」
    # （含子进程非零退出）必须在状态报告中可见且不能标绿——以失败态+
    # 明确原因呈现。生成缺失（EXIT_NO_GENERATION）不记录，避免无运行冒充结果。
    # EXIT_SEND_FAILED 仅为历史兼容保留，不再由 deliver() 返回。
    if rc == EXIT_OK:
        record_job_outcome("success")
    elif rc == EXIT_SEND_FAILED:
        record_job_outcome("failure", "hermes send returned nonzero (legacy)")
    elif rc == EXIT_UNCERTAIN:
        record_job_outcome("failure", "delivery uncertain: manual review required")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
