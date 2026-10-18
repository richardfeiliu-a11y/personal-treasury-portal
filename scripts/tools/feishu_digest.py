#!/usr/bin/env python3
"""Personal Treasury 每日飞书日报 —— 生成步骤（WP02）。

职责拆分（D01：systemd 唯一调度者，生成与投递分开记录）：
  1. 本脚本只负责「生成」：调 Bridge 内部只读接口 → 中文日报文本 →
     写入状态目录 `<DIGEST_STATE_DIR>/<业务日>.txt` 并回显 stdout。
  2. 「投递」由 scripts/tools/deliver_feishu_digest.py 负责（systemd
     ExecStartPost 串联），以真实回执为准；生成失败时投递不会运行，
     也不得投递任何历史内容。

接口契约（R02 修复）：资产负债走现行 /reports/personal-balance-sheet
（旧 /reports/net-worth 已随消融审查移除，禁止回归）；业务日期显式按
Europe/Berlin 解析，禁止混用服务器 date.today() 与 UTC 日期。

用法（服务器，由 personal-treasury-feishu-digest.service 调用）：
    python3 scripts/tools/feishu_digest.py [--dry-run] [--business-date YYYY-MM-DD]
    --dry-run 只打印日报文本，不写状态文件；--business-date 仅排查用。
退出码：0 生成成功；1 生成失败（任何接口错误/结构异常）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from collections.abc import Callable
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

BRIDGE_BASE = os.environ.get("BRIDGE_BASE_URL", "http://127.0.0.1:18711/v1")
TOKEN = os.environ.get("BRIDGE_INTERNAL_TOKEN", "")
BERLIN = ZoneInfo("Europe/Berlin")
DEFAULT_STATE_DIR = "/var/lib/personal-treasury-digest"


def fetch(path: str) -> dict[str, Any]:
    """调 Bridge 内部接口（GET，Bearer 认证）。"""
    req = urllib.request.Request(
        f"{BRIDGE_BASE}{path}",
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def resolve_business_date(now: datetime | None = None) -> date:
    """显式 Europe/Berlin 业务日。

    naive 输入按 UTC 解释（服务器本地时区 +08:00 不得参与金融日期）；
    月末/夏令时边界行为由测试矩阵锁定（tests/finance_bridge/test_feishu_digest.py）。
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(BERLIN).date()


def _fmt_money(v: Any) -> str:
    """金额：千分位 + 两位小数；None/非法值 → 缺失语义「—」，不造零。"""
    if v is None:
        return "—"
    try:
        return f"{float(v):,.2f}"
    except (TypeError, ValueError):
        return str(v)


def _fmt_pct(v: Any) -> str:
    """百分比：一位小数（与金额格式分开，避免 40.0 变成 40.00）。"""
    if v is None:
        return "—"
    try:
        return f"{float(v):.1f}"
    except (TypeError, ValueError):
        return str(v)


def _pending_draft_count(drafts: dict[str, Any]) -> int:
    return sum(
        1 for d in drafts.get("drafts", [])
        if d.get("status") not in ("posted", "cancelled")
    )


def build_digest(
    balance: dict[str, Any],
    pnl: dict[str, Any],
    drafts: dict[str, Any],
    health: dict[str, Any],
    business_date: date,
) -> str:
    """把各接口数据格式化为飞书日报文本（纯函数，便于测试）。

    balance 为 /reports/personal-balance-sheet 响应：summary 折算总额
    缺汇率时为 null（fail-closed），此处显示「—」并标注不完整，不得
    回退 1:1 或 0。
    """
    summary = balance.get("summary") or {}
    fx_ok = bool(balance.get("fx_complete"))
    missing = balance.get("missing_currencies") or []

    lines = [
        "📊 Personal Treasury 每日简报",
        f"日期：{business_date.isoformat()}",
        "",
        "净资产：",
        (
            f"净资产 {_fmt_money(summary.get('net_worth_base'))} {balance.get('base_currency', 'CNY')}"
            f"（资产 {_fmt_money(summary.get('total_assets_base'))} / 负债 {_fmt_money(summary.get('total_liabilities_base'))}）"
        ),
        f"汇率完整性：{'✅' if fx_ok else '⚠️ 不完整'}",
    ]
    if not fx_ok and missing:
        lines.append(f"缺失汇率币种：{'、'.join(missing)}")
    lines += [
        "",
        "本月收支：",
    ]
    s = (pnl.get("summary") or {})
    lines.append(f"收入 {_fmt_money(s.get('total_income_cny'))} CNY")
    lines.append(f"支出 {_fmt_money(s.get('total_expenses_cny'))} CNY")
    lines.append(f"结余 {_fmt_money(s.get('net_result_cny'))} CNY")
    lines.append(f"储蓄率 {_fmt_pct(s.get('savings_rate_pct'))}%")
    lines.append("")
    pending = _pending_draft_count(drafts)
    lines.append(f"待办：待确认草稿 {pending} 条")
    lines.append("")
    lines.append(f"健康检查：{health.get('status')}")
    for name, check in (health.get("checks") or {}).items():
        if check.get("status") != "ok":
            detail = check.get("detail") or {}
            if isinstance(detail, dict) and "duplicate_groups_count" in detail:
                lines.append(f"⚠ {name}: 疑似重复 {detail['duplicate_groups_count']} 组")
            else:
                lines.append(f"⚠ {name}: {check.get('status')}")
    return "\n".join(lines)


