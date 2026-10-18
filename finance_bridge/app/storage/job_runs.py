"""Job runs storage repository for freshness tracking (WP04 六态语义).

状态枚举（healthy/failed/stale/never_succeeded/disabled/unknown）与判定
优先级是 tests/finance_bridge/test_freshness_never_run.py 的唯一依据：

1. disabled         产品态停用（REQUIRED_TASKS.enabled=False，如 investment_snapshot）
2. unknown          记录存在但不可读（时间戳非法）——不借用当前时间冒充
3. never_succeeded  有调度记录（注册/必需集合）但从未有任何运行结果
4. failed           最近一次结果为失败（含失败晚于成功——即使成功未超期）
5. healthy          最近一次成功且未超期
6. stale            成功存在但已超期未再成功

必需任务集合（REQUIRED_TASKS）即使尚无记录也必须出现在报告中——
R04 的核心缺陷是日报/巡检/Hermes 链路失败在健康摘要中隐身。
legacy 字段 never_run/is_stale 保留给现有消费方（patrol/health-check.sh）。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from finance_bridge.app.storage.sqlite import SQLiteStorage

STATES = ("healthy", "failed", "stale", "never_succeeded", "disabled", "unknown")

# 必需任务集合（WP04 初版；与 infra/runtime-entrypoints.json 的调度声明对齐）
REQUIRED_TASKS: dict[str, dict[str, Any]] = {
    "firefly_cron": {"stale_after_hours": 26, "on_calendar": "*-*-* 03:00:00 Asia/Shanghai"},
    "fx_rate_refresh": {"stale_after_hours": 36},
    "backup": {"stale_after_hours": 26, "on_calendar": "*-*-* 03:00:00 Asia/Shanghai"},
    "feishu_digest_generate": {"stale_after_hours": 30, "on_calendar": "*-*-* 18:00:00 Europe/Berlin"},
    "feishu_digest_deliver": {"stale_after_hours": 30, "on_calendar": "*-*-* 18:00:00 Europe/Berlin"},
    "patrol_health_check": {"stale_after_hours": 8, "on_calendar": "*-*-* 00/6:00:00 Europe/Berlin"},
    # 产品态停用：不启动、不告警、显示 disabled（WP04 硬约束）
    "investment_snapshot": {"stale_after_hours": 2400, "enabled": False},
}

# 仅支持仓库 unit 实际使用的 OnCalendar 形态；其余 → None（unknown，不猜测）
_ON_CALENDAR_DAILY = "*-*-* {hh:mm:ss} {tz}"
_ON_CALENDAR_EVERY_N_HOURS = "*-*-* 00/{n}:00:00 {tz}"


def _registered_threshold(job_name: str) -> int | None:
    """RV-06：REQUIRED_TASKS 是阈值的唯一权威；注册表外任务返回 None。"""
    spec = REQUIRED_TASKS.get(job_name)
    if spec and spec.get("stale_after_hours"):
        return int(spec["stale_after_hours"])
    return None


def _global_storage() -> SQLiteStorage:
    from finance_bridge.app.state import get_storage
    return get_storage()


def _now() -> str:
    # 微秒精度：秒级时间戳无法区分同一秒内的成功/失败先后（硬规则依赖序）
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse_iso(timestamp: str | None) -> datetime | None:
    if not timestamp:
        return None
    try:
        if timestamp.endswith("Z"):
            timestamp = timestamp[:-1] + "+00:00"
        return datetime.fromisoformat(timestamp)
    except Exception:
        return None


def _next_planned_from_calendar(on_calendar: str, now: datetime) -> str | None:
    """把仓库使用的两种 OnCalendar 形态解析为下次计划时刻（ISO 带时区）。

    形态：`*-*-* HH:MM:SS TZ`（每日固定时刻）与 `*-*-* 00/N:MM:SS TZ`
    （每 N 小时）。其他形态返回 None（调用方按 unknown 处理）。
    """
    try:
        spec, tz_name = on_calendar.rsplit(" ", 1)
        tz = ZoneInfo(tz_name)
        parts = spec.split(" ")  # ["*-*-*", "00/6:00:00"] 或 ["*-*-*", "18:00:00"]
        clock = parts[-1]  # "*-*-*" 之后的 HH:MM:SS
        local_now = now.astimezone(tz)
        # RV-06：先判定语法形态再解析数字（"00/6" 不得整体 int）。
        if len(parts) >= 2 and "/" in parts[1]:
            n = int(parts[1].split(":", 1)[0].split("/")[1])
            mm, ss = (int(x) for x in clock.split(":")[1:])
            anchor = local_now.replace(hour=(local_now.hour // n) * n, minute=mm,
                                       second=ss, microsecond=0)
            while anchor <= local_now:
                anchor += timedelta(hours=n)
            candidate = anchor
        else:
            hh, mm, ss = (int(x) for x in clock.split(":"))
            candidate = local_now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
            if candidate <= local_now:
                candidate += timedelta(days=1)
        return candidate.isoformat()
    except Exception:
        return None


class JobRunRepository:
    """Repository for job_runs table."""

    def __init__(self, storage: SQLiteStorage | None = None):
        self._explicit = storage

    def _storage(self) -> SQLiteStorage:
        return self._explicit or _global_storage()

    def record_success(self, job_name: str, timestamp: str | None = None) -> None:
        ts = timestamp or _now()
        storage = self._storage()
        # RV-06：新建行即写入注册表阈值（首次记录就遵守既定阈值）；
        # 已有行只更新时间戳，不覆盖显式管理的阈值。
        threshold = _registered_threshold(job_name)
        with storage._connection() as conn:
            exists = conn.execute(
                "SELECT 1 FROM job_runs WHERE job_name = ?", (job_name,)
            ).fetchone()
            if exists is None:
                if threshold is None:
                    conn.execute(
                        "INSERT INTO job_runs (job_name, last_success_at) VALUES (?, ?)",
                        (job_name, ts),
                    )
                else:
                    conn.execute(
                        "INSERT INTO job_runs (job_name, last_success_at, stale_after_hours)"
                        " VALUES (?, ?, ?)",
                        (job_name, ts, threshold),
                    )
            else:
                conn.execute(
                    "UPDATE job_runs SET last_success_at = ? WHERE job_name = ?",
                    (ts, job_name),
                )
            conn.commit()

    def record_failure(self, job_name: str, reason: str, timestamp: str | None = None) -> None:
        ts = timestamp or _now()
        storage = self._storage()
        threshold = _registered_threshold(job_name)
        with storage._connection() as conn:
            exists = conn.execute(
                "SELECT 1 FROM job_runs WHERE job_name = ?", (job_name,)
            ).fetchone()
            if exists is None:
                if threshold is None:
                    conn.execute(
                        "INSERT INTO job_runs (job_name, last_failure_at, last_failure_reason)"
                        " VALUES (?, ?, ?)",
                        (job_name, ts, reason[:500]),
                    )
                else:
                    conn.execute(
                        "INSERT INTO job_runs (job_name, last_failure_at, last_failure_reason,"
                        " stale_after_hours) VALUES (?, ?, ?, ?)",
                        (job_name, ts, reason[:500], threshold),
                    )
            else:
                conn.execute(
                    "UPDATE job_runs SET last_failure_at = ?, last_failure_reason = ?"
                    " WHERE job_name = ?",
                    (ts, reason[:500], job_name),
                )
            conn.commit()

    def register_job(self, job_name: str, stale_after_hours: int = 36) -> None:
        storage = self._storage()
        with storage._connection() as conn:
            conn.execute(
                """INSERT INTO job_runs (job_name, stale_after_hours)
                VALUES (?, ?)
                ON CONFLICT(job_name) DO UPDATE SET
                    stale_after_hours = excluded.stale_after_hours
                """,
                (job_name, stale_after_hours),
            )
            conn.commit()

    def _job_state(
        self,
        *,
        last_success_at: str | None,
        last_failure_at: str | None,
        enabled: bool,
        stale_after_hours: int,
        now_dt: datetime,
    ) -> tuple[str, float | None]:
        """返回 (state, hours_since_last_success)。判定优先级见模块 docstring。"""
        if not enabled:
            return "disabled", None

        success_dt = _parse_iso(last_success_at)
        failure_dt = _parse_iso(last_failure_at)
        # 记录不可读 → unknown（原始串存在但无法解析）
        if (last_success_at and success_dt is None) or (last_failure_at and failure_dt is None):
            return "unknown", None

        if success_dt is None and failure_dt is None:
            return "never_succeeded", None

        if failure_dt is not None and (success_dt is None or failure_dt > success_dt):
            return "failed", None

        hours_since = round((now_dt - success_dt).total_seconds() / 3600.0, 2)
        if hours_since <= stale_after_hours:
            return "healthy", hours_since
        return "stale", hours_since

    def get_freshness_report(self) -> dict[str, Any]:
        now_dt = datetime.now(timezone.utc)
        storage = self._storage()
        with storage._connection() as conn:
            rows = conn.execute("SELECT * FROM job_runs ORDER BY job_name").fetchall()

        rows_by_name = {row["job_name"]: dict(row) for row in rows}
        # 必需任务 ∪ 已有行：R04——必需链路即使没有记录也不允许从报告中隐身
        names = sorted(set(rows_by_name) | set(REQUIRED_TASKS))

        jobs: list[dict[str, Any]] = []
        overall_healthy = True

        for job_name in names:
            data = rows_by_name.get(job_name, {})
            spec = REQUIRED_TASKS.get(job_name, {})
            enabled = bool(spec.get("enabled", True))
            # RV-06：注册表优先于数据库值（兼容遗留默认行）；注册表外任务沿用 DB/36。
            stale_after_hours = int(spec.get("stale_after_hours")
                                    or data.get("stale_after_hours") or 36)
            last_success_at = data.get("last_success_at")
            last_failure_at = data.get("last_failure_at")

            state, hours_since_success = self._job_state(
                last_success_at=last_success_at,
                last_failure_at=last_failure_at,
                enabled=enabled,
                stale_after_hours=stale_after_hours,
                now_dt=now_dt,
            )

            if state not in ("healthy", "disabled"):
                overall_healthy = False

            on_calendar = spec.get("on_calendar")
            next_planned = (_next_planned_from_calendar(on_calendar, now_dt)
                            if (on_calendar and enabled) else None)

            jobs.append({
                "job_name": job_name,
                "state": state,
                "required": job_name in REQUIRED_TASKS,
                "last_success_at": last_success_at,
                "last_failure_at": last_failure_at,
                "last_failure_reason": data.get("last_failure_reason"),
                "next_planned_at": next_planned,
                "stale_after_hours": stale_after_hours,
                "hours_since_last_success": hours_since_success,
                # legacy 兼容字段（patrol/health-check.sh 继续消费）
                "never_run": state == "never_succeeded",
                "is_stale": state in ("stale", "failed"),
            })

        return {
            "status": "healthy" if overall_healthy else "degraded",
            "checked_at": _now(),
            "jobs": jobs,
        }