def generate_digest(business_date: date, fetch_fn: Callable[[str], dict[str, Any]] | None = None) -> str:
    """按业务日拉取现行只读接口并生成日报文本。

    请求契约由测试锁定：personal-balance-sheet（as_of=业务日）、
    income-statement（业务日所在月）、recent-drafts、health-check；
    不再调用已移除的 /reports/net-worth。任何接口失败向上传播，
    由调用方保证「生成失败不发送」。
    """
    if fetch_fn is None:
        fetch_fn = globals()["fetch"]  # 调用时解析，允许测试替换入口 fetch
    day = business_date.isoformat()
    month_start = day[:8] + "01"
    balance = fetch_fn(f"/reports/personal-balance-sheet?as_of={day}")
    pnl = fetch_fn(
        f"/reports/income-statement?start_date={month_start}&end_date={day}&accounting_view=management"
    )
    drafts = fetch_fn("/reports/recent-drafts?limit=100")
    health = fetch_fn("/reports/health-check")
    return build_digest(balance, pnl, drafts, health, business_date)


def record_job_outcome(job_name: str, status: str, reason: str | None = None) -> None:
    """best-effort 向 Bridge 内部 /v1/jobs/record 记录任务结果（WP04 接入）。

    记录失败只打 stderr，不影响生成/投递本身的退出码——任务状态链路
    自身的健康由 patrol 的 freshness 检查兜底。
    """
    import urllib.error

    if not TOKEN:
        print("job record skipped: BRIDGE_INTERNAL_TOKEN not set", file=sys.stderr)
        return
    body = json.dumps({"job_name": job_name, "status": status, "reason": reason}).encode()
    req = urllib.request.Request(
        f"{BRIDGE_BASE}/jobs/record",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception:  # 记录失败不掩盖主流程结果（BLE001 见 finance_bridge/pyproject.toml 豁免）
        print("job record failed（见上游日志，不回显异常原文防凭据形态）", file=sys.stderr)


def write_generated(state_dir: Path, business_date: date, text: str) -> Path:
    """把生成结果落盘为 `<业务日>.txt`（0600，内容不含凭据）。"""
    state_dir.mkdir(parents=True, exist_ok=True)
    out = state_dir / f"{business_date.isoformat()}.txt"
    out.write_text(text, encoding="utf-8")
    out.chmod(0o600)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Personal Treasury 每日飞书日报（生成步骤）")
    parser.add_argument("--dry-run", action="store_true", help="只打印文本，不写状态文件")
    parser.add_argument("--business-date", help="YYYY-MM-DD，覆盖业务日（仅排查用，默认按柏林时区解析当前时刻）")
    args = parser.parse_args(argv)

    if args.business_date:
        business_date = date.fromisoformat(args.business_date)
    else:
        business_date = resolve_business_date()

    try:
        text = generate_digest(business_date)
    except (RuntimeError, OSError, ValueError) as exc:
        import traceback
        traceback.print_exc()
        if not args.dry_run:
            record_job_outcome("feishu_digest_generate", "failure",
                               f"{type(exc).__name__}: {exc}")
        return 1

    if args.dry_run:
        print(text)
        return 0

    state_dir = Path(os.environ.get("DIGEST_STATE_DIR", DEFAULT_STATE_DIR))
    try:
        out = write_generated(state_dir, business_date, text)
    except OSError as exc:
        record_job_outcome("feishu_digest_generate", "failure",
                           f"write_failed: {exc}")
        raise
    print(text)
    print(f"digest written: {out}", file=sys.stderr)
    record_job_outcome("feishu_digest_generate", "success")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
